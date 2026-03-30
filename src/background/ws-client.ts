import { decodeSyncData } from '../content/msgpack';
import type { BuyerMessage } from '../shared/types';
import { findAnyGoofishTab } from './im-tab-manager';

const WS_URL = 'wss://wss-goofish.dingtalk.com/';
const BRIDGE_URL = 'https://www.goofish.com/';
const ACCESS_TOKEN_APP_KEY = '444e9908a51d1cb236a27862abc769c9';
const MTOP_APP_KEY = '34839810';
const DINGTALK_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36 DingTalk(2.1.5) OS(Windows/10) Browser(Chrome/133.0.0.0) DingWeb/2.1.5 IMPaaS DingWeb/2.1.5';
const HEARTBEAT_INTERVAL = 15_000;
const BRIDGE_WAIT_TIMEOUT = 15_000;
const CONNECT_TIMEOUT = 15_000;
const SEND_TIMEOUT = 10_000;
const MTOP_FETCH_TIMEOUT = 12_000;

type JsonRecord = Record<string, unknown>;
type BackgroundWsMessageHandler = (msg: BuyerMessage) => void | Promise<void>;
type PendingSendResult = { success: boolean; reason?: string; usedConversationId?: string };
type SystemRequestType = 'register' | 'ackDiff' | 'heartbeat';

const WS_CONSECUTIVE_FAIL_LIMIT = 3;

let bridgeTabId: number | null = null;
let activeWs: WebSocket | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let wsReadyPromise: Promise<boolean> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let backgroundWsDesired = false;
let currentDeviceId = '';
let currentAccessToken = '';
let currentUserId = '';
let backgroundWsMessageHandler: BackgroundWsMessageHandler | null = null;
let consecutiveWsConnectFailures = 0;
let onWsAuthFailure: (() => void) | null = null;

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

