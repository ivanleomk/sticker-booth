---
name: sticker-booth
description: Set up, run, customize, and troubleshoot the VexoHacks AI Sticker Booth (local Gemini sticker generator, Liene PixCut S1 RFCOMM/BLE printer & cutter daemon, React booth UI, and Cloud Run mobile QR relay). Use when deploying or operating the sticker booth, debugging PixCut S1 connectivity, updating branding, or redeploying the Cloud Run relay.
---

# Sticker Booth Operator & Setup Skill

Use this skill when setting up, operating, modifying, or troubleshooting the AI Sticker Booth repository.

## Key Files & Responsibilities

- `start.sh`: Launches `node server.mjs` (uses `GEMINI_API_KEY` from env or `op run --env-file=.env.op`).
- `server.mjs`: Local HTTP server (`http://127.0.0.1:3456`), Gemini image generation (`buildStickerPrompt`), persistent print queue (`output/queue-state.json`), and Cloud Run relay worker poller (`handleRelayGenerate` -> `preview_ready`, `handleRelayPrintConfirm` -> `printQueue`).
- `pixcut_driver.py`: Persistent Classic Bluetooth RFCOMM daemon (`Liene PixCut S1`, ~2.1s upload/sheet, `auto_off=0`, 28s keepalive) with BLE fallback, `4×7"` sheet composition (`yc-sheet-bg.png` + `vexo-mark.png`), and 6-contour `.plt` cut path generation.
- `web/`: React + Vite + Tailwind booth & `/queue` UI (`npm run build` outputs to `web/dist/`).
- `cloud-relay/`: Cloud Run service (`index.mjs` + `public/index.html`) providing the mobile QR submission page and 2-step preview-before-printing state machine (`printConfirmed` guard).

## First-Time Setup Checklist

1. **Build the UI:** `cd web && npm install && npm run build`
2. **Pre-warm `uvx --offline` caches** (required because `server.mjs` passes `--offline` to avoid venue Wi-Fi proxy hangs):
   - `uvx --python 3.14 --with pillow --with numpy --with bleak --with pyobjc-core --with pyobjc-framework-IOBluetooth python -c "import PIL, numpy, bleak, IOBluetooth"`
   - `uvx --python 3.14 --with qrcode python -c "import qrcode"`
3. **Configure Gemini API key:** Set `GEMINI_API_KEY` or create `.env.op` from `.env.op.example` for 1Password `op run`.
4. **Start the booth:** Run `./start.sh` and verify `curl -s http://127.0.0.1:3456/api/pixcut/status`.

## Cloud Run Mobile Relay Deployment

- **Security invariant:** Never embed `GEMINI_API_KEY` or `WORKER_SECRET` in `cloud-relay/public/index.html`.
- Deploy with `--min-instances=1 --max-instances=1` so the in-memory `Map` and `/tmp/submissions.json` remain consistent:
  ```bash
  gcloud run deploy sticker-booth-qr \
    --project=<PROJECT> \
    --region=us-west1 \
    --source=./cloud-relay \
    --allow-unauthenticated \
    --min-instances=1 \
    --max-instances=1 \
    --memory=512Mi
  ```
- Store `relayUrl`, `boothToken`, and `workerSecret` in `output/relay-config.json` (gitignored).

## Safe Operational Practices

- **Never kill a mid-print `server.mjs` process abruptly:** Wait for `activeJob` in `/api/queue` to finish printing before sending `SIGTERM` to the listening PID on port `3456`, then restart with `./start.sh` (`output/queue-state.json` preserves queued jobs).
- **Re-rendering cached sheets:** Delete `output/sheet-<id>.jpg` and `output/sheet-<id>.plt` for a queued job if you updated `pixcut_driver.py` sheet branding and want that queued job to re-render before printing.
