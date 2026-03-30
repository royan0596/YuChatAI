import type { BuyerMessage } from '../shared/types';
import { callBackgroundMtopApi, isBackgroundWsConnected } from './ws-client';

const POLL_INTERVAL = 15_000;
const MAX_PROCESSED_IDS = 200;

let pollTimer: ReturnType<typeof setInterval> | null = null;
let onNewMessage: ((msg: BuyerMessage) => void) | null = null;
let lastUnreadTotal = 0;
const processedMsgIds = new Set<string>();

function addProcessedId(id: string): void {
  processedMsgIds.add(id);
  if (processedMsgIds.size > MAX_PROCESSED_IDS) {
    const first = processedMsgIds.values().next().value;
    if (first) processedMsgIds.delete(first);
  }
}

async function callMtop(
  api: string,
  version: string,
  data: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  return await callBackgroundMtopApi(api, version, data);
}

async function checkUnreadAndExtract(): Promise<{
  hasNewUnread: boolean;
  extractedMessages: BuyerMessage[];
}> {
  const result = await callMtop('mtop.taobao.idlemessage.pc.redpoint.query', '1.0', {
    sessionTypes: '1,19,15,32,3,44,51,52,24',
    fetch: 50,
  });

  if (!result) return { hasNewUnread: false, extractedMessages: [] };

  const ret = result['ret'] as string[] | undefined;
  const data = result['data'] as Record<string, unknown> | undefined;
  if (!ret?.[0]?.startsWith('SUCCESS') || !data) {
    console.log('[Poller] 红点接口返回非成功状态:', ret);
    return { hasNewUnread: false, extractedMessages: [] };
  }

  const total = Number(data['total'] ?? 0);
  const hasNewUnread = total > lastUnreadTotal;
  if (hasNewUnread) {
    console.info('[Poller] 未读数增加:', lastUnreadTotal, '->', total);
  }
  lastUnreadTotal = total;

  return {
    hasNewUnread,
    extractedMessages: tryExtractFromRedpoint(data),
  };
}

function tryExtractFromRedpoint(data: Record<string, unknown>): BuyerMessage[] {
  const messages: BuyerMessage[] = [];
  const candidates = [data['sessionList'], data['sessions'], data['items'], data['list']];
  let sessions: Record<string, unknown>[] | null = null;

  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length > 0) {
      sessions = candidate as Record<string, unknown>[];
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

function parseSessionItem(session: Record<string, unknown>): BuyerMessage | null {
  try {
    const unreadCount = Number(session['unreadCount'] ?? session['unread'] ?? 0);
    if (unreadCount <= 0) return null;

    const cidRaw = String(session['cid'] ?? session['sessionId'] ?? session['conversationId'] ?? '');
    if (!cidRaw) return null;
    const conversationId = cidRaw.replace('@goofish', '');

    const lastMsg = (session['lastMessage'] ?? session['latestMessage'] ?? session['message'] ?? {}) as Record<string, unknown>;
    const msgContent = String(
      lastMsg['content'] ??
      lastMsg['text'] ??
      lastMsg['summary'] ??
      session['lastContent'] ??
      session['digest'] ??
      session['summary'] ??
      '',
    );
    if (!msgContent) return null;

    const msgId = String(lastMsg['messageId'] ?? lastMsg['msgId'] ?? lastMsg['id'] ?? `poll-${conversationId}-${Date.now()}`);
    if (processedMsgIds.has(msgId)) return null;

    const senderNick = String(
      lastMsg['senderNick'] ??
      lastMsg['nick'] ??
      session['otherNick'] ??
      session['peerNick'] ??
      session['nick'] ??
      '买家',
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

async function pollOnce(): Promise<void> {
  try {
    if (!isBackgroundWsConnected()) {
      console.info('[Poller] WS 未连接（实时通道不可用，轮询是唯一通道）');
    }

    const { hasNewUnread, extractedMessages } = await checkUnreadAndExtract();
    if (!hasNewUnread) return;

    console.info('[Poller] 检测到新的未读消息');
    if (extractedMessages.length > 0) {
      for (const msg of extractedMessages) {
        console.info('[Poller] 红点提取消息:', msg.buyerName, msg.content.slice(0, 50));
        onNewMessage?.(msg);
      }
      return;
    }

    console.info('[Poller] 已检测到未读变化，但红点接口未返回消息摘要，等待后台 WS 推送正文');
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
  void pollOnce();
  pollTimer = setInterval(() => {
    void pollOnce();
  }, POLL_INTERVAL);
}

export function stopPolling(): void {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
  console.info('[Poller] 轮询已停止');
}

export function isPolling(): boolean {
  return pollTimer !== null;
}
