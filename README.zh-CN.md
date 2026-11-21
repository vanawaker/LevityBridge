# LevityBridge

[English](./README.md) · [简体中文](./README.zh-CN.md)

**LevityBridge** 是 **Levity**（iPhone / iPad / iPhone Duo 远程伴侣 App）的官方开源桌面端桥接插件。

> Levity 与 LevityBridge 均为专为 Antigravity 打造的独立第三方伴侣工具，非 Google 官方产品。

## 核心特性

- **零第三方依赖**：纯 Node.js（`>= 20`）原生模块实现，安全可审计。
- **标准插件架构**：基于 Antigravity 官方 Sidecar 侧栏与生命周期 Hooks 接入，支持二维码一键配对与实时会话同步。
- **本地直连保护隐私**：所有聊天记录、附件与配对凭据仅在你的电脑与移动设备间通过局域网或 Tailscale 等私有网络直连传输，不经过开发者云端存储。
- **蜂窝网络极速体验**：内置尾部按需分页、HTTP Gzip 压缩与缩略图缓存。
- **双端未读同步与可选推送**：同步桌面与手机已读状态；支持经由无状态中转发送 APNs 推送通知（若不希望经过任何中转，设置 `LEVITY_PUSH_RELAY_URL=off` 即可彻底关闭）。

## 快速安装（macOS）

```bash
git clone https://github.com/vanawaker/LevityBridge.git
cd LevityBridge
npm run install-plugin
```

安装后重启 Antigravity（或在插件管理器启用 **LevityBridge**），打开 **Levity** 侧栏面板扫码即可秒连。

## 运行测试

```bash
npm test
```

## 开源协议

[MIT](./LICENSE)
