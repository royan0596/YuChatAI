/**
 * Background Service Worker
 * 负责：AI API 调用、订单通知分发、与 Content Script 通信、消息轮询
 *
 * 架构说明：
 * - 消息获取有两个通道：
 *   1. HTTP 轮询（主通道）：通过 message-poller 定期拉取闲鱼消息 API，不依赖任何页面
 *   2. WebSocket 拦截（辅助通道）：content script 在聊天页面拦截 WS 消息，实时性更好
 * - 回复发送也有两个通道：
 *   1. HTTP API（主通道）：通过 reply-sender 直接调用闲鱼发送 API
 *   2. DOM 注入（回退）：通过 content script 注入到聊天输入框
 */
import { getSettings, getStats, patchStats, appendMessageLog } from '../shared/storage';
import { STORAGE_KEYS } from '../shared/constants';
import type { RuntimeMessage, BuyerMessage, OrderEvent } from '../shared/types';
import { callAgentAI } from './ai-agents';
import { startPolling, stopPolling, isPolling } from './message-poller';
import { sendReplyViaAPI } from './reply-sender';
import {
  ensureBackgroundWs,
  rememberConversationParticipants,
  setBackgroundWsMessageHandler,
} from './ws-client';
import { findAnyGoofishTab } from './im-tab-manager';
import { fetchProductInfo } from './product-fetcher';
import { fetchMyProducts } from './product-list-fetcher';
import { filterReply, calcTypingDelay } from './safety-filter';
import { sendBrowserNotification } from './notify/browser';
import { sendSmsNotification } from './notify/sms';
import { sendDingtalkNotification } from './notify/dingtalk';
import { sendFeishuNotification } from './notify/feishu';
import { sendTelegramNotification } from './notify/telegram';

