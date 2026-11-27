import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs, { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os, { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { AgentController } from '../src/agent-controller.mjs';
import { ApnsPusher } from '../src/apns-pusher.mjs';
import { BrainScanner, sanitizeAssistantLeakedTail, uriToPath } from '../src/brain-scanner.mjs';
import { BridgeServer } from '../src/bridge-server.mjs';
import { BridgeUpdater, compareSemver } from '../src/bridge-updater.mjs';
import { MetaStore } from '../src/meta-store.mjs';
import { generateQrSvg } from '../src/qr-svg.mjs';
import { QuotaMonitor } from '../src/quota-monitor.mjs';
import { resolveWorkspaceDirectory, workspaceLocations } from '../src/workspace-paths.mjs';

function workspaceFixture(t) {
  const sandbox = mkdtempSync(join(tmpdir(), 'levity-workspaces-'));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const projectsRoot = join(sandbox, 'Projects');
  const projectsConfigDir = join(sandbox, 'registrations');
  const appData = join(sandbox, 'app-data');
  const stateDir = join(sandbox, 'state');
  for (const dir of [projectsRoot, projectsConfigDir, join(appData, 'brain')]) mkdirSync(dir, { recursive: true });
  const metaStore = new MetaStore({ stateDir });
  const scanner = new BrainScanner({ projectsRoot, projectsConfigDir, appDataDirs: [appData], metaStore });
  const captured = [];
  const controller = new AgentController({
    projectsRoot, projectsConfigDir, agentApiPath: 'mock-agentapi',
    brainDirsProvider: () => [appData],
    execFn: async (_bin, args, options) => {
      captured.push({ args, ...options });
      return { stdout: JSON.stringify({ conversationId: 'workspace-session' }) };
    },
  });
  const register = (id, binding) => {
    writeFileSync(join(projectsConfigDir, `${id}.json`), JSON.stringify({ id, name: id.toUpperCase(), ...binding }));
  };
  return { sandbox, projectsRoot, scanner, controller, metaStore, stateDir, captured, register };
}

test('BrainScanner merges both project roots, directory links, registered folders and trusted workspace history', t => {
  const { sandbox, projectsRoot, scanner, metaStore, register } = workspaceFixture(t);
  const home = join(sandbox, 'home');
  const homeProject = join(home, 'Projects', 'foo');
  const project = join(projectsRoot, 'foo');
  const linkedTarget = join(sandbox, 'linked-target');
  const link = join(projectsRoot, 'linked');
  const desktop = join(sandbox, 'Desktop Repo');
  const history = join(sandbox, 'historical');
  const saved = join(sandbox, 'remembered');
  const favorite = join(sandbox, 'favorite');
  const recent = join(sandbox, 'recent');
  const ignored = join(sandbox, 'hidden-sidecar');
  for (const path of [homeProject, project, linkedTarget, desktop, history, saved, favorite, recent, ignored]) {
    mkdirSync(path, { recursive: true });
  }
  symlinkSync(linkedTarget, link);
  symlinkSync(project, join(projectsRoot, 'alias-of-foo'));
  symlinkSync(join(sandbox, 'missing'), join(projectsRoot, 'broken'));
  writeFileSync(join(sandbox, 'file'), '');
  symlinkSync(join(sandbox, 'file'), join(projectsRoot, 'file-link'));
  register('desktop', { projectResources: { localFolders: [{ uri: pathToFileURL(desktop).href }] } });
  register('sidecar', { folders: [ignored], sidecar: { sidecarId: 'test' } });
  scanner.readDesktopSummariesIndex = () => new Map([
    ['history-session', { workspaceUri: pathToFileURL(history).href }],
    ['pseudo-session', { workspaceUri: 'project://fake' }],
    ['dead-session', { workspaceUri: pathToFileURL(ignored).href, killed: true }],
  ]);
  metaStore.rememberWorkspace('saved-session', saved);
  metaStore.rememberWorkspace('missing-session', join(sandbox, 'not-a-directory-yet'));
  metaStore.setWorkspaceFavorite(favorite, true);
  metaStore.rememberRecentWorkspace(recent);

  const mockHome = t.mock.method(os, 'homedir', () => home);
  syncBuiltinESMExports();
  try {
    const known = scanner.listKnownProjectFolders();
    const byPath = new Map(known.map((item) => [realpathSync.native(item.path), item]));
    assert.equal(known.length, byPath.size, 'aliases of the same directory only appear once');
    assert.equal(byPath.get(realpathSync.native(project)).name, 'foo');
    assert.equal(byPath.get(realpathSync.native(project)).parentPath, projectsRoot);
    assert.deepEqual(byPath.get(realpathSync.native(homeProject)), {
      name: 'foo', path: homeProject, parentPath: join(home, 'Projects'), source: 'projectsRoot',
    });
    assert.equal(byPath.get(realpathSync.native(linkedTarget)).path, link);
    assert.equal(byPath.get(realpathSync.native(desktop)).desktopProjectId, 'desktop');
    for (const [path, source] of [[history, 'history'], [saved, 'history'], [favorite, 'favorite'], [recent, 'recent']]) {
      assert.equal(byPath.get(realpathSync.native(path)).source, source);
    }
    assert.equal(known.length, 8);
    assert.ok(!known.some(({ name }) => ['broken', 'file-link', 'not-a-directory-yet', 'fake'].includes(name)));
  } finally {
    mockHome.mock.restore();
    syncBuiltinESMExports();
  }
});

test('AgentController matches exact normalized desktop folders and validates cwd before creating a conversation', async t => {
  const { sandbox, projectsRoot, controller, metaStore, stateDir, captured, register } = workspaceFixture(t);
  const repo = join(projectsRoot, 'Repo');
  const repoOld = join(projectsRoot, 'Repo-old');
  const spaces = join(projectsRoot, 'Repo With Spaces');
  const alias = join(sandbox, 'Alias');
  const file = join(sandbox, 'file');
  for (const dir of [repo, repoOld, spaces]) mkdirSync(dir);
  symlinkSync(spaces, alias);
  writeFileSync(file, '');
  register('prefix', { projectResources: { localFolders: [{ uri: pathToFileURL(repoOld).href }] } });
  register('z-choice', { workspaces: [{ workspaceFolderAbsoluteUri: pathToFileURL(spaces).href }] });
  register('a-choice', { projectResources: {}, folders: [{ uri: pathToFileURL(alias).href }] });
  register('sidecar', { folders: [repo], sidecar: true });

  assert.equal(controller.resolveDesktopProjectIdForWorkspace(repo), 'outside-of-project');
  assert.equal(controller.resolveDesktopProjectIdForWorkspace(repoOld), 'prefix');
  assert.equal(controller.resolveDesktopProjectIdForWorkspace(spaces), 'a-choice');
  assert.equal(controller.resolveDesktopProjectIdForWorkspace(alias, 'z-choice'), 'z-choice');
  assert.equal(controller.resolveDesktopProjectIdForWorkspace(spaces, 'prefix'), 'a-choice');
  for (const [path, code, status] of [
    [join(sandbox, 'missing'), 'NOT_FOUND', 404],
    [file, 'NOT_A_DIRECTORY', 400],
    [join(file, 'child'), 'NOT_A_DIRECTORY', 400],
    ['project://not-local', 'INVALID_PATH', 400],
    [`/Volumes/${sandbox.split('/').at(-1)}/Repo`, 'VOLUME_OFFLINE', 400],
  ]) {
    await assert.rejects(controller.createConversation({ prompt: 'Test', workspacePath: path, metaStore }), { code, status });
  }
  assert.equal(captured.length, 0);
  assert.deepEqual(metaStore.listWorkspacePaths().recents, []);

  const result = await controller.createConversation({
    prompt: 'Test', workspacePath: alias, desktopProjectId: 'z-choice', metaStore,
  });
  const canonical = realpathSync.native(spaces);
  assert.equal(result.workspacePath, canonical);
  assert.equal(captured[0].cwd, canonical);
  assert.equal(captured[0].env.ANTIGRAVITY_PROJECT_ID, 'z-choice');
  await controller.createConversation({ prompt: 'Test again', workspacePath: spaces, metaStore });
  assert.deepEqual(new MetaStore({ stateDir }).listWorkspacePaths().recents, [canonical]);
});

test('Workspace APIs browse arbitrary folders, persist favorites and advertise the capability without URL authentication', async t => {
  const { sandbox, projectsRoot, scanner, controller, metaStore, stateDir, register } = workspaceFixture(t);
  const parent = join(sandbox, 'outside-root');
  const child = join(parent, 'Alpha');
  const symlink = join(parent, 'Shortcut');
  const home = join(sandbox, 'home');
  const documents = join(home, 'Documents');
  const recent = join(sandbox, 'used');
  const inaccessible = join(parent, 'Denied');
  for (const path of [child, join(parent, 'Beta'), join(parent, '.Hidden'), documents, recent, inaccessible]) {
    mkdirSync(path, { recursive: true });
  }
  symlinkSync(child, symlink);
  symlinkSync(join(parent, 'nowhere'), join(parent, 'Broken'));
  writeFileSync(join(parent, 'file'), '');
  symlinkSync(join(parent, 'file'), join(parent, 'FileLink'));
  register('desk', { folders: [pathToFileURL(child).href] });
  register('alt', { workspaces: [{ uri: pathToFileURL(symlink).href }] });
  register('sidecar', { folders: [parent], sidecar: true });

  const homeMock = t.mock.method(os, 'homedir', () => home);
  syncBuiltinESMExports();
  t.after(() => {
    homeMock.mock.restore();
    syncBuiltinESMExports();
  });
  const bridge = new BridgeServer({
    port: 0, host: '127.0.0.1', metaStore, brainScanner: scanner, agentController: controller,
    quotaMonitor: { getSnapshot: async () => null },
  });
  await bridge.start();
  t.after(() => bridge.stop());
  const base = `http://127.0.0.1:${bridge.getBoundPort()}/api/v1`;
  const token = metaStore.getToken();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const request = async (endpoint, body, expectedStatus = 200) => {
    const response = await fetch(`${base}/${endpoint}`, {
      headers,
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const data = await response.json();
    assert.equal(response.status, expectedStatus, JSON.stringify(data));
    return data;
  };
  const suggestions = () => request('workspaces/suggestions');
  const list = (body, status) => request('workspaces/list', body, status);
  const resolve = (path, status) => request('workspaces/resolve', { path }, status);
  const favorite = (action, path) => request('workspaces/favorites', { action, path });
  for (const [route, method] of [['suggestions', 'GET'], ['list', 'POST'], ['resolve', 'POST'], ['favorites', 'POST']]) {
    const rejected = await fetch(`${base}/workspaces/${route}?token=${encodeURIComponent(token)}`, { method });
    assert.equal(rejected.status, 401);
    assert.equal(rejected.headers.get('cache-control'), 'no-store');
    assert.equal((await rejected.json()).code, 'UNAUTHORIZED');
  }
  const health = await request('health');
  assert.deepEqual(health.capabilities, ['inline_images', 'bridge_update_check', 'self_update', 'workspace_browser']);
  const boot = await request('bootstrap');
  assert.equal(boot.capabilities.workspaceBrowser, true);
  assert.deepEqual(boot.server.capabilities, ['inline_images', 'bridge_update_check', 'self_update', 'workspace_browser']);
  assert.ok(boot.knownProjects.some(({ desktopProjectId }) => desktopProjectId === 'alt'));

  const saved = await favorite('add', symlink);
  const canonical = realpathSync.native(child);
  assert.deepEqual(saved.favorites, [{
    name: 'Alpha', path: canonical, parentPath: realpathSync.native(parent), available: true,
    desktopProjectId: 'alt', desktopProjectName: 'ALT',
  }]);
  assert.deepEqual(await favorite('add', child), saved);
  assert.deepEqual(new MetaStore({ stateDir }).listWorkspacePaths().favorites, [canonical]);
  const initial = await suggestions();
  assert.deepEqual(initial.favorites, saved.favorites);
  assert.deepEqual(initial.recents, []);
  assert.deepEqual(initial.desktopProjects.map(({ id }) => id).sort(), ['alt', 'desk']);
  assert.equal(initial.locations[0].path, projectsRoot);
  assert.ok(initial.locations.some(({ path, name }) => path === documents && name === 'Documents'));
  assert.equal(initial.locations.at(-1).path, '/');
  assert.ok(!initial.locations.some(({ kind, path }) => kind === 'volume' && realpathSync.native(path) === '/'));

  const listing = await list({ path: parent });
  assert.equal(listing.resolvedPath, realpathSync.native(parent));
  assert.equal(listing.parentPath, sandbox);
  assert.equal(listing.isRoot, false);
  assert.deepEqual(listing.entries.map(({ name }) => name), ['Alpha', 'Beta', 'Denied', 'Shortcut']);
  assert.deepEqual(listing.entries.at(-1), {
    name: 'Shortcut', path: symlink, isSymlink: true, isHidden: false, isFavorite: true,
  });
  assert.equal(listing.truncated, false);
  assert.equal(listing.totalReturned, 4);
  assert.deepEqual((await list({ path: parent, filter: 'aLp' })).entries.map(({ name }) => name), ['Alpha']);
  const hidden = await list({ path: parent, showHidden: true, filter: 'hidden' });
  assert.equal(hidden.entries[0].isHidden, true);
  const limited = await list({ path: parent, limit: 1 });
  assert.equal(limited.totalReturned, 1);
  assert.equal(limited.truncated, true);
  assert.equal((await list({ path: '' })).path, projectsRoot);
  assert.equal((await list({ path: '/' })).isRoot, true);
  assert.equal((await list({ path: '/' })).parentPath, null);

  const resolved = await resolve(symlink);
  assert.equal(resolved.path, symlink);
  assert.equal(resolved.resolvedPath, canonical);
  assert.equal(resolved.isFavorite, true);
  assert.deepEqual(resolved.matchingDesktopProjects, [{ id: 'alt', name: 'ALT' }, { id: 'desk', name: 'DESK' }]);
  assert.equal((await resolve('~/Documents')).resolvedPath, realpathSync.native(documents));
  assert.equal((await resolve(join(parent, 'file'), 400)).code, 'NOT_A_DIRECTORY');
  assert.equal((await resolve(join(parent, 'Broken'), 404)).code, 'NOT_FOUND');
  assert.equal((await resolve('project://bad', 400)).code, 'INVALID_PATH');
  // Root can read mode-000 folders, so inject the kernel denial for that runner.
  const stat = fs.statSync;
  const accessMock = process.getuid?.() === 0 && t.mock.method(fs, 'statSync', (path, ...options) => {
    if (path === inaccessible) throw Object.assign(new Error('Access denied'), { code: 'EACCES' });
    return stat(path, ...options);
  });
  if (accessMock) syncBuiltinESMExports();
  chmodSync(inaccessible, 0o000);
  try {
    assert.deepEqual(await list({ path: inaccessible }, 403), {
      error: 'Mac 拒绝访问此目录', code: 'PERMISSION_DENIED',
    });
  } finally {
    chmodSync(inaccessible, 0o700);
    if (accessMock) {
      accessMock.mock.restore();
      syncBuiltinESMExports();
    }
  }
  assert.equal((await request('conversations', { prompt: 'Hi', workspacePath: join(parent, 'missing') }, 404)).code, 'NOT_FOUND');
  await request('conversations', { prompt: 'Hi', workspacePath: recent }, 201);
  assert.equal((await suggestions()).recents[0].path, realpathSync.native(recent));
  rmSync(recent, { recursive: true });
  assert.deepEqual((await suggestions()).recents, []);
  rmSync(child, { recursive: true });
  assert.equal((await suggestions()).favorites[0].available, false);
  assert.deepEqual(await favorite('remove', canonical), { favorites: [] });
  assert.deepEqual(new MetaStore({ stateDir }).listWorkspacePaths().favorites, []);
});

test('Workspace list caps returned directories at 200 and stops scanning after 4000 entries', async t => {
  const { sandbox, projectsRoot, scanner, controller, metaStore } = workspaceFixture(t);
  const wide = join(sandbox, 'wide');
  mkdirSync(wide);
  for (let index = 0; index < 201; index++) mkdirSync(join(projectsRoot, `dir-${index}`));
  for (let index = 0; index < 4001; index++) writeFileSync(join(wide, `skip-${index}`), '');
  const bridge = new BridgeServer({
    port: 0, host: '127.0.0.1', metaStore, brainScanner: scanner, agentController: controller,
    quotaMonitor: { getSnapshot: async () => null },
  });
  await bridge.start();
  t.after(() => bridge.stop());
  const list = async (body) => {
    const response = await fetch(`http://127.0.0.1:${bridge.getBoundPort()}/api/v1/workspaces/list`, {
      method: 'POST', headers: { Authorization: `Bearer ${metaStore.getToken()}` }, body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const clamped = await list({ limit: 999 });
  assert.equal(clamped.totalReturned, 200);
  assert.equal(clamped.truncated, true);
  const bounded = await list({ path: wide, filter: 'absent' });
  assert.deepEqual(bounded.entries, []);
  assert.equal(bounded.truncated, true);
});

test('Workspace volume discovery excludes stale mount directories and the root symlink', t => {
  const states = new Map([
    ['/Volumes', { dev: 1, isDirectory: () => true }],
    ['/Volumes/Mounted', { dev: 2, isDirectory: () => true }],
    ['/Volumes/Mounted/Repo', { dev: 2, isDirectory: () => true }],
    ['/Volumes/Stale', { dev: 1, isDirectory: () => true }],
    ['/Volumes/System', { dev: 3, isDirectory: () => true }],
  ]);
  const originalStat = fs.statSync;
  const originalReadDir = fs.readdirSync;
  const originalRealpath = fs.realpathSync.native;
  const statMock = t.mock.method(fs, 'statSync', (path, ...options) =>
    states.get(path) || originalStat(path, ...options));
  const directoryMock = t.mock.method(fs, 'readdirSync', (path, ...options) =>
    path === '/Volumes' ? ['Stale', 'Mounted', 'System'] : originalReadDir(path, ...options));
  const realpathMock = t.mock.method(fs.realpathSync, 'native', (path, ...options) => {
    if (path === '/Volumes/System') return '/';
    return states.has(path) ? path : originalRealpath(path, ...options);
  });
  syncBuiltinESMExports();
  try {
    assert.deepEqual(workspaceLocations('/Volumes/Mounted/Repo').filter(({ kind }) => kind === 'volume'), [{
      kind: 'volume', name: 'Mounted', path: '/Volumes/Mounted', parentPath: '/Volumes',
    }]);
    assert.equal(resolveWorkspaceDirectory('/Volumes/Mounted/Repo').resolvedPath, '/Volumes/Mounted/Repo');
    assert.equal(resolveWorkspaceDirectory('/Volumes/System').resolvedPath, '/');
    assert.throws(() => resolveWorkspaceDirectory('/Volumes/Stale'), { code: 'VOLUME_OFFLINE', status: 400 });
  } finally {
    for (const mock of [statMock, directoryMock, realpathMock]) mock.mock.restore();
    syncBuiltinESMExports();
  }
});

test('Background project discovery never enumerates lazy home locations even when configured through an alias', t => {
  const { sandbox, scanner } = workspaceFixture(t);
  const home = join(sandbox, 'home');
  const documents = join(home, 'Documents');
  const alias = join(sandbox, 'root-alias');
  mkdirSync(join(documents, 'Unopened'), { recursive: true });
  symlinkSync(documents, alias);
  scanner.projectsRoot = alias;

  const originalReadDir = fs.readdirSync;
  const reads = [];
  const homeMock = t.mock.method(os, 'homedir', () => home);
  const directoryMock = t.mock.method(fs, 'readdirSync', (path, ...options) => {
    if ([documents, alias].includes(path)) reads.push(path);
    return originalReadDir(path, ...options);
  });
  syncBuiltinESMExports();
  try {
    assert.deepEqual(scanner.listKnownProjectFolders(), []);
    assert.ok(workspaceLocations(alias).some(({ path }) => path === documents));
    assert.deepEqual(reads, []);
  } finally {
    for (const mock of [homeMock, directoryMock]) mock.mock.restore();
    syncBuiltinESMExports();
  }
});

test('QuotaMonitor parses GetUserStatus model quota pools and reset times', () => {
  const parsed = QuotaMonitor.parseUserStatus({
    userTier: { name: 'Google AI Ultra' },
    cascadeModelConfigData: {
      clientModelConfigs: [
        {
          label: 'Gemini 4 Carbon (High)',
          quotaInfo: { remainingFraction: 0.826, resetTime: '2026-11-19T14:16:20Z' },
        },
        {
          label: 'Claude Sonnet 5.5 (High)',
          quotaInfo: { remainingFraction: 0.95, resetTime: '2026-11-19T17:06:35Z' },
        },
      ],
    },
  });
  assert.ok(parsed);
  assert.equal(parsed.tierName, 'Google AI Ultra');
  assert.equal(parsed.pools.length, 2);
  assert.equal(parsed.pools[0].id, 'gemini');
  assert.equal(parsed.pools[0].remainingPercent, 83);
  assert.equal(parsed.pools[1].id, 'claude_gpt');
  assert.equal(parsed.pools[1].label, 'Claude · GPT');
  assert.equal(parsed.pools[1].remainingPercent, 95);
  assert.equal(parsed.byModelId['gemini-4-carbon-high'].remainingPercent, 83);

  const combined = QuotaMonitor.parseCombined(
    {
      response: {
        groups: [
          {
            displayName: 'Gemini Models',
            buckets: [
              { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.6128, resetTime: '2026-11-25T15:26:30Z' },
              { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.7519, resetTime: '2026-11-19T14:16:20Z' },
            ],
          },
          {
            displayName: 'Claude and GPT models',
            buckets: [
              { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 1.0, resetTime: '2026-11-26T12:49:58Z' },
              { bucketId: '3p-5h', window: '5h', remainingFraction: 1.0, resetTime: '2026-11-19T17:49:58Z' },
            ],
          },
        ],
      },
    },
    { userTier: { name: 'Google AI Ultra' } }
  );
  assert.equal(combined.tierName, 'Google AI Ultra');
  assert.equal(combined.pools[0].remainingPercent, 75);
  assert.equal(combined.pools[0].weeklyPercent, 61);
  assert.equal(combined.pools[1].remainingPercent, 100);
  assert.equal(combined.pools[1].weeklyPercent, 100);
  assert.equal(combined.byModelId['gemini-4-carbon-high'].weeklyPercent, 61);
  assert.equal(combined.byModelId['gpt-oss-120b-medium'].weeklyPercent, 100);

  // Authoritative RetrieveUserQuotaSummary pool values must override stale legacy GetUserStatus values (e.g. 89% vs 100%)
  // AND never mix a summary percentage with a stale legacy reset timestamp when pool.resetTime is null.
  const authoritative = QuotaMonitor.parseCombined(
    {
      response: {
        groups: [
          {
            displayName: 'Gemini Models',
            buckets: [
              { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.98, resetTime: '2026-12-03T06:00:00Z' },
              { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.93, resetTime: '2026-11-26T12:04:00Z' },
            ],
          },
          {
            displayName: 'Claude and GPT models',
            buckets: [
              { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 0.94, resetTime: '2026-12-03T07:00:00Z' },
              { bucketId: '3p-5h', window: '5h', remainingFraction: 0.89, resetTime: null },
            ],
          },
        ],
      },
    },
    {
      userTier: { name: 'Google AI Ultra' },
      cascadeModelConfigData: {
        clientModelConfigs: [
          {
            label: 'Claude Opus 5.5 (High)',
            quotaInfo: { remainingFraction: 1.0, resetTime: '2026-11-26T11:11:11Z' },
          },
        ],
      },
    }
  );
  assert.equal(authoritative.pools[1].remainingPercent, 89);
  assert.equal(authoritative.byModelId['claude-opus-5-5-high'].remainingPercent, 89);
  assert.equal(authoritative.byModelId['claude-opus-5-5-high'].remainingFraction, 0.89);
  assert.equal(authoritative.byModelId['claude-opus-5-5-high'].resetTime, null);
  assert.equal(authoritative.byModelId['claude-opus-5-5-high'].weeklyPercent, 94);

  // Null 5h remainingFraction must be treated as missing (falling back to weekly), NEVER coerced to 0%!
  const nullFiveH = QuotaMonitor.parseCombined(
    {
      response: {
        groups: [
          {
            displayName: 'Claude and GPT models',
            buckets: [
              { bucketId: '3p-5h', window: '5h', remainingFraction: null },
              { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 0.94, resetTime: '2026-12-03T07:00:00Z' },
            ],
          },
        ],
      },
    },
    { userTier: { name: 'Google AI Ultra' } }
  );
  assert.equal(nullFiveH.pools[0].remainingPercent, 94);
  assert.equal(nullFiveH.pools[0].weeklyPercent, 94);
});

test('QR SVG generator produces valid crisp SVG for pairing URIs', () => {
  const uri = 'antigravityz://pair?url=http%3A%2F%2F100.64.0.10%3A19818&token=abc123XYZ_secretToken987654&name=StudioMac';
  const svg = generateQrSvg(uri);
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'));
  assert.ok(svg.includes('<path d="M'));
});

function createReadCursorFixture(t) {
  const sandbox = mkdtempSync(join(tmpdir(), 'agz-read-cursor-'));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const appData = join(sandbox, 'appData');
  const convId = '451186a3-1111-4222-8333-444444444444';
  const convDir = join(appData, 'brain', convId);
  const logsDir = join(convDir, '.system_generated', 'logs');
  mkdirSync(logsDir, { recursive: true });
  const transcript = join(logsDir, 'transcript.jsonl');
  const metaStore = new MetaStore({ stateDir: join(sandbox, 'state') });
  const scanner = new BrainScanner({ appDataDirs: [appData], projectsRoot: sandbox, projectsConfigDir: sandbox, metaStore });
  const replyTime = new Date(Math.floor(Date.now() / 1000) * 1000 - 10_000);
  const reply = {
    step_index: 17,
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    created_at: replyTime.toISOString(),
    content: 'alpha',
  };
  const writeTranscript = (steps, mtime) => {
    writeFileSync(transcript, `${steps.map((step) => JSON.stringify(step)).join('\n')}\n`);
    utimesSync(transcript, mtime, mtime);
  };
  const findConversation = async () => {
    const { workspaces } = await scanner.scanAll({ includeMetadata: false });
    const conversation = workspaces.flatMap((w) => w.conversations).find((c) => c.id === convId);
    assert.ok(conversation);
    return conversation;
  };
  writeTranscript([reply], replyTime);
  return { appData, convDir, convId, metaStore, scanner, replyTime, reply, writeTranscript, findConversation };
}

test('WebSocket presence advances the iOS viewed step and reply signature', { timeout: 5000 }, async (t) => {
  const { convId, metaStore, scanner } = createReadCursorFixture(t);
  const bridge = new BridgeServer({ port: 0, host: '127.0.0.1', metaStore, brainScanner: scanner });
  await bridge.start();
  try {
    const token = encodeURIComponent(metaStore.getToken());
    const ws = new WebSocket(`ws://127.0.0.1:${bridge.getBoundPort()}/api/v1/stream?token=${token}`);
    try {
      await new Promise((resolve, reject) => {
        const deadline = AbortSignal.timeout(3000);
        deadline.addEventListener('abort', () => reject(deadline.reason), { once: true });
        ws.addEventListener('error', reject, { once: true });
        ws.addEventListener('open', () => {
          ws.send(JSON.stringify({ type: 'presence', deviceId: 'test-ios', active: true, visibleConversationId: convId }));
          ws.send(JSON.stringify({ type: 'ping' }));
        }, { once: true });
        ws.addEventListener('message', (event) => {
          if (JSON.parse(String(event.data)).type === 'pong') resolve();
        });
      });
      const meta = metaStore.getConversationMeta(convId);
      assert.equal(meta?.iosViewedStepIndex, 17);
      assert.equal(meta?.iosViewedReplySig, scanner.getConversationReadCursor(convId).replySig);
    } finally {
      ws.close();
    }
  } finally {
    await bridge.stop();
  }
});

test('An equal-length edit to a read reply makes the same step unread again', async (t) => {
  const { convId, metaStore, scanner, replyTime, reply, writeTranscript, findConversation } = createReadCursorFixture(t);
  const cursor = scanner.getConversationReadCursor(convId);
  metaStore.markConversationViewed(convId, Date.now(), { stepIndex: 17, replySig: '17:5:0' });
  assert.equal((await findConversation()).hasUnread, false, 'Legacy read cursors remain valid');
  metaStore.markConversationViewed(convId, Date.now(), cursor);
  assert.equal((await findConversation()).hasUnread, false);

  writeTranscript([{ ...reply, content: 'omega' }], new Date(replyTime.getTime() + 1000));
  const editedCursor = scanner.getConversationReadCursor(convId);
  assert.equal(editedCursor.stepIndex, cursor.stepIndex);
  assert.notEqual(editedCursor.replySig, cursor.replySig);
  assert.equal((await findConversation()).hasUnread, true);
});

test('Trailing bookkeeping does not mark a Desktop-read reply unread', async (t) => {
  const { appData, convId, replyTime, reply, writeTranscript, findConversation } = createReadCursorFixture(t);
  const annotationsDir = join(appData, 'annotations');
  mkdirSync(annotationsDir);
  writeFileSync(join(annotationsDir, `${convId}.pbtxt`),
    `title:"Read reply" last_user_view_time:{seconds:${replyTime.getTime() / 1000 + 1} nanos:0}\n`);
  assert.equal((await findConversation()).hasUnread, false);

  const bookkeepingTime = new Date(replyTime.getTime() + 5000);
  writeTranscript([reply, {
    step_index: 18,
    type: 'SYSTEM_MESSAGE',
    status: 'DONE',
    created_at: bookkeepingTime.toISOString(),
    content: 'Background bookkeeping completed.',
  }], bookkeepingTime);
  assert.equal((await findConversation()).hasUnread, false);
});

test('MetaStore caps flag notes by code point and preserves an emoji at the boundary', (t) => {
  const sandbox = mkdtempSync(join(tmpdir(), 'agz-flag-note-'));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const metaStore = new MetaStore({ stateDir: sandbox });
  const expected = `${'a'.repeat(59)}🙂`;
  const { flagNote } = metaStore.setConversationFlagged('flag-note-test', true, ` ${expected}tail `);
  assert.equal(flagNote, expected);
  assert.equal(Array.from(flagNote).length, 60);
  assert.equal(flagNote.isWellFormed(), true);
});

test('BridgeServer handles Desktop titles, PreInvocation userMessage injection, questions, and APNs push', async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'agz-test-'));
  try {
    const appData = join(sandbox, 'antigravity');
    const projectsRoot = join(sandbox, 'Projects');
    mkdirSync(join(projectsRoot, 'AntigravityZ'), { recursive: true });
    mkdirSync(join(projectsRoot, 'DemoApp'), { recursive: true });
    mkdirSync(join(appData, 'annotations'), { recursive: true });

    const rootConvId = '11111111-2222-3333-4444-555555555555';
    const subConvId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

    const db = new DatabaseSync(join(appData, 'conversation_summaries.db'));
    db.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id text PRIMARY KEY,
        title text NOT NULL DEFAULT '',
        preview text NOT NULL DEFAULT '',
        step_count integer NOT NULL DEFAULT 0,
        last_modified_time datetime NOT NULL,
        workspace_uris text NOT NULL,
        status text NOT NULL DEFAULT '',
        parent_conversation_id text NOT NULL DEFAULT '',
        nesting_depth integer NOT NULL DEFAULT 0,
        not_fully_idle numeric NOT NULL DEFAULT 0,
        killed numeric NOT NULL DEFAULT 0
      );
    `);
    const ins = db.prepare(
      `INSERT INTO conversation_summaries
       (conversation_id, title, last_modified_time, workspace_uris, status, parent_conversation_id, nesting_depth, not_fully_idle, killed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`
    );
    ins.run(rootConvId, 'Demo Sync Module', '2026-11-19T01:30:00Z', `file://${join(projectsRoot, 'DemoApp')}`, 'CASCADE_RUN_STATUS_IDLE', '', 0, 0);
    ins.run(subConvId, '', '2026-11-19T01:25:00Z', `file://${join(projectsRoot, 'DemoApp')}`, 'CASCADE_RUN_STATUS_IDLE', rootConvId, 1, 0);
    db.close();

    writeFileSync(
      join(appData, 'annotations', `${rootConvId}.pbtxt`),
      'title:"Demo Sync Module"  last_user_view_time:{seconds:1795023268}  pinned:true\n',
      'utf-8'
    );

    const rootLogDir = join(appData, 'brain', rootConvId, '.system_generated', 'logs');
    const subLogDir = join(appData, 'brain', subConvId, '.system_generated', 'logs');
    mkdirSync(rootLogDir, { recursive: true });
    mkdirSync(subLogDir, { recursive: true });

    writeFileSync(join(appData, 'brain', rootConvId, 'architecture.md'), '# Architecture Plan\nReady.', 'utf-8');

    const rootTranscript = [
      JSON.stringify({
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-11-19T00:00:01Z',
        content:
          '<USER_REQUEST>\n检查一下 DemoApp 的同步模块\n</USER_REQUEST>\n<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Gemini 4 Carbon (High). No need to comment on this change.\n</USER_SETTINGS_CHANGE>',
      }),
      JSON.stringify({
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-19T00:00:03Z',
        thinking: '先读取同步配置',
        tool_calls: [{ name: 'read_file', args: { Path: join(projectsRoot, 'DemoApp', 'sync.swift') } }],
      }),
      JSON.stringify({
        step_index: 2,
        source: 'MODEL',
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-11-19T00:00:04Z',
        content: '1: import Foundation',
      }),
      JSON.stringify({
        step_index: 3,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-19T00:00:06Z',
        content: '同步模块一切正常！',
      }),
      // Simulate wakeup SYSTEM_MESSAGE + PreInvocation injected USER_INPUT deduplication
      // 1) SYSTEM_MESSAGE followed by USER_INPUT
      JSON.stringify({
        step_index: 4,
        source: 'SYSTEM',
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        created_at: '2026-11-19T00:01:00Z',
        content: '[AntigravityZ_USER_PROMPT id=ios-msg-1]\n<USER_PROMPT>\n顺便加个单元测试\n</USER_PROMPT>',
      }),
      JSON.stringify({
        step_index: 5,
        source: 'HOOK',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-11-19T00:01:01Z',
        content: '顺便加个单元测试',
      }),
      // 2) Real Antigravity 2.0 order: PreInvocation USER_INPUT BEFORE wakeup SYSTEM_MESSAGE!
      JSON.stringify({
        step_index: 6,
        source: 'SYSTEM_SDK',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-11-19T00:02:00Z',
        content: '<USER_REQUEST>\n再检查一下通知逻辑\n</USER_REQUEST>',
      }),
      JSON.stringify({
        step_index: 7,
        source: 'SYSTEM',
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        created_at: '2026-11-19T00:02:00Z',
        content: '[AntigravityZ_USER_PROMPT id=ios-msg-real-order]\n<USER_PROMPT>\n再检查一下通知逻辑\n</USER_PROMPT>',
      }),
    ].join('\n');
    writeFileSync(join(rootLogDir, 'transcript_full.jsonl'), rootTranscript, 'utf-8');

    const subTranscript = JSON.stringify({
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-11-19T00:00:05Z',
      content: 'Subagent research task',
    });
    writeFileSync(join(subLogDir, 'transcript_full.jsonl'), subTranscript, 'utf-8');

    const metaStore = new MetaStore({ stateDir: join(sandbox, 'state') });
    const sentCalls = [];
    const pushedAlerts = [];

    const mockApns = new ApnsPusher({
      metaStore,
      sendFn: async (req) => {
        pushedAlerts.push(req);
        return { sent: true, status: 200 };
      },
    });

    const mockController = new AgentController({
      agentApiPath: 'mock-agentapi',
      projectsRoot,
      expectedMount: sandbox,
      execFn: async (_bin, args) => {
        if (args[0] === 'get-conversation-metadata') {
          const cid = args[1];
          if (cid === rootConvId) {
            return {
              stdout: JSON.stringify({
                response: {
                  conversationMetadata: {
                    metadata: {
                      workspaceUris: [`file://${join(projectsRoot, 'DemoApp')}`],
                      parentConversationId: '',
                      nestingDepth: 0,
                    },
                  },
                },
              }),
            };
          }
          if (cid === subConvId) {
            return {
              stdout: JSON.stringify({
                response: {
                  conversationMetadata: {
                    metadata: {
                      workspaceUris: [`file://${join(projectsRoot, 'DemoApp')}`],
                      parentConversationId: rootConvId,
                      nestingDepth: 1,
                      subagentSpec: { role: 'Codebase Researcher' },
                    },
                  },
                },
              }),
            };
          }
        }
        if (args[0] === 'send-message') {
          sentCalls.push(args);
          return { stdout: '{"ok":true}', stderr: '' };
        }
        if (args[0] === 'new-conversation') {
          const newId = '99999999-8888-7777-6666-555555555555';
          const newLogDir = join(appData, 'brain', newId, '.system_generated', 'logs');
          mkdirSync(newLogDir, { recursive: true });
          writeFileSync(
            join(newLogDir, 'transcript_full.jsonl'),
            JSON.stringify({
              step_index: 0,
              source: 'USER_EXPLICIT',
              type: 'USER_INPUT',
              status: 'DONE',
              created_at: new Date().toISOString(),
              content: args[args.length - 1],
            }),
            'utf-8'
          );
          return { stdout: JSON.stringify({ conversationId: newId }), stderr: '' };
        }
        return { stdout: '{}', stderr: '' };
      },
    });

    const scanner = new BrainScanner({
      appDataDirs: [appData],
      projectsRoot,
      agentController: mockController,
      metaStore,
    });

    const scan = await scanner.scanAll();
    assert.equal(scan.workspaces.length, 1);
    assert.equal(scan.workspaces[0].name, 'DemoApp');
    const rootSummary = scan.workspaces[0].conversations[0];
    assert.equal(rootSummary.title, 'Demo Sync Module');
    assert.equal(rootSummary.pinned, true);
    assert.equal(rootSummary.currentModelShort, 'Carbon · High');

    // Verify deduplication in BOTH orders (`SYSTEM_MESSAGE -> USER_INPUT` and `USER_INPUT -> SYSTEM_MESSAGE`)
    const detail = await scanner.getConversationDetail(rootConvId);
    assert.equal(detail.items.length, 4);
    assert.equal(detail.items[2].id, 'ios-msg-1');
    assert.equal(detail.items[2].origin, 'ios');
    assert.equal(detail.items[2].content, '顺便加个单元测试');
    assert.equal(detail.items[3].id, 'ios-msg-real-order');
    assert.equal(detail.items[3].origin, 'ios');
    assert.equal(detail.items[3].content, '再检查一下通知逻辑');

    const bridge = new BridgeServer({
      port: 0,
      host: '127.0.0.1',
      metaStore,
      brainScanner: scanner,
      agentController: mockController,
      apnsPusher: mockApns,
      pollIntervalMs: 60_000,
    });
    await bridge.start();
    const port = bridge.getBoundPort();
    const token = metaStore.getToken();

    try {
      // Register APNs token
      const fakeDeviceToken = 'a1b2c3d4e5f60123456789abcdef0123456789abcdef0123456789abcdef0123';
      const regRes = await fetch(`http://127.0.0.1:${port}/api/v1/devices/push-token`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          token: fakeDeviceToken,
          environment: 'production',
          deviceId: 'ios-dev-1',
        }),
      });
      assert.equal(regRes.status, 200);
      const regJson = await regRes.json();
      assert.equal(regJson.apnsConfigured, true);

      // Update model + mode via /settings
      await fetch(`http://127.0.0.1:${port}/api/v1/conversations/${rootConvId}/settings`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: 'gemini-4-hydrogen-xhigh', mode: 'plan' }),
      });

      // Send message -> queues PreInvocation userMessage injection!
      const msgRes = await fetch(
        `http://127.0.0.1:${port}/api/v1/conversations/${rootConvId}/messages`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ text: '再跑一次测试', clientMessageId: 'ios-msg-2' }),
        }
      );
      assert.equal(msgRes.status, 200);

      // Simulate Antigravity PreInvocation hook -> MUST return `injectSteps` with `userMessage`!
      const preInvRes = await fetch(`http://127.0.0.1:${port}/internal/hook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-AntigravityZ-Hook-Secret': metaStore.getHookSecret(),
        },
        body: JSON.stringify({
          conversationId: rootConvId,
          hookEventName: 'PreInvocation',
        }),
      });
      assert.equal(preInvRes.status, 200);
      const preInvJson = await preInvRes.json();
      assert.ok(Array.isArray(preInvJson.hookResponse.injectSteps));
      assert.equal(preInvJson.hookResponse.injectSteps.some((s) => s.userMessage === '再跑一次测试'), true);

      // Second PreInvocation in same turn -> queue already drained, returns empty `{}`!
      const preInv2 = await (
        await fetch(`http://127.0.0.1:${port}/internal/hook`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-AntigravityZ-Hook-Secret': metaStore.getHookSecret(),
          },
          body: JSON.stringify({
            conversationId: rootConvId,
            hookEventName: 'PreInvocation',
          }),
        })
      ).json();
      assert.deepEqual(preInv2.hookResponse, {});

      // PreToolUse with ask_question -> surfaces pendingInteraction & returns decision: "allow"
      const preToolJson = await (
        await fetch(`http://127.0.0.1:${port}/internal/hook`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-AntigravityZ-Hook-Secret': metaStore.getHookSecret(),
          },
          body: JSON.stringify({
            conversationId: rootConvId,
            hookEventName: 'PreToolUse',
            toolCall: {
              id: 'tc-ask-1',
              name: 'ask_question',
              args: {
                questions: [{ question: '选择数据库引擎？', options: ['SQLite', 'Postgres'] }],
              },
            },
          }),
        })
      ).json();
      assert.equal(preToolJson.hookResponse.decision, 'allow');
      const detDuringQuestion = await scanner.getConversationDetail(rootConvId);
      assert.equal(detDuringQuestion.pendingInteraction?.kind, 'question');
      assert.deepEqual(detDuringQuestion.pendingInteraction?.options, ['SQLite', 'Postgres']);

      // Clear tool & simulate Stop hook while device is NOT viewing -> delivers APNs push!
      await fetch(`http://127.0.0.1:${port}/internal/hook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-AntigravityZ-Hook-Secret': metaStore.getHookSecret(),
        },
        body: JSON.stringify({
          conversationId: rootConvId,
          hookEventName: 'Stop',
          terminationReason: 'NO_TOOL_CALL',
          continuationActive: false,
        }),
      });
      await new Promise((r) => setTimeout(r, 80));
      assert.ok(pushedAlerts.length >= 1);
      const lastPush = pushedAlerts[pushedAlerts.length - 1];
      assert.equal(lastPush.payload.conversationId, rootConvId);
      assert.equal(lastPush.payload.aps.alert.title, 'Levity');
      assert.equal(lastPush.payload.aps.alert.subtitle, 'Demo Sync Module');

      // Binary attachment upload + message send + upload download
      const samplePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
      const upRes = await fetch(`http://127.0.0.1:${port}/api/v1/uploads`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'image/png',
          'X-File-Name': encodeURIComponent('屏幕截图.png'),
          'X-Conversation-Id': rootConvId,
        },
        body: samplePng,
      });
      assert.equal(upRes.status, 201);
      const upJson = await upRes.json();
      assert.equal(upJson.ok, true);
      assert.equal(upJson.kind, 'image');
      assert.equal(upJson.name, '屏幕截图.png');

      const attMsgRes = await fetch(
        `http://127.0.0.1:${port}/api/v1/conversations/${rootConvId}/messages`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            text: '看看这张截图',
            clientMessageId: 'ios-msg-att-1',
            attachments: [upJson.uploadId],
          }),
        }
      );
      assert.equal(attMsgRes.status, 200);
      const detWithAtt = await scanner.getConversationDetail(rootConvId);
      const attBubble = detWithAtt.items.find((it) => it.id === 'ios-msg-att-1');
      assert.ok(attBubble);
      assert.equal(attBubble.pending, false);
      assert.equal(attBubble.attachments.length, 1);
      assert.equal(attBubble.attachments[0].name, '屏幕截图.png');

      // Verify PreInvocation injects clean `userMessage` with attachment link and NO `systemMessage.metadata`
      // (Antigravity's protojson hook parser drops the entire `injectSteps` turn if `metadata.user_markdown` is sent).
      const attPreInvJson = await (
        await fetch(`http://127.0.0.1:${port}/internal/hook`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-AntigravityZ-Hook-Secret': metaStore.getHookSecret(),
          },
          body: JSON.stringify({
            conversationId: rootConvId,
            hookEventName: 'PreInvocation',
          }),
        })
      ).json();
      const userStep = attPreInvJson.hookResponse.injectSteps.find((s) => typeof s.userMessage === 'string');
      assert.ok(userStep, 'Expected userMessage step in PreInvocation injectSteps');
      assert.ok(userStep.userMessage.includes('[附件: 屏幕截图.png](file://'));
      const sysStep = attPreInvJson.hookResponse.injectSteps.find((s) => s.systemMessage);
      assert.ok(sysStep && sysStep.systemMessage.metadata === undefined, 'Must not include systemMessage.metadata that breaks protojson hook injection');

      // Verify tail pagination (`?limit=2`) and honest Desktop model precedence over stale desiredModel
      const pagedRes = await fetch(`http://127.0.0.1:${port}/api/v1/conversations/${rootConvId}?limit=2`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(pagedRes.status, 200);
      const pagedJson = await pagedRes.json();
      assert.equal(pagedJson.detail.items.length, 2);
      assert.ok(pagedJson.detail.totalItemCount >= 5);
      assert.equal(pagedJson.detail.hasMoreHistory, true);
      assert.equal(pagedJson.detail.currentModelId, 'gemini-4-carbon-high', 'Real Desktop model must take strict precedence over stale desiredModel');

      // Auto-approved BypassSandbox command (EVEN WITHOUT task log and after 30s!) MUST NEVER trigger permission_waiting!
      const convDbDir = join(appData, 'conversations');
      mkdirSync(convDbDir, { recursive: true });
      const convDbPath = join(convDbDir, `${rootConvId}.db`);
      const cdb = new DatabaseSync(convDbPath);
      cdb.exec(`
        CREATE TABLE steps (
          idx integer PRIMARY KEY,
          step_type integer NOT NULL DEFAULT 0,
          status integer NOT NULL DEFAULT 0,
          permissions blob,
          step_payload blob
        );
      `);
      // Step 99 is RUNNING (status=2) with permissions=NULL (auto-approved!)
      cdb.prepare('INSERT INTO steps (idx, step_type, status, permissions, step_payload) VALUES (?, ?, ?, ?, ?)').run(99, 132, 2, null, null);
      cdb.close();

      scanner.recordHookEvent({
        conversationId: rootConvId,
        hookEventName: 'PreToolUse',
        stepIdx: 99,
        toolCall: {
          id: 'tc-auto-99',
          name: 'run_command',
          args: { BypassSandbox: true, CommandLine: 'xcodebuild archive' },
        },
      });
      scanner.inFlightTools.get(rootConvId).startedAt = Date.now() - 30_000;
      const detDuringAutoCmd = await scanner.getConversationDetail(rootConvId);
      assert.equal(detDuringAutoCmd.pendingInteraction, null);

      // Genuinely blocked permission step in conversations/<id>.db: status=9 WAITING with permissions=NULL (exact live Antigravity behavior!)
      const fakePayload = Buffer.from(
        '\x0a\x10call_1234567890\x12\x0brun_command\x1a{"BypassSandbox":true,"CommandLine":"git push origin v0.1.0-build12","toolSummary":"Push v0.1.0-build12 tag to GitHub"}"\x03ask*Pushing the tag modifies remote repository refs and may publish the tag publicly.',
        'utf8'
      );
      const cdb2 = new DatabaseSync(convDbPath);
      cdb2
        .prepare('INSERT INTO steps (idx, step_type, status, permissions, step_payload) VALUES (?, ?, ?, ?, ?)')
        .run(100, 132, 9, null, fakePayload);
      cdb2.close();
      scanner.convStepsDbCache.clear();
      const detDuringRealBlock = await scanner.getConversationDetail(rootConvId);
      assert.equal(detDuringRealBlock.pendingInteraction?.kind, 'permission_waiting');
      assert.equal(detDuringRealBlock.pendingInteraction?.title, '等待授权 · Push v0.1.0-build12 tag to GitHub');
      assert.ok(detDuringRealBlock.pendingInteraction?.prompt.includes('git push origin v0.1.0-build12'));
      assert.ok(detDuringRealBlock.pendingInteraction?.prompt.includes('modifies remote repository refs'));

      // Once user clicks Allow (status transitions to 2 RUNNING or 3 DONE), permission_waiting clears immediately!
      const cdb3 = new DatabaseSync(convDbPath);
      cdb3.prepare('UPDATE steps SET status = 2 WHERE idx = 100').run();
      cdb3.close();
      scanner.convStepsDbCache.clear();
      const detAfterApprove = await scanner.getConversationDetail(rootConvId);
      assert.equal(detAfterApprove.pendingInteraction, null);

      // Distinct events in the same conversation MUST use distinct collapseIds so Notification Center never eats previous alerts!
      await mockApns.notifyConversation({
        conversationId: rootConvId,
        title: 'Antigravity',
        body: 'First alert',
        eventKey: 'evt-1',
        force: true,
      });
      await mockApns.notifyConversation({
        conversationId: rootConvId,
        title: 'Antigravity',
        body: 'Second alert',
        eventKey: 'evt-2',
        force: true,
      });
      const pushA = pushedAlerts[pushedAlerts.length - 2];
      const pushB = pushedAlerts[pushedAlerts.length - 1];
      assert.notEqual(pushA.collapseId, pushB.collapseId);

      const dlRes = await fetch(
        `http://127.0.0.1:${port}/api/v1/conversations/${rootConvId}/uploads/${encodeURIComponent(upJson.fileName)}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      assert.equal(dlRes.status, 200);
      const dlBuf = Buffer.from(await dlRes.arrayBuffer());
      assert.deepEqual(dlBuf, samplePng);

      // Foreground presence suppression: when actively viewing rootConvId, APNs alert is suppressed!
      const countBefore = pushedAlerts.length;
      await fetch(`http://127.0.0.1:${port}/api/v1/devices/presence`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          deviceId: 'ios-dev-1',
          active: true,
          visibleConversationId: rootConvId,
        }),
      });
      const supRes = await mockApns.notifyConversation({
        conversationId: rootConvId,
        title: 'Antigravity',
        body: 'Should be suppressed',
        kind: 'completed',
      });
      assert.equal(supRes.suppressed, true);
      assert.equal(pushedAlerts.length, countBefore);

      // Subagent Stop hook MUST NEVER send user-facing APNs push alerts (`会话 xxxxxxx` spam prevention!)
      const beforeSubagentStopCount = pushedAlerts.length;
      const subStopRes = await fetch(`http://127.0.0.1:${port}/internal/hook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-AntigravityZ-Hook-Secret': metaStore.getHookSecret(),
        },
        body: JSON.stringify({
          conversationId: subConvId,
          hookEventName: 'Stop',
          terminationReason: 'COMPLETED',
        }),
      });
      assert.equal(subStopRes.status, 200);
      await new Promise((r) => setTimeout(r, 80));
      assert.equal(pushedAlerts.length, beforeSubagentStopCount, 'Subagent Stop hook must not trigger APNs alert');

      // Push toggle OFF -> DELETE by deviceId unregisters device cleanly
      const delRes = await fetch(`http://127.0.0.1:${port}/api/v1/devices/push-token`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ deviceId: 'ios-dev-1' }),
      });
      assert.equal(delRes.status, 200);
      assert.equal(metaStore.listPushDevices().length, 0);
    } finally {
      await bridge.stop();
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('BrainScanner extracts assistant inline artifact images and serves them via uploads route', async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'agz-img-test-'));
  try {
    const appData = join(sandbox, 'antigravity');
    const convId = '22222222-3333-4444-5555-666666666666';
    const convDir = join(appData, 'brain', convId);
    const logDir = join(convDir, '.system_generated', 'logs');
    mkdirSync(logDir, { recursive: true });

    const imgPath = join(convDir, 'preview_card.png');
    const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
    writeFileSync(imgPath, fakePng);

    const transcript = [
      JSON.stringify({
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-11-20T07:00:00Z',
        content: '<USER_REQUEST>\n给我看看截图\n</USER_REQUEST>',
      }),
      JSON.stringify({
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-20T07:00:05Z',
        content: `效果图在这里：\n\n![主页预览](${imgPath})\n\n你看看合适吗？`,
      }),
    ].join('\n');
    writeFileSync(join(logDir, 'transcript_full.jsonl'), `${transcript}\n`, 'utf-8');

    const scanner = new BrainScanner({ appDataDirs: [appData] });
    const detail = await scanner.getConversationDetail(convId);
    assert.ok(detail);
    const assistant = detail.items.find((i) => i.role === 'assistant');
    assert.ok(assistant);
    assert.equal(assistant.attachments.length, 1);
    assert.equal(assistant.attachments[0].fileName, 'preview_card.png');
    assert.equal(assistant.attachments[0].name, '主页预览');
    assert.equal(assistant.attachments[0].kind, 'image');
    assert.equal(assistant.attachments[0].mimeType, 'image/png');
    assert.ok(!assistant.content.includes(imgPath));
    assert.ok(assistant.content.includes('效果图在这里'));
    assert.ok(assistant.content.includes('你看看合适吗？'));

    const resolved = scanner.resolveUploadedFilePath(convId, 'preview_card.png');
    assert.equal(resolved, imgPath);
    assert.equal(scanner.resolveUploadedFilePath(convId, '../escape.png'), null);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('BrainScanner keeps verified inline images in prose, comparison tables, and carousel fences', async (t) => {
  const { convDir, writeTranscript, findConversation, scanner, convId, reply } = createReadCursorFixture(t);
  const bytes = Buffer.from('test image');
  for (const name of ['a.png', 'b preview.png', 'extra.png', 'figure (1).png']) {
    writeFileSync(join(convDir, name), bytes);
  }
  const a = `![desc1](${join(convDir, 'a.png')})`;
  const b = `![desc2](${join(convDir, 'b%20preview.png')})`;
  const c = `![](file://${join(convDir, 'figure%20(1).png')})`;
  writeTranscript([{
    ...reply,
    content: `Prose A\n${a}\nProse B\n${b}\n\n| Title 1 | Title 2 |\n| --- | --- |\n| ${a} | ${b} |\n\n\`\`\`\`carousel\n${c}\n<!-- slide -->\n${a}\n\`\`\`\``,
    media: [{ uri: join(convDir, 'extra.png') }],
  }], new Date(reply.created_at));

  const aToken = '![desc1](levity-attachment://a.png)';
  const bToken = '![desc2](levity-attachment://b%20preview.png)';
  const cToken = '![](levity-attachment://figure%20%281%29.png)';
  const detail = await scanner.getConversationDetail(convId);
  const assistant = detail.items.find((item) => item.role === 'assistant');
  assert.equal(assistant.content, [
    'Prose A', aToken, 'Prose B', bToken, '',
    '| Title 1 | Title 2 |', '| --- | --- |', `| ${aToken} | ${bToken} |`, '',
    '````carousel', cToken, '<!-- slide -->', aToken, '````',
  ].join('\n'));
  assert.ok(!assistant.content.includes(convDir));
  assert.ok(!assistant.content.includes('/Users/'));
  assert.ok(!assistant.content.includes('extra.png'));
  assert.deepEqual(assistant.attachments, [
    ['extra.png', 'extra.png'], ['a.png', 'desc1'], ['b preview.png', 'desc2'], ['figure (1).png', 'figure (1).png'],
  ].map(([fileName, name]) => ({
    id: `img-${fileName}`, name, fileName, kind: 'image', mimeType: 'image/png', sizeBytes: bytes.length,
  })));
  assert.equal(scanner.resolveUploadedFilePath(convId, 'b preview.png'), join(convDir, 'b preview.png'));

  const { lastPreview } = await findConversation();
  assert.ok(lastPreview.startsWith('Prose A [图片: desc1] Prose B [图片: desc2]'));
  assert.ok(!lastPreview.includes('levity-attachment://'));
});

test('BrainScanner leaves absolute, encoded traversal, and symlink image escapes unregistered', async (t) => {
  const { convDir, writeTranscript, scanner, convId, reply } = createReadCursorFixture(t);
  const outside = `${convDir}-sibling`;
  mkdirSync(outside);
  writeFileSync(join(outside, 'escape.png'), 'test image');
  const symlink = join(convDir, 'escape-link.png');
  symlinkSync(join(outside, 'escape.png'), symlink);
  const escapedTarget = `${convDir}/%2e%2e/${convId}-sibling/escape.png`;
  const content = [
    `![absolute](${join(outside, 'escape.png')})`,
    `![encoded](${escapedTarget})`,
    `![linked](${symlink})`,
  ].join('\n');
  writeTranscript([{ ...reply, content, media: [{ uri: symlink }] }], new Date(reply.created_at));
  const detail = await scanner.getConversationDetail(convId);
  const assistant = detail.items.find((item) => item.role === 'assistant');
  assert.equal(assistant.content, content);
  assert.equal(assistant.attachments?.length ?? 0, 0);
});

test('BrainScanner preserves old read receipts for replies whose images were previously stripped', async (t) => {
  const { convDir, writeTranscript, findConversation, scanner, convId, metaStore, reply } = createReadCursorFixture(t);
  const image = join(convDir, 'preview.png');
  writeFileSync(image, 'test image');
  const oldContent = 'Before\n\nAfter';
  const oldDigest = createHash('sha256').update(oldContent).digest('hex').slice(0, 16);
  writeTranscript([{ ...reply, content: `Before\n![Original](${image})\nAfter` }], new Date(reply.created_at));
  metaStore.markConversationViewed(convId, Date.now(), { stepIndex: 17, replySig: `17:${oldContent.length}:1:${oldDigest}` });
  assert.equal((await findConversation()).hasUnread, false);

  metaStore.markConversationViewed(convId, Date.now(), scanner.getConversationReadCursor(convId));
  writeTranscript([{ ...reply, content: `Before\n![New crop](${image})\nAfter` }], new Date(Date.now() + 1_000));
  assert.equal((await findConversation()).hasUnread, true);
});

test('APNs previews include inline image captions without any attachment URI', async () => {
  const alerts = [];
  const pusher = new ApnsPusher({
    keyPath: '',
    metaStore: { listPushDevices: () => [{ token: 'a'.repeat(64), environment: 'sandbox' }] },
    sendFn: async ({ payload }) => {
      alerts.push(payload.aps.alert);
      return { sent: true };
    },
  });
  const result = await pusher.notifyConversation({
    conversationId: 'test-inline-images',
    title: 'Levity',
    body: 'Before\n![Dark mode](levity-attachment://dark%20mode.png)\n![](levity-attachment://light.png)\nAfter',
  });
  assert.equal(result.sent, 1);
  assert.deepEqual(alerts, [{ title: 'Levity', body: 'Before [图片: Dark mode] [图片] After' }]);
});

test('BridgeServer emits workspaces_updated on preview change and resync_required when since_seq exceeds server epoch', async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'agz-resync-test-'));
  try {
    const appData = join(sandbox, 'antigravity');
    const stateDir = join(sandbox, 'state');
    const convId = '33333333-4444-5555-6666-777777777777';
    const logDir = join(appData, 'brain', convId, '.system_generated', 'logs');
    mkdirSync(logDir, { recursive: true });
    const tPath = join(logDir, 'transcript_full.jsonl');

    const writeTranscript = (assistantText) => {
      const lines = [
        JSON.stringify({
          step_index: 0,
          source: 'USER_EXPLICIT',
          type: 'USER_INPUT',
          status: 'DONE',
          created_at: '2026-11-20T17:00:00Z',
          content: '<USER_REQUEST>\n检查首页自动刷新\n</USER_REQUEST>',
        }),
        JSON.stringify({
          step_index: 1,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: '2026-11-20T17:00:05Z',
          content: assistantText,
        }),
      ];
      writeFileSync(tPath, `${lines.join('\n')}\n`, 'utf-8');
    };

    writeTranscript('旧的预览文本');

    const metaStore = new MetaStore({ stateDir });
    const scanner = new BrainScanner({ appDataDirs: [appData], metaStore });
    const bridge = new BridgeServer({
      port: 0,
      host: '127.0.0.1',
      metaStore,
      brainScanner: scanner,
      agentController: { isAvailable: () => false },
      pollIntervalMs: 60_000,
    });
    await bridge.start();
    const port = bridge.getBoundPort();
    const token = metaStore.getToken();

    try {
      // 1. Same stepCount/messageCount, ONLY lastPreview text updated -> MUST emit workspaces_updated!
      const seqBefore = bridge.seq;
      writeTranscript('刚刚完成思考的新预览消息内容');
      await bridge.pollChanges();
      assert.ok(bridge.seq > seqBefore, 'pollChanges must detect lastPreview updates even when stepCount is unchanged');
      assert.ok(
        bridge.ringBuffer.some((ev) => ev.type === 'workspaces_updated'),
        'workspaces_updated event must be emitted on preview change'
      );

      // 2. Client reconnects with stale future since_seq > server.seq -> MUST receive resync_required!
      const wsUrl = `ws://127.0.0.1:${port}/api/v1/stream?token=${encodeURIComponent(token)}&since_seq=9999`;
      const receivedTypes = await new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        const types = [];
        const timer = setTimeout(() => {
          ws.close();
          resolve(types);
        }, 1200);
        ws.addEventListener('message', (evt) => {
          try {
            const parsed = JSON.parse(String(evt.data));
            types.push(parsed.type);
            if (parsed.type === 'resync_required') {
              clearTimeout(timer);
              ws.close();
              resolve(types);
            }
          } catch {
            // ignore
          }
        });
        ws.addEventListener('error', (e) => {
          clearTimeout(timer);
          reject(e);
        });
      });
      assert.ok(receivedTypes.includes('hello'));
      assert.ok(receivedTypes.includes('resync_required'));
    } finally {
      await bridge.stop();
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('BridgeServer computes dual-synced hasUnread from Desktop annotations + /read receipts and sets APNs badge', async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'agz-unread-test-'));
  try {
    const appData = join(sandbox, 'antigravity');
    const stateDir = join(sandbox, 'state');
    const annDir = join(appData, 'annotations');
    mkdirSync(annDir, { recursive: true });

    const convId = '44444444-5555-6666-7777-888888888888';
    const logDir = join(appData, 'brain', convId, '.system_generated', 'logs');
    mkdirSync(logDir, { recursive: true });

    const replyEpochSec = Math.floor(Date.now() / 1000) - 30;
    const oldViewSec = replyEpochSec - 120;
    writeFileSync(
      join(annDir, `${convId}.pbtxt`),
      `title:"Unread Demo" last_user_view_time:{seconds:${oldViewSec} nanos:0} pinned:true\n`,
      'utf-8'
    );

    const tLines = [
      JSON.stringify({
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: new Date((oldViewSec - 10) * 1000).toISOString(),
        content: '<USER_REQUEST>\n帮我跑一下验证\n</USER_REQUEST>',
      }),
      JSON.stringify({
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: new Date(replyEpochSec * 1000).toISOString(),
        content: '全部验证完成，请查阅。',
      }),
    ];
    writeFileSync(join(logDir, 'transcript_full.jsonl'), `${tLines.join('\n')}\n`, 'utf-8');

    const metaStore = new MetaStore({ stateDir });
    const capturedPayloads = [];
    const mockApns = new ApnsPusher({
      metaStore,
      sendFn: async ({ payload }) => {
        capturedPayloads.push(payload);
        return { sent: true, status: 200 };
      },
    });
    metaStore.registerPushDevice({
      token: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
      environment: 'production',
      deviceId: 'ios-unread-dev',
    });

    const scanner = new BrainScanner({ appDataDirs: [appData], metaStore });
    const bridge = new BridgeServer({
      port: 0,
      host: '127.0.0.1',
      metaStore,
      brainScanner: scanner,
      agentController: { isAvailable: () => false },
      apnsPusher: mockApns,
      pollIntervalMs: 60_000,
    });
    await bridge.start();
    const port = bridge.getBoundPort();
    const token = metaStore.getToken();

    try {
      const boot1 = await (
        await fetch(`http://127.0.0.1:${port}/api/v1/bootstrap`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).json();
      assert.equal(boot1.workspaces[0].conversations[0].hasUnread, true);

      // Stop hook alert should carry aps.badge >= 1
      await fetch(`http://127.0.0.1:${port}/internal/hook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-AntigravityZ-Hook-Secret': metaStore.getHookSecret(),
        },
        body: JSON.stringify({
          conversationId: convId,
          hookEventName: 'Stop',
          terminationReason: 'COMPLETED',
        }),
      });
      await new Promise((r) => setTimeout(r, 100));
      assert.ok(capturedPayloads.length >= 1);
      assert.equal(capturedPayloads[capturedPayloads.length - 1].aps.badge, 1);

      // Marking read via /read must immediately clear hasUnread and unreadCount
      const readRes = await (
        await fetch(`http://127.0.0.1:${port}/api/v1/conversations/${convId}/read`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        })
      ).json();
      assert.equal(readRes.ok, true);
      assert.equal(readRes.unreadCount, 0);

      const boot2 = await (
        await fetch(`http://127.0.0.1:${port}/api/v1/bootstrap`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).json();
      assert.equal(boot2.workspaces[0].conversations[0].hasUnread, false);
    } finally {
      await bridge.stop();
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('BridgeServer detects status=2 SQLite ask_question immediately before answer and blocks post-submit ghost alerts', async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'agz-askq-test-'));
  try {
    const appData = join(sandbox, 'appdata');
    const brainRoot = join(appData, 'brain');
    const convsDir = join(appData, 'conversations');
    const stateDir = join(sandbox, 'state');
    const convId = '77777777-8888-9999-aaaa-bbbbbbbbbbbb';
    const logDir = join(brainRoot, convId, '.system_generated', 'logs');
    mkdirSync(logDir, { recursive: true });
    mkdirSync(convsDir, { recursive: true });
    mkdirSync(stateDir, { recursive: true });

    writeFileSync(
      join(logDir, 'transcript_full.jsonl'),
      `${JSON.stringify({
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: new Date().toISOString(),
        content: '帮我选方案',
      })}\n`,
      'utf-8'
    );

    const dbPath = join(convsDir, `${convId}.db`);
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, status INTEGER, permissions BLOB, step_payload BLOB)');
    const nestedArgs = JSON.stringify({
      questions: [
        {
          is_multi_select: false,
          question: '选哪个配色？',
          options: ['深空星云', '液态极光'],
        },
      ],
    });
    const fakePayload = Buffer.from(`\x0a\x18call_123456789\x12\x0cask_question\x1a\x90${nestedArgs}`, 'utf8');
    db.prepare('INSERT INTO steps (idx, status, permissions, step_payload) VALUES (?, ?, NULL, ?)').run(1, 2, fakePayload);
    db.close();

    const metaStore = new MetaStore({ stateDir });
    const capturedPayloads = [];
    const mockApns = new ApnsPusher({
      metaStore,
      sendFn: async ({ payload }) => {
        capturedPayloads.push(payload);
        return { sent: true, status: 200 };
      },
    });
    metaStore.registerPushDevice({
      token: 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
      environment: 'production',
      deviceId: 'ios-askq-dev',
    });

    const scanner = new BrainScanner({ appDataDirs: [appData], metaStore });
    const bridge = new BridgeServer({
      port: 0,
      host: '127.0.0.1',
      metaStore,
      brainScanner: scanner,
      agentController: { isAvailable: () => false },
      apnsPusher: mockApns,
      pollIntervalMs: 60_000,
    });
    await bridge.start();
    try {
      // Advance seq past initial boot
      bridge.seq = 1;
      await bridge.pollChanges();
      await new Promise((r) => setTimeout(r, 80));

      assert.equal(capturedPayloads.length, 1, 'Must fire action_required push IMMEDIATELY while ask_question is status=2');
      assert.equal(capturedPayloads[0].kind, 'action_required');
      assert.equal(capturedPayloads[0].aps.alert.body, '选哪个配色？');

      // Now simulate user submitting answer: SQLite flips to status=3 (DONE),
      // while transcript_full.jsonl briefly flushes PLANNER_RESPONSE before GENERIC DONE!
      const db2 = new DatabaseSync(dbPath);
      db2.prepare('UPDATE steps SET status = 3 WHERE idx = 1').run();
      db2.close();
      scanner.convStepsDbCache.clear();
      writeFileSync(
        join(logDir, 'transcript_full.jsonl'),
        [
          JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: new Date().toISOString(), content: '帮我选方案' }),
          JSON.stringify({
            step_index: 1,
            source: 'MODEL',
            type: 'PLANNER_RESPONSE',
            status: 'DONE',
            created_at: new Date().toISOString(),
            content: '',
            tool_calls: [{ id: 'call_late_lag', name: 'ask_question', args: { questions: nestedArgs } }],
          }),
        ].join('\n') + '\n',
        'utf-8'
      );

      await bridge.pollChanges();
      await new Promise((r) => setTimeout(r, 80));
      assert.equal(capturedPayloads.length, 1, 'Must NOT fire a ghost notification after SQLite marks ask_question DONE!');
    } finally {
      await bridge.stop();
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('BrainScanner deduplicates USER_INPUT and SYSTEM_MESSAGE even when PreInvocation strips emoji ZWJ characters', async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'agz-zwj-test-'));
  try {
    const appData = join(sandbox, 'appdata');
    const convId = '88888888-9999-aaaa-bbbb-cccccccccccc';
    const logDir = join(appData, 'brain', convId, '.system_generated', 'logs');
    mkdirSync(logDir, { recursive: true });
    writeFileSync(
      join(logDir, 'transcript_full.jsonl'),
      [
        JSON.stringify({
          step_index: 10,
          source: 'SYSTEM_SDK',
          type: 'USER_INPUT',
          status: 'DONE',
          created_at: '2026-11-21T11:21:46Z',
          content: '<USER_REQUEST>\n我还没改完呢🤦♂️ 再改改\n</USER_REQUEST>',
        }),
        JSON.stringify({
          step_index: 12,
          source: 'SYSTEM',
          type: 'SYSTEM_MESSAGE',
          status: 'DONE',
          created_at: '2026-11-21T11:21:46Z',
          content:
            '[AntigravityZ_USER_PROMPT id=ios-zwj-001]\n<USER_PROMPT>\n我还没改完呢🤦\u200d♂️ 再改改\n</USER_PROMPT>',
        }),
      ].join('\n') + '\n',
      'utf-8'
    );
    const scanner = new BrainScanner({ appDataDirs: [appData] });
    const detail = await scanner.getConversationDetail(convId);
    const userItems = detail.items.filter((i) => i.role === 'user');
    assert.equal(userItems.length, 1, 'ZWJ-stripped USER_INPUT and original SYSTEM_MESSAGE must merge into 1 bubble');
    assert.equal(userItems[0].id, 'ios-zwj-001');
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('AgentController targets outside-of-project and homedir for general chats, and BrainScanner never fabricates projects from transcripts', async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'agz-proj-test-'));
  try {
    const appData = join(sandbox, 'antigravity');
    const projectsRoot = join(sandbox, 'Projects');
    const projectsCfgDir = join(sandbox, 'config', 'projects');
    mkdirSync(join(projectsRoot, 'SecretRepo'), { recursive: true });
    mkdirSync(projectsCfgDir, { recursive: true });
    mkdirSync(join(appData, 'annotations'), { recursive: true });

    // One real user Desktop project + one hidden sidecar project
    const realProjId = '1111aaaa-2222-3333-4444-555566667777';
    const sidecarProjId = '9e2ff9e9-3ee9-47b3-bb41-d4c5f7d3f003';
    writeFileSync(
      join(projectsCfgDir, `${realProjId}.json`),
      JSON.stringify({
        id: realProjId,
        name: 'RealDesktopProj',
        projectResources: { localFolders: [{ uri: `file://${join(projectsRoot, 'SecretRepo')}` }] },
      }),
      'utf-8'
    );
    writeFileSync(
      join(projectsCfgDir, `${sidecarProjId}.json`),
      JSON.stringify({
        id: sidecarProjId,
        name: 'antigravity-z/bridge',
        projectResources: {},
        sidecar: { sidecarId: 'antigravity-z/bridge' },
      }),
      'utf-8'
    );

    const freeConvId = 'f1111111-2222-3333-4444-555555555551';
    const realProjConvId = 'f1111111-2222-3333-4444-555555555552';
    const sidecarConvId = 'f1111111-2222-3333-4444-555555555553';

    const db = new DatabaseSync(join(appData, 'conversation_summaries.db'));
    db.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id text PRIMARY KEY,
        title text NOT NULL DEFAULT '',
        preview text NOT NULL DEFAULT '',
        step_count integer NOT NULL DEFAULT 0,
        last_modified_time datetime NOT NULL,
        workspace_uris text NOT NULL,
        project_id text NOT NULL DEFAULT '',
        status text NOT NULL DEFAULT '',
        parent_conversation_id text NOT NULL DEFAULT '',
        nesting_depth integer NOT NULL DEFAULT 0,
        not_fully_idle numeric NOT NULL DEFAULT 0,
        killed numeric NOT NULL DEFAULT 0
      );
    `);
    const ins = db.prepare(
      `INSERT INTO conversation_summaries
       (conversation_id, title, last_modified_time, workspace_uris, project_id, status, parent_conversation_id, nesting_depth, not_fully_idle, killed)
       VALUES (?, ?, ?, ?, ?, 'CASCADE_RUN_STATUS_IDLE', '', 0, 0, 0)`
    );
    ins.run(freeConvId, 'Free Chat Mentioning Repo', '2026-11-22T02:00:00Z', '', 'outside-of-project');
    ins.run(realProjConvId, 'Real Project Chat', '2026-11-22T02:01:00Z', '', realProjId);
    ins.run(sidecarConvId, 'Legacy Sidecar Chat', '2026-11-22T02:02:00Z', '', sidecarProjId);
    db.close();

    for (const [cid, txt] of [
      [freeConvId, `帮我看下 ${join(projectsRoot, 'SecretRepo', 'main.swift')}`],
      [realProjConvId, '检查真实项目'],
      [sidecarConvId, 'Surge 网络排查'],
    ]) {
      const logDir = join(appData, 'brain', cid, '.system_generated', 'logs');
      mkdirSync(logDir, { recursive: true });
      writeFileSync(
        join(logDir, 'transcript_full.jsonl'),
        JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-22T02:00:00Z', content: txt }) + '\n',
        'utf-8'
      );
    }

    const capturedOpts = [];
    const controller = new AgentController({
      agentApiPath: 'mock-agentapi',
      projectsRoot,
      execFn: async (_bin, args, opts) => {
        capturedOpts.push({ args, cwd: opts?.cwd, projectId: opts?.env?.ANTIGRAVITY_PROJECT_ID });
        return { stdout: JSON.stringify({ conversationId: freeConvId }), stderr: '' };
      },
    });
    await controller.createConversation({ prompt: '自由聊聊', workspacePath: '' });
    assert.equal(capturedOpts[0].projectId, 'outside-of-project', 'General chat must target outside-of-project');
    assert.notEqual(capturedOpts[0].cwd, process.cwd(), 'General chat cwd must not stay inside plugin dir');

    const scanner = new BrainScanner({
      appDataDirs: [appData],
      projectsRoot,
      projectsConfigDir: projectsCfgDir,
    });
    const scan = await scanner.scanAll({ includeMetadata: false });
    const allConvs = scan.workspaces.flatMap((w) => w.conversations);
    const freeSummary = allConvs.find((c) => c.id === freeConvId);
    const realSummary = allConvs.find((c) => c.id === realProjConvId);
    const sidecarSummary = allConvs.find((c) => c.id === sidecarConvId);

    assert.equal(freeSummary.workspacePath, null, 'Free chat must NOT fabricate a project from chat transcript paths');
    assert.equal(freeSummary.workspaceName, '通用对话');
    assert.equal(realSummary.workspaceName, 'RealDesktopProj', 'Real Desktop project must sync 1:1');
    assert.equal(sidecarSummary.workspacePath, null, 'Hidden sidecar project must NOT leak as a user project');
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('BridgeServer syncs Desktop annotations/*.pbtxt renames immediately and returns 501 for mobile-only /rename', async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'agz-rename-sync-'));
  try {
    const appData = join(sandbox, 'antigravity');
    const convId = 'd1111111-2222-3333-4444-555555555555';
    mkdirSync(join(appData, 'annotations'), { recursive: true });
    const logDir = join(appData, 'brain', convId, '.system_generated', 'logs');
    mkdirSync(logDir, { recursive: true });

    const db = new DatabaseSync(join(appData, 'conversation_summaries.db'));
    db.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id text PRIMARY KEY,
        title text NOT NULL DEFAULT '',
        preview text NOT NULL DEFAULT '',
        step_count integer NOT NULL DEFAULT 0,
        last_modified_time datetime NOT NULL,
        workspace_uris text NOT NULL,
        project_id text NOT NULL DEFAULT '',
        status text NOT NULL DEFAULT '',
        parent_conversation_id text NOT NULL DEFAULT '',
        nesting_depth integer NOT NULL DEFAULT 0,
        not_fully_idle numeric NOT NULL DEFAULT 0,
        killed numeric NOT NULL DEFAULT 0
      );
    `);
    db.prepare(
      `INSERT INTO conversation_summaries
       (conversation_id, title, last_modified_time, workspace_uris, project_id, status, parent_conversation_id, nesting_depth, not_fully_idle, killed)
       VALUES (?, 'Original Desktop Title', '2026-11-22T02:00:00Z', '', 'outside-of-project', 'CASCADE_RUN_STATUS_IDLE', '', 0, 0, 0)`
    ).run(convId);
    db.close();

    writeFileSync(
      join(appData, 'annotations', `${convId}.pbtxt`),
      'title:"Original Desktop Title" last_user_view_time:{seconds:1795315800}\n',
      'utf-8'
    );
    writeFileSync(
      join(logDir, 'transcript_full.jsonl'),
      JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-22T02:00:00Z', content: '你好' }) + '\n',
      'utf-8'
    );

    const metaStore = new MetaStore({ stateDir: join(sandbox, 'state') });
    // Even if a legacy mobile alias exists in metaStore, Desktop title must win!
    metaStore.setConversationTitle(convId, 'Stale Mobile Alias');

    const scanner = new BrainScanner({ appDataDirs: [appData], metaStore });
    const bridge = new BridgeServer({
      port: 0,
      host: '127.0.0.1',
      metaStore,
      brainScanner: scanner,
      agentController: new AgentController({ agentApiPath: 'mock-agentapi', execFn: async () => ({ stdout: '{}' }) }),
      pollIntervalMs: 60_000,
    });
    await bridge.start();
    const port = bridge.getBoundPort();
    const token = metaStore.getToken();

    try {
      // Initial baseline poll
      await bridge.pollChanges();
      const d1 = await scanner.getConversationDetail(convId);
      assert.equal(d1.title, 'Original Desktop Title', 'Desktop title must always override stale mobile alias');

      // Mobile /rename must honestly return 501 instead of creating a fake local-only title
      const renameRes = await fetch(`http://127.0.0.1:${port}/api/v1/conversations/${convId}/rename`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Fake Mobile Name' }),
      });
      assert.equal(renameRes.status, 501);

      // Now simulate user renaming on Desktop (updates annotations/<id>.pbtxt even before SQLite WAL!)
      bridge.ringBuffer.length = 0;
      await new Promise((r) => setTimeout(r, 20));
      writeFileSync(
        join(appData, 'annotations', `${convId}.pbtxt`),
        'title:"桌面端新标题 🚀" last_user_view_time:{seconds:1795315900}\n',
        'utf-8'
      );

      await bridge.pollChanges();
      const convEv = bridge.ringBuffer.find((e) => e.type === 'conversation_updated' && e.conversationId === convId);
      const wsEv = bridge.ringBuffer.find((e) => e.type === 'workspaces_updated');
      assert.ok(convEv, 'Desktop rename must emit conversation_updated immediately');
      assert.equal(convEv.detail.title, '桌面端新标题 🚀');
      assert.ok(wsEv, 'Desktop rename must emit workspaces_updated immediately');
      assert.equal(wsEv.workspaces[0].conversations[0].title, '桌面端新标题 🚀');

      // Now simulate user archiving the conversation on Desktop (`archived:true` in annotations/*.pbtxt)
      bridge.ringBuffer.length = 0;
      await new Promise((r) => setTimeout(r, 20));
      writeFileSync(
        join(appData, 'annotations', `${convId}.pbtxt`),
        'title:"桌面端新标题 🚀" archived:true archival_status_timestamp:{seconds:1795316000}\n',
        'utf-8'
      );
      await bridge.pollChanges();
      const archiveWsEv = bridge.ringBuffer.find((e) => e.type === 'workspaces_updated');
      assert.ok(archiveWsEv, 'Desktop archive must immediately emit workspaces_updated');
      assert.equal(archiveWsEv.workspaces.flatMap((w) => w.conversations).length, 0, 'Archived session must disappear from active list');
      assert.equal(archiveWsEv.archivedConversations.length, 1, 'Archived session must appear in archivedConversations');
      assert.equal(archiveWsEv.archivedConversations[0].id, convId);
      assert.equal(archiveWsEv.archivedConversations[0].archived, true);
    } finally {
      await bridge.stop();
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('BridgeServer persists conversation to-do flag and broadcasts workspaces_updated for cross-device sync', async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'agz-flag-sync-'));
  try {
    const appData = join(sandbox, 'appData');
    const stateDir = join(sandbox, 'state');
    const convId = 'flag-sync-conv-0001';
    const convDir = join(appData, 'brain', convId);
    const logsDir = join(convDir, '.system_generated', 'logs');
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(
      join(logsDir, 'transcript.jsonl'),
      JSON.stringify({
        step_index: 1,
        type: 'USER_INPUT',
        created_at: '2026-11-22T10:00:00Z',
        content: 'Follow up later on deployment checklist',
      }) + '\n',
      'utf-8'
    );

    const metaStore = new MetaStore({ stateDir });
    const scanner = new BrainScanner({ appDataDirs: [appData], metaStore });
    const bridge = new BridgeServer({
      port: 0,
      host: '127.0.0.1',
      metaStore,
      brainScanner: scanner,
      agentController: new AgentController({ agentApiPath: 'mock-agentapi', execFn: async () => ({ stdout: '{}' }) }),
      pollIntervalMs: 60_000,
    });
    await bridge.start();
    try {
      const port = bridge.getBoundPort();
      const token = metaStore.getToken();
      await bridge.pollChanges();

      // Initially unflagged
      const res0 = await fetch(`http://127.0.0.1:${port}/api/v1/bootstrap`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res0.status, 200);
      const data0 = await res0.json();
      const conv0 = data0.workspaces.flatMap((w) => w.conversations).find((c) => c.id === convId);
      assert.ok(conv0, 'Conversation must appear in /api/v1/bootstrap');
      assert.equal(conv0.flagged, false);

      // Flag it with an optional memo note via POST /api/v1/conversations/:id/flag
      bridge.ringBuffer.length = 0;
      const flagRes = await fetch(`http://127.0.0.1:${port}/api/v1/conversations/${convId}/flag`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ flagged: true, flagNote: '  明天推 v0.7.3  ' }),
      });
      assert.equal(flagRes.status, 200);
      const flagJson = await flagRes.json();
      assert.equal(flagJson.ok, true);
      assert.equal(flagJson.flagged, true);
      assert.equal(flagJson.flagNote, '明天推 v0.7.3');

      const wsFlagEv = bridge.ringBuffer.find((e) => e.type === 'workspaces_updated');
      assert.ok(wsFlagEv, 'Flagging must broadcast workspaces_updated to other paired devices');
      const flaggedConv = wsFlagEv.workspaces.flatMap((w) => w.conversations).find((c) => c.id === convId);
      assert.equal(flaggedConv?.flagged, true);
      assert.equal(flaggedConv?.flagNote, '明天推 v0.7.3');

      // Updating flagNote while flagged must also broadcast workspaces_updated
      bridge.ringBuffer.length = 0;
      const editNoteRes = await fetch(`http://127.0.0.1:${port}/api/v1/conversations/${convId}/flag`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ flagged: true, flagNote: '顺手测完真机再发' }),
      });
      assert.equal(editNoteRes.status, 200);
      const editNoteJson = await editNoteRes.json();
      assert.equal(editNoteJson.flagNote, '顺手测完真机再发');
      const wsEditEv = bridge.ringBuffer.find((e) => e.type === 'workspaces_updated');
      assert.ok(wsEditEv, 'Editing flagNote must broadcast workspaces_updated');
      const editedConv = wsEditEv.workspaces.flatMap((w) => w.conversations).find((c) => c.id === convId);
      assert.equal(editedConv?.flagNote, '顺手测完真机再发');

      // Unflagging clears flagNote cleanly
      bridge.ringBuffer.length = 0;
      const unflagRes = await fetch(`http://127.0.0.1:${port}/api/v1/conversations/${convId}/flag`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ flagged: false }),
      });
      assert.equal(unflagRes.status, 200);
      const unflagJson = await unflagRes.json();
      assert.equal(unflagJson.flagged, false);
      assert.equal(unflagJson.flagNote, null);

      const wsUnflagEv = bridge.ringBuffer.find((e) => e.type === 'workspaces_updated');
      assert.ok(wsUnflagEv, 'Unflagging must broadcast workspaces_updated');
      const unflaggedConv = wsUnflagEv.workspaces.flatMap((w) => w.conversations).find((c) => c.id === convId);
      assert.equal(unflaggedConv?.flagged, false);
      assert.equal(unflaggedConv?.flagNote, null);
    } finally {
      await bridge.stop();
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('Stop hook suppresses mid-task notifications while background command/subagent is pending and notifies only on final reply', async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'agz-bg-notify-'));
  try {
    const appData = join(sandbox, 'appData');
    const stateDir = join(sandbox, 'state');
    const convId = 'bg-task-conv-0001';
    const convDir = join(appData, 'brain', convId);
    const logsDir = join(convDir, '.system_generated', 'logs');
    mkdirSync(logsDir, { recursive: true });
    const transcriptPath = join(logsDir, 'transcript.jsonl');

    const nowIso = new Date().toISOString();
    const initialSteps = [
      { step_index: 1, type: 'USER_INPUT', created_at: nowIso, content: '修一下三个 Bug' },
      {
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        created_at: nowIso,
        tool_calls: [{ id: 'tc-1', name: 'run_command', args: { CommandLine: 'xcodebuild test' } }],
        content: '',
      },
      {
        step_index: 3,
        type: 'GENERIC',
        status: 'RUNNING',
        created_at: nowIso,
        content: `Tool is running as a background task with task id: ${convId}/task-42\nTask Description: xcodebuild test`,
      },
      {
        step_index: 4,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: nowIso,
        tool_calls: [],
        content: 'Waiting for background test task-42 to complete.',
      },
    ];
    writeFileSync(transcriptPath, initialSteps.map((s) => JSON.stringify(s)).join('\n') + '\n', 'utf-8');

    const metaStore = new MetaStore({ stateDir });
    const scanner = new BrainScanner({ appDataDirs: [appData], metaStore });
    const pushedAlerts = [];
    const bridge = new BridgeServer({
      port: 0,
      host: '127.0.0.1',
      metaStore,
      brainScanner: scanner,
      agentController: new AgentController({ agentApiPath: 'mock-agentapi', execFn: async () => ({ stdout: '{}' }) }),
      pollIntervalMs: 60_000,
    });
    bridge.apnsPusher.notifyConversation = async (args) => {
      pushedAlerts.push(args);
      return { ok: true, sent: 1 };
    };
    await bridge.start();
    try {
      const port = bridge.getBoundPort();
      const hookSecret = metaStore.getHookSecret();
      await bridge.pollChanges();

      // 1. Mid-task Stop hook while task-42 is still running -> MUST suppress push & keep running!
      const detMid = await scanner.getConversationDetail(convId);
      assert.equal(detMid.hasPendingBackgroundTasks, true);
      assert.equal(detMid.runState, 'running');

      const stopMid = await fetch(`http://127.0.0.1:${port}/internal/hook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-antigravityz-hook-secret': hookSecret,
        },
        body: JSON.stringify({
          hookEventName: 'Stop',
          conversationId: convId,
          continuationActive: false,
        }),
      });
      assert.equal(stopMid.status, 200);
      await new Promise((r) => setTimeout(r, 80));
      assert.equal(pushedAlerts.length, 0, 'Mid-task Stop while background task is pending must NEVER push a notification!');
      assert.equal(
        bridge.ringBuffer.filter((e) => e.type === 'notification_event').length,
        0,
        'Mid-task Stop must NOT emit in-app notification_event!'
      );

      // 2. Background task finishes + daemon server starts (IsDaemon: true) + read_file cites bg text
      //    + conversation_summaries.db STILL has not_fully_idle=1 during Stop hook -> MUST STILL notify ONCE!
      const sumDb = new DatabaseSync(join(appData, 'conversation_summaries.db'));
      sumDb.exec(`
        CREATE TABLE conversation_summaries (
          conversation_id TEXT PRIMARY KEY,
          title TEXT,
          workspace_uris TEXT,
          project_id TEXT,
          status TEXT,
          parent_conversation_id TEXT,
          nesting_depth INTEGER,
          not_fully_idle INTEGER,
          killed INTEGER,
          last_modified_time TEXT
        );
      `);
      sumDb
        .prepare(
          `INSERT INTO conversation_summaries
           (conversation_id, title, workspace_uris, project_id, status, parent_conversation_id, nesting_depth, not_fully_idle, killed, last_modified_time)
           VALUES (?, ?, '', '', 'CASCADE_RUN_STATUS_RUNNING', '', 0, 1, 0, ?)`
        )
        .run(convId, 'Build Session', new Date(Date.now() + 2000).toISOString());
      sumDb.close();

      const finalSteps = [
        ...initialSteps,
        {
          step_index: 5,
          type: 'SYSTEM_MESSAGE',
          status: 'DONE',
          created_at: new Date(Date.now() + 1000).toISOString(),
          content: `<SYSTEM_MESSAGE>\n[Message] sender=${convId}/task-42 content=Task id "${convId}/task-42" finished with result:\n** TEST SUCCEEDED **`,
        },
        {
          step_index: 6,
          type: 'PLANNER_RESPONSE',
          created_at: new Date(Date.now() + 1400).toISOString(),
          tool_calls: [{ id: 'tc-read', name: 'read_file', args: { Path: '/tmp/brain-scanner.mjs' } }],
          content: '',
        },
        {
          step_index: 7,
          type: 'GENERIC',
          status: 'DONE',
          created_at: new Date(Date.now() + 1450).toISOString(),
          content: '1039: Tool is running as a background task with task id: fake/99',
        },
        {
          step_index: 8,
          type: 'PLANNER_RESPONSE',
          created_at: new Date(Date.now() + 1500).toISOString(),
          tool_calls: [{ id: 'tc-2', name: 'run_command', args: { CommandLine: 'npm run dev', IsDaemon: true } }],
          content: '',
        },
        {
          step_index: 9,
          type: 'GENERIC',
          status: 'RUNNING',
          created_at: new Date(Date.now() + 1600).toISOString(),
          content: `Tool is running as a background task with task id: ${convId}/task-daemon-99`,
        },
        {
          step_index: 10,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: new Date(Date.now() + 2000).toISOString(),
          tool_calls: [],
          content: '三条全修完了，测试全绿，随时可以推包。',
        },
      ];
      writeFileSync(transcriptPath, finalSteps.map((s) => JSON.stringify(s)).join('\n') + '\n', 'utf-8');

      const detDone = await scanner.getConversationDetail(convId);
      assert.equal(detDone.hasPendingBackgroundTasks, false, 'Completed task + IsDaemon server + read_file quote must NOT block final completion!');
      assert.equal(detDone.notFullyIdle, true, 'Simulates real Antigravity Stop hook firing before summaries.db flips not_fully_idle to 0');

      const stopFinal = await fetch(`http://127.0.0.1:${port}/internal/hook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-antigravityz-hook-secret': hookSecret,
        },
        body: JSON.stringify({
          hookEventName: 'Stop',
          conversationId: convId,
          continuationActive: false,
        }),
      });
      assert.equal(stopFinal.status, 200);
      await new Promise((r) => setTimeout(r, 80));
      assert.equal(pushedAlerts.length, 1, 'Final Stop must dispatch EXACTLY ONE notification!');
      assert.ok(
        pushedAlerts[0].body.includes('三条全修完了'),
        `Expected final reply in push body, got: ${pushedAlerts[0].body}`
      );
    } finally {
      await bridge.stop();
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('Stop hook beats stale SQLite not_fully_idle and emits atomic workspaces_updated (idle+preview+unread) BEFORE notification_event, plus tags isTurnFinal accurately', async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'agz-atomic-stop-'));
  try {
    const appDataDir = join(sandbox, 'antigravity');
    const brainRoot = join(appDataDir, 'brain');
    const convId = 'b2b2b2b2-1111-4222-8333-444444444444';
    const logsDir = join(brainRoot, convId, '.system_generated', 'logs');
    const annDir = join(appDataDir, 'annotations');
    mkdirSync(logsDir, { recursive: true });
    mkdirSync(annDir, { recursive: true });

    const nowMs = Date.now();
    const viewedSec = Math.floor((nowMs - 60_000) / 1000);
    writeFileSync(
      join(annDir, `${convId}.pbtxt`),
      `title: "SuperG · 超级小 G"\nlast_user_view_time {\n  seconds: ${viewedSec}\n  nanos: 0\n}\n`
    );

    // SQLite deliberately stays STALE (`CASCADE_RUN_STATUS_RUNNING`, `not_fully_idle = 1`)
    // even after the Stop hook fires — reproducing Antigravity's real SQLite flush lag!
    const db = new DatabaseSync(join(appDataDir, 'conversation_summaries.db'));
    db.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        title TEXT,
        workspace_uris TEXT,
        project_id TEXT,
        status TEXT,
        parent_conversation_id TEXT,
        nesting_depth INTEGER,
        not_fully_idle INTEGER,
        killed INTEGER,
        last_modified_time TEXT
      );
    `);
    db.prepare(
      `INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      convId,
      'SuperG · 超级小 G',
      '',
      'outside-of-project',
      'CASCADE_RUN_STATUS_RUNNING',
      '',
      0,
      1,
      0,
      new Date(nowMs - 1000).toISOString()
    );
    db.close();

    // Transcript with:
    // 1. User prompt
    // 2. Intermediate progress commentary WITH tool_calls (`isTurnFinal` MUST be false)
    // 3. Final reply #1 WITHOUT tool_calls (`isTurnFinal` MUST be true, 14:08)
    // 4. Background task completion SYSTEM_MESSAGE -> follow-up reply #2 WITHOUT tool_calls (`isTurnFinal` MUST be true, 14:11)
    const tPath = join(logsDir, 'transcript_full.jsonl');
    const t1 = new Date(nowMs - 20_000).toISOString();
    const t2 = new Date(nowMs - 18_000).toISOString();
    const t3 = new Date(nowMs - 15_000).toISOString();
    const t4 = new Date(nowMs - 12_000).toISOString();
    const t5 = new Date(nowMs - 2_000).toISOString();
    const t6 = new Date(nowMs - 500).toISOString();
    writeFileSync(
      tPath,
      [
        JSON.stringify({ step_index: 0, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: '查一下安卓端有没有同样的坑', created_at: t1 }),
        JSON.stringify({
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          content: '我先搜一下全仓正则用法…',
          tool_calls: [{ id: 'tc-1', name: 'read_file', args: { Path: '/tmp/AppModel.kt' } }],
          created_at: t2,
        }),
        JSON.stringify({ step_index: 2, type: 'GENERIC', status: 'DONE', content: 'ok', created_at: t3 }),
        JSON.stringify({
          step_index: 3,
          type: 'PLANNER_RESPONSE',
          content: '拍个板，你说「开搞」我马上动手！',
          tool_calls: [],
          created_at: t4,
        }),
        JSON.stringify({
          step_index: 4,
          type: 'SYSTEM_MESSAGE',
          content: 'Task id "bg-search-1" finished with result: matched ChatCompactionTest.kt',
          created_at: t5,
        }),
        JSON.stringify({
          step_index: 5,
          type: 'PLANNER_RESPONSE',
          thinking: 'Investigating past task outputs...',
          content: '刚后台那条全仓检索跑完了，顺手确认到安卓单测也一样！',
          tool_calls: [],
          created_at: t6,
        }),
      ].join('\n') + '\n'
    );

    const metaStore = new MetaStore({ stateDir: join(sandbox, 'meta') });
    const scanner = new BrainScanner({ appDataDirs: [appDataDir], metaStore });
    const fakeApns = {
      isConfigured: () => true,
      updatePresence: () => {},
      notifyConversation: async () => ({ ok: true }),
    };
    const bridge = new BridgeServer({
      port: 0,
      host: '127.0.0.1',
      metaStore,
      brainScanner: scanner,
      agentController: { isAvailable: () => false },
      apnsPusher: fakeApns,
      quotaMonitor: { getSnapshot: async () => null },
      pollIntervalMs: 60_000,
    });
    await bridge.start();
    try {
      const port = bridge.getBoundPort();
      // Initial baseline scan (before Stop, SQLite says RUNNING -> runState='running', hasUnread=false)
      await bridge.pollChanges();
      const emitted = [];
      const origEmit = bridge.emitEvent.bind(bridge);
      bridge.emitEvent = (type, payload) => {
        const env = origEmit(type, payload);
        emitted.push(env);
        return env;
      };

      // Fire Stop hook while SQLite DB STILL says not_fully_idle = 1!
      const stopRes = await fetch(`http://127.0.0.1:${port}/internal/hook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-AntigravityZ-Hook-Secret': metaStore.getHookSecret(),
        },
        body: JSON.stringify({
          hookEventName: 'Stop',
          conversationId: convId,
          continuationActive: false,
        }),
      });
      assert.equal(stopRes.status, 200);
      await new Promise((r) => setTimeout(r, 80));

      const wsIdx = emitted.findIndex((e) => e.type === 'workspaces_updated');
      const notifIdx = emitted.findIndex((e) => e.type === 'notification_event');
      assert.ok(wsIdx >= 0, 'Expected atomic workspaces_updated event');
      assert.ok(notifIdx > wsIdx, `Expected workspaces_updated (${wsIdx}) BEFORE notification_event (${notifIdx})`);

      const updatedConv = emitted[wsIdx].workspaces
        .flatMap((w) => w.conversations)
        .find((c) => c.id === convId);
      assert.ok(updatedConv, 'Expected conversation in workspaces_updated');
      assert.equal(updatedConv.runState, 'idle', 'Stop hook must override stale SQLite not_fully_idle immediately');
      assert.equal(updatedConv.hasUnread, true, 'Unread badge must flip true atomically in the same workspaces_updated');
      assert.ok(updatedConv.lastPreview.includes('刚后台那条全仓检索跑完了'), 'Preview must already hold the latest reply');

      // Verify isTurnFinal flags on parsed transcript items
      const detail = await scanner.getConversationDetail(convId);
      const assistantItems = detail.items.filter((it) => it.role === 'assistant');
      assert.equal(assistantItems.length, 3);
      assert.equal(assistantItems[0].isTurnFinal, false, 'Mid-turn tool commentary must have isTurnFinal = false');
      assert.equal(assistantItems[1].isTurnFinal, true, 'First turn-ending reply (14:08) must have isTurnFinal = true');
      assert.equal(assistantItems[2].isTurnFinal, true, 'Follow-up wakeup reply (14:11) must have isTurnFinal = true');
    } finally {
      await bridge.stop();
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('Desktop stream-interrupted cancel clears thinking state immediately without Stop hook, and createConversation strips ANTIGRAVITY_SOURCE_METADATA', async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'agz-cancel-and-sidebar-'));
  try {
    // 1. Verify Desktop cancel (ERROR_MESSAGE: stream interrupted) immediately clears active PreInvocation hook
    // even across repeated polls while SQLite not_fully_idle still lags!
    const appDataDir = join(sandbox, 'antigravity');
    const brainRoot = join(appDataDir, 'brain');
    const convId = 'c3c3c3c3-1111-4222-8333-444444444444';
    const logsDir = join(brainRoot, convId, '.system_generated', 'logs');
    mkdirSync(logsDir, { recursive: true });

    const nowMs = Date.now();
    const db = new DatabaseSync(join(appDataDir, 'conversation_summaries.db'));
    db.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        title TEXT,
        workspace_uris TEXT,
        project_id TEXT,
        status TEXT,
        parent_conversation_id TEXT,
        nesting_depth INTEGER,
        not_fully_idle INTEGER,
        killed INTEGER,
        last_modified_time TEXT
      );
    `);
    db.prepare(
      `INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      convId,
      'Levity for Antigravity',
      '',
      'outside-of-project',
      'CASCADE_RUN_STATUS_RUNNING',
      '',
      0,
      1,
      0,
      new Date(nowMs - 1000).toISOString()
    );
    db.close();

    const tPath = join(logsDir, 'transcript_full.jsonl');
    writeFileSync(
      tPath,
      [
        JSON.stringify({ step_index: 0, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: '推吧', created_at: new Date(nowMs - 3000).toISOString() }),
        JSON.stringify({
          step_index: 1,
          type: 'ERROR_MESSAGE',
          status: 'DONE',
          source: 'SYSTEM',
          content: 'Error: The stream was interrupted. Please continue the task you were working on.',
          created_at: new Date(nowMs).toISOString(),
        }),
      ].join('\n') + '\n'
    );

    const metaStore = new MetaStore({ stateDir: join(sandbox, 'meta') });
    const scanner = new BrainScanner({ appDataDirs: [appDataDir], metaStore });
    scanner.recordHookEvent({ conversationId: convId, hookEventName: 'PreInvocation' });

    // Poll #1 AND Poll #2 must BOTH report `idle` (never stuck in `思考中…` for 90s!)
    const det1 = await scanner.getConversationDetail(convId);
    assert.equal(det1.runState, 'idle', 'Stream interrupted must immediately exit running/thinking state');
    assert.equal(det1.activityDetail, '');
    const det2 = await scanner.getConversationDetail(convId);
    assert.equal(det2.runState, 'idle', 'Second poll must stay idle even while SQLite not_fully_idle lags');

    // 2. Verify AgentController.createConversation strips sidecar-origin env vars so new iOS sessions
    // appear cleanly in official Desktop & Web Antigravity sidebars!
    const prevSourceMeta = process.env.ANTIGRAVITY_SOURCE_METADATA;
    const prevUiToken = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN;
    const prevWebPort = process.env.ANTIGRAVITY_SIDECAR_WEB_PORT;
    const prevExecDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
    const prevLsAddr = process.env.ANTIGRAVITY_LS_ADDRESS;
    process.env.ANTIGRAVITY_SOURCE_METADATA = JSON.stringify({ sidecar: { sidecarId: 'antigravity-z/bridge' } });
    process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN = 'secret-ui-token';
    process.env.ANTIGRAVITY_SIDECAR_WEB_PORT = '63935';
    process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR = '/tmp/fake-sidecar-data';
    process.env.ANTIGRAVITY_LS_ADDRESS = 'localhost:65173';
    try {
      let capturedEnv = null;
      const controller = new AgentController({
        agentApiPath: 'mock-agentapi',
        projectsRoot: sandbox,
        execFn: async (_bin, _args, opts) => {
          capturedEnv = opts.env;
          return { stdout: JSON.stringify({ conversationId: 'd4d4d4d4-1111-4222-8333-444444444444' }), stderr: '' };
        },
      });
      await controller.createConversation({ prompt: 'Hello from Levity' });
      assert.ok(capturedEnv, 'Expected execFn to receive child env');
      assert.equal(capturedEnv.ANTIGRAVITY_PROJECT_ID, 'outside-of-project');
      assert.equal(capturedEnv.ANTIGRAVITY_LS_ADDRESS, 'localhost:65173');
      assert.equal(capturedEnv.ANTIGRAVITY_SOURCE_METADATA, undefined, 'Must strip ANTIGRAVITY_SOURCE_METADATA so Web sidebar lists the session');
      assert.equal(capturedEnv.ANTIGRAVITY_SIDECAR_UI_TOKEN, undefined);
      assert.equal(capturedEnv.ANTIGRAVITY_SIDECAR_WEB_PORT, undefined);
      assert.equal(capturedEnv.ANTIGRAVITY_EXECUTABLE_DATA_DIR, undefined);
    } finally {
      if (prevSourceMeta === undefined) delete process.env.ANTIGRAVITY_SOURCE_METADATA;
      else process.env.ANTIGRAVITY_SOURCE_METADATA = prevSourceMeta;
      if (prevUiToken === undefined) delete process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN;
      else process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN = prevUiToken;
      if (prevWebPort === undefined) delete process.env.ANTIGRAVITY_SIDECAR_WEB_PORT;
      else process.env.ANTIGRAVITY_SIDECAR_WEB_PORT = prevWebPort;
      if (prevExecDir === undefined) delete process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
      else process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR = prevExecDir;
      if (prevLsAddr === undefined) delete process.env.ANTIGRAVITY_LS_ADDRESS;
      else process.env.ANTIGRAVITY_LS_ADDRESS = prevLsAddr;
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});


test('Step-index read cursor and completion mtime guarantee hasUnread=true on flagged/regular sessions even when PLANNER_RESPONSE.created_at precedes iosViewedMs', async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'agz-step-unread-'));
  try {
    const appData = join(sandbox, 'antigravity');
    const stateDir = join(sandbox, 'state');
    const annDir = join(appData, 'annotations');
    mkdirSync(annDir, { recursive: true });

    const convId = '58dd75c3-1111-4222-8333-444444444444';
    const logDir = join(appData, 'brain', convId, '.system_generated', 'logs');
    mkdirSync(logDir, { recursive: true });
    const tPath = join(logDir, 'transcript.jsonl');

    const nowMs = Date.now();
    const turn1Sec = Math.floor((nowMs - 60_000) / 1000);
    writeFileSync(
      join(annDir, `${convId}.pbtxt`),
      `title:"Lose it MCP" last_user_view_time:{seconds:${turn1Sec + 5} nanos:0}\n`,
      'utf-8'
    );
    const turn1Lines = [
      JSON.stringify({
        step_index: 132,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: new Date((turn1Sec - 5) * 1000).toISOString(),
        content: '<USER_REQUEST>\n检查一下日志\n</USER_REQUEST>',
      }),
      JSON.stringify({
        step_index: 133,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: new Date(turn1Sec * 1000).toISOString(),
        content: '日志查完了，一切正常。',
      }),
    ];
    writeFileSync(tPath, `${turn1Lines.join('\n')}\n`, 'utf-8');

    const metaStore = new MetaStore({ stateDir });
    const scanner = new BrainScanner({ appDataDirs: [appData], metaStore });
    const bridge = new BridgeServer({
      port: 0,
      host: '127.0.0.1',
      metaStore,
      brainScanner: scanner,
      agentController: {
        isAvailable: () => true,
        sendMessage: async () => ({ ok: true, mode: 'mock' }),
      },
      apnsPusher: new ApnsPusher({ metaStore, sendFn: async () => ({ sent: false }) }),
      pollIntervalMs: 60_000,
    });
    await bridge.start();
    const port = bridge.getBoundPort();
    const token = metaStore.getToken();

    try {
      // 1. Flag the conversation & mark Turn 1 read on iOS
      await fetch(`http://127.0.0.1:${port}/api/v1/conversations/${convId}/flag`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ flagged: true }),
      });
      await fetch(`http://127.0.0.1:${port}/api/v1/conversations/${convId}/read`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });

      // 2. User sends a new message from iOS; Bridge marks viewed while Step 133 is still latest.
      //    Turn 2 starts 15s BEFORE completion so `PLANNER_RESPONSE.created_at` is strictly older
      //    than both `iosViewedMs` and Desktop turn-start view time!
      const turn2StartSec = Math.floor(Date.now() / 1000) - 15;
      await fetch(`http://127.0.0.1:${port}/api/v1/conversations/${convId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '那现在需要做什么？', clientMessageId: 'ios-turn2' }),
      });
      metaStore.markConversationViewed(
        convId,
        turn2StartSec * 1000 + 2500,
        scanner.getConversationReadCursor(convId)
      );
      writeFileSync(
        join(annDir, `${convId}.pbtxt`),
        `title:"Lose it MCP" last_user_view_time:{seconds:${turn2StartSec + 1} nanos:0}\n`,
        'utf-8'
      );

      // 3. Antigravity flushes Step 137 with `created_at` stamped at TURN START (`turn2StartSec`),
      //    while `mtimeMs` is NOW (15 seconds later).
      const turn2Lines = [
        ...turn1Lines,
        JSON.stringify({
          step_index: 134,
          source: 'USER_EXPLICIT',
          type: 'USER_INPUT',
          status: 'DONE',
          created_at: new Date(turn2StartSec * 1000).toISOString(),
          content: '<USER_REQUEST>\n那现在需要做什么？\n</USER_REQUEST>',
        }),
        JSON.stringify({
          step_index: 137,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: new Date(turn2StartSec * 1000).toISOString(),
          content: '就两步，简单到闭着眼都能走完。',
        }),
      ];
      writeFileSync(tPath, `${turn2Lines.join('\n')}\n`, 'utf-8');
      await fetch(`http://127.0.0.1:${port}/internal/hook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-AntigravityZ-Hook-Secret': metaStore.getHookSecret(),
        },
        body: JSON.stringify({
          hookEventName: 'Stop',
          conversationId: convId,
          continuationActive: false,
        }),
      });
      await new Promise((r) => setTimeout(r, 80));
      await bridge.pollChanges();

      const bootUnread = await (
        await fetch(`http://127.0.0.1:${port}/api/v1/bootstrap`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).json();
      const convUnread = bootUnread.workspaces.flatMap((w) => w.conversations).find((c) => c.id === convId);
      assert.ok(convUnread, 'Expected flagged conversation in bootstrap');
      assert.equal(convUnread.flagged, true, 'Conversation must remain flagged');
      assert.equal(
        convUnread.hasUnread,
        true,
        'Flagged conversation MUST show hasUnread=true even when PLANNER_RESPONSE.created_at precedes iosViewedMs & Desktop start view!'
      );

      // 4. Opening / reading the conversation on iOS clears hasUnread while keeping flagged=true
      await fetch(`http://127.0.0.1:${port}/api/v1/conversations/${convId}/read`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const bootRead = await (
        await fetch(`http://127.0.0.1:${port}/api/v1/bootstrap`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).json();
      const convRead = bootRead.workspaces.flatMap((w) => w.conversations).find((c) => c.id === convId);
      assert.equal(convRead.flagged, true, 'Flag must persist after reading');
      assert.equal(convRead.hasUnread, false, '/read must advance stepIndex cursor to 137 and clear hasUnread');

      // 5. Same-step streaming growth (Step 137 gains more text after user left) also triggers hasUnread=true
      const grownLines = [
        ...turn2Lines.slice(0, -1),
        JSON.stringify({
          step_index: 137,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: new Date(turn2StartSec * 1000).toISOString(),
          content: '就两步，简单到闭着眼都能走完。补充：第一步推上线，第二步回归验证。',
        }),
      ];
      writeFileSync(tPath, `${grownLines.join('\n')}\n`, 'utf-8');
      await bridge.pollChanges();
      const bootGrown = await (
        await fetch(`http://127.0.0.1:${port}/api/v1/bootstrap`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).json();
      const convGrown = bootGrown.workspaces.flatMap((w) => w.conversations).find((c) => c.id === convId);
      assert.equal(convGrown.hasUnread, true, 'Same-step content growth after read must re-trigger hasUnread=true');

      // 6. Viewing on Desktop AFTER completion clears hasUnread even without iOS /read
      const afterCompleteSec = Math.ceil(Date.now() / 1000) + 5;
      writeFileSync(
        join(annDir, `${convId}.pbtxt`),
        `title:"Lose it MCP" last_user_view_time:{seconds:${afterCompleteSec} nanos:0}\n`,
        'utf-8'
      );
      await bridge.pollChanges();
      const bootDesktopRead = await (
        await fetch(`http://127.0.0.1:${port}/api/v1/bootstrap`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).json();
      const convDesktopRead = bootDesktopRead.workspaces.flatMap((w) => w.conversations).find((c) => c.id === convId);
      assert.equal(convDesktopRead.hasUnread, false, 'Desktop view after reply completion must clear hasUnread');
    } finally {
      await bridge.stop();
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

function createBridgeUpdateFixture(t, options = {}) {
  const sandbox = mkdtempSync(join(tmpdir(), 'levity-update-'));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const remote = join(sandbox, 'origin.git');
  const publisher = join(sandbox, 'publisher');
  const repoRoot = join(sandbox, 'bridge');
  const git = (cwd, ...args) => execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const configure = cwd => {
    git(cwd, 'config', 'user.name', 'Bridge Test');
    git(cwd, 'config', 'user.email', 'bridge@example.invalid');
    git(cwd, 'config', 'commit.gpgsign', 'false');
    git(cwd, 'config', 'core.hooksPath', join(sandbox, 'no-hooks'));
  };
  git(sandbox, 'init', '--bare', '--initial-branch=main', remote);
  git(sandbox, 'clone', remote, publisher);
  configure(publisher);
  mkdirSync(join(publisher, 'BridgeServer', 'src'), { recursive: true });
  const writeVersion = (cwd, version) => writeFileSync(join(cwd, 'BridgeServer', 'package.json'), JSON.stringify({ version }));
  const writeCore = (cwd, content) => writeFileSync(join(cwd, 'BridgeServer', 'src', 'sidecar-entry.mjs'), content);
  const original = 'export const original = true;\n';
  writeVersion(publisher, '1.1.0');
  writeCore(publisher, original);
  git(publisher, 'add', '.');
  git(publisher, 'commit', '-m', 'Initial bridge');
  git(remote, 'fetch', publisher, 'refs/heads/main:refs/heads/main');
  git(sandbox, 'clone', remote, repoRoot);
  configure(repoRoot);
  const publish = (version = '1.2.0', content = 'export const updated = true;\n') => {
    writeVersion(publisher, version);
    writeCore(publisher, content);
    git(publisher, 'commit', '-am', 'Publish update');
    git(remote, 'fetch', publisher, 'refs/heads/main:refs/heads/main');
  };
  const updater = new BridgeUpdater({
    repoRoot,
    fetchFn: async () => ({ ok: false, status: 404 }),
    ...options,
  });
  const localGit = (...args) => git(repoRoot, ...args);
  const readCore = () => readFileSync(join(repoRoot, 'BridgeServer', 'src', 'sidecar-entry.mjs'), 'utf8');
  return {
    sandbox, repoRoot, publisher, updater, publish, localGit, readCore, original, writeCore,
    stageUpstream: path => git(publisher, 'add', path),
  };
}

test('Bridge updater compares supported SemVer versions and prereleases', () => {
  const versions = ['0.1.0', '1.0.7', '1.1.0', '1.1.10', '2.0.0'];
  for (let index = 1; index < versions.length; index++) {
    assert.equal(compareSemver(versions[index - 1], versions[index]), -1);
    assert.equal(compareSemver(versions[index], versions[index - 1]), 1);
  }
  assert.equal(compareSemver('v1.1.0', '1.1'), 0);
  assert.equal(compareSemver('1.1.0+build.1', '1.1.0'), 0);
  assert.equal(compareSemver('1.1.0-rc.2', '1.1.0-rc.10'), -1);
  assert.equal(compareSemver('1.1.0-rc.10', '1.1.0'), -1);
  assert.equal(compareSemver('1.1.0-01', '1.1.0'), -1);
});

test('Bridge updater uses the release cache and detects same-version upstream commits on forced checks', async t => {
  let now = 0;
  let requests = 0;
  const fixture = createBridgeUpdateFixture(t, {
    nowFn: () => now,
    fetchFn: async (url, request) => {
      assert.match(url, /\/releases\/latest$/);
      assert.equal(request.headers['User-Agent'], 'LevityBridge/1.1.0');
      assert.ok(request.signal instanceof AbortSignal);
      requests++;
      return { ok: true, json: async () => ({ tag_name: 'v1.1.0', body: 'Notes', html_url: 'https://example.invalid/release' }) };
    },
  });
  fixture.publish('1.1.0');
  const first = await fixture.updater.checkForUpdates();
  assert.equal(first.updateAvailable, false);
  assert.equal(first.releaseNotes, 'Notes');
  now = 1000;
  assert.equal((await fixture.updater.checkForUpdates()).checkedAt, first.checkedAt);
  assert.equal(requests, 1);
  now += 6 * 60 * 60 * 1000;
  assert.notEqual((await fixture.updater.checkForUpdates()).checkedAt, first.checkedAt);
  assert.equal(requests, 2);
  const forced = await fixture.updater.checkForUpdates({ force: true });
  assert.equal(requests, 3);
  assert.equal(forced.commitsBehind, 1);
  assert.equal(forced.latestVersion, '1.1.0');
  assert.equal(forced.updateAvailable, true);
  assert.equal(fixture.updater.getCachedSummary().releaseNotes, undefined);
});

test('Bridge updater honors the network opt-out for forced checks', async t => {
  let requests = 0;
  const fixture = createBridgeUpdateFixture(t, {
    fetchFn: async () => {
      requests++;
      return { ok: false };
    },
  });
  const envValue = process.env.LEVITY_UPDATE_CHECK;
  process.env.LEVITY_UPDATE_CHECK = 'off';
  t.after(() => {
    if (envValue === undefined) delete process.env.LEVITY_UPDATE_CHECK;
    else process.env.LEVITY_UPDATE_CHECK = envValue;
  });
  fixture.publish();
  const before = fixture.localGit('rev-parse', 'origin/main');
  const status = await fixture.updater.checkForUpdates({ force: true });
  assert.equal(status.currentVersion, '1.1.0');
  assert.equal(status.canSelfUpdate, true);
  assert.equal(status.checkedAt, null);
  assert.equal(requests, 0);
  assert.equal(fixture.localGit('rev-parse', 'origin/main'), before);
});

test('Bridge updater fast-forwards a clean checkout and reports a second update as unnecessary', async t => {
  const { updater, publish, localGit } = createBridgeUpdateFixture(t);
  const previousCommit = localGit('rev-parse', '--short', 'HEAD');
  localGit('branch', '--unset-upstream');
  publish();
  const result = await updater.performUpdate();
  assert.deepEqual(result, {
    ok: true, httpStatus: 200, status: 'updated_restarting', previousVersion: '1.1.0',
    newVersion: '1.2.0', previousCommit, newCommit: localGit('rev-parse', '--short', 'HEAD'), restarting: true,
  });
  assert.notEqual(result.previousCommit, result.newCommit);
  assert.equal(localGit('status', '--porcelain'), '');
  assert.equal(updater.getCachedSummary().currentVersion, '1.2.0');
  assert.deepEqual(await updater.performUpdate(), {
    ok: true, httpStatus: 200, status: 'already_up_to_date', currentVersion: '1.2.0',
    previousVersion: '1.2.0', newVersion: '1.2.0', restarting: false,
  });
});

test('Bridge updater preserves unstaged and staged tracked edits byte for byte', async t => {
  let restarts = 0;
  const fixture = createBridgeUpdateFixture(t, { onRequestRestart: () => restarts++ });
  const { updater, publish, readCore, writeCore, localGit, repoRoot } = fixture;
  publish();
  const changed = 'export const local = "未提交";\r\n';
  const previousHead = localGit('rev-parse', 'HEAD');
  writeCore(repoRoot, changed);
  for (const staged of [false, true]) {
    if (staged) localGit('add', 'BridgeServer/src/sidecar-entry.mjs');
    const result = await updater.performUpdate();
    assert.equal(result.httpStatus, 409);
    assert.equal(result.status, 'dirty_worktree');
    assert.equal(readCore(), changed);
    assert.equal(localGit('rev-parse', 'HEAD'), previousHead);
    assert.equal(restarts, 0);
  }
});

test('Bridge updater rejects diverged branches and preserves the local commit', async t => {
  const { updater, publish, localGit, readCore, writeCore, repoRoot } = createBridgeUpdateFixture(t);
  publish();
  const local = 'export const local = true;\n';
  writeCore(repoRoot, local);
  localGit('commit', '-am', 'Local change');
  const previousHead = localGit('rev-parse', 'HEAD');
  const result = await updater.performUpdate();
  assert.equal(result.httpStatus, 409);
  assert.equal(result.status, 'diverged');
  assert.equal(localGit('rev-parse', 'HEAD'), previousHead);
  assert.equal(readCore(), local);
});

test('Bridge updater rolls invalid syntax back to the original clean commit without restart', async t => {
  let restarts = 0;
  const { updater, publish, localGit, readCore, original } = createBridgeUpdateFixture(t, {
    onRequestRestart: () => restarts++,
  });
  const previousHead = localGit('rev-parse', 'HEAD');
  publish('1.2.0', 'export const = ;\n');
  const result = await updater.performUpdate();
  assert.equal(result.httpStatus, 500);
  assert.equal(result.status, 'rolled_back');
  assert.equal(result.newVersion, '1.1.0');
  assert.equal(result.restarting, false);
  assert.equal(localGit('rev-parse', 'HEAD'), previousHead);
  assert.equal(localGit('status', '--porcelain'), '');
  assert.equal(readCore(), original);
  assert.equal(restarts, 0);
  assert.deepEqual((await updater.checkForUpdates()).lastResult, result);
});

test('Bridge updater reports standalone, detached HEAD, and missing origin accurately', async t => {
  const { sandbox, updater, localGit, repoRoot } = createBridgeUpdateFixture(t);
  const standalone = new BridgeUpdater({
    repoRoot: join(repoRoot, 'BridgeServer'),
    packageJsonPath: join(sandbox, 'missing.json'),
    fetchFn: async () => ({ ok: false }),
  });
  const status = await standalone.checkForUpdates();
  assert.equal(status.currentVersion, '1.1.0');
  assert.equal(status.installKind, 'standalone');
  assert.equal(status.canSelfUpdate, false);
  assert.equal(status.blockReason, 'not_git_repo');
  assert.equal((await standalone.performUpdate()).status, 'not_git_repo');
  localGit('switch', '--detach');
  assert.equal((await updater.performUpdate()).status, 'detached_head');
  localGit('switch', 'main');
  localGit('remote', 'remove', 'origin');
  assert.equal((await updater.performUpdate()).status, 'no_remote');
});

test('Bridge updater keeps an ignored file that the upstream update would overwrite', async t => {
  const { updater, publish, localGit, readCore, repoRoot, original, publisher, stageUpstream } = createBridgeUpdateFixture(t);
  const notes = join(repoRoot, 'notes.txt');
  writeFileSync(join(repoRoot, '.git', 'info', 'exclude'), 'notes.txt\n');
  writeFileSync(notes, 'private notes');
  writeFileSync(join(publisher, 'notes.txt'), 'upstream notes');
  stageUpstream('notes.txt');
  publish();
  assert.equal((await updater.performUpdate()).status, 'merge_failed');
  assert.equal(readFileSync(notes, 'utf8'), 'private notes');
  assert.equal(readCore(), original);
  assert.equal(localGit('status', '--porcelain'), '');
});

test('Bridge updater protects local edits made during failed post-merge verification', async t => {
  const localEdit = 'export const editedDuringUpdate = true;\n';
  const fixture = createBridgeUpdateFixture(t, {
    execFileFn: (file, args, options) => {
      if (file === process.execPath && args[0] === '--check') {
        writeFileSync(args[1], localEdit);
        throw new Error('Syntax verification failed');
      }
      return execFileSync(file, args, options);
    },
  });
  fixture.publish('1.2.0', 'export const = ;\n');
  const result = await fixture.updater.performUpdate();
  assert.equal(result.status, 'rollback_failed');
  assert.equal(result.restarting, false);
  assert.equal(fixture.readCore(), localEdit);
});

test('Bridge updater runs the installer only when a plugin manifest or installer changes', async t => {
  const { updater, publisher, publish, repoRoot, stageUpstream } = createBridgeUpdateFixture(t);
  const installer = 'scripts/install-plugin.mjs';
  mkdirSync(join(publisher, 'scripts'));
  writeFileSync(join(publisher, installer), "import { appendFileSync } from 'node:fs';\nappendFileSync('installer-runs', '1');\n");
  stageUpstream(installer);
  publish();
  assert.equal((await updater.performUpdate()).status, 'updated_restarting');
  const marker = join(repoRoot, 'installer-runs');
  assert.equal(readFileSync(marker, 'utf8'), '1');
  publish('1.2.1', 'export const updatedAgain = true;\n');
  assert.equal((await updater.performUpdate()).status, 'updated_restarting');
  assert.equal(readFileSync(marker, 'utf8'), '1');
  writeFileSync(join(publisher, 'plugin.json'), '{}');
  stageUpstream('plugin.json');
  publish('1.2.2');
  assert.equal((await updater.performUpdate()).status, 'updated_restarting');
  assert.equal(readFileSync(marker, 'utf8'), '11');
});

test('Bridge updater rejects concurrent update calls while Git fetch is in flight', async t => {
  let enteredFetch;
  const fetching = new Promise(resolve => { enteredFetch = resolve; });
  let releaseFetch;
  const pendingFetch = new Promise(resolve => { releaseFetch = resolve; });
  const fixture = createBridgeUpdateFixture(t, {
    execFileFn: async (file, args, options) => {
      if (file === 'git' && args[0] === 'fetch') {
        enteredFetch();
        await pendingFetch;
      }
      return new Promise((resolve, reject) => {
        execFile(file, args, options, (error, stdout) => error ? reject(error) : resolve(stdout));
      });
    },
  });
  fixture.publish();
  const first = fixture.updater.performUpdate();
  try {
    await Promise.race([fetching, first]);
    const second = await fixture.updater.performUpdate();
    assert.equal(second.httpStatus, 409);
    assert.equal(second.status, 'already_updating');
  } finally {
    releaseFetch();
  }
  assert.equal((await first).status, 'updated_restarting');
});

test('Bridge updater advertises the endpoint and blocks one-tap when no supervisor can restart the host', async t => {
  const { updater, publish, localGit } = createBridgeUpdateFixture(t);
  const { metaStore, scanner } = createReadCursorFixture(t);
  const bridge = new BridgeServer({
    metaStore, brainScanner: scanner, agentController: { isAvailable: () => false }, bridgeUpdater: updater,
  });
  publish();
  const previousHead = localGit('rev-parse', 'HEAD');
  const status = await bridge.checkBridgeUpdate(true);
  assert.equal(status.updateAvailable, true);
  assert.equal(status.canSelfUpdate, false);
  assert.equal(status.blockReason, 'manual_restart_required');
  assert.ok(bridge.getPublicStatus().capabilities.includes('self_update'));
  assert.equal((await bridge.performBridgeUpdate()).status, 'manual_restart_required');
  assert.equal(localGit('rev-parse', 'HEAD'), previousHead);
});

test('Bridge update HTTP routes authenticate, advertise the handshake, and schedule one restart after success', async t => {
  let restarts = 0;
  let restarted;
  const restartSignal = new Promise(resolve => { restarted = resolve; });
  const { updater, publish } = createBridgeUpdateFixture(t, {
    onRequestRestart: () => {
      restarts++;
      restarted();
    },
  });
  const { metaStore, scanner } = createReadCursorFixture(t);
  const bridge = new BridgeServer({
    port: 0,
    host: '127.0.0.1',
    metaStore,
    brainScanner: scanner,
    agentController: { isAvailable: () => false },
    bridgeUpdater: updater,
  });
  await bridge.start();
  t.after(() => bridge.stop());
  const base = `http://127.0.0.1:${bridge.getBoundPort()}`;
  const headers = { Authorization: `Bearer ${metaStore.getToken()}` };
  for (const [path, method] of [['update-status', 'GET'], ['update', 'POST']]) {
    assert.equal((await fetch(`${base}/api/v1/bridge/${path}`, { method })).status, 401);
  }
  const boot = await fetch(`${base}/api/v1/bootstrap`, { headers }).then(res => res.json());
  assert.equal(boot.server.version, '1.1.0');
  assert.equal(boot.server.protocolVersion, 2);
  assert.deepEqual(boot.server.capabilities, ['inline_images', 'bridge_update_check', 'self_update', 'workspace_browser']);
  assert.equal(boot.server.updateInfo.canSelfUpdate, true);
  assert.equal(bridge.getPairingInfo().version, '1.1.0');
  const postUpdate = () => fetch(`${base}/api/v1/bridge/update`, { method: 'POST', headers });
  const noUpdate = await postUpdate().then(res => res.json());
  assert.equal(noUpdate.status, 'already_up_to_date');
  assert.equal(noUpdate.restarting, false);
  assert.equal(bridge.restartScheduled, false);
  publish();
  const status = await fetch(`${base}/api/v1/bridge/update-status?force=1`, { headers }).then(res => res.json());
  assert.equal(status.updateAvailable, true);
  assert.equal(status.commitsBehind, 1);
  assert.equal(status.canSelfUpdate, true);
  const response = await postUpdate();
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.status, 'updated_restarting');
  assert.equal(result.newVersion, '1.2.0');
  assert.equal(result.restarting, true);
  assert.equal(restarts, 0);
  const timeout = AbortSignal.timeout(3000);
  await Promise.race([
    restartSignal,
    new Promise((_, reject) => timeout.addEventListener('abort', () => reject(timeout.reason), { once: true })),
  ]);
  bridge.scheduleRestart();
  assert.equal(restarts, 1);
});

test('Bridge updater rolls back when pulled code breaks an ESM import at load time', async t => {
  let restarts = 0;
  const fixture = createBridgeUpdateFixture(t, { onRequestRestart: () => { restarts++; } });
  const before = fixture.localGit('rev-parse', 'HEAD');
  fixture.publish('1.2.0', "import './missing-module.mjs';\nexport const version = '1.2.0';\n");
  const result = await fixture.updater.performUpdate();
  assert.equal(result.ok, false);
  assert.equal(result.httpStatus, 500);
  assert.equal(result.status, 'rolled_back');
  assert.equal(result.restarting, false);
  assert.equal(fixture.localGit('rev-parse', 'HEAD'), before);
  assert.equal(restarts, 0);
});

test('Bridge updater marks failed offline checks and detects release ahead of unchanged branch', async t => {
  const fixture = createBridgeUpdateFixture(t, {
    fetchFn: async () => { throw new Error('offline'); },
  });
  // Make origin unreachable to simulate offline failure for both release API and git fetch
  fixture.localGit('remote', 'set-url', 'origin', '/nonexistent/levity-offline-origin.git');
  const failed = await fixture.updater.checkForUpdates({ force: true });
  assert.equal(failed.checkFailed, true);
  assert.equal(failed.checkedAt, null);

  // Now simulate GitHub release 1.2.0 ahead while tracked git branch has 0 commits behind
  const branchFixture = createBridgeUpdateFixture(t, {
    fetchFn: async () => ({
      ok: true,
      json: async () => ({ tag_name: 'v1.2.0', body: 'Release 1.2.0', html_url: 'https://example.invalid/1.2.0' }),
    }),
  });
  const checked = await branchFixture.updater.checkForUpdates({ force: true });
  assert.equal(checked.checkFailed, false);
  assert.equal(checked.updateAvailable, true);
  assert.equal(checked.canSelfUpdate, false);
  assert.equal(checked.blockReason, 'branch_not_ahead');
  const applied = await branchFixture.updater.performUpdate();
  assert.equal(applied.ok, false);
  assert.equal(applied.httpStatus, 409);
  assert.equal(applied.status, 'branch_not_ahead');
});

test('BrainScanner enforces symlink containment on downloads and skips unresolvable nested inline images', async t => {
  const { convDir, writeTranscript, scanner, convId, reply } = createReadCursorFixture(t);
  const outside = `${convDir}-outside`;
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'secret.png'), 'secret bytes');
  const escapedLink = join(convDir, 'leak.png');
  symlinkSync(join(outside, 'secret.png'), escapedLink);
  assert.equal(scanner.resolveUploadedFilePath(convId, 'leak.png'), null);

  const nestedDir = join(convDir, 'screens');
  mkdirSync(nestedDir, { recursive: true });
  const nestedImg = join(nestedDir, 'nested.png');
  writeFileSync(nestedImg, 'nested bytes');
  const rootImg = join(convDir, 'root.png');
  writeFileSync(rootImg, 'root bytes');
  writeTranscript([{
    ...reply,
    content: `![Nested](${nestedImg})\n![Root](${rootImg})`,
  }], new Date(reply.created_at));
  const detail = await scanner.getConversationDetail(convId);
  const assistant = detail.items.find((it) => it.role === 'assistant');
  assert.ok(assistant.content.includes('![Root](levity-attachment://root.png)'));
  assert.ok(!assistant.content.includes('levity-attachment://nested.png'));
  assert.deepEqual(assistant.attachments.map((a) => a.fileName), ['root.png']);
});

test('BridgeServer negotiates inline_images capability so legacy 1.0(19) clients receive clean legacy text', async t => {
  const { convDir, writeTranscript, metaStore, scanner, convId, reply } = createReadCursorFixture(t);
  const img = join(convDir, 'shot.png');
  writeFileSync(img, 'png bytes');
  writeTranscript([{
    ...reply,
    content: `Intro\n\`\`\`\`carousel\n![Shot](${img})\n\`\`\`\`\nOutro`,
  }], new Date(reply.created_at));

  const bridge = new BridgeServer({
    port: 0,
    host: '127.0.0.1',
    metaStore,
    brainScanner: scanner,
    agentController: { isAvailable: () => false },
  });
  await bridge.start();
  t.after(() => bridge.stop());
  const base = `http://127.0.0.1:${bridge.getBoundPort()}`;
  const auth = { Authorization: `Bearer ${metaStore.getToken()}` };

  const legacyRes = await fetch(`${base}/api/v1/conversations/${convId}`, { headers: auth }).then((r) => r.json());
  const legacyItem = legacyRes.detail.items.find((it) => it.role === 'assistant');
  assert.ok(!legacyItem.content.includes('levity-attachment://'));
  assert.equal(legacyItem.legacyContent, undefined);
  assert.deepEqual(legacyItem.attachments.map((a) => a.fileName), ['shot.png']);

  const modernRes = await fetch(`${base}/api/v1/conversations/${convId}`, {
    headers: { ...auth, 'X-Levity-Capabilities': 'inline_images' },
  }).then((r) => r.json());
  const modernItem = modernRes.detail.items.find((it) => it.role === 'assistant');
  assert.ok(modernItem.content.includes('![Shot](levity-attachment://shot.png)'));
  assert.equal(modernItem.legacyContent, undefined);
});

// These signature examples are mirrored in AntigravityZTests/AntigravityZTests.swift.
const leakedTailLines = [
  'user',
  'The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.',
  '',
  '<SYSTEM_MESSAGE>',
  '[Message] timestamp=2026-11-25T02:18:04Z sender=8a57e5fd-3cea-4f8a-a57e-01f70bd8bf8d/task-42',
  '后台任务已结束。',
  '</SYSTEM_MESSAGE>',
];
const leakedTail = leakedTailLines.join('\n');
const leakedModelContinuation = [
  ...leakedTailLines.slice(0, -1), '</SYSTEM_MESSAGE>model', '所有测试都通过，可以交付了。',
].join('\n');

test('sanitizeAssistantLeakedTail preserves LF and CRLF and captures the entire model continuation', () => {
  for (const newline of ['\n', '\r\n']) {
    const tail = leakedTailLines.join(newline) + newline;
    const prefix = `  已核对消息预览。${newline}继续检查通知。`;
    assert.deepEqual(sanitizeAssistantLeakedTail(`${prefix} \t${newline}${newline}${tail}`), {
      displayContent: prefix, leakedTail: tail,
    });
  }
  assert.deepEqual(sanitizeAssistantLeakedTail(`正在等测试结果。\n\n${leakedModelContinuation}`), {
    displayContent: '正在等测试结果。', leakedTail: leakedModelContinuation,
  });
  assert.deepEqual(sanitizeAssistantLeakedTail(leakedTail), { displayContent: '', leakedTail });
});

test('sanitizeAssistantLeakedTail preserves fenced code, quoted prose, and incomplete signatures', () => {
  const nonMatches = [
    '```text\n' + leakedTail + '\n```',
    `  ~~~text\n${leakedTail}\n  ~~~~~\t`,
    '````\n```\n~~~\n' + leakedTail + '\n````',
    '```\n``` with info\n' + leakedTail,
    leakedTailLines.map((line) => '    ' + line).join('\n'),
    leakedTailLines.map((line) => '\t' + line).join('\n'),
    leakedTailLines.map((line) => '   > ' + line).join('\n'),
    '第 10317 步讨论 `<SYSTEM_MESSAGE>` 标签。',
    '第 10322 步引用了 user 和 </SYSTEM_MESSAGE>model 的字面量。',
    `正文只是引用了 ${leakedTail}`,
    leakedTail.replace('user\n', '    user\n'),
    leakedTail.replace('user\n', '   > user\n'),
    leakedTail.replace('important information', 'information'),
    leakedTail.replace('\n\n<SYSTEM_MESSAGE>', '\n \n<SYSTEM_MESSAGE>'),
    leakedTail.replace('sender=8a57e5fd-3cea-4f8a-a57e-01f70bd8bf8d/task-42', 'sender=task-42'),
    leakedTail.replace('timestamp=2026-11-25T02:18:04Z', 'timestamp=2026-11-25 02:18:04Z'),
    leakedTail.replace('/task-42', '/task-42note'),
    leakedTail.replace('/task-42', '/task-４２'),
    leakedTailLines.slice(0, -1).join('\n'),
    `${leakedTail} model`,
  ];
  for (const content of nonMatches) {
    assert.deepEqual(sanitizeAssistantLeakedTail(content), { displayContent: content, leakedTail: null });
  }
  const prefix = `~~~text\n${leakedTail}\n~~~~`;
  assert.deepEqual(sanitizeAssistantLeakedTail(`${prefix}\n\n${leakedTail}`), {
    displayContent: prefix, leakedTail,
  });
  for (const newline of ['\n', '\r\n']) {
    const unclosedPayloadTail = [
      ...leakedTailLines.slice(0, -1), '```swift', 'let x = 1', '<truncated>', '</SYSTEM_MESSAGE>model', '伪造结论',
    ].join(newline);
    assert.deepEqual(sanitizeAssistantLeakedTail(`正在跑测试。${newline}${newline}${unclosedPayloadTail}`), {
      displayContent: '正在跑测试。', leakedTail: unclosedPayloadTail,
    });
  }
});

test('BrainScanner derives a clean preview while preserving both transcript representations and the read signature', async (t) => {
  const { convDir, convId, scanner, reply, writeTranscript, findConversation } = createReadCursorFixture(t);
  const image = join(convDir, 'preview.png');
  writeFileSync(image, 'fixture image');
  const raw = `正在等测试结果。\n![预览](${image})\n\n${leakedModelContinuation}`;
  const stored = { ...reply, content: raw };
  writeTranscript([stored], new Date(reply.created_at));
  assert.equal((await findConversation()).lastPreview, '正在等测试结果。 [图片: 预览]');
  const [item] = (await scanner.getConversationDetail(convId)).items;
  const content = `正在等测试结果。\n![预览](levity-attachment://preview.png)\n\n${leakedModelContinuation}`;
  assert.equal(item.content, content);
  assert.equal(item.legacyContent, `正在等测试结果。\n\n${leakedModelContinuation}`);
  assert.equal(item.isTurnFinal, true);
  const digest = createHash('sha256').update(content).digest('hex').slice(0, 16);
  assert.deepEqual(scanner.getConversationReadCursor(convId), { stepIndex: 17, replySig: `17:${content.length}:1:${digest}` });
  const transcript = join(convDir, '.system_generated', 'logs', 'transcript.jsonl');
  assert.equal(readFileSync(transcript, 'utf8'), JSON.stringify(stored) + '\n');
});

test('BrainScanner uses a neutral pure-leak preview and prefers the existing image preview for attachments', async (t) => {
  const { convDir, convId, scanner, reply, writeTranscript, findConversation } = createReadCursorFixture(t);
  writeTranscript([{ ...reply, content: leakedTail }], new Date(reply.created_at));
  assert.equal((await findConversation()).lastPreview, '打开查看异常回复');
  const [item] = (await scanner.getConversationDetail(convId)).items;
  assert.equal(item.content, leakedTail);
  assert.equal(item.isTurnFinal, true);

  const image = join(convDir, 'preview.png');
  writeFileSync(image, 'fixture image');
  writeTranscript([{ ...reply, content: leakedTail, media: [{ uri: image }] }], new Date(Date.now() + 1_000));
  assert.equal((await findConversation()).lastPreview, '[图片] preview.png');

  const nonLeaks = ['第 10317 步讨论 `<SYSTEM_MESSAGE>` 标签。', '```text\n' + leakedTail + '\n```'];
  for (const [index, content] of nonLeaks.entries()) {
    writeTranscript([{ ...reply, content }], new Date(Date.now() + 2_000 + index * 1_000));
    assert.equal((await findConversation()).lastPreview, content.replace(/\s+/g, ' ').slice(0, 140));
  }
});

test('Stop hook uses the sanitized summary for APNs and toast while retaining the received reply', { timeout: 5000 }, async (t) => {
  const { convId, scanner, metaStore, reply, writeTranscript } = createReadCursorFixture(t);
  const bridge = new BridgeServer({
    port: 0, host: '127.0.0.1', metaStore, brainScanner: scanner,
    agentController: { isAvailable: () => false },
  });
  await bridge.start();
  t.after(() => bridge.stop());
  const endpoint = `http://127.0.0.1:${bridge.getBoundPort()}/internal/hook`;
  const cases = [
    { content: `正在等测试结果。\n\n${leakedModelContinuation}`, summary: '正在等测试结果。' },
    { content: leakedTail, summary: '打开查看异常回复' },
  ];
  for (const [index, { content, summary }] of cases.entries()) {
    writeTranscript([{ ...reply, content, step_index: 17 + index }], new Date(Date.now() + index * 1000));
    const alert = new Promise((resolve) => {
      bridge.apnsPusher.notifyConversation = async (args) => {
        resolve(args);
        return { ok: true, sent: 1 };
      };
    });
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-antigravityz-hook-secret': metaStore.getHookSecret() },
      body: JSON.stringify({ hookEventName: 'Stop', conversationId: convId, continuationActive: false }),
    });
    assert.equal(response.status, 200);
    assert.equal((await alert).body, summary);
    assert.equal(bridge.ringBuffer.filter((event) => event.type === 'notification_event').at(-1)?.notificationBody, summary);
    const [item] = (await scanner.getConversationDetail(convId)).items;
    assert.equal(item.content, content);
  }
});

