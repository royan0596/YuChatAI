/**
 * /im 标签页管理器（共享单例）
 *
 * 解决 message-poller 和 reply-sender 各自独立创建 /im 标签页导致的竞态问题。
 * 所有需要 /im 标签页的模块都通过此管理器获取，确保：
 * 1. 同一时间只创建一个 /im 标签页
 * 2. WS 连接就绪后才返回 tabId
 * 3. 标签页被关闭后能自动重新创建
 */

let cachedImTabId: number | null = null;
let pendingEnsure: Promise<number | null> | null = null;

async function ensureContentScript(tabId: number): Promise<boolean> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    return true;
  } catch {
    console.info('[ImTabManager] Content Script 未就绪，尝试注入 tab:', tabId);
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content.js'],
      });
      await new Promise((r) => setTimeout(r, 500));
      return true;
    } catch (err) {
      console.error('[ImTabManager] Content Script 注入失败:', err);
      return false;
    }
  }
}

function waitForTabComplete(tabId: number, timeout: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(false);
    }, timeout);

    function listener(updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(true);
      }
    }

    chrome.tabs.onUpdated.addListener(listener);

    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(true);
      }
    }).catch(() => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(false);
    });
  });
}

async function getWsStatus(tabId: number): Promise<boolean> {
  try {
    const response = (await chrome.tabs.sendMessage(tabId, {
      type: 'WS_STATUS',
    })) as { connected?: boolean } | undefined;
    return response?.connected === true;
  } catch {
    return false;
  }
}

async function waitForWsConnected(tabId: number, timeout: number): Promise<boolean> {
  const startTime = Date.now();
  const interval = 1000;

  while (Date.now() - startTime < timeout) {
    if (await getWsStatus(tabId)) {
      console.info('[ImTabManager] WS 连接已就绪, tabId:', tabId);
      return true;
    }

    await new Promise((r) => setTimeout(r, interval));
  }

  console.log('[ImTabManager] 等待 WS 连接超时, tabId:', tabId);
  return false;
}

/**
 * 检查缓存的 tabId 是否仍然有效
 */
async function isTabAlive(tabId: number): Promise<boolean> {
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab.status === 'complete' && (tab.url?.includes('/im') ?? false);
  } catch {
    return false;
  }
}

/**
 * 核心方法：确保有一个 /im 标签页且 WS 已连接
 *
 * @param needWs 是否需要等待 WS 连接（发消息时需要，DOM 抓取时不需要）
 */
async function doEnsureImTab(needWs: boolean): Promise<number | null> {
  // 1. 检查缓存
  if (cachedImTabId) {
    if (await isTabAlive(cachedImTabId)) {
      const scriptReady = await ensureContentScript(cachedImTabId);
      if (scriptReady) {
        if (!needWs) return cachedImTabId;
        if (await getWsStatus(cachedImTabId)) return cachedImTabId;

        console.info('[ImTabManager] 复用缓存的 /im 标签页并等待 WS 连接:', cachedImTabId);
        if (await waitForWsConnected(cachedImTabId, 20_000)) {
          return cachedImTabId;
        }
      }
    } else {
      cachedImTabId = null;
    }
  }

  // 2. 查找已有的 /im 标签页
  const imTabs = await chrome.tabs.query({
    url: ['https://*.goofish.com/im*'],
  });

  for (const tab of imTabs) {
    if (!tab.id || tab.status !== 'complete') continue;
    const scriptReady = await ensureContentScript(tab.id);
    if (!scriptReady) continue;

    if (!needWs) {
      cachedImTabId = tab.id;
      return tab.id;
    }

    if (await getWsStatus(tab.id)) {
      cachedImTabId = tab.id;
      return tab.id;
    }

    console.info('[ImTabManager] 发现已有 /im 标签页但 WS 未连接，继续等待:', tab.id);
    if (await waitForWsConnected(tab.id, 20_000)) {
      cachedImTabId = tab.id;
      return tab.id;
    }
  }

  // 3. 没有可用的 /im 标签页，创建一个
  console.info('[ImTabManager] 自动打开 /im 标签页...');
  console.info('[ImTabManager] 当前没有可复用的 /im 标签页，跳过自动创建');
  return null;

  /* let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.create({
      url: 'https://www.goofish.com/im',
      active: false,
      pinned: true,
    });
  } catch (err) {
    console.error('[ImTabManager] 创建 /im 标签页失败:', err);
    return null;
  }

  if (!tab.id) return null;
  const tabId = tab.id;

  // 4. 等待页面加载完成
  const loaded = await waitForTabComplete(tabId, 15_000);
  if (!loaded) {
    console.log('[ImTabManager] /im 页面加载超时');
    return null;
  }

  // 5. 注入 Content Script（manifest 应该已经自动注入，这里做双保险）
  const scriptReady = await ensureContentScript(tabId);
  if (!scriptReady) return null;

  // 6. 等待 WS 连接（如果需要）
  if (needWs) {
    const connected = await waitForWsConnected(tabId, 20_000);
    if (!connected) {
      console.log('[ImTabManager] /im 页面 WS 连接未建立, tabId:', tabId);
      // 即使 WS 没连接也返回 tabId，让调用方决定如何处理
    }
  } else {
    // 即使不需要 WS，也等一下让 DOM 渲染
    await new Promise((r) => setTimeout(r, 2000));
  }

  cachedImTabId = tabId;
  return tabId; */
}

