# LevityBridge

[English](./README.md) · [简体中文](./README.zh-CN.md) · [官方网站](https://spaceshuttle.xyz/levity/) · [Agent 自动安装手册](./AGENT_INSTALL.md)

**LevityBridge** 是 **Levity**（iPhone / iPad / iPhone Duo 远程伴侣 App）的官方开源桌面端桥接插件。

> Levity 与 LevityBridge 均为专为 Antigravity 打造的独立第三方伴侣工具，非 Google 官方产品。

---

## 最简单安装方法（零代码 · 一句话让你的 Agent 帮你装好）

完全不会敲命令？直接复制下面这句话，发给你的 **Antigravity Agent** 即可：

```text
请帮我按 https://github.com/vanawaker/LevityBridge 仓库里的 AGENT_INSTALL.md 安装 LevityBridge 桌面端插件，安装完成后带我启用插件并打开配对二维码。
```

你的 Antigravity Agent 会自动检查 Node.js 环境、拉取开源仓库到 `~/LevityBridge`、把标准插件配置写入 `~/.gemini/config/plugins/levity-bridge`，并直接给你可点击的启用入口和扫码配对指引，全程不用碰终端！

> **关于 Antigravity 官方插件机制：** Antigravity 内置的 Agent Marketplace 目前仅向 Google 官方与合作伙伴开放上架，第三方自定义插件的标准安装目录为 `~/.gemini/config/plugins/<插件名>/`（包含 `plugin.json`、`hooks.json` 与 `sidecars/bridge/sidecar.json`）。本项目内置的 `npm run install-plugin` 会自动探测你电脑上的 Node 绝对路径并生成完全符合官方规范的插件清单。

---

## 开发者命令行安装（macOS）

```bash
git clone https://github.com/vanawaker/LevityBridge.git ~/LevityBridge
cd ~/LevityBridge
npm run install-plugin
```

安装完成后重启 Antigravity（或在 **Customizations → Plugins** 启用 **LevityBridge**），打开 **Levity** 侧栏面板扫码即可秒连。

## 核心特性

- **零第三方依赖**：纯 Node.js（`>= 20`）原生模块实现，安全可审计。
- **标准插件架构**：基于 Antigravity 官方 Sidecar 侧栏与生命周期 Hooks 接入，支持二维码一键配对与实时会话同步。
- **本地直连保护隐私**：所有聊天记录、附件与配对凭据仅在你的电脑与移动设备间通过局域网或 Tailscale 等私有网络直连传输，不经过开发者云端存储。
- **蜂窝网络极速体验**：内置尾部按需分页、HTTP Gzip 压缩与缩略图缓存。
- **选择题与回复即时推送**：Agent 弹出选项提问或完成任务瞬间即可推送到手机，双端自动同步已读状态（若希望彻底关闭外部中转，设置 `LEVITY_PUSH_RELAY_URL=off` 即可）。

## 运行测试

```bash
npm test
```

## 开源协议

[MIT](./LICENSE)
