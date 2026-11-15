import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PERSIST_PATH = '/tmp/submissions.json';

const PORT = Number(process.env.PORT || 8080);
const BOOTH_TOKEN = process.env.BOOTH_TOKEN || '';
const WORKER_SECRET = process.env.WORKER_SECRET || '';
const MAX_SUBMISSIONS = 100;
const CLAIM_STALE_MS = 120_000;

const ALLOWED_STYLES = new Set(['chibi', 'watercolor', 'realistic']);
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

/** @type {Map<string, any>} */
const submissions = new Map();
/** @type {any} */
let latestQueueSnapshot = null;

async function loadPersisted() {
  try {
    const raw = await fs.readFile(PERSIST_PATH, 'utf8');
    const list = JSON.parse(raw);
    if (Array.isArray(list)) {
      for (const item of list.slice(-MAX_SUBMISSIONS)) {
        if (item?.id) submissions.set(item.id, item);
      }
    }
  } catch {
    // Ignore cold start
  }
}

let persistTimer = null;
async function savePersistedNow() {
  try {
    const list = Array.from(submissions.values()).slice(-MAX_SUBMISSIONS);
    await fs.writeFile(`${PERSIST_PATH}.tmp`, JSON.stringify(list));
    await fs.rename(`${PERSIST_PATH}.tmp`, PERSIST_PATH);
  } catch {
    // Ignore /tmp write error
  }
}

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void savePersistedNow();
  }, 250);
}