/**
 * 获取可用的 /im 标签页（带锁机制，防止并发创建多个标签页）
 *
 * @param needWs 是否需要等待 WS 连接就绪（默认 true）
 */
export async function getImTab(needWs = true): Promise<number | null> {
  // 如果已经有一个 ensureImTab 在进行中，等待它完成
  if (pendingEnsure) {
    console.info('[ImTabManager] 等待已有的 ensureImTab 完成...');
    const result = await pendingEnsure;
    // 上一次可能不需要 WS 但这次需要，重新检查
    if (result && needWs) {
      if (await getWsStatus(result)) return result;
      // WS 还没连接，等一等
      return waitForWsConnected(result, 20_000).then((ok) => ok ? result : null);
    }
    return result;
  }

  pendingEnsure = doEnsureImTab(needWs);
  try {
    return await pendingEnsure;
  } finally {
    pendingEnsure = null;
  }
}

/**
 * 查找任意闲鱼标签页（用于 mtop 请求等不需要 /im 的场景）
 */
export async function findAnyGoofishTab(): Promise<number | null> {
  const tabs = await chrome.tabs.query({
    url: ['https://*.goofish.com/*', 'https://*.idlefish.com/*'],
  });

  if (!tabs.length) return null;

  const completeTabs = tabs.filter((t) => t.status === 'complete');
  const targetTab = completeTabs.find((t) => t.active) ?? completeTabs[0] ?? tabs[0];
  if (!targetTab.id) return null;

  const ready = await ensureContentScript(targetTab.id);
  return ready ? targetTab.id : null;
}

/**
 * 查找任意有 WS 连接的闲鱼标签页（用于发送消息）
 * 优先检查所有闲鱼标签页的 WS 状态，不限于 /im
 */
export async function findTabWithWs(): Promise<number | null> {
  const tabs = await chrome.tabs.query({
    url: ['https://*.goofish.com/*', 'https://*.idlefish.com/*'],
  });

  for (const tab of tabs) {
    if (!tab.id || tab.status !== 'complete') continue;
    try {
      const ready = await ensureContentScript(tab.id);
      if (!ready) continue;
      if (await getWsStatus(tab.id)) {
        console.info('[ImTabManager] 发现有 WS 连接的标签页:', tab.id, tab.url?.slice(0, 60));
        return tab.id;
      }
    } catch {
      continue;
    }
  }

  return null;
}

// 监听标签页关闭事件，清理缓存
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === cachedImTabId) {
    console.info('[ImTabManager] 缓存的 /im 标签页已关闭');
    cachedImTabId = null;
  }
});
