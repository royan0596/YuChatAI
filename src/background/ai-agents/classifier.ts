/**
 * 意图分类 Agent
 *
 * 对买家消息进行意图分类，决定路由到哪个专家 Agent。
 * 参考 XianyuAutoAgent 的 ClassifyAgent。
 */

import type { AIConfig } from '../../shared/types';
import { CLASSIFY_PROMPT } from './prompts';

export type Intent = 'no_reply' | 'price' | 'tech' | 'general';

/**
 * 快速关键词分类（不调用 AI，节省 token）
 * 能命中则直接返回，否则返回 null 交给 AI 分类
 */
function quickClassify(message: string): Intent | null {
  const msg = message.trim();

  // 纯表情或极短消息 → 不回复
  if (msg.length <= 2 && /^[\p{Emoji}\s]+$/u.test(msg)) return 'no_reply';

  // 结束语
  const noReplyPatterns = /^(好的?|嗯+|哦+|谢谢|感谢|不用了|算了|行|ok|OK|收到|明白了?)$/;
  if (noReplyPatterns.test(msg)) return 'no_reply';

  // 砍价关键词
  const priceKeywords = ['便宜', '少一点', '打折', '优惠', '最低', '包邮', '能不能',
    '降价', '再少', '多少钱', '什么价', '几折', '能便宜', '太贵', '贵了'];
  if (priceKeywords.some(k => msg.includes(k))) return 'price';

  // 技术/商品咨询关键词
  const techKeywords = ['发货', '快递', '物流', '邮寄', '尺寸', '大小', '颜色',
    '型号', '配置', '成色', '瑕疵', '保修', '退换', '退货', '几成新',
    '能用', '兼容', '配件', '充电', '电池', '屏幕', '内存'];
  if (techKeywords.some(k => msg.includes(k))) return 'tech';

  return null; // 需要 AI 分类
}

/**
 * 通过 AI 进行意图分类
 */
async function aiClassify(
  message: string,
  context: string,
  config: AIConfig,
): Promise<Intent> {
  const baseUrl = config.baseUrl.replace(/\/$/, '');
  const endpoint = `${baseUrl}/v1/chat/completions`;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: 'system', content: CLASSIFY_PROMPT },
          {
            role: 'user',
            content: context
              ? `对话历史：\n${context}\n\n最新消息：${message}`
              : `买家消息：${message}`,
          },
        ],
        temperature: 0.1, // 分类任务用低温度
        max_tokens: 20,
      }),
    });

    if (!response.ok) {
      console.warn('[Classifier] AI 分类请求失败:', response.status);
      return 'general';
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
    };
    const result = (data.choices[0]?.message?.content ?? '').trim().toLowerCase();

    // 解析返回的分类标签
    if (result.includes('no_reply')) return 'no_reply';
    if (result.includes('price')) return 'price';
    if (result.includes('tech')) return 'tech';
    return 'general';
  } catch (err) {
    console.error('[Classifier] AI 分类异常:', err);
    return 'general'; // 出错时默认走通用 Agent
  }
}

/**
 * 对买家消息进行意图分类
 *
 * 优先用关键词快速匹配，匹配不到再调用 AI
 */
export async function classifyIntent(
  message: string,
  context: string,
  config: AIConfig,
): Promise<Intent> {
  // 1. 快速关键词分类
  const quick = quickClassify(message);
  if (quick) {
    console.info('[Classifier] 快速分类:', quick, '消息:', message.slice(0, 30));
    return quick;
  }

  // 2. AI 分类
  const intent = await aiClassify(message, context, config);
  console.info('[Classifier] AI 分类:', intent, '消息:', message.slice(0, 30));
  return intent;
}
