import { performance } from 'node:perf_hooks';

const percentileSummary = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] : null;
  const mean = sorted.length ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length : null;
  return { p50: at(0.50), p95: at(0.95), p99: at(0.99), mean };
};

async function readFirstSseEvent(reader, buffer = '') {
  let pending = buffer;
  while (!pending.includes('\n\n') && !pending.includes('\r\n\r\n')) {
    const { done, value } = await reader.read();
    if (done) throw new Error('SSE response ended before its first event.');
    pending += new TextDecoder().decode(value, { stream: true });
  }
  const separator = pending.includes('\r\n\r\n') ? '\r\n\r\n' : '\n\n';
  return { firstEvent: pending.slice(0, pending.indexOf(separator)), remainder: pending.slice(pending.indexOf(separator) + separator.length) };
}

async function request(targetUrl, clientKey, config, id) {
  const stream = config.kind === 'sse';
  const started = performance.now();
  const response = await fetch(targetUrl, {
    method: 'POST',
    headers: { ...(clientKey ? { authorization: `Bearer ${clientKey}` } : {}), 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'bench-model', messages: [{ role: 'user', content: 'benchmark' }], stream, user: id }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`HTTP ${response.status}`);
  }
  if (!stream) {
    for await (const _chunk of response.body) { /* discard to avoid load generator buffering */ }
    return { latencyMs: performance.now() - started };
  }

  const reader = response.body.getReader();
  const { firstEvent, remainder } = await readFirstSseEvent(reader);
  const timeToFirstEventMs = performance.now() - started;
  if (!firstEvent.startsWith('data:')) throw new Error('First SSE frame was not a data event.');
  if (remainder) { /* bytes already read after first event are consumed, not buffered further */ }
  while (!(await reader.read()).done) { /* stream through to [DONE] without retaining chunks */ }
  reader.releaseLock();
  const latencyMs = performance.now() - started;
  return { latencyMs, timeToFirstEventMs, afterFirstEventMs: latencyMs - timeToFirstEventMs };
}

async function run(config) {
  const target = config.targetUrl;
  for (let i = 0; i < config.warmupCount; i++) {
    await request(target, config.clientKey, config, `warm-${config.kind}-${i}`);
  }

  const started = performance.now();
  const endAt = config.soakSeconds ? started + config.soakSeconds * 1000 : Infinity;
  let cursor = 0;
  let completed = 0;
  let errors = 0;
  const latencies = [];
  const firstEvents = [];
  const afterFirstEvents = [];
  const workers = Array.from({ length: config.concurrency }, async () => {
    while (config.soakSeconds ? performance.now() < endAt : cursor < config.requestCount) {
      const index = cursor++;
      const id = `bench-${config.kind}-${config.concurrency}-${index}`;
      try {
        const value = await request(target, config.clientKey, config, id);
        latencies.push(value.latencyMs);
        if (value.timeToFirstEventMs !== undefined) firstEvents.push(value.timeToFirstEventMs);
        if (value.afterFirstEventMs !== undefined) afterFirstEvents.push(value.afterFirstEventMs);
        completed++;
      } catch {
        errors++;
      }
    }
  });
  await Promise.all(workers);
  const durationMs = performance.now() - started;
  return {
    attempted: completed + errors, completed, errors,
    errorRatePercent: completed + errors ? errors / (completed + errors) * 100 : 0,
    durationMs, throughputRps: completed / (durationMs / 1000),
    latencyMs: percentileSummary(latencies),
    ...(config.kind === 'sse' ? {
      timeToFirstEventMs: percentileSummary(firstEvents),
      afterFirstEventMs: percentileSummary(afterFirstEvents),
    } : {}),
  };
}

async function disconnect(config) {
  const controller = new AbortController();
  const response = await fetch(config.targetUrl, {
    method: 'POST', signal: controller.signal,
    headers: { authorization: `Bearer ${config.clientKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'bench-model', messages: [], stream: true, user: 'disconnect-probe' }),
  });
  const reader = response.body.getReader();
  await readFirstSseEvent(reader);
  controller.abort();
  await reader.cancel().catch(() => undefined);
  return { clientAbortedAfterFirstEvent: true };
}

process.on('message', async (message) => {
  try {
    const result = message.type === 'disconnect'
      ? await disconnect(message)
      : await run(message.config);
    process.send?.({ type: 'result', ...result });
  } catch (error) {
    process.send?.({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
});
