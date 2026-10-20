# K'sRouter

A small OpenAI-compatible gateway built with TypeScript, Node.js, and Fastify. It routes chat completions to configured OpenAI-compatible providers by model name.

## Setup

```sh
npm install
cp .env.example .env
```

Set `PROVIDER_IDS` to a comma-separated list of provider ids. For each id, configure `PROVIDER_<ID>_BASE_URL`, `PROVIDER_<ID>_API_KEY`, and `PROVIDER_<ID>_MODELS` (comma-separated model names). For example, the template configures OpenAI and Groq. A model can belong to only one provider. Then start the server:

```sh
npm run dev
```

The server listens on `0.0.0.0:3000` by default. Set `HOST` or `PORT` to change that. `GET /health` checks the server; `POST /v1/chat/completions` accepts OpenAI-compatible requests, including `stream: true` SSE requests. If no provider is configured for a requested model, the gateway returns `404 model_not_found`. The gateway does not require its own API key in this first version.

```sh
curl http://localhost:3000/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"your-model","messages":[{"role":"user","content":"Hi"}]}'
```

Run checks with `npm test` and `npm run build`.
