import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  Download,
  ExternalLink,
  Eye,
  FlipHorizontal2,
  Loader2,
  Maximize2,
  Play,
  Printer,
  QrCode,
  RefreshCw,
  RotateCcw,
  Smartphone,
  Sparkles,
  Trash2,
  Upload,
  User,
  X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

function VexoMark({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 214 192"
      fill="currentColor"
      aria-label="Vexo"
      className={className}
    >
      <path d="M121.46 8.18 L153.96 66.18 A16 16 0 0 1 140 90 L75 90 A16 16 0 0 1 61.04 66.18 L93.54 8.18 A16 16 0 0 1 121.46 8.18Z" />
      <path d="M62.46 110.18 L94.96 168.18 A16 16 0 0 1 81 192 L16 192 A16 16 0 0 1 2.04 168.18 L34.54 110.18 A16 16 0 0 1 62.46 110.18Z" />
      <path d="M179.46 110.18 L211.96 168.18 A16 16 0 0 1 198 192 L133 192 A16 16 0 0 1 119.04 168.18 L151.54 110.18 A16 16 0 0 1 179.46 110.18Z" />
    </svg>
  );
}

type Route = '/' | '/queue';
type StyleKey = 'chibi' | 'watercolor' | 'realistic';

interface PrinterInfo {
  name: string;
  status: string;
  enabled: boolean;
}

interface PixCutStatus {
  connected: boolean;
  name?: string;
  address?: string;
  transport?: string;
  keepaliveMode?: string;
  model?: string;
  serial?: string;
  state?: string;
  subState?: string;
  alerts?: string;
  faults?: { code: string; message: string }[];
  latchedJobs?: number[];
  busy?: boolean;
  error?: string;
}

interface GalleryItem {
  filename: string;
  imageUrl: string;
}

interface PrintJob {
  id: number;
  filename: string;
  guestName?: string;
  source?: 'booth' | 'qr';
  sheetPreviewUrl?: string | null;
  previewUrl?: string;
  phase?: string;
  progressStage?: string;
  progressText?: string;
  pct?: number;
  transport?: string;
  copies: number;
  status: 'queued' | 'printing' | 'done' | 'error';
  message?: string;
  error?: string;
}

interface PrintQueueState {
  activeJob: PrintJob | null;
  queued: PrintJob[];
  history: PrintJob[];
  pausedReason?: string | null;
}

interface MobileQrInfo {
  enabled: boolean;
  shareUrl?: string;
  relayUrl?: string;
}

const STYLES: {
  id: StyleKey;
  label: string;
  subtitle: string;
  exampleUrl: string;
}[] = [
  {
    id: 'chibi',
    label: 'Chibi',
    subtitle: 'Cute 2.5D vinyl',
    exampleUrl: '/examples/chibi.jpg',
  },
  {
    id: 'watercolor',
    label: 'Watercolor',
    subtitle: 'Ink & wash',
    exampleUrl: '/examples/watercolor.jpg',
  },
  {
    id: 'realistic',
    label: 'Realistic',
    subtitle: 'Studio likeness',
    exampleUrl: '/examples/realistic.jpg',
  },
];

function getRouteFromPath(pathname: string): Route {
  return pathname === '/queue' || pathname === '/queue/' ? '/queue' : '/';
}

