/**
 * Telegram Bot 通知
 * 使用 Bot API sendMessage 接口
 * 需要：Bot Token（@BotFather 申请）+ Chat ID（用户/群组 ID）
 */
import type { NotificationConfig, OrderEvent } from '../../shared/types';

const TELEGRAM_API_BASE = 'https://api.telegram.org';

function buildMessage(order: OrderEvent): string {
  const lines = [
    '🐟 *闲鱼新订单提醒*',
    '',
    `📦 *商品：* ${escapeMarkdown(order.productTitle)}`,
    `👤 *买家：* ${escapeMarkdown(order.buyerName)}`,
  ];

  if (order.amount) {
    lines.push(`💰 *金额：* ¥${escapeMarkdown(order.amount)}`);
  }
  if (order.orderId) {
    lines.push(`🔖 *订单号：* ${escapeMarkdown(order.orderId)}`);
  }

  lines.push(`🕐 *时间：* ${escapeMarkdown(new Date(order.timestamp).toLocaleString('zh-CN'))}`);
  lines.push('');
  lines.push('[查看订单](https://www.goofish.com/order)');

  return lines.join('\n');
}

/** 转义 Telegram MarkdownV2 特殊字符 */
function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (c) => `\\${c}`);
}

export async function sendTelegramNotification(
  order: OrderEvent,
  config: NotificationConfig
): Promise<void> {
  if (!config.telegramEnabled || !config.telegramBotToken || !config.telegramChatId) {
    return;
  }

  const url = `${TELEGRAM_API_BASE}/bot${config.telegramBotToken}/sendMessage`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      chat_id: config.telegramChatId,
      text: buildMessage(order),
      parse_mode: 'MarkdownV2',
      disable_web_page_preview: false,
    }),
  });

  if (!response.ok) {
    throw new Error(`Telegram 通知发送失败: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as { ok: boolean; description?: string };
  if (!data.ok) {
    throw new Error(`Telegram API 返回错误: ${data.description ?? '未知错误'}`);
  }
}
