# K'sRouter

A small OpenAI-compatible gateway built with TypeScript, Node.js, and Fastify. It currently forwards chat completions to one configurable OpenAI-compatible provider.

## Setup

```sh
npm install
cp .env.example .env
```

Set `UPSTREAM_BASE_URL` to the provider's API base (for example `https://api.openai.com/v1`) and `UPSTREAM_API_KEY` to its secret key. Then start the server:

```sh
npm run dev
```

The server listens on `0.0.0.0:3000` by default. Set `HOST` or `PORT` to change that. `GET /health` checks the server; `POST /v1/chat/completions` accepts OpenAI-compatible requests, including `stream: true` SSE requests. The gateway does not require its own API key in this first version.

```sh
curl http://localhost:3000/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"your-model","messages":[{"role":"user","content":"Hi"}]}'
```

Run checks with `npm test` and `npm run build`.
