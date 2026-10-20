import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { createApp } from '../src/server.js';

const apps: Array<ReturnType<typeof createApp>> = [];

function appWithFetch(fetchImpl: typeof fetch) {
  const app = createApp({
    adminApiKey: 'test-admin-secret',
    serveDashboard: false,
    providers: [{
      name: 'default', baseUrl: 'https://provider.test/v1/', apiKey: 'test-secret', models: ['demo-model'],
    }],
    fetchImpl,
  });
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('K\'sRouter API', () => {
  it('reports healthy', async () => {
    const app = appWithFetch(async () => new Response());
    const response = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { status: 'ok' });
  });

  it('forwards non-streaming OpenAI-compatible requests and responses', async () => {
    let receivedUrl = '';
    let receivedHeaders: HeadersInit | undefined;
    let receivedBody = '';
    const payload = { model: 'demo-model', messages: [{ role: 'user', content: 'Hi' }] };
    const app = appWithFetch(async (input, init) => {
      receivedUrl = String(input);
      receivedHeaders = init?.headers;
      receivedBody = String(init?.body);
      return Response.json({ id: 'chatcmpl-test', choices: [{ message: { role: 'assistant', content: 'Hello' } }] });
    });

    const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload });
    assert.equal(response.statusCode, 200);
    assert.equal(receivedUrl, 'https://provider.test/v1/chat/completions');
    assert.equal(new Headers(receivedHeaders).get('authorization'), 'Bearer test-secret');
    assert.deepEqual(JSON.parse(receivedBody), payload);
    assert.equal(response.json().choices[0].message.content, 'Hello');
  });

  it('routes each configured model to its provider URL and API key', async () => {
    const received: Array<{ url: string; authorization: string | null }> = [];
    const app = createApp({
      adminApiKey: 'test-admin-secret',
      serveDashboard: false,
      providers: [
        { name: 'openai', baseUrl: 'https://openai.test/v1', apiKey: 'openai-secret', models: ['gpt-test'] },
        { name: 'groq', baseUrl: 'https://groq.test/openai/v1/', apiKey: 'groq-secret', models: ['llama-test'] },
      ],
      fetchImpl: async (input, init) => {
        received.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization') });
        return Response.json({ choices: [{ message: { role: 'assistant', content: 'ok' } }] });
      },
    });
    apps.push(app);

    for (const model of ['gpt-test', 'llama-test']) {
      const response = await app.inject({
        method: 'POST', url: '/v1/chat/completions', payload: { model, messages: [] },
      });
      assert.equal(response.statusCode, 200);
    }

    assert.deepEqual(received, [
      { url: 'https://openai.test/v1/chat/completions', authorization: 'Bearer openai-secret' },
      { url: 'https://groq.test/openai/v1/chat/completions', authorization: 'Bearer groq-secret' },
    ]);
  });

  it('returns model_not_found when no provider owns the requested model', async () => {
    const app = appWithFetch(async () => { throw new Error('must not call provider'); });
    const response = await app.inject({
      method: 'POST', url: '/v1/chat/completions', payload: { model: 'unknown-model', messages: [] },
    });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error.type, 'model_not_found');
  });

  it('streams provider event bytes through to the client', async () => {
    const eventStream = 'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n' + 'data: [DONE]\n\n';
    const app = appWithFetch(async (_input, init) => {
      assert.equal(new Headers(init?.headers).get('accept'), 'text/event-stream');
      return new Response(eventStream, { headers: { 'content-type': 'text/event-stream' } });
    });
    const response = await app.inject({
      method: 'POST', url: '/v1/chat/completions',
      payload: { model: 'demo-model', messages: [], stream: true },
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.headers['content-type'] ?? '', /text\/event-stream/);
    assert.equal(response.body, eventStream);
  });

  it('rejects malformed request bodies', async () => {
    const app = appWithFetch(async () => { throw new Error('must not call provider'); });
    const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: { model: 4 } });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.type, 'invalid_request_error');
  });

  it('returns a gateway error when the provider responds with an error', async () => {
    const app = appWithFetch(async () => new Response('provider unavailable', { status: 503 }));
    const response = await app.inject({
      method: 'POST', url: '/v1/chat/completions',
      payload: { model: 'demo-model', messages: [] },
    });
    assert.equal(response.statusCode, 502);
    assert.equal(response.json().error.message, 'The upstream provider returned HTTP 503.');
  });

  it('requires admin authentication for dashboard data APIs', async () => {
    const app = appWithFetch(async () => Response.json({}));
    for (const url of ['/admin/overview', '/admin/providers', '/admin/models', '/admin/requests', '/admin/settings']) {
      const response = await app.inject({ method: 'GET', url });
      assert.equal(response.statusCode, 401, `${url} must require authentication`);
    }
    const mutation = await app.inject({
      method: 'PUT', url: '/admin/providers/new-provider',
      payload: { baseUrl: 'https://provider.test/v1', apiKey: 'secret', models: ['new-model'] },
    });
    assert.equal(mutation.statusCode, 401, 'provider management must require authentication');
    const response = await app.inject({
      method: 'GET', url: '/admin/overview', headers: { authorization: 'Bearer test-admin-secret' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().providerCount, 1);
  });

  it('serves the dashboard shell without serving protected admin data', async () => {
    const app = createApp({
      adminApiKey: 'test-admin-secret',
      providers: [],
      fetchImpl: async () => Response.json({}),
    });
    apps.push(app);
    const redirect = await app.inject({ method: 'GET', url: '/dashboard' });
    assert.equal(redirect.statusCode, 302);
    const dashboard = await app.inject({ method: 'GET', url: '/dashboard/' });
    assert.equal(dashboard.statusCode, 200);
    assert.match(dashboard.body, /K'sRouter/);
    const admin = await app.inject({ method: 'GET', url: '/admin/providers' });
    assert.equal(admin.statusCode, 401);
  });

  it('returns provider metadata without exposing keys and safely manages providers', async () => {
    const app = appWithFetch(async () => Response.json({}));
    const headers = { authorization: 'Bearer test-admin-secret' };
    const added = await app.inject({
      method: 'PUT', url: '/admin/providers/local', headers,
      payload: { baseUrl: 'https://local-provider.test/v1', apiKey: 'new-provider-secret', models: ['local-model'] },
    });
    assert.equal(added.statusCode, 200);
    assert.equal(JSON.stringify(added.json()).includes('new-provider-secret'), false);

    const providers = await app.inject({ method: 'GET', url: '/admin/providers', headers });
    assert.equal(providers.json().providers[1].hasApiKey, true);
    assert.equal(JSON.stringify(providers.json()).includes('test-secret'), false);
    assert.deepEqual((await app.inject({ method: 'GET', url: '/admin/models', headers })).json().models[1], {
      model: 'local-model', provider: 'local',
    });

    const conflict = await app.inject({
      method: 'PUT', url: '/admin/providers/other', headers,
      payload: { baseUrl: 'https://other.test/v1', apiKey: 'secret', models: ['local-model'] },
    });
    assert.equal(conflict.statusCode, 409);

    const removed = await app.inject({ method: 'DELETE', url: '/admin/providers/local', headers });
    assert.equal(removed.statusCode, 204);
  });

  it('keeps request logs bounded and free of keys and message contents', async () => {
    const app = createApp({
      adminApiKey: 'test-admin-secret',
      maxRequestLogs: 1,
      serveDashboard: false,
      providers: [{ name: 'default', baseUrl: 'https://provider.test/v1', apiKey: 'do-not-log-this-key', models: ['demo-model'] }],
      fetchImpl: async () => Response.json({ choices: [{ message: { content: 'hidden response' } }] }),
    });
    apps.push(app);
    await app.inject({
      method: 'POST', url: '/v1/chat/completions',
      payload: { model: 'demo-model', messages: [{ role: 'user', content: 'private prompt text' }] },
    });
    await app.inject({
      method: 'POST', url: '/v1/chat/completions', payload: { model: 'unrouted-model', messages: [] },
    });
    const logs = await app.inject({ method: 'GET', url: '/admin/requests', headers: { authorization: 'Bearer test-admin-secret' } });
    const serialized = JSON.stringify(logs.json());
    assert.equal(logs.json().requests.length, 1);
    assert.equal(logs.json().requests[0].provider, '—');
    assert.equal(logs.json().requests[0].model, 'unrouted-model');
    assert.equal(serialized.includes('do-not-log-this-key'), false);
    assert.equal(serialized.includes('private prompt text'), false);
    assert.equal(serialized.includes('hidden response'), false);
  });
});
