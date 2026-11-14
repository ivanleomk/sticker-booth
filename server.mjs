import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRIVER_PATH = path.join(__dirname, 'pixcut_driver.py');
const UVX_PIXCUT_ARGS = [
  '--offline',
  '--python',
  '3.14',
  '--with',
  'numpy',
  '--with',
  'pillow',
  '--with',
  'bleak',
  '--with',
  'pyobjc-framework-IOBluetooth',
  'python',
  DRIVER_PATH,
];
const DIST_DIR = path.join(__dirname, 'web', 'dist');
const PUBLIC_DIR = path.join(__dirname, 'public');
const OUTPUT_DIR = path.join(__dirname, 'output');
const QUEUE_STATE_PATH = path.join(OUTPUT_DIR, 'queue-state.json');
const RELAY_CONFIG_PATH = path.join(OUTPUT_DIR, 'relay-config.json');
const PORT = Number(process.env.PORT || 3456);
const DEFAULT_MODEL = process.env.NANO_BANANA_MODEL || 'gemini-nano-banana-2.1';

const STYLE_PROMPTS = {
  chibi:
    'adorable kawaii chibi character illustration, 2.5-head proportions, big expressive sparkling eyes, bold crisp dark ink outlines, vibrant cel-shaded colors',
  watercolor:
    'expressive storybook watercolor and fountain-pen ink illustration, delicate hand-drawn dark ink outlines, luminous warm watercolor washes, artisanal sketchbook charm',
  realistic:
    'crisp stylized realistic studio portrait and modern industrial-design illustration, accurate natural facial likeness and skin tones, clean studio key lighting, sharp editorial finish',
};

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

await fs.mkdir(OUTPUT_DIR, { recursive: true });

const printQueue = [];
const printHistory = [];
let activePrintJob = null;
let queueRunning = false;
let queuePausedReason = null;
let nextQueueId = 1;

let pixcutDaemon = null;
let daemonReqSeq = 1;
const daemonPending = new Map();
let daemonRestartTimer = null;
let shuttingDown = false;
let cachedPixcutStatus = {
  connected: false,
  keepaliveMode: 'daemon',
  updatedAtMs: 0,
};
let cachedQrSvg = { url: '', svg: '' };

function sanitizeJob(job) {
  if (!job) return null;
  const { pngBuffer: _b, preparePromise: _p, _lastSyncedKey: _s, ...rest } = job;
  return {
    ...rest,
    previewUrl: job.sheetPreviewUrl || `/output/${job.filename}`,
  };
}

function parseLastJsonLine(text) {
  const lines = String(text || '')
    .trim()
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // Skip non-JSON diagnostic lines
    }
  }
  return null;
}

function dedupeQueueArray(queuedList, historyList, activeJobObj = null) {
  const seen = new Set();
  if (activeJobObj?.filename) {
    seen.add(activeJobObj.filename);
  }
  for (const h of historyList || []) {
    if (h?.status === 'done' && h?.filename) {
      seen.add(h.filename);
    }
  }
  const result = [];
  for (const item of queuedList || []) {
    if (!item?.filename || seen.has(item.filename)) continue;
    seen.add(item.filename);
    result.push(item);
  }
  return result;
}

