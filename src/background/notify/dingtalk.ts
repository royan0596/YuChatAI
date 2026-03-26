/**
 * 钉钉机器人通知
 * 支持自定义机器人 Webhook，可选加签 Secret
 */
import type { NotificationConfig, OrderEvent } from '../../shared/types';

async function signDingtalk(secret: string): Promise<{ timestamp: string; sign: string }> {
  const timestamp = Date.now().toString();
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    {
      name: 'HMAC',
      hash: 'SHA-256',
    },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}\n${secret}`));
  const bytes = new Uint8Array(signature);
  const binary = Array.from(bytes)
    .map((b) => String.fromCharCode(b))
    .join('');

  return {
    timestamp,
    sign: encodeURIComponent(btoa(binary)),
  };
}

function buildMessage(order: OrderEvent): string {
  return [
    '🐟 闲鱼新订单提醒',
    `商品：${order.productTitle}`,
    `买家：${order.buyerName}`,
    order.amount ? `金额：¥${order.amount}` : '',
    order.orderId ? `订单号：${order.orderId}` : '',
    `时间：${new Date(order.timestamp).toLocaleString('zh-CN')}`,
  ]
    .filter(Boolean)
    .join('\n');
}

export async function sendDingtalkNotification(
  order: OrderEvent,
  config: NotificationConfig
): Promise<void> {
  if (!config.dingtalkEnabled || !config.dingtalkWebhook) {
    return;
  }

  let webhook = config.dingtalkWebhook;

  if (config.dingtalkSecret) {
    const { timestamp, sign } = await signDingtalk(config.dingtalkSecret);
    const separator = webhook.includes('?') ? '&' : '?';
    webhook = `${webhook}${separator}timestamp=${timestamp}&sign=${sign}`;
  }

  const response = await fetch(webhook, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      msgtype: 'text',
      text: {
        content: buildMessage(order),
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`DingTalk 通知发送失败: ${response.status} ${response.statusText}`);
  }
}
