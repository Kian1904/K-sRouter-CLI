import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { createApp, type ProviderConfig } from '../src/server.js';

const adminKey = 'test-admin-secret';
const apps: Array<{ app: ReturnType<typeof createApp>; directory: string }> = [];

async function testApp(
  fetchImpl: typeof fetch,
  options: { providers?: ProviderConfig[]; maxRequestLogs?: number; serveDashboard?: boolean; clientKeyStorePath?: string } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'ksrouter-test-'));
  const app = createApp({
    adminApiKey: adminKey,
    serveDashboard: options.serveDashboard ?? false,
    providers: options.providers ?? [{
      name: 'default', baseUrl: 'https://provider.test/v1/', apiKey: 'test-provider-secret', models: ['demo-model'],
    }],
    fetchImpl,
    maxRequestLogs: options.maxRequestLogs,
    clientKeyStorePath: options.clientKeyStorePath ?? join(directory, 'keys.json'),
  });
  apps.push({ app, directory });
  await app.ready();
  const created = await app.inject({
    method: 'POST', url: '/admin/client-keys',
    headers: { authorization: `Bearer ${adminKey}` }, payload: { name: 'test client' },
  });
  assert.equal(created.statusCode, 201);
  return { app, clientKey: created.json().key as string, testDirectory: directory };
}

function adminHeaders(key = adminKey) { return { authorization: `Bearer ${key}` }; }
async function chat(app: ReturnType<typeof createApp>, key: string | null, payload: any) {
  return await app.inject({
    method: 'POST', url: '/v1/chat/completions',
    headers: key ? { authorization: `Bearer ${key}` } : {}, payload,
  });
}

afterEach(async () => {
  const active = apps.splice(0);
  await Promise.all(active.map(async ({ app, directory }) => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }));
});