async function saveQueueState() {
  try {
    const payload = {
      nextQueueId,
      pausedReason: queuePausedReason,
      queued: printQueue.map(sanitizeJob),
      history: printHistory.slice(0, 30),
    };
    const tmpPath = `${QUEUE_STATE_PATH}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(payload, null, 2));
    await fs.rename(tmpPath, QUEUE_STATE_PATH);
  } catch (err) {
    console.error('Failed to save queue-state.json:', err.message);
  }
}

async function prepareJobAssets(job) {
  const sheetLabel = job.guestName ? `${job.guestName} · #${job.id}` : `#${job.id}`;
  const sheetJpegPath = path.join(OUTPUT_DIR, `sheet-${job.id}.jpg`);
  const sheetPltPath = path.join(OUTPUT_DIR, `sheet-${job.id}.plt`);
  if (
    job.preparedLabel === sheetLabel &&
    job.sheetJpegPath === sheetJpegPath &&
    job.sheetPltPath === sheetPltPath
  ) {
    try {
      await Promise.all([fs.access(sheetJpegPath), fs.access(sheetPltPath)]);
      return;
    } catch {
      // Rebuild missing pre-rendered files
    }
  }
  if (job.preparePromise) {
    return job.preparePromise;
  }

  job.preparePromise = (async () => {
    try {
      const { stdout } = await execFileAsync(
        'uvx',
        [
          ...UVX_PIXCUT_ARGS,
          'prepare',
          '--png',
          job.pngPath,
          '--out-jpeg',
          sheetJpegPath,
          '--out-plt',
          sheetPltPath,
          '--label',
          sheetLabel,
        ],
        { timeout: 60000 }
      );
      const parsed = parseLastJsonLine(stdout);
      if (!parsed?.ok) {
        throw new Error(parsed?.error || 'Failed to pre-render sticker sheet');
      }
      job.sheetJpegPath = sheetJpegPath;
      job.sheetPltPath = sheetPltPath;
      job.sheetPreviewUrl = `/output/sheet-${job.id}.jpg?t=${Date.now()}`;
      job.preparedContours = Number(parsed.contours || 6);
      job.preparedLabel = sheetLabel;
      await saveQueueState();
    } finally {
      delete job.preparePromise;
    }
  })();

  return job.preparePromise;
}

function startPixcutDaemon() {
  if (shuttingDown || pixcutDaemon) return;
  const proc = spawn('uvx', [...UVX_PIXCUT_ARGS, 'daemon'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  pixcutDaemon = proc;

  const rlOut = readline.createInterface({ input: proc.stdout });
  rlOut.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      console.log('[pixcut-daemon]', trimmed);
      return;
    }
    if (msg.event === 'ready' || msg.event === 'status') {
      const { event: _ev, ...rest } = msg;
      cachedPixcutStatus = {
        ...rest,
        keepaliveMode: rest.keepaliveMode || 'daemon',
        updatedAtMs: Date.now(),
      };
      return;
    }
    if (msg.event === 'progress') {
      if (activePrintJob && (!msg.queueId || msg.queueId === activePrintJob.id)) {
        if (msg.text) activePrintJob.progressText = msg.text;
        if (typeof msg.pct === 'number') {
          activePrintJob.pct = msg.pct;
        } else if (msg.phase && msg.phase !== 'upload' && msg.phase !== 'cut') {
          delete activePrintJob.pct;
        }
        if (msg.phase) activePrintJob.phase = msg.phase;
        if (msg.transport) activePrintJob.transport = msg.transport;
      }
      return;
    }
    if (msg.id !== undefined) {
      const entry = daemonPending.get(msg.id);
      if (entry) {
        clearTimeout(entry.timer);
        daemonPending.delete(msg.id);
        entry.resolve(msg);
      }
    }
  });

  const rlErr = readline.createInterface({ input: proc.stderr });
  rlErr.on('line', (line) => {
    if (line.trim()) console.error('[pixcut-daemon]', line);
  });

  proc.on('exit', (code, sig) => {
    if (pixcutDaemon === proc) pixcutDaemon = null;
    for (const [id, entry] of daemonPending.entries()) {
      clearTimeout(entry.timer);
      daemonPending.delete(id);
      entry.reject(new Error(`PixCut daemon exited (code=${code}, sig=${sig})`));
    }
    cachedPixcutStatus = {
      ...cachedPixcutStatus,
      connected: false,
      busy: false,
      keepaliveMode: 'daemon',
      updatedAtMs: Date.now(),
    };
    if (!shuttingDown && !daemonRestartTimer) {
      daemonRestartTimer = setTimeout(() => {
        daemonRestartTimer = null;
        startPixcutDaemon();
      }, 2000);
    }
  });
}

function callPixcutDaemon(payload, timeoutMs = 25000) {
  if (!pixcutDaemon && !shuttingDown) {
    startPixcutDaemon();
  }
  const proc = pixcutDaemon;
  if (!proc || !proc.stdin || !proc.stdin.writable) {
    return Promise.reject(new Error('PixCut daemon is not ready'));
  }
  const id = daemonReqSeq++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      daemonPending.delete(id);
      reject(new Error(`PixCut daemon timeout after ${timeoutMs}ms (${payload.cmd})`));
    }, timeoutMs);
    daemonPending.set(id, { resolve, reject, timer });
    try {
      proc.stdin.write(JSON.stringify({ id, ...payload }) + '\n');
    } catch (err) {
      clearTimeout(timer);
      daemonPending.delete(id);
      reject(err);
    }
  });
}

async function shutdownServer() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (daemonRestartTimer) {
    clearTimeout(daemonRestartTimer);
    daemonRestartTimer = null;
  }
  const proc = pixcutDaemon;
  if (proc && !proc.killed) {
    try {
      proc.stdin?.write(JSON.stringify({ id: 999999, cmd: 'shutdown' }) + '\n');
      proc.stdin?.end();
    } catch {
      // Ignore
    }
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        try {
          proc.kill('SIGTERM');
        } catch {
          // Ignore
        }
        resolve();
      }, 1200);
      proc.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
  process.exit(0);
}

process.on('SIGINT', () => void shutdownServer());
process.on('SIGTERM', () => void shutdownServer());

async function loadQueueState() {
  try {
    const raw = await fs.readFile(QUEUE_STATE_PATH, 'utf8');
    const saved = JSON.parse(raw);
    queuePausedReason =
      typeof saved?.pausedReason === 'string' && saved.pausedReason
        ? saved.pausedReason
        : null;
    if (Array.isArray(saved?.history)) {
      printHistory.push(...saved.history.slice(0, 30));
    }
    const deduped = dedupeQueueArray(
      Array.isArray(saved?.queued) ? saved.queued : [],
      printHistory,
      null
    );
    for (const item of deduped) {
      if (!item?.pngPath || !item?.filename) continue;
      try {
        await fs.access(item.pngPath);
        printQueue.push({
          ...item,
          status: 'queued',
          startedAt: undefined,
        });
      } catch {
        // Skip missing file
      }
    }
    const allIds = [...printQueue, ...printHistory]
      .map((j) => Number(j.id) || 0)
      .filter((n) => n > 0);
    const maxId = allIds.length ? Math.max(...allIds) : 0;
    nextQueueId = Math.max(Number(saved?.nextQueueId) || 1, maxId + 1);
    await saveQueueState();
    for (const qJob of printQueue) {
      void prepareJobAssets(qJob).catch((err) =>
        console.error(`Pre-render #${qJob.id} failed:`, err.message)
      );
    }
    if (printQueue.length > 0 && !queuePausedReason) {
      setTimeout(() => {
        processPrintQueue();
      }, 500);
    }
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      console.error('Failed to load queue-state.json:', err.message);
    }
  }
}

startPixcutDaemon();
await loadQueueState();

