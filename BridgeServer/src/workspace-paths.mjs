import { accessSync, constants, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { opendir as openDirectory, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const VOLUMES = '/Volumes';
const LAZY_HOME_FOLDERS = ['Desktop', 'Documents', 'Downloads'];
const SCAN_LIMIT = 4000;
const PATH_ERRORS = {
  INVALID_PATH: [400, '无效的目录路径'],
  NOT_FOUND: [404, '目录不存在'],
  NOT_A_DIRECTORY: [400, '此路径不是目录'],
  PERMISSION_DENIED: [403, 'Mac 拒绝访问此目录'],
  VOLUME_OFFLINE: [400, '此存储卷未挂载'],
};

export class WorkspaceError extends Error {
  constructor(code, message = PATH_ERRORS[code]?.[1], status = PATH_ERRORS[code]?.[0]) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function filesystemError(error) {
  switch (error.code) {
    case 'EACCES': case 'EPERM': return new WorkspaceError('PERMISSION_DENIED');
    case 'ENOENT': case 'ELOOP': return new WorkspaceError('NOT_FOUND');
    case 'ENOTDIR': return new WorkspaceError('NOT_A_DIRECTORY');
    case 'EINVAL': case 'ENAMETOOLONG': return new WorkspaceError('INVALID_PATH');
    case 'ENODEV': case 'ENXIO': case 'ESTALE': return new WorkspaceError('VOLUME_OFFLINE');
    default: return error;
  }
}

export function localWorkspacePath(value) {
  if (typeof value !== 'string' || value.includes('\0')) throw new WorkspaceError('INVALID_PATH');
  let path = value;
  if (/^file:\/\//i.test(path)) {
    try {
      path = fileURLToPath(path);
    } catch {
      throw new WorkspaceError('INVALID_PATH');
    }
  }
  if (path === '~' || path.startsWith('~/')) path = homedir() + path.slice(1);
  if (!path.startsWith('/') || path.includes('\0')) throw new WorkspaceError('INVALID_PATH');
  return path.replace(/\/{2,}/g, '/');
}

export function canonicalWorkspacePath(path) {
  try {
    return realpathSync.native(path);
  } catch {
    return resolvePath(path);
  }
}

export function checkWorkspaceVolume(path) {
  const volumeName = /^\/Volumes\/([^/]+)/.exec(path)?.[1];
  if (!volumeName || volumeName === '.' || volumeName === '..') return;
  const volumePath = join(VOLUMES, volumeName);
  try {
    const volume = statSync(volumePath);
    if (!volume.isDirectory()) throw new WorkspaceError('NOT_A_DIRECTORY');
    if (volume.dev === statSync(VOLUMES).dev && canonicalWorkspacePath(volumePath) !== '/') {
      throw new WorkspaceError('VOLUME_OFFLINE');
    }
  } catch (error) {
    if (error.code === 'ENOENT') throw new WorkspaceError('VOLUME_OFFLINE');
    throw filesystemError(error);
  }
}

export function workspacePathMetadata(path) {
  return { path, name: basename(path) || '/', parentPath: path === '/' ? null : dirname(path) };
}

// Background discovery only checks metadata. Explicit requests can require read and search access.
export function resolveWorkspaceDirectory(value, { checkAccess = false } = {}) {
  const input = localWorkspacePath(value);
  try {
    checkWorkspaceVolume(input);
    if (!statSync(input).isDirectory()) throw new WorkspaceError('NOT_A_DIRECTORY');
    const resolvedPath = canonicalWorkspacePath(input);
    if (resolvedPath !== input) checkWorkspaceVolume(resolvedPath);
    if (checkAccess) accessSync(resolvedPath, constants.R_OK | constants.X_OK);
    // Resolve '..' through the filesystem so a symlink cannot change the directory that path names.
    const path = input.split('/').includes('..') ? resolvedPath : resolvePath(input);
    return { ...workspacePathMetadata(path), resolvedPath };
  } catch (error) {
    throw filesystemError(error);
  }
}

export function findWorkspaceDirectory(value) {
  try {
    return resolveWorkspaceDirectory(value);
  } catch {
    return null;
  }
}

export function isLazyHomeDirectory(value) {
  const path = resolvePath(value);
  const home = homedir();
  return [home, canonicalWorkspacePath(home)].some((root) =>
    LAZY_HOME_FOLDERS.some((name) => {
      const folder = join(root, name);
      return path === folder || path.startsWith(folder + '/');
    })
  );
}

export function workspaceLocations(projectsRoot) {
  const locations = [];
  const add = (kind, path, name) => locations.push({ kind, ...workspacePathMetadata(path), name });
  if (projectsRoot) {
    const path = resolvePath(localWorkspacePath(projectsRoot));
    add('projectsRoot', path, basename(path) || '/');
  }
  try {
    const parentDev = statSync(VOLUMES).dev;
    for (const name of readdirSync(VOLUMES).sort()) {
      const path = join(VOLUMES, name);
      try {
        const info = statSync(path);
        if (info.isDirectory() && info.dev !== parentDev && canonicalWorkspacePath(path) !== '/') {
          add('volume', path, name);
        }
      } catch {
        // The volume can disappear while building the list.
      }
    }
  } catch {
    // Other platforms and hosts can lack /Volumes.
  }
  const home = homedir();
  add('home', home, '~');
  for (const name of LAZY_HOME_FOLDERS) add('directory', join(home, name), name);
  add('root', '/', '/');
  return locations;
}

export async function openWorkspaceDirectory(path) {
  try {
    return await openDirectory(path);
  } catch (error) {
    throw filesystemError(error);
  }
}

export async function listWorkspaceDirectories(directory, { filter = '', showHidden = false, limit = 100 }, favorites) {
  const dir = await openWorkspaceDirectory(directory.resolvedPath);
  const entries = [];
  const query = filter.toLowerCase();
  let scanned = 0;
  let truncated = false;
  try {
    for await (const entry of dir) {
      if (scanned++ >= SCAN_LIMIT) {
        truncated = true;
        break;
      }
      const name = entry.name;
      const isHidden = name.startsWith('.');
      if ((!showHidden && isHidden) || !name.toLowerCase().includes(query)) continue;

      const path = join(directory.path, name);
      const child = join(directory.resolvedPath, name);
      const isSymlink = entry.isSymbolicLink();
      let identity = child;
      if (isSymlink) {
        try {
          if (!(await stat(child)).isDirectory()) continue;
        } catch {
          continue;
        }
        if (favorites.size > 0) identity = await realpath(child).catch(() => child);
      } else if (!entry.isDirectory()) {
        continue;
      }
      if (entries.length >= limit) {
        truncated = true;
        break;
      }
      entries.push({ name, path, isSymlink, isHidden, isFavorite: favorites.has(identity) });
    }
  } catch (error) {
    throw filesystemError(error);
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return { entries, truncated, totalReturned: entries.length };
}

function* projectFolderPaths(value) {
  if (typeof value === 'string') {
    try {
      yield localWorkspacePath(value);
    } catch {
      // Projects can also contain remote resources and other metadata.
    }
  } else if (Array.isArray(value)) {
    for (const child of value) yield* projectFolderPaths(child);
  } else if (value && typeof value === 'object') {
    for (const key of [
      'localFolders', 'folders', 'workspaces', 'workspaceFolders', 'resources',
      'localFolder', 'folder', 'workspaceFolder', 'workspaceFolderAbsoluteUri',
      'workspaceUri', 'folderUri', 'uri', 'folderPath', 'path', 'absolutePath', 'absoluteUri',
    ]) {
      if (Object.hasOwn(value, key)) yield* projectFolderPaths(value[key]);
    }
  }
}

export class DesktopProjects {
  constructor(configDir = join(homedir(), '.gemini', 'config', 'projects')) {
    this.configDir = configDir;
    this.configs = new Map();
  }

  read() {
    let entries;
    try {
      entries = readdirSync(this.configDir, { withFileTypes: true });
    } catch {
      return new Map();
    }
    const configs = new Map();
    const projects = new Map();
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      try {
        const path = join(this.configDir, entry.name);
        const { mtimeMs, size } = statSync(path);
        const key = `${mtimeMs}:${size}`;
        let config = this.configs.get(entry.name);
        if (config?.key !== key) {
          const data = JSON.parse(readFileSync(path, 'utf8'));
          const id = String(data?.id || '').trim();
          if (!id || data.sidecar) continue;
          const paths = [...new Set(projectFolderPaths([data.projectResources, data.workspaces, data.folders]))];
          config = { key, id, name: String(data.name || '').trim(), paths };
        }
        configs.set(entry.name, config);
        const { id, name, paths } = config;
        const resolvedPaths = paths.map((path) => findWorkspaceDirectory(path)?.resolvedPath);
        const folderPaths = [...new Set(resolvedPaths.filter(Boolean))];
        // Keep the registered path for historical conversation grouping when a volume is offline.
        const folderPath = resolvedPaths[0] || (paths.length ? resolvePath(paths[0]) : null);
        projects.set(id, { id, name, folderPath, folderPaths });
      } catch {
        // Ignore malformed project registration files.
      }
    }
    this.configs = configs;
    return projects;
  }
}

export function matchingDesktopProjects(projects, resolvedPath) {
  return [...projects.values()]
    .filter((project) => project.folderPaths.includes(resolvedPath))
    .sort((a, b) => a.id.localeCompare(b.id));
}
