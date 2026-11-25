/**
 * AI bridge tests.
 *
 * A local server stands in for an OpenAI-compatible provider. The tests prove
 * the tool loop actually executes tools, that the provider key stays on the
 * server, and that provider failures are reported without leaking the key.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

const requests: Array<{ path: string; auth: string | undefined; body: unknown }> = [];
let toolRoundSeen = false;

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => {
    raw += String(chunk);
  });
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {};
    requests.push({ path: req.url ?? '', auth: req.headers.authorization, body });

    if ((req.url ?? '').startsWith('/fail')) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'upstream exploded' }));
      return;
    }

    const messages = (body as { messages?: Array<{ role: string }> }).messages ?? [];
    const hasToolResult = messages.some((message) => message.role === 'tool');

    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (!hasToolResult && !toolRoundSeen) {
      toolRoundSeen = true;
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [
                  {
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'search_files', arguments: '{"query":"main.js"}' },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 3 },
        }),
      );
      return;
    }

    res.end(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'The entry file is /main.js.' } }],
        usage: { prompt_tokens: 20, completion_tokens: 8 },
      }),
    );
  });
});

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('mock provider failed to bind');
const baseUrl = `http://127.0.0.1:${address.port}/v1`;

const { llmConfig, llmStatus, runToolLoop, polishAnswer, LlmError } = await import('../src/lib/bigbrother/llm.ts');

test('no key means no provider, and the engine says so', async () => {
  delete process.env.DARKNOTE_AI_API_KEY;
  assert.equal(llmConfig(), null);
  assert.equal(llmStatus().configured, false);
  await assert.rejects(
    () =>
      runToolLoop({
        system: 'x',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [],
        callTool: async () => null,
      }),
    /No AI provider is configured/,
  );
});

test('the provider key is never part of a status payload', () => {
  process.env.DARKNOTE_AI_API_KEY = 'sk-test-super-secret';
  process.env.DARKNOTE_AI_BASE_URL = baseUrl;
  process.env.DARKNOTE_AI_MODEL = 'mock-model';
  const status = llmStatus();
  assert.equal(status.configured, true);
  assert.equal(status.model, 'mock-model');
  assert.equal(status.host, `127.0.0.1:${address.port}`);
  assert.ok(!JSON.stringify(status).includes('sk-test-super-secret'));
});

test('the tool loop executes a real data call and returns the grounded answer', async () => {
  process.env.DARKNOTE_AI_API_KEY = 'sk-test-super-secret';
  process.env.DARKNOTE_AI_BASE_URL = baseUrl;
  process.env.DARKNOTE_AI_MODEL = 'mock-model';
  process.env.DARKNOTE_AI_TIMEOUT_MS = '8000';

  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const result = await runToolLoop({
    system: 'You are BIGBROTHER.',
    messages: [{ role: 'user', content: 'Where is main.js?' }],
    tools: [
      {
        name: 'search_files',
        description: 'Search the project index',
        parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      },
    ],
    callTool: async (name, args) => {
      calls.push({ name, args });
      return { hits: [{ path: '/main.js', line: null }] };
    },
  });

  assert.equal(result.text, 'The entry file is /main.js.');
  assert.equal(result.model, 'mock-model');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'search_files');
  assert.equal(calls[0].args.query, 'main.js');
  assert.equal(result.toolCalls.length, 1);
  assert.deepEqual(result.usage, { promptTokens: 20, completionTokens: 8 });

  // The upstream request carried the key, and the tool result was fed back.
  assert.ok(requests.length >= 2);
  assert.equal(requests[0].auth, 'Bearer sk-test-super-secret');
  const second = requests[requests.length - 1].body as { messages: Array<{ role: string; content: string }> };
  assert.ok(second.messages.some((message) => message.role === 'tool'));
  assert.match(second.messages.find((message) => message.role === 'tool')?.content ?? '', /\/main\.js/);
});

test('polish rewrites wording without being required', async () => {
  const polished = await polishAnswer('Where is main.js?', 'The entry file is /main.js.');
  assert.equal(polished, 'The entry file is /main.js.');
});

test('a provider failure is reported without the key', async () => {
  process.env.DARKNOTE_AI_API_KEY = 'sk-test-super-secret';
  process.env.DARKNOTE_AI_BASE_URL = `${baseUrl.replace('/v1', '')}/fail`;
  try {
    await runToolLoop({
      system: 'x',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      callTool: async () => null,
    });
    assert.fail('expected a provider error');
  } catch (error) {
    assert.ok(error instanceof LlmError);
    assert.match((error as Error).message, /HTTP 500/);
    assert.ok(!(error as Error).message.includes('sk-test-super-secret'));
  } finally {
    delete process.env.DARKNOTE_AI_API_KEY;
    delete process.env.DARKNOTE_AI_BASE_URL;
  }
});

test('the mock provider can be closed', async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