function md5(str: string): string {
  function safeAdd(x: number, y: number) {
    const l = (x & 0xffff) + (y & 0xffff);
    return (((x >> 16) + (y >> 16) + (l >> 16)) << 16) | (l & 0xffff);
  }
  function rol(n: number, c: number) { return (n << c) | (n >>> (32 - c)); }
  function cmn(q: number, a: number, b: number, x: number, s: number, t: number) {
    return safeAdd(rol(safeAdd(safeAdd(a, q), safeAdd(x, t)), s), b);
  }
  function ff(a: number, b: number, c: number, d: number, x: number, s: number, t: number) { return cmn((b & c) | ((~b) & d), a, b, x, s, t); }
  function gg(a: number, b: number, c: number, d: number, x: number, s: number, t: number) { return cmn((b & d) | (c & (~d)), a, b, x, s, t); }
  function hh(a: number, b: number, c: number, d: number, x: number, s: number, t: number) { return cmn(b ^ c ^ d, a, b, x, s, t); }
  function ii(a: number, b: number, c: number, d: number, x: number, s: number, t: number) { return cmn(c ^ (b | (~d)), a, b, x, s, t); }

  const bytes: number[] = [];
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
  }
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  bytes.push(bitLength & 0xff, (bitLength >> 8) & 0xff, (bitLength >> 16) & 0xff, (bitLength >>> 24) & 0xff, 0, 0, 0, 0);

  let a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
  for (let off = 0; off < bytes.length; off += 64) {
    const m: number[] = [];
    for (let j = 0; j < 16; j++) m[j] = bytes[off + j * 4] | (bytes[off + j * 4 + 1] << 8) | (bytes[off + j * 4 + 2] << 16) | (bytes[off + j * 4 + 3] << 24);
    const oa = a, ob = b, oc = c, od = d;
    a = ff(a, b, c, d, m[0], 7, -680876936); d = ff(d, a, b, c, m[1], 12, -389564586); c = ff(c, d, a, b, m[2], 17, 606105819); b = ff(b, c, d, a, m[3], 22, -1044525330);
    a = ff(a, b, c, d, m[4], 7, -176418897); d = ff(d, a, b, c, m[5], 12, 1200080426); c = ff(c, d, a, b, m[6], 17, -1473231341); b = ff(b, c, d, a, m[7], 22, -45705983);
    a = ff(a, b, c, d, m[8], 7, 1770035416); d = ff(d, a, b, c, m[9], 12, -1958414417); c = ff(c, d, a, b, m[10], 17, -42063); b = ff(b, c, d, a, m[11], 22, -1990404162);
    a = ff(a, b, c, d, m[12], 7, 1804603682); d = ff(d, a, b, c, m[13], 12, -40341101); c = ff(c, d, a, b, m[14], 17, -1502002290); b = ff(b, c, d, a, m[15], 22, 1236535329);
    a = gg(a, b, c, d, m[1], 5, -165796510); d = gg(d, a, b, c, m[6], 9, -1069501632); c = gg(c, d, a, b, m[11], 14, 643717713); b = gg(b, c, d, a, m[0], 20, -373897302);
    a = gg(a, b, c, d, m[5], 5, -701558691); d = gg(d, a, b, c, m[10], 9, 38016083); c = gg(c, d, a, b, m[15], 14, -660478335); b = gg(b, c, d, a, m[4], 20, -405537848);
    a = gg(a, b, c, d, m[9], 5, 568446438); d = gg(d, a, b, c, m[14], 9, -1019803690); c = gg(c, d, a, b, m[3], 14, -187363961); b = gg(b, c, d, a, m[8], 20, 1163531501);
    a = gg(a, b, c, d, m[13], 5, -1444681467); d = gg(d, a, b, c, m[2], 9, -51403784); c = gg(c, d, a, b, m[7], 14, 1735328473); b = gg(b, c, d, a, m[12], 20, -1926607734);
    a = hh(a, b, c, d, m[5], 4, -378558); d = hh(d, a, b, c, m[8], 11, -2022574463); c = hh(c, d, a, b, m[11], 16, 1839030562); b = hh(b, c, d, a, m[14], 23, -35309556);
    a = hh(a, b, c, d, m[1], 4, -1530992060); d = hh(d, a, b, c, m[4], 11, 1272893353); c = hh(c, d, a, b, m[7], 16, -155497632); b = hh(b, c, d, a, m[10], 23, -1094730640);
    a = hh(a, b, c, d, m[13], 4, 681279174); d = hh(d, a, b, c, m[0], 11, -358537222); c = hh(c, d, a, b, m[3], 16, -722521979); b = hh(b, c, d, a, m[6], 23, 76029189);
    a = hh(a, b, c, d, m[9], 4, -640364487); d = hh(d, a, b, c, m[12], 11, -421815835); c = hh(c, d, a, b, m[15], 16, 530742520); b = hh(b, c, d, a, m[2], 23, -995338651);
    a = ii(a, b, c, d, m[0], 6, -198630844); d = ii(d, a, b, c, m[7], 10, 1126891415); c = ii(c, d, a, b, m[14], 15, -1416354905); b = ii(b, c, d, a, m[5], 21, -57434055);
    a = ii(a, b, c, d, m[12], 6, 1700485571); d = ii(d, a, b, c, m[3], 10, -1894986606); c = ii(c, d, a, b, m[10], 15, -1051523); b = ii(b, c, d, a, m[1], 21, -2054922799);
    a = ii(a, b, c, d, m[8], 6, 1873313359); d = ii(d, a, b, c, m[15], 10, -30611744); c = ii(c, d, a, b, m[6], 15, -1560198380); b = ii(b, c, d, a, m[13], 21, 1309151649);
    a = ii(a, b, c, d, m[4], 6, -145523070); d = ii(d, a, b, c, m[11], 10, -1120210379); c = ii(c, d, a, b, m[2], 15, 718787259); b = ii(b, c, d, a, m[9], 21, -343485551);
    a = safeAdd(a, oa); b = safeAdd(b, ob); c = safeAdd(c, oc); d = safeAdd(d, od);
  }
  const hex = (n: number) => { let s = ''; for (let i = 0; i < 4; i++) s += ((n >>> (i * 8)) & 0xff).toString(16).padStart(2, '0'); return s; };
  return hex(a) + hex(b) + hex(c) + hex(d);
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
  if (!backgroundWsDesired) return;
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!backgroundWsDesired) return;
    void ensureBackgroundWs();
  }, 5_000);
}

function clearReconnectTimer(): void {
  if (!reconnectTimer) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

function resetBackgroundWsState(): void {
  stopHeartbeat();
  clearReconnectTimer();
  pendingSystemRequests.clear();
  currentAccessToken = '';
  for (const [mid] of pendingSendRequests) {
    settlePendingSend(mid, false, 'WebSocket closed');
  }
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

async function isMtopBridgeReady(tabId: number): Promise<boolean> {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'MTOP_BRIDGE_STATUS' }) as
      { ready?: boolean } | undefined;
    return response?.ready === true;
  } catch (err) {
    console.warn('[BackgroundWs] 检查 mtop bridge 状态失败:', tabId, err);
    return false;
  }
}

