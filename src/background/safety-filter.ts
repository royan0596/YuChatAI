/**
 * 安全过滤器
 *
 * 参考 XianyuAutoAgent 的安全过滤机制：
 * 屏蔽 AI 回复中可能包含的引流/违规关键词，
 * 防止因 AI 幻觉导致账号违规。
 */

// 违规关键词列表（不区分大小写匹配）
const BLOCKED_KEYWORDS = [
  // 站外引流
  '微信', 'wx', 'weixin', 'wechat',
  'QQ', 'qq号',
  '加我', '私聊我', '私信我',
  // 支付绕过
  '支付宝', 'alipay', '转账',
  '银行卡', '银行账', '汇款',
  '线下交易', '线下付款',
  // 其他违规
  '假货', '高仿', 'A货',
];

// 替换后的安全提示
const SAFE_REPLACEMENT = '（请通过闲鱼平台沟通交易，保障双方权益哦~）';

/**
 * 检查文本是否包含违规关键词
 */
export function containsBlockedKeywords(text: string): string[] {
  const lower = text.toLowerCase();
  return BLOCKED_KEYWORDS.filter(keyword => lower.includes(keyword.toLowerCase()));
}

/**
 * 过滤 AI 回复中的违规内容
 *
 * @returns 过滤后的文本，如果检测到违规关键词则替换整句
 */
export function filterReply(reply: string): string {
  const blocked = containsBlockedKeywords(reply);
  if (blocked.length === 0) return reply;

  console.warn('[SafetyFilter] 检测到违规关键词:', blocked, '原文:', reply.slice(0, 100));

  // 逐句检查，只替换包含违规词的句子
  const sentences = reply.split(/([。！？.!?\n])/);
  const filtered: string[] = [];

  for (let i = 0; i < sentences.length; i++) {
    const sentence = sentences[i];
    if (containsBlockedKeywords(sentence).length > 0) {
      // 跳过违规句子及其标点
      if (i + 1 < sentences.length && /^[。！？.!?\n]$/.test(sentences[i + 1])) {
        i++; // 跳过紧跟的标点
      }
    } else {
      filtered.push(sentence);
    }
  }

  const result = filtered.join('').trim();

  // 如果过滤后内容太少（全是违规内容），返回安全提示
  if (result.length < 5) {
    return SAFE_REPLACEMENT;
  }

  return result;
}

/**
 * 人性化延迟计算（模拟打字速度）
 * 参考 XianyuAutoAgent：base delay + per-char delay，max 10s
 *
 * @returns 延迟毫秒数
 */
export function calcTypingDelay(replyText: string): number {
  const baseDelay = Math.random() * 1000; // 0-1s 基础延迟
  const perCharDelay = replyText.length * (100 + Math.random() * 200); // 每字 100-300ms
  const total = baseDelay + perCharDelay;
  return Math.min(total, 10_000); // 最大 10 秒
}
