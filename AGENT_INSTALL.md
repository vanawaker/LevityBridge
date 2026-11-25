# Agent Installation Runbook (`LevityBridge`)

> **For AI Agents (Antigravity / coding assistants):** Follow these steps cleanly to install and verify **LevityBridge** for the user so they never need to touch Terminal.

## Prerequisites Check

1. Check that `node` (`>= 22.13`, required for built-in `node:sqlite`) and `git` are installed:
   ```bash
   node -v && git --version
   ```
   - If Node.js `< 22.13` or missing on macOS, offer to install it via Homebrew (`brew install node`) or ask the user before installing.

## Installation Steps

2. Clone (or update if already present) the official repository into a clean persistent folder (default `~/LevityBridge`):
   ```bash
   if [ -d "$HOME/LevityBridge/.git" ]; then
     git -C "$HOME/LevityBridge" pull --ff-only
   else
     git clone https://github.com/vanawaker/LevityBridge.git "$HOME/LevityBridge"
   fi
   ```

3. Run the official Antigravity plugin installer script:
   ```bash
   cd "$HOME/LevityBridge" && npm run install-plugin
   ```
   This creates `~/.gemini/config/plugins/levity-bridge/` with:
   - `plugin.json` (Antigravity plugin metadata)
   - `hooks.json` (wired to the user's absolute `node` binary & `scripts/hook-relay.mjs`)
   - `sidecars/bridge/sidecar.json` (wired to `BridgeServer/src/sidecar-entry.mjs`, exposing the **Levity** QR pairing side pane)
   - `assets/logo.svg`

4. (Optional quick sanity check) Run the zero-dependency test suite:
   ```bash
   cd "$HOME/LevityBridge" && npm test
   ```

## Enabling & Pairing With Levity (iOS / iPadOS)

5. Tell the user clearly:
   - Click **[LevityBridge](customization://levity-bridge)** in Antigravity (or open **Customizations → Plugins**) and make sure **LevityBridge** is enabled (restart Antigravity once if the plugin does not appear immediately).
   - Once enabled, check whether the local bridge is live:
     ```bash
     curl -sS --noproxy '*' http://127.0.0.1:19818/api/v1/health
     ```
   - Open the **Levity** side panel in Antigravity (or open `http://127.0.0.1:19818/` in the local browser) to reveal the QR code, then open **Levity** on iPhone / iPad and scan it.

## Optional Privacy Note

- All chats, thumbnails, and credentials stay directly on the user's LAN or Tailscale network — zero cloud conversation storage.
- Push notifications use a stateless zero-log APNs relay by default (`https://push.spaceshuttle.xyz/v1/push`). If the user wants zero external network calls even for push notifications, set `LEVITY_PUSH_RELAY_URL=off` in the sidecar environment.
