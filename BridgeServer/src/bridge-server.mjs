/**
 * BridgeServer — Zero-dependency HTTP REST + Native RFC-6455 WebSocket Server
 * with monotonic `seq` ring-buffer replay, native Apple APNs push notifications,
 * PreInvocation `userMessage` hook injection, and interactive approval/question bridging.
 */
import { execFile } from 'node:child_process';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { networkInterfaces, hostname as osHostname, tmpdir } from 'node:os';
import { basename, extname, join, sep } from 'node:path';
import { URL } from 'node:url';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { ApnsPusher } from './apns-pusher.mjs';
import { MODEL_FAMILIES } from './model-catalog.mjs';
import { generateQrSvg } from './qr-svg.mjs';
import { QuotaMonitor } from './quota-monitor.mjs';

const execFileAsync = promisify(execFile);
const THUMB_CACHE_DIR = join(tmpdir(), 'antigravityz-thumbs');
const THUMB_SUPPORTED_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.heic']);
const inflightThumbs = new Map();

async function ensureCachedThumbnail(sourcePath, st) {
  const ext = extname(sourcePath).toLowerCase();
  if (!THUMB_SUPPORTED_EXTS.has(ext) || st.size < 90 * 1024) {
    return null;
  }
  const keyHash = createHash('sha1')
    .update(`${sourcePath}|${st.mtimeMs}|${st.size}`)
    .digest('hex')
    .slice(0, 20);
  const thumbPath = join(THUMB_CACHE_DIR, `${keyHash}.jpg`);
  if (existsSync(thumbPath)) {
    return thumbPath;
  }
  if (inflightThumbs.has(thumbPath)) {
    return inflightThumbs.get(thumbPath);
  }
  const job = (async () => {
    try {
      mkdirSync(THUMB_CACHE_DIR, { recursive: true });
      await execFileAsync(
        'sips',
        ['-Z', '720', '-s', 'format', 'jpeg', '-s', 'formatOptions', '80', sourcePath, '--out', thumbPath],
        { timeout: 8000 }
      );
      return existsSync(thumbPath) ? thumbPath : null;
    } catch {
      return null;
    } finally {
      inflightThumbs.delete(thumbPath);
    }
  })();
  inflightThumbs.set(thumbPath, job);
  return job;
}

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const RING_BUFFER_LIMIT = 500;

const MIME_BY_EXT = {
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

function classifyUploadKind(mimeType = '', fileName = '') {
  const m = String(mimeType || '').toLowerCase();
  const n = String(fileName || '').toLowerCase();
  if (m.startsWith('image/') || /\.(png|jpe?g|gif|webp|heic|svg)$/.test(n)) return 'image';
  if (m.startsWith('video/') || /\.(mp4|mov|m4v|webm)$/.test(n)) return 'video';
  if (m.startsWith('audio/') || /\.(m4a|mp3|wav|aac|ogg)$/.test(n)) return 'audio';
  return 'file';
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ''), 'utf-8');
  const bufB = Buffer.from(String(b || ''), 'utf-8');
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return timingSafeEqual(bufA, bufB);
}

function encodeWsFrame(opcode, payloadBuffer) {
  const len = payloadBuffer.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payloadBuffer]);
}

function encodeWsText(obj) {
  const data = Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf-8');
  return encodeWsFrame(0x01, data);
}

function fingerprintSummary(conv) {
  const subFp = (conv.subagents || [])
    .map((s) => `${s.id}:${s.stepCount}:${s.runState}`)
    .join(',');
  const interactFp = conv.pendingInteraction
    ? `${conv.pendingInteraction.kind}:${conv.pendingInteraction.id}`
    : '';
  return [
    conv.stepCount,
    conv.messageCount,
    conv.artifactCount,
    conv.runState,
    conv.activityDetail,
    conv.title,
    conv.pinned ? '1' : '0',
    conv.hasUnread ? '1' : '0',
    conv.currentModelId || '',
    conv.sessionMode || 'agent',
    conv.workspacePath || '',
    conv.lastPreview || '',
    conv.updatedMs || 0,
    interactFp,
    subFp,
  ].join('|');
}

export function discoverNetworkAddresses(port) {
  const ifaces = networkInterfaces();
  let tailscaleIp = null;
  let lanIp = null;
  const all = [];

  for (const [name, list] of Object.entries(ifaces)) {
    for (const info of list || []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      all.push({ interface: name, address: info.address });
      if (info.address.startsWith('100.')) {
        tailscaleIp = info.address;
      } else if (
        !lanIp &&
        (info.address.startsWith('192.168.') ||
          info.address.startsWith('10.') ||
          /^172\.(1[6-9]|2\d|3[0-1])\./.test(info.address))
      ) {
        lanIp = info.address;
      }
    }
  }

  const preferredHost = process.env.ANTIGRAVITYZ_PUBLIC_HOST || tailscaleIp || lanIp || '127.0.0.1';
  const primaryUrl = `http://${preferredHost}:${port}`;
  return {
    hostname: osHostname(),
    port,
    tailscaleIp,
    lanIp,
    preferredHost,
    primaryUrl,
    interfaces: all,
  };
}

