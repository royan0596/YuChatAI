import { decodeSyncData } from '../content/msgpack';
import type { BuyerMessage } from '../shared/types';
import { findAnyGoofishTab } from './im-tab-manager';

const WS_URL = 'wss://wss-goofish.dingtalk.com/';
const BRIDGE_URL = 'https://www.goofish.com/';
const ACCESS_TOKEN_APP_KEY = '444e9908a51d1cb236a27862abc769c9';
const DINGTALK_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36 DingTalk(2.1.5) OS(Windows/10) Browser(Chrome/133.0.0.0) DingWeb/2.1.5 IMPaaS DingWeb/2.1.5';
const HEARTBEAT_INTERVAL = 15_000;
const BRIDGE_WAIT_TIMEOUT = 15_000;
const CONNECT_TIMEOUT = 15_000;
const SEND_TIMEOUT = 10_000;

type JsonRecord = Record<string, unknown>;
type BackgroundWsMessageHandler = (msg: BuyerMessage) => void | Promise<void>;
type PendingSendResult = { success: boolean; reason?: string; usedConversationId?: string };
type SystemRequestType = 'register' | 'ackDiff' | 'heartbeat';

let bridgeTabId: number | null = null;
let activeWs: WebSocket | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let wsReadyPromise: Promise<boolean> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let currentDeviceId = '';
let currentAccessToken = '';
let currentUserId = '';
let backgroundWsMessageHandler: BackgroundWsMessageHandler | null = null;

const conversationParticipants = new Map<string, string[]>();
const conversationAliases = new Map<string, string[]>();
const pendingSystemRequests = new Map<string, SystemRequestType>();
const pendingSendRequests = new Map<
  string,
  {
    resolve: (value: PendingSendResult) => void;
    timer: ReturnType<typeof setTimeout>;
    cid: string;
    text: string;
    accepted: boolean;
  }
>();

function buildMid(prefix = ''): string {
  const head = prefix ? `${prefix}-` : '';
  return `${head}${Math.floor(Math.random() * 999)}${Date.now()} 0`;
}

function generateDeviceId(uid: string): string {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const result: string[] = [];
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      result.push('-');
    } else if (i === 14) {
      result.push('4');
    } else if (i === 19) {
      const r = Math.floor(16 * Math.random());
      result.push(chars[(r & 0x3) | 0x8]);
    } else {
      result.push(chars[Math.floor(16 * Math.random())]);
    }
  }
  return result.join('') + '-' + uid;
}

function getConversationKey(conversationId: string): string {
  return conversationId.includes('@') ? conversationId : `${conversationId}@goofish`;
}

function stripGoofishSuffix(value: string): string {
  return String(value ?? '').trim().replace(/@goofish$/, '');
}

function ensureGoofishUserId(value: string): string {
  const normalized = stripGoofishSuffix(value);
  return normalized ? `${normalized}@goofish` : '';
}

function normalizeParticipants(participants: string[]): string[] {
  const unique = new Set<string>();
  for (const participant of participants) {
    const normalized = ensureGoofishUserId(String(participant ?? ''));
    if (!normalized) continue;
    unique.add(normalized);
  }
  return Array.from(unique);
}

function reduceParticipants(participants: string[], currentUid: string): string[] {
  const normalized = normalizeParticipants(participants);
  if (normalized.length <= 2) return normalized;

  const current = ensureGoofishUserId(currentUid);
  const peers = normalized.filter((participant) => participant !== current);
  if (current && peers.length > 0) {
    return [peers[0], current];
  }

  return normalized.slice(0, 2);
}

function isLikelyUserId(value: string): boolean {
  return /^\d+$/.test(stripGoofishSuffix(value));
}

function isLikelyConversationId(value: string): boolean {
  const normalized = stripGoofishSuffix(value);
  if (!normalized || isLikelyUserId(normalized)) return false;
  return /[A-Za-z._:-]/.test(normalized);
}