describe('K\'sRouter API', () => {
  it('reports healthy', async () => {
    const { app } = await testApp(async () => new Response());
    const response = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { status: 'ok' });
  });

  it('requires a valid client key and rejects admin, missing, invalid, and revoked keys', async () => {
    let calls = 0;
    const { app, clientKey } = await testApp(async () => {
      calls++;
      return Response.json({ choices: [{ message: { content: 'ok' } }] });
    });
    const payload = { model: 'demo-model', messages: [] };
    assert.equal((await chat(app, null, payload)).statusCode, 401);
    assert.equal((await chat(app, 'invalid-key', payload)).statusCode, 401);
    assert.equal((await chat(app, adminKey, payload)).statusCode, 401, 'admin keys cannot authenticate chat requests');
    assert.equal(calls, 0);
    assert.equal((await chat(app, clientKey, payload)).statusCode, 200);
    assert.equal(calls, 1);

    const secondKeyResponse = await app.inject({
      method: 'POST', url: '/admin/client-keys', headers: adminHeaders(), payload: { name: 'second client' },
    });
    const secondClientKey = secondKeyResponse.json().key as string;
    assert.equal(secondKeyResponse.statusCode, 201);
    assert.equal((await chat(app, secondClientKey, payload)).statusCode, 200);
    assert.equal(calls, 2);

    const clientKeys = (await app.inject({ method: 'GET', url: '/admin/client-keys', headers: adminHeaders() })).json().clientKeys;
    const keyId = clientKeys.find((item: { name: string }) => item.name === 'test client').id;
    const revoked = await app.inject({ method: 'DELETE', url: `/admin/client-keys/${keyId}`, headers: adminHeaders() });
    assert.equal(revoked.statusCode, 204);
    assert.equal((await chat(app, clientKey, payload)).statusCode, 401);
    assert.equal((await chat(app, secondClientKey, payload)).statusCode, 200, 'revoking one key must not revoke other keys');
  });

  it('forwards non-streaming OpenAI-compatible requests and responses with client auth', async () => {
    let receivedUrl = '';
    let receivedHeaders: HeadersInit | undefined;
    let receivedBody = '';
    const payload = { model: 'demo-model', messages: [{ role: 'user', content: 'Hi' }] };
    const { app, clientKey } = await testApp(async (input, init) => {
      receivedUrl = String(input);
      receivedHeaders = init?.headers;
      receivedBody = String(init?.body);
      return Response.json({ id: 'chatcmpl-test', choices: [{ message: { role: 'assistant', content: 'Hello' } }] });
    });

    const response = await chat(app, clientKey, payload);
    assert.equal(response.statusCode, 200);
    assert.equal(receivedUrl, 'https://provider.test/v1/chat/completions');
    assert.equal(new Headers(receivedHeaders).get('authorization'), 'Bearer test-provider-secret');
    assert.deepEqual(JSON.parse(receivedBody), payload);
    assert.equal(response.json().choices[0].message.content, 'Hello');
  });

  it('routes each configured model to its provider URL and key', async () => {
    const received: Array<{ url: string; authorization: string | null }> = [];
    const { app, clientKey } = await testApp(async (input, init) => {
      received.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization') });
      return Response.json({ choices: [{ message: { content: 'ok' } }] });
    }, { providers: [
      { name: 'openai', baseUrl: 'https://openai.test/v1', apiKey: 'openai-secret', models: ['gpt-test'] },
      { name: 'groq', baseUrl: 'https://groq.test/openai/v1/', apiKey: 'groq-secret', models: ['llama-test'] },
    ] });

    for (const model of ['gpt-test', 'llama-test']) {
      const response = await chat(app, clientKey, { model, messages: [] });
      assert.equal(response.statusCode, 200);
    }
    assert.deepEqual(received, [
      { url: 'https://openai.test/v1/chat/completions', authorization: 'Bearer openai-secret' },
      { url: 'https://groq.test/openai/v1/chat/completions', authorization: 'Bearer groq-secret' },
    ]);
  });

  it('returns model_not_found when no provider owns the requested model', async () => {
    const { app, clientKey } = await testApp(async () => { throw new Error('must not call provider'); });
    const response = await chat(app, clientKey, { model: 'unknown-model', messages: [] });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error.type, 'model_not_found');
  });

  it('preserves SSE streaming behavior for authenticated clients', async () => {
    const eventStream = 'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n' + 'data: [DONE]\n\n';
    const { app, clientKey } = await testApp(async (_input, init) => {
      assert.equal(new Headers(init?.headers).get('accept'), 'text/event-stream');
      return new Response(eventStream, { headers: { 'content-type': 'text/event-stream' } });
    });
    const response = await chat(app, clientKey, { model: 'demo-model', messages: [], stream: true });
    assert.equal(response.statusCode, 200);
    assert.match(response.headers['content-type'] ?? '', /text\/event-stream/);
    assert.equal(response.body, eventStream);
  });

  it('rejects malformed authenticated request bodies', async () => {
    const { app, clientKey } = await testApp(async () => { throw new Error('must not call provider'); });
    const response = await chat(app, clientKey, { model: 4 });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.type, 'invalid_request_error');
  });

  it('returns sanitized upstream errors', async () => {
    const { app, clientKey } = await testApp(async () => new Response('provider unavailable', { status: 503 }));
    const response = await chat(app, clientKey, { model: 'demo-model', messages: [] });
    assert.equal(response.statusCode, 502);
    assert.equal(response.json().error.message, 'The upstream provider returned HTTP 503.');
  });

  it('requires admin authentication separately from client authentication', async () => {
    const { app, clientKey } = await testApp(async () => Response.json({}));
    for (const url of ['/admin/overview', '/admin/providers', '/admin/models', '/admin/requests', '/admin/settings', '/admin/client-keys']) {
      assert.equal((await app.inject({ method: 'GET', url })).statusCode, 401, `${url} must require authentication`);
      assert.equal((await app.inject({ method: 'GET', url, headers: adminHeaders(clientKey) })).statusCode, 401, 'client keys cannot authenticate admin requests');
    }
    const mutation = await app.inject({ method: 'POST', url: '/admin/client-keys', payload: { name: 'nope' } });
    assert.equal(mutation.statusCode, 401, 'client key management must require admin authentication');
    const response = await app.inject({ method: 'GET', url: '/admin/overview', headers: adminHeaders() });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().clientKeyCount, 1);
  });

  it('serves the dashboard shell while keeping admin data protected', async () => {
    const { app } = await testApp(async () => Response.json({}), { providers: [], serveDashboard: true });
    assert.equal((await app.inject({ method: 'GET', url: '/dashboard' })).statusCode, 302);
    const dashboard = await app.inject({ method: 'GET', url: '/dashboard/' });
    assert.equal(dashboard.statusCode, 200);
    assert.match(dashboard.body, /K'sRouter/);
    assert.equal((await app.inject({ method: 'GET', url: '/admin/providers' })).statusCode, 401);
  });

  it('generates client keys once, lists only masked identifiers, and revokes keys', async () => {
    const { app, testDirectory } = await testApp(async () => Response.json({}));
    const created = await app.inject({
      method: 'POST', url: '/admin/client-keys', headers: adminHeaders(), payload: { name: 'laptop' },
    });
    assert.equal(created.statusCode, 201);
    const { key, clientKey } = created.json();
    assert.match(key, /^ksr_live_[A-Za-z0-9_-]{43}$/);
    assert.equal(clientKey.name, 'laptop');
    assert.match(clientKey.identifier, /^ksr_live_.+…[A-Za-z0-9_-]{4}$/);
    assert.equal(JSON.stringify(clientKey).includes(key), false);

    const listed = await app.inject({ method: 'GET', url: '/admin/client-keys', headers: adminHeaders() });
    assert.equal(JSON.stringify(listed.json()).includes(key), false);
    assert.equal(JSON.stringify(listed.json()).includes('hash'), false);
    const file = await readFile(join(testDirectory, 'keys.json'), 'utf8');
    assert.equal(file.includes(key), false);
    assert.equal(file.includes('laptop'), true);
    assert.equal((await stat(join(testDirectory, 'keys.json'))).mode & 0o777, 0o600);
    assert.equal((await stat(testDirectory)).mode & 0o777, 0o700);

    const revoked = await app.inject({ method: 'DELETE', url: `/admin/client-keys/${clientKey.id}`, headers: adminHeaders() });
    assert.equal(revoked.statusCode, 204);
    const revokedList = await app.inject({ method: 'GET', url: '/admin/client-keys', headers: adminHeaders() });
    assert.ok(revokedList.json().clientKeys.find((item: { id: string; revokedAt?: string }) => item.id === clientKey.id)?.revokedAt);
  });

  it('persists client key hashes across app restarts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ksrouter-restart-test-'));
    const file = join(directory, 'keys.json');
    const first = await testApp(async () => Response.json({ choices: [{ message: { content: 'ok' } }] }), { clientKeyStorePath: file });
    const key = first.clientKey;
    const replacement = createApp({
      adminApiKey: adminKey,
      providers: [{ name: 'default', baseUrl: 'https://provider.test/v1', apiKey: 'test-provider-secret', models: ['demo-model'] }],
      serveDashboard: false,
      clientKeyStorePath: file,
      fetchImpl: async () => Response.json({ choices: [{ message: { content: 'still works' } }] }),
    });
    apps.push({ app: replacement, directory });
    assert.equal((await chat(replacement, key, { model: 'demo-model', messages: [] })).statusCode, 200);
  });

  it('keeps request logs bounded and free of client keys and message contents', async () => {
    const { app, clientKey } = await testApp(async () => Response.json({ choices: [{ message: { content: 'hidden response' } }] }), { maxRequestLogs: 1 });
    await chat(app, clientKey, { model: 'demo-model', messages: [{ role: 'user', content: 'private prompt text' }] });
    await chat(app, clientKey, { model: 'unrouted-model', messages: [] });
    const logs = await app.inject({ method: 'GET', url: '/admin/requests', headers: adminHeaders() });
    const serialized = JSON.stringify(logs.json());
    assert.equal(logs.json().requests.length, 1);
    assert.equal(logs.json().requests[0].provider, '—');
    assert.equal(logs.json().requests[0].model, 'unrouted-model');
    assert.equal(serialized.includes(clientKey), false);
    assert.equal(serialized.includes('private prompt text'), false);
    assert.equal(serialized.includes('hidden response'), false);
  });
});
