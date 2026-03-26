/**
 * Content Script
 * 注入到闲鱼页面，负责：WebSocket 劫持、消息解析、与 Background 通信、侧边栏注入
 *
 * 此脚本作为辅助通道：
 * - 在聊天页面通过 WS 拦截提供实时消息（比轮询更快）
 * - 接收 background 的 INJECT_REPLY 指令，在聊天页面注入回复
 * - 主通道是 background 的 HTTP 轮询 + API 回复
 */
import type { BuyerMessage, MtopRequestPayload, OrderEvent, RuntimeMessage } from '../shared/types';

// 注入 WebSocket 拦截脚本到页面主上下文（备用路径）
// 主路径是 background 通过 chrome.scripting.registerContentScripts 注入 (world:MAIN)
// 此处作为 fallback，防止 registerContentScripts 未生效
function injectInterceptor(): void {
  // 检查是否已由 registerContentScripts 注入（通过检测全局标志）
  // 这个检查只能在页面上下文做，content script 隔离世界无法访问
  // 所以 fallback 始终执行，content-injected.ts 内部需有防重复逻辑
  const url = chrome.runtime.getURL('content-injected.js');
  console.log('[Content] 备用注入 WS 拦截脚本:', url);
  const script = document.createElement('script');
  script.src = url;
  script.onload = () => {
    console.log('[Content] WS 拦截脚本备用注入完成');
    script.remove();
  };
  script.onerror = (e) => {
    console.error('[Content] WS 拦截脚本注入失败 ❌', e);
  };
  (document.head || document.documentElement).appendChild(script);
}

const PAGE_MESSAGE_SOURCE = 'xianyu-smart-assistant';
const CONTENT_INSTANCE_ATTR = 'data-xianyu-content-instance';
const CONTENT_INSTANCE_ID = `content-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const pendingMtopRequests = new Map<
  string,
  {
    resolve: (value: Record<string, unknown> | null) => void;
    reject: (reason?: unknown) => void;
    timer: number;
  }
>();
const pendingWsStatusRequests = new Map<
  string,
  {
    resolve: (value: { connected: boolean }) => void;
    timer: number;
  }
>();
const pendingWsSendRequests = new Map<
  string,
  {
    resolve: (value: { success: boolean; error?: string }) => void;
    timer: number;
  }
>();

function markContentInstance(): void {
  document.documentElement?.setAttribute(CONTENT_INSTANCE_ATTR, CONTENT_INSTANCE_ID);
  console.info('[Content] 标记当前实例:', CONTENT_INSTANCE_ID);
}

function isActiveContentInstance(): boolean {
  return document.documentElement?.getAttribute(CONTENT_INSTANCE_ATTR) === CONTENT_INSTANCE_ID;
}

function buildRequestId(): string {
  return `mtop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function requestMtopViaPage(payload: MtopRequestPayload): Promise<Record<string, unknown> | null> {
  return new Promise((resolve, reject) => {
    const requestId = buildRequestId();
    const timer = window.setTimeout(() => {
      pendingMtopRequests.delete(requestId);
      reject(new Error(`页面上下文 mtop 请求超时: ${payload.api}`));
    }, 15_000);

    pendingMtopRequests.set(requestId, { resolve, reject, timer });

    console.info('[Content] 转发 MTOP_REQUEST 到页面上下文:', {
      requestId,
      api: payload.api,
      version: payload.version,
      data: payload.data,
    });

    window.postMessage(
      {
        source: PAGE_MESSAGE_SOURCE,
        type: 'MTOP_REQUEST',
        payload: {
          requestId,
          ...payload,
        },
      },
      '*'
    );
  });
}

function sendMessageViaWs(
  cid: string,
  text: string,
  buyerUserId?: string,
  participants?: string[],
): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    const requestId = buildRequestId();
    const timer = window.setTimeout(() => {
      pendingWsSendRequests.delete(requestId);
      resolve({ success: false, error: 'WS 发送超时' });
    }, 10_000);

    pendingWsSendRequests.set(requestId, { resolve, timer });

    window.postMessage({
      source: PAGE_MESSAGE_SOURCE,
      type: 'SEND_WS_MESSAGE',
      payload: { requestId, cid, text, buyerUserId, participants },
    }, '*');
  });
}