function normalizeComparableText(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function rememberConversationAliases(primaryConversationId: string, candidates: string[]): void {
  const all = Array.from(new Set(
    [primaryConversationId, ...candidates]
      .map((value) => stripGoofishSuffix(value))
      .filter(Boolean),
  ));

  if (all.length < 2) return;

  for (const conversationId of all) {
    conversationAliases.set(
      getConversationKey(conversationId),
      all.filter((candidate) => candidate !== conversationId),
    );
  }
}

function getConversationAliasKeys(conversationId: string): string[] {
  const key = getConversationKey(conversationId);
  const aliases = conversationAliases.get(key) ?? [];
  return [key, ...aliases.map((alias) => getConversationKey(alias))];
}

function isSameConversation(candidateA: string, candidateB: string): boolean {
  const aliasesA = new Set(getConversationAliasKeys(candidateA));
  const aliasesB = getConversationAliasKeys(candidateB);
  return aliasesB.some((alias) => aliasesA.has(alias));
}

function stopHeartbeat(): void {
  if (!heartbeatTimer) return;
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

function startHeartbeat(ws: WebSocket): void {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) {
      stopHeartbeat();
      return;
    }

    const mid = buildMid('hb');
    pendingSystemRequests.set(mid, 'heartbeat');
    ws.send(JSON.stringify({ lwp: '/!', headers: { mid } }));
  }, HEARTBEAT_INTERVAL);
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void ensureBackgroundWs();
  }, 5_000);
}

function readTextCandidate(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object') return '';

  const record = value as JsonRecord;
  const nestedKeys = ['text', 'content', 'summary', 'title'];
  for (const key of nestedKeys) {
    const nested = record[key];
    if (typeof nested === 'string' && nested.trim()) return nested.trim();
    if (nested && typeof nested === 'object') {
      const nestedText = readTextCandidate(nested);
      if (nestedText) return nestedText;
    }
  }

  return '';
}

function decodeEmbeddedMessageText(value: unknown): string {
  if (typeof value !== 'string' || !value) return '';

  try {
    const decoded = JSON.parse(atob(value)) as JsonRecord;
    return readTextCandidate(decoded);
  } catch {
    return '';
  }
}

function extractJsonMessageText(content: JsonRecord): string {
  const custom = content['custom'] as JsonRecord | undefined;
  const directCandidates = [
    content['summary'],
    content['text'],
    content['content'],
    custom?.['summary'],
    custom?.['content'],
    custom?.['text'],
    custom?.['title'],
  ];

  for (const candidate of directCandidates) {
    const text = readTextCandidate(candidate);
    if (text) return text;
  }

  const embeddedCandidates = [
    custom?.['data'],
    content['data'],
    (content['text'] as JsonRecord | undefined)?.['data'],
  ];

  for (const candidate of embeddedCandidates) {
    const text = decodeEmbeddedMessageText(candidate);
    if (text) return text;
  }

  return '';
}

function getPeerUserIdFromReminderUrl(reminderUrl: string): string {
  if (!reminderUrl) return '';
  const match = reminderUrl.match(/[?&]peerUserId=(\d+)/);
  return match?.[1] ?? '';
}

function resolveMsgPackConversationId(
  msgObj: JsonRecord,
  senderUserId: string,
  currentUid: string,
): string {
  const rawCandidates = [
    String(msgObj['3'] ?? '').trim(),
    String(msgObj['2'] ?? '').trim(),
    String(msgObj['1'] ?? '').trim(),
  ].filter(Boolean);

  const userIds = new Set(
    [senderUserId, currentUid]
      .map((value) => stripGoofishSuffix(value))
      .filter(Boolean),
  );

  for (const candidate of rawCandidates) {
    const normalized = stripGoofishSuffix(candidate);
    if (!normalized || userIds.has(normalized)) continue;
    if (isLikelyConversationId(normalized)) return normalized;
  }

  for (const candidate of rawCandidates) {
    const normalized = stripGoofishSuffix(candidate);
    if (!normalized || userIds.has(normalized)) continue;
    return normalized;
  }

  return stripGoofishSuffix(rawCandidates[0] ?? '');
}

function buildConversationParticipants(
  senderUserId: string,
  currentUid: string,
  reminderUrl: string,
  msgObj?: JsonRecord,
): string[] {
  const currentUserFull = ensureGoofishUserId(currentUid);
  const peerCandidates = [
    senderUserId,
    getPeerUserIdFromReminderUrl(reminderUrl),
    String(msgObj?.['1'] ?? ''),
    String(msgObj?.['2'] ?? ''),
  ];

  let peerUserFull = '';
  for (const candidate of peerCandidates) {
    const userFull = ensureGoofishUserId(candidate);
    if (!userFull || !isLikelyUserId(userFull)) continue;
    if (currentUserFull && userFull === currentUserFull) continue;
    peerUserFull = userFull;
    break;
  }

  if (peerUserFull && currentUserFull) return [peerUserFull, currentUserFull];
  if (peerUserFull) return [peerUserFull];
  if (currentUserFull) return [currentUserFull];
  return [];
}

