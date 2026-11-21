#!/usr/bin/env node
/**
 * Fast Antigravity Lifecycle Hook Relay.
 * Forwards hook events (`SessionStart`, `PreInvocation`, `PreToolUse`, `PostToolUse`,
 * `PostInvocation`, `Stop`) to local AntigravityZ Bridge on 127.0.0.1 and relays
 * any `injectSteps` (such as mobile `userMessage`) back to Antigravity via stdout.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function fallbackOutputFor(eventName) {
  if (eventName === 'PreToolUse') {
    return '{"decision":"allow"}\n';
  }
  return '{}\n';
}

async function run() {
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += chunk;
  }

  let parsed = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  const eventName = String(parsed?.hookEventName || '');
  const defaultOut = fallbackOutputFor(eventName);

  const authPath = join(homedir(), '.gemini', 'antigravity', 'antigravityz', 'auth.json');
  if (raw && existsSync(authPath)) {
    try {
      const auth = JSON.parse(readFileSync(authPath, 'utf-8'));
      const port = Number(process.env.ANTIGRAVITYZ_PORT || 19818);
      const lsAddr = process.env.ANTIGRAVITY_LS_ADDRESS || '';
      const lsCsrf = process.env.ANTIGRAVITY_CSRF_TOKEN || '';
      const enrichedBody =
        parsed && typeof parsed === 'object' && lsAddr && lsCsrf
          ? JSON.stringify({ ...parsed, _lsEndpoint: { address: lsAddr, csrf: lsCsrf } })
          : raw;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      const res = await fetch(`http://127.0.0.1:${port}/internal/hook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-AntigravityZ-Hook-Secret': auth.hookSecret || '',
        },
        body: enrichedBody,
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res && res.ok) {
        const data = await res.json();
        if (data?.hookResponse && typeof data.hookResponse === 'object') {
          process.stdout.write(`${JSON.stringify(data.hookResponse)}\n`);
          return;
        }
      }
    } catch {
      // Never block agent lifecycle if bridge is restarting
    }
  }
  process.stdout.write(defaultOut);
}

run().catch(() => {
  process.stdout.write('{}\n');
});
