const video = document.getElementById('video');
const capturedPreview = document.getElementById('capturedPreview');
const captureCanvas = document.getElementById('captureCanvas');
const countdownOverlay = document.getElementById('countdownOverlay');
const cameraError = document.getElementById('cameraError');

const mirrorBtn = document.getElementById('mirrorBtn');
const fileInput = document.getElementById('fileInput');
const countdownSnapBtn = document.getElementById('countdownSnapBtn');
const instantSnapBtn = document.getElementById('instantSnapBtn');
const retakeBtn = document.getElementById('retakeBtn');

const stylePills = document.getElementById('stylePills');
const customNote = document.getElementById('customNote');
const modelSelect = document.getElementById('modelSelect');
const generateBtn = document.getElementById('generateBtn');

const emptyState = document.getElementById('emptyState');
const loadingState = document.getElementById('loadingState');
const stickerImage = document.getElementById('stickerImage');

const apiStatusPill = document.getElementById('apiStatusPill');
const printerStatusPill = document.getElementById('printerStatusPill');
const printerMessage = document.getElementById('printerMessage');
const printerSelect = document.getElementById('printerSelect');
const mediaSelect = document.getElementById('mediaSelect');
const copiesInput = document.getElementById('copiesInput');
const refreshPrintersBtn = document.getElementById('refreshPrintersBtn');
const autoPrintToggle = document.getElementById('autoPrintToggle');

const cupsPrintBtn = document.getElementById('cupsPrintBtn');
const browserPrintBtn = document.getElementById('browserPrintBtn');
const downloadLink = document.getElementById('downloadLink');
const statusToast = document.getElementById('statusToast');
const galleryGrid = document.getElementById('galleryGrid');

let mirrored = true;
let selectedStyle = 'kawaii';
let capturedDataUrl = null;
let currentStickerFilename = null;
let hasCupsPrinter = false;

function setToast(msg, isError = false) {
  statusToast.textContent = msg;
  statusToast.style.color = isError ? '#c5221f' : '#6738ea';
}

async function initCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 960 } },
      audio: false,
    });
    video.srcObject = stream;
    cameraError.classList.add('hidden');
  } catch {
    cameraError.classList.remove('hidden');
  }
}

function showCapturedPhoto(dataUrl) {
  capturedDataUrl = dataUrl;
  capturedPreview.src = dataUrl;
  capturedPreview.classList.remove('hidden');
  video.classList.add('hidden');
  retakeBtn.classList.remove('hidden');
  generateBtn.disabled = false;
}