async function waitForTabComplete(tabId: number, timeout = BRIDGE_WAIT_TIMEOUT): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(false);
    }, timeout);

    function listener(updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo): void {
      if (updatedTabId !== tabId || changeInfo.status !== 'complete') return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(true);
    }

    chrome.tabs.onUpdated.addListener(listener);

    chrome.tabs.get(tabId)
      .then((tab) => {
        if (tab.status !== 'complete') return;
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(true);
      })
      .catch(() => {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(false);
      });
  });
}

async function ensureContentScript(tabId: number): Promise<boolean> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    return true;
  } catch {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content.js'],
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      await chrome.tabs.sendMessage(tabId, { type: 'PING' });
      return true;
    } catch (err) {
      console.error('[BackgroundWs] Content script 注入失败:', err);
      return false;
    }
  }
}

async function ensureBridgeTab(): Promise<number | null> {
  if (bridgeTabId) {
    try {
      const tab = await chrome.tabs.get(bridgeTabId);
      if (tab.id && tab.status === 'complete') {
        const ready = await ensureContentScript(tab.id);
        if (ready) return tab.id;
      }
    } catch {
      bridgeTabId = null;
    }
  }

  const existing = await findAnyGoofishTab();
  if (existing) {
    bridgeTabId = existing;
    return existing;
  }

  try {
    const tab = await chrome.tabs.create({
      url: BRIDGE_URL,
      active: false,
      pinned: true,
    });
    if (!tab.id) return null;

    const loaded = await waitForTabComplete(tab.id);
    if (!loaded) {
      console.warn('[BackgroundWs] 桥接页加载超时:', tab.id);
      return null;
    }

    const ready = await ensureContentScript(tab.id);
    if (!ready) return null;

    bridgeTabId = tab.id;
    return tab.id;
  } catch (err) {
    console.error('[BackgroundWs] 创建桥接页失败:', err);
    return null;
  }
}

async function getCurrentUserId(): Promise<string> {
  const cookie = await chrome.cookies.get({ url: 'https://www.goofish.com', name: 'unb' });
  currentUserId = cookie?.value ?? '';
  return currentUserId;
}

async function requestAccessToken(): Promise<string | null> {
  const tabId = await ensureBridgeTab();
  if (!tabId) return null;

  const uid = await getCurrentUserId();
  currentDeviceId = generateDeviceId(uid);

  try {
    const resp = await chrome.tabs.sendMessage(tabId, {
      type: 'MTOP_REQUEST',
      payload: {
        api: 'mtop.taobao.idlemessage.pc.login.token',
        version: '1.0',
        data: {
          appKey: ACCESS_TOKEN_APP_KEY,
          deviceId: currentDeviceId,
        },
      },
    }) as { success?: boolean; data?: JsonRecord } | undefined;

    const token = (resp?.data?.['data'] as JsonRecord | undefined)?.['accessToken'];
    if (!resp?.success || typeof token !== 'string' || !token) {
      console.warn('[BackgroundWs] accessToken 获取失败:', resp);
      return null;
    }

    currentAccessToken = token;
    return token;
  } catch (err) {
    console.error('[BackgroundWs] accessToken 请求异常:', err);
    return null;
  }
}

function buildRegisterMessage(accessToken: string, mid: string): string {
  return JSON.stringify({
    lwp: '/reg',
    headers: {
      'cache-header': 'app-key token ua wv',
      'app-key': ACCESS_TOKEN_APP_KEY,
      token: accessToken,
      ua: DINGTALK_UA,
      dt: 'j',
      wv: 'im:3,au:3,sy:6',
      sync: '0,0;0;0;',
      did: currentDeviceId,
      mid,
    },
  });
}

