import { createApp } from '../dist/src/server.js';

const app = createApp({
  adminApiKey: 'benchmark-admin-secret',
  providers: [{ name: 'mock', baseUrl: `${process.env.MOCK_BASE_URL}/v1`, apiKey: 'mock-only', models: ['bench-model'] }],
  clientKeyStorePath: process.env.CLIENT_KEY_STORE_PATH,
  host: '127.0.0.1', port: 0, maxRequestLogs: 100,
});
const memoryFields = ['rss', 'heapUsed', 'heapTotal', 'external', 'arrayBuffers'];
const readMemory = () => {
  const memory = process.memoryUsage();
  return Object.fromEntries(memoryFields.map((field) => [field, memory[field]]));
};
let peak = readMemory();
let acceptedConnections = 0;
let sampleTimer;
let timelineTimer;
const sample = () => {
  const memory = readMemory();
  for (const field of memoryFields) peak[field] = Math.max(peak[field], memory[field]);
};

await app.ready();
const created = await app.inject({ method: 'POST', url: '/admin/client-keys', headers: { authorization: 'Bearer benchmark-admin-secret' }, payload: { name: 'benchmark' } });
if (created.statusCode !== 201) throw new Error(`Could not provision benchmark key: ${created.statusCode}`);
await app.listen({ host: '127.0.0.1', port: 0 });
app.server.on('connection', () => { acceptedConnections++; });
sampleTimer = setInterval(sample, 20);
timelineTimer = setInterval(() => {
  process.send?.({ type: 'memory-sample', sample: { at: Date.now(), ...readMemory() } });
}, 1000);
process.send?.({ type: 'ready', pid: process.pid, baseUrl: `http://127.0.0.1:${app.server.address().port}`, clientKey: created.json().key });

process.on('message', async (message) => {
  if (message?.type === 'memory') {
    if (message.action === 'reset') {
      global.gc?.();
      const current = readMemory();
      peak = { ...current };
      process.send?.({ type: 'result', current, peak: { ...peak }, acceptedConnections });
    } else {
      sample();
      global.gc?.();
      const current = readMemory();
      process.send?.({ type: 'result', current, peak: { ...peak }, acceptedConnections });
    }
  }
});

process.on('SIGTERM', async () => {
  clearInterval(sampleTimer);
  clearInterval(timelineTimer);
  await app.close();
  process.exit(0);
});
