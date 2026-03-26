export const EXTENSION_NAME = '闲鱼智能客服助手';

export const SIDEBAR_ID = 'xianyu-smart-sidebar';

export const MESSAGE_SOURCE = 'xianyu-smart-assistant';

export const XIANYU_MATCHES = [
  'https://*.goofish.com/*',
  'https://*.idlefish.com/*',
] as const;

export const DEFAULT_SIDEBAR_WIDTH = 300;

export const STORAGE_KEYS = {
  settings: 'xianyu-smart-assistant-settings',
  stats: 'xianyu-smart-assistant-stats',
} as const;