function ackServerMessage(ws: WebSocket, data: JsonRecord): void {
  const headers = data['headers'] as JsonRecord | undefined;
  if (!headers?.['mid'] || ws.readyState !== WebSocket.OPEN) return;

  const ack: JsonRecord = {
    code: 200,
    headers: {
      mid: headers['mid'],
      sid: headers['sid'] ?? '',
    },
  };
  if (headers['app-key']) (ack['headers'] as JsonRecord)['app-key'] = headers['app-key'];
  if (headers['ua']) (ack['headers'] as JsonRecord)['ua'] = headers['ua'];
  if (headers['dt']) (ack['headers'] as JsonRecord)['dt'] = headers['dt'];

  ws.send(JSON.stringify(ack));
}

function settlePendingSend(mid: string, success: boolean, reason?: string): void {
  const pending = pendingSendRequests.get(mid);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingSendRequests.delete(mid);
  pending.resolve({ success, reason });
}

function markPendingSendAccepted(mid: string): void {
  const pending = pendingSendRequests.get(mid);
  if (!pending) return;
  pending.accepted = true;
}

function confirmPendingSendByEcho(
  conversationId: string,
  content: string,
  senderUserId: string,
): void {
  const currentUid = stripGoofishSuffix(currentUserId);
  if (!currentUid || stripGoofishSuffix(senderUserId) !== currentUid) return;

  const cidFull = getConversationKey(conversationId);
  const normalizedContent = normalizeComparableText(content);
  if (!normalizedContent) return;

  for (const [mid, pending] of pendingSendRequests) {
    if (!pending.accepted) continue;
    if (!isSameConversation(pending.cid, cidFull)) continue;

    const pendingText = normalizeComparableText(pending.text);
    if (
      pendingText === normalizedContent ||
      pendingText.includes(normalizedContent) ||
      normalizedContent.includes(pendingText)
    ) {
      console.info('[BackgroundWs] 发送消息已在后台会话流中回显:', {
        cidFull,
        pendingCid: pending.cid,
        mid,
      });
      settlePendingSend(mid, true);
      return;
    }
  }
}

function sendAckDiff(ws: WebSocket): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  const now = Date.now();
  const mid = buildMid('ack');
  pendingSystemRequests.set(mid, 'ackDiff');
  ws.send(JSON.stringify({
    lwp: '/r/SyncStatus/ackDiff',
    headers: { mid },
    body: [
      {
        pipeline: 'sync',
        tooLong2Tag: 'PNM,1',
        channel: 'sync',
        topic: 'sync',
        highPts: 0,
        pts: now * 1000,
        seq: 0,
        timestamp: now,
      },
    ],
  }));
}

function dispatchBackgroundBuyerMessage(msg: BuyerMessage): void {
  rememberConversationParticipants(msg.conversationId, msg.participants);
  console.info('[BackgroundWs] 实时买家消息:', {
    conversationId: msg.conversationId,
    buyerUserId: msg.buyerUserId ?? '',
    content: msg.content.slice(0, 60),
  });

  if (!backgroundWsMessageHandler) return;
  Promise.resolve(backgroundWsMessageHandler(msg)).catch((err) => {
    console.error('[BackgroundWs] 买家消息处理回调失败:', err);
  });
}

function parseUserMessageModel(model: JsonRecord): BuyerMessage | null {
  const userExt = model['userExtension'] as JsonRecord | undefined;
  const message = model['message'] as JsonRecord | undefined;
  if (!message) return null;

  const ext = message['extension'] as JsonRecord | undefined;
  if (!ext) return null;

  const msgId = String(message['messageId'] ?? '');
  const content = String(ext['reminderContent'] ?? '');
  const buyerName = String(ext['reminderTitle'] ?? '买家');
  const createAt = Number(message['createAt'] ?? 0);
  const cidRaw = String(message['cid'] ?? '');
  const conversationId = stripGoofishSuffix(cidRaw);
  const senderUserId = stripGoofishSuffix(String(ext['senderUserId'] ?? ''));
  const reminderUrl = String(ext['reminderUrl'] ?? '');

  confirmPendingSendByEcho(conversationId, content, senderUserId);

  if (userExt?.['needPush'] !== 'true') return null;
  if (!content || !msgId) return null;
  if (currentUserId && senderUserId === currentUserId) return null;

  const participants = buildConversationParticipants(senderUserId, currentUserId, reminderUrl, message);
  if (cidRaw && participants.length >= 2) {
    conversationParticipants.set(getConversationKey(cidRaw), participants);
  }

  const itemIdMatch = reminderUrl.match(/itemId=(\d+)/);

  return {
    id: msgId,
    buyerName,
    content,
    timestamp: createAt || Date.now(),
    conversationId,
    buyerUserId: senderUserId,
    conversationIdType: 'real',
    participants,
    itemId: itemIdMatch?.[1] ?? '',
    productTitle: '',
  };
}

