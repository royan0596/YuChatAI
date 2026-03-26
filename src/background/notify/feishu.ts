/**
 * 飞书机器人通知
 * 支持自定义机器人 Webhook（卡片消息格式）
 */
import type { NotificationConfig, OrderEvent } from '../../shared/types';

function buildCardMessage(order: OrderEvent): object {
  const fields: { is_short: boolean; text: { tag: string; content: string } }[] = [
    {
      is_short: true,
      text: { tag: 'lark_md', content: `**商品**\n${order.productTitle}` },
    },
    {
      is_short: true,
      text: { tag: 'lark_md', content: `**买家**\n${order.buyerName}` },
    },
  ];

  if (order.amount) {
    fields.push({
      is_short: true,
      text: { tag: 'lark_md', content: `**金额**\n¥${order.amount}` },
    });
  }

  if (order.orderId) {
    fields.push({
      is_short: true,
      text: { tag: 'lark_md', content: `**订单号**\n${order.orderId}` },
    });
  }

  fields.push({
    is_short: false,
    text: {
      tag: 'lark_md',
      content: `**时间**\n${new Date(order.timestamp).toLocaleString('zh-CN')}`,
    },
  });

  return {
    msg_type: 'interactive',
    card: {
      header: {
        title: {
          tag: 'plain_text',
          content: '🐟 闲鱼新订单提醒',
        },
        template: 'orange',
      },
      elements: [
        {
          tag: 'div',
          fields,
        },
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '查看订单' },
              type: 'primary',
              url: 'https://www.goofish.com/order',
            },
          ],
        },
      ],
    },
  };
}

export async function sendFeishuNotification(
  order: OrderEvent,
  config: NotificationConfig
): Promise<void> {
  if (!config.feishuEnabled || !config.feishuWebhook) {
    return;
  }

  const response = await fetch(config.feishuWebhook, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(buildCardMessage(order)),
  });

  if (!response.ok) {
    throw new Error(`飞书通知发送失败: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as { code?: number; msg?: string };
  if (data.code !== 0) {
    throw new Error(`飞书通知返回错误: code=${data.code} msg=${data.msg}`);
  }
}
