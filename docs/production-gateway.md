# Production Gateway

Prior to this doc, there was no reverse proxy or unified gateway anywhere in
this repo — every backend service (`api`, `yjs`, `render-server`, and the
LiveKit `token-server`, which didn't even run in Docker) was reachable
directly on its own host port, and the only existing route table was
`webpack.config.js`'s `devServer.proxy` block, which is a **webpack-dev-server
feature** — it does not exist in a production build at all.

This doc covers the `gateway` service (`docker/nginx/nginx.conf`, wired up
via `docker-compose.prod.yml`) that fronts every collaboration/render/voice
WebSocket and HTTP route in production.

## Starting it

```bash
docker-compose -f docker-compose.yml -f docker-compose.prod.yml up
```

Add `docker-compose.gpu.yml` too if rendering on an NVIDIA host (all three
overlays compose freely — same pattern the GPU overlay already established):

```bash
docker-compose -f docker-compose.yml -f docker-compose.gpu.yml -f docker-compose.prod.yml up
```

## Route table

Mirrors `webpack.config.js`'s dev proxy block — keep both in sync if either
changes.

| Path | Upstream | Protocol | Notes |
|---|---|---|---|
| `/api` | `api:3001` | HTTP | Main REST API |
| `/app-ws` | `api:3001/ws` | WebSocket | Live broadcast (annotations, view/camera state) |
| `/yjs-ws` | `yjs:9001` | WebSocket | Y.js collaboration |
| `/render-ws` | `render-server:7000/ws` | WebSocket | Interactive render frame streaming |
| `/render-api` | `render-server:7000` | HTTP | Dataset listing, one-shot load/camera/frame |
| `/livekit-token` | `token-server:3002` | HTTP | LiveKit token issuance only |
| `/` | `dist/` (static) | HTTP | Frontend build, SPA fallback to `index.html` |

**Not fronted by this gateway**: the LiveKit SFU media path itself
(`__LIVEKIT_URL__`, `wss://...`). WebRTC/ICE media cannot be proxied through
a plain L7 reverse proxy — it needs its own TLS + TURN-reachable endpoint,
reachable directly by clients. This was already true of the dev proxy setup
(see the comment in `webpack.config.js`'s `devServer.proxy` block) and
remains true here; only the token-issuing HTTP route changes.

## TLS certificates

This repo ships no certificates for `gateway`. Supply your own by either:

- Mounting a real `cert.pem`/`key.pem` pair at `./certs/prod/` (the path
  `docker-compose.prod.yml`'s `gateway` service already mounts into the
  container at `/etc/nginx/certs/`), issued by your CA of choice
  (Let's Encrypt via a separate ACME client, an internal CA, etc.), **or**
- Removing the `gateway` service's TLS termination entirely and instead
  placing a managed load balancer / TLS terminator (a cloud provider's ALB,
  Cloudflare, etc.) in front of it, forwarding plain HTTP to `gateway` on
  port 80 only. If you do this, delete the `listen 443 ssl` server block
  and its `return 301 https://...` redirect in `docker/nginx/nginx.conf`.

Do **not** deploy with `docker/nginx/nginx.conf` pointed at a missing or
self-signed-for-testing certificate pair in production — WebXR (VR mode)
requires a browser-trusted certificate; the same constraint that makes
`./scripts/generate-certs.sh`'s self-signed certs dev-only for the frontend
webpack dev server applies here too.

## The `token-server` service

In dev, the LiveKit token-minting server (repo-root `token-server.js`) runs
ad hoc on the host via `npm run token-server` — never containerized, so it
had no stable network address a Docker-network gateway could reach.
`docker-compose.prod.yml` adds a `token-server` service
(`server/Dockerfile.token-server`) that builds and runs the exact same file
inside the Docker network, reachable as `token-server:3002` — the address
`docker/nginx/nginx.conf`'s `/livekit-token` route already assumes.

`server/Dockerfile.token-server`'s build context is the **repo root** (not
`server/`) because `token-server.js` itself lives at the repo root and
`require()`s files under `server/src/` directly — every dependency that
pulls in (express, cors, jsonwebtoken, jwks-rsa, livekit-server-sdk, pg,
dotenv) is already listed in the root `package.json`, so a single `npm ci`
at the root is sufficient; no separate `server/node_modules` build step is
needed for this one service.

Set real `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET`/`LIVEKIT_URL` env vars for
this service in production — the compose file's defaults
(`devkey`/`secret`) are LiveKit's built-in dev-mode defaults and will be
rejected by LiveKit Cloud or any non-dev LiveKit deployment.

## Verifying

No automated test covers this — it's infrastructure config, not application
code. Verify manually after bringing the stack up:

```bash
curl -k https://localhost/api/health          # -> API health check
curl -k https://localhost/render-api/health    # -> render server health check
curl -k -X POST https://localhost/livekit-token/token -d '{}' -H 'Content-Type: application/json'
# -> LiveKit token response (or a 401 if DEV_BYPASS_AUTH is off and no token supplied)
```

For the two WebSocket routes (`/yjs-ws`, `/render-ws`), open the frontend
through the gateway (`https://localhost/`) and confirm collaboration/render
features work end-to-end — a browser dev tools Network tab showing a `101
Switching Protocols` response on those paths confirms the WS upgrade made it
through.
