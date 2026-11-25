/**
 * ApnsPusher — Zero-dependency Apple Push Notification service (APNs) HTTP/2 client
 * with ES256 token authentication, foreground presence suppression, and dead-token pruning.
 */
import { createHash, sign as cryptoSign } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import http2 from 'node:http2';
import { stripInlineAttachmentMarkdown } from './inline-attachments.mjs';

const PRESENCE_LEASE_MS = 45_000;
const JWT_TTL_SEC = 50 * 60;
const TOKEN_RE = /^[0-9a-f]{32,200}$/i;

function base64Url(input) {
  return Buffer.from(input).toString('base64url');
}

export function isValidApnsToken(token) {
  return TOKEN_RE.test(String(token || '').trim());
}

export function hashDeviceToken(token) {
  return createHash('sha256').update(String(token).toLowerCase()).digest('hex').slice(0, 24);
}

export class ApnsPusher {
  constructor({
    metaStore,
    keyPath = process.env.LEVITY_APNS_KEY_PATH || process.env.ANTIGRAVITYZ_APNS_KEY_PATH || '',
    keyId = process.env.LEVITY_APNS_KEY_ID || process.env.ANTIGRAVITYZ_APNS_KEY_ID || '',
    teamId = process.env.LEVITY_APNS_TEAM_ID || process.env.ANTIGRAVITYZ_APNS_TEAM_ID || '',
    bundleId = process.env.LEVITY_APNS_BUNDLE_ID || process.env.ANTIGRAVITYZ_APNS_BUNDLE_ID || 'xyz.spaceshuttle.antigravityz',
    relayUrl = process.env.LEVITY_PUSH_RELAY_URL ?? 'https://push.spaceshuttle.xyz/v1/push',
    relayKey = process.env.LEVITY_PUSH_RELAY_KEY || '',
    defaultEnv = process.env.LEVITY_APNS_ENV || process.env.ANTIGRAVITYZ_APNS_ENV || 'production',
    sendFn = null,
  } = {}) {
    this.metaStore = metaStore;
    this.keyPath = keyPath;
    this.keyId = keyId;
    this.teamId = teamId;
    this.bundleId = bundleId;
    const rawRelay = String(relayUrl || '').trim();
    this.relayUrl = rawRelay && rawRelay.toLowerCase() !== 'off' ? rawRelay : '';
    this.relayKey = String(relayKey || '').trim();
    this.defaultEnv = defaultEnv === 'sandbox' ? 'sandbox' : 'production';
    this.sendFn = sendFn;

    this.privateKeyPem = '';
    if (this.keyPath && existsSync(this.keyPath)) {
      try {
        this.privateKeyPem = readFileSync(this.keyPath, 'utf-8');
      } catch (err) {
        console.warn('[Levity APNs] Unable to read APNs key file:', err?.message);
      }
    }

    this.cachedJwt = { token: '', issuedAtSec: 0 };
    this.presenceByDevice = new Map(); // deviceId -> { active, visibleConversationId, expiresAt }
    this.notifiedEventIds = new Set();
  }

  hasDirectKey() {
    return Boolean(this.privateKeyPem && this.keyId && this.teamId && this.bundleId);
  }

  isConfigured() {
    if (this.sendFn) return true;
    return this.hasDirectKey() || Boolean(this.relayUrl);
  }

  updatePresence({ deviceId, active = true, visibleConversationId = null }) {
    if (!deviceId) return;
    const cleanId = String(deviceId).slice(0, 120);
    if (!active) {
      this.presenceByDevice.delete(cleanId);
      return;
    }
    this.presenceByDevice.set(cleanId, {
      active: true,
      visibleConversationId: visibleConversationId ? String(visibleConversationId) : null,
      expiresAt: Date.now() + PRESENCE_LEASE_MS,
    });
  }

