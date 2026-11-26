/**
 * QuotaMonitor — Queries Antigravity's local Connect LanguageServerService
 * (`RetrieveUserQuotaSummary` + `GetUserStatus`) using the documented
 * `ANTIGRAVITY_LS_ADDRESS` & `ANTIGRAVITY_CSRF_TOKEN` environment contract
 * to surface all 4 live quota bars (Gemini 5h + Weekly, Claude/GPT 5h + Weekly).
 */
import { MODEL_FAMILIES } from './model-catalog.mjs';

function clampFraction(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}

function detectWindowType(remainingPercent, resetTime, weeklyPercent = null) {
  if (typeof weeklyPercent === 'number' && weeklyPercent <= 0) {
    return 'weekly_locked';
  }
  if (!resetTime) return 'five_hour';
  const resetMs = Date.parse(resetTime);
  if (!Number.isFinite(resetMs)) return 'five_hour';
  const hoursAhead = (resetMs - Date.now()) / 3_600_000;
  if (hoursAhead > 6.2 && remainingPercent <= 1) {
    return 'weekly_locked';
  }
  return 'five_hour';
}

export class QuotaMonitor {
  constructor({ metaStore = null, fetchFn = globalThis.fetch, minRefreshMs = 15_000 } = {}) {
    this.metaStore = metaStore;
    this.fetchFn = fetchFn;
    this.minRefreshMs = minRefreshMs;
    this.cachedSnapshot = null;
    this.lastFetchedAt = 0;
  }

  resolveEndpoint() {
    const envAddr = String(process.env.ANTIGRAVITY_LS_ADDRESS || '').trim();
    const envCsrf = String(process.env.ANTIGRAVITY_CSRF_TOKEN || '').trim();
    if (envAddr && envCsrf) {
      return { address: envAddr, csrf: envCsrf };
    }
    const saved = this.metaStore?.getLsEndpoint?.();
    if (saved?.address && saved?.csrf) {
      return { address: saved.address, csrf: saved.csrf };
    }
    return null;
  }

