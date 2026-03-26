/**
 * WebSocket 连接器（运行在页面主上下文）
 *
 * 参考 XianyuAutoAgent：在任意闲鱼页面上主动建立独立 WebSocket 连接，
 * 接收买家消息并通过 WS 发送回复。
 *
 * 流程：
 * 1. 通过 mtop API 获取 accessToken
 * 2. 连接 wss://wss-goofish.dingtalk.com/
 * 3. 发送 /reg 注册消息
 * 4. 维护心跳
 * 5. 接收买家消息 → postMessage 到 Content Script
 * 6. 接收 Content Script 的发送请求 → 通过 WS 发送回复
 */

(function () {
  // 每次加载都关闭旧连接并重新初始化
  // 旧连接可能僵死（有心跳但不推送消息），必须强制重建
  if ((window as any).__xianyuWsConnectorLoaded) {
    const existingGlobal = (window as any).__xianyuWsGlobal;
    console.log('[WS-Connector] 关闭旧连接，重新初始化...');
    if (existingGlobal) {
      if (existingGlobal.heartbeatTimer) clearInterval(existingGlobal.heartbeatTimer);
      if (existingGlobal.staleCheckTimer) clearInterval(existingGlobal.staleCheckTimer);
      if (existingGlobal.periodicReconnectTimer) clearInterval(existingGlobal.periodicReconnectTimer);
      try { existingGlobal.activeWs?.close(); } catch { /* ignore */ }
      existingGlobal.activeWs = null;
      existingGlobal.heartbeatTimer = null;
      existingGlobal.connectorActive = false;
    }
  }
  (window as any).__xianyuWsConnectorLoaded = true;

  const SOURCE = 'xianyu-smart-assistant';
  const WS_URL = 'wss://wss-goofish.dingtalk.com/';

  // 全局 WS 状态
  interface WsGlobal {
    activeWs: WebSocket | null;
    conversationParticipants: Map<string, string[]>;
    heartbeatTimer: ReturnType<typeof setInterval> | null;
    staleCheckTimer: ReturnType<typeof setInterval> | null;
    periodicReconnectTimer: ReturnType<typeof setInterval> | null;
    lastSyncPushTime: number; // 上次收到 sync 推送的时间
    connectorActive: boolean;
  }

  // 通过 window 全局共享
  const g: WsGlobal = ((window as any).__xianyuWsGlobal ??= {
    activeWs: null,
    conversationParticipants: new Map(),
    heartbeatTimer: null,
    staleCheckTimer: null,
    periodicReconnectTimer: null,
    lastSyncPushTime: 0,
    connectorActive: false,
  });

  const HEARTBEAT_INTERVAL = 15_000;
  const TOKEN_REFRESH_INTERVAL = 3600_000; // 1 小时
  const RECONNECT_DELAY = 5_000;
  const CONNECT_CHECK_DELAY = 3_000;
  const STALE_CHECK_INTERVAL = 60_000; // 每分钟检查一次
  const STALE_THRESHOLD = 5 * 60_000; // 5 分钟无 sync 推送视为僵死
  const PERIODIC_RECONNECT_INTERVAL = 30 * 60_000; // 每 30 分钟强制重连

  let tokenRefreshTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const pendingSendRequests = new Map<
    string,
    {
      requestId: string;
      timer: ReturnType<typeof setTimeout>;
      cid: string;
      text: string;
      accepted: boolean;
    }
  >();

  // ── MD5（与 mtop-bridge.ts 相同的实现）────────────────────────────
  function md5(str: string): string {
    function safeAdd(x: number, y: number) {
      const l = (x & 0xffff) + (y & 0xffff);
      return (((x >> 16) + (y >> 16) + (l >> 16)) << 16) | (l & 0xffff);
    }
    function rol(n: number, c: number) { return (n << c) | (n >>> (32 - c)); }
    function cmn(q: number, a: number, b: number, x: number, s: number, t: number) {
      return safeAdd(rol(safeAdd(safeAdd(a, q), safeAdd(x, t)), s), b);
    }
    function ff(a:number,b:number,c:number,d:number,x:number,s:number,t:number){return cmn((b&c)|((~b)&d),a,b,x,s,t);}
    function gg(a:number,b:number,c:number,d:number,x:number,s:number,t:number){return cmn((b&d)|(c&(~d)),a,b,x,s,t);}
    function hh(a:number,b:number,c:number,d:number,x:number,s:number,t:number){return cmn(b^c^d,a,b,x,s,t);}
    function ii(a:number,b:number,c:number,d:number,x:number,s:number,t:number){return cmn(c^(b|(~d)),a,b,x,s,t);}
    const bytes:number[]=[];
    for(let i=0;i<str.length;i++){const c=str.charCodeAt(i);if(c<0x80)bytes.push(c);else if(c<0x800)bytes.push(0xc0|(c>>6),0x80|(c&0x3f));else bytes.push(0xe0|(c>>12),0x80|((c>>6)&0x3f),0x80|(c&0x3f));}
    const bl=bytes.length*8;bytes.push(0x80);while(bytes.length%64!==56)bytes.push(0);bytes.push(bl&0xff,(bl>>8)&0xff,(bl>>16)&0xff,(bl>>>24)&0xff,0,0,0,0);
    let a=1732584193,b=-271733879,c=-1732584194,d=271733878;
    for(let off=0;off<bytes.length;off+=64){
      const m:number[]=[];for(let j=0;j<16;j++)m[j]=bytes[off+j*4]|(bytes[off+j*4+1]<<8)|(bytes[off+j*4+2]<<16)|(bytes[off+j*4+3]<<24);
      const oa=a,ob=b,oc=c,od=d;
      a=ff(a,b,c,d,m[0],7,-680876936);d=ff(d,a,b,c,m[1],12,-389564586);c=ff(c,d,a,b,m[2],17,606105819);b=ff(b,c,d,a,m[3],22,-1044525330);
      a=ff(a,b,c,d,m[4],7,-176418897);d=ff(d,a,b,c,m[5],12,1200080426);c=ff(c,d,a,b,m[6],17,-1473231341);b=ff(b,c,d,a,m[7],22,-45705983);
      a=ff(a,b,c,d,m[8],7,1770035416);d=ff(d,a,b,c,m[9],12,-1958414417);c=ff(c,d,a,b,m[10],17,-42063);b=ff(b,c,d,a,m[11],22,-1990404162);
      a=ff(a,b,c,d,m[12],7,1804603682);d=ff(d,a,b,c,m[13],12,-40341101);c=ff(c,d,a,b,m[14],17,-1502002290);b=ff(b,c,d,a,m[15],22,1236535329);
      a=gg(a,b,c,d,m[1],5,-165796510);d=gg(d,a,b,c,m[6],9,-1069501632);c=gg(c,d,a,b,m[11],14,643717713);b=gg(b,c,d,a,m[0],20,-373897302);
      a=gg(a,b,c,d,m[5],5,-701558691);d=gg(d,a,b,c,m[10],9,38016083);c=gg(c,d,a,b,m[15],14,-660478335);b=gg(b,c,d,a,m[4],20,-405537848);
      a=gg(a,b,c,d,m[9],5,568446438);d=gg(d,a,b,c,m[14],9,-1019803690);c=gg(c,d,a,b,m[3],14,-187363961);b=gg(b,c,d,a,m[8],20,1163531501);
      a=gg(a,b,c,d,m[13],5,-1444681467);d=gg(d,a,b,c,m[2],9,-51403784);c=gg(c,d,a,b,m[7],14,1735328473);b=gg(b,c,d,a,m[12],20,-1926607734);
      a=hh(a,b,c,d,m[5],4,-378558);d=hh(d,a,b,c,m[8],11,-2022574463);c=hh(c,d,a,b,m[11],16,1839030562);b=hh(b,c,d,a,m[14],23,-35309556);
      a=hh(a,b,c,d,m[1],4,-1530992060);d=hh(d,a,b,c,m[4],11,1272893353);c=hh(c,d,a,b,m[7],16,-155497632);b=hh(b,c,d,a,m[10],23,-1094730640);
      a=hh(a,b,c,d,m[13],4,681279174);d=hh(d,a,b,c,m[0],11,-358537222);c=hh(c,d,a,b,m[3],16,-722521979);b=hh(b,c,d,a,m[6],23,76029189);
      a=hh(a,b,c,d,m[9],4,-640364487);d=hh(d,a,b,c,m[12],11,-421815835);c=hh(c,d,a,b,m[15],16,530742520);b=hh(b,c,d,a,m[2],23,-995338651);
      a=ii(a,b,c,d,m[0],6,-198630844);d=ii(d,a,b,c,m[7],10,1126891415);c=ii(c,d,a,b,m[14],15,-1416354905);b=ii(b,c,d,a,m[5],21,-57434055);
      a=ii(a,b,c,d,m[12],6,1700485571);d=ii(d,a,b,c,m[3],10,-1894986606);c=ii(c,d,a,b,m[10],15,-1051523);b=ii(b,c,d,a,m[1],21,-2054922799);
      a=ii(a,b,c,d,m[8],6,1873313359);d=ii(d,a,b,c,m[15],10,-30611744);c=ii(c,d,a,b,m[6],15,-1560198380);b=ii(b,c,d,a,m[13],21,1309151649);
      a=ii(a,b,c,d,m[4],6,-145523070);d=ii(d,a,b,c,m[11],10,-1120210379);c=ii(c,d,a,b,m[2],15,718787259);b=ii(b,c,d,a,m[9],21,-343485551);
      a=safeAdd(a,oa);b=safeAdd(b,ob);c=safeAdd(c,oc);d=safeAdd(d,od);
    }
    const hex=(n:number)=>{let s='';for(let i=0;i<4;i++)s+=((n>>>(i*8))&0xff).toString(16).padStart(2,'0');return s;};
    return hex(a)+hex(b)+hex(c)+hex(d);
  }

  // ── 工具函数 ──────────────────────────────────────────────────────

  function getCurrentUserId(): string {
    const match = document.cookie.match(/(?:^|;\s*)unb=([^;]+)/);
    if (!match) return '';
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }

  function generateDeviceId(uid: string): string {
    // 与 XianyuAutoAgent generate_device_id 完全一致的 UUID v4 + uid 格式
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

  // DingTalk UA（与 XianyuAutoAgent 一致，服务器可能验证此字段）
  const DINGTALK_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36 DingTalk(2.1.5) OS(Windows/10) Browser(Chrome/133.0.0.0) DingWeb/2.1.5 IMPaaS DingWeb/2.1.5';

  function generateMid(): string {
    return `${Math.floor(Math.random() * 999)}${Date.now()} 0`;
  }

  // ── mtop API 调用（直接在页面上下文，带 credentials）────────────────

  async function callMtopApi(
    api: string,
    version: string,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    const tkCookie = document.cookie.split(';').map(c => c.trim()).find(c => c.startsWith('_m_h5_tk='));
    const tkRaw = tkCookie ? tkCookie.split('=')[1] : '';
    const token = tkRaw.split('_')[0];
    if (!token) {
      console.log('[WS-Connector] _m_h5_tk cookie 不存在');
      return null;
    }

    const timestamp = String(Date.now());
    const appKey = '34839810';
    const dataStr = JSON.stringify(data);
    const sign = md5(`${token}&${timestamp}&${appKey}&${dataStr}`);

    const params = new URLSearchParams({
      jsv: '2.7.2', appKey, t: timestamp, sign, v: version,
      type: 'originaljson', accountSite: 'xianyu', dataType: 'json',
      timeout: '20000', api, valueType: 'string', sessionOption: 'AutoLoginOnly',
    });

    const url = `https://h5api.m.goofish.com/h5/${api}/${version}/?${params.toString()}`;
    const isIdleMessageApi = api.includes('idlemessage.');
    const referrer = isIdleMessageApi ? `${location.origin}/im` : location.href;

    // 添加超时（10 秒），防止 fetch 挂起导致整个连接流程卡死
    const controller = new AbortController();
    const fetchTimeout = setTimeout(() => controller.abort(), 10_000);

    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        credentials: 'include',
        body: new URLSearchParams({ data: dataStr }).toString(),
        referrer,
        referrerPolicy: 'strict-origin-when-cross-origin',
        signal: controller.signal,
      });
      clearTimeout(fetchTimeout);

      const text = await resp.text();
      console.log('[WS-Connector] mtop 响应:', api, text.slice(0, 150));
      return JSON.parse(text) as Record<string, unknown>;
    } catch (fetchErr) {
      clearTimeout(fetchTimeout);
      console.error('[WS-Connector] mtop fetch 失败:', api, fetchErr);
      return null;
    }
  }

  // ── 通过 content script 桥接发起 mtop 请求（备用路径）────────────
  // 当直接 fetch 不可用时（CORS/网络问题），走 mtop-bridge.ts 的已验证通道

  function callMtopViaBridge(
    api: string,
    version: string,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    return new Promise((resolve) => {
      const requestId = `wsc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const timeout = setTimeout(() => {
        window.removeEventListener('message', handler);
        console.log('[WS-Connector] mtop 桥接请求超时:', api);
        resolve(null);
      }, 10_000);

      function handler(event: MessageEvent) {
        if (event.source !== window) return;
        if (event.data?.source !== SOURCE) return;
        if (event.data?.type !== 'MTOP_RESPONSE') return;
        if (event.data?.payload?.requestId !== requestId) return;

        clearTimeout(timeout);
        window.removeEventListener('message', handler);

        const payload = event.data.payload;
        if (payload.success) {
          resolve(payload.data ?? null);
        } else {
          console.log('[WS-Connector] mtop 桥接返回失败:', payload.error);
          resolve(null);
        }
      }

      window.addEventListener('message', handler);
      window.postMessage({
        source: SOURCE,
        type: 'MTOP_REQUEST',
        payload: { requestId, api, version, data },
      }, '*');
    });
  }

  // ── 获取 accessToken ──────────────────────────────────────────────
  // 返回 token 和对应的 deviceId（两者必须配对使用，服务器会校验）

  async function getAccessToken(deviceId: string): Promise<string | null> {
    try {
      const requestData = { appKey: '444e9908a51d1cb236a27862abc769c9', deviceId };

      // 尝试直接 fetch（快速路径）
      console.log('[WS-Connector] 尝试直接 fetch 获取 accessToken, did:', deviceId);
      let result = await callMtopApi(
        'mtop.taobao.idlemessage.pc.login.token',
        '1.0',
        requestData,
      );

      // 直接 fetch 失败时，走 mtop-bridge 桥接（备用路径）
      if (!result) {
        console.log('[WS-Connector] 直接 fetch 失败，尝试 mtop-bridge 桥接...');
        result = await callMtopViaBridge(
          'mtop.taobao.idlemessage.pc.login.token',
          '1.0',
          requestData,
        );
      }

      if (!result) return null;

      const ret = result['ret'] as string[] | undefined;
      const data = result['data'] as Record<string, unknown> | undefined;
      const accessToken = data?.['accessToken'] as string | undefined;

      if (!accessToken) {
        console.log('[WS-Connector] 获取 accessToken 失败:', ret);
        return null;
      }

      console.log('[WS-Connector] 获取 accessToken 成功');
      return accessToken;
    } catch (err) {
      console.error('[WS-Connector] getAccessToken 异常:', err);
      return null;
    }
  }

  // ── 心跳 ──────────────────────────────────────────────────────────

  function startHeartbeat(ws: WebSocket): void {
    stopHeartbeat();
    g.heartbeatTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) { stopHeartbeat(); return; }
      ws.send(JSON.stringify({ lwp: '/!', headers: { mid: `hb-${Date.now()}` } }));
    }, HEARTBEAT_INTERVAL);
  }

  function stopHeartbeat(): void {
    if (g.heartbeatTimer) { clearInterval(g.heartbeatTimer); g.heartbeatTimer = null; }
  }

  // ── ACK ───────────────────────────────────────────────────────────

  function sendAckDiff(ws: WebSocket): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    const nowMs = Date.now();
    ws.send(JSON.stringify({
      lwp: '/r/SyncStatus/ackDiff',
      headers: { mid: generateMid() },
      body: [{
        pipeline: 'sync', tooLong2Tag: 'PNM,1', channel: 'sync', topic: 'sync',
        highPts: 0, pts: nowMs * 1000, seq: 0, timestamp: nowMs,
      }],
    }));
  }

  // ── 消息解析和分发 ──────────────────────────────────────────────

  const processedMsgIds = new Set<string>();
  const LOAD_TIME = Date.now();

  function dispatchBuyerMessage(payload: Record<string, unknown>): void {
    window.postMessage({ source: SOURCE, type: 'BUYER_MESSAGE', payload }, '*');
  }

  function readTextCandidate(value: unknown): string {
    if (typeof value === 'string') return value.trim();
    if (!value || typeof value !== 'object') return '';

    const record = value as Record<string, unknown>;
    const nestedKeys = ['text', 'content', 'summary', 'title'];
    for (const key of nestedKeys) {
      const nested = record[key];
      if (typeof nested === 'string' && nested.trim()) {
        return nested.trim();
      }
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
      const decoded = JSON.parse(atob(value)) as Record<string, unknown>;
      return readTextCandidate(decoded);
    } catch {
      return '';
    }
  }

  function normalizeComparableText(value: string): string {
    return value.trim().replace(/\s+/g, ' ');
  }

  function settlePendingSend(mid: string, success: boolean, error?: string): void {
    const pending = pendingSendRequests.get(mid);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingSendRequests.delete(mid);
    window.postMessage({
      source: SOURCE,
      type: 'SEND_WS_RESPONSE',
      payload: { requestId: pending.requestId, success, error },
    }, '*');
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
    const currentUid = stripGoofishSuffix(getCurrentUserId());
    if (!currentUid || stripGoofishSuffix(senderUserId) !== currentUid) return;

    const cidFull = conversationId.includes('@') ? conversationId : `${conversationId}@goofish`;
    const normalizedContent = normalizeComparableText(content);
    if (!cidFull || !normalizedContent) return;

    for (const [mid, pending] of pendingSendRequests) {
      if (pending.cid !== cidFull) continue;
      if (!pending.accepted) continue;

      const pendingText = normalizeComparableText(pending.text);
      if (
        pendingText === normalizedContent ||
        pendingText.includes(normalizedContent) ||
        normalizedContent.includes(pendingText)
      ) {
        console.log('[WS-Connector] 发送消息已在会话流中回显:', { cidFull, mid });
        settlePendingSend(mid, true);
        return;
      }
    }
  }

  function extractJsonMessageText(content: Record<string, unknown>): string {
    const custom = content['custom'] as Record<string, unknown> | undefined;
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
      (content['text'] as Record<string, unknown> | undefined)?.['data'],
    ];

    for (const candidate of embeddedCandidates) {
      const text = decodeEmbeddedMessageText(candidate);
      if (text) return text;
    }

    return '';
  }

  function normalizeGoofishId(value: unknown): string {
    return String(value ?? '').trim();
  }

  function stripGoofishSuffix(value: string): string {
    return value.replace(/@goofish$/, '');
  }

  function isLikelyUserId(value: string): boolean {
    const normalized = stripGoofishSuffix(value);
    return /^\d+$/.test(normalized);
  }

  function isLikelyConversationId(value: string): boolean {
    const normalized = stripGoofishSuffix(value);
    if (!normalized) return false;
    if (isLikelyUserId(normalized)) return false;
    return /[A-Za-z._:-]/.test(normalized);
  }

  function ensureGoofishUserId(value: string): string {
    const normalized = stripGoofishSuffix(value);
    if (!normalized) return '';
    return `${normalized}@goofish`;
  }

  function getPeerUserIdFromReminderUrl(reminderUrl: string): string {
    if (!reminderUrl) return '';
    const match = reminderUrl.match(/[?&]peerUserId=(\d+)/);
    return match?.[1] ?? '';
  }

  function resolveMsgPackConversationId(
    msgObj: Record<string, unknown>,
    senderUserId: string,
    currentUid: string,
  ): string {
    const rawCandidates = [
      normalizeGoofishId(msgObj['3']),
      normalizeGoofishId(msgObj['2']),
      normalizeGoofishId(msgObj['1']),
    ].filter(Boolean);

    const userIds = new Set(
      [senderUserId, currentUid]
        .map((value) => stripGoofishSuffix(normalizeGoofishId(value)))
        .filter(Boolean),
    );

    for (const candidate of rawCandidates) {
      const normalized = stripGoofishSuffix(candidate);
      if (!normalized) continue;
      if (userIds.has(normalized)) continue;
      if (isLikelyConversationId(normalized)) return normalized;
    }

    for (const candidate of rawCandidates) {
      const normalized = stripGoofishSuffix(candidate);
      if (!normalized) continue;
      if (userIds.has(normalized)) continue;
      return normalized;
    }

    return stripGoofishSuffix(rawCandidates[0] ?? '');
  }

  function buildConversationParticipants(
    senderUserId: string,
    currentUid: string,
    reminderUrl: string,
    msgObj?: Record<string, unknown>,
  ): string[] {
    const currentUserId = ensureGoofishUserId(currentUid);
    const peerCandidates = [
      senderUserId,
      getPeerUserIdFromReminderUrl(reminderUrl),
      normalizeGoofishId(msgObj?.['1']),
      normalizeGoofishId(msgObj?.['2']),
    ];

    let peerUserId = '';
    for (const candidate of peerCandidates) {
      const userId = ensureGoofishUserId(candidate);
      if (!userId || !isLikelyUserId(userId)) continue;
      if (currentUserId && userId === currentUserId) continue;
      peerUserId = userId;
      break;
    }

    if (peerUserId && currentUserId) {
      return [peerUserId, currentUserId];
    }
    if (peerUserId) return [peerUserId];
    if (currentUserId) return [currentUserId];
    return [];
  }

  function parseAndDispatchWsMessage(data: Record<string, unknown>, ws: WebSocket): void {
    const body = data['body'] as Record<string, unknown> | undefined;
    if (!body) return;

    // 路径 1: userMessageModels
    if (Array.isArray(body['userMessageModels'])) {
      for (const model of body['userMessageModels'] as Record<string, unknown>[]) {
        const msg = parseUserMessageModel(model);
        if (msg) dispatchBuyerMessage(msg);
      }
    }

    // 路径 2: syncPushPackage（MessagePack 编码）
    const syncPkg = body['syncPushPackage'] as Record<string, unknown> | undefined;
    if (syncPkg) {
      // 更新最近一次 sync 推送时间（用于僵死检测）
      g.lastSyncPushTime = Date.now();

      console.log('[WS-Connector] syncPushPackage 结构:', {
        keys: Object.keys(syncPkg),
        dataIsArray: Array.isArray(syncPkg['data']),
        dataLength: Array.isArray(syncPkg['data']) ? (syncPkg['data'] as unknown[]).length : 'N/A',
        dataType: typeof syncPkg['data'],
        decodeFnExists: !!(window as any).__xianyuDecodeSyncData,
      });

      let hasDispatchedMsg = false;
      if (Array.isArray(syncPkg['data'])) {
        for (let idx = 0; idx < (syncPkg['data'] as unknown[]).length; idx++) {
          const item = (syncPkg['data'] as Record<string, unknown>[])[idx];
          console.log(`[WS-Connector] syncPkg.data[${idx}]:`, {
            itemKeys: item ? Object.keys(item) : 'null',
            hasData: !!(item?.['data']),
            dataType: typeof item?.['data'],
            dataPreview: typeof item?.['data'] === 'string' ? (item['data'] as string).slice(0, 80) + '...' : 'N/A',
            bizType: item?.['bizType'],
          });

          const b64 = item?.['data'] as string | undefined;
          if (!b64) { console.log(`[WS-Connector] data[${idx}] 无 data 字段，跳过`); continue; }

          // 使用共享的 decodeSyncData（MessagePack 解码）
          const decoded = (window as any).__xianyuDecodeSyncData?.(b64);
          if (!decoded) {
            console.log(`[WS-Connector] data[${idx}] decodeSyncData 返回 null（JSON系统消息或解码失败）`);
            continue;
          }

          console.log('[WS-Connector] MessagePack 解码成功，keys:', Object.keys(decoded),
            JSON.stringify(decoded).slice(0, 500));
          const msg = parseSyncPushItem(decoded);
          if (msg) {
            console.log('[WS-Connector] ✅ 解析到买家消息:', msg);
            dispatchBuyerMessage(msg);
            hasDispatchedMsg = true;
          } else {
            console.log('[WS-Connector] parseSyncPushItem 返回 null（被过滤）');
          }
        }
      }
      // 只在解析到有效买家消息时才发 ackDiff
      // 不对 typing/presence 通知（/s/para, bizType:40 无内容）发 ackDiff
      // 否则会告诉服务器"已收到当前时刻所有消息"，导致真正的消息推送被吞
      if (hasDispatchedMsg) {
        sendAckDiff(ws);
      }
    }
  }

  function parseUserMessageModel(model: Record<string, unknown>): Record<string, unknown> | null {
    const userExt = model['userExtension'] as Record<string, unknown> | undefined;
    const message = model['message'] as Record<string, unknown> | undefined;
    if (!message) return null;

    const ext = message['extension'] as Record<string, unknown> | undefined;
    if (!ext) return null;

    const msgId = String(message['messageId'] ?? '');
    const content = String(ext['reminderContent'] ?? '');
    const buyerName = String(ext['reminderTitle'] ?? '买家');
    const createAt = Number(message['createAt'] ?? 0);
    const cidRaw = String(message['cid'] ?? '');
    const conversationId = cidRaw.replace('@goofish', '');

    const senderUserId = stripGoofishSuffix(String(ext['senderUserId'] ?? ''));
    const currentUid = getCurrentUserId();
    confirmPendingSendByEcho(conversationId, content, senderUserId);
    if (userExt?.['needPush'] !== 'true') return null;
    const reminderUrl = String(ext['reminderUrl'] ?? '');
    const participants = buildConversationParticipants(senderUserId, currentUid, reminderUrl, message);
    if (cidRaw && participants.length >= 2) {
      g.conversationParticipants.set(cidRaw, participants);
    }

    if (!content || !msgId) return null;
    if (processedMsgIds.has(msgId)) return null;
    processedMsgIds.add(msgId);
    if (createAt > 0 && createAt < LOAD_TIME - 5000) return null;

    const itemIdMatch = reminderUrl.match(/itemId=(\d+)/);

    return {
      id: msgId, buyerName, content, timestamp: createAt || Date.now(),
      buyerUserId: senderUserId,
      conversationId, conversationIdType: 'real',
      participants,
      itemId: itemIdMatch?.[1] ?? '',
      productTitle: '',
    };
  }

  // 支持两种格式：
  // 格式 A（MessagePack 数字键）：{ "1": { "2": "cid@goofish", "5": ts, "10": { reminderContent, ... } }, "3": { needPush } }
  // 格式 B（JSON operation）：{ "operation": { "cid": "...", "content": { ... }, "sender": { ... } }, ... }
  function parseSyncPushItem(decoded: Record<string, unknown>): Record<string, unknown> | null {
    console.log('[WS-Connector] ★ 解码内容:', JSON.stringify(decoded).slice(0, 800));

    // ── 格式 B：JSON operation 结构 ──
    if (decoded['operation'] || decoded['chatType'] !== undefined) {
      return parseSyncPushItemJson(decoded);
    }

    // ── 格式 A：MessagePack 数字键 ──
    const msgObj = decoded['1'] as Record<string, unknown> | undefined;
    if (!msgObj || typeof msgObj !== 'object') {
      console.log('[WS-Connector] ★ decoded[1] 不是对象，尝试 JSON 解析');
      return parseSyncPushItemJson(decoded);
    }

    // needPush=false → 自己发的，跳过
    const userExt = decoded['3'] as Record<string, unknown> | undefined;
    if (userExt?.['needPush'] === 'false') return null;

    // extension（key "10"）
    const ext = msgObj['10'] as Record<string, unknown> | undefined;
    if (!ext) {
      console.log('[WS-Connector] ★ 无 key 10, msgObj keys:', Object.keys(msgObj), '尝试 JSON 解析');
      return parseSyncPushItemJson(decoded);
    }

    const messageContent = String(ext['reminderContent'] ?? '');
    const senderName = String(ext['reminderTitle'] ?? '买家');
    const senderUserId = stripGoofishSuffix(String(ext['senderUserId'] ?? ''));
    const currentUid = getCurrentUserId();
    const reminderUrl = String(ext['reminderUrl'] ?? '');
    const conversationId = resolveMsgPackConversationId(msgObj, senderUserId, currentUid);
    const createAt = Number(msgObj['5'] ?? 0);
    confirmPendingSendByEcho(conversationId, messageContent, senderUserId);
    if (currentUid && senderUserId === currentUid) return null;
    if (!messageContent) return null;
    if (messageContent.startsWith('[') && messageContent.endsWith(']')) return null;

    // 优先用真实 messageId
    const realMsgId = String(ext['messageId'] ?? '');
    const msgId = realMsgId || `sync-${conversationId}-${createAt || Date.now()}`;
    if (processedMsgIds.has(msgId)) return null;
    processedMsgIds.add(msgId);

    // 缓存参与者
    const participants = buildConversationParticipants(senderUserId, currentUid, reminderUrl, msgObj);
    if (conversationId && participants.length >= 2) {
      g.conversationParticipants.set(
        conversationId.includes('@') ? conversationId : `${conversationId}@goofish`,
        participants,
      );
    }

    // 从 reminderUrl 中提取 itemId
    const itemIdMatch = reminderUrl.match(/itemId=(\d+)/);

    // 过期消息（5 分钟前）
    if (createAt > 0 && (Date.now() - createAt) > 300_000) return null;

    console.log('[WS-Connector] 实时消息 (MsgPack):', senderName, messageContent, {
      conversationId,
      participants,
      rawKeys: {
        key1: msgObj['1'],
        key2: msgObj['2'],
        key3: msgObj['3'],
      },
    });

    return {
      id: msgId, buyerName: senderName, content: messageContent,
      buyerUserId: senderUserId,
      timestamp: createAt || Date.now(), conversationId,
      conversationIdType: 'real',
      participants,
      itemId: itemIdMatch?.[1] ?? '',
      productTitle: '',
    };
  }

  // ── JSON operation 格式解析（闲鱼 WS 实际推送的 JSON 格式）──────────
  function parseSyncPushItemJson(decoded: Record<string, unknown>): Record<string, unknown> | null {
    // 格式: { chatType, incrementType, operation: { cid, content: { contentType, custom }, sender: { uid, nick }, messageId, createAt } }
    const operation = decoded['operation'] as Record<string, unknown> | undefined;
    if (!operation) {
      console.log('[WS-Connector] ★ JSON 格式但无 operation 字段, keys:', Object.keys(decoded));
      return null;
    }

    const content = operation['content'] as Record<string, unknown> | undefined;
    const sender = operation['sender'] as Record<string, unknown> | undefined;
    if (!content || !sender) {
      console.log('[WS-Connector] ★ operation 缺少 content 或 sender');
      return null;
    }

    // 提取消息文本
    const custom = content['custom'] as Record<string, unknown> | undefined;
    let messageText = extractJsonMessageText(content);

    if (!messageText && custom) {
      // custom.summary 或 custom.text.text
      messageText = String(custom['summary'] ?? '');
      if (!messageText) {
        const textObj = custom['text'] as Record<string, unknown> | undefined;
        messageText = String(textObj?.['text'] ?? '');
      }
      // 如果 custom 有 data 字段（base64 编码的 JSON），尝试解析
      if (!messageText && typeof custom['data'] === 'string') {
        try {
          const innerData = JSON.parse(atob(custom['data'] as string));
          messageText = String(innerData?.text?.text ?? '');
        } catch { /* ignore */ }
      }
    }

    if (!messageText) {
      console.log('[WS-Connector] ★ JSON 消息文本为空, content:', JSON.stringify(content).slice(0, 200));
      return null;
    }

    const senderUid = String(sender['uid'] ?? '').replace('@goofish', '');
    const senderNick = String(sender['nick'] ?? (senderUid || '买家'));
    const cidRaw = String(operation['cid'] ?? decoded['cid'] ?? '');
    const conversationId = cidRaw.replace('@goofish', '');
    const createAt = Number(operation['createAt'] ?? decoded['createAt'] ?? 0);
    const msgId = String(operation['messageId'] ?? decoded['messageId'] ?? `json-${conversationId}-${createAt || Date.now()}`);

    // 过滤自己发的
    const currentUid = getCurrentUserId();
    confirmPendingSendByEcho(conversationId, messageText, senderUid);
    if (currentUid && senderUid === currentUid) {
      console.log('[WS-Connector] ★ JSON: 过滤自己发的消息');
      return null;
    }

    // 去重
    if (processedMsgIds.has(msgId)) return null;
    processedMsgIds.add(msgId);

    // 过期消息（5 分钟前）
    if (createAt > 0 && (Date.now() - createAt) > 300_000) return null;

    // 系统消息
    if (messageText.startsWith('[') && messageText.endsWith(']')) return null;

    // 缓存参与者
    let participants: string[] = [];
    if (cidRaw && senderUid) {
      const senderFull = senderUid.includes('@') ? senderUid : `${senderUid}@goofish`;
      participants = [senderFull];
      if (currentUid && currentUid !== senderUid) participants.push(`${currentUid}@goofish`);
      g.conversationParticipants.set(
        cidRaw.includes('@') ? cidRaw : `${cidRaw}@goofish`,
        participants
      );
    }

    const reminderUrl = String((operation['extension'] as Record<string, unknown> | undefined)?.['reminderUrl'] ?? '');
    const itemIdMatch = reminderUrl.match(/itemId=(\d+)/);

    console.log('[WS-Connector] ✅ JSON 买家消息:', senderNick, messageText, 'cid:', conversationId);

    return {
      id: msgId, buyerName: senderNick, content: messageText,
      buyerUserId: senderUid,
      timestamp: createAt || Date.now(), conversationId,
      conversationIdType: 'real',
      participants,
      itemId: itemIdMatch?.[1] ?? '',
      productTitle: '',
    };
  }

  // ── 主动建立 WS 连接 ──────────────────────────────────────────────

  // connector 自己的 WS 实例（独立于 interceptor 拦截的页面 WS）
  let connectorWs: WebSocket | null = null;

  async function establishConnection(): Promise<void> {
    // 只检查 connector 自己的连接，不受 interceptor 影响
    // interceptor 拦截的是页面的 WS（只收 bizType:40），connector 需要自己的连接来收聊天消息
    if (connectorWs && connectorWs.readyState === WebSocket.OPEN) {
      console.log('[WS-Connector] 已有自建 WS 连接，跳过');
      return;
    }

    const uid = getCurrentUserId();
    if (!uid) {
      console.log('[WS-Connector] 未登录（无 unb cookie），停止连接');
      return; // 未登录不重试
    }

    // 生成 deviceId（整个连接生命周期复用同一个，token 和 /reg 必须一致）
    const deviceId = generateDeviceId(uid);
    console.log('[WS-Connector] 开始主动建立 WS 连接...', 'uid:', uid, 'did:', deviceId);

    // 1. 获取 accessToken（带超时保护）
    let accessToken: string | null = null;
    try {
      accessToken = await getAccessToken(deviceId);
    } catch (err) {
      console.error('[WS-Connector] getAccessToken 抛出异常:', err);
    }
    if (!accessToken) {
      // 检查是否是未登录（_m_h5_tk 缺失），未登录不重试
      const hasTk = document.cookie.includes('_m_h5_tk=');
      if (!hasTk) {
        console.log('[WS-Connector] 未登录闲鱼，停止连接（登录后刷新页面即可）');
        return;
      }
      console.error('[WS-Connector] 无法获取 accessToken，稍后重试');
      scheduleReconnect();
      return;
    }

    // 2. 建立 WebSocket 连接
    const ws = new WebSocket(WS_URL);

    ws.addEventListener('open', () => {
      console.log('[WS-Connector] WS 连接已建立，发送注册消息...');
      const regMsg = {
        lwp: '/reg',
        headers: {
          'cache-header': 'app-key token ua wv',
          'app-key': '444e9908a51d1cb236a27862abc769c9',
          'token': accessToken,
          'ua': DINGTALK_UA,  // 必须用 DingTalk UA，服务器会验证
          'dt': 'j',
          'wv': 'im:3,au:3,sy:6',
          'sync': '0,0;0;0;',
          'did': deviceId,
          'mid': generateMid(),
        },
      };
      ws.send(JSON.stringify(regMsg));
      console.log('[WS-Connector] /reg 消息已发送, did:', deviceId);

      // 4. 等待收到 /reg 响应后发送初始 ackDiff（告诉服务器我们准备好接收）
      // 注意：必须发一次初始 ackDiff，否则服务器不会推送新消息
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          sendAckDiff(ws);
          console.log('[WS-Connector] 初始 ackDiff 已发送');
        }
      }, 1000);

      // 5. 保存 WS 引用
      connectorWs = ws;
      g.activeWs = ws;
      g.connectorActive = true;
      g.lastSyncPushTime = Date.now(); // 初始化
      startHeartbeat(ws);
      startStaleCheck();
      startPeriodicReconnect();

      console.log('[WS-Connector] WS 连接注册完成（含僵死检测和定期重连）');
    });

    ws.addEventListener('message', (event: MessageEvent) => {
      try {
        if (typeof event.data !== 'string') return;
        const data = JSON.parse(event.data) as Record<string, unknown>;

        // ── ACK：对每个带 headers.mid 的消息回复 ACK（与 XianyuAutoAgent 一致）──
        // 服务器可能在未收到 ACK 前不推送后续消息
        const headers = data['headers'] as Record<string, unknown> | undefined;
        if (headers && headers['mid']) {
          const ack: Record<string, unknown> = {
            code: 200,
            headers: {
              mid: headers['mid'],
              sid: headers['sid'] ?? '',
            },
          };
          // 转发可选 header 字段（与 XianyuAutoAgent handle_message 一致）
          if (headers['app-key']) (ack['headers'] as Record<string, unknown>)['app-key'] = headers['app-key'];
          if (headers['ua']) (ack['headers'] as Record<string, unknown>)['ua'] = headers['ua'];
          if (headers['dt']) (ack['headers'] as Record<string, unknown>)['dt'] = headers['dt'];

          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(ack));
          }
        }

        // 处理服务器响应（code 字段表示这是对我们请求的响应）
        if (data['code'] !== undefined) {
          const code = data['code'];
          const lwp = data['lwp'] ?? '';
          const mid = typeof headers?.['mid'] === 'string' ? headers['mid'] : '';
          if (mid) {
            if (code === 200) {
              markPendingSendAccepted(mid);
            } else {
              settlePendingSend(mid, false, JSON.stringify(data));
            }
          }
          if (code !== 200) {
            console.log('[WS-Connector] 非 200 响应:', code, lwp, JSON.stringify(data).slice(0, 200));
          }
          // code 响应不包含推送消息，但可能有 body 需要检查
          // 不要 return，继续检查 body 中是否有 syncPushPackage
        }

        // 解析和分发消息
        const body = data['body'] as Record<string, unknown> | undefined;
        if (body) {
          const hasUserModels = Array.isArray(body['userMessageModels']);
          const hasSyncPkg = !!(body['syncPushPackage'] as Record<string, unknown> | undefined);
          if (hasUserModels || hasSyncPkg) {
            console.log('[WS-Connector] 收到消息推送:', {
              hasUserModels,
              userModelCount: hasUserModels ? (body['userMessageModels'] as unknown[]).length : 0,
              hasSyncPkg,
              lwp: data['lwp'] ?? '',
            });
          }
        }

        parseAndDispatchWsMessage(data, ws);
      } catch (err) {
        console.error('[WS-Connector] 消息处理异常:', err);
      }
    });

    ws.addEventListener('close', (event: CloseEvent) => {
      console.log('[WS-Connector] WS 连接关闭:', event.code, event.reason);
      if (connectorWs === ws) {
        connectorWs = null;
      }
      if (g.activeWs === ws) {
        g.activeWs = null;
      }
      g.connectorActive = false;
      stopHeartbeat();
      for (const [mid] of pendingSendRequests) {
        settlePendingSend(mid, false, 'WebSocket closed');
      }
      if (g.staleCheckTimer) { clearInterval(g.staleCheckTimer); g.staleCheckTimer = null; }
      if (g.periodicReconnectTimer) { clearInterval(g.periodicReconnectTimer); g.periodicReconnectTimer = null; }
      scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      console.error('[WS-Connector] WS 连接错误');
      stopHeartbeat();
    });
  }

  function scheduleReconnect(): void {
    if (reconnectTimer) return;
    console.log('[WS-Connector] 将在', RECONNECT_DELAY / 1000, '秒后重连...');
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      establishConnection();
    }, RECONNECT_DELAY);
  }

  /**
   * 僵死检测：如果长时间未收到 sync 推送，说明连接已僵死，强制重连
   */
  function startStaleCheck(): void {
    if (g.staleCheckTimer) clearInterval(g.staleCheckTimer);
    g.staleCheckTimer = setInterval(() => {
      if (!connectorWs || connectorWs.readyState !== WebSocket.OPEN) return;
      const elapsed = Date.now() - g.lastSyncPushTime;
      if (elapsed > STALE_THRESHOLD) {
        console.log('[WS-Connector] ⚠️ 僵死检测：', Math.round(elapsed / 1000), '秒无 sync 推送，强制重连');
        forceReconnect();
      }
    }, STALE_CHECK_INTERVAL);
  }

  /**
   * 定期重连：每 30 分钟强制重连以刷新服务器注册
   */
  function startPeriodicReconnect(): void {
    if (g.periodicReconnectTimer) clearInterval(g.periodicReconnectTimer);
    g.periodicReconnectTimer = setInterval(() => {
      console.log('[WS-Connector] 🔄 定期重连（每 30 分钟刷新注册）');
      forceReconnect();
    }, PERIODIC_RECONNECT_INTERVAL);
  }

  /**
   * 强制重连：关闭现有连接并重新建立
   */
  function forceReconnect(): void {
    stopHeartbeat();
    if (g.staleCheckTimer) { clearInterval(g.staleCheckTimer); g.staleCheckTimer = null; }
    if (g.periodicReconnectTimer) { clearInterval(g.periodicReconnectTimer); g.periodicReconnectTimer = null; }
    if (connectorWs) {
      try { connectorWs.close(); } catch { /* ignore */ }
      connectorWs = null;
    }
    if (g.activeWs) {
      try { g.activeWs.close(); } catch { /* ignore */ }
      g.activeWs = null;
    }
    g.connectorActive = false;
    // 清除重连定时器，直接连接
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    establishConnection();
  }

  // ── 监听来自 Content Script 的消息（发送消息 + WS 状态查询）────────
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.source !== SOURCE) return;

    // WS 状态查询
    if (event.data.type === 'WS_STATUS') {
      const ws = connectorWs ?? g.activeWs;
      window.postMessage({
        source: SOURCE,
        type: 'WS_STATUS_RESPONSE',
        payload: {
          requestId: event.data.payload?.requestId,
          connected: ws !== null && ws.readyState === WebSocket.OPEN,
        },
      }, '*');
      return;
    }

    if (event.data.type !== 'SEND_WS_MESSAGE') return;

    const { requestId, cid, text, buyerUserId, participants } = event.data.payload as {
      requestId: string;
      cid: string;
      text: string;
      buyerUserId?: string;
      participants?: string[];
    };

    console.log('[WS-Connector] 收到发送请求:', cid, text.slice(0, 50));

    try {
      const ws = connectorWs ?? g.activeWs;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        throw new Error('WebSocket 未连接');
      }

      const cidFull = cid.includes('@') ? cid : `${cid}@goofish`;
      const currentUid = getCurrentUserId();

      const currentUserId = ensureGoofishUserId(currentUid);
      const peerUserId = ensureGoofishUserId(String(buyerUserId ?? ''));

      let receivers =
        peerUserId && currentUserId
          ? [peerUserId, currentUserId]
          : g.conversationParticipants.get(cidFull);

      if ((!receivers || receivers.length < 2) && participants?.length) {
        const hinted = new Set<string>();
        for (const participant of participants) {
          const userId = ensureGoofishUserId(String(participant ?? ''));
          if (!userId || !isLikelyUserId(userId)) continue;
          hinted.add(userId);
        }
        if (currentUserId) hinted.add(currentUserId);
        receivers = Array.from(hinted);
        if (receivers.length >= 2) {
          g.conversationParticipants.set(cidFull, receivers);
        }
      }
      if (receivers && receivers.length > 2) {
        const currentUserId = ensureGoofishUserId(currentUid);
        const peer = receivers.find((participant) => participant !== currentUserId);
        receivers = peer && currentUserId ? [peer, currentUserId] : receivers.slice(0, 2);
      }
      if (!receivers || receivers.length < 2) {
        throw new Error(`缺少有效会话参与者，无法通过 WS 发送: ${cidFull}`);
      }

      if (!currentUid) {
        throw new Error('无法从 cookie 获取当前用户 ID');
      }

      const mid = generateMid();
      const msgPayload = {
        lwp: '/r/MessageSend/sendByReceiverScope',
        headers: { mid },
        body: [
          {
            uuid: `-${Date.now()}${Math.floor(Math.random() * 10)}`,
            cid: cidFull,
            conversationType: 1,
            content: {
              contentType: 101,
              custom: {
                type: 1,
                data: btoa(unescape(encodeURIComponent(JSON.stringify({ contentType: 1, text: { text } })))),
              },
            },
            redPointPolicy: 0,
            extension: { extJson: '{}' },
            ctx: { appVersion: '1.0', platform: 'web' },
            mtags: {},
            msgReadStatusSetting: 1,
          },
          { actualReceivers: receivers },
        ],
      };

      const timer = setTimeout(() => {
        const pending = pendingSendRequests.get(mid);
        pendingSendRequests.delete(mid);
        window.postMessage({
          source: SOURCE,
          type: 'SEND_WS_RESPONSE',
          payload: {
            requestId,
            success: false,
            error: pending?.accepted ? 'WS accepted but no self echo' : 'WS send confirm timeout',
          },
        }, '*');
      }, 10_000);

      pendingSendRequests.set(mid, { requestId, timer, cid: cidFull, text, accepted: false });

      ws.send(JSON.stringify(msgPayload));
      console.log('[WS-Connector] 消息已发送:', { cidFull, receivers });

    } catch (err) {
      console.error('[WS-Connector] WS 发送失败:', err);
      window.postMessage({
        source: SOURCE,
        type: 'SEND_WS_RESPONSE',
        payload: { requestId, success: false, error: String(err) },
      }, '*');
    }
  });

  // ── 初始化 ────────────────────────────────────────────────────────

  function init(): void {
    // 独立建立 WS 连接（与 XianyuAutoAgent 一致）
    console.log('[WS-Connector] 已加载，', CONNECT_CHECK_DELAY / 1000, '秒后启动独立 WS 连接...');
    setTimeout(() => {
      console.log('[WS-Connector] 启动独立 WS 连接（与 XianyuAutoAgent 一致）');
      establishConnection();
    }, CONNECT_CHECK_DELAY);

    // Token 定期刷新（1 小时），刷新后重连
    tokenRefreshTimer = setInterval(async () => {
      console.log('[WS-Connector] Token 定期刷新...');
      if (connectorWs) {
        connectorWs.close();
        // close 事件会触发 scheduleReconnect → establishConnection（获取新 token）
      }
    }, TOKEN_REFRESH_INTERVAL);
  }

  init();
  console.log('[WS-Connector] 主动 WS 连接器已加载');
})();
