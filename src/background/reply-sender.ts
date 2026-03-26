import { getImTab, findTabWithWs } from './im-tab-manager';
import { sendReplyViaBackgroundWs } from './ws-client';

export interface SendReplyResult {
  success: boolean;
  via: 'background-ws' | 'page-ws' | 'dom' | 'none';
  usedConversationId?: string;
  detail?: string;
}

async function trySendViaWs(
  conversationId: string,
  content: string,
  buyerUserId?: string,
  participants?: string[],
): Promise<SendReplyResult> {
  if (conversationId.startsWith('dom-')) {
    return { success: false, via: 'none', detail: 'invalid_conversation_id' };
  }

  try {
    let tabId = await findTabWithWs();

    if (tabId) {
      console.info('[ReplySender] 使用已有 WS 标签页:', tabId);
    } else {
      console.info('[ReplySender] 无已有 WS 标签页，尝试获取 /im 标签页...');
      tabId = await getImTab(true);
    }

    if (!tabId) {
      console.log('[ReplySender] 无法获得任何可用的 WS 标签页');
      return { success: false, via: 'page-ws', detail: 'no_ws_tab' };
    }

    const response = (await chrome.tabs.sendMessage(tabId, {
      type: 'SEND_REPLY',
      payload: { conversationId, content, buyerUserId, participants },
    })) as { success?: boolean; error?: string } | undefined;

    if (response?.success) {
      console.info('[ReplySender] 页面 WS 发送成功:', conversationId);
      return { success: true, via: 'page-ws', usedConversationId: conversationId };
    }

    console.log('[ReplySender] 页面 WS 发送失败:', response?.error);
    return { success: false, via: 'page-ws', detail: response?.error ?? 'send_failed' };
  } catch (err) {
    console.error('[ReplySender] 页面 WS 桥接异常:', err);
    return { success: false, via: 'page-ws', detail: String(err) };
  }
}

async function trySendViaDom(conversationId: string, content: string): Promise<SendReplyResult> {
  try {
    const tabs = await chrome.tabs.query({
      url: ['https://*.goofish.com/im*'],
    });

    for (const tab of tabs) {
      if (!tab.id) continue;

      try {
        const response = (await chrome.tabs.sendMessage(tab.id, {
          type: 'INJECT_REPLY',
          payload: { conversationId, content },
        })) as { success?: boolean; error?: string } | undefined;

        if (response?.success) {
          console.info('[ReplySender] DOM 回退发送成功 tabId:', tab.id);
          return { success: true, via: 'dom', usedConversationId: conversationId };
        }

        console.log('[ReplySender] DOM 回退发送失败 tabId:', tab.id, 'error:', response?.error);
      } catch {
        continue;
      }
    }

    console.log('[ReplySender] 未找到可成功执行 DOM 回退的 /im 标签页');
    return { success: false, via: 'dom', detail: 'no_im_tab' };
  } catch (err) {
    console.error('[ReplySender] DOM 注入失败:', err);
    return { success: false, via: 'dom', detail: String(err) };
  }
}

export async function sendReplyViaAPI(
  conversationId: string,
  content: string,
  buyerUserId?: string,
  participants?: string[],
): Promise<SendReplyResult> {
  if (conversationId.startsWith('dom-')) {
    return { success: false, via: 'none', detail: 'invalid_conversation_id' };
  }

  const backgroundResult = await sendReplyViaBackgroundWs(conversationId, content, buyerUserId, participants);
  if (backgroundResult.success) {
    return {
      success: true,
      via: 'background-ws',
      usedConversationId: backgroundResult.usedConversationId ?? conversationId,
      detail: backgroundResult.reason,
    };
  }

  const wsResult = await trySendViaWs(conversationId, content, buyerUserId, participants);
  if (wsResult.success) return wsResult;

  console.info('[ReplySender] WS 发送失败，尝试 DOM 注入回退');
  const domResult = await trySendViaDom(conversationId, content);
  if (domResult.success) return domResult;

  return {
    success: false,
    via: 'none',
    usedConversationId:
      backgroundResult.usedConversationId ?? wsResult.usedConversationId ?? conversationId,
    detail: domResult.detail ?? wsResult.detail ?? backgroundResult.reason,
  };
}
