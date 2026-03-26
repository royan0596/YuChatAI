/**
 * 浏览器桌面通知
 * 使用 Chrome Notifications API
 */
import type { OrderEvent } from '../../shared/types';

export async function sendBrowserNotification(order: OrderEvent): Promise<void> {
  const notificationId = `order-${order.id}-${Date.now()}`;

  chrome.notifications.create(notificationId, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('assets/icon-128.png'),
    title: '🐟 闲鱼新订单提醒！',
    message: `商品：${order.productTitle}\n买家：${order.buyerName}${order.amount ? `\n金额：¥${order.amount}` : ''}`,
    priority: 2,
    buttons: [
      { title: '查看订单' },
      { title: '标记已处理' },
    ],
  });

  // 点击通知按钮的处理
  chrome.notifications.onButtonClicked.addListener((id, buttonIndex) => {
    if (id !== notificationId) return;
    if (buttonIndex === 0) {
      // 打开闲鱼订单页
      chrome.tabs.create({ url: 'https://www.goofish.com/order' });
    }
    chrome.notifications.clear(id);
  });
}