async function processPrintQueue() {
  if (queueRunning || queuePausedReason) return;
  queueRunning = true;
  try {
    while (printQueue.length > 0 && !queuePausedReason) {
      const job = printQueue.shift();
      activePrintJob = job;
      job.status = 'printing';
      job.startedAt = new Date().toISOString();
      job.progressText = 'Preparing sheet…';
      await saveQueueState();

      let requeuedOnFault = false;
      try {
        await prepareJobAssets(job).catch((err) =>
          console.error(`Prepare fallback #${job.id}:`, err.message)
        );
        const sheetLabel = job.guestName ? `${job.guestName} · #${job.id}` : `#${job.id}`;
        job.progressText = 'Connecting to PixCut S1…';

        const result = await callPixcutDaemon(
          {
            cmd: 'print',
            queueId: job.id,
            jpeg: job.sheetJpegPath,
            plt: job.sheetPltPath,
            png: job.pngPath,
            copies: job.copies,
            label: sheetLabel,
            contours: job.preparedContours,
          },
          380000
        );
        if (!result?.ok) {
          throw new Error(result?.error || 'Unexpected output from PixCut driver');
        }
        const contours = Number(result.contours || job.preparedContours || 6);
        job.status = 'done';
        job.printerJobId = result.jobId;
        job.pathCount = contours;
        job.transport = result.transport || job.transport;
        job.message = `Printed & cut (${contours} contour${contours === 1 ? '' : 's'}, job #${result.jobId})`;
      } catch (err) {
        const errMsg = err?.message || 'Print failed';
        if (
          /PixCutAlert|Printer fault blocks printing|8101|5301|5306|state-60|not found via BLE/i.test(
            errMsg
          )
        ) {
          requeuedOnFault = true;
          job.status = 'queued';
          delete job.startedAt;
          delete job.error;
          delete job.finishedAt;
          printQueue.unshift(job);
          queuePausedReason = errMsg;
        } else {
          job.status = 'error';
          job.error = errMsg;
        }
      } finally {
        delete job.progressText;
        delete job.pct;
        delete job.phase;
        if (!requeuedOnFault) {
          job.finishedAt = new Date().toISOString();
          printHistory.unshift(sanitizeJob(job));
          if (printHistory.length > 30) printHistory.length = 30;
        }
        activePrintJob = null;
        await saveQueueState();
      }
    }
  } finally {
    queueRunning = false;
  }
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJsonBody(req, maxBytes = 25 * 1024 * 1024) {
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

function parseDataUrl(dataUrl) {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(dataUrl || '');
  if (!match) {
    throw new Error('Invalid image data URL');
  }
  return { mimeType: match[1], base64: match[2] };
}

function buildStickerPrompt({ style, customNote, stickerCount = 6 }) {
  const styleDesc = STYLE_PROMPTS[style] || STYLE_PROMPTS.chibi;
  const userPrompt = customNote?.trim() || '';

  const sceneInstructions = userPrompt
    ? `USER CUSTOM PROMPT (prioritize this request for the poses, outfits, props, and scenes across the ${stickerCount} stickers): "${userPrompt}". Across the ${stickerCount} stickers, split the badges evenly: style 2 badges for VexoHacks (the Vexo 3-triangle pyramid logo mark: one rounded triangle centered above two rounded triangles side-by-side below, warm cream #F7F5F0 & matte charcoal #111111 or soft lavender #EDE4FB, "VexoHacks" / "VEXO AI" text, NO "Make Something People Want"), style 2 badges exclusively for Google DeepMind / Gemini (royal-blue #4285F4 & violet #9B72CB palette, 4-point concave Gemini star logo, "Google DeepMind" / "Built with Gemini" text, NO "Make Something People Want" and NO orange [Y]), and style 2 badges in Y Combinator orange ("[Y]" + "Make Something People Want").`
    : [
        `Show 6 distinct wearable-tech builder poses split evenly across 2 VexoHacks badges, 2 Google DeepMind / Gemini badges, and 2 Y Combinator badges:`,
        `(1) [Dedicated VexoHacks AI Wearables Badge — top-left, NO YC orange or "Make Something People Want"] Speaking a voice command into a sleek Vexo AI voice bracelet with glowing lavender soundwaves inside a warm cream (#F7F5F0) and matte charcoal-black (#111111) badge featuring the Vexo 3-triangle pyramid logo mark (one rounded triangle centered above two rounded triangles side-by-side below) and crisp "VexoHacks" header text;`,
        `(2) [Dedicated Google DeepMind Badge — top-right, NO YC logo or "Make Something People Want" text] Wearing a futuristic glowing AI lapel pin / smart pendant on their chest and flashing a cheerful peace sign inside a cool ice-white (#F0F4FF) and royal-blue & violet (#4285F4, #669DF6, #9B72CB) badge featuring the 4-point concave Gemini star logo and crisp "Google DeepMind" header text;`,
        `(3) [Dedicated Google DeepMind / Gemini Badge — middle-left, NO YC logo or "Make Something People Want" text] Looking excited while checking multimodal AI holographic telemetry on a next-gen smartwatch / neural wristband inside a cool blue-to-violet badge featuring the iconic 4-point concave Gemini star logo and crisp "Built with Gemini" banner text;`,
        `(4) [YC Orange Badge — middle-right] Wearing sleek AR smart glasses with glowing HUD graphics inside a warm cream (#FFF7ED) & vibrant orange (#FF6600) [Y] "Make Something People Want" badge;`,
        `(5) [Dedicated VexoHacks Hardware Badge — bottom-left, NO YC orange or "Make Something People Want"] Prototyping wearable AI sensors with smart glasses perched on their head inside a soft lavender (#EDE4FB) & charcoal (#111111) badge featuring the Vexo 3-triangle pyramid logo mark and crisp "VEXO AI · HACKS" emblem;`,
        `(6) [YC Orange Badge — bottom-right] Demo Day launch celebration wearing smart glasses and a builder hoodie with the orange square [Y] mark and "Make Something People Want" banner.`,
      ].join(' ');

  return [
    `Turn the person in this photo into a vertical 9:16 printable die-cut sticker sheet with ${stickerCount} distinct self-contained rounded-badge stickers arranged in a spacious 2-column by 3-row grid on a completely flat pure #FFFFFF white background.`,
    `Keep the person's recognizable likeness (facial features, hairstyle, glasses/accessories, warm personality) across all ${stickerCount} stickers. Art style: ${styleDesc}.`,
    `STICKER BADGE SPLIT (2 VEXOHACKS + 2 GOOGLE DEEPMIND + 2 YC): Enclose EVERY individual sticker inside its own self-contained rounded sticker badge card with a crisp solid closed outer border. Exactly 2 stickers (top-left and bottom-left) feature VexoHacks branding (Vexo 3-triangle pyramid logo mark, warm cream #F7F5F0 / lavender #EDE4FB / charcoal #111111, "VexoHacks" / "VEXO AI"). Exactly 2 stickers (top-right and middle-left) feature Google DeepMind / Gemini branding (cool ice-white #F0F4FF, royal-blue #4285F4 & violet #9B72CB, 4-point concave Gemini star logo, "Google DeepMind" / "Built with Gemini"). Exactly 2 stickers (middle-right and bottom-right) feature Y Combinator branding (warm cream #FFF7ED, vibrant YC orange #FF6600, orange square "Y" logo, "Make Something People Want").`,
    sceneInstructions,
    `CRITICAL CUTTING & SPACING RULES: Leave extra-wide, completely empty flat #FFFFFF white channels between all 6 sticker badges and around the outer margins so each badge is isolated for clean die-cutting. Do NOT render soft grey drop shadows, background gradients, or loose floating stars/sparkles outside each badge's closed outer border.`,
  ].join(' ');
}

async function getPrinters() {
  try {
    const { stdout } = await execFileAsync('lpstat', ['-p', '-d']);
    const printers = [];
    let defaultPrinter = null;

    for (const line of stdout.split(/\r?\n/)) {
      const printerMatch = /^printer\s+(\S+)\s+(.+)$/.exec(line.trim());
      if (printerMatch) {
        const [, name, statusText] = printerMatch;
        printers.push({
          name,
          status: statusText,
          enabled: !statusText.toLowerCase().includes('disabled'),
        });
      }
      const defaultMatch = /^system default destination:\s+(\S+)/.exec(line.trim());
      if (defaultMatch) {
        defaultPrinter = defaultMatch[1];
      }
    }

    const targetQueue = defaultPrinter || printers[0]?.name || null;
    let mediaOptions = [];
    if (targetQueue) {
      try {
        const { stdout: optsOut } = await execFileAsync('lpoptions', ['-p', targetQueue, '-l']);
        const pageSizeLine = optsOut
          .split(/\r?\n/)
          .find((l) => l.startsWith('PageSize/'));
        if (pageSizeLine) {
          const [, valuesPart = ''] = pageSizeLine.split(':');
          mediaOptions = valuesPart
            .trim()
            .split(/\s+/)
            .map((v) => v.replace(/^\*/, ''));
        }
      } catch {
        // Ignore lpoptions errors for queues without PPDs
      }
    }

    return {
      printers,
      defaultPrinter,
      mediaOptions,
      message: printers.length
        ? `Found ${printers.length} CUPS printer(s).`
        : 'No macOS printers configured yet. Connect a printer in System Settings -> Printers & Scanners.',
    };
  } catch (err) {
    const stderr = err?.stderr?.toString() || err.message || '';
    if (stderr.includes('No destinations added')) {
      return {
        printers: [],
        defaultPrinter: null,
        mediaOptions: [],
        message:
          'No macOS printers configured yet. Connect a printer in System Settings -> Printers & Scanners.',
      };
    }
    return {
      printers: [],
      defaultPrinter: null,
      mediaOptions: [],
      message: `Unable to query CUPS printers: ${stderr.trim()}`,
    };
  }
}

async function generateStickerSheet({ imageDataUrl, style, customNote, model }) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error(
      'Missing GEMINI_API_KEY. Start the server via ./start.sh (uses 1Password Agents vault) or export GEMINI_API_KEY.'
    );
  }

  const { mimeType, base64 } = parseDataUrl(imageDataUrl);
  const selectedModel = model || DEFAULT_MODEL;
  const prompt = buildStickerPrompt({ style, customNote });

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    selectedModel
  )}:generateContent`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType, data: base64 } },
            { text: prompt },
          ],
        },
      ],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
        imageConfig: {
          aspectRatio: '9:16',
        },
      },
    }),
  });

  const payload = await response.json();
  if (!response.ok) {
    const apiMessage = payload?.error?.message || `Gemini API HTTP ${response.status}`;
    throw new Error(apiMessage);
  }

  const parts = payload?.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find((p) => p.inlineData?.data);
  const textPart = parts.find((p) => p.text);

  if (!imagePart) {
    throw new Error(
      textPart?.text || 'Model did not return an image. Try another photo or model.'
    );
  }

  const outMime = imagePart.inlineData.mimeType || 'image/png';
  const ext = outMime.includes('jpeg') ? 'jpg' : 'png';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `stickers-${stamp}.${ext}`;
  const outPath = path.join(OUTPUT_DIR, filename);

  await fs.writeFile(outPath, Buffer.from(imagePart.inlineData.data, 'base64'));

  return {
    filename,
    imageUrl: `/output/${filename}`,
    caption: textPart?.text || '',
    model: selectedModel,
  };
}

async function printStickerSheet({ filename, printer, media, copies = 1, fitToPage = true }) {
  const safeName = path.basename(filename || '');
  if (!safeName || safeName !== filename) {
    throw new Error('Invalid filename');
  }
  const filePath = path.join(OUTPUT_DIR, safeName);
  await fs.access(filePath);

  const args = [];
  if (printer) {
    args.push('-d', printer);
  }
  const copyCount = Math.max(1, Math.min(10, Number(copies) || 1));
  if (copyCount > 1) {
    args.push('-n', String(copyCount));
  }
  if (media) {
    args.push('-o', `media=${media}`);
  }
  if (fitToPage) {
    args.push('-o', 'fit-to-page');
  }
  args.push(filePath);

  const { stdout, stderr } = await execFileAsync('lp', args);
  return {
    ok: true,
    command: `lp ${args.join(' ')}`,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  };
}

async function serveStatic(reqPath, res) {
  if (reqPath.startsWith('/output/')) {
    const fileName = path.basename(reqPath.slice('/output/'.length));
    const filePath = path.join(OUTPUT_DIR, fileName);
    try {
      const data = await fs.readFile(filePath);
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
      res.end(data);
      return;
    } catch {
      sendJson(res, 404, { error: 'Generated sticker file not found' });
      return;
    }
  }

  let activePublicDir = PUBLIC_DIR;
  try {
    await fs.access(path.join(DIST_DIR, 'index.html'));
    activePublicDir = DIST_DIR;
  } catch {
    // Fallback to public/
  }

  const rel = reqPath === '/' ? 'index.html' : reqPath.replace(/^\/+/, '');
  const resolved = path.resolve(activePublicDir, rel);
  if (!resolved.startsWith(activePublicDir)) {
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }

  try {
    const data = await fs.readFile(resolved);
    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  } catch {
    if (!reqPath.startsWith('/api/') && !reqPath.startsWith('/output/') && !path.extname(reqPath)) {
      try {
        const indexHtml = await fs.readFile(path.join(activePublicDir, 'index.html'));
        res.writeHead(200, { 'Content-Type': MIME_TYPES['.html'] });
        res.end(indexHtml);
        return;
      } catch {
        // Fall through to 404
      }
    }
    sendJson(res, 404, { error: 'Not found' });
  }
}

async function loadRelayConfig() {
  try {
    const raw = await fs.readFile(RELAY_CONFIG_PATH, 'utf8');
    const cfg = JSON.parse(raw);
    if (cfg?.relayUrl && cfg?.boothToken && cfg?.workerSecret) {
      return cfg;
    }
  } catch {
    // Relay not configured
  }
  return null;
}

async function handleRelayGenerate(sub, base, headers) {
  const safeSubId = String(sub.id || 'qr').replace(/[^a-zA-Z0-9_-]/g, '');
  const tmpJpeg = path.join(os.tmpdir(), `qr-preview-${safeSubId}.jpg`);
  const tmpPlt = path.join(os.tmpdir(), `qr-preview-${safeSubId}.plt`);
  try {
    const gen = await generateStickerSheet({
      imageDataUrl: sub.imageDataUrl,
      style: sub.style,
      customNote: sub.customNote,
      model: DEFAULT_MODEL,
    });
    const pngPath = path.join(OUTPUT_DIR, gen.filename);
    const label = String(sub.guestName || '').trim().slice(0, 40);

    try {
      await execFileAsync(
        'uvx',
        [
          ...UVX_PIXCUT_ARGS,
          'prepare',
          '--png',
          pngPath,
          ...(label ? ['--label', label] : []),
          '--out-jpeg',
          tmpJpeg,
          '--out-plt',
          tmpPlt,
        ],
        { timeout: 45000 }
      );
    } catch (err) {
      console.error(`QR preview prepare for ${sub.id} fell back to raw sheet:`, err?.message || err);
    }

    let previewDataUrl = null;
    try {
      const previewBuf = await fs.readFile(tmpJpeg).catch(() => fs.readFile(pngPath));
      previewDataUrl = `data:image/jpeg;base64,${previewBuf.toString('base64')}`;
    } catch {
      // Ignore preview read failure
    }

    await fetch(`${base}/api/worker/update`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        updates: [
          {
            id: sub.id,
            status: 'preview_ready',
            generatedFilename: gen.filename,
            message: 'Preview ready! Check your sticker sheet below, then tap Print & Cut.',
            previewDataUrl,
            error: null,
          },
        ],
      }),
    });
  } catch (err) {
    console.error(`QR generation ${sub.id} failed:`, err?.message || err);
    await fetch(`${base}/api/worker/update`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        updates: [
          {
            id: sub.id,
            status: 'error',
            error: err?.message || 'Generation failed on booth',
          },
        ],
      }),
    }).catch(() => {});
  } finally {
    await Promise.all([
      fs.unlink(tmpJpeg).catch(() => {}),
      fs.unlink(tmpPlt).catch(() => {}),
    ]);
  }
}

async function handleRelayPrintConfirm(item, base, headers) {
  try {
    const existing = [activePrintJob, ...printQueue, ...printHistory]
      .filter(Boolean)
      .find((j) => j.submissionId === item.id);
    if (existing) {
      const qPosNow =
        existing.status === 'queued'
          ? printQueue.findIndex((j) => j.id === existing.id) + 1
          : null;
      await fetch(`${base}/api/worker/update`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          updates: [
            {
              id: item.id,
              status: existing.status,
              ticketId: existing.id,
              queuePosition: qPosNow,
              message:
                existing.status === 'printing'
                  ? existing.progressText || `Ticket #${existing.id} printing now!`
                  : existing.status === 'done'
                    ? existing.message || 'Printed & kiss-cut! Pick up your stickers at the booth.'
                    : `Queued as Ticket #${existing.id}${qPosNow ? ` (#${qPosNow} in line)` : ''}`,
            },
          ],
        }),
      });
      return;
    }

    const safeName = path.basename(String(item.generatedFilename || ''));
    if (!safeName || safeName !== item.generatedFilename) {
      throw new Error('Invalid generated filename');
    }
    const pngPath = path.join(OUTPUT_DIR, safeName);
    await fs.access(pngPath);

    const guestName = String(item.guestName || '').trim().slice(0, 40);
    if (!guestName) {
      throw new Error('Your Name is required to print.');
    }

    const job = {
      id: nextQueueId++,
      filename: safeName,
      guestName,
      source: 'qr',
      submissionId: item.id,
      pngPath,
      copies: 1,
      status: 'queued',
      createdAt: new Date().toISOString(),
    };
    printQueue.push(job);
    const queuePosition = printQueue.length;
    await saveQueueState();
    await prepareJobAssets(job).catch((err) =>
      console.error(`Pre-render QR job #${job.id} failed:`, err.message)
    );
    if (!queuePausedReason) {
      processPrintQueue();
    }

    let previewDataUrl = null;
    try {
      const previewBuf = await fs.readFile(job.sheetJpegPath || job.pngPath);
      previewDataUrl = `data:image/jpeg;base64,${previewBuf.toString('base64')}`;
    } catch {
      // Ignore preview read failure
    }

    const qPosNow =
      job.status === 'queued'
        ? printQueue.findIndex((j) => j.id === job.id) + 1 || queuePosition
        : null;
    await fetch(`${base}/api/worker/update`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        updates: [
          {
            id: item.id,
            status: job.status,
            ticketId: job.id,
            queuePosition: qPosNow,
            message:
              job.status === 'printing'
                ? job.progressText || `Ticket #${job.id} printing now!`
                : `Queued as Ticket #${job.id} (#${qPosNow || queuePosition} in line)`,
            previewDataUrl,
          },
        ],
      }),
    });
  } catch (err) {
    console.error(`QR print confirm ${item.id} failed:`, err?.message || err);
    await fetch(`${base}/api/worker/update`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        updates: [
          {
            id: item.id,
            status: 'error',
            error: err?.message || 'Could not queue QR print job on booth',
          },
        ],
      }),
    }).catch(() => {});
  }
}

