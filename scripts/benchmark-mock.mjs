import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';

const responseKb = Number(process.env.RESPONSE_KB ?? 8);
const streamChunks = Number(process.env.STREAM_CHUNKS ?? 8);
const padding = 'x'.repeat(responseKb * 1024);
let acceptedConnections = 0;
let totalRequests = 0;
let abortedResponses = 0;

const server = createServer(async (request, response) => {
  totalRequests++;
  let raw = '';
  for await (const chunk of request) raw += chunk;
  let body = {};
  try { body = JSON.parse(raw); } catch { /* test harness sends JSON */ }

  response.on('close', () => {
    if (!response.writableEnded) abortedResponses++;
  });
  response.setHeader('content-type', body.stream ? 'text/event-stream; charset=utf-8' : 'application/json');
  response.writeHead(200);
  if (!body.stream) {
    response.end(JSON.stringify({ id: `mock-${body.user ?? 'direct'}`, choices: [{ message: { role: 'assistant', content: padding }, finish_reason: 'stop' }] }));
    return;
  }

  response.flushHeaders();
  if (body.user === 'disconnect-probe') {
    response.write('data: {"choices":[{"delta":{"content":"first"}}]}\n\n');
    const timer = setInterval(() => response.write('data: {"choices":[{"delta":{"content":"next"}}]}\n\n'), 20);
    response.on('close', () => clearInterval(timer));
    return;
  }
  const content = padding.slice(0, Math.ceil(padding.length / streamChunks));
  for (let index = 0; index < streamChunks; index++) {
    if (response.destroyed) return;
    response.write(`data: {"choices":[{"delta":{"content":"${content}"}}]}\n\n`);
    await new Promise((resolve) => setImmediate(resolve));
  }
  response.end('data: [DONE]\n\n');
});
server.on('connection', () => { acceptedConnections++; });

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
process.send?.({ type: 'ready', pid: process.pid, baseUrl: `http://127.0.0.1:${server.address().port}` });

process.on('message', (message) => {
  if (message?.type === 'snapshot') process.send?.({ type: 'result', acceptedConnections, totalRequests, abortedResponses });
});
process.on('SIGTERM', async () => {
  await new Promise((resolve) => server.close(resolve));
  process.exit(0);
});
