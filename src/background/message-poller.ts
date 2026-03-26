/**
 * 消息轮询模块
 * 通过闲鱼 H5 API 定期拉取状态
 *
 * 多级降级策略：
 * 1. 红点接口检测未读数变化 → 同时尝试从红点响应提取会话摘要
 * 2. 多个候选会话列表 API 逐一尝试
 * 3. DOM 抓取（需要 /im 页面）
 *
 * 注意：WS 实时推送是主通道，轮询是备份检测机制
 */

import type { BuyerMessage } from '../shared/types';
import { findAnyGoofishTab } from './im-tab-manager';
import { isBackgroundWsConnected } from './ws-client';

const POLL_INTERVAL = 15_000;

let pollTimer: ReturnType<typeof setInterval> | null = null;
let onNewMessage: ((msg: BuyerMessage) => void) | null = null;
let lastUnreadTotal = 0;
// 已处理的消息 ID（防重复）
const processedMsgIds = new Set<string>();
// 最多保留 200 条 ID
const MAX_PROCESSED_IDS = 200;

function addProcessedId(id: string): void {
  processedMsgIds.add(id);
  if (processedMsgIds.size > MAX_PROCESSED_IDS) {
    const first = processedMsgIds.values().next().value;
    if (first) processedMsgIds.delete(first);
  }
}

async function findGoofishTabId(): Promise<number | null> {
  const tabId = await findAnyGoofishTab();
  if (!tabId) {
    console.log('[Poller] 未找到闲鱼页面标签页，无法发起 mtop 请求');
  }
  return tabId;
}

async function callMtopViaTab(
  tabId: number,
  api: string,
  version: string,
  data: Record<string, unknown>
): Promise<Record<string, unknown> | null> {
  try {
    const response = (await chrome.tabs.sendMessage(tabId, {
      type: 'MTOP_REQUEST',
      payload: { api, version, data },
    })) as { success?: boolean; data?: Record<string, unknown> | null; error?: string } | undefined;

    if (!response?.success) {
      console.log('[Poller] mtop 请求失败:', api, response?.error || '未知错误');
      return null;
    }

    return response.data ?? null;
  } catch (err) {
    console.error('[Poller] mtop 调用异常:', api, err);
    return null;
  }
}

/**
 * 检测未读数变化（红点接口），同时尝试从红点响应提取会话摘要
 */
async function checkUnreadAndExtract(tabId: number): Promise<{
  hasNewUnread: boolean;
  extractedMessages: BuyerMessage[];
}> {
  const result = await callMtopViaTab(tabId, 'mtop.taobao.idlemessage.pc.redpoint.query', '1.0', {
    sessionTypes: '1,19,15,32,3,44,51,52,24',
    fetch: 50,
  });

  if (!result) return { hasNewUnread: false, extractedMessages: [] };

  const ret = result['ret'] as string[] | undefined;
  const data = result['data'] as Record<string, unknown> | undefined;

  if (!ret?.[0]?.startsWith('SUCCESS')) {
    console.log('[Poller] 红点接口返回非成功状态:', ret);
    return { hasNewUnread: false, extractedMessages: [] };
  }

  if (!data) return { hasNewUnread: false, extractedMessages: [] };

  const total = Number(data['total'] ?? 0);
  console.info('[Poller] 红点 total:', total, '上次:', lastUnreadTotal, 'data keys:', Object.keys(data));

  const hasNewUnread = total > lastUnreadTotal;
  if (hasNewUnread) {
    console.info('[Poller] 未读数增加:', lastUnreadTotal, '→', total);
  }
  lastUnreadTotal = total;

  // 尝试从红点响应提取会话摘要（某些版本的红点 API 会返回 sessionList）
  const extractedMessages = tryExtractFromRedpoint(data);

  return { hasNewUnread, extractedMessages };
}

/**
 * 尝试从红点响应中提取消息
 */
