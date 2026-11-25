/**
 * Sidecar Entry — Boots the AntigravityZ Bridge Server (:19818), loads optional
 * local host configuration (`~/.gemini/antigravity/antigravityz/config.json`),
 * and mounts the official Antigravity Auxiliary Pane pairing dashboard.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AgentController } from './agent-controller.mjs';
import { ApnsPusher } from './apns-pusher.mjs';
import { BrainScanner } from './brain-scanner.mjs';
import { BridgeServer } from './bridge-server.mjs';
import { MetaStore } from './meta-store.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const auxDir = join(__dirname, 'aux-pane');

function loadHostConfig(stateDir) {
  const cfgPath = join(stateDir, 'config.json');
  try {
    if (existsSync(cfgPath)) {
      const parsed = JSON.parse(readFileSync(cfgPath, 'utf-8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    }
  } catch {
    // Ignore malformed optional config
  }
  return {};
}

async function main() {
  const metaStore = new MetaStore();
  const hostCfg = loadHostConfig(metaStore.stateDir);
  const projectsRoot =
    process.env.ANTIGRAVITYZ_PROJECTS_ROOT ||
    hostCfg.projectsRoot ||
    join(homedir(), 'Projects');
  const expectedMount =
    process.env.ANTIGRAVITYZ_REQUIRED_MOUNT ||
    hostCfg.expectedMount ||
    '';

  let scannerRef = null;
  const agentController = new AgentController({
    projectsRoot,
    expectedMount,
    brainDirsProvider: () => (scannerRef ? scannerRef.discoverAppDataDirs() : []),
  });
  const brainScanner = new BrainScanner({
    projectsRoot,
    agentController,
    metaStore,
  });
  scannerRef = brainScanner;

  const apnsCfg = hostCfg.apns || {};
  const apnsPusher = new ApnsPusher({
    metaStore,
    keyPath: process.env.ANTIGRAVITYZ_APNS_KEY_PATH || apnsCfg.keyPath || '',
    keyId: process.env.ANTIGRAVITYZ_APNS_KEY_ID || apnsCfg.keyId || '',
    teamId: process.env.ANTIGRAVITYZ_APNS_TEAM_ID || apnsCfg.teamId || '',
    bundleId: process.env.ANTIGRAVITYZ_APNS_BUNDLE_ID || apnsCfg.bundleId || 'xyz.spaceshuttle.antigravityz',
    defaultEnv: process.env.ANTIGRAVITYZ_APNS_ENV || apnsCfg.env || 'production',
  });

  const bridge = new BridgeServer({
    metaStore,
    brainScanner,
    agentController,
    apnsPusher,
    managedSidecar: Boolean(process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR),
    onRequestRestart: () => { bridge.stop().finally(() => process.exit(0)); },
  });

  await bridge.start();
  const info = bridge.getPairingInfo();
  console.log(`[AntigravityZ] Bridge listening on 0.0.0.0:${info.port} (APNs: ${info.apnsConfigured ? 'enabled' : 'disabled'})`);
  console.log(`[AntigravityZ] Preferred URL: ${info.primaryUrl}`);

  try {
    const req = createRequire(import.meta.url);
    const searchPaths = (process.env.NODE_PATH || '').split(':').filter(Boolean);
    const resolved = req.resolve('sidecar_sdk', { paths: [...searchPaths, process.cwd()] });
    const sdk = await import(pathToFileURL(resolved).href);
    if (sdk?.SidecarApp && sdk?.Response) {
      const app = new sdk.SidecarApp();
      app.page('/', () => readFileSync(join(auxDir, 'index.html'), 'utf-8'));
      app.api(
        '/styles.css',
        () => new sdk.Response(readFileSync(join(auxDir, 'styles.css'), 'utf-8'), { contentType: 'text/css' }),
        'GET'
      );
      app.api(
        '/app.js',
        () =>
          new sdk.Response(readFileSync(join(auxDir, 'app.js'), 'utf-8'), {
            contentType: 'application/javascript',
          }),
        'GET'
      );
      app.api('/api/status', () => bridge.getPairingInfo(), 'GET');
      app.api('/api/bridge-update-status', () => bridge.checkBridgeUpdate(true), 'GET');
      app.api(
        '/api/bridge-update',
        async (data) => {
          if (!bridge.matchesPairingToken(data?.token)) {
            return { ok: false, httpStatus: 401, status: 'unauthorized', message: 'Refresh the pairing panel and try again.' };
          }
          const result = await bridge.performBridgeUpdate();
          // The SDK serializes this return value. Give it time to deliver the response.
          if (result.ok && result.restarting) bridge.scheduleRestart();
          return result;
        },
        'POST'
      );
      app.api(
        '/api/rotate-token',
        () => {
          metaStore.rotateToken();
          return bridge.getPairingInfo();
        },
        'POST'
      );
      app.run();
      console.log('[AntigravityZ] Auxiliary pane registered via sidecar_sdk');
    }
  } catch {
    console.log('[AntigravityZ] Running without sidecar_sdk (standalone daemon mode)');
  }
}

main().catch((err) => {
  console.error('[AntigravityZ] Fatal startup error:', err);
  process.exit(1);
});
