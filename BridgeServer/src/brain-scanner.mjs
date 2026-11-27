/**
 * BrainScanner — Discovers conversations, reads official `conversation_summaries.db`
 * (read-only) & `annotations/*.pbtxt` for Desktop-renamed titles and pinned status,
 * parses untruncated transcripts, active model/thinking settings, and interactive
 * questions/permission waits, resolves workspace grouping, and nests subagents.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve as resolvePath, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { stripInlineAttachmentMarkdown } from './inline-attachments.mjs';
import { lookupModelInfo } from './model-catalog.mjs';
import { DesktopProjects, findWorkspaceDirectory, isLazyHomeDirectory, workspacePathMetadata } from './workspace-paths.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_CONV_RE = /^[0-9a-zA-Z_-]{6,64}$/;
const ARTIFACT_EXTS = new Set(['.md', '.png', '.jpg', '.jpeg', '.webp', '.svg', '.txt', '.json']);
const LEAK_NOTICE = 'The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.';
const LEAK_METADATA_RE = /^\[Message\]\s+timestamp=\S+\s+sender=[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\/task-\d+\b/;
export const LEAKED_ASSISTANT_PREVIEW_FALLBACK = '打开查看异常回复';

export function sanitizeAssistantLeakedTail(text) {
  if (!text.includes('<SYSTEM_MESSAGE>')) return { displayContent: text, leakedTail: null };

  // Keep the separators so the tail can be sliced out of the original string verbatim.
  const parts = text.split(/(\r?\n)/);
  let offset = 0;
  let fence = null;
  let tailStart = null;
  for (let i = 0; i < parts.length; i += 2) {
    const line = parts[i];
    const lineStart = offset;
    offset += line.length + (parts[i + 1]?.length ?? 0);
    if (tailStart !== null) {
      // Once the unfenced 5-line protocol header has matched, lines inside the leaked
      // `<SYSTEM_MESSAGE>` payload are raw command logs (which may contain truncated,
      // unclosed Markdown code fences) and must not mask the closing protocol tag.
      if (line === '</SYSTEM_MESSAGE>' || line === '</SYSTEM_MESSAGE>model') {
        return { displayContent: text.slice(0, tailStart).trimEnd(), leakedTail: text.slice(tailStart) };
      }
      continue;
    }
    if (/^(?: {4}| {0,3}[\t>])/.test(line)) continue;

    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      const rest = line.slice(line.indexOf(marker) + marker.length);
      if (fence) {
        if (marker[0] === fence[0] && marker.length >= fence.length && !/[^ \t]/.test(rest)) fence = null;
      } else if (marker[0] === '~' || !rest.includes('`')) {
        fence = marker;
      }
      continue;
    }
    if (fence) continue;

    if (line === 'user' && parts[i + 2] === LEAK_NOTICE && parts[i + 4] === '' &&
        parts[i + 6] === '<SYSTEM_MESSAGE>' && LEAK_METADATA_RE.test(parts[i + 8] ?? '')) {
      tailStart = lineStart;
    }
  }
  return { displayContent: text, leakedTail: null };
}

function replyDigest(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function assistantReplySignature(stepIdx, content, attachmentCount) {
  return `${stepIdx}:${content.length}:${attachmentCount}:${replyDigest(content)}`;
}

function extractSettingsChanges(raw) {
  if (!raw || typeof raw !== 'string') return { modelName: null };
  let modelName = null;
  const re = /<USER_SETTINGS_CHANGE>([\s\S]*?)<\/USER_SETTINGS_CHANGE>/gi;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const block = m[1];
    const modelMatch = /setting\s+`Model Selection`\s+from\s+[\s\S]*?\s+to\s+([^.\n]+)\./i.exec(block);
    if (modelMatch && modelMatch[1]) {
      modelName = modelMatch[1].trim();
    }
  }
  return { modelName };
}

function stripUserWrapper(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const reqMatch = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i.exec(raw);
  const body = reqMatch
    ? reqMatch[1]
    : raw
        .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '')
        .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, '')
        .replace(/The user has uploaded \d+ attachment\(s\)[\s\S]*$/gi, '');
  return body
    .replace(/\n*\[Workspace:\s*[^\]]+\]/g, '')
    .replace(/\n*\[SESSION_MODE:\s*[^\n]+/g, '')
    .replace(/(?:\n+\[附件:\s*[^\]]+\]\(file:\/\/[^)]+\))+$/g, '')
    .trim();
}

function inferAttachmentKind(mimeOrName = '') {
  const s = String(mimeOrName || '').toLowerCase();
  if (s.startsWith('image/') || /\.(png|jpe?g|webp|gif|heic|svg)$/.test(s)) return 'image';
  if (s.startsWith('video/') || /\.(mp4|mov|m4v|webm)$/.test(s)) return 'video';
  if (s.startsWith('audio/') || /\.(m4a|mp3|wav|aac|ogg)$/.test(s)) return 'audio';
  return 'file';
}

function mimeFromImageExt(fileName = '') {
  const ext = extname(String(fileName || '')).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.heic') return 'image/heic';
  return 'image/png';
}

function extractAssistantInlineImages(rawContent, convDir, stepMedia = null) {
  const found = new Map();
  const resolvedConvDir = resolvePath(convDir);
  const allowedPrefix = resolvedConvDir + sep;
  let realConvDir;
  let realConvPrefix;
  let resolvableDirs;

  const ensureRealDirs = () => {
    if (!realConvDir) {
      realConvDir = realpathSync(resolvedConvDir);
      realConvPrefix = realConvDir + sep;
      resolvableDirs = [
        join(realConvDir, '.user_uploaded'),
        join(realConvDir, 'uploads'),
        realConvDir,
        join(realConvDir, 'scratch'),
      ];
    }
  };

  const registerPath = (cleanTarget, altText) => {
    if (!cleanTarget.startsWith('/')) return null;
    const resolved = resolvePath(cleanTarget);
    if (!resolved.startsWith(allowedPrefix)) return null;
    const fName = basename(resolved);
    if (!fName || fName.startsWith('.') || inferAttachmentKind(fName) !== 'image') return null;
    let sizeBytes = 0;
    try {
      ensureRealDirs();
      const realFile = realpathSync(resolved);
      if (!realFile.startsWith(realConvPrefix)) return null;
      const parentDir = dirname(realFile);
      if (!resolvableDirs.includes(parentDir)) return null;
      // Ensure download resolution by basename resolves to this exact canonical file (no shadowing).
      let matchedExact = false;
      for (const dir of resolvableDirs) {
        const probe = join(dir, fName);
        if (!existsSync(probe)) continue;
        try {
          const probeReal = realpathSync(probe);
          if (probeReal.startsWith(realConvPrefix) && statSync(probeReal).isFile()) {
            matchedExact = probeReal === realFile;
            break;
          }
        } catch {
          // Ignore unreadable probe
        }
      }
      if (!matchedExact) return null;
      const st = statSync(realFile);
      if (!st.isFile()) return null;
      sizeBytes = st.size;
    } catch {
      return null;
    }
    if (!found.has(fName)) {
      found.set(fName, {
        id: `img-${fName}`,
        name: (altText || '').trim() || fName,
        fileName: fName,
        kind: 'image',
        mimeType: mimeFromImageExt(fName),
        sizeBytes,
      });
    }
    return fName;
  };

  const tryRegisterLocalImage = (rawTarget, altText = '') => {
    const target = rawTarget.trim().replace(/^<([^>]+)>$/, '$1');
    try {
      if (target.startsWith('file://')) return registerPath(fileURLToPath(target), altText);
      if (!target.startsWith('/')) return null;
      return registerPath(target, altText)
        ?? (target.includes('%') ? registerPath(decodeURIComponent(target), altText) : null);
    } catch {
      return null;
    }
  };

  if (Array.isArray(stepMedia)) {
    for (const m of stepMedia) {
      const uri = String(m?.uri || '').trim();
      if (uri && !tryRegisterLocalImage(uri) && uri.includes(',')) {
        tryRegisterLocalImage(uri.split(',')[0]);
      }
    }
  }

  const source = String(rawContent || '');
  const legacyParts = [];
  let legacyStart = 0;
  const content = source.replace(/!\[((?:\\.|[^\]\\])*)\]\((<[^>\n]+>|(?:[^()\n]|\([^()\n]*\))+)\)/g, (full, alt, target, offset) => {
    const cleanAlt = String(alt || '').replace(/\\\]/g, ']').replace(/[\r\n]+/g, ' ').replace(/\]/g, ')').trim();
    const fileName = tryRegisterLocalImage(target, cleanAlt);
    if (!fileName) return full;
    legacyParts.push(source.slice(legacyStart, offset));
    legacyStart = offset + full.length;
    // encodeURIComponent leaves parentheses unescaped, where they would delimit Markdown.
    const encoded = encodeURIComponent(fileName).replace(/\(/g, '%28').replace(/\)/g, '%29');
    return `![${cleanAlt}](levity-attachment://${encoded})`;
  });
  const legacyContent = (legacyParts.join('') + source.slice(legacyStart)).replace(/\n{3,}/g, '\n\n').trim();

  return {
    cleanedContent: legacyParts.length ? content : legacyContent,
    legacyContent: legacyParts.length ? legacyContent : null,
    attachments: [...found.values()],
  };
}

function extractDesktopAttachments(step) {
  const found = new Map();
  if (Array.isArray(step?.media)) {
    for (const m of step.media) {
      const uri = String(m?.uri || '').trim();
      const filePath = uri.startsWith('file://') ? uriToPath(uri) : uri;
      const fName = basename(filePath);
      if (!fName) continue;
      let sizeBytes = 0;
      try {
        if (filePath && existsSync(filePath)) sizeBytes = statSync(filePath).size;
      } catch {
        // Ignore
      }
      const mimeType = String(m?.mime_type || m?.mimeType || 'application/octet-stream');
      found.set(fName, {
        id: fName,
        name: fName,
        fileName: fName,
        kind: inferAttachmentKind(mimeType || fName),
        mimeType,
        sizeBytes,
      });
    }
  }
  const rawContent = String(step?.content || '');
  const metaMatch = /<ADDITIONAL_METADATA>([\s\S]*?)<\/ADDITIONAL_METADATA>/i.exec(rawContent);
  if (metaMatch) {
    const lineRe = /^-\s*(\/[^\n]+\/\.user_uploaded\/([^\s\n]+))\s*$/gm;
    let m;
    while ((m = lineRe.exec(metaMatch[1])) !== null) {
      const fullPath = m[1].trim();
      const fName = m[2].trim();
      if (!fName || found.has(fName)) continue;
      let sizeBytes = 0;
      try {
        if (existsSync(fullPath)) sizeBytes = statSync(fullPath).size;
      } catch {
        // Ignore
      }
      found.set(fName, {
        id: fName,
        name: fName,
        fileName: fName,
        kind: inferAttachmentKind(fName),
        mimeType: inferAttachmentKind(fName) === 'image' ? 'image/jpeg' : 'application/octet-stream',
        sizeBytes,
      });
    }
  }
  return [...found.values()];
}

function extractMobilePrompt(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const switchOnlyMatch = /\[AntigravityZ_MODEL_SWITCH\s+model=([^\s\]]+)\]/.exec(raw);
  if (switchOnlyMatch) {
    const info = lookupModelInfo(switchOnlyMatch[1]);
    return {
      clientMessageId: null,
      modelId: switchOnlyMatch[1].trim(),
      mode: null,
      isControlOnly: true,
      text: `切换模型为 ${info ? info.displayName : switchOnlyMatch[1].trim()}`,
    };
  }
  if (!raw.includes('[AntigravityZ_USER_PROMPT')) return null;
  const headerMatch = /\[AntigravityZ_USER_PROMPT([^\]]*)\]/.exec(raw);
  const headerAttrs = headerMatch ? headerMatch[1] : '';
  const idMatch = /\bid=([^\s\]]+)/.exec(headerAttrs);
  const modelMatch = /\bmodel=([^\s\]]+)/.exec(headerAttrs);
  const modeMatch = /\bmode=([^\s\]]+)/.exec(headerAttrs);
  const promptMatch = /<USER_PROMPT>\s*([\s\S]*?)\s*<\/USER_PROMPT>/i.exec(raw);
  if (!promptMatch) return null;
  return {
    clientMessageId: idMatch?.[1]?.trim() || null,
    modelId: modelMatch?.[1]?.trim() || null,
    mode: modeMatch?.[1]?.trim() || null,
    isControlOnly: false,
    text: promptMatch[1].trim(),
  };
}

function normalizeUserDedupText(str) {
  return String(str || '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFE00-\uFE0F\uFEFF]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
}

function isSameUserTurnText(a, b) {
  const na = normalizeUserDedupText(a);
  const nb = normalizeUserDedupText(b);
  if (!na || !nb) return false;
  return na === nb || na.startsWith(nb) || nb.startsWith(na);
}

function extractBalancedJsonObject(str, fromIndex = 0) {
  if (!str || typeof str !== 'string') return null;
  const start = str.indexOf('{', Math.max(0, fromIndex));
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  const limit = Math.min(str.length, start + 32768);
  for (let i = start; i < limit; i += 1) {
    const ch = str[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return str.slice(start, i + 1);
      }
    }
  }
  return null;
}

export function parseAskQuestionArgs(args) {
  if (!args) return null;
  let rawQuestions = args.questions;
  if (typeof rawQuestions === 'string') {
    try {
      rawQuestions = JSON.parse(rawQuestions);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) return null;
  const normalized = [];
  for (let i = 0; i < rawQuestions.length; i++) {
    const item = rawQuestions[i];
    if (!item || typeof item.question !== 'string') continue;
    const text = item.question.trim();
    if (!text) continue;
    const opts = Array.isArray(item.options)
      ? item.options.map((o) => String(o ?? '').trim()).filter(Boolean)
      : [];
    normalized.push({
      id: `q-${i}`,
      question: text,
      options: opts,
      multiSelect: Boolean(item.is_multi_select ?? item.multiSelect),
    });
  }
  if (normalized.length === 0) return null;
  const q0 = normalized[0];
  return {
    question: q0.question,
    options: q0.options,
    multiSelect: q0.multiSelect,
    questions: normalized,
  };
}

function summarizeToolArgs(name, args) {
  if (!args || typeof args !== 'object') return '';
  const clean = (v) => String(v ?? '').replace(/^"|"$/g, '');
  if (args.toolSummary) return clean(args.toolSummary);
  if (args.Path) return basename(clean(args.Path)) || clean(args.Path);
  if (args.CommandLine) return clean(args.CommandLine).slice(0, 80);
  if (args.query) return clean(args.query).slice(0, 80);
  if (args.Role) return `${clean(args.TypeName || 'subagent')}: ${clean(args.Role)}`;
  if (name === 'ask_question') {
    const parsed = parseAskQuestionArgs(args);
    if (parsed?.question) return parsed.question.slice(0, 80);
  }
  if (name === 'swarm' && args.action) {
    const act = clean(args.action);
    const mod = args.model ? ` → ${clean(args.model)}` : '';
    return `swarm ${act}${mod}`;
  }
  const firstVal = Object.values(args)[0];
  return firstVal ? clean(firstVal).slice(0, 60) : name;
}

function humanizeToolActivity(name, args) {
  const clean = (v) => String(v ?? '').replace(/^"|"$/g, '').trim();
  const fileBase = args?.Path ? basename(clean(args.Path)) : '';
  const summary = args?.toolSummary ? clean(args.toolSummary) : '';
  switch (name) {
    case 'read_file':
    case 'view_file':
      return fileBase ? `正在读文件 · ${fileBase}` : '正在读文件…';
    case 'write_file':
    case 'edit_file':
      return fileBase ? `正在改代码 · ${fileBase}` : '正在改代码…';
    case 'run_command':
      return summary ? `正在跑命令 · ${summary}` : '正在跑命令…';
    case 'search_web':
      return '正在搜网页…';
    case 'invoke_subagent':
      return args?.Role ? `正在调度子代理 · ${clean(args.Role)}` : '正在调度子代理…';
    case 'swarm':
      return '正在切换模型或编排代理…';
    case 'schedule':
      return '正在设置定时任务…';
    case 'ask_question':
      return '等待你的确认…';
    default: {
      const s = summarizeToolArgs(name || 'tool', args);
      return s ? `正在执行 · ${s}` : '思考中…';
    }
  }
}

const MAX_PENDING_TASK_AGE_MS = 20 * 60 * 1000;

function isPlausibleWorkspacePathOrUri(value) {
  if (!value || typeof value !== 'string') return false;
  return (
    value.startsWith('/') ||
    value.startsWith('~/') ||
    /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ||
    /^[a-z]:[\\/]/i.test(value)
  );
}

export function uriToPath(uriOrPath, { allowCommaSplit = true, depth = 0, requireValidCandidate = false } = {}) {
  if (!uriOrPath || depth > 4) return '';
  if (Array.isArray(uriOrPath)) {
    for (const item of uriOrPath) {
      const resolved = uriToPath(item, { allowCommaSplit: false, depth: depth + 1, requireValidCandidate: true });
      if (resolved) return resolved;
    }
    return '';
  }
  if (typeof uriOrPath === 'object') {
    for (const key of [
      'workspaceFolderAbsoluteUri',
      'folderUri',
      'workspaceUri',
      'uri',
      'folderPath',
      'path',
    ]) {
      const candidate = uriOrPath[key];
      if (!candidate) continue;
      const resolved = uriToPath(candidate, { allowCommaSplit: false, depth: depth + 1, requireValidCandidate: true });
      if (resolved) return resolved;
    }
    return '';
  }
  if (typeof uriOrPath !== 'string') return '';
  const trimmed = uriOrPath.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('[') || trimmed.startsWith('"') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed !== trimmed) {
        return uriToPath(parsed, { allowCommaSplit: false, depth: depth + 1, requireValidCandidate });
      }
    } catch {
      // Not valid JSON; continue with plain URI/path handling.
    }
  }
  const first =
    allowCommaSplit && /,\s*file:\/\//i.test(trimmed)
      ? trimmed.split(/,\s*(?=file:\/\/)/i)[0].trim()
      : trimmed;
  if (!first) return '';
  let resolved = first;
  if (/^file:\/\//i.test(first)) {
    const normalizedFileUri = `file://${first.slice(7)}`;
    try {
      resolved = fileURLToPath(normalizedFileUri);
    } catch {
      const stripped = first.replace(/^file:\/\//i, '');
      try {
        resolved = decodeURIComponent(stripped);
      } catch {
        resolved = stripped;
      }
    }
  }
  if (resolved.length > 1 && resolved.endsWith('/')) {
    resolved = resolved.replace(/\/+$/, '') || '/';
  }
  if (requireValidCandidate && !isPlausibleWorkspacePathOrUri(resolved)) {
    return '';
  }
  return resolved;
}

function parsePbtxtTitle(txt) {
  const m = /\btitle:\s*"((?:[^"\\]|\\.)*)"/.exec(String(txt || ''));
  if (!m) return '';
  const raw = m[1];
  const bytes = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '\\' && i + 1 < raw.length) {
      const next = raw[i + 1];
      if (next >= '0' && next <= '7') {
        let oct = next;
        if (i + 2 < raw.length && raw[i + 2] >= '0' && raw[i + 2] <= '7') {
          oct += raw[i + 2];
          if (i + 3 < raw.length && raw[i + 3] >= '0' && raw[i + 3] <= '7') {
            oct += raw[i + 3];
          }
        }
        bytes.push(parseInt(oct, 8) & 0xff);
        i += oct.length;
        continue;
      }
      if (next === 'n') { bytes.push(0x0a); i++; continue; }
      if (next === 'r') { bytes.push(0x0d); i++; continue; }
      if (next === 't') { bytes.push(0x09); i++; continue; }
      if (next === '"' || next === '\\' || next === "'") {
        bytes.push(next.charCodeAt(0));
        i++;
        continue;
      }
    }
    const cp = raw.codePointAt(i);
    if (cp > 0xffff) i++;
    const chBuf = Buffer.from(String.fromCodePoint(cp), 'utf8');
    for (const b of chBuf) bytes.push(b);
  }
  return Buffer.from(bytes).toString('utf8').trim();
}

export class BrainScanner {
  constructor({
    appDataDirs = null,
    projectsRoot = process.env.ANTIGRAVITYZ_PROJECTS_ROOT || join(homedir(), 'Projects'),
    projectsConfigDir = null,
    agentController = null,
    metaStore = null,
  } = {}) {
    this.explicitAppDataDirs = appDataDirs;
    this.projectsRoot = projectsRoot;
    this.desktopProjects = new DesktopProjects(projectsConfigDir || undefined);
    this.agentController = agentController;
    this.metaStore = metaStore;
    this.transcriptCache = new Map();
    this.metadataCache = new Map();
    this.summariesDbCache = new Map();
    this.convStepsDbCache = new Map();
    this.subagentsByParent = new Map();
    this.annotationsCache = new Map();
    this.liveHooks = new Map();
    this.inFlightTools = new Map(); // convId -> { id, name, summary, bypassSandbox, commandLine, askQuestion, startedAt }
  }

  readDesktopProjects() {
    return this.desktopProjects.read();
  }

  discoverAppDataDirs() {
    if (Array.isArray(this.explicitAppDataDirs) && this.explicitAppDataDirs.length > 0) {
      return this.explicitAppDataDirs.filter((d) => existsSync(join(d, 'brain')));
    }
    const candidates = [];
    const execDataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
    if (execDataDir) {
      let cur = execDataDir;
      while (cur && cur !== resolvePath(cur, '..')) {
        if (basename(cur) === 'sidecar_data') {
          const parent = resolvePath(cur, '..');
          if (existsSync(join(parent, 'brain'))) candidates.push(parent);
          break;
        }
        cur = resolvePath(cur, '..');
      }
    }
    const geminiRoot = join(homedir(), '.gemini');
    for (const sub of ['antigravity', 'antigravity-ide', 'antigravity-cli']) {
      const full = join(geminiRoot, sub);
      if (!candidates.includes(full) && existsSync(join(full, 'brain'))) {
        candidates.push(full);
      }
    }
    return candidates;
  }

  readDesktopSummariesIndex(appData) {
    const dbPath = join(appData, 'conversation_summaries.db');
    const result = new Map();

    if (existsSync(dbPath)) {
      try {
        const dbStat = statSync(dbPath);
        const walPath = `${dbPath}-wal`;
        const walStat = existsSync(walPath) ? statSync(walPath) : null;
        const cacheKey = `${dbStat.mtimeMs}:${dbStat.size}:${walStat?.mtimeMs || 0}:${walStat?.size || 0}`;
        const cached = this.summariesDbCache.get(appData);
        if (cached && cached.key === cacheKey) {
          for (const [k, v] of cached.map.entries()) {
            result.set(k, { ...v });
          }
        } else {
          const freshMap = new Map();
          const db = new DatabaseSync(dbPath, { readOnly: true });
          try {
            let rows = [];
            try {
              rows = db
                .prepare(
                  `SELECT conversation_id, title, workspace_uris, project_id, status, parent_conversation_id, nesting_depth, not_fully_idle, killed, last_modified_time
                   FROM conversation_summaries`
                )
                .all();
            } catch {
              rows = db
                .prepare(
                  `SELECT conversation_id, title, workspace_uris, status, parent_conversation_id, nesting_depth, not_fully_idle, killed, last_modified_time
                   FROM conversation_summaries`
                )
                .all();
            }
            for (const row of rows) {
              if (!row?.conversation_id) continue;
              const modifiedMs = row.last_modified_time ? Date.parse(row.last_modified_time) || 0 : 0;
              freshMap.set(row.conversation_id, {
                title: typeof row.title === 'string' ? row.title.trim() : '',
                workspaceUri: typeof row.workspace_uris === 'string' ? row.workspace_uris.trim() : '',
                projectId: typeof row.project_id === 'string' ? row.project_id.trim() : '',
                status: typeof row.status === 'string' ? row.status.trim() : '',
                parentConversationId: typeof row.parent_conversation_id === 'string' ? row.parent_conversation_id.trim() : '',
                nestingDepth: Number(row.nesting_depth || 0),
                notFullyIdle: Boolean(row.not_fully_idle),
                killed: Boolean(row.killed),
                modifiedMs,
                pinned: false,
              });
            }
            try {
              const parentRows = db
                .prepare(`SELECT conversation_id, parent_id FROM conversation_parents`)
                .all();
              for (const pr of parentRows) {
                if (!pr?.conversation_id || !pr?.parent_id) continue;
                const existing = freshMap.get(pr.conversation_id);
                if (existing) {
                  if (!existing.parentConversationId) {
                    existing.parentConversationId = String(pr.parent_id).trim();
                  }
                  existing.nestingDepth = Math.max(existing.nestingDepth || 0, 1);
                } else {
                  freshMap.set(pr.conversation_id, {
                    title: '',
                    workspaceUri: '',
                    status: '',
                    parentConversationId: String(pr.parent_id).trim(),
                    nestingDepth: 1,
                    notFullyIdle: false,
                    killed: false,
                    modifiedMs: 0,
                    pinned: false,
                  });
                }
              }
            } catch {
              // Optional table in synthetic test DBs
            }
          } finally {
            db.close();
          }
          this.summariesDbCache.set(appData, { key: cacheKey, map: freshMap });
          for (const [k, v] of freshMap.entries()) {
            result.set(k, { ...v });
          }
        }
      } catch {
        // Ignore transient SQLite lock/checkpoint states
      }
    }

    const annDir = join(appData, 'annotations');
    if (existsSync(annDir)) {
      try {
        for (const entry of readdirSync(annDir, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.endsWith('.pbtxt')) continue;
          const convId = entry.name.slice(0, -'.pbtxt'.length);
          const fPath = join(annDir, entry.name);
          const st = statSync(fPath);
          const annCacheKey = `${st.mtimeMs}:${st.size}`;
          let ann = this.annotationsCache.get(fPath);
          if (!ann || ann.cacheKey !== annCacheKey) {
            const txt = readFileSync(fPath, 'utf-8');
            const pinned = /\bpinned:\s*true\b/.test(txt);
            const archived = /\barchived:\s*true\b/.test(txt);
            const title = parsePbtxtTitle(txt);
            const viewMatch = /last_user_view_time:\s*\{\s*seconds:\s*(\d+)(?:\s+nanos:\s*(\d+))?\s*\}/.exec(txt);
            const lastUserViewMs = viewMatch
              ? Number(viewMatch[1]) * 1000 + Math.floor(Number(viewMatch[2] || 0) / 1e6)
              : 0;
            ann = { cacheKey: annCacheKey, mtimeMs: st.mtimeMs, pinned, archived, title, lastUserViewMs };
            this.annotationsCache.set(fPath, ann);
          }
          const existing = result.get(convId) || {
            title: '',
            workspaceUri: '',
            projectId: '',
            status: '',
            parentConversationId: '',
            nestingDepth: 0,
            notFullyIdle: false,
            killed: false,
            archived: false,
            modifiedMs: st.mtimeMs,
            pinned: false,
            lastUserViewMs: 0,
          };
          existing.pinned = Boolean(ann.pinned);
          existing.archived = Boolean(ann.archived);
          // Desktop Antigravity updates `annotations/<id>.pbtxt` atomically upon every rename,
          // often before `conversation_summaries.db` WAL checkpoints flush.
          if (ann.title) {
            existing.title = ann.title;
          }
          existing.lastUserViewMs = Math.max(existing.lastUserViewMs || 0, ann.lastUserViewMs || 0);
          result.set(convId, existing);
        }
      } catch {
        // Ignore annotation parse errors
      }
    }

    return result;
  }

  recordHookEvent(payload) {
    const convId = payload?.conversationId;
    if (!convId || !SAFE_CONV_RE.test(convId)) return null;
    const hookName = String(payload.hookEventName || '');
    const toolCall = payload?.toolCall || null;
    const toolName = toolCall?.name || payload?.toolName || payload?.tool_name || null;
    const prev = this.liveHooks.get(convId) || {};
    const workspacePaths = Array.isArray(payload.workspacePaths) && payload.workspacePaths.length > 0
      ? payload.workspacePaths
      : (prev.workspacePaths || []);

    let activity = prev.activity || 'idle';
    let detail = prev.detail || '';
    let stoppedAt = prev.stoppedAt || 0;
    let continuationActive = false;
    if (hookName === 'SessionStart') {
      this.inFlightTools.delete(convId);
      activity = 'thinking';
      detail = '思考中…';
      stoppedAt = 0;
    } else if (hookName === 'PreInvocation') {
      this.inFlightTools.delete(convId);
      activity = 'thinking';
      detail = '思考中…';
      stoppedAt = 0;
    } else if (hookName === 'PreToolUse') {
      const args = toolCall?.args || toolCall?.arguments || payload?.toolInput || payload?.tool_input || {};
      const clean = (v) => String(v ?? '').replace(/^"|"$/g, '');
      const bypass = args.BypassSandbox === true || clean(args.BypassSandbox) === 'true';
      const summary = summarizeToolArgs(toolName || 'tool', args);
      const askQuestion = toolName === 'ask_question' ? parseAskQuestionArgs(args) : null;
      const hookStepIdx = typeof payload.stepIdx === 'number' ? payload.stepIdx : null;
      this.inFlightTools.set(convId, {
        id: toolCall?.id || `pre-${Date.now()}`,
        stepIdx: hookStepIdx,
        name: toolName || 'tool',
        summary,
        bypassSandbox: bypass,
        commandLine: clean(args.CommandLine),
        askQuestion,
        startedAt: Date.now(),
      });
      activity = askQuestion ? 'waiting' : 'working';
      detail = askQuestion ? '等待你的确认…' : humanizeToolActivity(toolName || 'tool', args);
      stoppedAt = 0;
    } else if (hookName === 'PostToolUse') {
      this.inFlightTools.delete(convId);
      activity = 'thinking';
      detail = '思考中…';
      stoppedAt = 0;
    } else if (hookName === 'PostInvocation') {
      this.inFlightTools.delete(convId);
      activity = 'working';
      detail = '正在回复…';
      stoppedAt = 0;
    } else if (hookName === 'Stop') {
      this.inFlightTools.delete(convId);
      activity = 'idle';
      detail = '';
      stoppedAt = Date.now();
      continuationActive = Boolean(payload?.continuationActive);
    }

    const entry = {
      conversationId: convId,
      hookEventName: hookName,
      activity,
      detail,
      toolName,
      workspacePaths,
      modelName: payload.modelName || prev.modelName || null,
      stoppedAt,
      continuationActive,
      updatedAt: Date.now(),
    };
    this.liveHooks.set(convId, entry);

    if (this.metaStore && workspacePaths.length > 0) {
      this.metaStore.rememberWorkspace(convId, workspacePaths[0]);
    }
    return entry;
  }

  *#historicalWorkspacePaths(desktopProjects) {
    for (const appData of this.discoverAppDataDirs()) {
      for (const [id, dbEntry] of this.readDesktopSummariesIndex(appData)) {
        if (dbEntry.killed) continue;
        yield this.resolveWorkspaceBinding({
          dbEntry, meta: this.metadataCache.get(id)?.meta, desktopProjects,
        }).workspacePath;
      }
    }
    for (const { meta } of this.metadataCache.values()) {
      yield this.resolveWorkspaceBinding({ meta, desktopProjects }).workspacePath;
    }
    for (const hook of this.liveHooks.values()) {
      yield this.resolveWorkspaceBinding({ hook, desktopProjects }).workspacePath;
    }
  }

  listKnownProjectFolders({
    desktopProjects = this.readDesktopProjects(),
    historicalPaths = this.#historicalWorkspacePaths(desktopProjects),
  } = {}) {
    const seen = new Map();
    const resolved = new Map();
    const add = (path, source) => {
      if (!resolved.has(path)) resolved.set(path, findWorkspaceDirectory(path));
      const directory = resolved.get(path);
      if (!directory || seen.has(directory.resolvedPath)) return;
      seen.set(directory.resolvedPath, { ...workspacePathMetadata(directory.path), source });
    };

    const links = [];
    for (const root of new Set([this.projectsRoot, join(homedir(), 'Projects')])) {
      const directory = findWorkspaceDirectory(root);
      if (!directory || isLazyHomeDirectory(directory.path) || isLazyHomeDirectory(directory.resolvedPath)) continue;
      try {
        for (const entry of readdirSync(directory.path, { withFileTypes: true })) {
          if (entry.name.startsWith('.')) continue;
          const path = join(directory.path, entry.name);
          if (entry.isDirectory()) add(path, 'projectsRoot');
          else if (entry.isSymbolicLink()) links.push(path);
        }
      } catch {
        // Ignore unreadable directories
      }
    }
    for (const path of links) add(path, 'projectsRoot');
    for (const { id, folderPaths } of [...desktopProjects.values()].sort((a, b) => a.id.localeCompare(b.id))) {
      for (const path of folderPaths) {
        if (!seen.has(path)) seen.set(path, { ...workspacePathMetadata(path), source: 'desktopProject' });
        seen.get(path).desktopProjectId ??= id;
      }
    }
    const saved = this.metaStore?.listWorkspacePaths();
    for (const path of saved?.favorites || []) add(path, 'favorite');
    for (const path of saved?.recents || []) add(path, 'recent');
    for (const path of historicalPaths) add(path, 'history');
    for (const path of this.metaStore?.listRememberedWorkspaces() || []) add(path, 'history');
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  }

  findTranscriptPath(convDir) {
    const fullPath = join(convDir, '.system_generated', 'logs', 'transcript_full.jsonl');
    if (existsSync(fullPath)) return fullPath;
    const compactPath = join(convDir, '.system_generated', 'logs', 'transcript.jsonl');
    if (existsSync(compactPath)) return compactPath;
    return null;
  }

  parseTranscript(convDir) {
    const emptyResult = {
      items: [],
      firstUserText: '',
      lastPreview: '',
      lastTimestamp: null,
      lastAssistantReplyMs: 0,
      lastAssistantStepIndex: -1,
      lastAssistantReplySig: '',
      lastAssistantLegacyImageReplySig: '',
      stepCount: 0,
      lastStepIndex: null,
      lastStepType: null,
      inferredWorkspace: null,
      detectedModelRaw: null,
      detectedMode: null,
      unansweredQuestion: null,
      spawnedSubagents: [],
      hasPendingBackgroundTasks: false,
      pendingTaskCount: 0,
      pendingSubagentCount: 0,
      pendingTaskStartedTimes: [],
      pendingSubagentStartedTimes: [],
      mtimeMs: 0,
    };
    const tPath = this.findTranscriptPath(convDir);
    if (!tPath) return emptyResult;
    let st;
    try {
      st = statSync(tPath);
    } catch {
      return emptyResult;
    }

    const cacheKey = `${st.mtimeMs}:${st.size}`;
    const cached = this.transcriptCache.get(tPath);
    if (cached && cached.key === cacheKey) return cached.parsed;

    const rawText = readFileSync(tPath, 'utf-8');
    const lines = rawText.split('\n');
    const items = [];
    const spawnedSubagents = [];
    const turnPendingTasks = new Map(); // taskId -> startedAtMs
    const turnPendingSubagents = new Map(); // subagentConvId -> startedAtMs
    let firstUserText = '';
    let lastPreview = '';
    let lastTimestamp = null;
    let lastAssistantReplyMs = 0;
    let lastAssistantStepIndex = -1;
    let lastAssistantReplySig = '';
    let lastAssistantLegacyImageReplySig = '';
    let hasNonBookkeepingStepAfterLastAssistant = false;
    let stepCount = 0;
    let lastStepIndex = null;
    let lastStepType = null;
    let detectedModelRaw = null;
    let detectedMode = null;
    let unansweredQuestion = null;
    let pendingToolBatch = null;
    const workspaceScores = new Map();
    const candidateRoots = [this.projectsRoot];
    const homeProjects = join(homedir(), 'Projects');
    if (!candidateRoots.includes(homeProjects)) candidateRoots.push(homeProjects);

    const scoreTextForProjects = (str, weight) => {
      if (!str || typeof str !== 'string') return;
      for (const root of candidateRoots) {
        const prefix = root + sep;
        let idx = str.indexOf(prefix);
        while (idx !== -1) {
          const rest = str.slice(idx + prefix.length);
          const projName = rest.split(/[/\s"'`\\]/)[0];
          if (projName && !projName.startsWith('.')) {
            const fullProj = join(root, projName);
            workspaceScores.set(fullProj, (workspaceScores.get(fullProj) || 0) + weight);
          }
          idx = str.indexOf(prefix, idx + prefix.length);
        }
      }
    };

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let step;
      try {
        step = JSON.parse(trimmed);
      } catch {
        continue;
      }
      stepCount++;
      const stepIdx = typeof step.step_index === 'number' ? step.step_index : stepCount - 1;
      lastStepIndex = stepIdx;
      const createdAt = step.created_at || null;
      if (createdAt) lastTimestamp = createdAt;
      lastStepType = step.type || null;

      if (step.type === 'USER_INPUT') {
        if (lastAssistantStepIndex >= 0) {
          hasNonBookkeepingStepAfterLastAssistant = true;
        }
        pendingToolBatch = null;
        unansweredQuestion = null;
        turnPendingTasks.clear();
        turnPendingSubagents.clear();
        const rawContent = step.content || '';
        const settings = extractSettingsChanges(rawContent);
        if (settings.modelName) {
          detectedModelRaw = settings.modelName;
        }
        const desktopAtts = extractDesktopAttachments(step);
        const text = stripUserWrapper(rawContent);
        if (!text && desktopAtts.length === 0) continue;
        if (text) scoreTextForProjects(text, 2);
        if (!firstUserText && text) firstUserText = text;
        lastPreview = stripInlineAttachmentMarkdown(text || `[附件] ${desktopAtts.map((a) => a.name).join('、')}`).slice(0, 140);

        // Deduplicate if `[AntigravityZ_USER_PROMPT]` SYSTEM_MESSAGE arrived right before USER_INPUT
        const prevItem = items[items.length - 1];
        if (
          prevItem &&
          prevItem.role === 'user' &&
          prevItem.origin === 'ios' &&
          isSameUserTurnText(prevItem.content, text)
        ) {
          prevItem.stepIndex = stepIdx;
          prevItem.createdAt = createdAt || prevItem.createdAt;
          if (desktopAtts.length > 0 && (!prevItem.attachments || prevItem.attachments.length === 0)) {
            prevItem.attachments = desktopAtts;
          }
          continue;
        }

        items.push({
          id: `step-${stepIdx}`,
          stepIndex: stepIdx,
          role: 'user',
          origin: step.source === 'USER_EXPLICIT' ? 'desktop' : 'ios',
          content: text,
          thinking: null,
          toolCalls: [],
          attachments: desktopAtts,
          createdAt,
        });
      } else if (step.type === 'SYSTEM_MESSAGE') {
        const sysContent = String(step.content || '');
        const mobile = extractMobilePrompt(sysContent);
        if (mobile && mobile.text) {
          if (lastAssistantStepIndex >= 0) {
            hasNonBookkeepingStepAfterLastAssistant = true;
          }
          pendingToolBatch = null;
          unansweredQuestion = null;
          turnPendingTasks.clear();
          turnPendingSubagents.clear();
          if (mobile.mode) detectedMode = mobile.mode;
          if (!firstUserText && !mobile.isControlOnly) firstUserText = mobile.text;
          lastPreview = stripInlineAttachmentMarkdown(mobile.text).slice(0, 140);

          // Deduplicate when PreInvocation hook injected `USER_INPUT` right BEFORE `[AntigravityZ_USER_PROMPT]` SYSTEM_MESSAGE!
          const prevItem = items[items.length - 1];
          if (
            prevItem &&
            prevItem.role === 'user' &&
            isSameUserTurnText(prevItem.content, mobile.text)
          ) {
            if (mobile.clientMessageId) {
              prevItem.id = mobile.clientMessageId;
            }
            prevItem.origin = 'ios';
            prevItem.content = mobile.text;
            prevItem.stepIndex = stepIdx;
            prevItem.createdAt = createdAt || prevItem.createdAt;
            continue;
          }

          items.push({
            id: mobile.clientMessageId || `step-${stepIdx}`,
            stepIndex: stepIdx,
            role: 'user',
            origin: 'ios',
            content: mobile.text,
            thinking: null,
            toolCalls: [],
            attachments: [],
            createdAt,
          });
        } else {
          // Track completion of background tasks & subagents launched during the active turn
          const senderMatch = /\bsender=([^\s\n]+)/.exec(sysContent);
          if (senderMatch) {
            turnPendingTasks.delete(senderMatch[1]);
            turnPendingSubagents.delete(senderMatch[1]);
          }
          const taskDoneMatch =
            /Task id "([^"]+)"\s+(?:finished|failed|cancelled|canceled|killed|stopped|exited)/i.exec(sysContent);
          if (taskDoneMatch) {
            turnPendingTasks.delete(taskDoneMatch[1]);
          }
        }
      } else if (step.type === 'PLANNER_RESPONSE') {
        const rawToolCalls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
        const cleanVal = (v) => String(v ?? '').replace(/^"|"$/g, '').trim();
        const batchMeta = [];
        const mappedTools = rawToolCalls.map((tc, i) => {
          const args = tc?.args || {};
          const tName = tc?.name || 'tool';
          const rawDaemon = args.IsDaemon;
          const isDaemon = rawDaemon === true || cleanVal(rawDaemon).toLowerCase() === 'true';
          batchMeta.push({ isDaemon });
          const cleanPath = cleanVal(args.Path);
          const weight = (tName === 'write_file' || tName === 'edit_file') ? 5 : (tName === 'run_command' ? 3 : 1);
          scoreTextForProjects(cleanPath, weight);
          if (args.CommandLine) scoreTextForProjects(String(args.CommandLine), 3);

          if (tName === 'manage_task' && cleanVal(args.Action) === 'kill') {
            const killId = cleanVal(args.TaskId);
            if (killId) turnPendingTasks.delete(killId);
          }
          if (tName === 'manage_subagents') {
            const act = cleanVal(args.Action);
            if (act === 'kill_all') {
              turnPendingSubagents.clear();
            } else if (act === 'kill' && Array.isArray(args.ConversationIds)) {
              for (const cid of args.ConversationIds) {
                turnPendingSubagents.delete(cleanVal(cid));
              }
            }
          }

          if (tName === 'swarm' && cleanVal(args.action) === 'model') {
            const targetName = cleanVal(args.name);
            const targetModel = cleanVal(args.model);
            if (targetModel && (!targetName || targetName === 'coordinator')) {
              detectedModelRaw = targetModel;
            }
          }
          if (tName === 'ask_question') {
            const parsedQ = parseAskQuestionArgs(args);
            if (parsedQ) {
              unansweredQuestion = {
                id: tc?.id || `ask-${stepIdx}-${i}`,
                kind: 'question',
                title: '等待你的确认',
                prompt: parsedQ.question,
                options: parsedQ.options,
                multiSelect: parsedQ.multiSelect,
                questions: parsedQ.questions,
              };
            }
          }
          if (tName === 'invoke_subagent') {
            spawnedSubagents.push({
              role: cleanVal(args.Role || 'Subagent'),
              typeName: cleanVal(args.TypeName || 'subagent'),
            });
          }
          return {
            id: tc?.id || `tc-${stepIdx}-${i}`,
            name: tName,
            summary: summarizeToolArgs(tName, args),
            status: 'done',
            outputPreview: '',
          };
        });

        const rawAssistantContent = typeof step.content === 'string' ? step.content.trim() : '';
        const { cleanedContent: content, legacyContent, attachments: assistantAtts } = extractAssistantInlineImages(
          rawAssistantContent,
          convDir,
          step.media
        );
        const thinking = typeof step.thinking === 'string' ? step.thinking.trim() : '';
        if (content || assistantAtts.length > 0) {
          const replyMs = createdAt ? Date.parse(createdAt) : 0;
          const effectiveReplyMs = Number.isFinite(replyMs) && replyMs > 0 ? replyMs : st.mtimeMs;
          if (effectiveReplyMs > lastAssistantReplyMs) {
            lastAssistantReplyMs = effectiveReplyMs;
          }
          if (stepIdx >= lastAssistantStepIndex) {
            lastAssistantStepIndex = stepIdx;
            lastAssistantReplySig = assistantReplySignature(stepIdx, content, assistantAtts.length);
            lastAssistantLegacyImageReplySig = legacyContent === null ? '' : assistantReplySignature(stepIdx, legacyContent, assistantAtts.length);
            hasNonBookkeepingStepAfterLastAssistant = false;
          }
        } else if (mappedTools.length > 0 && lastAssistantStepIndex >= 0) {
          hasNonBookkeepingStepAfterLastAssistant = true;
        }
        const { displayContent, leakedTail } = sanitizeAssistantLeakedTail(content);
        if (displayContent) {
          lastPreview = stripInlineAttachmentMarkdown(displayContent).replace(/\s+/g, ' ').slice(0, 140);
        } else if (assistantAtts.length > 0) {
          lastPreview = stripInlineAttachmentMarkdown(`[图片] ${assistantAtts.map((a) => a.name).join('、')}`).slice(0, 140);
        } else if (leakedTail !== null) {
          lastPreview = LEAKED_ASSISTANT_PREVIEW_FALLBACK;
        }

        const isTurnFinal = mappedTools.length === 0 && (Boolean(content) || assistantAtts.length > 0);
        const assistantItem = {
          id: `step-${stepIdx}`,
          stepIndex: stepIdx,
          role: 'assistant',
          origin: 'agent',
          content,
          ...(legacyContent !== null ? { legacyContent } : {}),
          thinking: thinking || null,
          toolCalls: mappedTools,
          attachments: assistantAtts,
          isTurnFinal,
          createdAt,
        };
        items.push(assistantItem);
        pendingToolBatch = mappedTools.length > 0 ? { tools: mappedTools, meta: batchMeta, cursor: 0 } : null;
      } else if (step.type === 'GENERIC') {
        const out = String(step.content || '').trim();
        for (const re of [
          /Wait cancelled\s*\(\s*task\s+([^\s),]+)/gi,
          /Task\s+(?:id\s+)?"([^"]+)"\s+(?:finished|failed|cancelled|canceled|killed|stopped|exited)/gi,
          /\bTask\s+([0-9a-zA-Z_-]+\/task-\d+)\s+(?:finished|failed|cancelled|canceled|killed|stopped|exited)/gi,
        ]) {
          for (const match of out.matchAll(re)) {
            if (match[1]) turnPendingTasks.delete(match[1]);
          }
        }
        if (pendingToolBatch) {
          if (lastAssistantStepIndex >= 0) {
            hasNonBookkeepingStepAfterLastAssistant = true;
          }
          const targetTool = pendingToolBatch.tools[pendingToolBatch.cursor];
          const targetMeta = pendingToolBatch.meta?.[pendingToolBatch.cursor] || { isDaemon: false };
          if (targetTool) {
            targetTool.outputPreview = out.slice(0, 600);
            targetTool.status = step.status === 'ERROR' ? 'error' : 'done';
            if (targetTool.name === 'ask_question' && step.status === 'DONE') {
              unansweredQuestion = null;
            }
            const convMatch = /conversationId["\s:=]+([0-9a-f-]{36})/i.exec(out);
            if (convMatch && targetTool.name === 'invoke_subagent') {
              targetTool.subagentConversationId = convMatch[1];
              const startedMs = createdAt ? Date.parse(createdAt) || st.mtimeMs : st.mtimeMs;
              turnPendingSubagents.set(convMatch[1], startedMs);
            }
            const isAsyncBgTool =
              targetTool.name === 'run_command' ||
              targetTool.name === 'run_workflow' ||
              targetTool.name === 'schedule';
            if (!targetMeta.isDaemon && isAsyncBgTool) {
              const bgTaskMatch = /^Tool is running as a background task with task id:\s*([^\s\n]+)/im.exec(out);
              if (bgTaskMatch) {
                const startedMs = createdAt ? Date.parse(createdAt) || st.mtimeMs : st.mtimeMs;
                turnPendingTasks.set(bgTaskMatch[1], startedMs);
              } else if (
                step.status === 'RUNNING' &&
                (targetTool.name === 'run_command' || targetTool.name === 'run_workflow')
              ) {
                const startedMs = createdAt ? Date.parse(createdAt) || st.mtimeMs : st.mtimeMs;
                turnPendingTasks.set(`step-${stepIdx}`, startedMs);
              }
            }
            pendingToolBatch.cursor++;
          }
        }
      } else if (step.type === 'ERROR_MESSAGE' || step.status === 'ERROR') {
        const errText = String(step.content || '执行过程中出现错误').trim();
        lastPreview = stripInlineAttachmentMarkdown(errText).slice(0, 140);
        const errMs = createdAt ? Date.parse(createdAt) : 0;
        const effectiveErrMs = Number.isFinite(errMs) && errMs > 0 ? errMs : st.mtimeMs;
        if (effectiveErrMs > lastAssistantReplyMs) {
          lastAssistantReplyMs = effectiveErrMs;
        }
        if (stepIdx >= lastAssistantStepIndex) {
          lastAssistantStepIndex = stepIdx;
          lastAssistantReplySig = `${stepIdx}:err:${errText.length}:${replyDigest(errText)}`;
          lastAssistantLegacyImageReplySig = '';
          hasNonBookkeepingStepAfterLastAssistant = false;
        }
        items.push({
          id: `step-${stepIdx}`,
          stepIndex: stepIdx,
          role: 'error',
          origin: 'system',
          content: errText,
          thinking: null,
          toolCalls: [],
          createdAt,
        });
      }
    }

    const mergedItems = [];
    for (const item of items) {
      const prev = mergedItems[mergedItems.length - 1];
      if (
        prev &&
        prev.role === 'assistant' &&
        item.role === 'assistant' &&
        !prev.content &&
        (!prev.attachments || prev.attachments.length === 0)
      ) {
        if (item.thinking) {
          prev.thinking = prev.thinking ? `${prev.thinking}\n\n${item.thinking}` : item.thinking;
        }
        prev.toolCalls.push(...item.toolCalls);
        if (item.content) prev.content = item.content;
        if (Array.isArray(item.attachments) && item.attachments.length > 0) {
          prev.attachments = [...(prev.attachments || []), ...item.attachments];
        }
        prev.isTurnFinal = Boolean(item.isTurnFinal);
        prev.stepIndex = item.stepIndex;
        prev.createdAt = item.createdAt || prev.createdAt;
      } else {
        mergedItems.push({
          ...item,
          toolCalls: [...item.toolCalls],
          attachments: Array.isArray(item.attachments) ? [...item.attachments] : [],
        });
      }
    }

    let inferredWorkspace = null;
    let bestScore = 0;
    for (const [projPath, sc] of workspaceScores.entries()) {
      if (sc > bestScore) {
        bestScore = sc;
        inferredWorkspace = projPath;
      }
    }

    const nowMs = Date.now();
    const pendingTaskStartedTimes = [...turnPendingTasks.values()].map((t) => (Number.isFinite(t) && t > 0 ? t : st.mtimeMs));
    const pendingSubagentStartedTimes = [...turnPendingSubagents.values()].map((t) => (Number.isFinite(t) && t > 0 ? t : st.mtimeMs));
    const pendingTaskCount = pendingTaskStartedTimes.filter((t) => nowMs - t < MAX_PENDING_TASK_AGE_MS).length;
    const pendingSubagentCount = pendingSubagentStartedTimes.filter((t) => nowMs - t < MAX_PENDING_TASK_AGE_MS).length;
    const hasPendingBackgroundTasks = pendingTaskCount > 0 || pendingSubagentCount > 0;

    const MAX_TURN_GENERATION_MS = 20 * 60 * 1000;
    if (
      lastAssistantStepIndex >= 0 &&
      lastStepIndex === lastAssistantStepIndex &&
      !hasNonBookkeepingStepAfterLastAssistant &&
      st.mtimeMs > lastAssistantReplyMs &&
      st.mtimeMs - lastAssistantReplyMs <= MAX_TURN_GENERATION_MS
    ) {
      lastAssistantReplyMs = st.mtimeMs;
    }

    const parsed = {
      items: mergedItems,
      firstUserText,
      lastPreview,
      lastTimestamp,
      lastAssistantReplyMs,
      lastAssistantStepIndex,
      lastAssistantReplySig,
      lastAssistantLegacyImageReplySig,
      stepCount,
      lastStepIndex,
      lastStepType,
      inferredWorkspace,
      detectedModelRaw,
      detectedMode,
      unansweredQuestion,
      spawnedSubagents,
      hasPendingBackgroundTasks,
      pendingTaskCount,
      pendingSubagentCount,
      pendingTaskStartedTimes,
      pendingSubagentStartedTimes,
      mtimeMs: st.mtimeMs,
    };
    this.transcriptCache.set(tPath, { key: cacheKey, parsed });
    return parsed;
  }

  #extractPromptFromPermissionsBlob(rawBlob) {
    if (!rawBlob) return '';
    try {
      const buf = Buffer.from(rawBlob);
      const ascii = buf.toString('utf8');
      const matches = ascii.match(/[\x20-\x7e\u4e00-\u9fff]{6,}/g) || [];
      const cleaned = matches
        .map((s) => s.trim())
        .filter((s) => s !== 'command' && !s.startsWith('*.command'));
      if (cleaned.length > 0) {
        cleaned.sort((a, b) => b.length - a.length);
        return cleaned[0].slice(0, 180);
      }
    } catch {
      // Ignore malformed blob
    }
    return '';
  }

  #extractWaitingStepDetails(row, matchingInFlight = null) {
    let toolName = matchingInFlight?.name || '';
    let toolSummary = matchingInFlight?.summary || '';
    let commandLine = matchingInFlight?.commandLine || '';
    let targetPath = '';
    let askReason = '';
    let parsedArgs = null;

    if (row?.step_payload) {
      try {
        const rawLatin = Buffer.from(row.step_payload).toString('latin1');
        const rawUtf8 = Buffer.from(row.step_payload).toString('utf8');

        const toolMatch = /call_[0-9A-Za-z_]+[\x00-\x1f]+([a-z][a-z0-9_]{1,40})[\x00-\x1f]+/.exec(rawLatin);
        if (toolMatch?.[1] && !toolName) {
          toolName = toolMatch[1];
        } else if (!toolName && rawUtf8.includes('ask_question')) {
          toolName = 'ask_question';
        }

        const searchFrom = toolName ? Math.max(0, rawUtf8.indexOf(toolName)) : 0;
        const jsonCandidate =
          extractBalancedJsonObject(rawUtf8, searchFrom) ||
          extractBalancedJsonObject(rawUtf8, 0);
        if (jsonCandidate) {
          try {
            parsedArgs = JSON.parse(jsonCandidate);
            if (typeof parsedArgs.toolSummary === 'string' && parsedArgs.toolSummary.trim()) {
              toolSummary = parsedArgs.toolSummary.trim();
            }
            if (typeof parsedArgs.CommandLine === 'string' && parsedArgs.CommandLine.trim()) {
              commandLine = parsedArgs.CommandLine.trim();
            }
            if (typeof parsedArgs.Path === 'string' && parsedArgs.Path.trim()) {
              targetPath = parsedArgs.Path.trim();
            }
          } catch {
            // Ignore partial JSON match
          }
        }

        const askIdx = rawUtf8.indexOf('\x03ask*');
        if (askIdx !== -1) {
          const afterAsk = rawUtf8.slice(askIdx + 5, askIdx + 460);
          const reasonMatch = /([A-Z\u4e00-\u9fff][\x20-\x7e\u4e00-\u9fff]{12,360})/.exec(afterAsk);
          if (reasonMatch?.[1]) {
            askReason = reasonMatch[1].trim();
          }
        }
      } catch {
        // Ignore payload parse errors
      }
    }

    if (toolName === 'ask_question' && parsedArgs) {
      const q = parseAskQuestionArgs(parsedArgs);
      if (q) {
        return {
          id: `ask-step-${row.idx}`,
          kind: 'question',
          title: '等待你的确认',
          prompt: q.question,
          options: q.options,
          multiSelect: q.multiSelect,
          questions: q.questions,
        };
      }
    }

    const decodedPerm = this.#extractPromptFromPermissionsBlob(row?.permissions);
    const primaryTarget = commandLine || targetPath || decodedPerm || toolSummary;
    const promptParts = [];
    if (primaryTarget) promptParts.push(primaryTarget);
    if (askReason && askReason !== primaryTarget) promptParts.push(askReason);

    return {
      id: `perm-step-${row.idx}`,
      kind: 'permission_waiting',
      title: toolSummary ? `等待授权 · ${toolSummary}` : '桌面端等待系统授权',
      prompt: promptParts.join('\n') || '请在电脑端或网页版确认权限请求',
      options: [],
      multiSelect: false,
    };
  }

  /**
   * Authoritative permission-wait check backed directly by Antigravity 2.0's live SQLite trajectory DB
   * (`~/.gemini/antigravity/conversations/<convId>.db`).
   *
   * Verified against live Antigravity 2.0 step state machine:
   * - `status = 1`: PENDING (queued), `status = 2`: RUNNING (including Auto-mode LLM safety check), `status = 3`: DONE.
   * - `status = 9`: `CORTEX_STEP_STATUS_WAITING` ("Waiting for user input.") — entered ONLY when manual user approval
   *   is required! Crucially, `permissions` remains `NULL` while `status = 9` (it is only populated AFTER the user
   *   submits their decision), while `step_payload` already holds the tool args & safety review reason.
   */
  readAuthoritativePermissionWait(convId, convDir, inFlight = null) {
    const state = this.readAuthoritativeStepsState(convId, convDir, inFlight);
    return state.waiting;
  }

  readAuthoritativeStepsState(convId, convDir, inFlight = null) {
    if (!convDir) return { hasDb: false, waiting: null };
    const appDataDir = resolvePath(convDir, '..', '..');
    const dbPath = join(appDataDir, 'conversations', `${convId}.db`);
    if (!existsSync(dbPath)) return { hasDb: false, waiting: null };

    try {
      const now = Date.now();
      const dbStat = statSync(dbPath);
      const walPath = `${dbPath}-wal`;
      const walStat = existsSync(walPath) ? statSync(walPath) : null;
      const cacheKey = `${dbStat.mtimeMs}:${dbStat.size}:${walStat?.mtimeMs || 0}:${walStat?.size || 0}`;
      const cached = this.convStepsDbCache.get(dbPath);
      if (cached && cached.key === cacheKey && now - cached.checkedAt < 450) {
        return { hasDb: true, waiting: cached.waiting };
      }

      let waiting = null;
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        // 1. Authoritative WAITING (status = 9): permission prompt or waiting question
        let row = null;
        try {
          row = db
            .prepare(
              `SELECT idx, status, permissions, step_payload
               FROM steps
               WHERE status = 9
               ORDER BY idx DESC
               LIMIT 1`
            )
            .get();
        } catch {
          row = db
            .prepare(
              `SELECT idx, status, permissions
               FROM steps
               WHERE status = 9
               ORDER BY idx DESC
               LIMIT 1`
            )
            .get();
        }
        if (row) {
          const matchingInFlight = inFlight && inFlight.stepIdx === row.idx ? inFlight : null;
          waiting = this.#extractWaitingStepDetails(row, matchingInFlight);
        }

        // 2. Active ask_question steps live in status = 1 (PENDING) or 2 (RUNNING) while
        // waiting for the user to select an answer in the Antigravity UI! Detect immediately
        // BEFORE the user submits, instead of waiting for post-submit transcript flush.
        if (!waiting) {
          let activeRows = [];
          try {
            activeRows = db
              .prepare(
                `SELECT idx, status, permissions, step_payload
                 FROM steps
                 WHERE status IN (1, 2)
                 ORDER BY idx DESC
                 LIMIT 4`
              )
              .all();
          } catch {
            activeRows = [];
          }
          for (const activeRow of activeRows) {
            if (!activeRow?.step_payload) continue;
            const payloadBuf = Buffer.from(activeRow.step_payload);
            if (!payloadBuf.includes('ask_question')) continue;
            const candidate = this.#extractWaitingStepDetails(activeRow, inFlight);
            if (candidate && candidate.kind === 'question') {
              waiting = candidate;
              break;
            }
          }
        }
      } finally {
        db.close();
      }
      this.convStepsDbCache.set(dbPath, { key: cacheKey, checkedAt: now, waiting });
      return { hasDb: true, waiting };
    } catch {
      return { hasDb: false, waiting: null };
    }
  }

  resolvePendingInteraction(convId, parsedTranscript, convDir = null) {
    const inFlight = this.inFlightTools.get(convId);
    if (inFlight) {
      if (inFlight.askQuestion) {
        return {
          id: inFlight.id,
          kind: 'question',
          title: '等待你的确认',
          prompt: inFlight.askQuestion.question,
          options: inFlight.askQuestion.options,
          multiSelect: inFlight.askQuestion.multiSelect,
          questions: inFlight.askQuestion.questions,
        };
      }
      if (
        inFlight.stepIdx !== null &&
        parsedTranscript.lastStepIndex !== null &&
        parsedTranscript.lastStepIndex >= inFlight.stepIdx
      ) {
        this.inFlightTools.delete(convId);
      }
    }

    const dbState = this.readAuthoritativeStepsState(convId, convDir, inFlight);
    if (dbState.waiting) {
      return dbState.waiting;
    }
    // When the live SQLite steps DB exists and reports NO active waiting/ask_question step,
    // trust SQLite as authoritative so a brief post-submit transcript flush lag NEVER fires
    // a stale ghost notification after the user already answered!
    if (dbState.hasDb) {
      return null;
    }

    if (parsedTranscript.unansweredQuestion) {
      return parsedTranscript.unansweredQuestion;
    }
    return null;
  }

  listArtifacts(convDir) {
    try {
      const entries = readdirSync(convDir, { withFileTypes: true });
      const artifacts = [];
      for (const entry of entries) {
        if (!entry.isFile() || entry.name.startsWith('.')) continue;
        const ext = extname(entry.name).toLowerCase();
        if (!ARTIFACT_EXTS.has(ext)) continue;
        const full = join(convDir, entry.name);
        const st = statSync(full);
        artifacts.push({
          name: entry.name,
          ext,
          kind: ['.png', '.jpg', '.jpeg', '.webp', '.svg'].includes(ext) ? 'image' : 'markdown',
          sizeBytes: st.size,
          updatedAt: new Date(st.mtimeMs).toISOString(),
        });
      }
      return artifacts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    } catch {
      return [];
    }
  }

  async resolveMetadata(convId) {
    const now = Date.now();
    const cached = this.metadataCache.get(convId);
    if (cached && now - cached.fetchedAt < 600_000) {
      return cached.meta;
    }
    if (!this.agentController) return null;
    try {
      const meta = await this.agentController.getConversationMetadata(convId);
      if (meta) {
        this.metadataCache.set(convId, { fetchedAt: now, meta });
      }
      return meta;
    } catch {
      return cached?.meta || null;
    }
  }

  evaluatePendingBackgroundTasks(parsedTranscript, dbEntry = null, nowMs = Date.now()) {
    const taskTimes = Array.isArray(parsedTranscript?.pendingTaskStartedTimes)
      ? parsedTranscript.pendingTaskStartedTimes
      : [];
    const subTimes = Array.isArray(parsedTranscript?.pendingSubagentStartedTimes)
      ? parsedTranscript.pendingSubagentStartedTimes
      : [];
    const activeTaskTimes = taskTimes.filter((t) => Number.isFinite(t) && t > 0 && nowMs - t < MAX_PENDING_TASK_AGE_MS);
    const activeSubTimes = subTimes.filter((t) => Number.isFinite(t) && t > 0 && nowMs - t < MAX_PENDING_TASK_AGE_MS);
    if (activeTaskTimes.length === 0 && activeSubTimes.length === 0) {
      return { hasPendingBackgroundTasks: false, pendingTaskCount: 0, pendingSubagentCount: 0 };
    }
    if (dbEntry && dbEntry.status === 'CASCADE_RUN_STATUS_IDLE' && !dbEntry.notFullyIdle) {
      const latestPendingStart = Math.max(0, ...activeTaskTimes, ...activeSubTimes);
      if (!dbEntry.modifiedMs || dbEntry.modifiedMs >= latestPendingStart - 1000) {
        return { hasPendingBackgroundTasks: false, pendingTaskCount: 0, pendingSubagentCount: 0 };
      }
    }
    return {
      hasPendingBackgroundTasks: true,
      pendingTaskCount: activeTaskTimes.length,
      pendingSubagentCount: activeSubTimes.length,
    };
  }

  computeRunState(convId, parsedTranscript, dbEntry = null, pendingInteraction = null) {
    if (pendingInteraction?.kind === 'permission_waiting') {
      return {
        state: 'running',
        activity: 'waiting',
        detail: '桌面端等待系统授权…',
      };
    }
    if (pendingInteraction?.kind === 'question') {
      return {
        state: 'running',
        activity: 'waiting',
        detail: '等待你的确认…',
      };
    }

    const hook = this.liveHooks.get(convId);
    const now = Date.now();
    const pendingBg = this.evaluatePendingBackgroundTasks(parsedTranscript, dbEntry, now);
    const lastItem = parsedTranscript.items[parsedTranscript.items.length - 1];
    const lastItemMs = lastItem?.createdAt ? Date.parse(lastItem.createdAt) || 0 : 0;

    // If Desktop cancelled/interrupted generation (writing an ERROR_MESSAGE like
    // "Error: The stream was interrupted...") or finished a turn-final reply / flipped SQLite
    // explicitly back to IDLE AFTER the last active hook WITHOUT firing a `Stop` hook,
    // expire the stale live hook immediately instead of hanging in `思考中…` for 90s!
    const hookInvalidatedByTerminalTranscript = Boolean(
      hook &&
      hook.activity !== 'idle' &&
      (
        (lastItem?.role === 'error' && (lastItemMs >= hook.updatedAt - 1000 || parsedTranscript.mtimeMs >= hook.updatedAt)) ||
        (lastItem?.role === 'assistant' && lastItem.isTurnFinal && Math.max(lastItemMs, parsedTranscript.lastAssistantReplyMs || 0) > hook.updatedAt + 500 && dbEntry?.status === 'CASCADE_RUN_STATUS_IDLE' && !dbEntry?.notFullyIdle) ||
        (dbEntry?.status === 'CASCADE_RUN_STATUS_IDLE' && !dbEntry?.notFullyIdle && dbEntry?.modifiedMs > hook.updatedAt + 800 && !pendingBg.hasPendingBackgroundTasks)
      )
    );
    if (hookInvalidatedByTerminalTranscript) {
      this.inFlightTools.delete(convId);
      this.liveHooks.set(convId, {
        ...hook,
        hookEventName: 'Stop',
        continuationActive: false,
        activity: 'idle',
        detail: '',
        stoppedAt: now,
        updatedAt: now,
      });
    }

    const effectiveHook = this.liveHooks.get(convId);
    if (effectiveHook && now - effectiveHook.updatedAt < 90_000 && effectiveHook.activity !== 'idle') {
      return {
        state: 'running',
        activity: effectiveHook.activity,
        detail: effectiveHook.detail || '思考中…',
      };
    }
    if (pendingBg.hasPendingBackgroundTasks) {
      const detailMsg =
        pendingBg.pendingSubagentCount > 0 && pendingBg.pendingTaskCount === 0
          ? '等待子代理完成…'
          : '等待后台任务完成…';
      return {
        state: 'running',
        activity: 'working',
        detail: detailMsg,
      };
    }

    const hasNewerUserTurnAfterStop =
      Boolean(effectiveHook?.stoppedAt) &&
      lastItem?.role === 'user' &&
      lastItemMs > effectiveHook.stoppedAt + 200;
    // Antigravity fires the `Stop` hook synchronously BEFORE SQLite flips
    // `conversation_summaries.status` / `not_fully_idle` back to idle (often 1–5s later).
    // Trust a recent non-continuation `Stop` hook (or terminal error/interrupt step) over stale
    // SQLite running flags so `runState`, `lastPreview`, and `hasUnread` flip atomically!
    const hasAuthoritativeRecentStop =
      (
        (Boolean(effectiveHook && effectiveHook.hookEventName === 'Stop' && !effectiveHook.continuationActive) &&
          now - effectiveHook.updatedAt < 15_000) ||
        hookInvalidatedByTerminalTranscript
      ) &&
      !hasNewerUserTurnAfterStop;

    if (!hasAuthoritativeRecentStop && dbEntry && (dbEntry.status === 'CASCADE_RUN_STATUS_RUNNING' || dbEntry.notFullyIdle)) {
      return {
        state: 'running',
        activity: 'thinking',
        detail: '思考中…',
      };
    }
    if (!hasAuthoritativeRecentStop && parsedTranscript.mtimeMs && now - parsedTranscript.mtimeMs < 25_000) {
      if (lastItem && (lastItem.role === 'user' || (lastItem.role === 'assistant' && !lastItem.content))) {
        return {
          state: 'running',
          activity: 'thinking',
          detail: '思考中…',
        };
      }
    }
    if (lastItem?.role === 'error') {
      const isStreamInterrupted = /stream was interrupted|user_canceled|cancelled|canceled/i.test(lastItem.content || '');
      if (isStreamInterrupted) {
        return { state: 'idle', activity: 'idle', detail: '' };
      }
      return { state: 'error', activity: 'error', detail: '执行出错' };
    }
    return { state: 'idle', activity: 'idle', detail: '' };
  }

  resolveTitle({ convId, parsed, dbEntry, savedMeta, meta }) {
    const autoTitle = parsed.firstUserText
      ? parsed.firstUserText.replace(/\s+/g, ' ').slice(0, 48)
      : `会话 ${convId.slice(0, 8)}`;

    // Desktop Antigravity (`annotations/*.pbtxt` + `conversation_summaries.db`) is always
    // the authoritative single source of truth for conversation titles.
    if (dbEntry?.title) {
      return dbEntry.title;
    }
    return savedMeta?.title || meta?.subagentSpec?.role || autoTitle;
  }

  resolveWorkspaceBinding({ dbEntry, meta, hook, savedMeta, desktopProjects }) {
    let workspacePath = '';
    let workspaceName = '';
    const projectId = dbEntry?.projectId || meta?.projectId || '';
    const realProject =
      projectId && projectId !== 'outside-of-project'
        ? desktopProjects?.get(projectId) || null
        : null;

    if (dbEntry?.workspaceUri) {
      workspacePath = uriToPath(dbEntry.workspaceUri);
    }
    if (!workspacePath && meta?.workspaceUris?.length) {
      workspacePath = uriToPath(meta.workspaceUris);
    }
    if (!workspacePath && meta?.workspaces?.length) {
      workspacePath = uriToPath(meta.workspaces);
    }
    if (!workspacePath && realProject) {
      workspacePath = realProject.folderPath || `project://${realProject.id}`;
      workspaceName = realProject.name || (realProject.folderPath ? basename(realProject.folderPath) : '项目');
    }
    if (!workspacePath && hook?.workspacePaths?.length) {
      workspacePath = uriToPath(hook.workspacePaths);
    }
    if (!workspacePath && savedMeta?.workspacePath) {
      workspacePath = uriToPath(savedMeta.workspacePath);
    }

    if (workspacePath && !workspaceName) {
      const canonical = (p) => {
        if (!p) return '';
        try {
          return realpathSync(p);
        } catch {
          return p;
        }
      };
      const canonicalWorkspace = canonical(workspacePath);
      const matchesRealProject =
        realProject &&
        realProject.name &&
        ((realProject.folderPath && (workspacePath === realProject.folderPath || canonicalWorkspace === canonical(realProject.folderPath))) ||
          (Array.isArray(realProject.folderPaths) &&
            realProject.folderPaths.some((fp) => workspacePath === fp || canonicalWorkspace === canonical(fp))));
      workspaceName = matchesRealProject ? realProject.name : basename(workspacePath);
    }

    return {
      workspacePath: workspacePath || null,
      workspaceName: workspacePath ? (workspaceName || basename(workspacePath)) : '通用对话',
    };
  }

  resolveModelAndMode(convId, parsed) {
    const savedMeta = this.metaStore ? this.metaStore.getConversationMeta(convId) : null;
    const hook = this.liveHooks.get(convId);
    const hookInfo = lookupModelInfo(hook?.modelName);
    const transcriptInfo = lookupModelInfo(parsed.detectedModelRaw);
    const detectedInfo = hookInfo || transcriptInfo;
    // Always prioritize Desktop's real running model over stale local preferences;
    // fall back to savedMeta.desiredModel ONLY when a newly created session has not yet emitted a model change.
    const fallbackCreatedInfo = lookupModelInfo(savedMeta?.desiredModel);
    const effective = detectedInfo || fallbackCreatedInfo;
    return {
      detectedModelId: detectedInfo?.id || null,
      currentModelId: effective?.id || null,
      currentModelDisplay: effective?.displayName || null,
      currentModelShort: effective?.shortLabel || null,
      sessionMode: savedMeta?.sessionMode || parsed.detectedMode || 'agent',
    };
  }

  async scanAll({ includeMetadata = true, includeKnownProjects = true } = {}) {
    const appDataDirs = this.discoverAppDataDirs();
    const rawConvs = [];

    for (const appData of appDataDirs) {
      const surface = basename(appData) === 'antigravity-cli' ? 'cli' : 'desktop';
      const dbIndex = this.readDesktopSummariesIndex(appData);

      const brainRoot = join(appData, 'brain');
      let entries = [];
      try {
        entries = readdirSync(brainRoot, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.isDirectory() || !SAFE_CONV_RE.test(entry.name)) continue;
        const convId = entry.name;
        const dbEntry = dbIndex.get(convId) || null;
        if (dbEntry?.killed) continue;

        const convDir = join(brainRoot, convId);
        let dirStat;
        try {
          dirStat = statSync(convDir);
        } catch {
          continue;
        }
        const parsed = this.parseTranscript(convDir);
        const artifacts = this.listArtifacts(convDir);
        rawConvs.push({
          id: convId,
          appData,
          surface,
          convDir,
          dirMtimeMs: dirStat.mtimeMs,
          dbEntry,
          parsed,
          artifacts,
        });
      }
    }

    rawConvs.sort((a, b) => {
      const ta = a.parsed.mtimeMs || a.dirMtimeMs;
      const tb = b.parsed.mtimeMs || b.dirMtimeMs;
      return tb - ta;
    });

    if (includeMetadata && this.agentController) {
      // `conversation_summaries.db` already supplies title/workspace/parent/depth in <1ms;
      // only fall back to `agentapi get-conversation-metadata` for conversations missing from the DB index.
      const needsMeta = rawConvs
        .filter((c) => c.surface === 'desktop' && UUID_RE.test(c.id) && !c.dbEntry)
        .slice(0, 6);
      if (needsMeta.length > 0) {
        await Promise.all(needsMeta.map((c) => this.resolveMetadata(c.id)));
      }
    }

    const desktopProjects = this.readDesktopProjects();
    const byId = new Map();
    for (const c of rawConvs) {
      const meta = this.metadataCache.get(c.id)?.meta || null;
      const savedMeta = this.metaStore ? this.metaStore.getConversationMeta(c.id) : null;
      const hook = this.liveHooks.get(c.id);
      const dbEntry = c.dbEntry;

      const { workspacePath, workspaceName } = this.resolveWorkspaceBinding({
        dbEntry,
        meta,
        hook,
        savedMeta,
        desktopProjects,
      });

      const parentId =
        dbEntry?.parentConversationId ||
        meta?.parentConversationId ||
        savedMeta?.parentConversationId ||
        '';
      const isSubagent = Boolean(
        parentId ||
          (dbEntry?.nestingDepth && dbEntry.nestingDepth > 0) ||
          (meta?.nestingDepth && meta.nestingDepth > 0) ||
          meta?.subagentSpec
      );

      const title = this.resolveTitle({
        convId: c.id,
        parsed: c.parsed,
        dbEntry,
        savedMeta,
        meta,
      });

      const pendingMsgs = this.metaStore ? this.metaStore.getPendingMessages(c.id) : [];
      const latestPending = pendingMsgs.length > 0 ? pendingMsgs[pendingMsgs.length - 1] : null;
      const pendingInteraction = this.resolvePendingInteraction(c.id, c.parsed, c.convDir);
      const runStatus = this.computeRunState(c.id, c.parsed, dbEntry, pendingInteraction);
      const nowScanMs = Date.now();
      let updatedMs = c.parsed.mtimeMs || c.dirMtimeMs;
      let effectivePreview = c.parsed.lastPreview || '暂无消息';
      if (latestPending && latestPending.sentAt > updatedMs) {
        updatedMs = latestPending.sentAt;
        if (latestPending.text) {
          effectivePreview = stripInlineAttachmentMarkdown(latestPending.text).replace(/\s+/g, ' ').slice(0, 140);
        }
      }
      if (runStatus.state === 'running' && hook && hook.activity !== 'idle' && nowScanMs - hook.updatedAt < 90_000) {
        updatedMs = Math.max(updatedMs, hook.updatedAt);
      }
      const updatedAt = c.parsed.lastTimestamp && updatedMs === c.parsed.mtimeMs
        ? c.parsed.lastTimestamp
        : new Date(updatedMs).toISOString();
      const modelAndMode = this.resolveModelAndMode(c.id, c.parsed);
      const pinned = Boolean(dbEntry?.pinned);
      const archived = Boolean(dbEntry?.archived);
      const flagged = Boolean(savedMeta?.flagged);
      const flagNote =
        flagged && typeof savedMeta?.flagNote === 'string' && savedMeta.flagNote.trim()
          ? savedMeta.flagNote.trim()
          : null;
      const desktopViewedMs = dbEntry?.lastUserViewMs || 0;
      const iosViewedMs = savedMeta?.iosViewedMs || 0;
      const iosViewedStepIndex =
        typeof savedMeta?.iosViewedStepIndex === 'number' && Number.isFinite(savedMeta.iosViewedStepIndex)
          ? savedMeta.iosViewedStepIndex
          : null;
      const iosViewedReplySig = typeof savedMeta?.iosViewedReplySig === 'string' ? savedMeta.iosViewedReplySig : '';
      const lastReplyMs = c.parsed.lastAssistantReplyMs || 0;
      const lastAssistantStepIndex =
        typeof c.parsed.lastAssistantStepIndex === 'number' ? c.parsed.lastAssistantStepIndex : -1;
      const lastAssistantReplySig = c.parsed.lastAssistantReplySig || '';
      // Older cursors can omit the digest or fingerprint the reply with image Markdown removed.
      const legacyReplySig = lastAssistantReplySig.slice(0, lastAssistantReplySig.lastIndexOf(':'));
      const legacyImageReplySig = c.parsed.lastAssistantLegacyImageReplySig || '';
      const legacyImageReplySigWithoutDigest = legacyImageReplySig.slice(0, legacyImageReplySig.lastIndexOf(':'));
      let hasUnread = false;
      if (!archived && runStatus.state !== 'running') {
        if (pendingInteraction) {
          hasUnread = true;
        } else if (lastReplyMs > 0) {
          const readOnDesktop = desktopViewedMs > 0 && lastReplyMs <= desktopViewedMs + 1500;
          let readOnIos = false;
          if (iosViewedStepIndex !== null && lastAssistantStepIndex >= 0) {
            readOnIos =
              lastAssistantStepIndex < iosViewedStepIndex ||
              (lastAssistantStepIndex === iosViewedStepIndex &&
                (!iosViewedReplySig || iosViewedReplySig === lastAssistantReplySig || iosViewedReplySig === legacyReplySig ||
                  iosViewedReplySig === legacyImageReplySig || iosViewedReplySig === legacyImageReplySigWithoutDigest));
          } else if (iosViewedMs > 0) {
            readOnIos = lastReplyMs <= iosViewedMs + 250;
          }
          if (readOnDesktop || readOnIos) {
            hasUnread = false;
          } else if (desktopViewedMs > 0 || iosViewedMs > 0 || iosViewedStepIndex !== null) {
            hasUnread = true;
          } else {
            hasUnread = nowScanMs - lastReplyMs < 6 * 3600 * 1000;
          }
        }
      }

      byId.set(c.id, {
        id: c.id,
        title,
        pinned,
        archived,
        flagged,
        flagNote,
        hasUnread,
        lastReplyMs,
        surface: c.surface,
        workspacePath: workspacePath || null,
        workspaceName,
        parentConversationId: parentId || null,
        isSubagent,
        subagentRole: meta?.subagentSpec?.role || null,
        lastPreview: effectivePreview,
        stepCount: c.parsed.stepCount,
        messageCount: c.parsed.items.length,
        artifactCount: c.artifacts.length,
        artifacts: c.artifacts,
        runState: runStatus.state,
        activityDetail: runStatus.detail,
        currentModelId: modelAndMode.currentModelId,
        currentModelDisplay: modelAndMode.currentModelDisplay,
        currentModelShort: modelAndMode.currentModelShort,
        sessionMode: modelAndMode.sessionMode,
        pendingInteraction,
        updatedAt,
        updatedMs,
        convDir: c.convDir,
        subagents: [],
      });
    }

    const rootConversations = [];
    for (const conv of byId.values()) {
      if (conv.isSubagent && conv.parentConversationId && byId.has(conv.parentConversationId)) {
        const parent = byId.get(conv.parentConversationId);
        parent.subagents.push({
          id: conv.id,
          title: conv.title,
          role: conv.subagentRole || conv.title,
          lastPreview: conv.lastPreview,
          runState: conv.runState,
          activityDetail: conv.activityDetail,
          stepCount: conv.stepCount,
          updatedAt: conv.updatedAt,
        });
      } else if (!conv.isSubagent) {
        rootConversations.push(conv);
      }
    }

    const nextSubagentsByParent = new Map();
    for (const conv of rootConversations) {
      conv.subagents.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      if (conv.subagents.length > 0) {
        nextSubagentsByParent.set(conv.id, conv.subagents);
      }
    }
    this.subagentsByParent = nextSubagentsByParent;

    const workspaceMap = new Map();
    const ensureWorkspace = (wsPath, wsName, isGlobal = false) => {
      const key = isGlobal ? '__global__' : wsPath;
      if (!workspaceMap.has(key)) {
        workspaceMap.set(key, {
          id: key,
          name: wsName,
          path: isGlobal ? null : wsPath,
          isGlobal,
          conversations: [],
          activeCount: 0,
          latestUpdatedMs: 0,
        });
      }
      return workspaceMap.get(key);
    };

    let unreadCount = 0;
    const archivedConversations = [];
    for (const conv of rootConversations) {
      const savedMeta = this.metaStore ? this.metaStore.getConversationMeta(conv.id) : null;
      if (conv.messageCount === 0 && !savedMeta) continue;
      const { convDir, ...publicSummary } = conv;
      if (conv.archived) {
        archivedConversations.push(publicSummary);
        continue;
      }
      if (conv.hasUnread) unreadCount++;

      const isGlobal = !conv.workspacePath;
      const group = ensureWorkspace(conv.workspacePath, conv.workspaceName, isGlobal);
      group.conversations.push(publicSummary);
      if (conv.runState === 'running') group.activeCount++;
      if (conv.updatedMs > group.latestUpdatedMs) group.latestUpdatedMs = conv.updatedMs;
    }

    archivedConversations.sort((a, b) => b.updatedMs - a.updatedMs);

    const workspaces = [...workspaceMap.values()].sort((a, b) => {
      if (a.activeCount !== b.activeCount) return b.activeCount - a.activeCount;
      return b.latestUpdatedMs - a.latestUpdatedMs;
    });

    for (const ws of workspaces) {
      ws.conversations.sort((a, b) => {
        if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
        return b.updatedMs - a.updatedMs;
      });
    }

    return {
      workspaces,
      archivedConversations,
      knownProjects: includeKnownProjects ? this.listKnownProjectFolders({
        desktopProjects,
        historicalPaths: [...byId.values()].map((conv) => conv.workspacePath),
      }) : [],
      totalConversations: rootConversations.length - archivedConversations.length,
      unreadCount,
    };
  }

  getConversationReadCursor(convId) {
    if (!SAFE_CONV_RE.test(String(convId || ''))) {
      return { stepIndex: -1, replySig: '' };
    }
    for (const appData of this.discoverAppDataDirs()) {
      const convDir = join(appData, 'brain', convId);
      if (!existsSync(convDir)) continue;
      const parsed = this.parseTranscript(convDir);
      return {
        stepIndex: typeof parsed.lastAssistantStepIndex === 'number' ? parsed.lastAssistantStepIndex : -1,
        replySig: parsed.lastAssistantReplySig || '',
      };
    }
    return { stepIndex: -1, replySig: '' };
  }

  async getConversationDetail(convId) {
    if (!SAFE_CONV_RE.test(convId)) return null;
    for (const appData of this.discoverAppDataDirs()) {
      const convDir = join(appData, 'brain', convId);
      if (!existsSync(convDir)) continue;
      const dbIndex = this.readDesktopSummariesIndex(appData);
      const dbEntry = dbIndex.get(convId) || null;
      const parsed = this.parseTranscript(convDir);
      const artifacts = this.listArtifacts(convDir);
      const meta = dbEntry ? (this.metadataCache.get(convId)?.meta || null) : await this.resolveMetadata(convId);
      const savedMeta = this.metaStore ? this.metaStore.getConversationMeta(convId) : null;
      const pendingInteraction = this.resolvePendingInteraction(convId, parsed, convDir);
      const runStatus = this.computeRunState(convId, parsed, dbEntry, pendingInteraction);
      const modelAndMode = this.resolveModelAndMode(convId, parsed);

      const desktopProjects = this.readDesktopProjects();
      const hook = this.liveHooks.get(convId);
      const { workspacePath, workspaceName } = this.resolveWorkspaceBinding({
        dbEntry,
        meta,
        hook,
        savedMeta,
        desktopProjects,
      });

      const title = this.resolveTitle({
        convId,
        parsed,
        dbEntry,
        savedMeta,
        meta,
      });

      let subagents = this.subagentsByParent.get(convId) || [];
      if (subagents.length === 0 && this.subagentsByParent.size === 0) {
        const allScan = await this.scanAll({ includeMetadata: false });
        for (const ws of allScan.workspaces) {
          const match = ws.conversations.find((c) => c.id === convId);
          if (match) {
            subagents = match.subagents || [];
            break;
          }
        }
      }

      const attMap = this.metaStore ? this.metaStore.getMessageAttachmentsMap(convId) : {};
      const items = parsed.items.map((it) => {
        const savedAtts = attMap[it.id];
        if (Array.isArray(savedAtts) && savedAtts.length > 0) {
          return { ...it, attachments: savedAtts };
        }
        // For new-conversation initial user step (`step-0`), bind `ios-init-*` attachments if present
        if (it.stepIndex === 0 && it.role === 'user' && (!it.attachments || it.attachments.length === 0)) {
          const initKey = Object.keys(attMap).find((k) => k.startsWith('ios-init-'));
          if (initKey && Array.isArray(attMap[initKey])) {
            return { ...it, attachments: attMap[initKey] };
          }
        }
        return it;
      });
      const pending = this.metaStore ? this.metaStore.getPendingMessages(convId) : [];
      for (const p of pending) {
        const alreadyInTranscript = items.some(
          (it) =>
            it.id === p.clientMessageId ||
            (it.role === 'user' &&
              (it.content === p.text || it.content.startsWith(p.text)) &&
              Date.parse(it.createdAt || 0) >= p.sentAt - 15_000)
        );
        if (!alreadyInTranscript) {
          items.push({
            id: p.clientMessageId,
            stepIndex: 999999,
            role: 'user',
            origin: 'ios',
            content: p.text,
            thinking: null,
            toolCalls: [],
            attachments: p.attachments || attMap[p.clientMessageId] || [],
            createdAt: new Date(p.sentAt).toISOString(),
            pending: false,
          });
        } else if (this.metaStore) {
          this.metaStore.clearPendingMessage(convId, p.clientMessageId);
        }
      }

      let isSubagentInMap = false;
      for (const list of this.subagentsByParent.values()) {
        if (list.some((s) => s.id === convId)) {
          isSubagentInMap = true;
          break;
        }
      }
      const parentConversationId =
        dbEntry?.parentConversationId || meta?.parentConversationId || null;
      const isSubagent = Boolean(
        parentConversationId || (dbEntry?.nestingDepth || 0) > 0 || isSubagentInMap
      );

      const pendingBg = this.evaluatePendingBackgroundTasks(parsed, dbEntry);
      return {
        id: convId,
        title,
        pinned: Boolean(dbEntry?.pinned),
        archived: Boolean(dbEntry?.archived),
        parentConversationId,
        isSubagent,
        surface: basename(appData) === 'antigravity-cli' ? 'cli' : 'desktop',
        workspacePath: workspacePath || null,
        workspaceName,
        runState: runStatus.state,
        activityDetail: runStatus.detail,
        hasPendingBackgroundTasks: pendingBg.hasPendingBackgroundTasks,
        notFullyIdle: Boolean(dbEntry?.notFullyIdle),
        detectedModelId: modelAndMode.detectedModelId,
        currentModelId: modelAndMode.currentModelId,
        currentModelDisplay: modelAndMode.currentModelDisplay,
        currentModelShort: modelAndMode.currentModelShort,
        sessionMode: modelAndMode.sessionMode,
        pendingInteraction,
        items,
        subagents,
        artifacts,
        convDir,
      };
    }
    return null;
  }

  resolveUploadedFilePath(convId, fileName) {
    if (!SAFE_CONV_RE.test(convId)) return null;
    const cleanName = basename(String(fileName || '').trim());
    if (!cleanName || cleanName.startsWith('.')) return null;

    for (const appData of this.discoverAppDataDirs()) {
      const convDir = resolvePath(join(appData, 'brain', convId));
      if (!existsSync(convDir)) continue;
      let realConvPrefix;
      try {
        realConvPrefix = realpathSync(convDir) + sep;
      } catch {
        continue;
      }
      const candidateDirs = [
        resolvePath(join(convDir, '.user_uploaded')),
        resolvePath(join(convDir, 'uploads')),
        convDir,
        resolvePath(join(convDir, 'scratch')),
      ];
      for (const dir of candidateDirs) {
        const candidate = resolvePath(join(dir, cleanName));
        if (candidate.startsWith(dir + sep) && existsSync(candidate)) {
          try {
            const realCandidate = realpathSync(candidate);
            if (!realCandidate.startsWith(realConvPrefix)) continue;
            if (statSync(realCandidate).isFile()) return candidate;
          } catch {
            // Ignore unreadable file
          }
        }
      }
    }
    return null;
  }
}
