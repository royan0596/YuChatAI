/**
 * 多 Agent AI 系统入口
 *
 * 参考 XianyuAutoAgent 的多 Agent 架构：
 * 1. ClassifyAgent 意图分类
 * 2. 路由到专家 Agent（PriceAgent / TechAgent / DefaultAgent）
 * 3. 安全过滤
 *
 * 替代原来的 ai-client.ts 单一 callAI 函数
 */

import type { AIConfig, BuyerMessage, ProductInfo, ProductKnowledgeItem } from '../../shared/types';
import { getProductKnowledge } from '../../shared/storage';
import { classifyIntent, type Intent } from './classifier';
import { PRICE_PROMPT, TECH_PROMPT, DEFAULT_PROMPT } from './prompts';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OpenAIResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
}

// ── 上下文管理 ────────────────────────────────────────────────────────
const MAX_CONTEXT = 10;
const contextMap = new Map<string, ChatMessage[]>();

// ── 砍价计数（温度随次数递增）─────────────────────────────────────────
const bargainCountMap = new Map<string, number>();

// ── 商品知识缓存 ─────────────────────────────────────────────────────
let productKnowledgeCache: ProductKnowledgeItem[] | null = null;

// 监听 storage 变化，自动刷新缓存
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes['xianyu-product-knowledge']) {
      productKnowledgeCache = null; // 清除缓存，下次使用时重新加载
    }
  });
} catch {
  // 非扩展环境下忽略
}

async function loadProductKnowledge(): Promise<ProductKnowledgeItem[]> {
  if (productKnowledgeCache) return productKnowledgeCache;
  productKnowledgeCache = await getProductKnowledge();
  return productKnowledgeCache;
}

/**
 * Agent 配置：每种意图对应不同的 system prompt 和温度
 *
 * 权限规则：
 * - price / tech agent 使用内置提示词，不受用户 systemPrompt 影响
 * - general agent 使用用户的 systemPrompt（如果有的话）
 */
function getAgentConfig(intent: Intent, conversationId: string, userPrompt: string): {
  systemPrompt: string;
  temperature: number;
} {
  switch (intent) {
    case 'price': {
      // 砍价次数递增 → 温度递增（回复更有变化性）
      const count = bargainCountMap.get(conversationId) ?? 0;
      bargainCountMap.set(conversationId, count + 1);
      const temp = Math.min(0.3 + count * 0.15, 0.9);
      return {
        systemPrompt: PRICE_PROMPT,
        temperature: temp,
      };
    }
    case 'tech':
      return {
        systemPrompt: TECH_PROMPT,
        temperature: 0.4,
      };
    case 'general':
    default:
      return {
        systemPrompt: userPrompt || DEFAULT_PROMPT,
        temperature: 0.7,
      };
  }
}

/**
 * 格式化对话历史为文本（用于分类器上下文）
 */
function formatContext(history: ChatMessage[]): string {
  return history
    .slice(-6) // 只取最近 6 条用于分类
    .map(m => `${m.role === 'user' ? '买家' : '卖家'}：${m.content}`)
    .join('\n');
}

/**
 * 调用 AI 生成回复
 */
async function callLLM(
  messages: ChatMessage[],
  config: AIConfig,
  temperature: number,
): Promise<string> {
  const baseUrl = config.baseUrl.replace(/\/$/, '');
  const endpoint = `${baseUrl}/v1/chat/completions`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      temperature,
      max_tokens: config.maxTokens,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`AI API 请求失败 ${response.status}: ${text}`);
  }

  const data = (await response.json()) as OpenAIResponse;
  return data.choices[0]?.message?.content ?? '';
}

export interface AgentResult {
  reply: string;
  intent: Intent;
}

/**
 * 多 Agent AI 入口（替代原 callAI）
 *
 * 流程：分类 → 路由 → 生成 → 返回
 * 如果分类为 no_reply，返回空字符串
 */
export async function callAgentAI(
  msg: BuyerMessage,
  config: AIConfig,
): Promise<AgentResult> {
  if (!config.apiKey) {
    throw new Error('AI API Key 未配置');
  }

  const history = contextMap.get(msg.conversationId) ?? [];
  const contextStr = formatContext(history);

  // 1. 意图分类
  const intent = await classifyIntent(msg.content, contextStr, config);

  // 不需要回复的消息
  if (intent === 'no_reply') {
    console.info('[AgentAI] 分类为 no_reply, 跳过回复:', msg.content.slice(0, 30));
    return { reply: '', intent };
  }

  // 2. 获取对应 Agent 配置
  const agentConfig = getAgentConfig(intent, msg.conversationId, config.systemPrompt);

  // 3. 加载商品知识库，匹配当前商品
  const knowledge = await loadProductKnowledge();
  const matchedProduct = msg.itemId
    ? knowledge.find(p => p.itemId === msg.itemId)
    : undefined;

  // 4. 构建消息
  const userMessage: ChatMessage = { role: 'user', content: msg.content };
  history.push(userMessage);
  const trimmed = history.slice(-MAX_CONTEXT);

  const systemPrompt = buildSystemPrompt(
    agentConfig.systemPrompt,
    intent,
    config.knowledgeBase,
    msg.productInfo,
    msg.productTitle,
    matchedProduct,
  );

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...trimmed,
  ];

  // 5. 调用 AI
  const reply = await callLLM(messages, config, agentConfig.temperature);

  // 6. 更新上下文
  if (reply) {
    trimmed.push({ role: 'assistant', content: reply });
    contextMap.set(msg.conversationId, trimmed.slice(-MAX_CONTEXT));
  }

  console.info('[AgentAI] 意图:', intent, '温度:', agentConfig.temperature, '回复:', reply.slice(0, 50));
  return { reply, intent };
}

function buildSystemPrompt(
  base: string,
  intent: Intent,
  knowledgeBase?: string,
  productInfo?: ProductInfo,
  productTitle?: string,
  matchedProduct?: ProductKnowledgeItem,
): string {
  let prompt = base;

  // 通用知识（所有 agent 都注入）
  if (knowledgeBase) {
    prompt += `\n\n【通用知识】\n${knowledgeBase}`;
  }

  // 商品基本信息（从 API 获取的标题、价格、描述）
  if (productInfo) {
    let section = `\n\n【当前咨询商品】\n商品标题：${productInfo.title}`;
    if (productInfo.price) {
      section += `\n商品价格：¥${productInfo.price}`;
    }
    if (productInfo.description) {
      section += `\n商品描述：${productInfo.description}`;
    }
    prompt += section;
  } else if (productTitle) {
    prompt += `\n\n【当前商品】${productTitle}`;
  }

  // 卖家对该商品的配置（底价 + 补充说明）
  if (matchedProduct) {
    let sellerSection = '\n\n【卖家对此商品的配置】';
    if (matchedProduct.bottomPrice) {
      sellerSection += `\n底价：¥${matchedProduct.bottomPrice}`;
      if (intent === 'price') {
        sellerSection += '（绝对不能低于此价格，这是卖家的最终底线）';
      }
    }
    if (matchedProduct.extraNote) {
      sellerSection += `\n卖家补充说明：${matchedProduct.extraNote}`;
    }
    prompt += sellerSection;
  }

  return prompt;
}
