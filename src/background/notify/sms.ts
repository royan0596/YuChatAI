/**
 * 短信通知模块
 * 当前为骨架实现，后续补充阿里云/腾讯云签名算法与请求格式
 */
import type { NotificationConfig, OrderEvent } from '../../shared/types';

export async function sendSmsNotification(
  order: OrderEvent,
  config: NotificationConfig
): Promise<void> {
  if (!config.smsEnabled || !config.smsPhone) {
    return;
  }

  const message = `闲鱼新订单：${order.productTitle}，买家 ${order.buyerName}${
    order.amount ? `，金额 ¥${order.amount}` : ''
  }`;

  switch (config.smsProvider) {
    case 'aliyun':
      console.info('[SMS][Aliyun] 待实现', {
        phone: config.smsPhone,
        signName: config.smsSignName,
        templateCode: config.smsTemplateCode,
        message,
      });
      return;

    case 'tencent':
      console.info('[SMS][Tencent] 待实现', {
        phone: config.smsPhone,
        signName: config.smsSignName,
        templateCode: config.smsTemplateCode,
        message,
      });
      return;

    default:
      return;
  }
}
