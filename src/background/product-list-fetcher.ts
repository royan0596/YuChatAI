/**
 * 卖家在售商品列表获取模块
 *
 * 调用闲鱼 mtop API 获取当前登录用户的在售商品列表。
 * API: mtop.idle.web.xyh.item.list
 * 必需参数: { pageNumber, pageSize, userId }
 * 返回结构: data.cardList[].cardData.{ id, title, priceInfo.price, picInfo.picUrl, itemStatus }
 * itemStatus: 0=在售, 1=已卖出
 */

import { callMtopApi } from './product-fetcher';
import { findAnyGoofishTab } from './im-tab-manager';
import type { ProductKnowledgeItem } from '../shared/types';
import { getProductKnowledge } from '../shared/storage';

const API_NAME = 'mtop.idle.web.xyh.item.list';
const API_VERSION = '1.0';

interface CardData {
  id?: string;
  title?: string;
  priceInfo?: { price?: string; preText?: string };
  picInfo?: { picUrl?: string; width?: number; height?: number };
  itemStatus?: number;
  categoryId?: string;
  [key: string]: unknown;
}

interface CardItem {
  cardType?: number;
  cardData?: CardData;
}

interface ItemListResponse {
  cardList?: CardItem[];
  totalCount?: number;
  [key: string]: unknown;
}

/**
 * 从闲鱼页面 cookie 获取当前登录用户的 userId (unb)
 */
async function getUserId(): Promise<string | null> {
  const tabId = await findAnyGoofishTab();
  if (!tabId) {
    console.log('[ProductList] 找不到闲鱼标签页');
    return null;
  }

  try {
    const resp = await chrome.tabs.sendMessage(tabId, {
      type: 'GET_COOKIE',
      payload: { name: 'unb' },
    }) as string | null | undefined;

    if (resp) return resp;
  } catch {
    // content script 可能未实现 GET_COOKIE，用 chrome.cookies 降级
  }

  // 降级：通过 chrome.cookies API 获取
  try {
    const cookie = await chrome.cookies.get({
      url: 'https://www.goofish.com',
      name: 'unb',
    });
    return cookie?.value ?? null;
  } catch {
    console.log('[ProductList] 无法获取 userId');
    return null;
  }
}

/**
 * 将 API 返回的卡片数据转为 ProductKnowledgeItem（合并已有用户笔记）
 */
function cardToKnowledgeItem(
  card: CardItem,
  existingMap: Map<string, ProductKnowledgeItem>,
): ProductKnowledgeItem | null {
  const cd = card.cardData;
  if (!cd || !cd.id || !cd.title) return null;

  const itemId = String(cd.id);
  const title = String(cd.title);
  const price = cd.priceInfo?.price ? String(cd.priceInfo.price) : '';
  const imageUrl = cd.picInfo?.picUrl ? String(cd.picInfo.picUrl) : undefined;

  // 合并已有的用户笔记
  const existing = existingMap.get(itemId);

  return {
    itemId,
    title,
    price,
    imageUrl,
    bottomPrice: existing?.bottomPrice ?? '',
    extraNote: existing?.extraNote ?? '',
  };
}

/**
 * 获取卖家在售商品列表
 *
 * 返回合并了已有用户笔记的商品列表。
 * 如果获取失败，返回 null。
 */
export interface FetchResult {
  items: ProductKnowledgeItem[] | null;
  error?: string;
}

export async function fetchMyProducts(): Promise<FetchResult> {
  // 1. 获取 userId
  const userId = await getUserId();
  if (!userId) {
    const msg = '无法获取用户ID(unb cookie)，请确保已登录闲鱼';
    console.log('[ProductList]', msg);
    return { items: null, error: msg };
  }

  console.log('[ProductList] 调用 API:', API_NAME, 'userId:', userId.slice(0, 4) + '***');

  // 2. 调用 API
  const result = await callMtopApi(API_NAME, API_VERSION, {
    pageNumber: 1,
    pageSize: 20,
    userId,
  });

  if (!result) {
    const msg = 'mtop API 调用失败(callMtopApi 返回 null)，请确保已打开闲鱼页面';
    console.log('[ProductList]', msg);
    return { items: null, error: msg };
  }

  // 检查 ret 状态
  const ret = result['ret'] as string[] | undefined;
  console.log('[ProductList] API ret:', ret, 'keys:', Object.keys(result));

  const data = result['data'] as ItemListResponse | undefined;
  if (!data) {
    const msg = '返回无 data 字段, ret: ' + JSON.stringify(ret) + ', keys: ' + Object.keys(result).join(',');
    console.log('[ProductList]', msg);
    return { items: null, error: msg };
  }

  const cardList = data.cardList;
  if (!Array.isArray(cardList) || cardList.length === 0) {
    const msg = 'cardList 为空, data keys: ' + Object.keys(data).join(',') + ', ret: ' + JSON.stringify(ret);
    console.log('[ProductList]', msg);
    return { items: null, error: msg };
  }

  console.log('[ProductList] 获取到', cardList.length, '张卡片, totalCount:', data.totalCount);

  // 3. 加载已有用户笔记
  const existing = await getProductKnowledge();
  const existingMap = new Map(existing.map(p => [p.itemId, p]));

  // 4. 转换并过滤（只保留在售商品 itemStatus=0，加上所有有笔记的已下架商品）
  const items: ProductKnowledgeItem[] = [];
  for (const card of cardList) {
    const status = card.cardData?.itemStatus;
    const item = cardToKnowledgeItem(card, existingMap);
    if (!item) continue;

    // 在售商品始终包含
    if (status === 0) {
      items.push(item);
    }
    // 已下架但有用户笔记的也保留
    else if (existingMap.has(item.itemId)) {
      items.push(item);
    }
  }

  console.log('[ProductList] 最终返回', items.length, '个商品（含在售+有笔记的已下架）');
  return { items };
}