function parseSyncPushItemJson(decoded: JsonRecord): BuyerMessage | null {
  const operation = decoded['operation'] as JsonRecord | undefined;
  if (!operation) return null;

  const content = operation['content'] as JsonRecord | undefined;
  const sender = operation['sender'] as JsonRecord | undefined;
  if (!content || !sender) return null;

  const messageText = extractJsonMessageText(content);
  if (!messageText) return null;

  const senderUid = stripGoofishSuffix(String(sender['uid'] ?? ''));
  const senderNick = String(sender['nick'] ?? (senderUid || '买家'));
  const cidRaw = String(operation['cid'] ?? decoded['cid'] ?? '');
  const conversationId = stripGoofishSuffix(cidRaw);
  const createAt = Number(operation['createAt'] ?? decoded['createAt'] ?? 0);
  const msgId = String(operation['messageId'] ?? decoded['messageId'] ?? `json-${conversationId}-${createAt || Date.now()}`);

  confirmPendingSendByEcho(conversationId, messageText, senderUid);

  if (currentUserId && senderUid === currentUserId) return null;
  if (messageText.startsWith('[') && messageText.endsWith(']')) return null;

  let participants: string[] = [];
  if (cidRaw && senderUid) {
    const senderFull = ensureGoofishUserId(senderUid);
    const currentFull = ensureGoofishUserId(currentUserId);
    participants = currentFull && senderFull !== currentFull
      ? [senderFull, currentFull]
      : senderFull ? [senderFull] : [];
    if (participants.length >= 2) {
      conversationParticipants.set(getConversationKey(cidRaw), participants);
    }
  }

  const reminderUrl = String((operation['extension'] as JsonRecord | undefined)?.['reminderUrl'] ?? '');
  const itemIdMatch = reminderUrl.match(/itemId=(\d+)/);

  return {
    id: msgId,
    buyerName: senderNick,
    content: messageText,
    timestamp: createAt || Date.now(),
    conversationId,
    buyerUserId: senderUid,
    conversationIdType: 'real',
    participants,
    itemId: itemIdMatch?.[1] ?? '',
    productTitle: '',
  };
}

function parseSyncPushItem(decoded: JsonRecord): BuyerMessage | null {
  if (decoded['operation'] || decoded['chatType'] !== undefined) {
    return parseSyncPushItemJson(decoded);
  }

  const msgObj = decoded['1'] as JsonRecord | undefined;
  if (!msgObj || typeof msgObj !== 'object') {
    return parseSyncPushItemJson(decoded);
  }

  const userExt = decoded['3'] as JsonRecord | undefined;
  if (userExt?.['needPush'] === 'false') return null;

  const ext = msgObj['10'] as JsonRecord | undefined;
  if (!ext) return parseSyncPushItemJson(decoded);

  const messageContent = String(ext['reminderContent'] ?? '');
  const senderName = String(ext['reminderTitle'] ?? '买家');
  const senderUserId = stripGoofishSuffix(String(ext['senderUserId'] ?? ''));
  const reminderUrl = String(ext['reminderUrl'] ?? '');
  const conversationId = resolveMsgPackConversationId(msgObj, senderUserId, currentUserId);
  const createAt = Number(msgObj['5'] ?? 0);
  const realMsgId = String(ext['messageId'] ?? '');
  const msgId = realMsgId || `sync-${conversationId}-${createAt || Date.now()}`;

  confirmPendingSendByEcho(conversationId, messageContent, senderUserId);

  if (!messageContent) return null;
  if (currentUserId && senderUserId === currentUserId) return null;
  if (messageContent.startsWith('[') && messageContent.endsWith(']')) return null;

  const participants = buildConversationParticipants(senderUserId, currentUserId, reminderUrl, msgObj);
  if (conversationId && participants.length >= 2) {
    conversationParticipants.set(getConversationKey(conversationId), participants);
  }
  rememberConversationAliases(conversationId, [
    String(msgObj['2'] ?? ''),
    String(msgObj['3'] ?? ''),
  ]);

  const itemIdMatch = reminderUrl.match(/itemId=(\d+)/);

  console.info('[BackgroundWs] MsgPack 实时消息解析:', {
    conversationId,
    buyerUserId: senderUserId,
    rawKey2: String(msgObj['2'] ?? ''),
    rawKey3: String(msgObj['3'] ?? ''),
  });

  return {
    id: msgId,
    buyerName: senderName,
    content: messageContent,
    timestamp: createAt || Date.now(),
    conversationId,
    buyerUserId: senderUserId,
    conversationIdType: 'real',
    participants,
    itemId: itemIdMatch?.[1] ?? '',
    productTitle: '',
  };
}

