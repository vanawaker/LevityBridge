# LevityBridge

[English](./README.md) · [简体中文](./README.zh-CN.md) · [Website](https://spaceshuttle.xyz/levity/) · [Agent Runbook](./AGENT_INSTALL.md)

**LevityBridge** is the open-source companion desktop plugin for **Levity** on iPhone, iPad, and iPhone Duo.

> Levity & LevityBridge are independent third-party companion tools for Antigravity, not affiliated with Google.
>
> **Platform Support: macOS only.** I don't have a Windows or Linux machine to test on, so `LevityBridge` is built and tested exclusively for macOS. The bridge is plain open-source Node.js though—if you're on another OS and want to hack on it (or hand the repo to your own Agent), feel free, and tested PRs are always welcome.

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

To update an existing install later:

```bash
git -C ~/LevityBridge pull --ff-only && npm --prefix ~/LevityBridge run install-plugin
```

## Features

- **Zero External Dependencies**: Runs purely on Node.js (`>= 20`) built-in modules (`http`, `http2`, `crypto`, `zlib`, `fs`, `node:sqlite`).
- **Official Plugin Lifecycle**: Integrates cleanly via Antigravity Sidecar + Hooks (`SessionStart`, `PreInvocation`, `PreToolUse`, `PostToolUse`, `PostInvocation`, `Stop`).
- **Local-First & Private**: Sessions, thumbnails, and uploaded files travel directly between your Mac and your iOS/iPadOS device over LAN, Tailscale, or your private network. No cloud conversation storage.
- **Fast on Cellular**: Built-in tail pagination, HTTP Gzip compression, and cached thumbnail resizing (`sips` on macOS).
- **Smart Final-Reply & Choice-Prompt Push**: Immediately alerts your phone when your Agent asks a choice question or finishes its final reply — while silencing intermediate background-command and subagent status noise — complete with dual-synced unread clearing and cross-device To-Do flagging (`LEVITY_PUSH_RELAY_URL=off` disables push relay completely).

## Scope & Current Limitations

**Levity** is designed as a lightweight **remote companion & monitor** for Antigravity — not a full desktop IDE replacement. Because it stays strictly within Antigravity's official public plugin & local API boundaries, a few desktop-only controls are intentionally outside scope today:

- **Mid-session model switching & renaming**: You can pick any model and thinking level when creating a **new session** from Levity, and Levity displays the exact model and title from your desktop in real time. Switching models mid-conversation or renaming existing conversations is not currently exposed by Antigravity's official plugin API, so make those changes on desktop (and Levity syncs them live).
- **Sandbox permission approval (`Always Allow`)**: High-privilege or out-of-sandbox permission prompts must be approved locally on your Mac for security. Levity sends an immediate push alert so you know when your Agent is waiting for confirmation.
- **Mid-turn Stop / Abort**: You can send follow-up prompts, answer choice questions, and upload photos/files remotely, but forcefully cancelling an in-flight tool execution must still be done on desktop.
- **Desktop must be awake & reachable**: Because there is no cloud mirror of your sessions, your Mac running Antigravity needs to be online and reachable over LAN or a private VPN (such as Tailscale or Surge Ponte).

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
