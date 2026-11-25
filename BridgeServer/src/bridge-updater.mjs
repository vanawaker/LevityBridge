import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultRepoRoot = fileURLToPath(new URL('../../', import.meta.url));
const defaultFeed = 'https://api.github.com/repos/vanawaker/LevityBridge/releases/latest';
const coreFiles = [
  'sidecar-entry.mjs', 'bridge-server.mjs', 'brain-scanner.mjs', 'agent-controller.mjs',
  'bridge-updater.mjs', 'apns-pusher.mjs', 'meta-store.mjs', 'inline-attachments.mjs',
];
const importableModules = [
  'bridge-server.mjs', 'brain-scanner.mjs', 'agent-controller.mjs', 'bridge-updater.mjs',
  'apns-pusher.mjs', 'meta-store.mjs', 'inline-attachments.mjs',
];

const semver = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/i;
const numeric = /^\d+$/;
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function parseSemver(value) {
  const match = typeof value === 'string' && value.trim().match(semver);
  if (!match) return null;
  const prerelease = match[4]?.split('.') ?? [];
  if (prerelease.some(id => numeric.test(id) && id.length > 1 && id.startsWith('0'))) return null;
  return { core: [match[1], match[2], match[3] ?? '0'].map(BigInt), prerelease };
}

export function compareSemver(a, b) {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) return order(Boolean(left), Boolean(right));
  for (let index = 0; index < 3; index++) {
    const difference = order(left.core[index], right.core[index]);
    if (difference) return difference;
  }
  if (!left.prerelease.length || !right.prerelease.length) {
    return order(!left.prerelease.length, !right.prerelease.length);
  }
  for (let index = 0; index < Math.min(left.prerelease.length, right.prerelease.length); index++) {
    const lhs = left.prerelease[index];
    const rhs = right.prerelease[index];
    const lhsIsNumeric = numeric.test(lhs);
    const rhsIsNumeric = numeric.test(rhs);
    const difference = lhsIsNumeric && rhsIsNumeric
      ? order(BigInt(lhs), BigInt(rhs))
      : lhsIsNumeric !== rhsIsNumeric ? order(rhsIsNumeric, lhsIsNumeric) : order(lhs, rhs);
    if (difference) return difference;
  }
  return order(left.prerelease.length, right.prerelease.length);
}

export function readBridgeVersion(packageJsonPath = fileURLToPath(new URL('../package.json', import.meta.url))) {
  try {
    const { version } = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    if (parseSemver(version)) return version;
  } catch {
    // A packaged install can omit the manifest.
  }
  return '1.1.0';
}