function parseAndDispatchIncoming(data: JsonRecord, ws: WebSocket): void {
  const body = data['body'] as JsonRecord | undefined;
  if (!body) return;

  const syncMessages: BuyerMessage[] = [];
  const modelMessages: BuyerMessage[] = [];

  if (Array.isArray(body['userMessageModels'])) {
    for (const model of body['userMessageModels'] as JsonRecord[]) {
      const msg = parseUserMessageModel(model);
      if (msg) modelMessages.push(msg);
    }
  }

  const syncPkg = body['syncPushPackage'] as JsonRecord | undefined;
  if (syncPkg && Array.isArray(syncPkg['data'])) {
    for (const item of syncPkg['data'] as JsonRecord[]) {
      const b64 = item?.['data'];
      if (typeof b64 !== 'string' || !b64) continue;

      const decoded = decodeSyncData(b64);
      if (!decoded) continue;

      const msg = parseSyncPushItem(decoded);
      if (msg) syncMessages.push(msg);
    }
  }

  const messagesToDispatch = syncMessages.length > 0 ? syncMessages : modelMessages;
  if (syncMessages.length > 0 && modelMessages.length > 0) {
    console.info('[BackgroundWs] 同时收到 userMessageModels 和 syncPushPackage，优先采用 syncPushPackage');
  }

  if (messagesToDispatch.length === 0) return;

  for (const msg of messagesToDispatch) {
    dispatchBackgroundBuyerMessage(msg);
  }

  sendAckDiff(ws);
}

async function connectBackgroundWs(): Promise<boolean> {
  const accessToken = currentAccessToken || await requestAccessToken();
  if (!accessToken) return false;

  return new Promise((resolve) => {
    const ws = new WebSocket(WS_URL);
    const registerMid = buildMid('reg');
    let settled = false;

    const connectTimer = setTimeout(() => {
      try { ws.close(); } catch { /* ignore */ }
      if (!settled) {
        settled = true;
        resolve(false);
      }
    }, CONNECT_TIMEOUT);

    ws.addEventListener('open', () => {
      activeWs = ws;
      pendingSystemRequests.set(registerMid, 'register');
      ws.send(buildRegisterMessage(accessToken, registerMid));
      console.info('[BackgroundWs] 后台 WS 已建立，等待注册确认', {
        did: currentDeviceId,
        regMid: registerMid,
      });
    });

    ws.addEventListener('message', (event) => {
      try {
        if (typeof event.data !== 'string') return;
        const data = JSON.parse(event.data) as JsonRecord;
        ackServerMessage(ws, data);

        const headers = data['headers'] as JsonRecord | undefined;
        const mid = typeof headers?.['mid'] === 'string' ? headers['mid'] : '';
        const systemRequestType = mid ? pendingSystemRequests.get(mid) : undefined;

        if (mid && data['code'] !== undefined) {
          if (systemRequestType) {
            pendingSystemRequests.delete(mid);
            if (systemRequestType === 'register') {
              if (data['code'] === 200) {
                clearTimeout(connectTimer);
                startHeartbeat(ws);
                setTimeout(() => sendAckDiff(ws), 1_000);
                console.info('[BackgroundWs] 注册成功，开始接收实时消息');
                if (!settled) {
                  settled = true;
                  resolve(true);
                }
              } else {
                console.warn('[BackgroundWs] 注册失败:', {
                  mid,
                  code: data['code'],
                  body: data['body'],
                });
                currentAccessToken = '';
                try { ws.close(); } catch { /* ignore */ }
                if (!settled) {
                  settled = true;
                  resolve(false);
                }
              }
            } else if (systemRequestType === 'ackDiff' && data['code'] !== 200) {
              console.warn('[BackgroundWs] ackDiff 响应非 200:', {
                mid,
                code: data['code'],
                body: data['body'],
              });
            }
          } else if (data['code'] === 200) {
            markPendingSendAccepted(mid);
          } else {
            const reason = String((data['body'] as JsonRecord | undefined)?.['reason'] ?? '');
            console.warn('[BackgroundWs] 发送响应非 200:', {
              mid,
              code: data['code'],
              reason,
              developerMessage: (data['body'] as JsonRecord | undefined)?.['developerMessage'] ?? '',
              raw: JSON.stringify(data).slice(0, 600),
            });
            settlePendingSend(mid, false, reason);
          }
        }

        parseAndDispatchIncoming(data, ws);
      } catch (err) {
        console.warn('[BackgroundWs] message parse failed:', err);
      }
    });

    ws.addEventListener('close', () => {
      clearTimeout(connectTimer);
      if (activeWs === ws) activeWs = null;
      currentAccessToken = '';
      stopHeartbeat();
      pendingSystemRequests.clear();
      for (const [mid] of pendingSendRequests) {
        settlePendingSend(mid, false, 'WebSocket closed');
      }
      console.warn('[BackgroundWs] 后台 WS 已关闭，准备重连');
      if (!settled) {
        settled = true;
        resolve(false);
      }
      scheduleReconnect();
    });

    ws.addEventListener('error', (err) => {
      console.error('[BackgroundWs] WS 错误:', err);
    });
  });
}

