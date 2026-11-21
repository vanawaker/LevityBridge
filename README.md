# LevityBridge

[English](./README.md) · [简体中文](./README.zh-CN.md)

**LevityBridge** is the open-source companion desktop plugin for **Levity** on iPhone, iPad, and iPhone Duo.

> Levity & LevityBridge are independent third-party companion tools for Antigravity, not affiliated with Google.

## Features

- **Zero External Dependencies**: Runs purely on Node.js (`>= 20`) built-in modules (`http`, `http2`, `crypto`, `zlib`, `fs`).
- **Official Plugin Lifecycle**: Integrates cleanly via Antigravity Sidecar + Hooks (`SessionStart`, `PreInvocation`, `PreToolUse`, `PostToolUse`, `PostInvocation`, `Stop`).
- **Local-First & Private**: Sessions, thumbnails, and uploaded files travel directly between your Mac and your iOS/iPadOS device over LAN, Tailscale, or your private network. No cloud conversation storage.
- **Fast on Cellular**: Built-in tail pagination, HTTP Gzip compression, and cached thumbnail resizing (`sips` on macOS).
- **Dual-Synced Unread State & Optional Push**: Syncs read receipts between desktop and mobile and supports optional stateless APNs push relay (`LEVITY_PUSH_RELAY_URL`, set `LEVITY_PUSH_RELAY_URL=off` to disable completely).

## Quick Install (macOS)

```bash
git clone https://github.com/vanawaker/LevityBridge.git
cd LevityBridge
npm run install-plugin
```

Then restart Antigravity (or enable **LevityBridge** in Plugins Manager), open the **Levity** sidecar panel, and scan the QR code from **Levity** on your iPhone or iPad.

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
