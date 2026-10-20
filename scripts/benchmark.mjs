#!/usr/bin/env node
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../dist/src/server.js';

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
}

const concurrencyLevels = option('concurrency', '1,10,25').split(',').map(Number);
const requestCount = Number(option('requests', '200'));
const warmupCount = Number(option('warmup', '20'));
const streamChunks = Number(option('stream-chunks', '8'));
const responseKb = Number(option('response-kb', '4'));
if ([...concurrencyLevels, requestCount, warmupCount, streamChunks, responseKb].some((value) => !Number.isInteger(value) || value < 1)) {
  throw new Error('Options must be positive integers.');
}
const padding = 'x'.repeat(responseKb * 1024);

const upstreamMetrics = new Map();
let upstreamDisconnects = 0;
let mockConnections = 0;
let gatewayConnections = 0;
let upstreamCloseResolve;
const upstreamClosed = new Promise((resolve) => { upstreamCloseResolve = resolve; });

const mock = createServer(async (request, response) => {
  const startedAt = performance.now();
  let raw = '';
  for await (const chunk of request) raw += chunk;
  let body = {};
  try { body = JSON.parse(raw); } catch { /* benchmark fixture only */ }
  const requestId = body.user;
  if (requestId) upstreamMetrics.set(requestId, { startedAt });

  response.on('close', () => {
    if (!response.writableEnded) {
      upstreamDisconnects++;
      if (requestId === 'disconnect-probe') upstreamCloseResolve();
    }
  });

  response.setHeader('content-type', body.stream ? 'text/event-stream; charset=utf-8' : 'application/json');
  response.setHeader('connection', 'keep-alive');
  response.writeHead(200);
  if (!body.stream) {
    const result = JSON.stringify({ id: `bench-${requestId}`, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: padding }, finish_reason: 'stop' }] });
    response.end(result, () => {
      if (requestId) upstreamMetrics.set(requestId, { ...upstreamMetrics.get(requestId), durationMs: performance.now() - startedAt });
    });
    return;
  }

  response.flushHeaders();
  if (requestId === 'disconnect-probe') {
    response.write('data: {"choices":[{"delta":{"content":"first"}}]}\n\n');
    const timer = setInterval(() => response.write('data: {"choices":[{"delta":{"content":"next"}}]}\n\n'), 20);
    response.on('close', () => clearInterval(timer));
    return;
  }

  for (let index = 0; index < streamChunks; index++) {
    if (response.destroyed) return;
    const chunkContent = padding.slice(0, Math.ceil(padding.length / streamChunks));
    response.write(`data: {"choices":[{"delta":{"content":"${chunkContent}"}}]}\n\n`);
    await new Promise((resolve) => setImmediate(resolve));
  }
  response.end('data: [DONE]\n\n', () => {
    if (requestId) upstreamMetrics.set(requestId, { ...upstreamMetrics.get(requestId), durationMs: performance.now() - startedAt });
  });
});
mock.on('connection', () => { mockConnections++; });

await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
const upstreamPort = mock.address().port;
const storeDir = await mkdtemp(join(tmpdir(), 'ksrouter-bench-'));
const app = createApp({
  adminApiKey: 'benchmark-admin-secret',
  providers: [{ name: 'mock', baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: 'mock-only', models: ['bench-model'] }],
  clientKeyStorePath: join(storeDir, 'keys.json'),
  host: '127.0.0.1', port: 0, maxRequestLogs: 100,
});
app.server.on('connection', () => { gatewayConnections++; });

