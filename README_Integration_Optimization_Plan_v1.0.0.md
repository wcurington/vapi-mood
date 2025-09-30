# Integration & Optimization Plan — v1.0.0

This document maps the rollout of the merged foundation, server mounting, and presentation updates.

## 1) File Consolidation & Optimization
- **Code refinement:** De‑duplicate helpers, remove dead code, and enforce single‑source configuration through environment variables.
- **Asset compression:** Serve `/media` with HTTP compression at the proxy (Caddy) and app level; store optimized PNG/JPEG/WebP only.
- **Dependency hygiene:** Keep runtime minimal (express, helmet, compression, morgan, rate‑limit, cors).

## 2) Mounting in `server_v2.5.1.js`
- **Routes:**
  - `GET /health` → liveness
  - `POST /api/ai/query` → Alex bridge (injects constitutional guardrails; model call pluggable)
  - `POST /api/ai/call-events` → call outcome logging
  - `POST /api/knowledge/reload` → hot‑reload CSV knowledgebase
  - `GET /media/*` → static assets (audio TTS, etc.)
- **Middleware:** helmet, compression, JSON body‑parser, CORS allowlist, rate‑limiter, request‑id, morgan logs.
- **Knowledgebase preload:** On boot, parse `PRODUCT_KNOWLEDGEBASE(1).csv` and build a spoken‑name → SKU map in memory.

## 3) Alex Connection (API Contract)
- **Request:** `{ text: string, context?: object, customer?: object }`
- **Response:** `{ ok: boolean, reply: string, guardrails: string[], contextEcho?: object }`
- **Guardrails injected server‑side** to enforce constitutional rules (no money‑back guarantee; value window; step‑down sequence; closing script).

## 4) Sales Presentation Development
- **Protected:** Core Rules, Introduction, Qualifying Timeline remain exactly as authored.
- **Additions:** Features/benefits, anonymized use‑cases, visuals (infographics/charts/icons), and a testimonial template.
- **Consistency:** All slides reaffirm “no shipping, no taxes,” step‑down offers, and forbidden language rules.

## 5) Merged File Deployment
- Place **`Alex Foundation (Merged) — v1.0.0`** in both root directories (production & staging) as `alex_foundation_merged_v1.0.0.md`.
- Ensure `server_v2.5.1.js` reads guardrails from foundation (optional upgrade) or maintain as inline constants (current build).

## 6) Commands (Docker/Caddy quick path)
```bash
# Build
docker build -t healthamerica/app:2.5.1 .

# Run (port 8880 preserved for Caddy)
docker run -d --name ha-app --env PORT=8880 \
  -v $PWD/media:/app/media \
  -v $PWD/logs:/app/logs \
  -p 8880:8880 healthamerica/app:2.5.1

# Smoke tests
curl -s http://localhost:8880/health | jq
curl -s -X POST http://localhost:8880/api/knowledge/reload | jq
curl -s -X POST http://localhost:8880/api/ai/query -H "Content-Type: application/json" \
  -d '{"text":"intro and first question","context":{"callId":"demo"},"customer":{"firstName":"Pat"}}' | jq
```

## 7) Next Steps
- Wire the actual LLM provider in `alex.query()` and pass foundation + knowledge to the prompt.
- Add auth middleware for write endpoints (`/api/ai/*`, `/api/knowledge/reload`).
- Extend `/api/ai/call-events` to write to Google Sheets / PostgreSQL per your data pipeline.