  isConversationActivelyViewed(conversationId) {
    if (!conversationId) return false;
    const now = Date.now();
    for (const [id, entry] of this.presenceByDevice.entries()) {
      if (now >= entry.expiresAt) {
        this.presenceByDevice.delete(id);
        continue;
      }
      if (entry.active && entry.visibleConversationId === conversationId) {
        return true;
      }
    }
    return false;
  }

  #buildJwt() {
    const nowSec = Math.floor(Date.now() / 1000);
    if (this.cachedJwt.token && nowSec - this.cachedJwt.issuedAtSec < JWT_TTL_SEC) {
      return this.cachedJwt.token;
    }
    const header = base64Url(JSON.stringify({ alg: 'ES256', kid: this.keyId }));
    const claims = base64Url(JSON.stringify({ iss: this.teamId, iat: nowSec }));
    const signingInput = `${header}.${claims}`;
    const signature = cryptoSign('sha256', Buffer.from(signingInput), {
      key: this.privateKeyPem,
      dsaEncoding: 'ieee-p1363',
    });
    const jwt = `${signingInput}.${signature.toString('base64url')}`;
    this.cachedJwt = { token: jwt, issuedAtSec: nowSec };
    return jwt;
  }

  async #sendViaRelay({ token, environment, payload, collapseId }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    timer.unref?.();
    try {
      const headers = { 'content-type': 'application/json' };
      if (this.relayKey) {
        headers['x-levity-relay-key'] = this.relayKey;
      }
      const resp = await fetch(this.relayUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          token,
          environment: environment === 'sandbox' ? 'sandbox' : 'production',
          collapseId,
          payload,
        }),
        signal: controller.signal,
      });
      const data = await resp.json().catch(() => ({}));
      if (resp.ok && data.sent !== false) {
        return { sent: true, status: data.status || resp.status };
      }
      return {
        sent: false,
        status: data.status || resp.status,
        permanent: Boolean(data.permanent || resp.status === 410),
        reason: data.reason || data.error || `relay_http_${resp.status}`,
      };
    } catch (err) {
      return { sent: false, permanent: false, reason: err?.message || 'relay_network_error' };
    } finally {
      clearTimeout(timer);
    }
  }

  async #sendSingleHttp2({ token, environment, payload, collapseId }) {
    if (this.sendFn) {
      return this.sendFn({ token, environment, payload, collapseId, bundleId: this.bundleId });
    }
    if (!this.hasDirectKey() && this.relayUrl) {
      return this.#sendViaRelay({ token, environment, payload, collapseId });
    }
    if (!this.hasDirectKey()) {
      return { skipped: true, reason: 'apns_not_configured' };
    }

    const env = environment === 'sandbox' ? 'sandbox' : (environment === 'production' ? 'production' : this.defaultEnv);
    const host = env === 'sandbox' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com';

    return new Promise((resolve) => {
      const client = http2.connect(host);
      let settled = false;
      const finish = (res) => {
        if (settled) return;
        settled = true;
        try {
          client.close();
        } catch {
          // Ignore close errors
        }
        resolve(res);
      };

      client.on('error', (err) => {
        finish({ sent: false, permanent: false, reason: err?.message || 'connect_error' });
      });

      let authHeader = '';
      try {
        authHeader = `bearer ${this.#buildJwt()}`;
      } catch (err) {
        finish({ sent: false, permanent: false, reason: err?.message || 'jwt_sign_error' });
        return;
      }

      const headers = {
        ':method': 'POST',
        ':path': `/3/device/${token}`,
        authorization: authHeader,
        'apns-topic': this.bundleId,
        'apns-push-type': 'alert',
        'apns-priority': '10',
      };
      if (collapseId) {
        headers['apns-collapse-id'] = String(collapseId).slice(0, 64);
      }

      const req = client.request(headers);
      let status = 0;
      const chunks = [];
      req.setEncoding('utf8');
      req.on('response', (h) => {
        status = Number(h[':status']) || 0;
      });
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const raw = chunks.join('');
        if (status >= 200 && status < 300) {
          finish({ sent: true, status });
          return;
        }
        let reason = raw;
        try {
          reason = JSON.parse(raw)?.reason || raw;
        } catch {
          // Keep raw string
        }
        finish({
          sent: false,
          status,
          permanent: status === 410 || reason === 'BadDeviceToken' || reason === 'Unregistered',
          reason,
        });
      });
      req.on('error', (err) => {
        finish({ sent: false, permanent: false, reason: err?.message || 'request_error' });
      });

      req.end(JSON.stringify(payload));
      setTimeout(() => {
        finish({ sent: false, permanent: false, reason: 'timeout' });
      }, 10_000).unref?.();
    });
  }

  rememberDedupeKey(eventKey) {
    if (!eventKey) return false;
    if (this.notifiedEventIds.has(eventKey)) return true;
    this.notifiedEventIds.add(eventKey);
    if (this.notifiedEventIds.size > 2000) {
      for (const old of this.notifiedEventIds) {
        this.notifiedEventIds.delete(old);
        if (this.notifiedEventIds.size <= 1000) break;
      }
    }
    return false;
  }

  async notifyConversation({
    conversationId,
    title,
    subtitle = '',
    body,
    kind = 'completed',
    eventKey = '',
    badge = null,
    force = false,
  }) {
    if (eventKey && !force && this.rememberDedupeKey(eventKey)) {
      return { ok: true, skipped: true, reason: 'duplicate_event' };
    }
    if (!force && conversationId && this.isConversationActivelyViewed(conversationId)) {
      return { ok: true, suppressed: true, reason: 'actively_viewed' };
    }
    if (!this.isConfigured()) {
      return { ok: true, configured: false, sent: 0 };
    }

    const devices = this.metaStore ? this.metaStore.listPushDevices() : [];
    if (devices.length === 0) {
      return { ok: true, configured: true, sent: 0, total: 0 };
    }

    const alert = {
      title: stripInlineAttachmentMarkdown(title || 'Levity').slice(0, 80),
      body: stripInlineAttachmentMarkdown(body || 'Session updated').replace(/\s+/g, ' ').trim().slice(0, 180),
    };
    if (subtitle) {
      alert.subtitle = stripInlineAttachmentMarkdown(subtitle).slice(0, 60);
    }

    const aps = {
      alert,
      sound: 'default',
      'thread-id': conversationId || 'general',
    };
    if (typeof badge === 'number' && Number.isFinite(badge) && badge >= 0) {
      aps.badge = Math.floor(badge);
    }

    const payload = {
      aps,
      conversationId: conversationId || '',
      kind,
    };

    // Never collapse by conversationId (which overwrites previous unread notifications in iOS Notification Center).
    // Only deduplicate identical event retries by eventKey hash; `aps.thread-id` groups per-session stacks natively.
    const collapseId = eventKey
      ? `agz-${createHash('sha256').update(String(eventKey)).digest('hex').slice(0, 32)}`
      : '';
    let sent = 0;
    let failed = 0;

    for (const dev of devices) {
      let res = await this.#sendSingleHttp2({
        token: dev.token,
        environment: dev.environment || this.defaultEnv,
        payload,
        collapseId,
      });
      // Automatic fallback if Xcode Debug token hit production endpoint or vice versa
      if (!res.sent && res.reason === 'BadDeviceToken' && !dev.environmentConfirmed) {
        const altEnv = (dev.environment || this.defaultEnv) === 'sandbox' ? 'production' : 'sandbox';
        const retryRes = await this.#sendSingleHttp2({
          token: dev.token,
          environment: altEnv,
          payload,
          collapseId,
        });
        if (retryRes.sent) {
          res = retryRes;
          this.metaStore?.registerPushDevice({
            token: dev.token,
            environment: altEnv,
            deviceId: dev.deviceId,
            environmentConfirmed: true,
          });
        }
      }

      if (res.sent) {
        sent += 1;
      } else {
        failed += 1;
        if (res.permanent && this.metaStore) {
          this.metaStore.removePushDevice(dev.token);
        }
      }
    }

    return { ok: true, configured: true, sent, failed, total: devices.length };
  }
}