export class BridgeServer {
  constructor({
    port = Number(process.env.ANTIGRAVITYZ_PORT || 19818),
    host = process.env.ANTIGRAVITYZ_BIND || '0.0.0.0',
    metaStore,
    brainScanner,
    agentController,
    apnsPusher = null,
    quotaMonitor = null,
    pollIntervalMs = 750,
  }) {
    this.port = port;
    this.host = host;
    this.metaStore = metaStore;
    this.brainScanner = brainScanner;
    this.agentController = agentController;
    if (this.agentController && !this.agentController.brainDirsProvider && this.brainScanner) {
      this.agentController.brainDirsProvider = () => this.brainScanner.discoverAppDataDirs();
    }
    this.apnsPusher = apnsPusher || new ApnsPusher({ metaStore });
    this.quotaMonitor = quotaMonitor || new QuotaMonitor({ metaStore });
    this.pollIntervalMs = pollIntervalMs;

    this.seq = 0;
    this.ringBuffer = [];
    this.wsClients = new Set();
    this.convFingerprints = new Map();
    this.lastQuotaFingerprint = '';
    this.lastUnreadCount = 0;
    this.notifiedInteractions = new Set();
    this.httpServer = null;
    this.pollTimer = null;
    this.pingTimer = null;
  }

  getPairingInfo() {
    const actualPort = this.getBoundPort();
    const net = discoverNetworkAddresses(actualPort);
    const token = this.metaStore.getToken();
    const pairingUri = `levity://pair?url=${encodeURIComponent(net.primaryUrl)}&token=${encodeURIComponent(token)}&name=${encodeURIComponent(net.hostname)}`;
    return {
      ...net,
      token,
      pairingUri,
      qrSvg: generateQrSvg(pairingUri, { margin: 2, fg: '#F8FAFC', bg: '#0B1020' }),
      connectedClients: this.wsClients.size,
      agentApiReady: this.agentController.isAvailable(),
      apnsConfigured: this.apnsPusher.isConfigured(),
      currentSeq: this.seq,
    };
  }

  getPublicStatus() {
    const actualPort = this.getBoundPort();
    const net = discoverNetworkAddresses(actualPort);
    return {
      ok: true,
      service: 'AntigravityZ Bridge',
      version: '0.1.0',
      hostname: net.hostname,
      tailscaleIp: net.tailscaleIp,
      lanIp: net.lanIp,
      port: actualPort,
      connectedClients: this.wsClients.size,
      agentApiReady: this.agentController.isAvailable(),
      apnsConfigured: this.apnsPusher.isConfigured(),
      projectsRoot: this.brainScanner?.projectsRoot || null,
      currentSeq: this.seq,
    };
  }

  getBoundPort() {
    const addr = this.httpServer?.address();
    return typeof addr === 'object' && addr ? addr.port : this.port;
  }

  emitEvent(type, payload = {}) {
    this.seq += 1;
    const envelope = {
      seq: this.seq,
      type,
      timestamp: new Date().toISOString(),
      ...payload,
    };
    this.ringBuffer.push(envelope);
    if (this.ringBuffer.length > RING_BUFFER_LIMIT) {
      this.ringBuffer.shift();
    }
    const frame = encodeWsText(envelope);
    for (const client of this.wsClients) {
      try {
        client.socket.write(frame);
      } catch {
        this.wsClients.delete(client);
      }
    }
    return envelope;
  }