let sampler;
let peakRss;
let peakHeap;
try {
  await app.ready();
  const created = await app.inject({ method: 'POST', url: '/admin/client-keys', headers: { authorization: 'Bearer benchmark-admin-secret' }, payload: { name: 'benchmark' } });
  if (created.statusCode !== 201) throw new Error(`Could not create benchmark client key (${created.statusCode}).`);
  const clientKey = created.json().key;
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('Could not read gateway listening address.');
  const gatewayUrl = `http://127.0.0.1:${address.port}/v1/chat/completions`;

  const send = async (stream, user) => {
    const started = performance.now();
    const response = await fetch(gatewayUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${clientKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'bench-model', messages: [{ role: 'user', content: 'benchmark' }], stream, user }),
    });
    if (!response.ok) throw new Error(`Gateway returned HTTP ${response.status}.`);
    for await (const _chunk of response.body) { /* discard response bytes to avoid load-generator buffering */ }
    return { latencyMs: performance.now() - started, upstreamMs: upstreamMetrics.get(user)?.durationMs };
  };

  // One warmup per request kind warms the gateway, upstream, fetch, and TCP paths.
  for (let i = 0; i < warmupCount; i++) {
    await send(false, `warm-json-${i}`);
    await send(true, `warm-sse-${i}`);
  }
  upstreamMetrics.clear();
  global.gc?.();
  const baseline = process.memoryUsage();
  peakRss = baseline.rss;
  peakHeap = baseline.heapUsed;
  sampler = setInterval(() => {
    const memory = process.memoryUsage();
    peakRss = Math.max(peakRss, memory.rss);
    peakHeap = Math.max(peakHeap, memory.heapUsed);
  }, 10);

  const results = [];
  for (const kind of ['non-streaming', 'sse']) {
    for (const concurrency of concurrencyLevels) {
      global.gc?.();
      const memoryStart = process.memoryUsage();
      let casePeakRss = memoryStart.rss;
      let casePeakHeap = memoryStart.heapUsed;
      const caseSampler = setInterval(() => {
        const memory = process.memoryUsage();
        casePeakRss = Math.max(casePeakRss, memory.rss);
        casePeakHeap = Math.max(casePeakHeap, memory.heapUsed);
      }, 10);
      let cursor = 0;
      let completed = 0;
      let failed = 0;
      const latencies = [];
      const upstreamDurations = [];
      const started = performance.now();
      const workers = Array.from({ length: Math.min(concurrency, requestCount) }, async () => {
        while (cursor < requestCount) {
          const index = cursor++;
          const id = `${kind}-${concurrency}-${index}`;
          try {
            const sample = await send(kind === 'sse', id);
            latencies.push(sample.latencyMs);
            if (typeof sample.upstreamMs === 'number') upstreamDurations.push(sample.upstreamMs);
            completed++;
          } catch {
            failed++;
          }
        }
      });
      await Promise.all(workers);
      const durationMs = performance.now() - started;
      clearInterval(caseSampler);
      global.gc?.();
      const memoryEnd = process.memoryUsage();
      const sorted = latencies.toSorted((left, right) => left - right);
      const percentile = (p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] : null;
      const averageUpstreamMs = upstreamDurations.length
        ? upstreamDurations.reduce((sum, value) => sum + value, 0) / upstreamDurations.length
        : null;
      const averageLatencyMs = sorted.length ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length : null;
      results.push({
        kind, concurrency, attempted: requestCount, completed, errors: failed,
        errorRatePercent: requestCount ? (failed / requestCount) * 100 : 0,
        throughputRps: completed / (durationMs / 1000), durationMs,
        latencyMs: { p50: percentile(0.50), p95: percentile(0.95), p99: percentile(0.99), mean: averageLatencyMs },
        mockUpstreamServiceMs: { mean: averageUpstreamMs },
        estimatedRouterAndLoopbackOverheadMs: averageLatencyMs !== null && averageUpstreamMs !== null ? averageLatencyMs - averageUpstreamMs : null,
        memoryBytes: { baselineRss: memoryStart.rss, peakRss: casePeakRss, postRunRss: memoryEnd.rss, baselineHeapUsed: memoryStart.heapUsed, peakHeapUsed: casePeakHeap, postRunHeapUsed: memoryEnd.heapUsed },
      });
    }
  }
  clearInterval(sampler);
  sampler = undefined;
  global.gc?.();
  const after = process.memoryUsage();

  // Verify the actual HTTP client disconnect reaches the mock provider as an aborted response.
  const controller = new AbortController();
  const disconnectPromise = fetch(gatewayUrl, {
    method: 'POST', signal: controller.signal,
    headers: { authorization: `Bearer ${clientKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'bench-model', messages: [], stream: true, user: 'disconnect-probe' }),
  });
  const disconnectResponse = await disconnectPromise;
  const reader = disconnectResponse.body.getReader();
  await reader.read();
  controller.abort();
  await Promise.race([upstreamClosed, delay(2000).then(() => { throw new Error('Timed out waiting for upstream cancellation after client disconnect.'); })]);
  await delay(50);

  console.log(JSON.stringify({
    benchmark: 'K\'sRouter local mock baseline',
    timestamp: new Date().toISOString(),
    runtime: { node: process.version, platform: process.platform, arch: process.arch, cpus: globalThis.navigator?.hardwareConcurrency ?? null },
    parameters: { requestCountPerCase: requestCount, warmupPerKind: warmupCount, concurrencyLevels, streamChunks, mockResponseSizeKb: responseKb, mockUpstream: 'localhost HTTP; fixed responses; no model/provider API calls' },
    connections: { gatewayAcceptedTotal: gatewayConnections, mockUpstreamAcceptedTotal: mockConnections, note: 'New TCP connections accepted after startup, including warmups; remaining requests reused keep-alive connections.' },
    measurementNotes: {
      latency: 'Client-observed gateway request duration, including both localhost HTTP legs and body consumption.',
      overhead: 'Estimate: client-observed mean minus mock upstream handler service time; includes loopback/network and gateway work.',
      memory: 'Whole benchmark process (gateway, mock upstream, and load generator), sampled every 10 ms; not gateway-only. Post-run heap/RSS are sampled after optional explicit GC.',
    },
    cases: results,
    memoryBytes: { baselineRss: baseline.rss, baselineHeapUsed: baseline.heapUsed, peakRss: peakRss, peakHeapUsed: peakHeap, postRunRss: after.rss, postRunHeapUsed: after.heapUsed, postRunExternal: after.external, rssGrowth: after.rss - baseline.rss, heapGrowth: after.heapUsed - baseline.heapUsed },
    disconnectCheck: { clientAbortedAfterFirstSseChunk: true, upstreamResponseClosed: upstreamDisconnects > 0, upstreamDisconnectCount: upstreamDisconnects },
  }, null, 2));
} finally {
  if (sampler) clearInterval(sampler);
  await app.close().catch(() => undefined);
  await new Promise((resolve) => mock.close(resolve));
  await rm(storeDir, { recursive: true, force: true });
}