function tryExtractFromRedpoint(data: Record<string, unknown>): BuyerMessage[] {
  const messages: BuyerMessage[] = [];

  // 红点 API 可能包含 sessionList / sessions / items
  const candidates = [data['sessionList'], data['sessions'], data['items'], data['list']];
  let sessions: Record<string, unknown>[] | null = null;

  for (const c of candidates) {
    if (Array.isArray(c) && c.length > 0) {
      sessions = c as Record<string, unknown>[];
      console.info('[Poller] 红点响应包含会话列表, 条数:', sessions.length);
      break;
    }
  }

  if (!sessions) return messages;

  for (const session of sessions) {
    const msg = parseSessionItem(session);
    if (msg) messages.push(msg);
  }

  return messages;
}

/**
 * 从会话列表 API 获取最近消息
 *
 * 注意：session.list / session.query / idle.im.session.list 等 API
 * 全部被 CORS 策略阻止（h5api.m.goofish.com 不返回 Access-Control-Allow-Origin），
 * 在 www.goofish.com 页面上完全不可用。
 * 唯一可用的是红点接口 (redpoint.query)，但它只返回未读数不返回消息内容。
 * 消息内容获取完全依赖 WS 实时推送通道。
 */
async function fetchRecentMessages(_tabId: number): Promise<BuyerMessage[]> {
  // 所有会话列表 API 均被 CORS 阻止，不再尝试
  return [];
}

/**
 * 解析会话列表数据
 */
function parseSessionList(data: Record<string, unknown>): BuyerMessage[] {
  const messages: BuyerMessage[] = [];

  // 解析会话列表（结构可能因版本不同而异，增加多种解析路径）
  const candidates = [data['sessions'], data['sessionList'], data['list'], data['result']];
  let sessions: Record<string, unknown>[] | null = null;

  for (const c of candidates) {
    if (Array.isArray(c) && c.length > 0) {
      sessions = c as Record<string, unknown>[];
      break;
    }
  }

  if (!sessions) {
    console.info('[Poller] 会话列表数据结构不匹配, keys:', Object.keys(data));
    return [];
  }

  for (const session of sessions) {
    const msg = parseSessionItem(session);
    if (msg) messages.push(msg);
  }

  return messages;
}

/**
 * 解析单个会话条目为 BuyerMessage
 */
function parseSessionItem(session: Record<string, unknown>): BuyerMessage | null {
  try {
    const unreadCount = Number(session['unreadCount'] ?? session['unread'] ?? 0);
    if (unreadCount <= 0) return null;

    // 获取会话 ID
    const cidRaw = String(session['cid'] ?? session['sessionId'] ?? session['conversationId'] ?? '');
    if (!cidRaw) return null;
    const conversationId = cidRaw.replace('@goofish', '');

    // 获取最后一条消息
    const lastMsg = (session['lastMessage'] ?? session['latestMessage'] ?? session['message'] ?? {}) as Record<string, unknown>;
    const msgContent = String(
      lastMsg['content'] ?? lastMsg['text'] ?? lastMsg['summary'] ??
      session['lastContent'] ?? session['digest'] ?? session['summary'] ?? ''
    );
    if (!msgContent) return null;

    // 消息 ID（用于去重）
    const msgId = String(lastMsg['messageId'] ?? lastMsg['msgId'] ?? lastMsg['id'] ?? `poll-${conversationId}-${Date.now()}`);
    if (processedMsgIds.has(msgId)) return null;

    // 获取发送者信息
    const senderNick = String(
      lastMsg['senderNick'] ?? lastMsg['nick'] ??
      session['otherNick'] ?? session['peerNick'] ?? session['nick'] ?? '买家'
    );

    const timestamp = Number(lastMsg['createAt'] ?? lastMsg['timestamp'] ?? session['lastTime'] ?? Date.now());

    addProcessedId(msgId);
    return {
      id: msgId,
      buyerName: senderNick,
      content: msgContent,
      timestamp,
      conversationId,
      conversationIdType: 'real',
      productTitle: '',
    };
  } catch (err) {
    console.log('[Poller] 解析会话条目失败:', err);
    return null;
  }
}

