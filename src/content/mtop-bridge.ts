/**
 * mtop API 桥接模块（运行在页面主上下文）
 *
 * Service Worker 无法携带 partitioned cookie 发起 mtop 请求，
 * 因此将 mtop 请求委托到页面上下文执行，通过 postMessage 与 Content Script 通信。
 *
 * 流程：Background → Content Script → postMessage → 本模块 → fetch → postMessage 回传结果
 */

(function () {
  const SOURCE = 'xianyu-smart-assistant';

  // ── MD5 (Joseph Myers) ──────────────────────────────────────────────
  function md5(str: string): string {
    function safeAdd(x: number, y: number) {
      const l = (x & 0xffff) + (y & 0xffff);
      return (((x >> 16) + (y >> 16) + (l >> 16)) << 16) | (l & 0xffff);
    }
    function rol(n: number, c: number) { return (n << c) | (n >>> (32 - c)); }
    function cmn(q: number, a: number, b: number, x: number, s: number, t: number) {
      return safeAdd(rol(safeAdd(safeAdd(a, q), safeAdd(x, t)), s), b);
    }
    function ff(a: number,b: number,c: number,d: number,x: number,s: number,t: number) { return cmn((b&c)|((~b)&d),a,b,x,s,t); }
    function gg(a: number,b: number,c: number,d: number,x: number,s: number,t: number) { return cmn((b&d)|(c&(~d)),a,b,x,s,t); }
    function hh(a: number,b: number,c: number,d: number,x: number,s: number,t: number) { return cmn(b^c^d,a,b,x,s,t); }
    function ii(a: number,b: number,c: number,d: number,x: number,s: number,t: number) { return cmn(c^(b|(~d)),a,b,x,s,t); }

    const bytes: number[] = [];
    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i);
      if (code < 0x80) bytes.push(code);
      else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
      else bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
    const bl = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    bytes.push(bl & 0xff, (bl >> 8) & 0xff, (bl >> 16) & 0xff, (bl >>> 24) & 0xff, 0, 0, 0, 0);

    let a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
    for (let off = 0; off < bytes.length; off += 64) {
      const m: number[] = [];
      for (let j = 0; j < 16; j++) m[j] = bytes[off+j*4]|(bytes[off+j*4+1]<<8)|(bytes[off+j*4+2]<<16)|(bytes[off+j*4+3]<<24);
      const oa = a, ob = b, oc = c, od = d;
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
      a=safeAdd(a,oa); b=safeAdd(b,ob); c=safeAdd(c,oc); d=safeAdd(d,od);
    }
    const hex = (n: number) => { let s = ''; for (let i = 0; i < 4; i++) s += ((n >>> (i*8)) & 0xff).toString(16).padStart(2, '0'); return s; };
    return hex(a) + hex(b) + hex(c) + hex(d);
  }

  // ── mtop 请求 ───────────────────────────────────────────────────────
  async function callMtopApi(
    api: string,
    version: string,
    data: Record<string, unknown>
  ): Promise<Record<string, unknown> | null> {
    const tkCookie = document.cookie.split(';').map(c => c.trim()).find(c => c.startsWith('_m_h5_tk='));
    const tkRaw = tkCookie ? tkCookie.split('=')[1] : '';
    const token = tkRaw.split('_')[0];

    if (!token) {
      console.log('[MtopBridge] _m_h5_tk cookie 不存在');
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
    const controller = new AbortController();
    const fetchTimeout = window.setTimeout(() => controller.abort(), 12_000);

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

      const text = await resp.text();
      return JSON.parse(text) as Record<string, unknown>;
    } finally {
      window.clearTimeout(fetchTimeout);
    }
  }

  // ── 监听来自 Content Script 的 mtop 请求 ────────────────────────────
  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    if (event.data?.source !== SOURCE || event.data?.type !== 'MTOP_REQUEST') return;

    const { requestId, api, version, data } = event.data.payload as {
      requestId: string;
      api: string;
      version: string;
      data: Record<string, unknown>;
    };

    console.info('[MtopBridge] 收到 mtop 请求:', api, version);

    try {
      const result = await callMtopApi(api, version, data);
      window.postMessage({
        source: SOURCE,
        type: 'MTOP_RESPONSE',
        payload: { requestId, success: true, data: result },
      }, '*');
    } catch (err) {
      console.error('[MtopBridge] 请求失败:', err);
      window.postMessage({
        source: SOURCE,
        type: 'MTOP_RESPONSE',
        payload: { requestId, success: false, error: String(err) },
      }, '*');
    }
  });

  console.info('[MtopBridge] mtop 桥接模块已加载');
})();
