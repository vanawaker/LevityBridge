# LevityBridge

[English](./README.md) · [简体中文](./README.zh-CN.md) · [Website](https://spaceshuttle.xyz/levity/) · [Agent Runbook](./AGENT_INSTALL.md)

**LevityBridge** is the open-source companion desktop plugin for **Levity** on iPhone, iPad, and iPhone Duo.

> Levity & LevityBridge are independent third-party companion tools for Antigravity, not affiliated with Google.

---

## Easiest Install (No Coding Required — Let Your Agent Do It)

Never want to touch Terminal? Just copy the sentence below and send it directly to your **Antigravity Agent**:

```text
Please install the LevityBridge desktop plugin for me from https://github.com/vanawaker/LevityBridge following AGENT_INSTALL.md, then help me open the QR code so I can pair my phone.
```

Your Antigravity Agent will automatically check Node.js, clone the repo into `~/LevityBridge`, install the native Antigravity plugin into `~/.gemini/config/plugins/levity-bridge`, and guide you to enable **LevityBridge** and scan the QR code!

> **About Antigravity's Plugin System:** Antigravity's built-in Agent Marketplace is currently Google/partner-curated, while custom user plugins install natively into `~/.gemini/config/plugins/<name>/` (with `plugin.json`, `hooks.json`, and `sidecars/bridge/sidecar.json`). `npm run install-plugin` generates those exact official plugin manifests automatically using your local Node.js path.

---

## Manual Terminal Install (macOS)

```bash
git clone https://github.com/vanawaker/LevityBridge.git ~/LevityBridge
cd ~/LevityBridge
npm run install-plugin
```

Then restart Antigravity (or enable **LevityBridge** in **Customizations → Plugins**), open the **Levity** sidecar panel, and scan the QR code from **Levity** on your iPhone or iPad.

## Features

- **Zero External Dependencies**: Runs purely on Node.js (`>= 20`) built-in modules (`http`, `http2`, `crypto`, `zlib`, `fs`, `node:sqlite`).
- **Official Plugin Lifecycle**: Integrates cleanly via Antigravity Sidecar + Hooks (`SessionStart`, `PreInvocation`, `PreToolUse`, `PostToolUse`, `PostInvocation`, `Stop`).
- **Local-First & Private**: Sessions, thumbnails, and uploaded files travel directly between your Mac and your iOS/iPadOS device over LAN, Tailscale, or your private network. No cloud conversation storage.
- **Fast on Cellular**: Built-in tail pagination, HTTP Gzip compression, and cached thumbnail resizing (`sips` on macOS).
- **Instant Choice-Prompt & Completion Push**: Immediately alerts your phone the moment your Agent asks a choice question or finishes a turn, with dual-synced unread clearing (`LEVITY_PUSH_RELAY_URL=off` disables push relay completely).

## Configuration (Optional Environment Variables)

| Variable | Default | Description |
| --- | --- | --- |
| `ANTIGRAVITYZ_PORT` | `19818` | Local bridge listen port |
| `LEVITY_PUSH_RELAY_URL` | `https://push.spaceshuttle.xyz/v1/push` | Stateless APNs push relay (`off` to disable) |
| `LEVITY_APNS_KEY_PATH` | _(unset)_ | Optional self-hosted `.p8` APNs key path |

## Verification

```bash
npm test
```

## License

[MIT](./LICENSE)
