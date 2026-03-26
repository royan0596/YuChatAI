import { DEFAULT_SETTINGS, type AppSettings, type ProductKnowledgeItem } from './types';

const SETTINGS_KEY = 'xianyu-smart-assistant-settings';
const STATS_KEY = 'xianyu-smart-assistant-stats';

export interface StoredStats {
  running: boolean;
  processedMessages: number;
  todayOrders: number;
}

export const DEFAULT_STATS: StoredStats = {
  running: true,
  processedMessages: 0,
  todayOrders: 0,
};

export async function getSettings(): Promise<AppSettings> {
  const result = await chrome.storage.sync.get(SETTINGS_KEY);
  const merged: AppSettings = {
    ...DEFAULT_SETTINGS,
    ...(result[SETTINGS_KEY] as Partial<AppSettings> | undefined),
    ai: {
      ...DEFAULT_SETTINGS.ai,
      ...((result[SETTINGS_KEY] as Partial<AppSettings> | undefined)?.ai ?? {}),
    },
    notification: {
      ...DEFAULT_SETTINGS.notification,
      ...((result[SETTINGS_KEY] as Partial<AppSettings> | undefined)?.notification ?? {}),
    },
  };
  const directSendAuthorized = Boolean(merged.ai.directSendAuthorized);

  return {
    ...merged,
    ai: {
      ...merged.ai,
      directSendAuthorized,
      autoReplyEnabled: directSendAuthorized,
      reviewModeEnabled: false,
    },
  };
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  const directSendAuthorized = Boolean(settings.ai.directSendAuthorized);
  await chrome.storage.sync.set({
    [SETTINGS_KEY]: {
      ...settings,
      ai: {
        ...settings.ai,
        directSendAuthorized,
        autoReplyEnabled: directSendAuthorized,
        reviewModeEnabled: false,
      },
    },
  });
}

export async function getStats(): Promise<StoredStats> {
  const result = await chrome.storage.local.get(STATS_KEY);
  return {
    ...DEFAULT_STATS,
    ...(result[STATS_KEY] as Partial<StoredStats> | undefined),
  };
}

export async function saveStats(stats: StoredStats): Promise<void> {
  await chrome.storage.local.set({
    [STATS_KEY]: stats,
  });
}

export async function patchStats(partial: Partial<StoredStats>): Promise<StoredStats> {
  const current = await getStats();
  const next = { ...current, ...partial };
  await saveStats(next);
  return next;
}

// ── 商品知识库 ──────────────────────────────────────────────────────
const PRODUCT_KNOWLEDGE_KEY = 'xianyu-product-knowledge';

export async function getProductKnowledge(): Promise<ProductKnowledgeItem[]> {
  const result = await chrome.storage.local.get(PRODUCT_KNOWLEDGE_KEY);
  return (result[PRODUCT_KNOWLEDGE_KEY] as ProductKnowledgeItem[] | undefined) ?? [];
}

export async function saveProductKnowledge(items: ProductKnowledgeItem[]): Promise<void> {
  await chrome.storage.local.set({ [PRODUCT_KNOWLEDGE_KEY]: items });
}

// ── 消息日志 ──────────────────────────────────────────────────────
const MSG_LOG_KEY = 'xianyu-msg-log';
const MAX_LOG_SIZE = 20; // 侧边栏默认只保留并展示最近 20 条

export interface MessageLogEntry {
  id: string;
  buyerName: string;
  content: string;
  reply: string;
  intent: string;
  timestamp: number;
  conversationId: string;
  sent: boolean;
}

export async function getMessageLogs(): Promise<MessageLogEntry[]> {
  const result = await chrome.storage.local.get(MSG_LOG_KEY);
  return (result[MSG_LOG_KEY] as MessageLogEntry[] | undefined) ?? [];
}

export async function appendMessageLog(entry: MessageLogEntry): Promise<void> {
  const logs = await getMessageLogs();
  logs.push(entry);
  // 只保留最近 N 条
  const trimmed = logs.slice(-MAX_LOG_SIZE);
  await chrome.storage.local.set({ [MSG_LOG_KEY]: trimmed });
}