function checkWsStatus(): Promise<{ connected: boolean }> {
  return new Promise((resolve) => {
    const requestId = buildRequestId();
    const timer = window.setTimeout(() => {
      pendingWsStatusRequests.delete(requestId);
      resolve({ connected: false });
    }, 3_000);

    pendingWsStatusRequests.set(requestId, { resolve, timer });

    window.postMessage({
      source: PAGE_MESSAGE_SOURCE,
      type: 'WS_STATUS',
      payload: { requestId },
    }, '*');
  });
}

// 监听来自注入脚本的 postMessage（WS 拦截通道 + MTOP 桥接通道）
function setupMessageListener(): void {
  window.addEventListener(
    'message',
    (event) => {
      if (!isActiveContentInstance()) return;
      if (event.source !== window) return;
      if (event.data?.source !== PAGE_MESSAGE_SOURCE) return;

      const { type, payload } = event.data;

      if (type === 'WS_STATUS_RESPONSE') {
        const { requestId, connected } = payload as { requestId: string; connected: boolean };
        const pending = pendingWsStatusRequests.get(requestId);
        if (pending) {
          window.clearTimeout(pending.timer);
          pendingWsStatusRequests.delete(requestId);
          pending.resolve({ connected });
        }
        return;
      }

      if (type === 'SEND_WS_RESPONSE') {
        const { requestId, success, error } = payload as {
          requestId: string;
          success: boolean;
          error?: string;
        };
        const pending = pendingWsSendRequests.get(requestId);
        if (pending) {
          window.clearTimeout(pending.timer);
          pendingWsSendRequests.delete(requestId);
          pending.resolve({ success, error });
        }
        return;
      }

      if (type === 'MTOP_RESPONSE') {
        const { requestId, success, data, error } = payload as {
          requestId: string;
          success: boolean;
          data?: Record<string, unknown> | null;
          error?: string;
        };
        const pending = pendingMtopRequests.get(requestId);
        if (!pending) {
          // 其他标签页的 MTOP 响应通过 postMessage 广播到所有 content script
          // 非本标签页发起的请求，静默忽略
          return;
        }

        window.clearTimeout(pending.timer);
        pendingMtopRequests.delete(requestId);

        console.info('[Content] 收到页面上下文 MTOP_RESPONSE:', {
          requestId,
          success,
          error,
          ret: data?.['ret'],
        });

        if (success) {
          pending.resolve(data ?? null);
        } else {
          pending.reject(new Error(error || '页面上下文 mtop 请求失败'));
        }
        return;
      }

      console.info('[Content] 收到 WS 消息:', type, payload);
      handleContentMessage(type, payload);
    },
    false
  );
}

// 监听来自 background 的消息（INJECT_REPLY 回退通道 + MTOP 请求转发通道）
function setupBackgroundListener(): void {
  chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
    if (!isActiveContentInstance()) {
      console.info('[Content] 忽略非当前实例的 background 消息:', message.type);
      return false;
    }

    if (message.type === 'INJECT_REPLY') {
      const { conversationId, content } = message.payload;
      console.info('[Content] 收到 background INJECT_REPLY 指令:', conversationId);
      injectReplyToChat(content, conversationId)
        .then((result) => {
          console.info('[Content] INJECT_REPLY 结果:', result);
          sendResponse(result);
        })
        .catch((err) => {
          console.error('[Content] INJECT_REPLY 执行失败:', err);
          sendResponse({ success: false, error: String(err) });
        });
      return true;
    }

    if (message.type === 'WS_STATUS') {
      checkWsStatus().then((result) => sendResponse(result));
      return true;
    }

    if (message.type === 'SEND_REPLY') {
      const { conversationId, content, buyerUserId, participants } = message.payload;
      console.info('[Content] 收到 SEND_REPLY，通过 WS 发送:', conversationId, content.slice(0, 50));
      sendMessageViaWs(conversationId, content, buyerUserId, participants)
        .then((result) => {
          console.info('[Content] WS 发送结果:', result);
          sendResponse(result);
        });
      return true;
    }

    if (message.type === 'MTOP_REQUEST') {
      console.info('[Content] 收到 background MTOP_REQUEST:', message.payload.api, message.payload.version);
      requestMtopViaPage(message.payload)
        .then((result) => {
          console.info('[Content] MTOP_REQUEST 转发完成:', message.payload.api, result?.['ret']);
          sendResponse({ success: true, data: result });
        })
        .catch((err) => {
          console.error('[Content] MTOP_REQUEST 转发失败:', err);
          sendResponse({ success: false, error: String(err) });
        });
      return true;
    }

    if (message.type === 'SCRAPE_UNREAD') {
      console.info('[Content] 收到 SCRAPE_UNREAD 请求，开始抓取 DOM');
      const messages = scrapeUnreadConversations();
      console.info('[Content] DOM 抓取结果:', messages.length, '条未读会话');
      sendResponse({ success: true, messages });
      return false;
    }

    if (message.type === 'PING') {
      sendResponse({ pong: true });
      return false;
    }

    return false;
  });
}

