import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.deepseek.chatter',
  appName: 'DeepSeek',
  webDir: 'dist',
  android: {
    // 允许 WebView 加载 http:// 地址的自定义服务商接口
    allowMixedContent: true,
  },
};

export default config;