test('uriToPath parses JSON-array workspace_uris, URL-encoded spaces, empty arrays, and legacy comma-separated URIs', () => {
  assert.equal(uriToPath('["file:///Volumes/TestDrive/LifeOS"]'), '/Volumes/TestDrive/LifeOS');
  assert.equal(
    uriToPath('["file:///Volumes/TestDrive/My%20Project/", "file:///tmp/second"]'),
    '/Volumes/TestDrive/My Project'
  );
  assert.equal(uriToPath('["", "file:///tmp/Foo,%20Bar"]'), '/tmp/Foo, Bar');
  assert.equal(uriToPath('[{"uri":"file:///tmp/ObjectRepo"}]'), '/tmp/ObjectRepo');
  assert.equal(uriToPath('"file:///tmp/QuotedRepo"'), '/tmp/QuotedRepo');
  assert.equal(uriToPath('[]'), '');
  assert.equal(uriToPath('["", null]'), '');
  assert.equal(uriToPath('file:///tmp/First,file:///tmp/Second'), '/tmp/First');
  assert.equal(uriToPath('/tmp/Folder, With Comma'), '/tmp/Folder, With Comma');
  assert.equal(uriToPath('/'), '/');
  assert.equal(uriToPath('project://fake'), 'project://fake');
});

