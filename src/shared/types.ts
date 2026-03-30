export type AIProvider = 'openai' | 'deepseek' | 'qwen' | 'custom';

export type SmsProvider = 'aliyun' | 'tencent';

export type DingtalkProvider = 'webhook';

export type FeishuProvider = 'webhook';

export type TelegramProvider = 'bot';

export interface AIConfig {
  provider: AIProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
  systemPrompt: string;
  directSendAuthorized: boolean;
  autoReplyEnabled: boolean;
  reviewModeEnabled: boolean;
  temperature: number;
  maxTokens: number;
  knowledgeBase: string;
}

export interface NotificationConfig {
  browserEnabled: boolean;

  // 短信
  smsEnabled: boolean;
  smsProvider: SmsProvider;
  smsAccessKey?: string;
  smsSecretKey?: string;
  smsSignName?: string;
  smsTemplateCode?: string;
  smsPhone?: string;

  // 钉钉机器人
  dingtalkEnabled: boolean;
  dingtalkWebhook?: string;
  /** 安全设置：加签 Secret（可选） */
  dingtalkSecret?: string;

  // 飞书机器人
  feishuEnabled: boolean;
  feishuWebhook?: string;

  // Telegram Bot
  telegramEnabled: boolean;
  telegramBotToken?: string;
  telegramChatId?: string;
}

export interface AppSettings {
  ai: AIConfig;
  notification: NotificationConfig;
}

export interface ProductInfo {
  title: string;
  price: string;
  description: string;
}

export interface ProductKnowledgeItem {
  itemId: string;
  title: string;
  price: string;
  imageUrl?: string;
  /** 卖家设置的底价（AI 砍价时不低于此价） */
  bottomPrice: string;
  /** 卖家补充说明（卖点、包邮、瑕疵等） */
  extraNote: string;
}

export interface BuyerMessage {
  id: string;
  buyerName: string;
  content: string;
  timestamp: number;
  conversationId: string;
  buyerUserId?: string;
  conversationIdType?: 'real' | 'derived';
  participants?: string[];
  itemId?: string;
  productTitle?: string;
  productInfo?: ProductInfo;
}

export interface OrderEvent {
  id: string;
  buyerName: string;
  productTitle: string;
  amount?: string;
  timestamp: number;
  orderId?: string;
}

export interface MtopRequestPayload {
  api: string;
  version: string;
  data: Record<string, unknown>;
}

export type RuntimeMessage =
  | {
      type: 'PING';
    }
  | {
      type: 'DIAG';
    }
  | {
      type: 'BUYER_MESSAGE';
      payload: BuyerMessage;
    }
  | {
      type: 'ORDER_CREATED';
      payload: OrderEvent;
    }
  | {
      type: 'TOGGLE_AUTO_REPLY';
      payload: { enabled: boolean };
    }
  | {
      type: 'INJECT_REPLY';
      payload: { conversationId: string; content: string };
    }
  | {
      type: 'MTOP_REQUEST';
      payload: MtopRequestPayload;
    }
  | {
      type: 'SCRAPE_UNREAD';
    }
  | {
      type: 'SEND_REPLY';
      payload: { conversationId: string; content: string; buyerUserId?: string; participants?: string[] };
    }
  | {
      type: 'WS_STATUS';
    }
  | {
      type: 'MTOP_BRIDGE_STATUS';
    }
  | {
      type: 'CHECK_LOGIN';
    }
  | {
      type: 'FETCH_PRODUCT_INFO';
      payload: { itemId: string };
    }
  | {
      type: 'FETCH_MY_PRODUCTS';
    }
  | {
      type: 'RELEASE_REPLY';
      payload: { logId: string };
    };

export interface PopupStats {
  running: boolean;
  processedMessages: number;
  todayOrders: number;
}

export const DEFAULT_SETTINGS: AppSettings = {
  ai: {
    provider: 'deepseek',
    apiKey: '',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    systemPrompt:
      '你是闲鱼平台的智能客服助手，请用礼貌、简洁、友好的中文回复买家问题。',
    directSendAuthorized: false,
    autoReplyEnabled: false,
    reviewModeEnabled: false,
    temperature: 0.7,
    maxTokens: 800,
    knowledgeBase: '',
  },
  notification: {
    browserEnabled: true,
    smsEnabled: false,
    smsProvider: 'aliyun',
    dingtalkEnabled: false,
    feishuEnabled: false,
    telegramEnabled: false,
  },
};