await loadPersisted();

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readJsonBody(req, maxBytes = 10 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new Error('Request payload too large');
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function safeEqual(a, b) {
  if (!a || !b) return false;
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function isWorkerAuthorized(req) {
  const header = String(req.headers.authorization || '');
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return false;
  return safeEqual(match[1], WORKER_SECRET);
}

function publicSubmission(sub) {
  const { imageDataUrl: _img, ...rest } = sub;
  return rest;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  try {
    if (req.method === 'GET' && url.pathname === '/healthz') {
      sendJson(res, 200, { ok: true, count: submissions.size });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/submit') {
      const body = await readJsonBody(req, 10 * 1024 * 1024);
      if (!safeEqual(body?.k, BOOTH_TOKEN)) {
        sendJson(res, 403, {
          ok: false,
          error: 'Invalid or expired booth QR link. Please scan the QR code again.',
        });
        return;
      }

      const guestName = String(body?.guestName || '').trim().slice(0, 40);
      if (!guestName) {
        sendJson(res, 400, {
          ok: false,
          error: 'Please enter your name (required so it is printed on your sheet).',
        });
        return;
      }

      const imageDataUrl = String(body?.imageDataUrl || '');
      if (!/^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(imageDataUrl)) {
        sendJson(res, 400, {
          ok: false,
          error: 'Please take or upload a valid photo.',
        });
        return;
      }

      const style = ALLOWED_STYLES.has(body?.style) ? body.style : 'chibi';
      const customNote = String(body?.customNote || '').trim().slice(0, 240);
      const id = crypto.randomUUID();

      const entry = {
        id,
        guestName,
        style,
        customNote,
        imageDataUrl,
        generatedFilename: null,
        printConfirmed: false,
        status: 'pending',
        message: 'Sent to booth — generating your sticker sheet preview…',
        ticketId: null,
        queuePosition: null,
        previewDataUrl: null,
        error: null,
        createdAt: new Date().toISOString(),
        claimedAt: 0,
        printClaimedAt: 0,
      };
      submissions.set(id, entry);
      while (submissions.size > MAX_SUBMISSIONS) {
        const oldestKey = submissions.keys().next().value;
        if (!oldestKey) break;
        submissions.delete(oldestKey);
      }
      schedulePersist();

      sendJson(res, 200, {
        ok: true,
        id,
        submission: publicSubmission(entry),
      });
      return;
    }

    const subMatch = /^\/api\/submissions\/([a-zA-Z0-9-]+)$/.exec(url.pathname);
    if (req.method === 'GET' && subMatch) {
      if (!safeEqual(url.searchParams.get('k'), BOOTH_TOKEN)) {
        sendJson(res, 403, { ok: false, error: 'Unauthorized booth token' });
        return;
      }
      const entry = submissions.get(subMatch[1]);
      if (!entry) {
        sendJson(res, 404, { ok: false, error: 'Submission not found' });
        return;
      }
      sendJson(res, 200, { ok: true, submission: publicSubmission(entry) });
      return;
    }

    const confirmMatch = /^\/api\/submissions\/([a-zA-Z0-9-]+)\/confirm-print$/.exec(
      url.pathname
    );
    if (req.method === 'POST' && confirmMatch) {
      const body = await readJsonBody(req, 64 * 1024);
      if (!safeEqual(body?.k, BOOTH_TOKEN)) {
        sendJson(res, 403, { ok: false, error: 'Unauthorized booth token' });
        return;
      }
      const entry = submissions.get(confirmMatch[1]);
      if (!entry) {
        sendJson(res, 404, { ok: false, error: 'Submission not found' });
        return;
      }
      if (
        ['print_requested', 'queueing', 'queued', 'printing', 'done'].includes(
          entry.status
        )
      ) {
        sendJson(res, 200, { ok: true, submission: publicSubmission(entry) });
        return;
      }
      if (entry.status !== 'preview_ready' || !entry.generatedFilename) {
        sendJson(res, 409, {
          ok: false,
          error: 'Sticker preview is not ready to print yet.',
        });
        return;
      }
      const guestName = String(body?.guestName ?? entry.guestName ?? '')
        .trim()
        .slice(0, 40);
      if (!guestName) {
        sendJson(res, 400, {
          ok: false,
          error: 'Please enter your name (required to print on your sheet).',
        });
        return;
      }
      entry.guestName = guestName;
      entry.printConfirmed = true;
      entry.status = 'print_requested';
      entry.printClaimedAt = 0;
      entry.error = null;
      entry.message = 'Sending your sticker sheet to the PixCut S1 print queue…';
      schedulePersist();
      sendJson(res, 200, { ok: true, submission: publicSubmission(entry) });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/queue') {
      const token = (url.searchParams.get('k') || '').trim();
      if (!BOOTH_TOKEN || !safeEqual(token, BOOTH_TOKEN)) {
        sendJson(res, 403, { ok: false, error: 'Invalid booth token' });
        return;
      }
      sendJson(res, 200, { ok: true, queue: latestQueueSnapshot });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/stickers') {
      const token = (url.searchParams.get('k') || '').trim();
      if (!BOOTH_TOKEN || !safeEqual(token, BOOTH_TOKEN)) {
        sendJson(res, 403, { ok: false, error: 'Invalid booth token' });
        return;
      }
      try {
        const gcsRes = await fetch(
          'https://storage.googleapis.com/ivan-agent-hub-sticker-booth/manifest.json',
          { cache: 'no-store' }
        );
        if (!gcsRes.ok) {
          sendJson(res, 502, { ok: false, error: `GCS manifest HTTP ${gcsRes.status}` });
          return;
        }
        const manifest = await gcsRes.json();
        sendJson(res, 200, {
          ok: true,
          updatedAt: manifest.updatedAt || null,
          items: Array.isArray(manifest.items) ? manifest.items : [],
        });
      } catch (err) {
        sendJson(res, 502, { ok: false, error: err?.message || 'Could not load sticker manifest' });
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/worker/claim') {
      if (!isWorkerAuthorized(req)) {
        sendJson(res, 401, { ok: false, error: 'Unauthorized worker' });
        return;
      }
      const body = await readJsonBody(req, 256 * 1024).catch(() => ({}));
      if (body?.queueSnapshot && typeof body.queueSnapshot === 'object') {
        latestQueueSnapshot = body.queueSnapshot;
      }
      const now = Date.now();
      const claimed = [];
      for (const sub of submissions.values()) {
        if (!sub.imageDataUrl) continue;
        const isPending = sub.status === 'pending';
        const isStale =
          sub.status === 'generating' && now - (sub.claimedAt || 0) > CLAIM_STALE_MS;
        if (isPending || isStale) {
          sub.status = 'generating';
          sub.claimedAt = now;
          sub.message = 'Generating your sticker preview on the booth…';
          claimed.push({
            id: sub.id,
            guestName: sub.guestName,
            style: sub.style,
            customNote: sub.customNote,
            imageDataUrl: sub.imageDataUrl,
            createdAt: sub.createdAt,
          });
          if (claimed.length >= 2) break;
        }
      }

      const printItems = [];
      for (const sub of submissions.values()) {
        if (!sub.generatedFilename) continue;
        const isPrintReq = sub.status === 'print_requested';
        const isPrintStale =
          sub.status === 'queueing' && now - (sub.printClaimedAt || 0) > 30_000;
        if (isPrintReq || isPrintStale) {
          sub.status = 'queueing';
          sub.printClaimedAt = now;
          sub.message = 'Adding your sheet to the PixCut S1 print queue…';
          printItems.push({
            id: sub.id,
            guestName: sub.guestName,
            generatedFilename: sub.generatedFilename,
            createdAt: sub.createdAt,
          });
          if (printItems.length >= 4) break;
        }
      }

      if (claimed.length > 0 || printItems.length > 0) schedulePersist();
      sendJson(res, 200, { ok: true, items: claimed, printItems });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/worker/update') {
      if (!isWorkerAuthorized(req)) {
        sendJson(res, 401, { ok: false, error: 'Unauthorized worker' });
        return;
      }
      const body = await readJsonBody(req, 12 * 1024 * 1024);
      const updates = Array.isArray(body?.updates) ? body.updates : [];
      let changed = false;
      for (const u of updates) {
        if (!u?.id) continue;
        const sub = submissions.get(u.id);
        if (!sub) continue;
        if (
          u.status &&
          ['queued', 'printing', 'done'].includes(String(u.status)) &&
          !sub.printConfirmed
        ) {
          continue;
        }
        if (u.status) sub.status = String(u.status);
        if (u.message !== undefined) sub.message = u.message;
        if (u.ticketId !== undefined) sub.ticketId = u.ticketId;
        if (u.queuePosition !== undefined) sub.queuePosition = u.queuePosition;
        if (u.generatedFilename) sub.generatedFilename = String(u.generatedFilename);
        if (u.previewDataUrl) sub.previewDataUrl = u.previewDataUrl;
        if (u.error !== undefined) sub.error = u.error;
        if (
          [
            'preview_ready',
            'print_requested',
            'queueing',
            'queued',
            'printing',
            'done',
            'error',
          ].includes(sub.status)
        ) {
          sub.imageDataUrl = null;
        }
        changed = true;
      }
      if (changed) schedulePersist();
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET') {
      const rel =
        url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
      const resolved = path.resolve(PUBLIC_DIR, rel);
      if (!resolved.startsWith(PUBLIC_DIR)) {
        sendJson(res, 403, { error: 'Forbidden' });
        return;
      }
      try {
        const data = await fs.readFile(resolved);
        const ext = path.extname(resolved).toLowerCase();
        res.writeHead(200, {
          'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
          'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=3600',
        });
        res.end(data);
        return;
      } catch {
        // Fallback to index.html for unknown non-api paths
        if (!url.pathname.startsWith('/api/')) {
          const html = await fs.readFile(path.join(PUBLIC_DIR, 'index.html'));
          res.writeHead(200, {
            'Content-Type': MIME_TYPES['.html'],
            'Cache-Control': 'no-store',
          });
          res.end(html);
          return;
        }
      }
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err?.message || 'Internal error' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Sticker Booth QR Relay listening on port ${PORT}`);
});