// ── 点击扩展图标打开侧边栏 ──────────────────────────────────────────────
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// ── 扩展图标 Badge 状态指示 ────────────────────────────────────────────
async function updateBadge(): Promise<void> {
  const stats = await getStats();
  if (stats.running) {
    chrome.action.setBadgeText({ text: 'ON' });
    chrome.action.setBadgeBackgroundColor({ color: '#52c41a' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
  chrome.action.setTitle({
    title: `闲鱼智能客服 · ${stats.running ? '运行中' : '已暂停'} · 已处理 ${stats.processedMessages} 条`,
  });
}

// 启动时立即更新 badge
updateBadge();

const LOGIN_CHECK_INTERVAL = 60_000;
const LOGIN_SOFT_FAILURE_LIMIT = 3;
let consecutiveLoginSoftFailures = 0;
const RECENT_MESSAGE_TTL = 2 * 60_000;
const recentMessageKeys = new Map<string, number>();
const recentCanonicalConversationIds = new Map<string, { conversationId: string; expiresAt: number }>();

function cleanupRecentMessages(now = Date.now()): void {
  for (const [key, expiresAt] of recentMessageKeys) {
    if (expiresAt > now) continue;
    recentMessageKeys.delete(key);
  }

  for (const [key, entry] of recentCanonicalConversationIds) {
    if (entry.expiresAt > now) continue;
    recentCanonicalConversationIds.delete(key);
  }
}

function isSuspiciousConversationId(conversationId: string): boolean {
  const normalized = conversationId.replace(/@goofish$/, '');
  return /^\d+$/.test(normalized);
}

function getMessageSignatureKey(msg: BuyerMessage): string {
  const normalizedContent = msg.content.trim().replace(/\s+/g, ' ');
  const roundedTimestamp = msg.timestamp ? Math.round(msg.timestamp / 1000) : 0;
  return `${normalizedContent}|${roundedTimestamp}|${msg.itemId ?? ''}`;
}

function rememberCanonicalConversationId(msg: BuyerMessage): void {
  if (!msg.conversationId || isSuspiciousConversationId(msg.conversationId)) return;

  recentCanonicalConversationIds.set(getMessageSignatureKey(msg), {
    conversationId: msg.conversationId,
    expiresAt: Date.now() + RECENT_MESSAGE_TTL,
  });
}

function normalizeConversationId(msg: BuyerMessage): BuyerMessage {
  cleanupRecentMessages();
  if (!msg.conversationId || !isSuspiciousConversationId(msg.conversationId)) {
    rememberCanonicalConversationId(msg);
    return msg;
  }

  const canonical = recentCanonicalConversationIds.get(getMessageSignatureKey(msg));
  if (!canonical?.conversationId) {
    return msg;
  }

  console.info('[Background] 修正可疑会话 ID:', msg.conversationId, '->', canonical.conversationId, msg.id);
  const hintedParticipants = new Set<string>([`${msg.conversationId}@goofish`]);
  for (const participant of msg.participants ?? []) {
    hintedParticipants.add(participant);
  }
  return {
    ...msg,
    conversationId: canonical.conversationId,
    buyerUserId: msg.buyerUserId || msg.conversationId,
    conversationIdType: 'real',
    participants: Array.from(hintedParticipants),
  };
}

function getMessageDedupKeys(msg: BuyerMessage): string[] {
  const normalizedContent = msg.content.trim().replace(/\s+/g, ' ');
  const roundedTimestamp = msg.timestamp ? Math.round(msg.timestamp / 1000) : 0;
  const keys = [
    `id:${msg.id}`,
    `sig:${getMessageSignatureKey(msg)}`,
  ];

  if (msg.conversationId) {
    keys.push(`conv:${msg.conversationId}|${normalizedContent}|${roundedTimestamp}`);
  }

  return keys;
}

function markMessageSeen(msg: BuyerMessage): void {
  const expiresAt = Date.now() + RECENT_MESSAGE_TTL;
  for (const key of getMessageDedupKeys(msg)) {
    recentMessageKeys.set(key, expiresAt);
  }
}

function isDuplicateMessage(msg: BuyerMessage): boolean {
  cleanupRecentMessages();
  return getMessageDedupKeys(msg).some((key) => recentMessageKeys.has(key));
}

async function hasGoofishAuthCookies(): Promise<boolean> {
  try {
    const [tokenCookie, userCookie] = await Promise.all([
      chrome.cookies.get({ url: 'https://www.goofish.com', name: '_m_h5_tk' }),
      chrome.cookies.get({ url: 'https://www.goofish.com', name: 'unb' }),
    ]);
    return Boolean(tokenCookie?.value && userCookie?.value);
  } catch (err) {
    console.warn('[Background] 读取闲鱼登录 cookie 失败:', err);
    return false;
  }
}

async function disableAutoReplyForLogout(reason: string): Promise<void> {
  console.log('[Background] 检测到闲鱼退出登录，自动停止:', reason);
  await patchStats({ running: false });
}

// ── 监听闲鱼 cookie 变化，退出登录时自动停止 ────────────────────────────
// 方式1: cookie 被清除时立即停止
chrome.cookies.onChanged.addListener(async (changeInfo) => {
  const { cookie, removed } = changeInfo;
  if (!cookie.domain.includes('goofish')) return;
  if (!removed) return;
  if (cookie.name !== '_m_h5_tk' && cookie.name !== 'unb') return;

  const stats = await getStats();
  if (!stats.running) {
    consecutiveLoginSoftFailures = 0;
    return;
  }

  await disableAutoReplyForLogout(`cookie removed: ${cookie.name}`);
  return;

});

// 方式2: 定时验证登录（兜底，闲鱼退出可能不清 cookie）
async function checkLoginAndStop(): Promise<void> {
  const stats = await getStats();
  if (!stats.running) {
    consecutiveLoginSoftFailures = 0;
    return;
  }

  try {
    const tab = await findAnyGoofishTab();
    if (!tab) {
      consecutiveLoginSoftFailures = 0;
      return;
    }
    if (!tab) return; // 没有闲鱼页面就跳过检查

    const resp = await chrome.tabs.sendMessage(tab, {
      type: 'MTOP_REQUEST',
      payload: { api: 'mtop.taobao.idlemessage.pc.login.token', version: '1.0', data: { appKey: '444e9908a51d1cb236a27862abc769c9', deviceId: 'login-check' } },
    }) as { success?: boolean; data?: Record<string, unknown> } | undefined;
    const token = (resp?.data?.['data'] as Record<string, unknown> | undefined)?.['accessToken'];

    if (token) {
      consecutiveLoginSoftFailures = 0;
      return;
    }

    const hasCookies = await hasGoofishAuthCookies();
    if (!hasCookies) {
      consecutiveLoginSoftFailures = 0;
      await disableAutoReplyForLogout('mtop login token missing and auth cookies absent');
      return;
    }

    consecutiveLoginSoftFailures += 1;
    console.warn(
      '[Background] 登录校验软失败，保留自动回复继续运行:',
      `attempt=${consecutiveLoginSoftFailures}/${LOGIN_SOFT_FAILURE_LIMIT}`
    );

    if (consecutiveLoginSoftFailures >= LOGIN_SOFT_FAILURE_LIMIT) {
      console.warn('[Background] 连续登录校验失败，但 cookie 仍存在，推断为桥接或接口波动，不自动停机');
      consecutiveLoginSoftFailures = 0;
    }
    return;
  } catch (err) {
    consecutiveLoginSoftFailures += 1;
    console.warn('[Background] 登录校验异常，忽略本次停机判定:', err);
    if (consecutiveLoginSoftFailures >= LOGIN_SOFT_FAILURE_LIMIT) {
      consecutiveLoginSoftFailures = 0;
    }
  }
}

// 每 60 秒检查一次
setInterval(checkLoginAndStop, LOGIN_CHECK_INTERVAL);

// ── 注册 MAIN 世界脚本（确保 WS 拦截器在页面脚本之前运行）────────────────
// chrome.scripting.registerContentScripts 比 manifest content_scripts 更可靠
(async () => {
  try {
    // 先尝试注销旧的（避免重复注册报错）
    await chrome.scripting.unregisterContentScripts({ ids: ['xianyu-ws-interceptor'] }).catch(() => {});
    await chrome.scripting.registerContentScripts([{
      id: 'xianyu-ws-interceptor',
      matches: ['https://*.goofish.com/*', 'https://*.idlefish.com/*'],
      js: ['content-injected.js'],
      runAt: 'document_start',
      world: 'MAIN',
    }]);
    console.log('[Background] ✅ MAIN 世界脚本注册成功（content-injected.js）');
  } catch (err) {
    console.error('[Background] ❌ MAIN 世界脚本注册失败:', err);
  }
})();

// ── 商品信息补全 ──────────────────────────────────────────────────────────

async function enrichProductInfo(msg: BuyerMessage): Promise<BuyerMessage> {
  if (!msg.itemId || msg.productInfo) return msg;
  try {
    const info = await fetchProductInfo(msg.itemId);
    if (info) {
      return { ...msg, productInfo: info, productTitle: info.title };
    }
  } catch (err) {
    console.log('[Background] 商品信息获取失败:', err);
  }
  return msg;
}

// ── 轮询消息处理回调 ──────────────────────────────────────────────────────

async function handlePolledMessage(msg: BuyerMessage): Promise<void> {
  console.info('[Background] 轮询收到新消息:', msg.buyerName, msg.content.slice(0, 50));
  msg = normalizeConversationId(msg);

  const [settings, stats] = await Promise.all([getSettings(), getStats()]);
  if (!stats.running) {
    console.info('[Background] 系统未运行，跳过轮询消息');
    return;
  }
  if (!settings.ai.directSendAuthorized) {
    console.info('[Background] 用户未授权自动直发，跳过轮询消息自动发送');
    await appendMessageLog({
      id: msg.id,
      buyerName: msg.buyerName,
      content: msg.content,
      reply: '',
      intent: 'awaiting_consent',
      timestamp: msg.timestamp,
      conversationId: msg.conversationId,
      sent: false,
    });
    return;
  }

  try {
    // 补全商品详情（标题、价格、描述）
    msg = await enrichProductInfo(msg);

    const { reply: rawReply, intent } = await callAgentAI(msg, settings.ai);

    // 分类为 no_reply 时跳过发送
    if (!rawReply) {
      console.info('[Background] Agent 判定无需回复 (intent:', intent, ')');
      await appendMessageLog({
        id: msg.id, buyerName: msg.buyerName, content: msg.content,
        reply: '', intent, timestamp: msg.timestamp,
        conversationId: msg.conversationId, sent: false,
      });
      return;
    }

    const reply = filterReply(rawReply);
    console.info('[Background] AI 回复:', reply.slice(0, 80));

    // 人性化延迟（模拟打字速度）
    const delay = calcTypingDelay(reply);
    console.info('[Background] 模拟打字延迟:', Math.round(delay), 'ms');
    await new Promise((r) => setTimeout(r, delay));

    // 通过 WS/DOM 发送回复
    const sendResult = await sendReplyViaAPI(msg.conversationId, reply, msg.buyerUserId, msg.participants);
    const sent = sendResult.success;
    console.info('[Background] 发送结果:', {
      originalConversationId: msg.conversationId,
      usedConversationId: sendResult.usedConversationId ?? msg.conversationId,
      via: sendResult.via,
      success: sendResult.success,
      detail: sendResult.detail ?? '',
    });
    if (sendResult.success) {
      console.info('[Background] 回复已通过 API 发送成功');
    } else {
      console.log('[Background] API 发送失败，回复未送达');
    }

    // 记录消息日志
    await appendMessageLog({
      id: msg.id, buyerName: msg.buyerName, content: msg.content,
      reply, intent, timestamp: msg.timestamp,
      conversationId: msg.conversationId, sent,
    });

    const stats = await getStats();
    await patchStats({ processedMessages: stats.processedMessages + 1 });
  } catch (err) {
    console.error('[Background] 处理轮询消息失败:', err);
  }
}

// ── 启动时同步标志 + 启动轮询 ─────────────────────────────────────────────

async function initAndSync(): Promise<void> {
  const [settings, stats] = await Promise.all([getSettings(), getStats()]);

  console.info('[Background] 启动同步检查:', {
    'stats.running': stats.running,
    'settings.ai.directSendAuthorized': settings.ai.directSendAuthorized,
    'settings.ai.provider': settings.ai.provider,
    'settings.ai.model': settings.ai.model,
    'settings.ai.apiKey': settings.ai.apiKey ? '已配置(' + settings.ai.apiKey.slice(0, 6) + '...)' : '❌ 未配置',
    'isPolling': isPolling(),
  });

  // 以 stats.running 为唯一真相来源
  if (stats.running) {
    console.info('[Background] ✅ 系统运行中（stats.running=true），启动消息轮询');
    setBackgroundWsMessageHandler(async (msg) => {
      try {
        await handleBuyerMessage(msg);
      } catch (err) {
        console.error('[Background] 后台 WS 买家消息处理失败:', err);
      }
    });
    void ensureBackgroundWs();
    startPolling(handlePolledMessage);
  } else {
    setBackgroundWsMessageHandler(null);
    console.info('[Background] 系统未运行（stats.running=false），轮询待命中');
  }
}

// Service Worker 启动时初始化
initAndSync();

// 监听 stats 变更，动态启停轮询 + 更新 badge
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (changes[STORAGE_KEYS.stats]) {
    updateBadge();
    // stats.running 变更时动态启停轮询
    getStats().then((stats) => {
      if (stats.running && !isPolling()) {
        console.info('[Background] 检测到系统启动，启动轮询');
        setBackgroundWsMessageHandler(async (msg) => {
          try {
            await handleBuyerMessage(msg);
          } catch (err) {
            console.error('[Background] 后台 WS 买家消息处理失败:', err);
          }
        });
        void ensureBackgroundWs();
        startPolling(handlePolledMessage);
      } else if (!stats.running && isPolling()) {
        console.info('[Background] 检测到系统暂停，停止轮询');
        setBackgroundWsMessageHandler(null);
        stopPolling();
      }
    });
  }
});

// ── 监听来自 Content Script 的消息（WebSocket 拦截通道）─────────────────

chrome.runtime.onMessage.addListener(
  (message: RuntimeMessage, _sender, sendResponse) => {
    console.info('[Background] 收到消息:', message.type, message);
    handleMessage(message)
      .then((result) => {
        console.info('[Background] 处理完成:', message.type, result);
        sendResponse(result);
      })
      .catch((err) => {
        console.error('[Background] 处理失败:', message.type, err);
        sendResponse({ error: String(err) });
      });
    return true; // 保持异步响应通道
  }
);

async function handleMessage(message: RuntimeMessage): Promise<unknown> {
  switch (message.type) {
    case 'PING':
      return { pong: true };

    case 'DIAG': {
      const diagSettings = await getSettings();
      const diagStats = await getStats();
      return {
        directSendAuthorized: diagSettings.ai.directSendAuthorized,
        autoReplyEnabled: diagSettings.ai.autoReplyEnabled,
        reviewModeEnabled: diagSettings.ai.reviewModeEnabled,
        running: diagStats.running,
        apiKey: diagSettings.ai.apiKey ? diagSettings.ai.apiKey.slice(0, 8) + '...' : 'NOT_SET',
        provider: diagSettings.ai.provider,
        model: diagSettings.ai.model,
        baseUrl: diagSettings.ai.baseUrl,
        polling: isPolling(),
      };
    }

    case 'CHECK_LOGIN': {
      // cookie 不可靠（闲鱼退出不清 cookie），改为实际调用 API 验证
      try {
        const tab = await findAnyGoofishTab();
        if (!tab) {
          console.log('[Background] 登录检查: 无闲鱼页面');
          return { loggedIn: false, reason: 'no_tab' };
        }
        const resp = await chrome.tabs.sendMessage(tab, {
          type: 'MTOP_REQUEST',
          payload: { api: 'mtop.taobao.idlemessage.pc.login.token', version: '1.0', data: { appKey: '444e9908a51d1cb236a27862abc769c9', deviceId: 'login-check' } },
        }) as { success?: boolean; data?: Record<string, unknown> } | undefined;
        const token = (resp?.data?.['data'] as Record<string, unknown> | undefined)?.['accessToken'];
        console.log('[Background] 登录检查: API 返回 success=', resp?.success, 'hasToken=', !!token);
        return { loggedIn: !!(resp?.success && token) };
      } catch (err) {
        console.log('[Background] 登录检查异常:', err);
        return { loggedIn: false, reason: 'error' };
      }
    }

    case 'FETCH_MY_PRODUCTS': {
      try {
        const result = await fetchMyProducts();
        const items = result.items;
        return { success: !!items && items.length > 0, products: items ?? [], error: result.error };
      } catch (err) {
        console.log('[Background] 获取在售商品失败:', err);
        return { success: false, products: [], error: String(err) };
      }
    }

    case 'BUYER_MESSAGE':
      return handleBuyerMessage(message.payload);

    case 'ORDER_CREATED':
      return handleOrderCreated(message.payload);

    case 'TOGGLE_AUTO_REPLY': {
      return patchStats({ running: message.payload.enabled });
    }

    default:
      return null;
  }
}

async function handleBuyerMessage(msg: BuyerMessage): Promise<{ success: boolean; reply?: string } | null> {
  msg = normalizeConversationId(msg);
  if (isDuplicateMessage(msg)) {
    console.info('[Background] 跳过重复轮询消息:', msg.id, msg.conversationId);
    return { success: true };
  }
  markMessageSeen(msg);

  const [settings, stats] = await Promise.all([getSettings(), getStats()]);
  rememberConversationParticipants(msg.conversationId, msg.participants);
  console.info('[Background] handleBuyerMessage:', {
    running: stats.running,
    directSendAuthorized: settings.ai.directSendAuthorized,
    provider: settings.ai.provider,
    model: settings.ai.model,
    apiKey: settings.ai.apiKey ? '✅' : '❌',
    conversationId: msg.conversationId,
    conversationIdType: msg.conversationIdType ?? 'real',
  });

  if (!stats.running) {
    console.log('[Background] 系统未运行（stats.running=false），跳过');
    return null;
  }
  if (!settings.ai.directSendAuthorized) {
    console.info('[Background] 用户未授权自动直发，跳过实时消息自动发送:', msg.conversationId);
    await appendMessageLog({
      id: msg.id,
      buyerName: msg.buyerName,
      content: msg.content,
      reply: '',
      intent: 'awaiting_consent',
      timestamp: msg.timestamp,
      conversationId: msg.conversationId,
      sent: false,
    });
    return { success: false };
  }

  // 补全商品详情（标题、价格、描述）
  msg = await enrichProductInfo(msg);

  const { reply: rawReply, intent } = await callAgentAI(msg, settings.ai);

  // 分类为 no_reply 时跳过发送
  if (!rawReply) {
    console.info('[Background] Agent 判定无需回复 (intent:', intent, ')');
    await appendMessageLog({
      id: msg.id, buyerName: msg.buyerName, content: msg.content,
      reply: '', intent, timestamp: msg.timestamp,
      conversationId: msg.conversationId, sent: false,
    });
    return { success: true };
  }

  const reply = filterReply(rawReply);
  console.info('[Background] AI 回复:', reply.slice(0, 80));

  // 人性化延迟（模拟打字速度）
  const delay = calcTypingDelay(reply);
  console.info('[Background] 模拟打字延迟:', Math.round(delay), 'ms');
  await new Promise((r) => setTimeout(r, delay));

  const curStats = await getStats();
  await patchStats({
    processedMessages: curStats.processedMessages + 1,
  });

  const sendResult = await sendReplyViaAPI(msg.conversationId, reply, msg.buyerUserId, msg.participants);
  const sent = sendResult.success;
  console.info('[Background] 发送结果:', {
    originalConversationId: msg.conversationId,
    usedConversationId: sendResult.usedConversationId ?? msg.conversationId,
    via: sendResult.via,
    success: sendResult.success,
    detail: sendResult.detail ?? '',
  });
  if (sent) {
    console.info('[Background] 回复发送成功:', msg.conversationId);
  } else {
    console.log('[Background] 回复发送失败:', msg.conversationId);
  }

  // 记录消息日志
  await appendMessageLog({
    id: msg.id, buyerName: msg.buyerName, content: msg.content,
    reply, intent, timestamp: msg.timestamp,
    conversationId: msg.conversationId, sent,
  });

  return { success: sent, reply };
}

async function handleOrderCreated(order: OrderEvent): Promise<void> {
  const settings = await getSettings();
  const stats = await getStats();
  await patchStats({
    todayOrders: stats.todayOrders + 1,
  });

  const promises: Promise<void>[] = [];

  if (settings.notification.browserEnabled) {
    promises.push(sendBrowserNotification(order));
  }
  if (settings.notification.smsEnabled) {
    promises.push(sendSmsNotification(order, settings.notification));
  }
  if (settings.notification.dingtalkEnabled) {
    promises.push(sendDingtalkNotification(order, settings.notification));
  }
  if (settings.notification.feishuEnabled) {
    promises.push(sendFeishuNotification(order, settings.notification));
  }
  if (settings.notification.telegramEnabled) {
    promises.push(sendTelegramNotification(order, settings.notification));
  }

  await Promise.allSettled(promises);
}
