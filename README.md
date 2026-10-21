# K'sRouter

K'sRouter is an independent, self-hosted, multi-provider AI gateway built with TypeScript, Node.js, Fastify, React, Vite, and Tailwind CSS. It routes OpenAI-compatible chat completions by model name and includes a private web dashboard.

## Requirements

- Node.js 20.6 or newer
- An OpenAI-compatible provider endpoint and API key

## Configure

```sh
npm install
cp .env.example .env
```

Set `ADMIN_API_KEY` to a long random secret. For example, generate one with `openssl rand -hex 32`. This secret authenticates dashboard and admin APIs only. Set `PROVIDER_IDS` to a comma-separated list of provider IDs. For each ID, set `PROVIDER_<ID>_BASE_URL`, `PROVIDER_<ID>_API_KEY`, and `PROVIDER_<ID>_MODELS` (comma-separated exact model names). Example:

```env
PROVIDER_IDS=openai,groq
PROVIDER_OPENAI_BASE_URL=https://api.openai.com/v1
PROVIDER_OPENAI_API_KEY=your-openai-key
PROVIDER_OPENAI_MODELS=gpt-4o-mini,gpt-4.1-mini
PROVIDER_GROQ_BASE_URL=https://api.groq.com/openai/v1
PROVIDER_GROQ_API_KEY=your-groq-key
PROVIDER_GROQ_MODELS=llama-3.3-70b-versatile
```

Each model must be assigned to one provider only. Provider configuration from the dashboard is held in memory and resets on restart; environment configuration is loaded at startup.

## Run locally

For development, start the API and Vite dashboard together:

```sh
npm run dev
```

Open <http://127.0.0.1:5173/dashboard/>. Enter `ADMIN_API_KEY` to unlock it. The dashboard keeps this key in memory only; reloads require signing in again. The Fastify API listens on `127.0.0.1:3000` by default.

For a production-style run, build the dashboard and server, then serve both from Fastify:

```sh
npm run build
npm start
```

Open <http://127.0.0.1:3000/dashboard/>. The listener defaults to localhost. To access it remotely, use a private tunnel or VPN; do not expose the admin dashboard to the public internet without a trusted TLS reverse proxy and network access controls.

## API

- `GET /health` returns the gateway process status.
- `POST /v1/chat/completions` requires `Authorization: Bearer <CLIENT_API_KEY>` and accepts OpenAI-compatible JSON and `stream: true` SSE requests. The `model` value selects its configured provider. Unknown models return `404 model_not_found`.
- Dashboard APIs under `/admin/*` require `Authorization: Bearer <ADMIN_API_KEY>`.

Use the dashboard’s **Client Keys** page to generate and revoke client credentials. The raw key is shown once at creation. Copy it immediately and provide it to your application through its server-side environment, for example `KSR_CLIENT_API_KEY`; do not put it in browser code or commit it. The gateway stores only SHA-256 hashes and masked identifiers in `CLIENT_KEY_STORE_PATH` (default `.data/client-keys.json`). The directory and file are restricted to the current OS user (`0700` and `0600` on POSIX), and records persist across restarts. Keep this file private and back it up securely if needed. Client keys cannot authenticate admin endpoints, and the admin key cannot authenticate chat requests.

Example request:

```sh
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer $KSR_CLIENT_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"Hello"}]}'
```

The dashboard can list, add, edit, and remove providers; manage client keys; list model routes; view request metadata; and inspect runtime settings. Provider API keys are accepted by the server but never returned to the dashboard. Provider dashboard changes are in-memory only. Request logs retain up to 100 recent entries by default and contain only status, provider, model, timestamp, and latency—not message contents or credentials.

Run the production build and automated tests with:

```sh
npm run build
npm test
```

## Performance baseline (local mock)

The benchmark runs the mock upstream, K'sRouter, and load generator as three separate Node processes on loopback. It does not call a model provider or use API credits. For every response type and concurrency level, it first calls the mock directly, then through K'sRouter using the same request count or soak duration, payload size, and response fixture. Output is JSON with throughput, error rate, p50/p95/p99/mean latency, gateway-only RSS and heap samples, and TCP connection counts. SSE also reports time to first complete event (TTFE) separately from total time through `[DONE]`.

`gatewayAddedLatencyMs` is the difference between the gateway and direct-mock latency distributions for equivalent workloads (for example, gateway p95 minus direct p95). The runs are sequential and the percentiles are not paired request-by-request, so treat small differences as noise and repeat runs. This comparison avoids attributing mock handler time as gateway overhead, but still includes loopback, HTTP, and process scheduling differences. The direct run shares the mock process but not the gateway. Gateway memory is measured in the gateway child itself; end heap uses explicit GC. During a soak, a one-second RSS/heap time series is also returned. A post-GC end reading is useful for retained heap, while RSS can remain high because of allocator and runtime behavior.

On Linux/macOS, install dependencies and run:

```sh
npm install
npm run benchmark -- --requests 300 --warmup 20 --concurrency 1,5,10,20 --response-kb 8 --stream-chunks 8
```

Termux setup:

```sh
pkg update
pkg install nodejs-lts
cd ~/K-sRouter-CLI
npm install
npm run benchmark -- --requests 100 --warmup 10 --concurrency 1,5,10,20 --response-kb 8 --stream-chunks 8
```

Options are per-case requests, warmups per target, comma-separated concurrency levels (defaults to `1,5,10,20`), response size in KiB, SSE chunk count, and optional `--soak-seconds`. A soak duration applies to each direct and gateway run for every response type and concurrency level; e.g. `--concurrency 10 --soak-seconds 120` runs four two-minute workloads, plus warmups and the cancellation probe. On phones, run with the device plugged in, close heavy apps, and repeat at least three times at the same temperature and power mode before comparing changes. A soak's memory series can show growth during its run, but it cannot prove a leak by itself; compare repeated runs and inspect post-GC heap. The SSE probe aborts the client after its first event and verifies that the mock upstream sees its response connection close.

The benchmark is a local baseline, not a production capacity guarantee. OS scheduling, Node version, thermal throttling, socket reuse, and small sample counts affect results. Direct and gateway measurements are sequential rather than randomized or paired; keep payloads, Node version, device state, and concurrency identical when comparing revisions.