  async #callRpc(baseUrl, csrf, methodName, signal) {
    const res = await this.fetchFn(
      `${baseUrl}/exa.language_server_pb.LanguageServerService/${methodName}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          'x-codeium-csrf-token': csrf,
        },
        body: '{}',
        signal,
      }
    );
    if (!res || !res.ok) return null;
    return await res.json();
  }

  async getSnapshot({ force = false } = {}) {
    const now = Date.now();
    if (!force && this.cachedSnapshot && now - this.lastFetchedAt < this.minRefreshMs) {
      return this.cachedSnapshot;
    }

    const endpoint = this.resolveEndpoint();
    if (!endpoint || typeof this.fetchFn !== 'function') {
      return this.cachedSnapshot;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1800);
    try {
      const hostPart = endpoint.address.startsWith('http')
        ? endpoint.address
        : `http://${endpoint.address}`;
      const baseUrl = hostPart.replace(/\/+$/, '');

      const [summarySettled, statusSettled] = await Promise.allSettled([
        this.#callRpc(baseUrl, endpoint.csrf, 'RetrieveUserQuotaSummary', controller.signal),
        this.#callRpc(baseUrl, endpoint.csrf, 'GetUserStatus', controller.signal),
      ]);

      const summaryData = summarySettled.status === 'fulfilled' ? summarySettled.value : null;
      const statusData = statusSettled.status === 'fulfilled' ? statusSettled.value : null;

      const parsed = QuotaMonitor.parseCombined(summaryData, statusData?.userStatus);
      if (parsed) {
        this.cachedSnapshot = parsed;
        this.lastFetchedAt = now;
      }
      return this.cachedSnapshot;
    } catch {
      return this.cachedSnapshot;
    } finally {
      clearTimeout(timer);
    }
  }

  static parseQuotaSummaryGroups(summaryPayload) {
    const groups = summaryPayload?.response?.groups || summaryPayload?.groups;
    if (!Array.isArray(groups) || groups.length === 0) return null;

    const byPoolId = new Map();
    for (const grp of groups) {
      const disp = String(grp?.displayName || '').toLowerCase();
      const buckets = Array.isArray(grp?.buckets) ? grp.buckets : [];
      if (buckets.length === 0) continue;

      const bucketIdsJoined = buckets.map((b) => String(b?.bucketId || '').toLowerCase()).join(' ');
      let poolId = null;
      let label = null;
      if (disp.includes('gemini') || bucketIdsJoined.includes('gemini')) {
        poolId = 'gemini';
        label = 'Gemini';
      } else if (
        disp.includes('claude') ||
        disp.includes('gpt') ||
        bucketIdsJoined.includes('3p-')
      ) {
        poolId = 'claude_gpt';
        label = 'Claude · GPT';
      } else {
        continue;
      }

      const fiveHBucket = buckets.find(
        (b) => b?.window === '5h' || String(b?.bucketId || '').endsWith('-5h')
      );
      const weeklyBucket = buckets.find(
        (b) => b?.window === 'weekly' || String(b?.bucketId || '').endsWith('-weekly')
      );

      const fiveHFrac = clampFraction(fiveHBucket?.remainingFraction);
      const weeklyFrac = clampFraction(weeklyBucket?.remainingFraction);
      if (fiveHFrac === null && weeklyFrac === null) continue;

      const primaryFrac = fiveHFrac !== null ? fiveHFrac : weeklyFrac;
      const remainingFraction = Number(primaryFrac.toFixed(4));
      const remainingPercent = Math.round(primaryFrac * 100);
      const resetTime = fiveHFrac !== null
        ? (fiveHBucket?.resetTime ? String(fiveHBucket.resetTime) : null)
        : (weeklyBucket?.resetTime ? String(weeklyBucket.resetTime) : null);

      const weeklyFraction = weeklyFrac !== null ? Number(weeklyFrac.toFixed(4)) : null;
      const weeklyPercent = weeklyFrac !== null ? Math.round(weeklyFrac * 100) : null;
      const weeklyResetTime = weeklyBucket?.resetTime ? String(weeklyBucket.resetTime) : null;

      byPoolId.set(poolId, {
        id: poolId,
        label,
        remainingFraction,
        remainingPercent,
        resetTime,
        weeklyFraction,
        weeklyPercent,
        weeklyResetTime,
        windowType: detectWindowType(remainingPercent, resetTime, weeklyPercent),
      });
    }

    return byPoolId.size > 0 ? byPoolId : null;
  }

  static parseCombined(summaryPayload, userStatus) {
    const summaryPools = QuotaMonitor.parseQuotaSummaryGroups(summaryPayload);
    const statusParsed = QuotaMonitor.parseUserStatus(userStatus);

    if (!summaryPools && !statusParsed) return null;

    if (!summaryPools) {
      return statusParsed;
    }

    const pools = [];
    for (const key of ['gemini', 'claude_gpt']) {
      if (summaryPools.has(key)) {
        pools.push(summaryPools.get(key));
      } else {
        const fallback = statusParsed?.pools?.find((p) => p.id === key);
        if (fallback) pools.push(fallback);
      }
    }

    const byModelId = { ...(statusParsed?.byModelId || {}) };
    for (const fam of MODEL_FAMILIES) {
      const poolKey = fam.provider === 'anthropic' || fam.provider === 'oss' ? 'claude_gpt' : 'gemini';
      const pool = summaryPools.get(poolKey);
      if (!pool) continue;
      const usePoolPrimary = pool.remainingFraction !== null && pool.remainingFraction !== undefined;
      for (const variant of fam.variants) {
        const existing = byModelId[variant.id];
        byModelId[variant.id] = {
          id: variant.id,
          label: variant.displayName,
          remainingFraction: usePoolPrimary ? pool.remainingFraction : (existing?.remainingFraction ?? null),
          remainingPercent: usePoolPrimary ? pool.remainingPercent : (existing?.remainingPercent ?? null),
          resetTime: usePoolPrimary ? pool.resetTime : (existing?.resetTime ?? null),
          weeklyFraction: pool.weeklyFraction,
          weeklyPercent: pool.weeklyPercent,
          weeklyResetTime: pool.weeklyResetTime,
          windowType: pool.windowType,
        };
      }
    }

    const rawTier = userStatus?.userTier?.name ? String(userStatus.userTier.name) : null;
    return {
      tierName: statusParsed?.tierName || rawTier,
      pools,
      byModelId,
      updatedAt: new Date().toISOString(),
    };
  }

  static parseUserStatus(userStatus) {
    if (!userStatus || typeof userStatus !== 'object') return null;
    const configs = userStatus?.cascadeModelConfigData?.clientModelConfigs;
    if (!Array.isArray(configs) || configs.length === 0) return null;

    const rawByLabelLower = new Map();
    for (const cfg of configs) {
      const label = String(cfg?.label || '').trim();
      const frac = clampFraction(cfg?.quotaInfo?.remainingFraction);
      if (!label || frac === null) continue;
      const resetTime = cfg?.quotaInfo?.resetTime ? String(cfg.quotaInfo.resetTime) : null;
      rawByLabelLower.set(label.toLowerCase(), {
        label,
        remainingFraction: Number(frac.toFixed(4)),
        remainingPercent: Math.round(frac * 100),
        resetTime,
      });
    }
    if (rawByLabelLower.size === 0) return null;

    const byModelId = {};
    let geminiRepresentative = null;
    let claudeGptRepresentative = null;

    for (const fam of MODEL_FAMILIES) {
      for (const variant of fam.variants) {
        const hit = rawByLabelLower.get(variant.displayName.toLowerCase());
        if (!hit) continue;
        const windowType = detectWindowType(hit.remainingPercent, hit.resetTime);
        const entry = {
          id: variant.id,
          label: variant.displayName,
          remainingFraction: hit.remainingFraction,
          remainingPercent: hit.remainingPercent,
          resetTime: hit.resetTime,
          weeklyFraction: null,
          weeklyPercent: null,
          weeklyResetTime: null,
          windowType,
        };
        byModelId[variant.id] = entry;
        if (fam.provider === 'google' && !geminiRepresentative) {
          geminiRepresentative = {
            id: 'gemini',
            label: 'Gemini',
            remainingFraction: hit.remainingFraction,
            remainingPercent: hit.remainingPercent,
            resetTime: hit.resetTime,
            weeklyFraction: null,
            weeklyPercent: null,
            weeklyResetTime: null,
            windowType,
          };
        } else if ((fam.provider === 'anthropic' || fam.provider === 'oss') && !claudeGptRepresentative) {
          claudeGptRepresentative = {
            id: 'claude_gpt',
            label: 'Claude · GPT',
            remainingFraction: hit.remainingFraction,
            remainingPercent: hit.remainingPercent,
            resetTime: hit.resetTime,
            weeklyFraction: null,
            weeklyPercent: null,
            weeklyResetTime: null,
            windowType,
          };
        }
      }
    }

    const pools = [];
    if (geminiRepresentative) pools.push(geminiRepresentative);
    if (claudeGptRepresentative) pools.push(claudeGptRepresentative);

    if (pools.length === 0) {
      const first = rawByLabelLower.values().next().value;
      if (first) {
        pools.push({
          id: 'default',
          label: 'Gemini',
          remainingFraction: first.remainingFraction,
          remainingPercent: first.remainingPercent,
          resetTime: first.resetTime,
          weeklyFraction: null,
          weeklyPercent: null,
          weeklyResetTime: null,
          windowType: detectWindowType(first.remainingPercent, first.resetTime),
        });
      }
    }

    return {
      tierName: userStatus?.userTier?.name ? String(userStatus.userTier.name) : null,
      pools,
      byModelId,
      updatedAt: new Date().toISOString(),
    };
  }
}
