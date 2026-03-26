/**
 * 商品详情获取模块
 *
 * 通过 mtop API 查询闲鱼商品的标题、价格、描述等信息，
 * 并缓存结果避免重复请求。
 */

import type { ProductInfo } from '../shared/types';
import { findAnyGoofishTab } from './im-tab-manager';

// ── 缓存（itemId → ProductInfo），最多缓存 200 条 ──────────────────────
const productCache = new Map<string, ProductInfo>();
const CACHE_MAX = 200;

/**
 * 通过 content script 的 mtop bridge 调用闲鱼 API
 */
export async function callMtopApi(
  api: string,
  version: string,
  data: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const tabId = await findAnyGoofishTab();
  if (!tabId) {
    console.log('[ProductFetcher] 找不到闲鱼标签页');
    return null;
  }

  try {
    const response = (await chrome.tabs.sendMessage(tabId, {
      type: 'MTOP_REQUEST',
      payload: { api, version, data },
    })) as { success?: boolean; data?: Record<string, unknown> | null } | undefined;

    if (!response?.success || !response.data) {
      console.log('[ProductFetcher] mtop 请求失败:', api);
      return null;
    }
    return response.data;
  } catch (err) {
    console.log('[ProductFetcher] mtop 调用异常:', err);
    return null;
  }
}

/**
 * 从 API 返回数据中提取商品信息
 */
function extractProductInfo(result: Record<string, unknown>): ProductInfo | null {
  // mtop.taobao.idle.pc.detail 返回格式：
  // { data: { pcDescContent, itemDO: { title, ... }, priceDTO: { price, ... }, ... } }
  const data = result['data'] as Record<string, unknown> | undefined;
  if (!data) return null;

  // 尝试多种 API 返回结构
  const itemDO = data['itemDO'] as Record<string, unknown> | undefined;
  const priceDTO = data['priceDTO'] as Record<string, unknown> | undefined;

  // 标题
  const title = String(
    itemDO?.['title'] ??
    data['title'] ??
    ''
  );

  // 价格
  const price = String(
    priceDTO?.['price'] ??
    itemDO?.['price'] ??
    data['price'] ??
    ''
  );

  // 描述
  const desc = String(
    data['pcDescContent'] ??
    data['desc'] ??
    itemDO?.['desc'] ??
    ''
  );

  // 至少要有标题
  if (!title) return null;

  return {
    title,
    price,
    description: desc.replace(/<[^>]+>/g, '').slice(0, 500), // 去除 HTML 标签，截断
  };
}

/**
 * 获取商品详情（带缓存）
 */
export async function fetchProductInfo(itemId: string): Promise<ProductInfo | null> {
  if (!itemId) return null;

  // 先查缓存
  const cached = productCache.get(itemId);
  if (cached) {
    console.log('[ProductFetcher] 缓存命中:', itemId, cached.title);
    return cached;
  }

  console.log('[ProductFetcher] 查询商品详情:', itemId);

  // 尝试 API 1: mtop.taobao.idle.pc.detail
  let result = await callMtopApi('mtop.taobao.idle.pc.detail', '1.0', {
    itemId,
  });

  let info = result ? extractProductInfo(result) : null;

  // 尝试 API 2: mtop.taobao.idlefish.item.detail.simple
  if (!info) {
    result = await callMtopApi('mtop.taobao.idlefish.item.detail.simple', '1.0', {
      itemId,
    });
    info = result ? extractProductInfo(result) : null;
  }

  if (info) {
    // 存入缓存
    if (productCache.size >= CACHE_MAX) {
      // 删除最早的条目
      const firstKey = productCache.keys().next().value;
      if (firstKey) productCache.delete(firstKey);
    }
    productCache.set(itemId, info);
    console.log('[ProductFetcher] 商品详情获取成功:', info.title, '¥' + info.price);
  } else {
    console.log('[ProductFetcher] 商品详情获取失败, itemId:', itemId);
  }

  return info;
}