export async function ensureBackgroundWs(): Promise<boolean> {
  if (activeWs?.readyState === WebSocket.OPEN) return true;
  if (wsReadyPromise) return wsReadyPromise;

  wsReadyPromise = connectBackgroundWs()
    .catch((err) => {
      console.error('[BackgroundWs] 连接异常:', err);
      return false;
    })
    .finally(() => {
      wsReadyPromise = null;
    });

  return wsReadyPromise;
}

export function isBackgroundWsConnected(): boolean {
  return activeWs?.readyState === WebSocket.OPEN;
}

export function setBackgroundWsMessageHandler(handler: BackgroundWsMessageHandler | null): void {
  backgroundWsMessageHandler = handler;
}

export function rememberConversationParticipants(
  conversationId: string,
  participants?: string[],
): void {
  if (!conversationId || !participants?.length) return;
  const normalized = normalizeParticipants(participants);
  if (normalized.length < 2) return;
  conversationParticipants.set(getConversationKey(conversationId), normalized);
}

async function submitReplyViaBackgroundWs(
  conversationKey: string,
  content: string,
  participants: string[],
  buyerUserId: string,
): Promise<PendingSendResult> {
  if (!activeWs || activeWs.readyState !== WebSocket.OPEN) {
    return { success: false, reason: 'ws_not_connected' };
  }

  const mid = buildMid();

  return await new Promise<PendingSendResult>((resolve) => {
    const timer = setTimeout(() => {
      const pending = pendingSendRequests.get(mid);
      if (!pending) return;
      pendingSendRequests.delete(mid);
      const reason = pending.accepted ? 'accepted_but_no_echo' : 'send_timeout';
      console.warn(
        pending.accepted
          ? '[BackgroundWs] 后台直发已受理但未在会话流回显:'
          : '[BackgroundWs] 后台直发等待回执超时:',
        { conversationId: conversationKey, mid },
      );
      resolve({ success: false, reason, usedConversationId: conversationKey });
    }, SEND_TIMEOUT);

    pendingSendRequests.set(mid, {
      resolve,
      timer,
      cid: conversationKey,
      text: content,
      accepted: false,
    });

    const ws = activeWs;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      clearTimeout(timer);
      pendingSendRequests.delete(mid);
      resolve({ success: false, reason: 'ws_not_connected', usedConversationId: conversationKey });
      return;
    }

    ws.send(JSON.stringify({
      lwp: '/r/MessageSend/sendByReceiverScope',
      headers: { mid },
      body: [
        {
          uuid: `-${Date.now()}${Math.floor(Math.random() * 10)}`,
          cid: conversationKey,
          conversationType: 1,
          content: {
            contentType: 101,
            custom: {
              type: 1,
              data: btoa(unescape(encodeURIComponent(JSON.stringify({
                contentType: 1,
                text: { text: content },
              })))),
            },
          },
          redPointPolicy: 0,
          extension: { extJson: '{}' },
          ctx: { appVersion: '1.0', platform: 'web' },
          mtags: {},
          msgReadStatusSetting: 1,
        },
        { actualReceivers: participants },
      ],
    }));

    console.info('[BackgroundWs] 后台直发已提交:', {
      conversationId: conversationKey,
      buyerUserId,
      participants,
      mid,
    });

    const pending = pendingSendRequests.get(mid);
    if (pending) {
      const originalResolve = pending.resolve;
      pending.resolve = (result) => originalResolve({
        ...result,
        usedConversationId: result.usedConversationId ?? conversationKey,
      });
    }
  });
}

