console.log('%c[闲鱼助手] content-injected.js 已加载', 'color: #00ff00; font-weight: bold; font-size: 14px;', location.href);

import { decodeSyncData } from './msgpack';

// 将 MessagePack 解码函数挂载到 window，供 ws-connector 使用
(window as any).__xianyuDecodeSyncData = decodeSyncData;

import './mtop-bridge';
import './ws-connector';