/**
 * 从 DOM 抓取未读会话列表
 * 闲鱼聊天页面 DOM 结构：
 *   .conversation-item--xxx  (会话条目)
 *     └ .ant-badge .ant-scroll-number-only-unit.current  (未读数)
 *     └ div (昵称)
 *     └ div (最后一条消息)
 *     └ div (时间)
 */
function scrapeUnreadConversations(): BuyerMessage[] {
  // 只在 /im 页面有会话列表
  if (!window.location.pathname.startsWith('/im')) {
    console.info('[Content] 非聊天页面，跳过 DOM 抓取');
    return [];
  }

  const items = document.querySelectorAll('[class*="conversation-item"]');
  const messages: BuyerMessage[] = [];

  items.forEach((el) => {
    // 检查是否有未读标记（ant-badge 组件）
    const badge = el.querySelector('.ant-scroll-number-only-unit.current, [class*="ant-badge"] sup');
    const unreadText = badge?.textContent?.trim();
    const unreadCount = parseInt(unreadText || '0', 10);
    if (unreadCount <= 0) return;

    // 提取文本内容：分离未读数、消息内容、时间
    const fullText = el.textContent?.trim() || '';

    // 获取所有叶子文本节点
    const textParts: string[] = [];
    const leafDivs = el.querySelectorAll('div');
    leafDivs.forEach((d) => {
      // 只取没有子 div 的叶子 div
      if (d.querySelector('div')) return;
      const t = d.textContent?.trim();
      if (t && t !== unreadText) textParts.push(t);
    });

    // textParts 通常是: [昵称+消息+时间] 或 [消息, 时间] 等
    // 尝试提取最后一项为时间，倒数第二项为消息内容
    let content = '';
    let timeStr = '';
    if (textParts.length >= 2) {
      timeStr = textParts[textParts.length - 1];
      content = textParts[textParts.length - 2];
    } else if (textParts.length === 1) {
      content = textParts[0];
    }

    if (!content) return;

    // 生成消息 ID（基于内容 hash 避免重复处理）
    const msgId = `dom-${hashCode(fullText)}-${Date.now()}`;

    messages.push({
      id: msgId,
      buyerName: '买家',
      content,
      timestamp: Date.now(),
      conversationId: `dom-${hashCode(el.textContent || '')}`,
      conversationIdType: 'derived',
      productTitle: '',
    });

    console.info('[Content] DOM 抓取到未读会话:', { content, unreadCount, timeStr });
  });

  return messages;
}