export async function sendReplyViaBackgroundWs(
  conversationId: string,
  content: string,
  buyerUserId?: string,
  participantsHint?: string[],
): Promise<PendingSendResult> {
  if (!conversationId || conversationId.startsWith('dom-')) return { success: false, reason: 'invalid_conversation_id' };

  const key = getConversationKey(conversationId);
  const currentUid = await getCurrentUserId();
  const currentUserFull = ensureGoofishUserId(currentUid);
  const buyerUserFull = ensureGoofishUserId(buyerUserId ?? '');

  let participants =
    buyerUserFull && currentUserFull
      ? [buyerUserFull, currentUserFull]
      : conversationParticipants.get(key);

  if ((!participants || participants.length < 2) && participantsHint?.length) {
    participants = reduceParticipants([...participantsHint, currentUid], currentUid);
    if (participants.length >= 2) {
      conversationParticipants.set(key, participants);
    }
  }

  if (participants?.length) {
    participants = reduceParticipants(participants, currentUid);
  }

  if (!participants || participants.length < 2) {
    console.warn('[BackgroundWs] 缺少参与者缓存，无法后台直发:', {
      conversationId: key,
      buyerUserId: buyerUserId ?? '',
      participantsHint,
    });
    return { success: false, reason: 'missing_participants', usedConversationId: key };
  }

  const connected = await ensureBackgroundWs();
  if (!connected || !activeWs || activeWs.readyState !== WebSocket.OPEN) {
    console.warn('[BackgroundWs] WS 未连接，后台直发失败');
    return { success: false, reason: 'ws_not_connected', usedConversationId: key };
  }

  const primaryResult = await submitReplyViaBackgroundWs(
    key,
    content,
    participants,
    buyerUserId ?? '',
  );
  if (primaryResult.success) return primaryResult;
  if (primaryResult.reason === 'accepted_but_no_echo') {
    console.warn('[BackgroundWs] 后台直发已受理但未回显，停止继续回退:', {
      conversationId: key,
    });
    return { success: true, reason: primaryResult.reason, usedConversationId: primaryResult.usedConversationId ?? key };
  }
  if (primaryResult.reason !== 'conversation not exist') return primaryResult;

  const aliases = conversationAliases.get(key) ?? [];
  for (const aliasConversationId of aliases) {
    const aliasKey = getConversationKey(aliasConversationId);
    if (aliasKey === key) continue;

    console.warn('[BackgroundWs] 当前会话不存在，尝试备用会话 ID:', {
      from: key,
      to: aliasKey,
    });

    const retryResult = await submitReplyViaBackgroundWs(
      aliasKey,
      content,
      participants,
      buyerUserId ?? '',
    );
    if (retryResult.success) return retryResult;
    if (retryResult.reason === 'accepted_but_no_echo') {
      console.warn('[BackgroundWs] 备用会话已受理但未回显，停止继续回退:', {
        conversationId: aliasKey,
      });
      return { success: true, reason: retryResult.reason, usedConversationId: retryResult.usedConversationId ?? aliasKey };
    }
  }

  return { success: false, reason: 'conversation not exist', usedConversationId: key };
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === bridgeTabId) {
    bridgeTabId = null;
  }
});
