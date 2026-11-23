import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { AgentController } from '../src/agent-controller.mjs';
import { ApnsPusher } from '../src/apns-pusher.mjs';
import { BrainScanner } from '../src/brain-scanner.mjs';
import { BridgeServer } from '../src/bridge-server.mjs';
import { MetaStore } from '../src/meta-store.mjs';
import { generateQrSvg } from '../src/qr-svg.mjs';
import { QuotaMonitor } from '../src/quota-monitor.mjs';

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
});

test('QR SVG generator produces valid crisp SVG for pairing URIs', () => {
  const uri = 'antigravityz://pair?url=http%3A%2F%2F100.108.180.5%3A19818&token=abc123XYZ_secretToken987654&name=StudioMac';
  const svg = generateQrSvg(uri);
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'));
  assert.ok(svg.includes('<path d="M'));
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

      // Flag it via POST /api/v1/conversations/:id/flag
      bridge.ringBuffer.length = 0;
      const flagRes = await fetch(`http://127.0.0.1:${port}/api/v1/conversations/${convId}/flag`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ flagged: true }),
      });
      assert.equal(flagRes.status, 200);
      const flagJson = await flagRes.json();
      assert.equal(flagJson.ok, true);
      assert.equal(flagJson.flagged, true);

      const wsFlagEv = bridge.ringBuffer.find((e) => e.type === 'workspaces_updated');
      assert.ok(wsFlagEv, 'Flagging must broadcast workspaces_updated to other paired devices');
      const flaggedConv = wsFlagEv.workspaces.flatMap((w) => w.conversations).find((c) => c.id === convId);
      assert.equal(flaggedConv?.flagged, true);

      // Unflag it
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

      const wsUnflagEv = bridge.ringBuffer.find((e) => e.type === 'workspaces_updated');
      assert.ok(wsUnflagEv, 'Unflagging must broadcast workspaces_updated');
      const unflaggedConv = wsUnflagEv.workspaces.flatMap((w) => w.conversations).find((c) => c.id === convId);
      assert.equal(unflaggedConv?.flagged, false);
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