function hashCode(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

async function handleContentMessage(
  type: string,
  payload: unknown
): Promise<void> {
  switch (type) {
    case 'BUYER_MESSAGE': {
      const msg = payload as BuyerMessage;
      console.info('[Content] 买家消息 → 发送给 Background:', msg);
      // 通知页面上下文：消息已转发给 Background
      window.postMessage({ source: PAGE_MESSAGE_SOURCE, type: 'BUYER_MESSAGE_FORWARDED', payload: { id: msg.id, content: msg.content } }, '*');
      try {
        const response = await chrome.runtime.sendMessage({
          type: 'BUYER_MESSAGE',
          payload: msg,
        });
        console.info('[Content] Background 处理结果:', response);
        // 通知页面上下文：Background 处理完成
        window.postMessage({ source: PAGE_MESSAGE_SOURCE, type: 'BUYER_MESSAGE_RESULT', payload: { id: msg.id, response } }, '*');
      } catch (err) {
        console.error('[Content] sendMessage 失败:', err);
        window.postMessage({ source: PAGE_MESSAGE_SOURCE, type: 'BUYER_MESSAGE_RESULT', payload: { id: msg.id, error: String(err) } }, '*');
      }
      break;
    }

    case 'ORDER_CREATED': {
      const order = payload as OrderEvent;
      console.info('[Content] 新订单 → 发送给 Background:', order);
      try {
        await chrome.runtime.sendMessage({
          type: 'ORDER_CREATED',
          payload: order,
        });
      } catch (err) {
        console.error('[Content] ORDER_CREATED sendMessage 失败:', err);
      }
      break;
    }

    case 'DIAG': {
      try {
        const resp = await chrome.runtime.sendMessage({ type: 'DIAG' as any });
        console.info('[Content] DIAG 结果:', JSON.stringify(resp));
        // 把结果通过 postMessage 回传给页面上下文
        window.postMessage({ source: 'xianyu-smart-assistant', type: 'DIAG_RESULT', payload: resp }, '*');
      } catch (err) {
        console.error('[Content] DIAG 失败:', err);
      }
      break;
    }

    default:
      break;
  }
}

/**
 * 将 AI 回复注入到闲鱼聊天输入框并自动发送
 *
 * 闲鱼聊天 DOM 结构：
 * - 输入框: textarea[placeholder*="请输入消息"]
 * - 发送按钮: 包含"发 送"文字的 button
 * - 也支持 Enter 键发送
 */
async function injectReplyToChat(
  reply: string,
  conversationId: string
): Promise<{ success: boolean; error?: string }> {
  if (!window.location.pathname.startsWith('/im')) {
    return { success: false, error: '当前页面不是 /im 聊天页' };
  }

  if (conversationId.startsWith('dom-')) {
    console.log('[Content] DOM 回退收到派生会话 ID，无法精准切换会话:', conversationId);
  }

  // 1. 查找输入框
  const inputEl = document.querySelector(
    'textarea[placeholder*="请输入消息"], textarea[placeholder*="回复"], textarea[placeholder*="输入"], [data-spm="chat-input"], div[contenteditable="true"]'
  ) as HTMLTextAreaElement | HTMLDivElement | null;

  if (!inputEl) {
    console.log('[Content] 未找到聊天输入框（当前可能不在具体聊天会话中）');
    return { success: false, error: '未找到聊天输入框' };
  }

  console.info('[Content] 找到输入框，注入回复:', inputEl.tagName, reply.slice(0, 50), 'conversationId:', conversationId);

  // 2. 设置输入框内容
  if (inputEl instanceof HTMLTextAreaElement) {
    // 使用 React 兼容的方式设置值
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value'
    )?.set;
    if (nativeInputValueSetter) {
      nativeInputValueSetter.call(inputEl, reply);
    } else {
      inputEl.value = reply;
    }
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    inputEl.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    inputEl.textContent = reply;
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
  }

  await new Promise((resolve) => setTimeout(resolve, 300));

  // 3. 点击发送按钮或回车
  const allButtons = document.querySelectorAll('button, [class*="sendbox"]');
  let sendBtn: Element | null = null;
  allButtons.forEach((btn) => {
    const text = btn.textContent?.replace(/\s/g, '') || '';
    if (text === '发送') sendBtn = btn;
  });

  if (sendBtn) {
    console.info('[Content] 点击发送按钮');
    (sendBtn as HTMLElement).click();
    return { success: true };
  }

  console.info('[Content] 未找到发送按钮，模拟 Enter 键');
  inputEl.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true
  }));
  return { success: true };
}

// 初始化
function init(): void {
  console.log('[Content] 闲鱼智能客服扩展已加载，页面:', window.location.pathname);
  injectInterceptor(); // 立即注入，不等待 DOM
  setupMessageListener();
  setupBackgroundListener();
}

// document_start 阶段立即执行，不等待 DOMContentLoaded
// 这样 WS 拦截器尽早注入，减少被页面 WS 抢先的可能
markContentInstance();
init();