let relayPollInFlight = false;
function startRelayPoller() {
  setInterval(async () => {
    if (shuttingDown || relayPollInFlight) return;
    relayPollInFlight = true;
    try {
      const cfg = await loadRelayConfig();
      if (!cfg) return;
      const base = cfg.relayUrl.replace(/\/+$/, '');
      const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.workerSecret}`,
      };

      const claimRes = await fetch(`${base}/api/worker/claim`, {
        method: 'POST',
        headers,
        body: '{}',
      });
      if (claimRes.ok) {
        const { items, printItems } = await claimRes.json();
        if (Array.isArray(items) && items.length > 0) {
          for (const sub of items) {
            void handleRelayGenerate(sub, base, headers);
          }
        }
        if (Array.isArray(printItems) && printItems.length > 0) {
          for (const pItem of printItems) {
            void handleRelayPrintConfirm(pItem, base, headers);
          }
        }
      }

      const updates = [];
      const tracked = [
        ...(activePrintJob ? [{ job: activePrintJob, qPos: 0 }] : []),
        ...printQueue.map((job, idx) => ({ job, qPos: idx + 1 })),
        ...printHistory.slice(0, 12).map((job) => ({ job, qPos: 0 })),
      ];
      for (const { job, qPos } of tracked) {
        if (!job?.submissionId) continue;
        const message =
          job.status === 'printing'
            ? job.progressText || 'Printing & kiss-cutting now on PixCut S1…'
            : job.status === 'queued'
              ? `Queued as Ticket #${job.id} (#${qPos} in line)`
              : job.status === 'done'
                ? job.message || 'Printed & kiss-cut! Pick up your stickers at the booth.'
                : job.error || 'Print failed';
        const syncKey = `${job.status}|${qPos}|${message}|${job.error || ''}`;
        if (job._lastSyncedKey === syncKey) continue;
        job._lastSyncedKey = syncKey;
        updates.push({
          id: job.submissionId,
          status: job.status,
          ticketId: job.id,
          queuePosition: qPos > 0 ? qPos : null,
          message,
          error: job.error || null,
        });
      }
      if (updates.length > 0) {
        await fetch(`${base}/api/worker/update`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ updates }),
        });
      }
    } catch (err) {
      // Transient network errors shouldn't spam logs every 1.2s
      if (process.env.DEBUG_RELAY) {
        console.error('[relay-poller]', err?.message || err);
      }
    } finally {
      relayPollInFlight = false;
    }
  }, 1200);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  try {
    if (req.method === 'GET' && url.pathname === '/api/health') {
      sendJson(res, 200, {
        ok: true,
        hasApiKey: Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY),
        defaultModel: DEFAULT_MODEL,
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/printers') {
      const info = await getPrinters();
      sendJson(res, 200, info);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/gallery') {
      const entries = await fs.readdir(OUTPUT_DIR);
      const files = entries
        .filter((f) => /^stickers-.*\.(png|jpe?g)$/i.test(f))
        .sort()
        .reverse()
        .slice(0, 24)
        .map((filename) => ({ filename, imageUrl: `/output/${filename}` }));
      sendJson(res, 200, { items: files });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/generate') {
      const body = await readJsonBody(req);
      const result = await generateStickerSheet(body);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/print') {
      const body = await readJsonBody(req);
      const result = await printStickerSheet(body);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/open-liene') {
      const body = await readJsonBody(req);
      const safeName = path.basename(body?.filename || '');
      if (!safeName || safeName !== body?.filename) {
        throw new Error('Invalid filename');
      }
      const filePath = path.join(OUTPUT_DIR, safeName);
      await fs.access(filePath);
      await execFileAsync('open', ['-a', 'Liene Photo', filePath]);
      sendJson(res, 200, { ok: true, message: `Opened ${safeName} in Liene Photo` });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/mobile-qr') {
      const cfg = await loadRelayConfig();
      if (!cfg) {
        sendJson(res, 200, { enabled: false });
        return;
      }
      const shareUrl = `${cfg.relayUrl.replace(/\/+$/, '')}/?k=${encodeURIComponent(cfg.boothToken)}`;
      sendJson(res, 200, {
        enabled: true,
        shareUrl,
        relayUrl: cfg.relayUrl,
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/mobile-qr.svg') {
      const cfg = await loadRelayConfig();
      if (!cfg) {
        sendJson(res, 404, { error: 'Mobile QR relay not configured' });
        return;
      }
      const shareUrl = `${cfg.relayUrl.replace(/\/+$/, '')}/?k=${encodeURIComponent(cfg.boothToken)}`;
      if (cachedQrSvg.url !== shareUrl || !cachedQrSvg.svg) {
        const { stdout } = await execFileAsync(
          'uvx',
          [
            '--offline',
            '--python',
            '3.14',
            '--with',
            'segno',
            'python',
            '-c',
            "import sys, io, segno; b = io.BytesIO(); segno.make(sys.argv[1], error='m').save(b, kind='svg', scale=6, border=2, dark='#111111', light='#ffffff'); sys.stdout.write(b.getvalue().decode())",
            shareUrl,
          ],
          { timeout: 15000 }
        );
        cachedQrSvg = { url: shareUrl, svg: stdout };
      }
      res.writeHead(200, {
        'Content-Type': 'image/svg+xml; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(cachedQrSvg.svg);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/pixcut/status') {
      if (queueRunning) {
        sendJson(res, 200, {
          ...cachedPixcutStatus,
          connected: true,
          name: cachedPixcutStatus.name || 'Liene PixCut S1-29DC',
          model: cachedPixcutStatus.model || 'DHP700',
          state: cachedPixcutStatus.state || '30',
          busy: true,
          keepaliveMode: 'daemon',
        });
        return;
      }
      if (
        url.searchParams.get('refresh') !== '1' &&
        cachedPixcutStatus.updatedAtMs > 0 &&
        Date.now() - cachedPixcutStatus.updatedAtMs < 45000
      ) {
        sendJson(res, 200, cachedPixcutStatus);
        return;
      }
      try {
        const parsed = await callPixcutDaemon({ cmd: 'status' }, 15000);
        sendJson(res, 200, parsed);
      } catch (err) {
        sendJson(res, 200, {
          connected: false,
          keepaliveMode: 'daemon',
          error: err?.message || 'Unable to query PixCut daemon',
        });
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/pixcut/clear-fault') {
      if (queueRunning) {
        sendJson(res, 409, { ok: false, error: 'Cannot clear fault while a print job is active.' });
        return;
      }
      const parsed = await callPixcutDaemon({ cmd: 'clear-fault' }, 20000);
      if (!parsed?.ok) {
        throw new Error(parsed?.error || 'Failed to clear PixCut fault');
      }
      if (queuePausedReason) {
        queuePausedReason = null;
        await saveQueueState();
        processPrintQueue();
      }
      sendJson(res, 200, parsed);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/queue') {
      sendJson(res, 200, {
        activeJob: activePrintJob ? sanitizeJob(activePrintJob) : null,
        queued: printQueue.map(sanitizeJob),
        history: printHistory.map(sanitizeJob),
        pausedReason: queuePausedReason,
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/queue/resume') {
      if (queueRunning) {
        sendJson(res, 409, { ok: false, error: 'Queue is already running' });
        return;
      }
      await callPixcutDaemon({ cmd: 'clear-fault' }, 20000).catch(() => {});
      queuePausedReason = null;
      await saveQueueState();
      processPrintQueue();
      sendJson(res, 200, { ok: true, message: 'Queue resumed!' });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/queue/clear') {
      printHistory.length = 0;
      await saveQueueState();
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/queue/dedupe') {
      const before = printQueue.length;
      const deduped = dedupeQueueArray(printQueue, printHistory, activePrintJob);
      printQueue.splice(0, printQueue.length, ...deduped);
      const removedCount = before - printQueue.length;
      await saveQueueState();
      sendJson(res, 200, {
        ok: true,
        removedCount,
        queued: printQueue.map(sanitizeJob),
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/queue/remove') {
      const body = await readJsonBody(req);
      const targetId = Number(body?.id);
      const idx = printQueue.findIndex((j) => j.id === targetId);
      if (idx === -1) {
        sendJson(res, 404, { ok: false, error: 'Queued job not found' });
        return;
      }
      const [removed] = printQueue.splice(idx, 1);
      await saveQueueState();
      sendJson(res, 200, { ok: true, removed: sanitizeJob(removed) });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/pixcut/print') {
      const body = await readJsonBody(req);
      const safeName = path.basename(body?.filename || '');
      if (!safeName || safeName !== body?.filename) {
        throw new Error('Invalid filename');
      }
      const guestName = String(body?.guestName || '').trim().slice(0, 40);
      if (!guestName) {
        sendJson(res, 400, {
          ok: false,
          error: 'Your name is required so we can print it on your sticker sheet.',
        });
        return;
      }
      const force = Boolean(body?.force);
      const copies = Math.max(1, Math.min(10, Number(body?.copies) || 1));

      if (!force) {
        if (activePrintJob?.filename === safeName) {
          sendJson(res, 200, {
            ok: true,
            alreadyQueued: true,
            job: sanitizeJob(activePrintJob),
            message: `Already printing as Ticket #${activePrintJob.id}`,
          });
          return;
        }
        const existingQueued = printQueue.find((j) => j.filename === safeName);
        if (existingQueued) {
          if (guestName && !existingQueued.guestName) {
            existingQueued.guestName = guestName;
            await saveQueueState();
            void prepareJobAssets(existingQueued).catch((err) =>
              console.error(`Pre-render #${existingQueued.id} failed:`, err.message)
            );
          }
          const qPos = printQueue.findIndex((j) => j.id === existingQueued.id) + 1;
          sendJson(res, 200, {
            ok: true,
            alreadyQueued: true,
            queuePosition: qPos,
            job: sanitizeJob(existingQueued),
            message: `Already in queue as Ticket #${existingQueued.id}`,
          });
          return;
        }
        const existingDone = printHistory.find(
          (j) => j.filename === safeName && j.status === 'done'
        );
        if (existingDone) {
          sendJson(res, 200, {
            ok: true,
            alreadyQueued: true,
            job: existingDone,
            message: `Already printed as Ticket #${existingDone.id}`,
          });
          return;
        }
      }

      let pngBuffer;
      let pngPath = path.join(OUTPUT_DIR, safeName);
      if (body?.transparentDataUrl) {
        const { base64 } = parseDataUrl(body.transparentDataUrl);
        pngBuffer = Buffer.from(base64, 'base64');
        pngPath = path.join(OUTPUT_DIR, `cut-${safeName}`);
        await fs.writeFile(pngPath, pngBuffer);
      } else {
        pngBuffer = await fs.readFile(pngPath);
      }

      const job = {
        id: nextQueueId++,
        filename: safeName,
        guestName,
        source: 'booth',
        pngPath,
        pngBuffer,
        copies,
        status: 'queued',
        createdAt: new Date().toISOString(),
      };
      printQueue.push(job);
      const queuePosition = printQueue.length;
      await saveQueueState();
      void prepareJobAssets(job).catch((err) =>
        console.error(`Pre-render #${job.id} failed:`, err.message)
      );
      if (!queuePausedReason) {
        processPrintQueue();
      }

      const publicJob = sanitizeJob(job);
      sendJson(res, 200, {
        ok: true,
        job: publicJob,
        queuePosition,
        message: `Queued Ticket #${job.id} (${guestName}) — #${queuePosition} in line`,
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/foundry/queue') {
      const body = await readJsonBody(req);
      const safeName = path.basename(body?.filename || '');
      if (!safeName || safeName !== body?.filename) {
        throw new Error('Invalid filename');
      }

      let incomingDir = path.join(process.env.HOME || '', 'Downloads', 'Sticker Foundry', 'incoming');
      try {
        const foundryRes = await fetch('http://127.0.0.1:8080/api/status');
        if (foundryRes.ok) {
          const status = await foundryRes.json();
          if (status.incoming_dir) incomingDir = status.incoming_dir;
        }
      } catch {
        // Use default incomingDir if status check fails
      }

      const targetPath = path.join(incomingDir, safeName);
      try {
        if (body?.transparentDataUrl) {
          const { base64 } = parseDataUrl(body.transparentDataUrl);
          await fs.writeFile(targetPath, Buffer.from(base64, 'base64'));
        } else {
          const srcPath = path.join(OUTPUT_DIR, safeName);
          await fs.copyFile(srcPath, targetPath);
        }
        sendJson(res, 200, {
          ok: true,
          queuedPath: targetPath,
          message: `Queued ${safeName} to Sticker Foundry!`,
        });
      } catch (err) {
        if (err?.code === 'EPERM' || err?.code === 'EACCES') {
          sendJson(res, 403, {
            error:
              'macOS blocked writing to ~/Downloads/Sticker Foundry/incoming from this background shell. Run "cd ~/Documents/coding && bash start.sh" in your Terminal so it has Downloads permission.',
          });
          return;
        }
        throw err;
      }
      return;
    }

    if (req.method === 'GET') {
      await serveStatic(url.pathname, res);
      return;
    }

    sendJson(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    sendJson(res, 500, { error: err.message || 'Internal server error' });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Sticker Booth running at http://127.0.0.1:${PORT}`);
  startRelayPoller();
});