export default function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const snapPreviewTimerRef = useRef<number | null>(null);

  const [route, setRoute] = useState<Route>(() =>
    getRouteFromPath(window.location.pathname)
  );

  const [mirrored, setMirrored] = useState(true);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [snapFlash, setSnapFlash] = useState(false);
  const [snapPreviewUrl, setSnapPreviewUrl] = useState<string | null>(null);

  const [capturedDataUrl, setCapturedDataUrl] = useState<string | null>(null);
  const [selectedStyle, setSelectedStyle] = useState<StyleKey>('chibi');
  const [customNote, setCustomNote] = useState('');
  const [guestName, setGuestName] = useState('');
  const guestNameRef = useRef('');
  const [selectedModel, setSelectedModel] = useState('gemini-nano-banana-2.1');

  const dispatchedFilesRef = useRef<Set<string>>(new Set());
  const [queuedJobsByFile, setQueuedJobsByFile] = useState<Record<string, PrintJob>>({});

  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const generateAbortRef = useRef<AbortController | null>(null);
  const generateRequestIdRef = useRef(0);
  const [stickerFile, setStickerFile] = useState<GalleryItem | null>(null);
  const [gallery, setGallery] = useState<GalleryItem[]>([]);

  const [mobileQr, setMobileQr] = useState<MobileQrInfo>({ enabled: false });
  const [qrModalOpen, setQrModalOpen] = useState(false);
  const [previewModalJob, setPreviewModalJob] = useState<PrintJob | null>(null);

  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null);
  const [printers, setPrinters] = useState<PrinterInfo[]>([]);
  const [defaultPrinter, setDefaultPrinter] = useState<string | null>(null);
  const [selectedPrinter, setSelectedPrinter] = useState('');
  const [mediaOptions, setMediaOptions] = useState<string[]>([]);
  const [selectedMedia, setSelectedMedia] = useState('');
  const [copies, setCopies] = useState(1);
  const [printerMessage, setPrinterMessage] = useState('Checking connected printers…');
  const [pixcut, setPixcut] = useState<PixCutStatus>({ connected: false });
  const [refreshingPrinters, setRefreshingPrinters] = useState(false);
  const [clearingFault, setClearingFault] = useState(false);
  const [dieCutTransparent, setDieCutTransparent] = useState(true);
  const [autoPrint, setAutoPrint] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [resumingQueue, setResumingQueue] = useState(false);
  const [queueState, setQueueState] = useState<PrintQueueState>({
    activeJob: null,
    queued: [],
    history: [],
    pausedReason: null,
  });

  const [toast, setToast] = useState<{ text: string; isError?: boolean } | null>(null);

  function navigate(target: Route) {
    if (target === route) return;
    window.history.pushState(null, '', target);
    setRoute(target);
  }

  useEffect(() => {
    const onPopState = () => setRoute(getRouteFromPath(window.location.pathname));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 960 } },
          audio: false,
        });
        if (!active) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
        setCameraReady(true);
      } catch {
        if (active) setCameraError(true);
      }
    })();

    return () => {
      active = false;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (route === '/' && videoRef.current && streamRef.current) {
      if (videoRef.current.srcObject !== streamRef.current) {
        videoRef.current.srcObject = streamRef.current;
      }
      videoRef.current.play().catch(() => {});
    }
  }, [route]);

  async function checkHealth() {
    try {
      const res = await fetch('/api/health');
      const data = await res.json();
      setHasApiKey(Boolean(data.hasApiKey));
      if (data.defaultModel) setSelectedModel(data.defaultModel);
    } catch {
      setHasApiKey(false);
    }
  }

  async function refreshPrinters(forceRefresh = false) {
    setRefreshingPrinters(true);
    try {
      const [cupsRes, pixcutRes] = await Promise.all([
        fetch('/api/printers'),
        fetch(forceRefresh ? '/api/pixcut/status?refresh=1' : '/api/pixcut/status'),
      ]);
      const data = await cupsRes.json();
      const list: PrinterInfo[] = data.printers || [];
      setPrinters(list);
      setDefaultPrinter(data.defaultPrinter || null);
      setSelectedPrinter(data.defaultPrinter || list[0]?.name || '');
      setMediaOptions(data.mediaOptions || []);
      setPrinterMessage(data.message || '');

      if (pixcutRes.ok) {
        const pData: PixCutStatus = await pixcutRes.json();
        setPixcut(pData);
      }
    } catch {
      setPrinterMessage('Unable to query printers.');
    } finally {
      setRefreshingPrinters(false);
    }
  }

  async function loadGallery() {
    try {
      const res = await fetch('/api/gallery');
      const data = await res.json();
      setGallery(data.items || []);
    } catch {
      // Ignore
    }
  }

  async function loadQueue() {
    try {
      const res = await fetch('/api/queue');
      if (res.ok) {
        const data: PrintQueueState = await res.json();
        setQueueState(data);
      }
    } catch {
      // Ignore
    }
  }

  async function loadMobileQr() {
    try {
      const res = await fetch('/api/mobile-qr');
      if (res.ok) {
        const data: MobileQrInfo = await res.json();
        setMobileQr(data);
      }
    } catch {
      // Ignore
    }
  }

  useEffect(() => {
    checkHealth();
    refreshPrinters();
    loadGallery();
    loadQueue();
    loadMobileQr();
    return () => {
      if (snapPreviewTimerRef.current !== null) {
        window.clearTimeout(snapPreviewTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    guestNameRef.current = guestName;
  }, [guestName]);

  useEffect(() => {
    const hasPendingLocal = Object.keys(queuedJobsByFile).length > 0;
    if (
      !mobileQr.enabled &&
      route !== '/queue' &&
      !queueState.activeJob &&
      queueState.queued.length === 0 &&
      !queueState.pausedReason &&
      !hasPendingLocal
    ) {
      return;
    }
    const timer = setInterval(loadQueue, 1500);
    return () => clearInterval(timer);
  }, [
    mobileQr.enabled,
    route,
    queueState.activeJob,
    queueState.queued.length,
    queueState.pausedReason,
    queuedJobsByFile,
  ]);

  function findJobForFilename(filename: string | undefined): PrintJob | null {
    if (!filename) return null;
    if (queueState.activeJob?.filename === filename) return queueState.activeJob;
    const queuedMatch = queueState.queued.find((j) => j.filename === filename);
    if (queuedMatch) return queuedMatch;
    const doneMatch = queueState.history.find(
      (j) => j.filename === filename && j.status === 'done'
    );
    if (doneMatch) return doneMatch;
    return queuedJobsByFile[filename] || null;
  }

  function triggerBriefSnapPreview(dataUrl: string) {
    if (snapPreviewTimerRef.current !== null) {
      window.clearTimeout(snapPreviewTimerRef.current);
    }
    setSnapFlash(true);
    window.setTimeout(() => setSnapFlash(false), 150);
    setSnapPreviewUrl(dataUrl);
    snapPreviewTimerRef.current = window.setTimeout(() => {
      setSnapPreviewUrl(null);
      snapPreviewTimerRef.current = null;
    }, 1200);
  }

  function snapFromVideo() {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !video.videoWidth) {
      setToast({ text: 'Camera feed not ready yet — or upload a photo.', isError: true });
      return;
    }
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.save();
    if (mirrored) {
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    ctx.restore();
    const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
    if (stickerFile && findJobForFilename(stickerFile.filename)) {
      setGuestName('');
      setCustomNote('');
    }
    setCapturedDataUrl(dataUrl);
    setStickerFile(null);
    setToast(null);
    triggerBriefSnapPreview(dataUrl);
    video.play().catch(() => {});
    void handleGenerate(dataUrl);
  }

  function cancelInFlightGeneration() {
    if (generateAbortRef.current) {
      generateAbortRef.current.abort();
      generateAbortRef.current = null;
    }
    generateRequestIdRef.current += 1;
    setGenerating(false);
  }

  async function handleCountdownSnap() {
    cancelInFlightGeneration();
    setGenerateError(null);
    setSnapPreviewUrl(null);
    for (const n of [3, 2, 1]) {
      setCountdown(n);
      await new Promise((r) => setTimeout(r, 850));
    }
    setCountdown(null);
    snapFromVideo();
  }

  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const inputEl = e.target;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        const dataUrl = reader.result;
        if (stickerFile && findJobForFilename(stickerFile.filename)) {
          setGuestName('');
          setCustomNote('');
        }
        setCapturedDataUrl(dataUrl);
        setStickerFile(null);
        setToast(null);
        triggerBriefSnapPreview(dataUrl);
        void handleGenerate(dataUrl);
      }
      inputEl.value = '';
    };
    reader.readAsDataURL(file);
  }

  async function printSheet(filename: string) {
    setPrinting(true);
    setToast({ text: 'Sending sticker sheet to printer…' });
    try {
      const res = await fetch('/api/print', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename,
          printer: selectedPrinter || undefined,
          media: selectedMedia || undefined,
          copies,
          fitToPage: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Print failed');
      setToast({ text: `Sent to printer. ${data.stdout || ''}`.trim() });
    } catch (err) {
      setToast({
        text: err instanceof Error ? err.message : 'Print failed',
        isError: true,
      });
    } finally {
      setPrinting(false);
    }
  }

  async function makeTransparentBackground(imageUrl: string): Promise<string> {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Failed to load image for transparency'));
      img.src = imageUrl;
    });

    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas unavailable');

    ctx.drawImage(img, 0, 0);
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const { data, width, height } = imgData;
    const visited = new Uint8Array(width * height);
    const queue = new Int32Array(width * height);
    let head = 0;
    let tail = 0;

    const isBgLike = (idx: number) => {
      const p = idx * 4;
      const r = data[p], g = data[p + 1], b = data[p + 2], a = data[p + 3];
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      return a < 20 || mn >= 242 || (mn >= 214 && mx - mn <= 15);
    };

    const pushIfWhite = (x: number, y: number) => {
      const idx = y * width + x;
      if (!visited[idx] && isBgLike(idx)) {
        visited[idx] = 1;
        queue[tail++] = idx;
      }
    };

    for (let x = 0; x < width; x++) {
      pushIfWhite(x, 0);
      pushIfWhite(x, height - 1);
    }
    for (let y = 0; y < height; y++) {
      pushIfWhite(0, y);
      pushIfWhite(width - 1, y);
    }

    while (head < tail) {
      const idx = queue[head++];
      data[idx * 4 + 3] = 0;
      const x = idx % width;
      const y = (idx - x) / width;
      if (x > 0) pushIfWhite(x - 1, y);
      if (x < width - 1) pushIfWhite(x + 1, y);
      if (y > 0) pushIfWhite(x, y - 1);
      if (y < height - 1) pushIfWhite(x, y + 1);
    }

    ctx.putImageData(imgData, 0, 0);
    return canvas.toDataURL('image/png');
  }

  async function printPixCutDirect(
    item: GalleryItem,
    options?: { force?: boolean; promptForName?: boolean; guestName?: string; copies?: number }
  ) {
    const force = Boolean(options?.force);
    let effectiveName = (options?.guestName ?? guestNameRef.current).trim();
    if (!effectiveName && options?.promptForName) {
      const entered = window.prompt(
        'Enter guest name to print on the sticker sheet (required):'
      );
      effectiveName = entered?.trim() || '';
      if (!effectiveName) {
        return;
      }
    }
    if (!effectiveName) {
      setToast({
        text: 'Please enter your name above — Your Name is required to print.',
        isError: true,
      });
      document.getElementById('guest-name-input')?.focus();
      return;
    }
    if (!force) {
      if (dispatchedFilesRef.current.has(item.filename) || findJobForFilename(item.filename)) {
        return;
      }
      dispatchedFilesRef.current.add(item.filename);
    }
    setPrinting(true);
    setToast({ text: 'Generating PLT cut path & adding to print queue…' });
    try {
      const transparentDataUrl = dieCutTransparent
        ? await makeTransparentBackground(item.imageUrl)
        : undefined;
      const res = await fetch('/api/pixcut/print', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: item.filename,
          guestName: effectiveName,
          force,
          transparentDataUrl,
          copies: options?.copies ?? copies,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to queue print job');
      if (data.job) {
        setQueuedJobsByFile((prev) => ({ ...prev, [item.filename]: data.job }));
      }
      if (!force) {
        setCapturedDataUrl(null);
        setSnapPreviewUrl(null);
        setGuestName('');
        setCustomNote('');
      }
      setToast({ text: data.message });
      await loadQueue();
    } catch (err) {
      if (!force) {
        dispatchedFilesRef.current.delete(item.filename);
      }
      setToast({
        text: err instanceof Error ? err.message : 'Failed to queue print job',
        isError: true,
      });
    } finally {
      setPrinting(false);
    }
  }

  async function handleRemoveQueuedJob(id: number) {
    try {
      const res = await fetch('/api/queue/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to remove queued job');
      if (data.removed?.filename) {
        dispatchedFilesRef.current.delete(data.removed.filename);
        setQueuedJobsByFile((prev) => {
          const next = { ...prev };
          delete next[data.removed.filename];
          return next;
        });
      }
      setToast({ text: `Removed #${id} from queue` });
      await loadQueue();
    } catch (err) {
      setToast({
        text: err instanceof Error ? err.message : 'Failed to remove job',
        isError: true,
      });
    }
  }

  async function handleDedupeQueue() {
    try {
      const res = await fetch('/api/queue/dedupe', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to deduplicate queue');
      setToast({
        text:
          data.removedCount > 0
            ? `Removed ${data.removedCount} duplicate job${data.removedCount === 1 ? '' : 's'} from queue`
            : 'No duplicates in queue',
      });
      await loadQueue();
    } catch (err) {
      setToast({
        text: err instanceof Error ? err.message : 'Failed to deduplicate queue',
        isError: true,
      });
    }
  }

  async function handleClearHistory() {
    await fetch('/api/queue/clear', { method: 'POST' });
    await loadQueue();
  }

  async function handleResumeQueue() {
    setResumingQueue(true);
    setToast({ text: 'Clearing printer fault & resuming queue…' });
    try {
      const res = await fetch('/api/queue/resume', { method: 'POST' });
      const data = await res.json();
      if (!res.ok || data.ok === false) {
        throw new Error(data.error || 'Failed to resume queue');
      }
      setToast({ text: data.message || 'Queue resumed!' });
      await Promise.all([loadQueue(), refreshPrinters()]);
    } catch (err) {
      setToast({
        text: err instanceof Error ? err.message : 'Failed to resume queue',
        isError: true,
      });
    } finally {
      setResumingQueue(false);
    }
  }

  async function handleClearFault() {
    setClearingFault(true);
    setToast({ text: 'Clearing printer fault…' });
    try {
      const res = await fetch('/api/pixcut/clear-fault', { method: 'POST' });
      const data = await res.json();
      if (!res.ok || data.ok === false) {
        throw new Error(data.error || 'Failed to clear fault');
      }
      setToast({ text: 'Printer fault cleared' });
      await refreshPrinters();
    } catch (err) {
      setToast({
        text: err instanceof Error ? err.message : 'Failed to clear fault',
        isError: true,
      });
    } finally {
      setClearingFault(false);
    }
  }

  async function handleGenerate(overrideImageUrl?: string) {
    const imgSource =
      typeof overrideImageUrl === 'string' ? overrideImageUrl : capturedDataUrl;
    if (!imgSource) return;

    cancelInFlightGeneration();
    const requestId = generateRequestIdRef.current;
    const controller = new AbortController();
    generateAbortRef.current = controller;

    setGenerating(true);
    setGenerateError(null);
    setStickerFile(null);
    setToast({ text: 'Generating cute sticker sheet with Nano Banana 2.1…' });
    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          imageDataUrl: imgSource,
          style: selectedStyle,
          customNote,
          model: selectedModel,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Generation failed');
      if (controller.signal.aborted || requestId !== generateRequestIdRef.current) {
        return;
      }

      const created: GalleryItem = {
        filename: data.filename,
        imageUrl: `${data.imageUrl}?t=${Date.now()}`,
      };
      setStickerFile(created);
      setToast({ text: 'Sticker sheet ready!' });
      await loadGallery();

      if (controller.signal.aborted || requestId !== generateRequestIdRef.current) {
        return;
      }

      if (autoPrint) {
        if (pixcut.connected) {
          if (!guestNameRef.current.trim()) {
            setToast({ text: 'Sticker sheet ready! Enter your name below to print.' });
            document.getElementById('guest-name-input')?.focus();
          } else {
            await printPixCutDirect(created);
          }
        } else if (printers.length > 0) {
          await printSheet(data.filename);
        }
      }
    } catch (err) {
      if (
        controller.signal.aborted ||
        (err instanceof DOMException && err.name === 'AbortError') ||
        requestId !== generateRequestIdRef.current
      ) {
        return;
      }
      const msg = err instanceof Error ? err.message : 'Generation failed';
      setGenerateError(msg);
      setToast({
        text: msg,
        isError: true,
      });
    } finally {
      if (requestId === generateRequestIdRef.current) {
        if (generateAbortRef.current === controller) {
          generateAbortRef.current = null;
        }
        setGenerating(false);
      }
    }
  }

  const activeQueueCount =
    (queueState.activeJob ? 1 : 0) + queueState.queued.length;

  const currentSheetJob = findJobForFilename(stickerFile?.filename);
  const currentQueuePos = currentSheetJob
    ? queueState.queued.findIndex((j) => j.id === currentSheetJob.id) + 1
    : 0;

  const duplicateQueueCount = (() => {
    const seen = new Set<string>();
    if (queueState.activeJob?.filename) {
      seen.add(queueState.activeJob.filename);
    }
    for (const h of queueState.history) {
      if (h.status === 'done') seen.add(h.filename);
    }
    let dups = 0;
    for (const q of queueState.queued) {
      if (seen.has(q.filename)) dups++;
      else seen.add(q.filename);
    }
    return dups;
  })();

  const allQueueJobs = [
    ...(queueState.activeJob ? [queueState.activeJob] : []),
    ...queueState.queued,
    ...queueState.history,
  ];

  return (
    <div className="min-h-screen px-4 py-6 sm:px-8">
      {/* Minimal Editorial Top Nav */}
      <header className="no-print mx-auto mb-8 flex max-w-6xl flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-xl border border-[#e5dfd3] bg-[#f7f5f0] text-[#111111] shadow-2xs">
            <VexoMark className="h-5 w-5" />
          </div>
          <div>
            <p className="text-xs font-medium text-[#737373]">
              AI Wearables Hackathon · YC × Google DeepMind · Gemini
            </p>
            <h1 className="text-lg font-semibold tracking-tight text-[#111111]">
              VexoHacks Sticker Booth
            </h1>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <nav
            aria-label="Primary"
            className="inline-flex items-center rounded-full border border-[#e5e5e7] bg-white p-1"
          >
            <button
              type="button"
              onClick={() => navigate('/')}
              className={cn(
                'rounded-full px-4 py-1.5 text-xs font-medium transition-colors cursor-pointer',
                route === '/'
                  ? 'bg-[#111111] text-white'
                  : 'text-[#525252] hover:text-[#111111]'
              )}
            >
              Booth
            </button>
            <button
              type="button"
              onClick={() => navigate('/queue')}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-xs font-medium transition-colors cursor-pointer',
                route === '/queue'
                  ? 'bg-[#111111] text-white'
                  : 'text-[#525252] hover:text-[#111111]'
              )}
            >
              <span>Queue</span>
              {activeQueueCount > 0 && (
                <span
                  className={cn(
                    'inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-none',
                    route === '/queue'
                      ? 'bg-white text-[#111111]'
                      : 'bg-[#111111] text-white'
                  )}
                >
                  {activeQueueCount}
                </span>
              )}
            </button>
          </nav>

          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={hasApiKey ? 'success' : 'warning'}>
              <span
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  hasApiKey ? 'bg-emerald-500' : 'bg-amber-500'
                )}
              />
              {hasApiKey === null
                ? 'Checking API…'
                : hasApiKey
                  ? 'Gemini API Ready'
                  : 'Missing API Key'}
            </Badge>
            <Badge
              variant={
                pixcut.connected || printers.length > 0 ? 'success' : 'muted'
              }
            >
              <Printer className="h-3 w-3" />
              {pixcut.connected
                ? 'PixCut S1'
                : printers.length > 0
                  ? `CUPS: ${defaultPrinter || printers[0].name}`
                  : 'No Printer'}
            </Badge>
          </div>
        </div>
      </header>

      {mobileQr.enabled && (
        <div className="no-print mx-auto mb-6 flex max-w-6xl flex-wrap items-center justify-between gap-4 rounded-2xl border border-[#e5e5e7] bg-white p-3.5 shadow-2xs">
          <div className="flex items-center gap-3.5 min-w-0">
            <img
              src="/api/mobile-qr.svg"
              alt="Mobile QR Code"
              className="h-20 w-20 shrink-0 rounded-xl border border-[#e5e5e7] bg-white p-1"
            />
            <div className="min-w-0 space-y-0.5">
              <div className="flex items-center gap-1.5 text-sm font-semibold text-[#111111]">
                <QrCode className="h-4 w-4 shrink-0 text-[#FF6600]" />
                <span>Skip the line — Create Stickers from Your Phone</span>
              </div>
              <p className="text-xs text-[#737373]">
                Scan with your camera to snap a selfie, pick a style &amp; send straight to the PixCut S1 print queue.
              </p>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setQrModalOpen(true)}
          >
            <Maximize2 className="h-3.5 w-3.5" />
            Enlarge QR
          </Button>
        </div>
      )}

      {route === '/' ? (
        /* Main 2-Column Booth */
        <main className="mx-auto grid max-w-6xl grid-cols-1 gap-6 lg:grid-cols-2">
          {/* Left Card: Capture & Style */}
          <Card className="no-print">
            <CardHeader>
              <CardTitle>1. Take a Photo</CardTitle>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setMirrored((m) => !m)}
                >
                  <FlipHorizontal2 className="h-3.5 w-3.5" />
                  Mirror
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Upload className="h-3.5 w-3.5" />
                  Upload
                </Button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={handleFileUpload}
                />
              </div>
            </CardHeader>

            <CardContent className="space-y-5">
              <div className="relative aspect-[4/3] w-full overflow-hidden rounded-xl bg-[#141416]">
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  className={cn(
                    'h-full w-full object-cover',
                    mirrored && 'scale-x-[-1]'
                  )}
                />
                {snapPreviewUrl && (
                  <img
                    src={snapPreviewUrl}
                    alt="Captured photo"
                    className="absolute inset-0 h-full w-full object-cover"
                  />
                )}
                {snapFlash && (
                  <div className="pointer-events-none absolute inset-0 bg-white/85 transition-opacity" />
                )}
                {capturedDataUrl && !snapPreviewUrl && countdown === null && (
                  <div className="absolute bottom-3 left-3 flex items-center gap-2 rounded-xl bg-black/70 p-1 pr-2 text-white backdrop-blur-xs">
                    <img
                      src={capturedDataUrl}
                      alt="Last snap"
                      className="h-12 w-16 rounded-lg object-cover"
                    />
                    <span className="text-[11px] font-medium">Last snap</span>
                    <button
                      type="button"
                      aria-label="Clear last snap"
                      onClick={() => setCapturedDataUrl(null)}
                      className="rounded-full p-0.5 text-white/80 hover:bg-white/20 hover:text-white cursor-pointer"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}
                {countdown !== null && (
                  <div className="absolute inset-0 grid place-items-center bg-black/40 text-7xl font-bold tracking-tight text-white">
                    {countdown}
                  </div>
                )}
                {cameraError && !snapPreviewUrl && (
                  <div className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-neutral-300">
                    Camera unavailable. Allow camera access or click Upload above.
                  </div>
                )}
              </div>
              <canvas ref={canvasRef} hidden />

              <div className="flex flex-wrap items-center gap-2.5">
                <Button
                  onClick={handleCountdownSnap}
                  disabled={!cameraReady || countdown !== null}
                >
                  <Camera className="h-4 w-4" />
                  Take Photo
                </Button>
                {capturedDataUrl && (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      cancelInFlightGeneration();
                      setGenerateError(null);
                      setCapturedDataUrl(null);
                      setSnapPreviewUrl(null);
                      setStickerFile(null);
                      setGuestName('');
                      setToast(null);
                    }}
                  >
                    <RotateCcw className="h-4 w-4" />
                    Clear Photo
                  </Button>
                )}
              </div>

              <div className="h-px bg-[#e5e5e7]" />

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold tracking-tight text-[#111111]">
                    2. Art Style
                  </h3>
                  <span className="text-[11px] text-[#737373]">
                    Auto-generates on snap
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-2.5">
                  {STYLES.map((s) => {
                    const active = selectedStyle === s.id;
                    return (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => setSelectedStyle(s.id)}
                        className={cn(
                          'flex flex-col overflow-hidden rounded-xl border p-1.5 text-left transition-all cursor-pointer',
                          active
                            ? 'border-[#FF6600] bg-orange-50/50 ring-2 ring-[#FF6600]/25'
                            : 'border-[#e5e5e7] bg-white hover:border-[#cfcfd4] hover:bg-[#fafafa]'
                        )}
                      >
                        <div className="aspect-square w-full overflow-hidden rounded-lg bg-[#fafafa]">
                          <img
                            src={s.exampleUrl}
                            alt={`${s.label} example`}
                            className="h-full w-full object-cover"
                          />
                        </div>
                        <div className="mt-1.5 px-1 pb-0.5">
                          <p className="text-xs font-semibold text-[#111111]">
                            {s.label}
                          </p>
                          <p className="text-[10px] leading-tight text-[#737373]">
                            {s.subtitle}
                          </p>
                        </div>
                      </button>
                    );
                  })}
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-[#737373]">
                    Custom prompt (optional)
                  </label>
                  <Input
                    value={customNote}
                    onChange={(e) => setCustomNote(e.target.value)}
                    placeholder="Write your own prompt if needed (e.g. wearing AR glasses, holding matcha, building robots)…"
                  />
                </div>

                <Button
                  size="lg"
                  className="w-full"
                  disabled={!capturedDataUrl || generating}
                  onClick={() => handleGenerate()}
                >
                  {generating ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Generating sticker sheet…
                    </>
                  ) : (
                    <>
                      <Sparkles className="h-4 w-4" />
                      {stickerFile ? 'Regenerate Stickers' : 'Generate Stickers'}
                    </>
                  )}
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Right Card: Sticker Sheet & Print */}
          <Card className="print-only-sheet">
            <CardHeader className="no-print">
              <CardTitle>3. Sticker Sheet &amp; Print</CardTitle>
              <label className="flex items-center gap-2 text-xs font-medium text-[#737373] cursor-pointer">
                <Switch checked={autoPrint} onCheckedChange={setAutoPrint} />
                Auto-print
              </label>
            </CardHeader>

            <CardContent className="space-y-5">
              <div className="grid min-h-[380px] place-items-center rounded-xl border border-dashed border-[#dcdce0] bg-[#fafafa] p-4 print-only-sheet">
                {generating ? (
                  <div className="no-print flex flex-col items-center gap-3 text-center">
                    <Loader2 className="h-7 w-7 animate-spin text-[#111111]" />
                    <p className="text-sm text-[#737373]">
                      Nano Banana 2.1 is illustrating your sticker sheet…
                    </p>
                  </div>
                ) : stickerFile ? (
                  currentSheetJob?.previewUrl?.startsWith('/output/sheet-') ? (
                    <img
                      src={currentSheetJob.previewUrl}
                      alt="Prepared 4x7 sticker sheet"
                      className="max-h-[560px] w-auto rounded-xl border border-[#e5e5e7] object-contain shadow-sm print-only-sheet"
                    />
                  ) : (
                    <div className="mx-auto flex w-full max-w-[330px] flex-col items-center gap-2 rounded-2xl border border-[#e6dec8] bg-[#f8f4eb] px-3.5 py-3 shadow-sm print-only-sheet">
                      <span className="inline-flex items-center gap-1.5 rounded-full border border-[#c6d2f6] bg-white px-2.5 py-0.5 text-[10px] font-semibold text-[#182030]">
                        <VexoMark className="h-2.5 w-2.5 text-[#111111]" />
                        VexoHacks × Google DeepMind · Gemini ✦
                      </span>
                      <div className="flex items-center gap-1.5">
                        <span className="grid h-4 w-4 place-items-center rounded-[3px] bg-[#FF6600] text-[10px] font-extrabold text-white">
                          Y
                        </span>
                        <span className="text-[11px] font-bold tracking-tight text-[#111111]">
                          Make Something People Want
                        </span>
                      </div>
                      <span
                        className={cn(
                          'max-w-full truncate rounded-full border-2 border-[#FF6600] bg-white px-3 py-0.5 text-[11px] font-bold',
                          guestName.trim()
                            ? 'text-[#111111]'
                            : 'border-dashed text-[#9ca3af]'
                        )}
                      >
                        {guestName.trim() || 'Your Name (type below ★)'}
                      </span>
                      <img
                        src={stickerFile.imageUrl}
                        alt="Generated sticker sheet"
                        className="max-h-[390px] w-full rounded-lg bg-white object-contain"
                      />
                      <span
                        className={cn(
                          'max-w-full truncate rounded-full border-2 border-[#FF6600] bg-white px-3 py-0.5 text-[11px] font-bold',
                          guestName.trim()
                            ? 'text-[#111111]'
                            : 'border-dashed text-[#9ca3af]'
                        )}
                      >
                        {guestName.trim() || 'Your Name Here'}
                      </span>
                      <span className="text-[9px] font-semibold text-[#525252]">
                        ✦ VexoHacks · YC × Google DeepMind · Built with Gemini
                      </span>
                    </div>
                  )
                ) : generateError ? (
                  <div className="no-print max-w-xs text-center space-y-3">
                    <div className="mx-auto grid h-10 w-10 place-items-center rounded-full bg-red-50 text-red-600">
                      <AlertTriangle className="h-4 w-4" />
                    </div>
                    <div className="space-y-1">
                      <p className="text-sm font-semibold text-red-700">Generation failed</p>
                      <p className="text-xs text-[#737373]">{generateError}</p>
                    </div>
                    {capturedDataUrl && (
                      <Button
                        size="sm"
                        onClick={() => handleGenerate()}
                        className="mx-auto"
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                        Retry Generation
                      </Button>
                    )}
                  </div>
                ) : (
                  <div className="no-print max-w-xs text-center space-y-2">
                    <div className="mx-auto grid h-10 w-10 place-items-center rounded-full bg-[#f1f1f3]">
                      <Sparkles className="h-4 w-4 text-[#525252]" />
                    </div>
                    <p className="text-sm text-[#737373]">
                      Snap or upload a solo or group photo on the left — stickers generate{' '}
                      <span className="font-medium text-[#111111]">
                        automatically
                      </span>
                      !
                    </p>
                  </div>
                )}
              </div>

              <div className="no-print space-y-4 border-t border-[#e5e5e7] pt-4">
                <div className="space-y-1.5">
                  <label
                    htmlFor="guest-name-input"
                    className="flex flex-wrap items-center gap-1.5 text-xs font-medium text-[#111111]"
                  >
                    <User className="h-3.5 w-3.5 text-[#FF6600]" />
                    <span>
                      Your Name <span className="text-red-600">*</span>
                    </span>
                    <span className="rounded-full bg-orange-100 px-2 py-0.5 text-[10px] font-semibold text-[#FF6600]">
                      Required · printed top &amp; bottom
                    </span>
                  </label>
                  <Input
                    id="guest-name-input"
                    required
                    value={guestName}
                    onChange={(e) => setGuestName(e.target.value)}
                    maxLength={40}
                    disabled={Boolean(currentSheetJob)}
                    className={cn(
                      stickerFile &&
                        !currentSheetJob &&
                        !guestName.trim() &&
                        'border-[#FF6600]/60 ring-2 ring-[#FF6600]/15'
                    )}
                    placeholder="Required — e.g. Alex (printed top & bottom of sheet)"
                  />
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-[#fafafa] px-3.5 py-2.5 border border-[#e5e5e7]">
                  <label className="flex items-center gap-2 text-xs font-medium text-[#525252] cursor-pointer">
                    <Switch
                      checked={dieCutTransparent}
                      onCheckedChange={setDieCutTransparent}
                    />
                    Shape die-cut (remove white background)
                  </label>

                  <div className="flex items-center gap-2">
                    <span className="text-xs text-[#737373]">Copies</span>
                    <Input
                      type="number"
                      min={1}
                      max={10}
                      value={copies}
                      onChange={(e) => setCopies(Number(e.target.value) || 1)}
                      className="h-8 w-16 text-center text-xs"
                    />
                  </div>
                </div>

                {!pixcut.connected && printers.length > 0 && (
                  <div className="grid grid-cols-2 gap-3">
                    <select
                      value={selectedPrinter}
                      onChange={(e) => setSelectedPrinter(e.target.value)}
                      className="h-9 w-full rounded-xl border border-[#e5e5e7] bg-white px-3 text-xs text-[#111111]"
                    >
                      {printers.map((p) => (
                        <option key={p.name} value={p.name}>
                          {p.name} (CUPS)
                        </option>
                      ))}
                    </select>
                    <select
                      value={selectedMedia}
                      onChange={(e) => setSelectedMedia(e.target.value)}
                      disabled={mediaOptions.length === 0}
                      className="h-9 w-full rounded-xl border border-[#e5e5e7] bg-white px-3 text-xs text-[#111111] disabled:opacity-50"
                    >
                      <option value="">Default media</option>
                      {mediaOptions.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-2">
                  {pixcut.connected && (
                    <Button
                      disabled={
                        !stickerFile ||
                        printing ||
                        Boolean(currentSheetJob) ||
                        !guestName.trim()
                      }
                      onClick={() => stickerFile && printPixCutDirect(stickerFile)}
                      className={cn(
                        currentSheetJob && 'disabled:opacity-100 text-white shadow-xs',
                        currentSheetJob?.status === 'printing'
                          ? 'bg-amber-600 hover:bg-amber-600'
                          : currentSheetJob
                            ? 'bg-emerald-600 hover:bg-emerald-600'
                            : ''
                      )}
                    >
                      {printing || currentSheetJob?.status === 'printing' ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : currentSheetJob ? (
                        <CheckCircle2 className="h-4 w-4" />
                      ) : (
                        <Printer className="h-4 w-4" />
                      )}
                      {printing
                        ? 'Adding to Queue…'
                        : currentSheetJob?.status === 'printing'
                          ? `Printing Now · Ticket #${currentSheetJob.id}`
                          : currentSheetJob?.status === 'done'
                            ? `Printed · Ticket #${currentSheetJob.id}`
                            : currentSheetJob
                              ? `Queued · Ticket #${currentSheetJob.id}`
                              : stickerFile && !guestName.trim()
                                ? 'Enter Your Name to Print'
                                : 'Print & Cut Stickers'}
                    </Button>
                  )}
                  {printers.length > 0 && (
                    <Button
                      variant={pixcut.connected ? 'secondary' : 'default'}
                      disabled={!stickerFile || printing}
                      onClick={() => stickerFile && printSheet(stickerFile.filename)}
                    >
                      <Printer className="h-4 w-4" />
                      Print (CUPS)
                    </Button>
                  )}
                  {stickerFile ? (
                    <a
                      href={stickerFile.imageUrl}
                      download={stickerFile.filename}
                      className="inline-flex h-10 items-center justify-center gap-2 rounded-full border border-[#e5e5e7] bg-white px-4 text-sm font-medium text-[#111111] hover:bg-[#f7f7f8]"
                    >
                      <Download className="h-4 w-4" />
                      Save PNG
                    </a>
                  ) : (
                    <Button variant="outline" disabled>
                      <Download className="h-4 w-4" />
                      Save PNG
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!stickerFile}
                    onClick={() => window.print()}
                  >
                    Browser Print
                  </Button>
                </div>

                {currentSheetJob && (
                  <div
                    className={cn(
                      'flex items-center justify-between gap-3 rounded-xl border px-3.5 py-3 text-xs',
                      currentSheetJob.status === 'printing'
                        ? 'border-amber-300 bg-amber-50 text-amber-950'
                        : 'border-emerald-300 bg-emerald-50 text-emerald-950'
                    )}
                  >
                    <div className="flex items-start gap-2.5 min-w-0">
                      {currentSheetJob.status === 'printing' ? (
                        <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-amber-700" />
                      ) : (
                        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700" />
                      )}
                      <div className="min-w-0 space-y-0.5">
                        <p className="font-semibold">
                          Ticket #{currentSheetJob.id}
                          {currentSheetJob.guestName
                            ? ` · ${currentSheetJob.guestName}`
                            : ''}
                        </p>
                        <p className="text-[11px] opacity-90">
                          {currentSheetJob.status === 'printing'
                            ? currentSheetJob.progressText ||
                              'Printing & kiss-cutting now on PixCut S1…'
                            : currentSheetJob.status === 'done'
                              ? 'Printed & kiss-cut! Pick up your sheet at the printer.'
                              : currentQueuePos > 0
                                ? `Confirmed in print queue (#${currentQueuePos} in line)`
                                : 'Confirmed in print queue!'}
                        </p>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => navigate('/queue')}
                      className="shrink-0 font-semibold underline cursor-pointer"
                    >
                      View Queue →
                    </button>
                  </div>
                )}

                {queueState.activeJob &&
                  queueState.activeJob.filename !== stickerFile?.filename && (
                    <div className="flex items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-xs text-amber-900">
                      <div className="flex items-center gap-2 min-w-0">
                        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-amber-700" />
                        <span className="truncate font-medium">
                          Printer busy: Ticket #{queueState.activeJob.id}
                          {queueState.activeJob.guestName
                            ? ` (${queueState.activeJob.guestName})`
                            : ''}
                          {queueState.queued.length > 0
                            ? ` · ${queueState.queued.length} waiting in queue`
                            : ''}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => navigate('/queue')}
                        className="shrink-0 font-semibold underline cursor-pointer"
                      >
                        View Queue
                      </button>
                    </div>
                  )}

                {queueState.pausedReason && (
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-300 bg-red-50 px-3.5 py-3 text-xs text-red-950">
                    <div className="flex items-start gap-2.5 min-w-0 flex-1">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
                      <div className="min-w-0 space-y-0.5">
                        <p className="font-semibold">
                          Printer Paused — Needs Ink Cartridge / Paper Check
                        </p>
                        <p className="text-[11px] opacity-90">
                          {queueState.pausedReason} All queued prints are safely saved in line.
                        </p>
                      </div>
                    </div>
                    <Button
                      size="sm"
                      disabled={resumingQueue}
                      onClick={handleResumeQueue}
                      className="shrink-0 bg-red-600 text-white hover:bg-red-700"
                    >
                      {resumingQueue ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Play className="h-3.5 w-3.5" />
                      )}
                      {resumingQueue ? 'Resuming…' : 'Resume Queue'}
                    </Button>
                  </div>
                )}

                {toast && (
                  <p
                    className={cn(
                      'text-xs font-medium',
                      toast.isError ? 'text-red-600' : 'text-[#525252]'
                    )}
                  >
                    {toast.text}
                  </p>
                )}
              </div>
            </CardContent>
          </Card>
        </main>
      ) : (
        /* Dedicated /queue Page: Printer Status, Print Queue & Recent Sticker Sheets */
        <main className="no-print mx-auto max-w-6xl space-y-6">
          {/* Live Liene PixCut S1 Status */}
          <Card>
            <CardHeader>
              <div className="space-y-1">
                <CardTitle>
                  {pixcut.connected
                    ? `${pixcut.name || 'Liene PixCut S1'} · 4 × 7 in`
                    : 'Liene PixCut S1'}
                </CardTitle>
                <p className="text-xs text-[#737373]">
                  {pixcut.connected
                    ? [
                        pixcut.transport === 'rfcomm'
                          ? 'Fast RFCOMM (110 KB/s) · Keep-alive active'
                          : 'Persistent BLE · Keep-alive active',
                        'Auto-off disabled',
                        pixcut.model || 'DHP700',
                        pixcut.serial ? `S/N ${pixcut.serial}` : null,
                        pixcut.busy
                          ? 'Printing…'
                          : pixcut.state
                            ? `State ${pixcut.state}`
                            : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')
                    : pixcut.error || printerMessage}
                </p>
                {pixcut.faults && pixcut.faults.length > 0 && (
                  <p className="text-xs font-medium text-red-600">
                    {pixcut.faults.map((f) => `${f.code}: ${f.message}`).join(' · ')}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2">
                {(pixcut.state === '60' ||
                  (pixcut.faults && pixcut.faults.length > 0) ||
                  (pixcut.latchedJobs && pixcut.latchedJobs.length > 0)) && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={clearingFault}
                    onClick={handleClearFault}
                  >
                    {clearingFault ? 'Clearing…' : 'Clear Fault'}
                  </Button>
                )}
                <Badge variant={pixcut.connected ? 'success' : 'muted'}>
                  <span
                    className={cn(
                      'h-1.5 w-1.5 rounded-full',
                      pixcut.connected ? 'bg-emerald-500' : 'bg-[#737373]'
                    )}
                  />
                  {pixcut.connected ? 'Connected' : 'Disconnected'}
                </Badge>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={refreshingPrinters}
                  onClick={() => refreshPrinters(true)}
                >
                  <RefreshCw
                    className={cn(
                      'h-3.5 w-3.5',
                      refreshingPrinters && 'animate-spin'
                    )}
                  />
                  Refresh
                </Button>
              </div>
            </CardHeader>
            {toast && (
              <CardContent className="pt-0">
                <p
                  className={cn(
                    'text-xs font-medium',
                    toast.isError ? 'text-red-600' : 'text-[#525252]'
                  )}
                >
                  {toast.text}
                </p>
              </CardContent>
            )}
          </Card>

          {/* Print Queue */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <CardTitle>Print Queue</CardTitle>
                {activeQueueCount > 0 && (
                  <Badge variant="default">{activeQueueCount} active</Badge>
                )}
              </div>
              <div className="flex items-center gap-2">
                {duplicateQueueCount > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleDedupeQueue}
                  >
                    Remove Duplicates ({duplicateQueueCount})
                  </Button>
                )}
                {queueState.history.length > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleClearHistory}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Clear history
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {queueState.pausedReason && (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-xs text-red-950">
                  <div className="flex items-start gap-2.5 min-w-0 flex-1">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
                    <div className="min-w-0 space-y-0.5">
                      <p className="text-sm font-semibold">
                        Printer Paused — Needs Ink Cartridge / Paper Check
                      </p>
                      <p className="opacity-90">
                        {queueState.pausedReason} All queued prints are safely saved in line.
                      </p>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    disabled={resumingQueue}
                    onClick={handleResumeQueue}
                    className="shrink-0 bg-red-600 text-white hover:bg-red-700"
                  >
                    {resumingQueue ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Play className="h-3.5 w-3.5" />
                    )}
                    {resumingQueue ? 'Resuming…' : 'Resume Queue'}
                  </Button>
                </div>
              )}
              {allQueueJobs.length === 0 ? (
                <p className="rounded-xl border border-dashed border-[#dcdce0] bg-[#fafafa] py-8 text-center text-sm text-[#737373]">
                  No active or recent print jobs.
                </p>
              ) : (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
                  {allQueueJobs.map((job) => {
                    const queuePos =
                      job.status === 'queued'
                        ? queueState.queued.findIndex((q) => q.id === job.id) + 1
                        : 0;
                    const imgSrc = job.previewUrl || `/output/${job.filename}`;
                    return (
                      <div
                        key={job.id}
                        className={cn(
                          'flex flex-col overflow-hidden rounded-2xl border bg-white shadow-2xs transition-colors',
                          job.status === 'printing'
                            ? 'border-amber-300 ring-2 ring-amber-200/60'
                            : 'border-[#e5e5e7]'
                        )}
                      >
                        <button
                          type="button"
                          onClick={() => setPreviewModalJob(job)}
                          className="group relative aspect-[4/7] w-full overflow-hidden bg-[#f8f4eb] text-left cursor-pointer"
                        >
                          <img
                            src={imgSrc}
                            alt={`Ticket #${job.id}`}
                            loading="lazy"
                            className="h-full w-full object-contain transition-transform duration-200 group-hover:scale-[1.02]"
                          />
                          <div className="absolute left-2 top-2 flex flex-wrap items-center gap-1">
                            <span className="rounded-full bg-[#111111]/85 px-2 py-0.5 text-[11px] font-semibold text-white backdrop-blur-xs">
                              #{job.id}
                            </span>
                            {job.source === 'qr' && (
                              <span className="inline-flex items-center gap-1 rounded-full bg-indigo-600/90 px-2 py-0.5 text-[10px] font-semibold text-white backdrop-blur-xs">
                                <Smartphone className="h-3 w-3" />
                                Phone QR
                              </span>
                            )}
                          </div>
                          <div className="absolute right-2 top-2">
                            <Badge
                              variant={
                                job.status === 'done'
                                  ? 'success'
                                  : job.status === 'error'
                                    ? 'warning'
                                    : 'muted'
                              }
                              className={cn(
                                'backdrop-blur-xs shadow-2xs',
                                job.status === 'printing' &&
                                  'border-amber-300 bg-amber-50/95 text-amber-800',
                                job.status === 'queued' &&
                                  'border-[#e5e5e7] bg-white/95 text-[#111111]',
                                job.status === 'error' &&
                                  'border-red-300 bg-red-50/95 text-red-700'
                              )}
                            >
                              {job.status === 'printing' && 'Printing…'}
                              {job.status === 'queued' &&
                                (queuePos > 0 ? `Queued #${queuePos}` : 'Queued')}
                              {job.status === 'done' && 'Printed & cut'}
                              {job.status === 'error' && 'Error'}
                            </Badge>
                          </div>
                        </button>

                        <div className="flex flex-1 flex-col justify-between gap-2.5 border-t border-[#e5e5e7] p-3">
                          <div className="space-y-1.5">
                            <div className="flex items-center justify-between gap-2">
                              {job.guestName ? (
                                <span className="max-w-full truncate rounded-full bg-orange-100 px-2.5 py-0.5 text-xs font-semibold text-[#FF6600]">
                                  {job.guestName}
                                </span>
                              ) : (
                                <span className="rounded-full bg-[#f1f1f3] px-2.5 py-0.5 text-xs font-medium text-[#737373]">
                                  No name
                                </span>
                              )}
                              {job.copies > 1 && (
                                <span className="shrink-0 text-xs font-semibold text-[#525252]">
                                  ×{job.copies}
                                </span>
                              )}
                            </div>

                            {job.status === 'printing' ? (
                              <div className="space-y-1">
                                <p className="truncate text-[11px] font-medium text-amber-800">
                                  {job.progressText || 'Printing & kiss-cutting…'}
                                </p>
                                {typeof job.pct === 'number' && (
                                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-amber-100">
                                    <div
                                      className="h-full rounded-full bg-amber-500 transition-all duration-300"
                                      style={{
                                        width: `${Math.max(4, Math.min(100, job.pct))}%`,
                                      }}
                                    />
                                  </div>
                                )}
                              </div>
                            ) : (
                              <p className="truncate text-[11px] text-[#737373]">
                                {job.status === 'error'
                                  ? job.error || 'Failed to print'
                                  : job.message || job.filename}
                              </p>
                            )}
                          </div>

                          <div className="flex items-center gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              className="flex-1"
                              onClick={() => setPreviewModalJob(job)}
                            >
                              <Eye className="h-3.5 w-3.5" />
                              View
                            </Button>
                            {job.status === 'error' && job.filename && (
                              <Button
                                variant="outline"
                                size="sm"
                                className="border-orange-200 text-[#FF6600] hover:bg-orange-50"
                                onClick={() =>
                                  printPixCutDirect(
                                    { filename: job.filename, imageUrl: `/output/${job.filename}` },
                                    {
                                      force: true,
                                      guestName: job.guestName || 'Guest',
                                      copies: job.copies || 1,
                                    }
                                  )
                                }
                              >
                                <RotateCcw className="h-3.5 w-3.5" />
                                Retry
                              </Button>
                            )}
                            {job.status === 'queued' && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="text-red-600 hover:bg-red-50 hover:text-red-700"
                                onClick={() => handleRemoveQueuedJob(job.id)}
                              >
                                Remove
                              </Button>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Recent Sticker Sheets */}
          <Card>
            <CardHeader>
              <CardTitle>Recent Sticker Sheets</CardTitle>
              <span className="text-xs text-[#737373]">Saved in output/</span>
            </CardHeader>
            <CardContent>
              {gallery.length === 0 ? (
                <p className="rounded-xl border border-dashed border-[#dcdce0] bg-[#fafafa] py-8 text-center text-sm text-[#737373]">
                  No sticker sheets generated yet. Head to Booth to create one.
                </p>
              ) : (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
                  {gallery.map((item) => {
                    const activeOrQueued =
                      queueState.activeJob?.filename === item.filename
                        ? queueState.activeJob
                        : queueState.queued.find((j) => j.filename === item.filename);
                    return (
                      <div
                        key={item.filename}
                        className="flex flex-col overflow-hidden rounded-2xl border border-[#e5e5e7] bg-white"
                      >
                        <div className="aspect-[3/4] w-full overflow-hidden bg-[#fafafa]">
                          <img
                            src={item.imageUrl}
                            alt={item.filename}
                            className="h-full w-full object-cover"
                          />
                        </div>
                        <div className="flex flex-col gap-2 border-t border-[#e5e5e7] p-3">
                          <p className="truncate text-xs font-medium text-[#525252]">
                            {item.filename}
                          </p>
                          <div className="flex items-center gap-2">
                            <Button
                              size="sm"
                              className="flex-1"
                              disabled={
                                printing ||
                                Boolean(activeOrQueued) ||
                                (!pixcut.connected && printers.length === 0)
                              }
                              onClick={() =>
                                pixcut.connected
                                  ? printPixCutDirect(item, { force: true, promptForName: true })
                                  : printSheet(item.filename)
                              }
                            >
                              <Printer className="h-3.5 w-3.5" />
                              {activeOrQueued
                                ? `Ticket #${activeOrQueued.id}`
                                : 'Print & Cut'}
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => {
                                setStickerFile(item);
                                navigate('/');
                              }}
                            >
                              <ExternalLink className="h-3.5 w-3.5" />
                              View on Booth
                            </Button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </main>
      )}

      {qrModalOpen && mobileQr.enabled && (
        <div
          className="no-print fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 backdrop-blur-xs"
          onClick={() => setQrModalOpen(false)}
        >
          <div
            className="relative w-full max-w-sm rounded-3xl border border-[#e5e5e7] bg-white p-6 text-center shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              aria-label="Close QR modal"
              onClick={() => setQrModalOpen(false)}
              className="absolute right-4 top-4 rounded-full p-1.5 text-[#737373] hover:bg-[#f1f1f3] hover:text-[#111111] cursor-pointer"
            >
              <X className="h-4 w-4" />
            </button>
            <div className="mx-auto mb-3 inline-flex items-center gap-1.5 rounded-full bg-orange-50 px-3 py-1 text-xs font-semibold text-[#FF6600]">
              <QrCode className="h-3.5 w-3.5" />
              Scan to Print from Your Phone
            </div>
            <h2 className="text-lg font-semibold text-[#111111]">
              VexoHacks × YC × DeepMind Booth
            </h2>
            <p className="mt-1 text-xs text-[#737373]">
              Point your iPhone or Android camera here to generate &amp; queue your 4×7&quot; die-cut sticker sheet.
            </p>
            <img
              src="/api/mobile-qr.svg"
              alt="Mobile QR Code"
              className="mx-auto my-5 h-72 w-72 rounded-2xl border border-[#e5e5e7] bg-white p-3 shadow-xs"
            />
            <Button
              variant="outline"
              className="w-full"
              onClick={() => setQrModalOpen(false)}
            >
              Done
            </Button>
          </div>
        </div>
      )}

      {previewModalJob && (
        <div
          className="no-print fixed inset-0 z-50 grid place-items-center bg-black/65 p-4 backdrop-blur-xs"
          onClick={() => setPreviewModalJob(null)}
        >
          <div
            className="relative flex max-h-[92vh] w-full max-w-md flex-col gap-3 rounded-3xl border border-[#e5e5e7] bg-white p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 min-w-0">
                <span className="font-semibold text-[#111111]">
                  Ticket #{previewModalJob.id}
                </span>
                {previewModalJob.guestName && (
                  <span className="truncate rounded-full bg-orange-100 px-2.5 py-0.5 text-xs font-semibold text-[#FF6600]">
                    {previewModalJob.guestName}
                  </span>
                )}
              </div>
              <button
                type="button"
                aria-label="Close preview modal"
                onClick={() => setPreviewModalJob(null)}
                className="rounded-full p-1.5 text-[#737373] hover:bg-[#f1f1f3] hover:text-[#111111] cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="overflow-auto rounded-2xl border border-[#e5e5e7] bg-[#f8f4eb] p-2">
              <img
                src={
                  previewModalJob.previewUrl ||
                  `/output/${previewModalJob.filename}`
                }
                alt={`Ticket #${previewModalJob.id}`}
                className="mx-auto max-h-[68vh] w-auto rounded-xl object-contain"
              />
            </div>
            <div className="flex items-center justify-between gap-2 text-xs text-[#525252]">
              <span className="truncate">
                {previewModalJob.status === 'printing'
                  ? previewModalJob.progressText || 'Printing & kiss-cutting…'
                  : previewModalJob.status === 'error'
                    ? previewModalJob.error || 'Error'
                    : previewModalJob.message || previewModalJob.status}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPreviewModalJob(null)}
              >
                Close
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