export async function ensureBridgeTab(): Promise<number | null> {
  if (bridgeTabId) {
    try {
      const tab = await chrome.tabs.get(bridgeTabId);
      if (tab.id && tab.status === 'complete') {
        const ready = await ensureContentScript(tab.id);
        if (ready && await isMtopBridgeReady(tab.id)) return tab.id;
      }
    } catch {
      bridgeTabId = null;
    }
    bridgeTabId = null;
  }

  const existing = await findAnyGoofishTab();
  if (existing) {
    if (await isMtopBridgeReady(existing)) {
      bridgeTabId = existing;
      return existing;
    }
    console.warn('[BackgroundWs] 发现已有闲鱼标签页，但 mtop bridge 不可用，改为创建专用桥接页:', existing);
  }

  console.info('[BackgroundWs] 当前没有可复用的闲鱼标签页，跳过创建桥接页');
  return null;

  /* try {
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

    // 等待 content-injected.js (mtop-bridge) 在 MAIN 世界加载完成
    await new Promise((r) => setTimeout(r, 2000));

    const bridgeReady = await isMtopBridgeReady(tab.id);
    if (!bridgeReady) {
      console.error('[BackgroundWs] 新建桥接页后 mtop bridge 仍未就绪:', tab.id);
      return null;
    }

    bridgeTabId = tab.id;
    return tab.id;
  } catch (err) {
    console.error('[BackgroundWs] 创建桥接页失败:', err);
    return null;
  } */
}

async function getCurrentUserId(): Promise<string> {
  const cookie = await chrome.cookies.get({ url: 'https://www.goofish.com', name: 'unb' });
  currentUserId = cookie?.value ?? '';
  return currentUserId;
}

async function getMtopToken(): Promise<string> {
  const cookie = await chrome.cookies.get({ url: 'https://www.goofish.com', name: '_m_h5_tk' });
  const token = String(cookie?.value ?? '').split('_')[0];
  return token;
}

function getMtopReferrer(api: string): string {
  return api.includes('idlemessage.') ? 'https://www.goofish.com/im' : 'https://www.goofish.com/';
}

