# YuChatAI

YuChatAI 是一个面向闲鱼卖家的 Chrome 扩展，用于处理买家咨询、生成 AI 回复和接收订单通知。

## 功能概览

- 监听闲鱼买家咨询消息
- 调用用户自行配置的 AI 服务生成回复
- 在用户明确授权后自动直发 AI 回复
- 未授权自动直发时保留待发送消息，并支持手动放行
- 支持浏览器、钉钉、飞书、Telegram、短信等订单通知
- 支持商品知识库和商品专属配置
- 支持侧边栏查看最近消息和运行状态

## 合规设计

- 自动直发默认关闭
- 只有在用户明确授权后才会自动发送 AI 回复
- 用户消息不会上传到开发者自建服务器
- AI API Key、知识库、消息日志保存在浏览器本地
- 买家消息仅发送到用户自行配置的第三方 AI 服务

## 本地开发

```bash
npm install
npm run build
```

构建完成后，将 `dist/` 目录作为 Chrome 扩展加载。

## 目录说明

- `src/background/`: 后台 service worker 与消息处理逻辑
- `src/content/`: 页面注入与消息桥接逻辑
- `src/options/`: 设置页
- `src/sidepanel/`: 侧边栏
- `public/privacy.html`: 扩展内隐私政策页面
- `docs/privacy.html`: GitHub Pages 隐私政策页面
- `CWS_SUBMISSION.md`: Chrome Web Store 提交文案草稿
- `CWS_PERMISSIONS_REVIEW.md`: 权限与 host 权限审查说明
- `CWS_CHECKLIST.md`: 上架前最终检查清单

## 隐私政策

启用 GitHub Pages 后，可公开访问：

- `https://royan0596.github.io/YuChatAI/privacy.html`

## 联系方式

- GitHub: [https://github.com/royan0596/YuChatAI](https://github.com/royan0596/YuChatAI)
- Telegram: [@Global_Acc_Hub](https://t.me/Global_Acc_Hub)