function snapFromVideo() {
  if (!video.videoWidth || !video.videoHeight) {
    setToast('Camera feed not ready yet — or upload a photo.', true);
    return;
  }
  captureCanvas.width = video.videoWidth;
  captureCanvas.height = video.videoHeight;
  const ctx = captureCanvas.getContext('2d');
  if (mirrored) {
    ctx.translate(captureCanvas.width, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(video, 0, 0, captureCanvas.width, captureCanvas.height);
  showCapturedPhoto(captureCanvas.toDataURL('image/jpeg', 0.92));
}

async function countdownSnap() {
  countdownSnapBtn.disabled = true;
  instantSnapBtn.disabled = true;
  countdownOverlay.classList.remove('hidden');

  for (const n of [3, 2, 1]) {
    countdownOverlay.textContent = String(n);
    await new Promise((r) => setTimeout(r, 850));
  }

  countdownOverlay.classList.add('hidden');
  snapFromVideo();
  countdownSnapBtn.disabled = false;
  instantSnapBtn.disabled = false;
}

function resetCameraPreview() {
  capturedDataUrl = null;
  capturedPreview.classList.add('hidden');
  video.classList.remove('hidden');
  retakeBtn.classList.add('hidden');
  generateBtn.disabled = true;
}

function showStickerResult(filename, imageUrl) {
  currentStickerFilename = filename;
  stickerImage.src = `${imageUrl}?t=${Date.now()}`;
  stickerImage.classList.remove('hidden');
  emptyState.classList.add('hidden');
  loadingState.classList.add('hidden');

  browserPrintBtn.disabled = false;
  cupsPrintBtn.disabled = !hasCupsPrinter;
  downloadLink.href = imageUrl;
  downloadLink.download = filename;
  downloadLink.classList.remove('disabled');
}

async function checkHealth() {
  try {
    const res = await fetch('/api/health');
    const data = await res.json();
    if (data.hasApiKey) {
      apiStatusPill.textContent = 'Gemini API Ready';
      apiStatusPill.className = 'pill pill-ok';
    } else {
      apiStatusPill.textContent = 'Missing GEMINI_API_KEY';
      apiStatusPill.className = 'pill pill-warn';
    }
  } catch {
    apiStatusPill.textContent = 'Server Offline';
    apiStatusPill.className = 'pill pill-warn';
  }
}

async function refreshPrinters() {
  try {
    const res = await fetch('/api/printers');
    const data = await res.json();
    const printers = data.printers || [];
    hasCupsPrinter = printers.length > 0;

    printerSelect.innerHTML = '';
    mediaSelect.innerHTML = '';

    if (hasCupsPrinter) {
      printerStatusPill.textContent = `Printer: ${data.defaultPrinter || printers[0].name}`;
      printerStatusPill.className = 'pill pill-ok';
      printerMessage.textContent = data.message;

      for (const p of printers) {
        const opt = document.createElement('option');
        opt.value = p.name;
        opt.textContent = `${p.name} (${p.enabled ? 'ready' : 'disabled'})`;
        if (p.name === data.defaultPrinter) opt.selected = true;
        printerSelect.appendChild(opt);
      }
      printerSelect.disabled = false;

      const defaultOpt = document.createElement('option');
      defaultOpt.value = '';
      defaultOpt.textContent = 'Printer default';
      mediaSelect.appendChild(defaultOpt);

      for (const m of data.mediaOptions || []) {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m;
        mediaSelect.appendChild(opt);
      }
      mediaSelect.disabled = false;
    } else {
      printerStatusPill.textContent = 'No CUPS Printer';
      printerStatusPill.className = 'pill pill-warn';
      printerMessage.textContent = data.message;

      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No printer detected';
      printerSelect.appendChild(opt);
      printerSelect.disabled = true;

      const mOpt = document.createElement('option');
      mOpt.value = '';
      mOpt.textContent = 'Default';
      mediaSelect.appendChild(mOpt);
      mediaSelect.disabled = true;
    }

    cupsPrintBtn.disabled = !(hasCupsPrinter && currentStickerFilename);
  } catch {
    printerStatusPill.textContent = 'Printer Check Failed';
    printerStatusPill.className = 'pill pill-warn';
  }
}

async function loadGallery() {
  try {
    const res = await fetch('/api/gallery');
    const data = await res.json();
    galleryGrid.innerHTML = '';
    for (const item of data.items || []) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'gallery-item';
      btn.title = item.filename;
      const img = document.createElement('img');
      img.src = item.imageUrl;
      img.alt = item.filename;
      btn.appendChild(img);
      btn.addEventListener('click', () => {
        showStickerResult(item.filename, item.imageUrl);
        setToast(`Loaded ${item.filename}`);
      });
      galleryGrid.appendChild(btn);
    }
  } catch {
    // Ignore gallery errors
  }
}

async function printCurrentStickers() {
  if (!currentStickerFilename) return;
  cupsPrintBtn.disabled = true;
  setToast('Sending sticker sheet to printer…');

  try {
    const res = await fetch('/api/print', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: currentStickerFilename,
        printer: printerSelect.value || undefined,
        media: mediaSelect.value || undefined,
        copies: Number(copiesInput.value) || 1,
        fitToPage: true,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Print failed');
    setToast(`Sent to printer! ${data.stdout || ''}`.trim());
  } catch (err) {
    setToast(`Print error: ${err.message}`, true);
  } finally {
    cupsPrintBtn.disabled = !hasCupsPrinter;
  }
}

async function generateStickers() {
  if (!capturedDataUrl) return;
  generateBtn.disabled = true;
  emptyState.classList.add('hidden');
  stickerImage.classList.add('hidden');
  loadingState.classList.remove('hidden');
  setToast('Generating cute sticker sheet with Nano Banana…');

  try {
    const res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        imageDataUrl: capturedDataUrl,
        style: selectedStyle,
        customNote: customNote.value,
        model: modelSelect.value,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Generation failed');

    showStickerResult(data.filename, data.imageUrl);
    setToast('Sticker sheet ready!');
    await loadGallery();

    if (autoPrintToggle.checked && hasCupsPrinter) {
      await printCurrentStickers();
    }
  } catch (err) {
    loadingState.classList.add('hidden');
    emptyState.classList.remove('hidden');
    setToast(`Generation error: ${err.message}`, true);
  } finally {
    generateBtn.disabled = false;
  }
}

mirrorBtn.addEventListener('click', () => {
  mirrored = !mirrored;
  video.classList.toggle('mirrored', mirrored);
});

fileInput.addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    if (typeof reader.result === 'string') {
      showCapturedPhoto(reader.result);
    }
  };
  reader.readAsDataURL(file);
});

countdownSnapBtn.addEventListener('click', countdownSnap);
instantSnapBtn.addEventListener('click', snapFromVideo);
retakeBtn.addEventListener('click', resetCameraPreview);

stylePills.addEventListener('click', (e) => {
  const btn = e.target.closest('.style-pill');
  if (!btn) return;
  for (const el of stylePills.querySelectorAll('.style-pill')) {
    el.classList.remove('active');
  }
  btn.classList.add('active');
  selectedStyle = btn.dataset.style || 'kawaii';
});

generateBtn.addEventListener('click', generateStickers);
refreshPrintersBtn.addEventListener('click', refreshPrinters);
cupsPrintBtn.addEventListener('click', printCurrentStickers);
browserPrintBtn.addEventListener('click', () => window.print());

initCamera();
checkHealth();
refreshPrinters();
loadGallery();