  async #dispatchAlert({ conversationId, title, subtitle = '', body, kind, eventKey }) {
    this.emitEvent('notification_event', {
      conversationId,
      notificationTitle: title,
      notificationSubtitle: subtitle,
      notificationBody: body,
      notificationKind: kind,
    });
    const badgeCount = Math.max(1, this.lastUnreadCount || 0);
    await this.apnsPusher.notifyConversation({
      conversationId,
      title,
      subtitle,
      body,
      kind,
      eventKey,
      badge: badgeCount,
    });
  }

  async pollChanges() {
    try {
      const scan = await this.brainScanner.scanAll({ includeMetadata: false });
      this.lastUnreadCount = typeof scan.unreadCount === 'number' ? scan.unreadCount : 0;
      let listChanged = false;

      for (const ws of scan.workspaces) {
        for (const conv of ws.conversations) {
          const fp = fingerprintSummary(conv);
          const prevFp = this.convFingerprints.get(conv.id);
          const isInitialBoot = this.seq === 0 && prevFp === undefined;

          if (prevFp === undefined) {
            this.convFingerprints.set(conv.id, fp);
            if (!isInitialBoot) {
              listChanged = true;
              const detail = await this.brainScanner.getConversationDetail(conv.id);
              this.emitEvent('conversation_updated', {
                conversationId: conv.id,
                summary: conv,
                detail: detail ? this.#stripPrivateDetail(detail) : null,
              });
            }
          } else if (prevFp !== fp) {
            this.convFingerprints.set(conv.id, fp);
            listChanged = true;
            const detail = await this.brainScanner.getConversationDetail(conv.id);
            this.emitEvent('conversation_updated', {
              conversationId: conv.id,
              summary: conv,
              detail: detail ? this.#stripPrivateDetail(detail) : null,
            });
          }

          // Alert once when a conversation enters permission_waiting or ask_question
          if (!isInitialBoot && conv.pendingInteraction) {
            const key = `${conv.id}:${conv.pendingInteraction.kind}:${conv.pendingInteraction.id}`;
            if (!this.notifiedInteractions.has(key)) {
              this.notifiedInteractions.add(key);
              const subParts = [];
              if (conv.title && conv.title !== 'Antigravity') subParts.push(conv.title);
              if (conv.pendingInteraction.title) subParts.push(conv.pendingInteraction.title);
              void this.#dispatchAlert({
                conversationId: conv.id,
                title: 'Antigravity',
                subtitle: subParts.join(' · '),
                body: conv.pendingInteraction.prompt,
                kind: 'action_required',
                eventKey: key,
              });
            }
          }
        }
      }

      if (listChanged) {
        this.emitEvent('workspaces_updated', {
          workspaces: scan.workspaces,
        });
      }

      const quota = await this.quotaMonitor.getSnapshot();
      if (quota) {
        const qFp = JSON.stringify({
          t: quota.tierName,
          p: quota.pools?.map(
            (x) => `${x.id}:${x.remainingFraction}:${x.resetTime}:${x.weeklyFraction}:${x.weeklyResetTime}`
          ),
        });
        if (this.lastQuotaFingerprint && this.lastQuotaFingerprint !== qFp) {
          this.emitEvent('quota_updated', { quota });
        }
        this.lastQuotaFingerprint = qFp;
      }
    } catch (err) {
      console.error('[AntigravityZ] pollChanges error:', err?.message || err);
    }
  }

  #stripPrivateDetail(detail, { limit = 30 } = {}) {
    const { convDir, detectedModelId, items = [], ...rest } = detail;
    const totalItemCount = items.length;
    const sliced = limit && limit > 0 && totalItemCount > limit ? items.slice(-limit) : items;
    const len = sliced.length;
    const compactItems = sliced.map((it, idx) => {
      const isRecent = idx >= len - 6;
      const maxThinking = isRecent ? 2400 : 800;
      const maxToolOut = isRecent ? 900 : 450;
      let changed = false;
      let thinking = it.thinking;
      if (typeof thinking === 'string' && thinking.length > maxThinking) {
        thinking = `${thinking.slice(0, maxThinking)}\n…`;
        changed = true;
      }
      let toolCalls = it.toolCalls;
      if (Array.isArray(toolCalls) && toolCalls.length > 0) {
        for (const tc of toolCalls) {
          if (typeof tc.outputPreview === 'string' && tc.outputPreview.length > maxToolOut) {
            changed = true;
            break;
          }
        }
        if (changed) {
          toolCalls = toolCalls.map((tc) =>
            typeof tc.outputPreview === 'string' && tc.outputPreview.length > maxToolOut
              ? { ...tc, outputPreview: `${tc.outputPreview.slice(0, maxToolOut)}\n…` }
              : tc
          );
        }
      }
      return changed ? { ...it, thinking, toolCalls } : it;
    });
    return {
      ...rest,
      totalItemCount,
      hasMoreHistory: totalItemCount > compactItems.length,
      items: compactItems,
    };
  }

  #checkAuth(req, parsedUrl) {
    const expected = this.metaStore.getToken();
    const authHeader = req.headers.authorization || '';
    if (authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7).trim();
      if (safeEqual(token, expected)) return true;
    }
    const qToken = parsedUrl.searchParams.get('token');
    if (qToken && safeEqual(qToken, expected)) return true;
    return false;
  }

  #sendJson(res, status, data, req = null) {
    const rawBuf = Buffer.from(JSON.stringify(data), 'utf-8');
    const acceptEnc = String(req?.headers?.['accept-encoding'] || '').toLowerCase();
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    };
    if (acceptEnc.includes('gzip') && rawBuf.length > 1024) {
      const zipped = gzipSync(rawBuf, { level: 6 });
      headers['Content-Encoding'] = 'gzip';
      headers['Vary'] = 'Accept-Encoding';
      headers['Content-Length'] = String(zipped.length);
      res.writeHead(status, headers);
      res.end(zipped);
      return;
    }
    headers['Content-Length'] = String(rawBuf.length);
    res.writeHead(status, headers);
    res.end(rawBuf);
  }

  async #readJsonBody(req, maxBytes = 512 * 1024) {
    const buf = await this.#readRawBody(req, maxBytes);
    if (buf.length === 0) return {};
    return JSON.parse(buf.toString('utf-8'));
  }

  async #readRawBody(req, maxBytes = 64 * 1024 * 1024) {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > maxBytes) throw new Error('Payload too large');
      chunks.push(chunk);
    }
    return total === 0 ? Buffer.alloc(0) : Buffer.concat(chunks);
  }

  async #handleHttp(req, res) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      });
      res.end();
      return;
    }

    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    try {
      if (req.method === 'GET' && pathname === '/api/v1/health') {
        this.#sendJson(res, 200, this.getPublicStatus());
        return;
      }

      // Loopback-only internal hook receiver from Antigravity hooks.json
      if (req.method === 'POST' && pathname === '/internal/hook') {
        const remoteIp = req.socket.remoteAddress || '';
        const isLoopback =
          remoteIp === '127.0.0.1' ||
          remoteIp === '::1' ||
          remoteIp === '::ffff:127.0.0.1';
        const secret = req.headers['x-antigravityz-hook-secret'] || '';
        if (!isLoopback || !safeEqual(secret, this.metaStore.getHookSecret())) {
          this.#sendJson(res, 403, { error: 'Forbidden' });
          return;
        }
        const payload = await this.#readJsonBody(req);
        if (payload?._lsEndpoint && this.metaStore?.setLsEndpoint) {
          this.metaStore.setLsEndpoint(payload._lsEndpoint);
        }
        const hookName = String(payload?.hookEventName || '');
        const convId = payload?.conversationId || '';
        const hookState = this.brainScanner.recordHookEvent(payload);

        let hookResponse = {};
        if (hookName === 'PreToolUse') {
          hookResponse = { decision: 'allow' };
        } else if (hookName === 'PreInvocation' && convId && this.metaStore) {
          const queued = this.metaStore.dequeueHookInjections(convId);
          if (queued.length > 0) {
            const injectSteps = [];
            for (const q of queued) {
              if (q.text) {
                injectSteps.push({
                  userMessage: q.text,
                });
              }
              if (q.systemDirective) {
                injectSteps.push({
                  systemMessage: {
                    systemMessage: q.systemDirective,
                  },
                });
              }
            }
            if (injectSteps.length > 0) {
              hookResponse = { injectSteps };
            }
          }
        }

        if (hookState) {
          this.emitEvent('live_activity', hookState);
          setImmediate(async () => {
            if (hookName === 'Stop' || hookName === 'PostInvocation') {
              await this.quotaMonitor.getSnapshot({ force: true });
            }
            await this.pollChanges();
            if (
              hookName === 'Stop' &&
              convId &&
              !payload?.continuationActive &&
              payload?.terminationReason !== 'USER_CANCELED'
            ) {
              const detail = await this.brainScanner.getConversationDetail(convId);
              if (detail && !detail.isSubagent && !detail.pendingInteraction) {
                const lastAssistant = [...detail.items].reverse().find((it) => it.role === 'assistant' && it.content);
                const bodyText = lastAssistant?.content
                  ? lastAssistant.content.replace(/[#*`>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 140)
                  : (payload?.terminationReason === 'ERROR' ? '会话执行过程中遇到错误' : '本轮任务已完成');
                const kind = payload?.terminationReason === 'ERROR' ? 'error' : 'completed';
                const subParts = [];
                if (detail.title && detail.title !== 'Antigravity') subParts.push(detail.title);
                if (kind === 'error') subParts.push('执行异常');
                await this.#dispatchAlert({
                  conversationId: convId,
                  title: 'Antigravity',
                  subtitle: subParts.join(' · '),
                  body: bodyText,
                  kind,
                  eventKey: `stop:${convId}:${detail.items.length}:${lastAssistant?.stepIndex ?? 0}`,
                });
              }
            }
          });
        }

        this.#sendJson(res, 200, { ok: true, hookResponse });
        return;
      }

      if (req.method === 'GET' && pathname === '/local-pair') {
        const remoteIp = req.socket.remoteAddress || '';
        const isLoopback =
          remoteIp === '127.0.0.1' ||
          remoteIp === '::1' ||
          remoteIp === '::ffff:127.0.0.1';
        if (!isLoopback) {
          this.#sendJson(res, 403, { error: 'Loopback only' });
          return;
        }
        this.#sendJson(res, 200, this.getPairingInfo());
        return;
      }

      if (!this.#checkAuth(req, parsedUrl)) {
        this.#sendJson(res, 401, { error: 'Unauthorized: 配对令牌无效或已过期' });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/v1/bootstrap') {
        const scan = await this.brainScanner.scanAll({ includeMetadata: true });
        for (const ws of scan.workspaces) {
          for (const conv of ws.conversations) {
            if (!this.convFingerprints.has(conv.id)) {
              this.convFingerprints.set(conv.id, fingerprintSummary(conv));
            }
            if (conv.pendingInteraction) {
              this.notifiedInteractions.add(
                `${conv.id}:${conv.pendingInteraction.kind}:${conv.pendingInteraction.id}`
              );
            }
          }
        }
        const quota = await this.quotaMonitor.getSnapshot();
        this.#sendJson(res, 200, {
          server: this.getPublicStatus(),
          workspaces: scan.workspaces,
          knownProjects: scan.knownProjects,
          modelFamilies: MODEL_FAMILIES,
          quota,
          currentSeq: this.seq,
        }, req);
        return;
      }

      // APNs Device Push Token Registration
      if (req.method === 'POST' && pathname === '/api/v1/devices/push-token') {
        const body = await this.#readJsonBody(req);
        const entry = this.metaStore.registerPushDevice({
          token: body.token,
          environment: body.environment || 'production',
          deviceId: body.deviceId || '',
        });
        this.#sendJson(res, 200, {
          ok: true,
          apnsConfigured: this.apnsPusher.isConfigured(),
          environment: entry.environment,
        });
        return;
      }

      if (req.method === 'DELETE' && pathname === '/api/v1/devices/push-token') {
        const body = await this.#readJsonBody(req);
        this.metaStore.removePushDevice({
          token: body.token,
          deviceId: body.deviceId,
        });
        this.#sendJson(res, 200, { ok: true });
        return;
      }

      // Foreground Presence Heartbeat
      if (req.method === 'POST' && pathname === '/api/v1/devices/presence') {
        const body = await this.#readJsonBody(req);
        const isActive = Boolean(body.active);
        const visibleConvId = body.visibleConversationId || null;
        this.apnsPusher.updatePresence({
          deviceId: body.deviceId,
          active: isActive,
          visibleConversationId: visibleConvId,
        });
        if (isActive && visibleConvId && this.metaStore?.markConversationViewed) {
          this.metaStore.markConversationViewed(String(visibleConvId), Date.now());
        }
        this.#sendJson(res, 200, { ok: true });
        return;
      }

      // Manual Test Push Trigger
      if (req.method === 'POST' && pathname === '/api/v1/devices/test-push') {
        const result = await this.apnsPusher.notifyConversation({
          conversationId: '',
          title: 'Antigravity',
          body: '官方 APNs 原生推送已连通，锁屏与后台均可实时接收会话通知。',
          kind: 'test',
          force: true,
        });
        this.#sendJson(res, 200, result);
        return;
      }

      // Binary Attachment Upload: POST /api/v1/uploads
      if (req.method === 'POST' && pathname === '/api/v1/uploads') {
        const rawBytes = await this.#readRawBody(req, 64 * 1024 * 1024);
        if (rawBytes.length === 0) {
          this.#sendJson(res, 400, { error: '附件内容为空' });
          return;
        }
        const rawHeaderName = String(req.headers['x-file-name'] || parsedUrl.searchParams.get('name') || 'upload.bin');
        let decodedName = rawHeaderName;
        try {
          decodedName = decodeURIComponent(rawHeaderName);
        } catch {
          // Keep raw
        }
        const originalName = basename(decodedName).slice(0, 120) || 'upload.bin';
        const ext = extname(originalName).toLowerCase() || '';
        const mimeHeader = String(req.headers['x-mime-type'] || req.headers['content-type'] || '').split(';')[0].trim();
        const mimeType = mimeHeader || MIME_BY_EXT[ext] || 'application/octet-stream';
        const kind = classifyUploadKind(mimeType, originalName);
        const convHint = String(req.headers['x-conversation-id'] || parsedUrl.searchParams.get('conversationId') || '').trim();

        const uploadId = `upl_${Date.now()}_${randomUUID().slice(0, 8)}`;
        const safeStem = originalName
          .slice(0, originalName.length - ext.length)
          .replace(/[^A-Za-z0-9._-]+/g, '_')
          .replace(/^_+|_+$/g, '')
          .slice(0, 40) || 'media';
        const storedFileName = `${safeStem}_${randomUUID().slice(0, 8)}${ext || '.bin'}`;

        let destDir = this.metaStore.uploadStagingDir;
        if (convHint && /^[0-9a-zA-Z_-]{6,64}$/.test(convHint)) {
          destDir = this.agentController.resolveConversationUploadDir(convHint);
        }
        mkdirSync(destDir, { recursive: true });
        const stagedPath = join(destDir, storedFileName);
        writeFileSync(stagedPath, rawBytes);

        const record = this.metaStore.registerStagedUpload({
          uploadId,
          name: originalName,
          fileName: storedFileName,
          kind,
          mimeType,
          sizeBytes: rawBytes.length,
          stagedPath,
        });
        this.#sendJson(res, 201, {
          ok: true,
          uploadId: record.uploadId,
          name: record.name,
          fileName: record.fileName,
          kind: record.kind,
          mimeType: record.mimeType,
          sizeBytes: record.sizeBytes,
        });
        return;
      }

      // Create new conversation
      if (req.method === 'POST' && pathname === '/api/v1/conversations') {
        const body = await this.#readJsonBody(req);
        const result = await this.agentController.createConversation({
          prompt: body.prompt,
          title: body.title || '',
          model: body.model || '',
          mode: body.mode || 'agent',
          workspacePath: body.workspacePath || '',
          createProjectName: body.createProjectName || '',
          attachments: Array.isArray(body.attachments) ? body.attachments : [],
          metaStore: this.metaStore,
        });
        if (result.conversationId) {
          this.metaStore.registerCreatedConversation(result.conversationId, {
            title: result.title,
            workspacePath: result.workspacePath,
            model: body.model || '',
            mode: body.mode || 'agent',
          });
          this.metaStore.markConversationViewed(result.conversationId, Date.now());
          this.metaStore.addPendingMessage(result.conversationId, {
            clientMessageId: result.clientMessageId,
            text: String(body.prompt || '').trim() || (result.attachments?.length ? `请查看附件：${result.attachments.map((a) => a.name).join('、')}` : ''),
            attachments: result.attachments || [],
          });
        }
        await this.pollChanges();
        const detail = result.conversationId
          ? await this.brainScanner.getConversationDetail(result.conversationId)
          : null;
        this.#sendJson(res, 201, {
          ...result,
          detail: detail ? this.#stripPrivateDetail(detail) : null,
        });
        return;
      }

      // Conversation detail: GET /api/v1/conversations/:id?limit=30
      const convDetailMatch = /^\/api\/v1\/conversations\/([0-9a-zA-Z_-]{6,64})$/.exec(pathname);
      if (req.method === 'GET' && convDetailMatch) {
        const convId = convDetailMatch[1];
        const rawLimit = parsedUrl.searchParams.get('limit');
        let limit = 30;
        if (rawLimit === 'all' || rawLimit === '0') {
          limit = 0;
        } else if (rawLimit !== null) {
          const parsedLimit = Number(rawLimit);
          if (Number.isFinite(parsedLimit) && parsedLimit > 0) {
            limit = Math.min(500, Math.floor(parsedLimit));
          }
        }
        const detail = await this.brainScanner.getConversationDetail(convId);
        if (!detail) {
          this.#sendJson(res, 404, { error: '未找到该会话' }, req);
          return;
        }
        const quota = await this.quotaMonitor.getSnapshot();
        this.#sendJson(res, 200, {
          detail: this.#stripPrivateDetail(detail, { limit }),
          quota,
          currentSeq: this.seq,
        }, req);
        return;
      }

      // Mark conversation viewed/read on mobile: POST /api/v1/conversations/:id/read
      const markReadMatch = /^\/api\/v1\/conversations\/([0-9a-zA-Z_-]{6,64})\/read$/.exec(pathname);
      if (req.method === 'POST' && markReadMatch) {
        const convId = markReadMatch[1];
        const viewedMs = this.metaStore.markConversationViewed(convId, Date.now());
        await this.pollChanges();
        this.#sendJson(res, 200, {
          ok: true,
          conversationId: convId,
          viewedMs,
          unreadCount: this.lastUnreadCount,
        }, req);
        return;
      }

      // Send message to existing conversation: POST /api/v1/conversations/:id/messages
      const sendMsgMatch = /^\/api\/v1\/conversations\/([0-9a-zA-Z_-]{6,64})\/messages$/.exec(pathname);
      if (req.method === 'POST' && sendMsgMatch) {
        const convId = sendMsgMatch[1];
        this.metaStore.markConversationViewed(convId, Date.now());
        const body = await this.#readJsonBody(req);
        const text = String(body.text || body.prompt || '').trim();
        const clientMessageId = String(body.clientMessageId || `ios-${randomUUID()}`);

        const beforeDetail = await this.brainScanner.getConversationDetail(convId);
        const existingMeta = this.metaStore.getConversationMeta(convId);
        const sessionMode = existingMeta?.sessionMode || body.mode || 'agent';

        const rawAttachments = Array.isArray(body.attachments) ? body.attachments : [];
        const effectivePendingText =
          text || (rawAttachments.length > 0 ? `请查看附件` : '');
        this.metaStore.addPendingMessage(convId, { clientMessageId, text: effectivePendingText });
        const result = await this.agentController.sendMessage(convId, text, {
          clientMessageId,
          workspacePath: beforeDetail?.workspacePath || existingMeta?.workspacePath || null,
          sessionMode,
          attachments: rawAttachments,
          metaStore: this.metaStore,
        });
        if (result.attachments?.length) {
          this.metaStore.addPendingMessage(convId, {
            clientMessageId,
            text: effectivePendingText,
            attachments: result.attachments,
          });
        }

        this.brainScanner.recordHookEvent({
          conversationId: convId,
          hookEventName: 'PreInvocation',
        });
        const detail = await this.brainScanner.getConversationDetail(convId);
        this.emitEvent('conversation_updated', {
          conversationId: convId,
          detail: detail ? this.#stripPrivateDetail(detail) : null,
        });

        this.#sendJson(res, 200, {
          ...result,
          currentSeq: this.seq,
        });
        return;
      }

      // Update in-session model / thinking / mode settings: POST /api/v1/conversations/:id/settings
      const settingsMatch = /^\/api\/v1\/conversations\/([0-9a-zA-Z_-]{6,64})\/settings$/.exec(pathname);
      if (req.method === 'POST' && settingsMatch) {
        const convId = settingsMatch[1];
        const body = await this.#readJsonBody(req);
        const updatedMeta = this.metaStore.setConversationSettings(convId, {
          model: body.model,
          mode: body.mode,
        });
        if (body.applyNow && body.model && body.model !== 'inherit') {
          await this.agentController.switchConversationModel(convId, body.model);
          this.brainScanner.recordHookEvent({
            conversationId: convId,
            hookEventName: 'PreInvocation',
          });
        }
        await this.pollChanges();
        const detail = await this.brainScanner.getConversationDetail(convId);
        this.emitEvent('conversation_updated', {
          conversationId: convId,
          detail: detail ? this.#stripPrivateDetail(detail) : null,
        });
        this.#sendJson(res, 200, {
          ok: true,
          meta: updatedMeta,
          detail: detail ? this.#stripPrivateDetail(detail) : null,
          currentSeq: this.seq,
        });
        return;
      }

      // Rename conversation: POST /api/v1/conversations/:id/rename
      const renameMatch = /^\/api\/v1\/conversations\/([0-9a-zA-Z_-]{6,64})\/rename$/.exec(pathname);
      if (req.method === 'POST' && renameMatch) {
        const convId = renameMatch[1];
        const body = await this.#readJsonBody(req);
        const updated = this.metaStore.setConversationTitle(convId, body.title);
        await this.pollChanges();
        const detail = await this.brainScanner.getConversationDetail(convId);
        if (detail) {
          this.emitEvent('conversation_updated', {
            conversationId: convId,
            detail: this.#stripPrivateDetail(detail),
          });
        }
        this.#sendJson(res, 200, { ok: true, meta: updated });
        return;
      }

      // Serve user-uploaded attachment safely: GET /api/v1/conversations/:id/uploads/:filename
      const uploadServeMatch = /^\/api\/v1\/conversations\/([0-9a-zA-Z_-]{6,64})\/uploads\/([^/]+)$/.exec(pathname);
      if (req.method === 'GET' && uploadServeMatch) {
        const convId = uploadServeMatch[1];
        const filename = decodeURIComponent(uploadServeMatch[2]);
        if (filename.includes('..') || filename.includes('/') || filename.includes('\\') || filename.startsWith('.')) {
          this.#sendJson(res, 400, { error: 'Invalid upload filename' });
          return;
        }
        const resolved = this.brainScanner.resolveUploadedFilePath(convId, filename);
        if (!resolved || !existsSync(resolved)) {
          this.#sendJson(res, 404, { error: 'Uploaded file not found' });
          return;
        }
        const st = statSync(resolved);
        if (!st.isFile() || st.size > 64 * 1024 * 1024) {
          this.#sendJson(res, 413, { error: 'Uploaded file too large' });
          return;
        }
        const wantThumb = parsedUrl.searchParams.get('thumb') === '1';
        if (wantThumb) {
          const thumbPath = await ensureCachedThumbnail(resolved, st);
          if (thumbPath && existsSync(thumbPath)) {
            const thumbBuf = readFileSync(thumbPath);
            res.writeHead(200, {
              'Content-Type': 'image/jpeg',
              'Content-Length': thumbBuf.length,
              'Cache-Control': 'private, max-age=86400',
            });
            res.end(thumbBuf);
            return;
          }
        }
        const ext = extname(filename).toLowerCase();
        const mime = MIME_BY_EXT[ext] || 'application/octet-stream';
        res.writeHead(200, {
          'Content-Type': mime,
          'Content-Length': st.size,
          'Cache-Control': 'private, max-age=3600',
        });
        res.end(readFileSync(resolved));
        return;
      }

      // Serve conversation artifact safely: GET /api/v1/conversations/:id/artifacts/:filename
      const artifactMatch = /^\/api\/v1\/conversations\/([0-9a-zA-Z_-]{6,64})\/artifacts\/([^/]+)$/.exec(pathname);
      if (req.method === 'GET' && artifactMatch) {
        const convId = artifactMatch[1];
        const filename = decodeURIComponent(artifactMatch[2]);
        if (filename.includes('..') || filename.includes('/') || filename.includes('\\') || filename.startsWith('.')) {
          this.#sendJson(res, 400, { error: 'Invalid artifact filename' });
          return;
        }
        const detail = await this.brainScanner.getConversationDetail(convId);
        if (!detail || !detail.convDir) {
          this.#sendJson(res, 404, { error: 'Conversation not found' });
          return;
        }
        const target = join(detail.convDir, filename);
        if (!existsSync(target)) {
          this.#sendJson(res, 404, { error: 'Artifact not found' });
          return;
        }
        const convReal = realpathSync(detail.convDir);
        const fileReal = realpathSync(target);
        if (!fileReal.startsWith(convReal + sep)) {
          this.#sendJson(res, 403, { error: 'Forbidden path' });
          return;
        }
        const st = statSync(fileReal);
        if (!st.isFile() || st.size > 15 * 1024 * 1024) {
          this.#sendJson(res, 413, { error: 'Artifact too large' });
          return;
        }
        const ext = extname(filename).toLowerCase();
        const mime = MIME_BY_EXT[ext] || 'application/octet-stream';
        res.writeHead(200, {
          'Content-Type': mime,
          'Content-Length': st.size,
          'Cache-Control': 'private, max-age=30',
        });
        res.end(readFileSync(fileReal));
        return;
      }

      this.#sendJson(res, 404, { error: 'Not Found' });
    } catch (err) {
      this.#sendJson(res, 400, {
        error: err?.message || 'Internal Server Error',
      });
    }
  }

  #handleUpgrade(req, socket) {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (parsedUrl.pathname !== '/api/v1/stream') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!this.#checkAuth(req, parsedUrl)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '\r\n',
      ].join('\r\n')
    );
    socket.setNoDelay(true);
    socket.setKeepAlive?.(true, 10_000);

    const client = {
      id: randomUUID(),
      deviceId: null,
      socket,
      connectedAt: Date.now(),
      buffer: Buffer.alloc(0),
    };
    this.wsClients.add(client);

    const sinceParam = parsedUrl.searchParams.get('since_seq');
    const sinceSeq = sinceParam !== null ? Number(sinceParam) : null;

    socket.write(
      encodeWsText({
        seq: this.seq,
        type: 'hello',
        currentSeq: this.seq,
        serverTime: new Date().toISOString(),
      })
    );

    if (sinceSeq !== null && !Number.isNaN(sinceSeq) && sinceSeq > this.seq) {
      socket.write(
        encodeWsText({
          seq: this.seq,
          type: 'resync_required',
          currentSeq: this.seq,
        })
      );
    } else if (sinceSeq !== null && !Number.isNaN(sinceSeq) && sinceSeq < this.seq) {
      const oldestBuffered = this.ringBuffer.length > 0 ? this.ringBuffer[0].seq : this.seq + 1;
      if (sinceSeq + 1 < oldestBuffered) {
        socket.write(
          encodeWsText({
            seq: this.seq,
            type: 'resync_required',
            currentSeq: this.seq,
          })
        );
      } else {
        for (const ev of this.ringBuffer) {
          if (ev.seq > sinceSeq) {
            socket.write(encodeWsText(ev));
          }
        }
      }
    }

    socket.on('data', (chunk) => this.#onWsData(client, chunk));
    socket.on('close', () => {
      if (client.deviceId) {
        this.apnsPusher.updatePresence({ deviceId: client.deviceId, active: false });
      }
      this.wsClients.delete(client);
    });
    socket.on('error', () => {
      if (client.deviceId) {
        this.apnsPusher.updatePresence({ deviceId: client.deviceId, active: false });
      }
      this.wsClients.delete(client);
    });
  }

  #onWsData(client, chunk) {
    client.buffer = Buffer.concat([client.buffer, chunk]);
    while (client.buffer.length >= 2) {
      const b0 = client.buffer[0];
      const b1 = client.buffer[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let payloadLen = b1 & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (client.buffer.length < 4) return;
        payloadLen = client.buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (client.buffer.length < 10) return;
        payloadLen = Number(client.buffer.readBigUInt64BE(2));
        offset = 10;
      }

      if (payloadLen > 2 * 1024 * 1024) {
        client.socket.destroy();
        this.wsClients.delete(client);
        return;
      }

      const maskLen = masked ? 4 : 0;
      if (client.buffer.length < offset + maskLen + payloadLen) return;

      const payload = Buffer.from(client.buffer.subarray(offset + maskLen, offset + maskLen + payloadLen));
      if (masked) {
        const mask = client.buffer.subarray(offset, offset + 4);
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= mask[i & 3];
        }
      }
      client.buffer = client.buffer.subarray(offset + maskLen + payloadLen);

      if (opcode === 0x08) {
        try {
          client.socket.end(encodeWsFrame(0x08, Buffer.alloc(0)));
        } catch {
          client.socket.destroy();
        }
        if (client.deviceId) {
          this.apnsPusher.updatePresence({ deviceId: client.deviceId, active: false });
        }
        this.wsClients.delete(client);
        return;
      } else if (opcode === 0x09) {
        try {
          client.socket.write(encodeWsFrame(0x0a, payload));
        } catch {
          this.wsClients.delete(client);
        }
      } else if (opcode === 0x01) {
        try {
          const msg = JSON.parse(payload.toString('utf-8'));
          if (msg?.type === 'ping') {
            client.socket.write(encodeWsText({ type: 'pong', seq: this.seq, ts: msg.ts || Date.now() }));
          } else if (msg?.type === 'presence' && msg?.deviceId) {
            client.deviceId = String(msg.deviceId);
            const isActive = Boolean(msg.active);
            const visibleConvId = msg.visibleConversationId || null;
            this.apnsPusher.updatePresence({
              deviceId: client.deviceId,
              active: isActive,
              visibleConversationId: visibleConvId,
            });
            if (isActive && visibleConvId && this.metaStore?.markConversationViewed) {
              this.metaStore.markConversationViewed(String(visibleConvId), Date.now());
            }
          }
        } catch {
          // Ignore malformed client frame
        }
      }
    }
  }

  async start() {
    if (this.httpServer) return this;
    await this.pollChanges();

    this.httpServer = createServer((req, res) => {
      this.#handleHttp(req, res);
    });
    this.httpServer.on('upgrade', (req, socket) => {
      this.#handleUpgrade(req, socket);
    });

    await new Promise((resolve, reject) => {
      this.httpServer.once('error', reject);
      this.httpServer.listen(this.port, this.host, () => {
        this.httpServer.removeListener('error', reject);
        resolve();
      });
    });

    this.pollTimer = setInterval(() => {
      this.pollChanges();
    }, this.pollIntervalMs);
    this.pollTimer.unref?.();

    this.pingTimer = setInterval(() => {
      const pingFrame = encodeWsFrame(0x09, Buffer.from('hb'));
      for (const client of this.wsClients) {
        try {
          client.socket.write(pingFrame);
        } catch {
          this.wsClients.delete(client);
        }
      }
    }, 12_000);
    this.pingTimer.unref?.();

    return this;
  }

  async stop() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    for (const c of this.wsClients) {
      try {
        c.socket.destroy();
      } catch {
        // Ignore
      }
    }
    this.wsClients.clear();
    if (this.httpServer) {
      await new Promise((resolve) => this.httpServer.close(() => resolve()));
      this.httpServer = null;
    }
  }
}
