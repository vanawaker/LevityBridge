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

## 定位与已知局限

**Levity** 的定位是轻量级 **远程伴侣与监控客户端（Remote Companion）**，而非桌面端完整 Antigravity IDE 的全功能替代品。为了严格遵守 Antigravity 官方插件与本地接口的安全边界，以下桌面专属操作目前不在手机端支持范围内：

- **已有会话中途切换模型**：在手机端**新建会话**时可自由选择任意模型与思考档位，并在聊天中实时查看电脑端当前真实模型与剩余额度；但受限于桌面端本地接口边界，**无法在已有会话中途从手机强制切换模型**，如需中途改模型请在电脑端操作。
- **系统沙盒授权确认（`Always Allow`）**：涉及高危操作或沙盒外路径的系统权限弹窗，出于本机安全边界必须由你在 Mac 上亲自点击确认；手机端会第一时间推送通知提醒你。
- **运行中途强制停止（Stop / Abort）**：手机端支持随时发新消息、点选回答 Agent 的选择题以及上传图片/文件，但暂不支持远程强行中止正在执行中的工具调用。
- **依赖桌面端在线可达**：由于不存在任何云端会话镜像，需要保持运行 Antigravity 的 Mac 在线且可通过局域网或私有网络（如 Tailscale / Surge Ponte）直连。

## 运行测试

```bash
npm test
```

## 开源协议

[MIT](./LICENSE)
