/**
 * AgentController — Wraps official Google Antigravity `agentapi` binary
 * for native Desktop session messaging, live model/thinking/mode switching,
 * and new conversation / workspace initialization.
 */
import { execFile } from 'node:child_process';
import { accessSync, constants as fsConstants, copyFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { promisify } from 'node:util';
import { lookupModelInfo } from './model-catalog.mjs';
import {
  checkWorkspaceVolume, DesktopProjects, findWorkspaceDirectory, matchingDesktopProjects,
  openWorkspaceDirectory, resolveWorkspaceDirectory,
} from './workspace-paths.mjs';

const execFileAsync = promisify(execFile);
const PROJECT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const UUID_FIND_RE = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;

const MODE_DIRECTIVES = {
  plan: '[SESSION_MODE: PLAN] 当前会话处于「规划模式」：请先完整调研分析，列出清晰的实施方案与关键决策点同用户对齐，在收到明确确认信号前不要直接修改业务源码或执行破坏性操作。',
  boost: '[SESSION_MODE: BOOST] 当前会话处于「深度攻坚模式」：请展开多视角深度推理、边界条件审查与严密测试验证，给出最彻底稳健的实现。',
  goal: '[SESSION_MODE: GOAL] 当前会话处于「目标死磕模式」：请持续自主推进、自行验证测试并排查一切隐患，直到目标完整达成为止。',
};

export class AgentController {
  constructor({
    agentApiPath = null,
    projectsRoot = process.env.ANTIGRAVITYZ_PROJECTS_ROOT || join(homedir(), 'Projects'),
    expectedMount = process.env.ANTIGRAVITYZ_REQUIRED_MOUNT || '',
    projectsConfigDir,
    brainDirsProvider = null,
    execFn = null,
  } = {}) {
    this.agentApiPath = agentApiPath || join(homedir(), '.gemini', 'antigravity', 'bin', 'agentapi');
    this.projectsRoot = projectsRoot;
    this.expectedMount = expectedMount;
    this.desktopProjects = new DesktopProjects(projectsConfigDir);
    this.brainDirsProvider = brainDirsProvider;
    this.execFn = execFn || ((bin, args, opts) => execFileAsync(bin, args, opts));
  }

  isAvailable() {
    try {
      accessSync(this.agentApiPath, fsConstants.X_OK);
      return true;
    } catch {
      return Boolean(this.execFn && this.agentApiPath === 'mock-agentapi');
    }
  }

  async getConversationMetadata(conversationId) {
    if (!this.isAvailable()) return null;
    try {
      const { stdout } = await this.execFn(
        this.agentApiPath,
        ['get-conversation-metadata', conversationId],
        { timeout: 6000, maxBuffer: 2 * 1024 * 1024 }
      );
      const parsed = JSON.parse(stdout);
      return parsed?.response?.conversationMetadata?.metadata || parsed?.metadata || null;
    } catch {
      return null;
    }
  }

  async ensureProjectDirectory(projectName) {
    const cleanName = String(projectName || '').trim();
    if (!PROJECT_NAME_RE.test(cleanName)) {
      throw new Error('项目名称仅支持字母、数字、点、下划线和连字符');
    }
    checkWorkspaceVolume(resolvePath(this.projectsRoot));
    if (this.expectedMount && !existsSync(this.expectedMount)) {
      throw new Error(`目标存储卷 ${this.expectedMount} 未挂载，已中止创建`);
    }
    if (!existsSync(this.projectsRoot)) {
      mkdirSync(this.projectsRoot, { recursive: true });
    }
    try {
      accessSync(this.projectsRoot, fsConstants.W_OK);
    } catch {
      throw new Error(`项目根目录 ${this.projectsRoot} 不可写，已中止创建`);
    }
    const targetDir = resolvePath(this.projectsRoot, cleanName);
    if (!targetDir.startsWith(resolvePath(this.projectsRoot) + '/')) {
      throw new Error('非法的项目路径');
    }
    if (!existsSync(targetDir)) {
      mkdirSync(targetDir, { recursive: true });
      try {
        await execFileAsync('git', ['init'], { cwd: targetDir, timeout: 5000 });
      } catch {
        // Non-fatal if git init is unavailable
      }
    }
    return targetDir;
  }

  resolveConversationUploadDir(conversationId) {
    const dirs = this.brainDirsProvider ? this.brainDirsProvider() : [join(homedir(), '.gemini', 'antigravity')];
    let chosenBrainRoot = join(dirs[0] || join(homedir(), '.gemini', 'antigravity'), 'brain');
    for (const appData of dirs) {
      const candidate = join(appData, 'brain', conversationId);
      if (existsSync(candidate)) {
        chosenBrainRoot = join(appData, 'brain');
        break;
      }
    }
    const uploadDir = join(chosenBrainRoot, conversationId, '.user_uploaded');
    mkdirSync(uploadDir, { recursive: true });
    return uploadDir;
  }

  materializeAttachments(conversationId, rawAttachments = [], metaStore = null, { keepStagingCopy = false } = {}) {
    if (!Array.isArray(rawAttachments) || rawAttachments.length === 0) return [];
    const uploadDir = conversationId ? this.resolveConversationUploadDir(conversationId) : null;
    const materialized = [];

    for (const item of rawAttachments) {
      const uploadId = typeof item === 'string' ? item : item?.uploadId || item?.id;
      const staged = uploadId && metaStore ? metaStore.getStagedUpload(uploadId) : null;
      const srcPath = staged?.stagedPath || item?.stagedPath;
      if (!srcPath || !existsSync(srcPath)) continue;

      const fileName = staged?.fileName || item?.fileName || `upload_${Date.now()}`;
      const kind = staged?.kind || item?.kind || 'file';
      let finalPath = srcPath;
      let previewPath = srcPath;
      if (uploadDir) {
        finalPath = join(uploadDir, fileName);
        if (finalPath !== srcPath) {
          copyFileSync(srcPath, finalPath);
          if (!keepStagingCopy) {
            try {
              unlinkSync(srcPath);
            } catch {
              // Ignore
            }
            if (uploadId && metaStore) {
              metaStore.consumeStagedUpload(uploadId);
            }
          }
        }
        if (kind === 'image') {
          try {
            const convArtifactUploadsDir = join(resolvePath(uploadDir, '..'), 'uploads');
            mkdirSync(convArtifactUploadsDir, { recursive: true });
            previewPath = join(convArtifactUploadsDir, fileName);
            if (!existsSync(previewPath)) {
              copyFileSync(finalPath, previewPath);
            }
          } catch {
            previewPath = finalPath;
          }
        } else {
          previewPath = finalPath;
        }
      }

      materialized.push({
        id: uploadId || fileName,
        name: staged?.name || item?.name || fileName,
        fileName,
        kind,
        mimeType: staged?.mimeType || item?.mimeType || 'application/octet-stream',
        sizeBytes: Number(staged?.sizeBytes || item?.sizeBytes || 0),
        localPath: finalPath,
        previewPath,
      });
    }
    return materialized;
  }

  buildSystemDirective({ workspacePath = null, sessionMode = 'agent', attachments = [] } = {}) {
    const directives = [];
    if (workspacePath) {
      directives.push(`[Active Project Workspace: ${workspacePath}]`);
    }
    if (sessionMode && MODE_DIRECTIVES[sessionMode]) {
      directives.push(MODE_DIRECTIVES[sessionMode]);
    }
    if (Array.isArray(attachments) && attachments.length > 0) {
      const lines = attachments.map((a) => `- ${a.localPath} (${a.name}, ${a.mimeType})`);
      directives.push(`The user has uploaded ${attachments.length} attachment(s) — inspect them directly with read_file:\n${lines.join('\n')}`);
    }
    return directives.join('\n');
  }

  buildMobilePayload(text, { clientMessageId, workspacePath, sessionMode = 'agent', attachments = [] } = {}) {
    const attrs = [];
    if (clientMessageId) attrs.push(`id=${clientMessageId}`);
    if (sessionMode && sessionMode !== 'agent') attrs.push(`mode=${sessionMode}`);
    const attrStr = attrs.length > 0 ? ` ${attrs.join(' ')}` : '';
    const sysDir = this.buildSystemDirective({ workspacePath, sessionMode, attachments });
    const dirBlock = sysDir ? `\n${sysDir}` : '';
    return `[AntigravityZ_USER_PROMPT${attrStr}]${dirBlock}\n(Mobile client wakeup — if an identical USER_INPUT step immediately follows via PreInvocation hook, treat them as a single user turn and execute once.)\n<USER_PROMPT>\n${String(text || '').trim()}\n</USER_PROMPT>`;
  }

  async sendMessage(
    conversationId,
    text,
    {
      clientMessageId = null,
      workspacePath = null,
      sessionMode = 'agent',
      attachments = [],
      metaStore = null,
    } = {}
  ) {
    const materialized = this.materializeAttachments(conversationId, attachments, metaStore);
    const rawCleanText = String(text || '').trim();
    const cleanText = rawCleanText || (materialized.length > 0 ? `请查看附件：${materialized.map((a) => a.name).join('、')}` : '');
    if (!cleanText) throw new Error('消息内容不能为空');
    if (!this.isAvailable()) {
      throw new Error(`未找到可执行的官方 agentapi: ${this.agentApiPath}`);
    }

    if (metaStore && materialized.length > 0) {
      metaStore.recordMessageAttachments(conversationId, clientMessageId, materialized);
    }

    // Keep clickable file links directly in `userMessage` and avoid `systemMessage.metadata.user_markdown`
    // which Antigravity's protojson hook unmarshaler rejects (previously dropping the entire `injectSteps` turn!).
    const attachmentLinks = materialized.map((a) => `[附件: ${a.name}](file://${a.localPath})`);
    const attachmentNote = attachmentLinks.length > 0 ? `\n\n${attachmentLinks.join('\n')}` : '';
    const injectedUserText = `${cleanText}${attachmentNote}`;

    const systemDirective = this.buildSystemDirective({
      workspacePath,
      sessionMode,
      attachments: materialized,
    });
    if (metaStore) {
      metaStore.enqueueHookInjection(conversationId, {
        clientMessageId,
        text: injectedUserText,
        systemDirective,
      });
    }

    const payload = this.buildMobilePayload(cleanText, {
      clientMessageId,
      workspacePath,
      sessionMode,
      attachments: materialized,
    });
    const args = [
      'send-message',
      '--title=Antigravity',
      conversationId,
      payload,
    ];
    const { stdout, stderr } = await this.execFn(this.agentApiPath, args, {
      timeout: 12_000,
      maxBuffer: 1024 * 1024,
    });
    return {
      ok: true,
      conversationId,
      clientMessageId,
      attachments: materialized,
      rawOutput: (stdout || stderr || '').trim(),
    };
  }

  async switchConversationModel(conversationId, targetModelId) {
    const info = lookupModelInfo(targetModelId);
    if (!info) throw new Error('无效的模型标识');
    if (!this.isAvailable()) {
      throw new Error(`未找到可执行的官方 agentapi: ${this.agentApiPath}`);
    }
    const payload = `[AntigravityZ_MODEL_SWITCH model=${info.id}]\n用户请求将当前会话模型切换为 ${info.displayName} (${info.id})。\n请立即调用 \`swarm\` 工具 (\`{"action":"model","model":"${info.id}"}\`，不要传 \`name\`) 将本会话切换到 ${info.displayName}，切换完成后简短确认一句即可。`;
    const args = [
      'send-message',
      '--title=AntigravityZ · Model Switch',
      conversationId,
      payload,
    ];
    const { stdout, stderr } = await this.execFn(this.agentApiPath, args, {
      timeout: 12_000,
      maxBuffer: 1024 * 1024,
    });
    return {
      ok: true,
      conversationId,
      model: info.id,
      displayName: info.displayName,
      rawOutput: (stdout || stderr || '').trim(),
    };
  }

  #snapshotBrainIds() {
    const set = new Set();
    const dirs = this.brainDirsProvider ? this.brainDirsProvider() : [];
    for (const appData of dirs) {
      try {
        for (const name of readdirSync(join(appData, 'brain'))) {
          set.add(name);
        }
      } catch {
        // Ignore
      }
    }
    return set;
  }

  resolveDesktopProjectIdForWorkspace(workspacePath, desktopProjectId = null) {
    const directory = findWorkspaceDirectory(workspacePath);
    if (!directory) return 'outside-of-project';
    const matches = matchingDesktopProjects(this.desktopProjects.read(), directory.resolvedPath);
    return (matches.find((project) => project.id === desktopProjectId) || matches[0])?.id || 'outside-of-project';
  }

  async createConversation({
    prompt,
    title = '',
    model = '',
    mode = 'agent',
    workspacePath = '',
    desktopProjectId = null,
    createProjectName = '',
    attachments = [],
    metaStore = null,
  } = {}) {
    const stagedPreview = this.materializeAttachments(null, attachments, metaStore, { keepStagingCopy: true });
    const rawCleanPrompt = String(prompt || '').trim();
    const cleanPrompt = rawCleanPrompt || (stagedPreview.length > 0 ? `请查看附件：${stagedPreview.map((a) => a.name).join('、')}` : '');
    if (!cleanPrompt) throw new Error('新建会话的首条消息不能为空');
    let resolvedWorkspace = '';
    if (!createProjectName && workspacePath != null && workspacePath !== '') {
      resolvedWorkspace = resolveWorkspaceDirectory(workspacePath, { checkAccess: true }).resolvedPath;
      const dir = await openWorkspaceDirectory(resolvedWorkspace);
      await dir.close();
    }
    if (!this.isAvailable()) {
      throw new Error(`未找到可执行的官方 agentapi: ${this.agentApiPath}`);
    }

    if (createProjectName) {
      const path = await this.ensureProjectDirectory(createProjectName);
      resolvedWorkspace = resolveWorkspaceDirectory(path, { checkAccess: true }).resolvedPath;
    }

    const beforeIds = this.#snapshotBrainIds();
    const args = ['new-conversation'];
    if (model && model !== 'default' && model !== 'inherit') {
      args.push(`--model=${model}`);
    }
    const effectiveTitle = String(title || createProjectName || cleanPrompt.slice(0, 36)).trim();
    if (effectiveTitle) {
      args.push(`--title=${effectiveTitle}`);
    }

    let fullPrompt = cleanPrompt;
    const prefixNotes = [];
    if (resolvedWorkspace) {
      prefixNotes.push(`[Workspace: ${resolvedWorkspace}]`);
    }
    if (mode && MODE_DIRECTIVES[mode]) {
      prefixNotes.push(MODE_DIRECTIVES[mode]);
    }
    if (stagedPreview.length > 0) {
      const attLines = stagedPreview.map((a) => `- ${a.localPath} (${a.name}, ${a.mimeType})`);
      prefixNotes.push(`The user has uploaded ${stagedPreview.length} attachment(s) — inspect them directly with read_file:\n${attLines.join('\n')}`);
    }
    if (prefixNotes.length > 0) {
      fullPrompt = `${cleanPrompt}\n\n${prefixNotes.join('\n')}`;
    }

    args.push('--', fullPrompt);

    // Explicitly target Desktop's native `outside-of-project` (or a matching user Project ID)
    // and strip sidecar-origin metadata (`ANTIGRAVITY_SOURCE_METADATA`, etc.) so conversations
    // created from mobile are first-class user sessions that appear cleanly in Antigravity's
    // official Desktop & Web sidebars instead of being filtered out as sidecar-internal chats!
    const targetProjectId = this.resolveDesktopProjectIdForWorkspace(resolvedWorkspace, desktopProjectId);
    const cwd = resolvedWorkspace || homedir();
    const env = {
      ...process.env,
      ANTIGRAVITY_PROJECT_ID: targetProjectId,
    };
    delete env.ANTIGRAVITY_SOURCE_METADATA;
    delete env.ANTIGRAVITY_SIDECAR_UI_TOKEN;
    delete env.ANTIGRAVITY_SIDECAR_WEB_PORT;
    delete env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
    let result;
    try {
      result = await this.execFn(this.agentApiPath, args, {
        cwd,
        env,
        timeout: 15_000,
        maxBuffer: 2 * 1024 * 1024,
      });
    } catch (error) {
      if (resolvedWorkspace) resolveWorkspaceDirectory(resolvedWorkspace, { checkAccess: true });
      throw error;
    }

    const { stdout, stderr } = result;
    const combined = `${stdout || ''}\n${stderr || ''}`;
    let conversationId = null;

    try {
      const parsed = JSON.parse(stdout);
      conversationId =
        parsed?.conversationId ||
        parsed?.response?.conversationId ||
        parsed?.id ||
        null;
    } catch {
      // Fallback to UUID regex
    }
    if (!conversationId) {
      const m = UUID_FIND_RE.exec(combined);
      if (m) conversationId = m[1];
    }

    if (!conversationId && this.brainDirsProvider) {
      for (let attempt = 0; attempt < 10; attempt++) {
        await new Promise((r) => setTimeout(r, 200));
        const afterIds = this.#snapshotBrainIds();
        for (const id of afterIds) {
          if (!beforeIds.has(id)) {
            conversationId = id;
            break;
          }
        }
        if (conversationId) break;
      }
    }

    const clientMessageId = `ios-init-${Date.now()}`;
    let finalAttachments = [];
    if (conversationId && attachments.length > 0) {
      // Copy into `<convDir>/.user_uploaded/` so mobile UI can serve them cleanly too, while keeping staging path valid for in-flight first turn
      finalAttachments = this.materializeAttachments(conversationId, attachments, metaStore, { keepStagingCopy: true });
      if (metaStore) {
        metaStore.recordMessageAttachments(conversationId, clientMessageId, finalAttachments);
      }
    }
    if (resolvedWorkspace) metaStore?.rememberRecentWorkspace(resolvedWorkspace);

    return {
      ok: true,
      conversationId,
      title: effectiveTitle,
      workspacePath: resolvedWorkspace || null,
      clientMessageId,
      attachments: finalAttachments,
    };
  }
}