function runFile(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

const blockMessages = {
  not_git_repo: 'This Bridge installation is not a Git checkout.',
  detached_head: 'Switch to a local branch before updating the Bridge.',
  dirty_worktree: 'The Bridge has local changes. Save or commit them before updating.',
  no_remote: 'The Bridge checkout has no origin remote.',
  inspection_failed: 'The Bridge checkout could not be verified. Check it on the desktop.',
};

function failure(status, message, details = {}, httpStatus = 409) {
  return { ok: false, httpStatus, status, message, restarting: false, ...details };
}

export class BridgeUpdater {
  constructor({
    repoRoot = defaultRepoRoot,
    packageJsonPath = join(repoRoot, 'BridgeServer', 'package.json'),
    execFileFn = runFile,
    fetchFn = globalThis.fetch,
    onRequestRestart = null,
    updateFeedUrl = defaultFeed,
    nowFn = Date.now,
    checkTtlMs = 6 * 60 * 60 * 1000,
  } = {}) {
    this.repoRoot = repoRoot;
    this.packageJsonPath = packageJsonPath;
    this.execFileFn = execFileFn;
    this.fetchFn = fetchFn;
    this.onRequestRestart = onRequestRestart;
    this.updateFeedUrl = updateFeedUrl;
    this.nowFn = nowFn;
    this.checkTtlMs = checkTtlMs;
    this.updating = false;
    this.lastResult = null;
    this.lastCheck = null;
    this.environment = null;
    this.checkGeneration = 0;
  }

  get currentVersion() {
    return readBridgeVersion(this.packageJsonPath);
  }

  async #run(file, args, timeout = 5000) {
    const output = await this.execFileFn(file, args, {
      cwd: this.repoRoot,
      encoding: 'utf8',
      timeout,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return String(output?.stdout ?? output ?? '').trim();
  }

  #git(args, timeout) {
    return this.#run('git', args, timeout);
  }

  async inspectEnvironment() {
    const standalone = {
      installKind: 'standalone', branch: null, commit: null, remoteExists: false,
      clean: false, canSelfUpdate: false, blockReason: 'not_git_repo',
    };
    try {
      const inside = await this.#git(['rev-parse', '--is-inside-work-tree']);
      // A standalone copy nested inside a different repository must never update that repository.
      if (inside !== 'true' || await this.#git(['rev-parse', '--show-prefix'])) return standalone;
    } catch {
      return standalone;
    }

    const [branch, commit, remotes, ...diffs] = await Promise.allSettled([
      this.#git(['rev-parse', '--abbrev-ref', 'HEAD']),
      this.#git(['rev-parse', '--short', 'HEAD']),
      this.#git(['remote']),
      this.#git(['diff', '--quiet', '--no-ext-diff']),
      this.#git(['diff', '--cached', '--quiet', '--no-ext-diff']),
    ]);
    const remoteExists = remotes.value?.split(/\s+/).includes('origin') ?? false;
    const clean = diffs.every(result => result.status === 'fulfilled');
    const inspected = branch.value && commit.value && remotes.status === 'fulfilled'
      && diffs.every(result => result.status === 'fulfilled' || (result.reason?.code ?? result.reason?.status) === 1);
    const blockReason = !inspected ? 'inspection_failed'
      : branch.value === 'HEAD' ? 'detached_head'
        : !clean ? 'dirty_worktree'
          : !remoteExists ? 'no_remote' : null;
    return {
      installKind: 'git', branch: branch.value ?? null, commit: commit.value ?? null,
      remoteExists, clean, canSelfUpdate: blockReason === null, blockReason,
    };
  }

  async refreshEnvironment() {
    this.environment = await this.inspectEnvironment();
  }

  getCachedSummary() {
    const currentVersion = this.currentVersion;
    const latestVersion = this.lastCheck?.latestVersion ?? null;
    const commitsBehind = this.lastCheck?.commitsBehind ?? 0;
    const releaseAhead = compareSemver(latestVersion, currentVersion) > 0;
    const updateAvailable = releaseAhead || commitsBehind > 0;
    const branchChecked = this.lastCheck?.branchChecked === true;
    const branchNotAhead = branchChecked && releaseAhead && commitsBehind === 0;
    const baseCanSelfUpdate = this.environment?.canSelfUpdate ?? false;
    return {
      currentVersion,
      latestVersion,
      commitsBehind,
      updateAvailable,
      canSelfUpdate: baseCanSelfUpdate && !branchNotAhead,
      installKind: this.environment?.installKind ?? null,
      blockReason: this.environment?.blockReason ?? (branchNotAhead ? 'branch_not_ahead' : null),
      checkedAt: this.lastCheck?.checkedAt ?? null,
      checkFailed: Boolean(this.lastCheckFailed),
      updating: this.updating,
    };
  }

  #status() {
    return {
      ...this.getCachedSummary(),
      releaseNotes: this.lastCheck?.releaseNotes ?? null,
      releaseUrl: this.lastCheck?.releaseUrl ?? null,
      lastResult: this.lastResult,
    };
  }

  async #upstream(branch) {
    try {
      const ref = await this.#git(['rev-parse', '--symbolic-full-name', '@{u}']);
      if (ref.startsWith('refs/remotes/origin/')) return ref;
    } catch {
      // Fresh clones may not have a tracking branch configured.
    }
    return `refs/remotes/origin/${branch}`;
  }

  async #latestRelease(currentVersion) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await this.fetchFn(this.updateFeedUrl, {
        headers: { 'User-Agent': `LevityBridge/${currentVersion}`, Accept: 'application/vnd.github+json' },
        signal: controller.signal,
      });
      if (!response.ok) return { ok: false };
      const release = await response.json();
      return {
        ok: true,
        latestVersion: parseSemver(release?.tag_name) ? release.tag_name.trim().replace(/^v/i, '') : null,
        releaseNotes: typeof release?.body === 'string' ? release.body : null,
        releaseUrl: typeof release?.html_url === 'string' ? release.html_url : null,
      };
    } catch {
      return { ok: false };
    } finally {
      clearTimeout(timeout);
    }
  }

  async #commitsBehind(environment) {
    if (environment.installKind !== 'git' || !environment.remoteExists || environment.branch === 'HEAD') {
      return { ok: false, checked: false, count: 0 };
    }
    try {
      await this.#git(['fetch', '--tags', '--quiet', 'origin'], 15_000);
      const upstream = await this.#upstream(environment.branch);
      const count = Number(await this.#git(['rev-list', '--count', `HEAD..${upstream}`])) || 0;
      return { ok: true, checked: true, count };
    } catch {
      return { ok: false, checked: false, count: this.lastCheck?.commitsBehind ?? 0 };
    }
  }

  async checkForUpdates({ force = false } = {}) {
    if (this.updating) return this.#status();
    const generation = this.checkGeneration;
    const environment = await this.inspectEnvironment();
    if (generation !== this.checkGeneration) return this.#status();
    this.environment = environment;

    if (process.env.LEVITY_UPDATE_CHECK === 'off') {
      this.lastCheck = null;
      this.lastCheckFailed = false;
      return this.#status();
    }
    if (!force && this.lastCheck && !this.lastCheckFailed && this.nowFn() - Date.parse(this.lastCheck.checkedAt) < this.checkTtlMs) {
      return this.#status();
    }

    const [release, gitProbe] = await Promise.all([
      this.#latestRelease(this.currentVersion),
      force ? this.#commitsBehind(environment) : Promise.resolve({ ok: false, checked: false, count: this.lastCheck?.commitsBehind ?? 0 }),
    ]);
    if (generation === this.checkGeneration) {
      const anySucceeded = Boolean(release.ok || gitProbe.ok);
      this.lastCheckFailed = !anySucceeded;
      if (anySucceeded) {
        this.lastCheck = {
          latestVersion: release.ok ? release.latestVersion : (this.lastCheck?.latestVersion ?? null),
          releaseNotes: release.ok ? release.releaseNotes : (this.lastCheck?.releaseNotes ?? null),
          releaseUrl: release.ok ? release.releaseUrl : (this.lastCheck?.releaseUrl ?? null),
          commitsBehind: gitProbe.ok ? gitProbe.count : (this.lastCheck?.commitsBehind ?? 0),
          branchChecked: gitProbe.checked || Boolean(this.lastCheck?.branchChecked),
          checkedAt: new Date(this.nowFn()).toISOString(),
        };
      }
    }
    return this.#status();
  }

  async #applyUpdate() {
    const environment = await this.inspectEnvironment();
    this.environment = environment;
    if (!environment.canSelfUpdate) return failure(environment.blockReason, blockMessages[environment.blockReason]);

    const previousHead = await this.#git(['rev-parse', 'HEAD']);
    const previousVersion = this.currentVersion;
    const previousCommit = await this.#git(['rev-parse', '--short', previousHead]);
    try {
      await this.#git(['fetch', '--tags', 'origin'], 15_000);
    } catch {
      return failure('fetch_failed', 'Could not fetch the Bridge update from origin.', { previousVersion });
    }

    const upstream = await this.#upstream(environment.branch);
    let target;
    try {
      target = await this.#git(['rev-parse', '--verify', `${upstream}^{commit}`]);
    } catch {
      return failure('no_upstream', 'No matching origin branch was found for this checkout.', { previousVersion });
    }
    const [ahead, behind] = (await this.#git(['rev-list', '--left-right', '--count', `${previousHead}...${target}`]))
      .split(/\s+/).map(Number);
    if (behind === 0) {
      if (compareSemver(this.lastCheck?.latestVersion, previousVersion) > 0) {
        if (this.lastCheck) this.lastCheck = { ...this.lastCheck, commitsBehind: 0, branchChecked: true };
        return failure('branch_not_ahead', 'The latest release is not yet on the tracked Git branch. Update manually on your desktop.', {
          previousVersion,
          currentVersion: previousVersion,
          newVersion: previousVersion,
        });
      }
      return {
        ok: true, httpStatus: 200, status: 'already_up_to_date', currentVersion: previousVersion,
        previousVersion, newVersion: previousVersion, restarting: false,
      };
    }
    if (ahead > 0 && behind > 0) {
      return failure('diverged', 'Local branch has diverged from upstream; manual merge required.', { previousVersion });
    }
    const newCommit = await this.#git(['rev-parse', '--short', target]);

    const beforeMerge = await this.inspectEnvironment();
    this.environment = beforeMerge;
    if (!beforeMerge.canSelfUpdate) return failure(beforeMerge.blockReason, blockMessages[beforeMerge.blockReason]);
    if (beforeMerge.branch !== environment.branch || await this.#git(['rev-parse', 'HEAD']) !== previousHead) {
      return failure('merge_failed', 'The checkout changed during the update. Check it before retrying.', { previousVersion });
    }
    const presentCoreBefore = coreFiles.filter((file) => existsSync(join(this.repoRoot, 'BridgeServer', 'src', file)));
    try {
      await this.#git(['merge', '--ff-only', '--no-overwrite-ignore', target], 15_000);
    } catch {
      return failure('merge_failed', 'Git could not fast-forward the Bridge checkout.', { previousVersion });
    }

    try {
      for (const file of presentCoreBefore) {
        const path = join(this.repoRoot, 'BridgeServer', 'src', file);
        if (!existsSync(path)) {
          throw new Error(`Required Bridge file removed by update: ${file}`);
        }
      }
      const presentCoreAfter = coreFiles.filter((file) => existsSync(join(this.repoRoot, 'BridgeServer', 'src', file)));
      for (const file of presentCoreAfter) {
        const path = join(this.repoRoot, 'BridgeServer', 'src', file);
        await this.#run(process.execPath, ['--check', path]);
      }
      const importUrls = importableModules
        .map((file) => join(this.repoRoot, 'BridgeServer', 'src', file))
        .filter((path) => existsSync(path))
        .map((path) => pathToFileURL(path).href);
      if (importUrls.length > 0) {
        // Verify the live ESM import graph and exports in a clean child process before restarting.
        await this.#run(
          process.execPath,
          ['--input-type=module', '-e', 'for (const url of process.argv.slice(1)) { await import(url); }', ...importUrls],
          10_000
        );
      }
      // Also confirm sidecar-entry.mjs relative static imports resolve on disk (both `import ... from './x'` and `import './x'`).
      const sidecarPath = join(this.repoRoot, 'BridgeServer', 'src', 'sidecar-entry.mjs');
      if (existsSync(sidecarPath)) {
        const sidecarSrc = readFileSync(sidecarPath, 'utf8');
        for (const match of sidecarSrc.matchAll(/^\s*import\s+(?:[\s\S]*?\s+from\s+)?['"](\.[^'"]+)['"]/gm)) {
          const relPath = join(this.repoRoot, 'BridgeServer', 'src', match[1]);
          if (!existsSync(relPath)) {
            throw new Error(`Missing sidecar import: ${match[1]}`);
          }
        }
      }
    } catch {
      try {
        const afterMerge = await this.inspectEnvironment();
        if (!afterMerge.clean || afterMerge.branch !== environment.branch
          || await this.#git(['rev-parse', 'HEAD']) !== target) {
          throw new Error('Checkout changed during verification');
        }
        // --keep restores the previous tree and refuses to discard concurrent local edits.
        await this.#git(['reset', '--keep', previousHead]);
      } catch {
        return failure('rollback_failed', 'Pulled code failed verification. Check the desktop checkout to finish restoring it.', { previousVersion }, 500);
      }
      return failure('rolled_back', 'Pulled code failed syntax verification and was rolled back cleanly.', {
        previousVersion, newVersion: previousVersion,
      }, 500);
    }

    const installer = 'scripts/install-plugin.mjs';
    let warning;
    if (existsSync(join(this.repoRoot, installer))) {
      try {
        const changed = await this.#git(['diff', '--name-only', `${previousHead}..${target}`, '--',
          'plugin.json', 'hooks.json', 'sidecars/', installer]);
        if (changed) await this.#run(process.execPath, [installer], 10_000);
      } catch {
        warning = 'The Bridge was updated, but the desktop plugin installer could not finish.';
        console.warn(`[LevityBridge] ${warning}`);
      }
    }
    return {
      ok: true, httpStatus: 200, status: 'updated_restarting', previousVersion, newVersion: this.currentVersion,
      previousCommit, newCommit, restarting: true,
      ...(warning ? { warning } : {}),
    };
  }

  async performUpdate() {
    if (this.updating) return failure('already_updating', 'Bridge update is already in progress.');
    this.updating = true;
    this.checkGeneration++;
    try {
      const result = await this.#applyUpdate();
      if (result.ok && this.lastCheck) this.lastCheck = { ...this.lastCheck, commitsBehind: 0 };
      this.lastResult = result;
      return result;
    } catch {
      this.lastResult = failure('update_failed', 'The Bridge update could not finish. Check the desktop checkout.', {}, 500);
      return this.lastResult;
    } finally {
      this.updating = false;
    }
  }
}