export async function callBackgroundMtopApi(
  api: string,
  version: string,
  data: Record<string, unknown>,
): Promise<JsonRecord | null> {
  const token = await getMtopToken();
  if (!token) {
    console.warn('[BackgroundWs] 缺少 _m_h5_tk，无法直接发起 mtop 请求:', api);
    return null;
  }

  const timestamp = String(Date.now());
  const dataStr = JSON.stringify(data);
  const sign = md5(`${token}&${timestamp}&${MTOP_APP_KEY}&${dataStr}`);
  const params = new URLSearchParams({
    jsv: '2.7.2',
    appKey: MTOP_APP_KEY,
    t: timestamp,
    sign,
    v: version,
    type: 'originaljson',
    accountSite: 'xianyu',
    dataType: 'json',
    timeout: '20000',
    api,
    valueType: 'string',
    sessionOption: 'AutoLoginOnly',
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MTOP_FETCH_TIMEOUT);
  const url = `https://h5api.m.goofish.com/h5/${api}/${version}/?${params.toString()}`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      credentials: 'include',
      body: new URLSearchParams({ data: dataStr }).toString(),
      referrer: getMtopReferrer(api),
      referrerPolicy: 'strict-origin-when-cross-origin',
      signal: controller.signal,
    });
    const text = await response.text();
    return JSON.parse(text) as JsonRecord;
  } catch (err) {
    console.error('[BackgroundWs] 后台 mtop 请求异常:', api, err);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function probeBackgroundLoginState(): Promise<{ loggedIn: boolean; reason: string }> {
  const uid = await getCurrentUserId();
  const mtopToken = await getMtopToken();
  if (!uid || !mtopToken) {
    return { loggedIn: false, reason: 'no_cookies' };
  }

  if (isBackgroundWsConnected()) {
    return { loggedIn: true, reason: 'ws_connected' };
  }

  const deviceId = generateDeviceId(uid);
  const response = await callBackgroundMtopApi('mtop.taobao.idlemessage.pc.login.token', '1.0', {
    appKey: ACCESS_TOKEN_APP_KEY,
    deviceId,
  });

  if (!response) {
    return { loggedIn: false, reason: 'token_request_failed' };
  }
  if (isMtopTokenError(response)) {
    return { loggedIn: false, reason: 'token_invalid' };
  }

  const accessToken = (response['data'] as JsonRecord | undefined)?.['accessToken'];
  if (typeof accessToken !== 'string' || !accessToken) {
    return { loggedIn: false, reason: 'token_missing' };
  }

  currentDeviceId = deviceId;
  currentAccessToken = accessToken;
  return { loggedIn: true, reason: 'token_ok' };
}

/** MTOP ret 中表示 token/session 失效的关键词 */
const MTOP_TOKEN_ERROR_PATTERNS = [
  'FAIL_SYS_TOKEN_EXOIRED',  // 阿里拼写就是 EXOIRED
  'FAIL_SYS_TOKEN_EXPIRED',
  'FAIL_SYS_SESSION_EXPIRED',
  'FAIL_SYS_ILLEGAL_ACCESS',
  'FAIL_SYS_USER_VALIDATE',
  'FAIL_BIZ_TOKEN_EXPIRE',
  'FAIL_SYS_TOKEN_EMPTY',
  'FAIL_SYS_NOT_LOGIN',
];

function isMtopTokenError(data: JsonRecord | null | undefined): boolean {
  if (!data) return false;
  const ret = data['ret'] as string[] | string | undefined;
  if (!ret) return false;
  const retArr = Array.isArray(ret) ? ret : [String(ret)];
  return retArr.some((r) =>
    MTOP_TOKEN_ERROR_PATTERNS.some((p) => String(r).toUpperCase().includes(p)),
  );
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

    // 检查 MTOP ret 是否为 token/session 错误（明确的登录失效信号）
    if (isMtopTokenError(resp?.data)) {
      console.warn('[BackgroundWs] MTOP 返回 token/session 错误:', resp?.data?.['ret']);
      return null;
    }

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

async function requestAccessTokenDirect(): Promise<string | null> {
  const uid = await getCurrentUserId();
  if (!uid) return null;

  currentDeviceId = generateDeviceId(uid);

  try {
    const resp = await callBackgroundMtopApi('mtop.taobao.idlemessage.pc.login.token', '1.0', {
      appKey: ACCESS_TOKEN_APP_KEY,
      deviceId: currentDeviceId,
    });

    if (isMtopTokenError(resp)) {
      console.warn('[BackgroundWs] MTOP 返回 token/session 错误:', resp?.['ret']);
      return null;
    }

    const token = (resp?.['data'] as JsonRecord | undefined)?.['accessToken'];
    if (typeof token !== 'string' || !token) {
      console.warn('[BackgroundWs] accessToken 获取失败:', resp);
      return null;
    }

    currentAccessToken = token;
    return token;
  } catch (err) {
    console.error('[BackgroundWs] 后台 accessToken 请求异常:', err);
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
  const accessToken = currentAccessToken || await requestAccessTokenDirect();
  if (!accessToken) {
    consecutiveWsConnectFailures++;
    console.warn(
      `[BackgroundWs] accessToken 获取失败 (连续 ${consecutiveWsConnectFailures}/${WS_CONSECUTIVE_FAIL_LIMIT})`,
    );
    if (consecutiveWsConnectFailures >= WS_CONSECUTIVE_FAIL_LIMIT && onWsAuthFailure) {
      console.error('[BackgroundWs] 连续多次无法获取 accessToken，触发登录失效回调');
      onWsAuthFailure();
    }
    return false;
  }

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
                consecutiveWsConnectFailures = 0; // 连接成功，重置失败计数
                startHeartbeat(ws);
                setTimeout(() => sendAckDiff(ws), 1_000);
                console.info('[BackgroundWs] 注册成功，开始接收实时消息');
                if (!settled) {
                  settled = true;
                  resolve(true);
                }
              } else {
                consecutiveWsConnectFailures++;
                console.warn('[BackgroundWs] 注册失败:', {
                  mid,
                  code: data['code'],
                  body: data['body'],
                  consecutiveFailures: consecutiveWsConnectFailures,
                });
                currentAccessToken = '';
                if (consecutiveWsConnectFailures >= WS_CONSECUTIVE_FAIL_LIMIT && onWsAuthFailure) {
                  console.error('[BackgroundWs] 连续多次注册失败，触发登录失效回调');
                  onWsAuthFailure();
                }
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
  backgroundWsDesired = true;
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

/**
 * 注册 WS 认证失败回调：连续多次无法获取 accessToken 或注册失败时触发
 */
export function setWsAuthFailureCallback(cb: (() => void) | null): void {
  onWsAuthFailure = cb;
}

export function stopBackgroundWs(reason = 'stopped'): void {
  backgroundWsDesired = false;
  consecutiveWsConnectFailures = 0;
  resetBackgroundWsState();

  const ws = activeWs;
  activeWs = null;
  if (ws) {
    try {
      ws.close();
    } catch {
      console.warn('[BackgroundWs] 关闭连接失败:', reason);
    }
  }
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
