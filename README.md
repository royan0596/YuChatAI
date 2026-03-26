# YuChatAI

闲鱼智能客服助手 Chrome 扩展。

## 功能概览

- 监听闲鱼买家咨询消息
- 调用用户自行配置的 AI 服务生成回复
- 仅在用户明确授权后自动直发 AI 回复
- 订单通知支持浏览器、钉钉、飞书、Telegram、短信
- 支持商品知识库和商品专属配置
- 支持侧边栏查看最近消息和运行状态

## 当前合规设计

- 默认不开启自动直发
- 用户需要在设置页手动勾选授权后，系统才会自动发送 AI 回复
- AI API Key、知识库、消息日志仅保存在浏览器本地存储
- 不设独立开发者服务器，不会把数据上传到开发者自有后端

## 本地开发

```bash
npm install
npm run build
```

构建完成后，加载 `dist/` 目录作为 Chrome 扩展。

## 目录说明

- `src/background/`: 后台 service worker 与消息处理逻辑
- `src/content/`: 页面注入与消息桥接逻辑
- `src/options/`: 设置页
- `src/sidepanel/`: 侧边栏
- `public/privacy.html`: 隐私政策源文件
- `docs/privacy.html`: GitHub Pages 用隐私政策页面

## 隐私政策

如果已启用 GitHub Pages，隐私政策可公开访问于：

- `https://royan0596.github.io/YuChatAI/privacy.html`

如果你尚未启用 GitHub Pages，请在仓库设置中选择：

- `Settings`
- `Pages`
- `Deploy from a branch`
- `main`
- `/docs`

## 联系方式

- GitHub: [https://github.com/royan0596/YuChatAI](https://github.com/royan0596/YuChatAI)
- Telegram: [@Global_Acc_Hub](https://t.me/Global_Acc_Hub)

## Chrome Web Store 提交提醒

这类扩展涉及：

- 网站消息内容
- Cookie / 登录状态
- 第三方 AI 服务调用
- 第三方通知通道

提交到 Chrome Web Store 前，请务必同步填写：

- Privacy practices
- 数据使用披露
- 支持联系方式
- 隐私政策 URL

建议使用仓库中的 [CWS_SUBMISSION.md](C:\Users\yan\xianyu\CWS_SUBMISSION.md) 作为提交草稿。
