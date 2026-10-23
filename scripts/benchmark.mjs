#!/usr/bin/env node
import { fork } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const option = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
};
const concurrencyLevels = option('concurrency', '1,5,10,20').split(',').map(Number);
const requestCount = Number(option('requests', '200'));
const warmupCount = Number(option('warmup', '20'));
const streamChunks = Number(option('stream-chunks', '8'));
const responseKb = Number(option('response-kb', '8'));
const soakSeconds = Number(option('soak-seconds', '0'));
const kindOption = option('kind', 'both');
const kinds = kindOption === 'both' ? ['non-streaming', 'sse'] : [kindOption];
if (kinds.some((kind) => !['non-streaming', 'sse'].includes(kind))) {
  throw new Error('--kind must be non-streaming, sse, or both.');
}
if ([...concurrencyLevels, requestCount, warmupCount, streamChunks, responseKb].some((n) => !Number.isInteger(n) || n < 1)
  || !Number.isFinite(soakSeconds) || soakSeconds < 0) {
  throw new Error('Use positive integer counts and a non-negative --soak-seconds value.');
}

const script = (name) => new URL(`./benchmark-${name}.mjs`, import.meta.url);
const startChild = (name, env = {}) => fork(script(name), [], {
  env: { ...process.env, ...env },
  stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
});
const waitMessage = (child, expected, timeoutMs = 10_000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${expected} from child process.`)), timeoutMs);
  const onMessage = (message) => {
    if (message?.type === 'error') {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
      reject(new Error(message.message));
      return;
    }
    if (message?.type !== expected) return;
    clearTimeout(timer);
    child.off('message', onMessage);
    child.off('exit', onExit);
    resolve(message);
  };
  const onExit = (code) => {
    clearTimeout(timer);
    child.off('message', onMessage);
    reject(new Error(`${child.spawnargs[1]} exited (${code}) before ${expected}.`));
  };
  child.on('message', onMessage);
  child.once('exit', onExit);
});
const command = (child, message, expected = 'result', timeoutMs = 120_000) => {
  const result = waitMessage(child, expected, timeoutMs);
  child.send(message);
  return result;
};
const tempDir = await mkdtemp(join(tmpdir(), 'ksrouter-perf-'));
let mock;
let gateway;
let load;
const gatewayProcesses = [];
let lastGatewayCounts;
let disconnectCheck;
try {
  mock = startChild('mock', { RESPONSE_KB: String(responseKb), STREAM_CHUNKS: String(streamChunks) });
  const mockReady = await waitMessage(mock, 'ready');
  load = startChild('load');

  const baseLoad = { requestCount, warmupCount, streamChunks, responseKb, soakSeconds };
  const workloadTimeoutMs = soakSeconds ? (soakSeconds + 180) * 1000 : 120_000;
  const cases = [];
  for (const kind of kinds) {
    // A new gateway for each response type prevents JSON state from contaminating SSE measurements.
    gateway = startChild('gateway', {
      MOCK_BASE_URL: mockReady.baseUrl,
      CLIENT_KEY_STORE_PATH: join(tempDir, `client-keys-${kind}.json`),
    });
    const gatewayReady = await waitMessage(gateway, 'ready');
    gatewayProcesses.push({ kind, pid: gatewayReady.pid });
    for (const concurrency of concurrencyLevels) {
      const common = { ...baseLoad, kind, concurrency };
      const direct = await command(load, { type: 'run', config: { ...common, targetUrl: `${mockReady.baseUrl}/v1/chat/completions` } }, 'result', workloadTimeoutMs);

      const memoryStart = await command(gateway, { type: 'memory', action: 'reset' });
      const timeline = [];
      const onMemory = (message) => { if (message?.type === 'memory-sample') timeline.push(message.sample); };
      gateway.on('message', onMemory);
      const routed = await command(load, { type: 'run', config: {
        ...common, targetUrl: `${gatewayReady.baseUrl}/v1/chat/completions`, clientKey: gatewayReady.clientKey,
      } }, 'result', workloadTimeoutMs);
      gateway.off('message', onMemory);
      const memoryImmediate = await command(gateway, { type: 'memory', action: 'snapshot' });
      await delay(1000);
      const memoryEnd = await command(gateway, { type: 'memory', action: 'snapshot' });

      cases.push({
        kind, concurrency, direct, throughGateway: routed,
        gatewayAddedLatencyMs: {
          comparison: 'gateway percentile minus direct-mock percentile for the same request count/duration, concurrency, payload and stream shape; separate runs, not per-request paired samples',
          p50: routed.latencyMs.p50 - direct.latencyMs.p50,
          p95: routed.latencyMs.p95 - direct.latencyMs.p95,
          p99: routed.latencyMs.p99 - direct.latencyMs.p99,
          mean: routed.latencyMs.mean - direct.latencyMs.mean,
        },
        gatewayMemoryBytes: {
          fields: 'rss, heapUsed, heapTotal, external, and arrayBuffers; arrayBuffers is included in external.',
          start: memoryStart.current,
          peak: memoryEnd.peak,
          immediateAfterGc: memoryImmediate.current,
          settledAfterGc: memoryEnd.current,
          growthAfterGc: Object.fromEntries(Object.keys(memoryEnd.current).map((field) => [field, memoryEnd.current[field] - memoryStart.current[field]])),
          soakSamples: timeline,
        },
      });
    }
    if (kind === 'sse') {
      const { type: _beforeType, ...beforeDisconnect } = await command(mock, { type: 'snapshot' });
      const { type: _disconnectType, ...disconnect } = await command(load, { type: 'disconnect', targetUrl: `${gatewayReady.baseUrl}/v1/chat/completions`, clientKey: gatewayReady.clientKey });
      await delay(50);
      const { type: _afterType, ...afterDisconnect } = await command(mock, { type: 'snapshot' });
      disconnectCheck = { ...disconnect, mockDisconnectCountBefore: beforeDisconnect.abortedResponses, mockDisconnectCountAfter: afterDisconnect.abortedResponses, upstreamCancelled: afterDisconnect.abortedResponses > beforeDisconnect.abortedResponses };
    }
    lastGatewayCounts = await command(gateway, { type: 'memory', action: 'snapshot' });
    gateway.kill('SIGTERM');
    await new Promise((resolve) => gateway.once('exit', resolve));
    gateway = undefined;
  }

  const { type: _countsType, ...counts } = await command(mock, { type: 'snapshot' });
  const measuredRequests = cases.reduce((sum, entry) => sum + entry.direct.completed + entry.throughGateway.completed, 0);
  console.log(JSON.stringify({
    benchmark: "K'sRouter three-process local baseline",
    generatedAt: new Date().toISOString(),
    processes: { gateways: gatewayProcesses, mockUpstreamPid: mockReady.pid, loadGeneratorPid: load.pid },
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    parameters: { concurrencyLevels, requestsPerCase: soakSeconds ? null : requestCount, soakSecondsPerCase: soakSeconds || null, warmupPerTarget: warmupCount, responseKb, streamChunks },
    measuredRequests,
    measurement: {
      directBaseline: 'Load generator calls the mock server directly with the same payload, concurrency, response size, and stream fixture as the gateway case.',
      addedLatency: 'Same-workload distribution deltas (gateway p50/p95/p99/mean minus direct baseline p50/p95/p99/mean). Runs are sequential, not paired request-by-request.',
      sse: 'TTFE is measured from fetch start until the first complete SSE event. afterFirstEventMs is the same request total duration minus TTFE; total duration runs through [DONE] and response close.',
      memory: 'RSS, heapUsed, heapTotal, external, and arrayBuffers are sampled inside the gateway child process only. End values use explicit GC when Node was started with --expose-gc. Each kind uses a fresh gateway process; direct baseline memory is not included. arrayBuffers is part of external, so do not sum them.',
    },
    connectionStats: { gatewayAcceptedTotal: lastGatewayCounts.acceptedConnections, ...counts },
    disconnectCheck,
    cases,
  }, null, 2));
} finally {
  for (const child of [load, gateway, mock]) {
    if (!child || child.exitCode !== null || child.signalCode !== null) continue;
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
  }
  await rm(tempDir, { recursive: true, force: true });
}
