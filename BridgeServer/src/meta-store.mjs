/**
 * MetaStore — Persists Bridge authentication secrets (mode 0600),
 * custom conversation titles, model/mode preferences, workspace associations,
 * APNs device subscriptions, and PreInvocation hook injection queues.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isValidApnsToken } from './apns-pusher.mjs';

export class MetaStore {
  constructor({ stateDir = null } = {}) {
    this.stateDir = stateDir || join(homedir(), '.gemini', 'antigravity', 'antigravityz');
    mkdirSync(this.stateDir, { recursive: true });
    this.authPath = join(this.stateDir, 'auth.json');
    this.metaPath = join(this.stateDir, 'conversations-meta.json');
    this.pushDevicesPath = join(this.stateDir, 'push-devices.json');
    this.lsEndpointPath = join(this.stateDir, 'ls-endpoint.json');
    this.uploadStagingDir = join(this.stateDir, 'uploads-staging');
    mkdirSync(this.uploadStagingDir, { recursive: true });

    this.pendingMessages = new Map();   // convId -> Array<{ clientMessageId, text, attachments, sentAt }>
    this.hookInjections = new Map();    // convId -> Array<{ clientMessageId, text, systemDirective, enqueuedAt }>
    this.stagedUploads = new Map();     // uploadId -> { uploadId, name, fileName, mimeType, kind, sizeBytes, stagedPath, createdAt }

    this.auth = this.#loadOrInitAuth();
    this.conversations = this.#loadJsonObject(this.metaPath);
    this.pushDevices = this.#loadJsonObject(this.pushDevicesPath);
    this.lsEndpoint = this.#loadJsonObject(this.lsEndpointPath);
  }

  #loadOrInitAuth() {
    try {
      if (existsSync(this.authPath)) {
        const parsed = JSON.parse(readFileSync(this.authPath, 'utf-8'));
        if (parsed?.token && parsed?.hookSecret) {
          return parsed;
        }
      }
    } catch {
      // Regenerate below
    }
    const fresh = {
      token: randomBytes(24).toString('base64url'),
      hookSecret: randomBytes(18).toString('hex'),
      createdAt: new Date().toISOString(),
    };
    this.#writeAtomic(this.authPath, JSON.stringify(fresh, null, 2), 0o600);
    return fresh;
  }

  #loadJsonObject(filePath) {
    try {
      if (existsSync(filePath)) {
        const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
        return parsed && typeof parsed === 'object' ? parsed : {};
      }
    } catch {
      // Ignore corrupt cache
    }
    return {};
  }

  #saveMeta() {
    this.#writeAtomic(this.metaPath, JSON.stringify(this.conversations, null, 2), 0o600);
  }

  #savePushDevices() {
    this.#writeAtomic(this.pushDevicesPath, JSON.stringify(this.pushDevices, null, 2), 0o600);
  }

  #writeAtomic(targetPath, content, mode = 0o600) {
    const tmp = `${targetPath}.tmp.${process.pid}`;
    writeFileSync(tmp, content, { encoding: 'utf-8', mode });
    try {
      chmodSync(tmp, mode);
    } catch {
      // Ignore on filesystems without chmod
    }
    renameSync(tmp, targetPath);
  }

  rotateToken() {
    this.auth = {
      ...this.auth,
      token: randomBytes(24).toString('base64url'),
      rotatedAt: new Date().toISOString(),
    };
    this.#writeAtomic(this.authPath, JSON.stringify(this.auth, null, 2), 0o600);
    return this.auth.token;
  }

  getToken() {
    return process.env.ANTIGRAVITYZ_TOKEN || this.auth.token;
  }

  getHookSecret() {
    return this.auth.hookSecret;
  }

  setLsEndpoint({ address, csrf } = {}) {
    const cleanAddr = String(address || '').trim();
    const cleanCsrf = String(csrf || '').trim();
    if (!cleanAddr || !cleanCsrf) return;
    if (this.lsEndpoint?.address === cleanAddr && this.lsEndpoint?.csrf === cleanCsrf) return;
    this.lsEndpoint = {
      address: cleanAddr,
      csrf: cleanCsrf,
      updatedAt: new Date().toISOString(),
    };
    this.#writeAtomic(this.lsEndpointPath, JSON.stringify(this.lsEndpoint, null, 2), 0o600);
  }

  getLsEndpoint() {
    if (this.lsEndpoint?.address && this.lsEndpoint?.csrf) {
      return this.lsEndpoint;
    }
    return null;
  }

  getConversationMeta(convId) {
    return this.conversations[convId] || null;
  }

  getConversationViewedMs(convId) {
    const val = this.conversations[convId]?.iosViewedMs;
    return typeof val === 'number' && Number.isFinite(val) ? val : 0;
  }

  markConversationViewed(convId, viewedMs = Date.now()) {
    if (!convId) return 0;
    const prev = this.conversations[convId] || {};
    const prevMs = typeof prev.iosViewedMs === 'number' ? prev.iosViewedMs : 0;
    const nextMs = Math.max(prevMs, Math.floor(Number(viewedMs) || Date.now()));
    if (nextMs === prevMs) return prevMs;
    this.conversations[convId] = {
      ...prev,
      iosViewedMs: nextMs,
      updatedAt: new Date(nextMs).toISOString(),
    };
    this.#saveMeta();
    return nextMs;
  }

  isConversationFlagged(convId) {
    return Boolean(this.conversations[convId]?.flagged);
  }

  setConversationFlagged(convId, flagged) {
    if (!convId) return null;
    const prev = this.conversations[convId] || {};
    const nextFlagged = Boolean(flagged);
    const nowMs = Date.now();
    this.conversations[convId] = {
      ...prev,
      flagged: nextFlagged,
      flaggedUpdatedAtMs: nowMs,
      updatedAt: new Date(nowMs).toISOString(),
    };
    this.#saveMeta();
    return this.conversations[convId];
  }

  setConversationTitle(convId, title) {
    const clean = String(title || '').trim().slice(0, 80);
    if (!clean) return null;
    const nowMs = Date.now();
    this.conversations[convId] = {
      ...(this.conversations[convId] || {}),
      title: clean,
      renamedOnMobile: true,
      titleUpdatedAtMs: nowMs,
      updatedAt: new Date(nowMs).toISOString(),
    };
    this.#saveMeta();
    return this.conversations[convId];
  }

  setConversationSettings(convId, { model, mode } = {}) {
    if (!convId) return null;
    const prev = this.conversations[convId] || {};
    const next = {
      ...prev,
      updatedAt: new Date().toISOString(),
    };
    if (typeof model === 'string') {
      const cleanModel = model.trim();
      if (!cleanModel || cleanModel === 'inherit' || cleanModel === 'default') {
        delete next.desiredModel;
      } else {
        next.desiredModel = cleanModel;
        next.modelUpdatedAtMs = Date.now();
      }
    }
    if (typeof mode === 'string' && ['agent', 'plan', 'boost', 'goal'].includes(mode)) {
      next.sessionMode = mode;
    }
    this.conversations[convId] = next;
    this.#saveMeta();
    return next;
  }

  rememberWorkspace(convId, workspacePath) {
    if (!convId || !workspacePath) return;
    const prev = this.conversations[convId] || {};
    if (prev.workspacePath === workspacePath) return;
    this.conversations[convId] = {
      ...prev,
      workspacePath,
      updatedAt: new Date().toISOString(),
    };
    this.#saveMeta();
  }

  registerCreatedConversation(convId, { title, workspacePath, model, mode } = {}) {
    const nowMs = Date.now();
    this.conversations[convId] = {
      ...(this.conversations[convId] || {}),
      ...(title ? { title: String(title).trim().slice(0, 80), titleUpdatedAtMs: nowMs } : {}),
      ...(workspacePath ? { workspacePath } : {}),
      ...(model && model !== 'inherit' && model !== 'default' ? { desiredModel: model, modelUpdatedAtMs: nowMs } : {}),
      ...(mode && ['agent', 'plan', 'boost', 'goal'].includes(mode) ? { sessionMode: mode } : {}),
      createdVia: 'ios',
      createdAt: new Date(nowMs).toISOString(),
      updatedAt: new Date(nowMs).toISOString(),
    };
    this.#saveMeta();
  }

  // ---- APNs Device Subscriptions ----

  registerPushDevice({ token, environment = 'production', deviceId = '', environmentConfirmed = false }) {
    const cleanToken = String(token || '').trim().toLowerCase();
    if (!isValidApnsToken(cleanToken)) {
      throw new Error('Invalid APNs device token');
    }
    const env = environment === 'sandbox' ? 'sandbox' : 'production';
    this.pushDevices[cleanToken] = {
      token: cleanToken,
      environment: env,
      environmentConfirmed: Boolean(environmentConfirmed),
      deviceId: String(deviceId || '').slice(0, 120),
      updatedAt: new Date().toISOString(),
    };
    this.#savePushDevices();
    return this.pushDevices[cleanToken];
  }

  removePushDevice(tokenOrFilter) {
    let token = '';
    let deviceId = '';
    if (typeof tokenOrFilter === 'string') {
      token = tokenOrFilter.trim().toLowerCase();
    } else if (tokenOrFilter && typeof tokenOrFilter === 'object') {
      token = String(tokenOrFilter.token || '').trim().toLowerCase();
      deviceId = String(tokenOrFilter.deviceId || '').trim();
    }
    let changed = false;
    if (token && this.pushDevices[token]) {
      delete this.pushDevices[token];
      changed = true;
    }
    if (deviceId) {
      for (const [key, entry] of Object.entries(this.pushDevices)) {
        if (entry?.deviceId === deviceId) {
          delete this.pushDevices[key];
          changed = true;
        }
      }
    }
    if (changed) {
      this.#savePushDevices();
    }
    return changed;
  }

  listPushDevices() {
    return Object.values(this.pushDevices);
  }

  // ---- Staged Uploads & Conversation Attachments ----

  registerStagedUpload(meta) {
    if (!meta?.uploadId) return null;
    const now = Date.now();
    for (const [k, v] of this.stagedUploads.entries()) {
      if (now - (v.createdAt || 0) > 3600_000) {
        this.stagedUploads.delete(k);
      }
    }
    const entry = { ...meta, createdAt: now };
    this.stagedUploads.set(meta.uploadId, entry);
    return entry;
  }

  getStagedUpload(uploadId) {
    return this.stagedUploads.get(uploadId) || null;
  }

  consumeStagedUpload(uploadId) {
    const entry = this.stagedUploads.get(uploadId) || null;
    if (entry) this.stagedUploads.delete(uploadId);
    return entry;
  }

  recordMessageAttachments(convId, clientMessageId, attachments) {
    if (!convId || !Array.isArray(attachments) || attachments.length === 0) return;
    const prev = this.conversations[convId] || {};
    const byMsg = { ...(prev.attachmentsByMsgId || {}) };
    const key = clientMessageId || `att-${Date.now()}`;
    byMsg[key] = attachments.map((a) => ({
      id: a.id || a.uploadId || a.fileName,
      name: a.name,
      fileName: a.fileName,
      kind: a.kind || 'file',
      mimeType: a.mimeType || 'application/octet-stream',
      sizeBytes: Number(a.sizeBytes || 0),
    }));
    this.conversations[convId] = {
      ...prev,
      attachmentsByMsgId: byMsg,
      updatedAt: new Date().toISOString(),
    };
    this.#saveMeta();
  }

  getMessageAttachmentsMap(convId) {
    return this.conversations[convId]?.attachmentsByMsgId || {};
  }

  // ---- Optimistic Mobile Messages & PreInvocation Hook Queue ----

  addPendingMessage(convId, { clientMessageId, text, attachments = [] }) {
    const list = this.pendingMessages.get(convId) || [];
    const now = Date.now();
    const filtered = list.filter((m) => now - m.sentAt < 180_000 && m.clientMessageId !== clientMessageId);
    filtered.push({ clientMessageId, text, attachments, sentAt: now });
    this.pendingMessages.set(convId, filtered);
  }

  getPendingMessages(convId) {
    const list = this.pendingMessages.get(convId) || [];
    const now = Date.now();
    return list.filter((m) => now - m.sentAt < 180_000);
  }

  clearPendingMessage(convId, clientMessageId) {
    const list = this.pendingMessages.get(convId);
    if (!list) return;
    this.pendingMessages.set(
      convId,
      list.filter((m) => m.clientMessageId !== clientMessageId)
    );
  }

  enqueueHookInjection(convId, { clientMessageId, text, systemDirective = '', userMarkdown = '' }) {
    if (!convId) return;
    const now = Date.now();
    const existing = (this.hookInjections.get(convId) || []).filter((item) => now - item.enqueuedAt < 60_000);
    existing.push({
      clientMessageId,
      text: String(text || '').trim(),
      systemDirective: String(systemDirective || '').trim(),
      userMarkdown: String(userMarkdown || '').trim(),
      enqueuedAt: now,
    });
    this.hookInjections.set(convId, existing);
  }

  dequeueHookInjections(convId) {
    if (!convId || !this.hookInjections.has(convId)) return [];
    const now = Date.now();
    const items = (this.hookInjections.get(convId) || []).filter((item) => now - item.enqueuedAt < 60_000);
    this.hookInjections.delete(convId);
    return items;
  }
}
