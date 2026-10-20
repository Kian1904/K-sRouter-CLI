import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { createApp } from '../src/server.js';

const apps: Array<ReturnType<typeof createApp>> = [];

function appWithFetch(fetchImpl: typeof fetch) {
  const app = createApp({ baseUrl: 'https://provider.test/v1/', apiKey: 'test-secret', fetchImpl });
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
    assert.equal(response.json().error.message, 'provider unavailable');
  });
});