/**
 * DOM 抓取降级方案（通过 content script 在 /im 页面抓取）
 */
async function fetchViaDomScraping(): Promise<BuyerMessage[]> {
  try {
    const tabs = await chrome.tabs.query({ url: ['https://*.goofish.com/im*'] });
    if (!tabs.length) {
      console.info('[Poller] 无 /im 页面，DOM 抓取不可用');
      return [];
    }

    for (const tab of tabs) {
      if (!tab.id || tab.status !== 'complete') continue;

      try {
        const resp = (await chrome.tabs.sendMessage(tab.id, { type: 'SCRAPE_UNREAD' })) as
          { success?: boolean; messages?: BuyerMessage[] } | undefined;

        if (resp?.success && resp.messages && resp.messages.length > 0) {
          // 过滤已处理的
          const newMsgs = resp.messages.filter(m => !processedMsgIds.has(m.id));
          for (const m of newMsgs) addProcessedId(m.id);
          console.info('[Poller] DOM 抓取到', newMsgs.length, '条新消息');
          return newMsgs;
        }
      } catch {
        continue;
      }
    }
  } catch (err) {
    console.error('[Poller] DOM 抓取异常:', err);
  }
  return [];
}

/**
 * 检查 WS 连接状态（诊断用）
 */
async function checkWsStatus(tabId: number): Promise<boolean> {
  try {
    const resp = (await chrome.tabs.sendMessage(tabId, { type: 'WS_STATUS' })) as
      { connected?: boolean } | undefined;
    return resp?.connected === true;
  } catch {
    return false;
  }
}

async function pollOnce(): Promise<void> {
  try {
    const tabId = await findGoofishTabId();
    if (!tabId) return;

    // 0. 诊断 WS 状态（每次轮询顺便检查）
    const wsConnected = isBackgroundWsConnected() || await checkWsStatus(tabId);
    if (!wsConnected) {
      console.info('[Poller] ⚠️ WS 未连接（实时通道不可用，轮询是唯一通道）');
    }

    // 1. 检测未读数变化（同时尝试提取会话数据）
    const { hasNewUnread, extractedMessages } = await checkUnreadAndExtract(tabId);

    if (!hasNewUnread) return;

    console.info('[Poller] 检测到新未读消息（WS 通道应自动处理，轮询仅做提醒）');

    // 红点响应中可能包含消息摘要
    if (extractedMessages.length > 0) {
      console.info(`[Poller] 从红点响应提取到 ${extractedMessages.length} 条消息`);
      for (const msg of extractedMessages) {
        console.info('[Poller] 新消息（红点提取）:', msg.buyerName, msg.content.slice(0, 50));
        onNewMessage?.(msg);
      }
      return;
    }

    // 会话列表 API 全部被 CORS 阻止，跳过
    // 消息内容获取完全依赖 WS 实时推送

    // 降级到 DOM 抓取（需要 /im 页面）
    const domMessages = await fetchViaDomScraping();
    if (domMessages.length > 0) {
      console.info(`[Poller] DOM 抓取到 ${domMessages.length} 条消息`);
      for (const msg of domMessages) {
        console.info('[Poller] 新消息（DOM）:', msg.buyerName, msg.content.slice(0, 50));
        onNewMessage?.(msg);
      }
      return;
    }

    console.info('[Poller] 未读数变化已检测到，等待 WS 通道推送消息内容');
  } catch (err) {
    console.error('[Poller] 轮询异常:', err);
  }
}

export function startPolling(callback: (msg: BuyerMessage) => void): void {
  if (pollTimer) {
    console.info('[Poller] 轮询已在运行中');
    return;
  }

  onNewMessage = callback;
  lastUnreadTotal = 0;

  console.info('[Poller] 启动消息轮询，间隔:', POLL_INTERVAL, 'ms');
  pollOnce();
  pollTimer = setInterval(pollOnce, POLL_INTERVAL);
}

export function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    console.info('[Poller] 轮询已停止');
  }
}

export function isPolling(): boolean {
  return pollTimer !== null;
}
