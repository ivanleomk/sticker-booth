# VexoHacks AI Sticker Booth

Live AI die-cut sticker booth powered by **Gemini**, a local **React + Node.js** booth app, a **Liene PixCut S1** Bluetooth RFCOMM/BLE printer & cutter driver, and an optional **Google Cloud Run** mobile QR relay so guests can generate, preview, and queue stickers from their phones.

## Architecture

- **Local Booth Server (`server.mjs`)**: Serves the built React UI (`web/dist`), calls the Gemini API locally using your `GEMINI_API_KEY` (never exposed to clients or Cloud Run), manages the persistent print queue (`output/queue-state.json`), and polls the optional Cloud Run relay.
- **Booth & Queue UI (`web/`)**: Vite + React + Tailwind frontend with live camera capture, style presets (`chibi`, `watercolor`, `realistic`), custom prompts, required guest name pills, `/queue` preview cards, and a fullscreen Mobile QR modal.
- **PixCut S1 Driver (`pixcut_driver.py`)**: Persistent macOS Classic Bluetooth RFCOMM daemon (with BLE fallback) that renders `4×7"` branded backing sheets, detects 6 die-cut contours, generates `.plt` cut paths, uploads frames in ~2s over RFCOMM, and prints & kiss-cuts automatically.
- **Mobile QR Relay (`cloud-relay/`)**: Lightweight Node.js HTTP server deployed to Cloud Run. Phones submit selfies with `?k=<BOOTH_TOKEN>`; your Mac polls `/api/worker/claim` with `WORKER_SECRET`, generates the `4×7"` preview locally, and uploads it back. Printing only starts after the guest taps **Print & Cut My Stickers** on their phone (`POST /api/submissions/:id/confirm-print`).

## Prerequisites

- **macOS** (tested on Apple Silicon) with **Node.js 20+** and **[uv](https://docs.astral.sh/uv/)** (`uvx`)
- **Liene PixCut S1** paired over Bluetooth in macOS System Settings (`Sticker Foundry.app` installed at `/Users/ileo/Applications/Sticker Foundry.app` for its PixCut protocol assets, or update `STICKER_FOUNDRY_BIN` in `pixcut_driver.py`)
- **Gemini API key** (via `GEMINI_API_KEY` env var or 1Password CLI `.env.op`)
- Optional for Mobile QR: **Google Cloud SDK (`gcloud`)** for deploying `cloud-relay/` to Cloud Run

## Local Setup & Running

1. **Build the frontend:**
   ```bash
   cd web
   npm install
   npm run build
   cd ..
   ```

2. **Configure `GEMINI_API_KEY`:**
   - Either export it directly:
     ```bash
     export GEMINI_API_KEY="your-key-here"
     ```
   - Or copy `.env.op.example` to `.env.op` and point it at your 1Password secret reference:
     ```bash
     cp .env.op.example .env.op
     ```

3. **Pre-warm Python `uvx` cache (recommended while online before an event):**
   `server.mjs` invokes `uvx --offline` so venue Wi-Fi proxies or captive portals never stall printing or QR generation. Warm the cache once while online:
   ```bash
   uvx --python 3.14 --with pillow --with numpy --with bleak --with pyobjc-core --with pyobjc-framework-IOBluetooth python -c "import PIL, numpy, bleak, IOBluetooth; print('ok')"
   uvx --python 3.14 --with qrcode python -c "import qrcode; print('ok')"
   ```

4. **Start the booth:**
   ```bash
   ./start.sh
   ```
   Open **`http://127.0.0.1:3456`** in Chrome (and **`http://127.0.0.1:3456/queue`** for the live print queue).

## Mobile QR Relay Setup (Cloud Run)

The relay uses an **outbound-only pull model** — no tunnels or open ports on your Mac, and `GEMINI_API_KEY` never leaves your laptop.

1. **Generate two random secrets:**
   - `BOOTH_TOKEN` — embedded in the QR code URL (`?k=...`) so only guests who scan the booth QR can submit.
   - `WORKER_SECRET` — shared only between Cloud Run and your local Mac (`output/relay-config.json`) to authorize `/api/worker/claim` and `/api/worker/update`.

2. **Deploy `cloud-relay/` to Cloud Run:**
   ```bash
   gcloud run deploy sticker-booth-qr \
     --project=<YOUR_GCP_PROJECT> \
     --region=us-west1 \
     --source=./cloud-relay \
     --allow-unauthenticated \
     --min-instances=1 \
     --max-instances=1 \
     --memory=512Mi \
     --set-env-vars="BOOTH_TOKEN=<YOUR_BOOTH_TOKEN>,WORKER_SECRET=<YOUR_WORKER_SECRET>"
   ```
   > Use `--min-instances=1 --max-instances=1` so the in-memory submission map and `/tmp/submissions.json` stay on a single warm instance.

3. **Connect your local booth to the relay:**
   Create `output/relay-config.json` (gitignored):
   ```json
   {
     "relayUrl": "https://sticker-booth-qr-<hash>.us-west1.run.app",
     "boothToken": "<YOUR_BOOTH_TOKEN>",
     "workerSecret": "<YOUR_WORKER_SECRET>"
   }
   ```
   Restart `./start.sh`. The booth header and `/api/mobile-qr.svg` will automatically display the live QR code.

## Customizing Branding

- **`pixcut_driver.py`**: Update `_draw_sheet_branding` / `_draw_branding_pill`, `yc-sheet-bg.png`, and `vexo-mark.png` to change the `4×7"` physical sheet layout.
- **`server.mjs`**: Edit `buildStickerPrompt()` and `STYLE_PROMPTS` to customize badge themes or poses.
- **`web/src/App.tsx`** & **`cloud-relay/public/index.html`**: Update event titles and logos (remember to run `npm run build` in `web/` and redeploy `cloud-relay/`).

## Troubleshooting

- **Slow uploads or BLE disconnects:** Check `curl -s http://127.0.0.1:3456/api/pixcut/status`. Ensure `"transport": "rfcomm"` is active (pairs via Classic Bluetooth MAC cached in `output/printer-mac.json`). RFCOMM uploads a sheet in ~2.1s vs ~65s over BLE.
- **Clean restart without losing queued jobs:** `./start.sh` loads pending jobs from `output/queue-state.json` on startup. Send `SIGTERM` to the listening PID on port `3456` after the current active job finishes, then run `./start.sh`.
- **Agent setup guide:** See [SKILL.md](file:///Users/ileo/.gemini/antigravity/scratch/sticker-booth/.agents/skills/sticker-booth/SKILL.md) for step-by-step AI agent runbooks.
