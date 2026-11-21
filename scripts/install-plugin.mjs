#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const pluginDir =
  process.env.LEVITY_PLUGIN_DIR ||
  path.join(os.homedir(), '.gemini', 'config', 'plugins', 'levity-bridge');
const nodeBin = process.execPath;
const hookRelayPath = path.join(repoRoot, 'scripts', 'hook-relay.mjs');
const sidecarEntryPath = path.join(repoRoot, 'BridgeServer', 'src', 'sidecar-entry.mjs');

fs.mkdirSync(path.join(pluginDir, 'assets'), { recursive: true });
fs.mkdirSync(path.join(pluginDir, 'sidecars', 'bridge'), { recursive: true });

const pluginManifest = {
  name: 'levity-bridge',
  displayName: 'LevityBridge',
  version: '1.0.1',
  description:
    'Open-source companion bridge plugin syncing Antigravity desktop sessions with Levity on iPhone, iPad, and iPhone Duo over LAN or Tailscale.',
  author: {
    name: 'LevityBridge Contributors',
  },
  logo: 'assets/logo.svg',
  suggestedPrompts: [
    'Open the LevityBridge pairing panel to scan the QR code',
    'Check LevityBridge connection health',
  ],
};

const hookCommand = `${nodeBin} ${hookRelayPath}`;
const hooksManifest = {
  'levity-bridge-telemetry': {
    enabled: true,
    SessionStart: [{ type: 'command', command: hookCommand, timeout: 5 }],
    PreInvocation: [{ type: 'command', command: hookCommand, timeout: 5 }],
    PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: hookCommand, timeout: 5 }] }],
    PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: hookCommand, timeout: 5 }] }],
    PostInvocation: [{ type: 'command', command: hookCommand, timeout: 5 }],
    Stop: [{ type: 'command', command: hookCommand, timeout: 5 }],
  },
};

const sidecarManifest = {
  command: nodeBin,
  args: [sidecarEntryPath],
  restart_policy: 'always',
  display_name: 'LevityBridge',
  description: 'Levity companion session bridge and QR pairing auxiliary pane.',
  has_web_ui: true,
  agent_permissions: {
    allows_user_interactions: false,
  },
  ui_config: {
    display_name: 'Levity',
    views: [
      {
        path: '/',
        entrypoint: 'SIDECAR_UI_ENTRYPOINT_AUX_PANE',
        title: 'Levity',
      },
    ],
  },
};

const logoSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="none">
  <defs>
    <linearGradient id="levityGrad" x1="28" y1="28" x2="228" y2="228" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#4B90FF"/>
      <stop offset="52%" stop-color="#9B72CB"/>
      <stop offset="100%" stop-color="#D96570"/>
    </linearGradient>
    <linearGradient id="glassShine" x1="40" y1="30" x2="180" y2="190" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.42"/>
      <stop offset="100%" stop-color="#FFFFFF" stop-opacity="0.06"/>
    </linearGradient>
  </defs>
  <rect x="26" y="26" width="204" height="204" rx="52" fill="#0B1022"/>
  <rect x="28" y="28" width="200" height="200" rx="50" fill="url(#levityGrad)" fill-opacity="0.22" stroke="url(#levityGrad)" stroke-width="6"/>
  <rect x="38" y="38" width="180" height="180" rx="42" fill="url(#glassShine)"/>
  <path d="M96 74V176H172" stroke="url(#levityGrad)" stroke-width="22" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M180 62L185 75L198 80L185 85L180 98L175 85L162 80L175 75L180 62Z" fill="#DCE8FF"/>
</svg>
`;

fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify(pluginManifest, null, 2) + '\n');
fs.writeFileSync(path.join(pluginDir, 'hooks.json'), JSON.stringify(hooksManifest, null, 2) + '\n');
fs.writeFileSync(path.join(pluginDir, 'sidecars', 'bridge', 'sidecar.json'), JSON.stringify(sidecarManifest, null, 2) + '\n');
fs.writeFileSync(path.join(pluginDir, 'assets', 'logo.svg'), logoSvg);

console.log(JSON.stringify({ ok: true, pluginDir, nodeBin, repoRoot }, null, 2));
