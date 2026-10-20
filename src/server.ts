import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';

export interface ProviderConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
}

export interface RequestLog {
  id: string;
  timestamp: string;
  status: 'success' | 'error';
  provider: string;
  model: string;
  latencyMs: number;
  httpStatus: number;
}

export interface RouterConfig {
  providers: ProviderConfig[];
  adminApiKey: string;
  host?: string;
  port?: number;
  maxRequestLogs?: number;
  fetchImpl?: typeof fetch;
  serveDashboard?: boolean;
}

interface ChatCompletionBody {
  model?: unknown;
  messages?: unknown;
  stream?: unknown;
  [key: string]: unknown;
}

interface ProviderUpdateBody {
  baseUrl?: unknown;
  apiKey?: unknown;
  models?: unknown;
}

const DEFAULT_LOG_LIMIT = 100;

function errorResponse(message: string, type = 'invalid_request_error') {
  return { error: { message, type } };
}

function safeProvider(provider: ProviderConfig) {
  return {
    name: provider.name,
    baseUrl: provider.baseUrl,
    models: [...provider.models],
    hasApiKey: Boolean(provider.apiKey),
  };
}

function readProviderUpdate(body: ProviderUpdateBody, current?: ProviderConfig): ProviderConfig | null {
  if (typeof body.baseUrl !== 'string' || !Array.isArray(body.models)) return null;
  let url: URL;
  try {
    url = new URL(body.baseUrl);
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null;

  const models = body.models.map((model) => typeof model === 'string' ? model.trim() : '').filter(Boolean);
  const apiKey = typeof body.apiKey === 'string' && body.apiKey.trim()
    ? body.apiKey.trim()
    : current?.apiKey;
  if (models.length === 0 || !apiKey) return null;
  if (new Set(models).size !== models.length) return null;

  return { name: current?.name ?? '', baseUrl: body.baseUrl.trim().replace(/\/+$/, ''), apiKey, models };
}

export function createApp(config: RouterConfig): FastifyInstance {
  if (!config.adminApiKey) throw new Error('ADMIN_API_KEY is required.');

  const providers = new Map<string, ProviderConfig>();
  const configuredModels = new Set<string>();
  for (const provider of config.providers) {
    if (providers.has(provider.name)) throw new Error(`Provider "${provider.name}" is configured more than once.`);
    for (const model of provider.models) {
      if (configuredModels.has(model)) throw new Error(`Model "${model}" is configured for more than one provider.`);
      configuredModels.add(model);
    }
    providers.set(provider.name, { ...provider, models: [...provider.models] });
  }
  const requestLogs: RequestLog[] = [];
  const logLimit = Math.max(1, config.maxRequestLogs ?? DEFAULT_LOG_LIMIT);
  const startedAt = Date.now();
  const fetchImpl = config.fetchImpl ?? fetch;
  const adminKeyHash = createHash('sha256').update(config.adminApiKey).digest();
  const app = Fastify({ logger: false });

  const models = () => [...providers.values()].flatMap((provider) =>
    provider.models.map((model) => ({ model, provider: provider.name })),
  );
  const recordRequest = (entry: Omit<RequestLog, 'id' | 'timestamp'>) => {
    requestLogs.push({
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      ...entry,
    });
    if (requestLogs.length > logLimit) requestLogs.splice(0, requestLogs.length - logLimit);
  };
  const findProviderForModel = (model: string) => {
    for (const provider of providers.values()) {
      if (provider.models.includes(model)) return provider;
    }
    return undefined;
  };

  app.get('/health', async () => ({ status: 'ok' }));

  app.post<{ Body: ChatCompletionBody }>('/v1/chat/completions', async (request, reply) => {
    const started = Date.now();
    const body = request.body;
    if (!body || typeof body !== 'object' || typeof body.model !== 'string' || !Array.isArray(body.messages)) {
      return reply.code(400).send(errorResponse('Expected a model string and messages array.'));
    }
    if (body.stream !== undefined && typeof body.stream !== 'boolean') {
      return reply.code(400).send(errorResponse('The stream field must be a boolean.'));
    }
    const provider = findProviderForModel(body.model);
    if (!provider) {
      recordRequest({ status: 'error', provider: '—', model: body.model, latencyMs: Date.now() - started, httpStatus: 404 });
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
    } catch {
      if (abortController.signal.aborted) return reply;
      const latencyMs = Date.now() - started;
      recordRequest({ status: 'error', provider: provider.name, model: body.model, latencyMs, httpStatus: 502 });
      return reply.code(502).send(errorResponse('The upstream provider could not be reached.', 'upstream_error'));
    }

    if (!upstream.ok) {
      const latencyMs = Date.now() - started;
      recordRequest({ status: 'error', provider: provider.name, model: body.model, latencyMs, httpStatus: 502 });
      return reply.code(502).send(errorResponse(`The upstream provider returned HTTP ${upstream.status}.`, 'upstream_error'));
    }

    if (body.stream !== true) {
      const contentType = upstream.headers.get('content-type');
      if (contentType) reply.header('content-type', contentType);
      const responseBody = await upstream.text();
      recordRequest({ status: 'success', provider: provider.name, model: body.model, latencyMs: Date.now() - started, httpStatus: upstream.status });
      return reply.code(upstream.status).send(responseBody);
    }

    if (!upstream.body) {
      recordRequest({ status: 'error', provider: provider.name, model: body.model, latencyMs: Date.now() - started, httpStatus: 502 });
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
    let streamFailed = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!reply.raw.write(value)) await new Promise<void>((resolveDrain) => reply.raw.once('drain', resolveDrain));
      }
    } catch {
      streamFailed = true;
    } finally {
      reader.releaseLock();
      reply.raw.end();
      recordRequest({
        status: streamFailed ? 'error' : 'success',
        provider: provider.name,
        model: body.model,
        latencyMs: Date.now() - started,
        httpStatus: streamFailed ? 502 : upstream.status,
      });
    }
    return reply;
  });

  app.register(async (admin) => {
    admin.addHook('preHandler', async (request, reply) => {
      reply.header('cache-control', 'no-store');
      reply.header('pragma', 'no-cache');
      const authorization = request.headers.authorization ?? '';
      const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
      const suppliedHash = createHash('sha256').update(token).digest();
      if (!timingSafeEqual(suppliedHash, adminKeyHash)) {
        return reply.code(401).send(errorResponse('Admin authentication required.', 'authentication_error'));
      }
    });

    admin.get('/overview', async () => ({
      status: 'ok',
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      providerCount: providers.size,
      modelCount: models().length,
      requestCount: requestLogs.length,
      requestLogLimit: logLimit,
    }));

    admin.get('/providers', async () => ({ providers: [...providers.values()].map(safeProvider) }));

    admin.put<{ Params: { id: string }; Body: ProviderUpdateBody }>('/providers/:id', async (request, reply) => {
      const id = request.params.id;
      if (!/^[a-zA-Z0-9_-]+$/.test(id)) return reply.code(400).send(errorResponse('Invalid provider id.'));
      const current = providers.get(id);
      const updated = readProviderUpdate(request.body ?? {}, current);
      if (!updated) return reply.code(400).send(errorResponse('Provide a valid HTTPS base URL, API key, and at least one model.'));
      for (const [otherId, other] of providers) {
        if (otherId !== id && updated.models.some((model) => other.models.includes(model))) {
          return reply.code(409).send(errorResponse('Each model can be assigned to only one provider.'));
        }
      }
      updated.name = id;
      providers.set(id, updated);
      return { provider: safeProvider(updated) };
    });

    admin.delete<{ Params: { id: string } }>('/providers/:id', async (request, reply) => {
      if (!providers.delete(request.params.id)) return reply.code(404).send(errorResponse('Provider not found.', 'not_found'));
      return reply.code(204).send();
    });

    admin.get('/models', async () => ({ models: models() }));
    admin.get('/requests', async () => ({ requests: [...requestLogs].reverse() }));
    admin.get('/settings', async () => ({
      host: config.host ?? '127.0.0.1',
      port: config.port ?? 3000,
      adminAuthentication: 'enabled',
      providerSecrets: 'server-only',
      requestLogLimit: logLimit,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    }));
  }, { prefix: '/admin' });

  if (config.serveDashboard !== false) {
    app.get('/dashboard', async (_request, reply) => reply.redirect('/dashboard/'));
    app.register(fastifyStatic, {
      root: resolve(process.cwd(), 'dist/dashboard'),
      prefix: '/dashboard/',
      decorateReply: false,
    });
  }

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
    const modelList = requiredEnv(`${prefix}_MODELS`).split(',').map((model) => model.trim()).filter(Boolean);
    if (modelList.length === 0) throw new Error(`${prefix}_MODELS must contain at least one model.`);
    const baseUrl = requiredEnv(`${prefix}_BASE_URL`);
    let parsedBaseUrl: URL;
    try {
      parsedBaseUrl = new URL(baseUrl);
    } catch {
      throw new Error(`${prefix}_BASE_URL must be a valid URL.`);
    }
    if (parsedBaseUrl.username || parsedBaseUrl.password || parsedBaseUrl.search || parsedBaseUrl.hash) {
      throw new Error(`${prefix}_BASE_URL must not contain credentials, query parameters, or fragments.`);
    }
    return {
      name: id,
      baseUrl,
      apiKey: requiredEnv(`${prefix}_API_KEY`),
      models: modelList,
    };
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? '127.0.0.1';
  const app = createApp({
    providers: providersFromEnv(),
    adminApiKey: requiredEnv('ADMIN_API_KEY'),
    host,
    port,
  });
  await app.listen({ port, host });
}
