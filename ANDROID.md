# Android 打包说明（安卓版）

DeepSeek 官方开源 chat-demo（[deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo)）的安卓打包版：用 Capacitor 将其静态网页包装为原生安卓 APK。

> 注意：本项目**不是** DeepSeek 官方出品，仅是对其 MIT 开源 demo 的打包封装。

## 功能

- 与官方 chat-demo 一致：多会话管理、流式回复、深度思考、联网搜索、Markdown/KaTeX/Mermaid、语音输入与朗读、深浅色主题、中英文界面
- 原生安卓壳：全屏 WebView、移动端布局、已内置麦克风权限请求（语音输入）

## 使用

1. 安装 APK（自行构建产物 `app-debug.apk`）
2. 首次打开 → 设置 → 填入你的 DeepSeek API key
3. API key 与聊天数据均存储在本机（localStorage / IndexedDB），不会上传到任何第三方

## 本地构建

环境要求：Node.js 22.12+、pnpm、JDK 21、Android SDK

```bash
pnpm install
pnpm build          # 生成 dist/
npx cap sync android
gradle -p android assembleDebug
```

产物：`android/app/build/outputs/apk/debug/app-debug.apk`

## License

上游 demo 为 MIT，本仓库沿用。