test('BrainScanner resolves JSON-array workspace_uris cleanly and falls through on empty [] arrays', async (t) => {
  const sandbox = mkdtempSync(join(tmpdir(), 'levity-json-uris-'));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const appData = join(sandbox, 'antigravity');
  const projectsCfgDir = join(sandbox, 'projects-config');
  const lifeOsDir = join(sandbox, 'LifeOS');
  const fallbackDir = join(sandbox, 'FallbackProj');
  const spacedDir = join(sandbox, 'My Space App');
  for (const dir of [appData, projectsCfgDir, lifeOsDir, fallbackDir, spacedDir]) {
    mkdirSync(dir, { recursive: true });
  }

  const fallbackProjId = '11111111-2222-3333-4444-555555555555';
  writeFileSync(
    join(projectsCfgDir, `${fallbackProjId}.json`),
    JSON.stringify({
      id: fallbackProjId,
      name: 'Fallback Desktop Name',
      projectResources: { localFolders: [{ uri: pathToFileURL(fallbackDir).href }] },
    })
  );

  const lifeConvId = 'aaaaaaaa-1111-4222-8333-444444444401';
  const emptyWithProjectConvId = 'aaaaaaaa-1111-4222-8333-444444444402';
  const emptyFreeConvId = 'aaaaaaaa-1111-4222-8333-444444444403';
  const spacedConvId = 'aaaaaaaa-1111-4222-8333-444444444404';

  const db = new DatabaseSync(join(appData, 'conversation_summaries.db'));
  db.exec(`
    CREATE TABLE conversation_summaries (
      conversation_id text PRIMARY KEY,
      title text NOT NULL DEFAULT '',
      preview text NOT NULL DEFAULT '',
      step_count integer NOT NULL DEFAULT 0,
      last_modified_time datetime NOT NULL,
      workspace_uris text NOT NULL,
      project_id text NOT NULL DEFAULT '',
      status text NOT NULL DEFAULT '',
      parent_conversation_id text NOT NULL DEFAULT '',
      nesting_depth integer NOT NULL DEFAULT 0,
      not_fully_idle numeric NOT NULL DEFAULT 0,
      killed numeric NOT NULL DEFAULT 0
    );
  `);
  const ins = db.prepare(
    `INSERT INTO conversation_summaries
     (conversation_id, title, last_modified_time, workspace_uris, project_id, status, parent_conversation_id, nesting_depth, not_fully_idle, killed)
     VALUES (?, ?, ?, ?, ?, 'CASCADE_RUN_STATUS_IDLE', '', 0, 0, 0)`
  );
  ins.run(lifeConvId, 'LifeOS Session', '2026-11-27T05:00:00Z', JSON.stringify([pathToFileURL(lifeOsDir).href]), '');
  ins.run(emptyWithProjectConvId, 'Empty Array Project Session', '2026-11-27T05:01:00Z', '[]', fallbackProjId);
  ins.run(emptyFreeConvId, 'Empty Array Free Session', '2026-11-27T05:02:00Z', '[]', 'outside-of-project');
  ins.run(spacedConvId, 'Spaced Repo Session', '2026-11-27T05:03:00Z', JSON.stringify([pathToFileURL(spacedDir).href]), '');
  db.close();

  for (const cid of [lifeConvId, emptyWithProjectConvId, emptyFreeConvId, spacedConvId]) {
    const logDir = join(appData, 'brain', cid, '.system_generated', 'logs');
    mkdirSync(logDir, { recursive: true });
    writeFileSync(
      join(logDir, 'transcript_full.jsonl'),
      JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-27T05:00:00Z', content: 'hello' }) + '\n'
    );
  }

  const scanner = new BrainScanner({
    appDataDirs: [appData],
    projectsRoot: join(sandbox, 'Projects'),
    projectsConfigDir: projectsCfgDir,
  });
  const scan = await scanner.scanAll({ includeMetadata: false });
  const convById = new Map(scan.workspaces.flatMap((w) => w.conversations).map((c) => [c.id, c]));

  assert.equal(convById.get(lifeConvId).workspacePath, lifeOsDir);
  assert.equal(convById.get(lifeConvId).workspaceName, 'LifeOS');
  assert.equal(convById.get(spacedConvId).workspacePath, spacedDir);
  assert.equal(convById.get(spacedConvId).workspaceName, 'My Space App');
  assert.equal(convById.get(emptyWithProjectConvId).workspacePath, realpathSync(fallbackDir));
  assert.equal(convById.get(emptyWithProjectConvId).workspaceName, 'Fallback Desktop Name');
  assert.equal(convById.get(emptyFreeConvId).workspacePath, null);
  assert.equal(convById.get(emptyFreeConvId).workspaceName, '通用对话');
  assert.ok(
    scan.knownProjects.some((p) => realpathSync(p.path) === realpathSync(lifeOsDir) && p.name === 'LifeOS'),
    'JSON-array historical workspace must also appear cleanly in knownProjects'
  );
});
