import Fastify, { type FastifyInstance } from 'fastify';

export interface ProviderConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
}

export interface RouterConfig {
  providers: ProviderConfig[];
  fetchImpl?: typeof fetch;
}

interface ChatCompletionBody {
  model?: unknown;
  messages?: unknown;
  stream?: unknown;
  [key: string]: unknown;
}

function errorResponse(message: string, type = 'invalid_request_error') {
  return { error: { message, type } };
}

export function createApp(config: RouterConfig): FastifyInstance {
  const modelRoutes = new Map<string, ProviderConfig>();
  for (const provider of config.providers) {
    for (const model of provider.models) {
      if (modelRoutes.has(model)) throw new Error(`Model "${model}" is configured for more than one provider.`);
      modelRoutes.set(model, provider);
    }
  }
  const fetchImpl = config.fetchImpl ?? fetch;
  const app = Fastify({ logger: false });

  app.get('/health', async () => ({ status: 'ok' }));

  app.post<{ Body: ChatCompletionBody }>('/v1/chat/completions', async (request, reply) => {
    const body = request.body;
    if (!body || typeof body !== 'object' || typeof body.model !== 'string' || !Array.isArray(body.messages)) {
      return reply.code(400).send(errorResponse('Expected a model string and messages array.'));
    }
    if (body.stream !== undefined && typeof body.stream !== 'boolean') {
      return reply.code(400).send(errorResponse('The stream field must be a boolean.'));
    }
    const provider = modelRoutes.get(body.model);
    if (!provider) {
      return reply.code(404).send(errorResponse(`No provider is configured for model "${body.model}".`, 'model_not_found'));
    }

    const abortController = new AbortController();
    const abortUpstream = () => {
      if (!reply.raw.writableEnded) abortController.abort();
    };
    request.raw.once('aborted', abortUpstream);
    reply.raw.once('close', abortUpstream);

    let upstream: Response;
    try {
      upstream = await fetchImpl(`${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${provider.apiKey}`,
          'content-type': 'application/json',
          accept: body.stream === true ? 'text/event-stream' : 'application/json',
        },
        body: JSON.stringify(body),
        signal: abortController.signal,
      });
    } catch (error) {
      if (abortController.signal.aborted) return reply;
      request.log.error({ err: error }, 'Upstream request failed');
      return reply.code(502).send(errorResponse('The upstream provider could not be reached.', 'upstream_error'));
    }

    if (!upstream.ok) {
      const message = await upstream.text().catch(() => 'The upstream provider returned an error.');
      return reply.code(502).send(errorResponse(message, 'upstream_error'));
    }

    if (body.stream !== true) {
      const contentType = upstream.headers.get('content-type');
      if (contentType) reply.header('content-type', contentType);
      const responseBody = await upstream.text();
      return reply.code(upstream.status).send(responseBody);
    }

    if (!upstream.body) {
      return reply.code(502).send(errorResponse('The upstream provider returned an empty stream.', 'upstream_error'));
    }

    reply.hijack();
    reply.raw.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') ?? 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const reader = upstream.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!reply.raw.write(value)) {
          await new Promise<void>((resolve) => reply.raw.once('drain', resolve));
        }
      }
    } catch (error) {
      if (!abortController.signal.aborted) request.log.error({ err: error }, 'Upstream stream failed');
    } finally {
      reader.releaseLock();
      reply.raw.end();
    }
    return reply;
  });

  return app;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function providersFromEnv(): ProviderConfig[] {
  const ids = requiredEnv('PROVIDER_IDS').split(',').map((id) => id.trim()).filter(Boolean);
  if (ids.length === 0) throw new Error('PROVIDER_IDS must contain at least one provider id.');

  return ids.map((id) => {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error(`Invalid provider id: ${id}`);
    const prefix = `PROVIDER_${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
    const models = requiredEnv(`${prefix}_MODELS`).split(',').map((model) => model.trim()).filter(Boolean);
    if (models.length === 0) throw new Error(`${prefix}_MODELS must contain at least one model.`);
    return {
      name: id,
      baseUrl: requiredEnv(`${prefix}_BASE_URL`),
      apiKey: requiredEnv(`${prefix}_API_KEY`),
      models,
    };
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = createApp({ providers: providersFromEnv() });
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? '0.0.0.0';
  await app.listen({ port, host });
}
