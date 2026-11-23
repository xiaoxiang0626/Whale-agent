/** 真实模型跨日志恢复上下文；额外比较同一合成历史的裁剪前后 prompt token。 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { SessionJournal, sessionPath } from '../src/session.ts';
import { resolveConfig } from '../src/config.ts';
import { createOpenAICompatibleProvider } from '../src/providers/openai-compatible.ts';
import { Conversation } from '../src/conversation.ts';
import { selectContext } from '../src/context.ts';
import { isRecord } from '../src/providers/wire.ts';
import { formatError } from '../src/errors.ts';
import type { ModelMessage } from '../src/providers/types.ts';
import { createReadOnlyTools } from '../src/tools/read-only.ts';

let root: string | undefined;
let journal: SessionJournal | undefined;
try {
  process.loadEnvFile('.env');
  const config = resolveConfig(process.env);
  if (config.provider !== 'openai-compatible') { throw new Error('Real provider required'); }
  root = await mkdtemp(join(tmpdir(), 'agent-session-live-'));
  const path = await sessionPath(root, 'live');
  const identity = { workspace: root, provider: config.provider, model: config.model, mode: 'read-only' as const };
  const tokens: (number | null)[] = [];
  const provider = createOpenAICompatibleProvider(config, async (input, init) => {
    const response = await fetch(input, init);
    if (response.ok) {
      const value: unknown = await response.clone().json(); const usage = isRecord(value) ? value['usage'] : undefined;
      tokens.push(isRecord(usage) && typeof usage['prompt_tokens'] === 'number' ? usage['prompt_tokens'] : null);
    }
    return response;
  });
  const signal = AbortSignal.timeout(180000);
  const marker = `SESSION_${randomBytes(8).toString('hex')}`;
  await writeFile(join(root, 'marker.txt'), marker + '\n');
  journal = await SessionJournal.open(path, identity, false, false, [config.apiKey]);
  const first = new Conversation(provider, config.model, { journal, tools: await createReadOnlyTools(root) });
  await first.send('读取 marker.txt，记住文件中的完整标记，只回复已记住。', signal);
  assert.ok(first.messages.some(message => message.role === 'tool' && message.content.includes(marker)));
  await journal.close();
  journal = await SessionJournal.open(path, identity, true, false, [config.apiKey]);
  const restored = new Conversation(provider, config.model, { journal, tools: await createReadOnlyTools(root) });
  assert.ok((await restored.send('只根据上一轮工具结果回答，不再读取文件：完整标记是什么？只回复标记。', signal)).text.includes(marker));
  assert.equal(restored.turnCount, 2);
  const raw = await readFile(path, 'utf8'); assert.ok(!raw.includes(config.apiKey)); assert.ok(!raw.includes('Authorization'));
  const history: ModelMessage[] = Array.from({ length: 8 }, (_, index) => [
    { role: 'user' as const, content: `fixture ${index} ` + 'fixture-history '.repeat(80) }, { role: 'assistant' as const, content: '收到' },
  ]).flat();
  history.push({ role: 'user', content: '仅回复：收到' });
  const full = { model: config.model, messages: history };
  const selected = selectContext(full, history.length - 1, 4000);
  const beforeMetrics = tokens.length;
  for (const request of [full, selected.request]) { await provider.complete(request, signal); }
  console.log(JSON.stringify({ status: 'passed', restoredTurns: 2, modelRequests: tokens.length, secretsSaved: false,
    jsonCharsBefore: JSON.stringify(full).length, jsonCharsAfter: JSON.stringify(selected.request).length, droppedMessages: selected.dropped,
    promptTokensBefore: tokens[beforeMetrics], promptTokensAfter: tokens[beforeMetrics + 1], restoredToolHistory: true }));
} catch (error) { process.stderr.write(`${formatError(error)}\n`); process.exitCode = 1; }
finally { await journal?.close(); if (root !== undefined) { await rm(root, { recursive: true, force: true }); } }
