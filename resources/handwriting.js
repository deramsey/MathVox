// "Draw the equation by hand" panel: a drawing pad whose strokes are
// recognized on this device by the Texo model (see handwriting-worker.js).
// The model (~33MB, ~17MB compressed) only downloads the first time the
// panel is opened; after that the browser's cache serves it.
//
// Flow: draw -> recognized automatically after a short pause -> the result
// is shown (rendered, spoken text for screen readers, and LaTeX) -> "Insert
// into Equation" puts it at the cursor in the equation field. Recognition
// isn't perfect, so the person always checks before inserting.
import { preprocessInk, normalizeRecognizedLatex } from './pure-logic.js';

const PAUSE_MS = 700;      // wait this long after the last stroke
const RENDER_LINE = 3.5;   // stroke width, in CSS px, of the copy the model sees

export function setupHandwriting({ onInsert, toSpeech, announce }) {
    const panel = document.querySelector('#draw-panel');
    const canvas = document.querySelector('#draw-canvas');
    const statusEl = document.querySelector('#draw-status');
    const progressWrap = document.querySelector('#draw-progress-wrap');
    const progressEl = document.querySelector('#draw-progress');
    const resultEl = document.querySelector('#draw-result');
    const previewEl = document.querySelector('#draw-preview');
    const spokenEl = document.querySelector('#draw-spoken');
    const latexEl = document.querySelector('#draw-latex');
    const undoBtn = document.querySelector('#draw-undo');
    const clearBtn = document.querySelector('#draw-clear');
    const insertBtn = document.querySelector('#draw-insert');
    if (!panel || !canvas) return;

    const ctx = canvas.getContext('2d');
    const strokes = [];        // each stroke: [[x, y], ...] in CSS px
    let current = null;
    let worker = null;
    let modelState = 'idle';   // idle | loading | ready | failed
    let recognizedLatex = '';
    let timer = 0;
    let busy = false;
    let again = false;
    let requestId = 0;
    const loadedBytes = new Map();
    const totalBytes = new Map();

    const setStatus = (text) => { statusEl.textContent = text; };

    function updateButtons() {
        const empty = strokes.length === 0;
        undoBtn.disabled = empty;
        clearBtn.disabled = empty;
        insertBtn.disabled = !recognizedLatex;
    }

    // ---- Drawing ----------------------------------------------------------
    function fitCanvas() {
        const rect = canvas.getBoundingClientRect();
        if (!rect.width) return;
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.round(rect.width * dpr);
        canvas.height = Math.round(rect.height * dpr);
        redraw();
    }

    function redraw() {
        const dpr = canvas.width / (canvas.getBoundingClientRect().width || 1);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        // The page's text color (CanvasText in high contrast mode), so ink
        // stays visible on the pad's themed background.
        ctx.strokeStyle = getComputedStyle(canvas).color;
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        for (const s of strokes) drawStroke(ctx, s);
        if (current) drawStroke(ctx, current);
    }

    function drawStroke(c, s) {
        c.beginPath();
        c.moveTo(s[0][0], s[0][1]);
        if (s.length === 1) c.lineTo(s[0][0] + 0.1, s[0][1]);
        for (let i = 1; i < s.length; i++) c.lineTo(s[i][0], s[i][1]);
        c.stroke();
    }

    const point = (e) => {
        const r = canvas.getBoundingClientRect();
        return [e.clientX - r.left, e.clientY - r.top];
    };

    canvas.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        canvas.setPointerCapture(e.pointerId);
        clearTimeout(timer);
        current = [point(e)];
        redraw();
    });
    canvas.addEventListener('pointermove', (e) => {
        if (!current) return;
        const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
        for (const ev of events) current.push(point(ev));
        redraw();
    });
    const endStroke = () => {
        if (!current) return;
        strokes.push(current);
        current = null;
        redraw();
        updateButtons();
        scheduleRecognition();
    };
    canvas.addEventListener('pointerup', endStroke);
    canvas.addEventListener('pointercancel', endStroke);

    undoBtn.addEventListener('click', () => {
        strokes.pop();
        redraw();
        afterEdit();
        announce(strokes.length ? 'Last stroke removed.' : 'Drawing is empty.');
    });
    clearBtn.addEventListener('click', () => {
        clearDrawing();
        announce('Drawing cleared.');
    });

    function clearDrawing() {
        strokes.length = 0;
        redraw();
        afterEdit();
    }

    function afterEdit() {
        updateButtons();
        if (strokes.length) {
            scheduleRecognition();
        } else {
            clearTimeout(timer);
            showResult('');
        }
    }

    // ---- Recognition ------------------------------------------------------
    function scheduleRecognition() {
        clearTimeout(timer);
        timer = setTimeout(recognize, PAUSE_MS);
    }

    // The model sees a black-on-white copy at 1x (the pad itself follows the
    // page theme), drawn just around the ink.
    function inkPixels() {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const s of strokes) for (const [x, y] of s) {
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
        const pad = 16;
        const w = Math.ceil(maxX - minX + 2 * pad), h = Math.ceil(maxY - minY + 2 * pad);
        const off = document.createElement('canvas');
        off.width = w; off.height = h;
        const c = off.getContext('2d');
        c.fillStyle = '#fff';
        c.fillRect(0, 0, w, h);
        c.translate(pad - minX, pad - minY);
        c.strokeStyle = '#000';
        c.lineWidth = RENDER_LINE;
        c.lineCap = 'round';
        c.lineJoin = 'round';
        for (const s of strokes) drawStroke(c, s);
        const rgba = c.getImageData(0, 0, w, h).data;
        const grey = new Uint8ClampedArray(w * h);
        for (let i = 0; i < grey.length; i++) grey[i] = 0.299 * rgba[4 * i] + 0.587 * rgba[4 * i + 1] + 0.114 * rgba[4 * i + 2];
        return preprocessInk(grey, w, h);
    }

    async function recognize() {
        if (!strokes.length) return;
        if (modelState !== 'ready') { again = true; return; }
        if (busy) { again = true; return; }
        busy = true;
        again = false;
        const pixels = inkPixels();
        if (!pixels) { busy = false; return; }
        const id = ++requestId;
        worker.postMessage({ type: 'recognize', id, pixels }, [pixels.buffer]);
    }

    async function showResult(raw) {
        recognizedLatex = normalizeRecognizedLatex(raw);
        updateButtons();
        if (!recognizedLatex) {
            resultEl.hidden = true;
            previewEl.textContent = '';
            spokenEl.textContent = '';
            latexEl.textContent = '';
            return;
        }
        resultEl.hidden = false;
        latexEl.textContent = recognizedLatex;
        try {
            previewEl.innerHTML = window.MathLive.convertLatexToMarkup(recognizedLatex);
        } catch (err) {
            previewEl.textContent = recognizedLatex;
        }
        let spoken = '';
        try {
            spoken = await toSpeech(recognizedLatex);
        } catch (err) {
            spoken = '';
        }
        spokenEl.textContent = spoken || recognizedLatex;
        // Announced (not shown again; the result is right there on screen),
        // and the ready/loading message is cleared so it doesn't linger.
        setStatus('');
        announce(`Recognized: ${spoken || recognizedLatex}. Check it, then select Insert into Equation.`);
    }

    insertBtn.addEventListener('click', () => {
        if (!recognizedLatex) return;
        onInsert(recognizedLatex);
        clearDrawing();
        setStatus('');
        announce('Added to the equation. The drawing pad is cleared for the next part.');
    });

    // ---- Model loading (first open only) ----------------------------------
    function startWorker() {
        if (worker) return;
        if (typeof WebAssembly !== 'object' || typeof Worker !== 'function') {
            modelState = 'failed';
            setStatus('Handwriting recognition isn’t supported in this browser. Use the equation field or the LaTeX box instead.');
            return;
        }
        modelState = 'loading';
        setStatus('Downloading the handwriting model (about 17 MB, first time only)…');
        progressWrap.hidden = false;
        worker = new Worker(new URL('./handwriting-worker.js', import.meta.url), { type: 'module' });
        worker.addEventListener('message', ({ data }) => {
            if (data.type === 'progress') {
                loadedBytes.set(data.file, data.loaded);
                totalBytes.set(data.file, data.total);
                const total = [...totalBytes.values()].reduce((a, b) => a + b, 0);
                const loaded = [...loadedBytes.values()].reduce((a, b) => a + b, 0);
                if (total) progressEl.value = Math.round((loaded / total) * 100);
            } else if (data.type === 'ready') {
                modelState = 'ready';
                progressWrap.hidden = true;
                setStatus('Handwriting recognition is ready. Draw your equation in the box.');
                if (again || strokes.length) recognize();
            } else if (data.type === 'result') {
                busy = false;
                if (again) {
                    recognize();
                } else if (data.id === requestId && strokes.length) {
                    showResult(data.latex);
                }
            } else if (data.type === 'error') {
                busy = false;
                if (modelState === 'loading' || data.id === undefined) {
                    modelState = 'failed';
                    progressWrap.hidden = true;
                    setStatus('The handwriting model couldn’t load. Check your internet connection, then close and reopen this panel.');
                    worker.terminate();
                    worker = null;
                } else {
                    setStatus('That drawing couldn’t be recognized. Try drawing it again.');
                }
            }
        });
        worker.postMessage({ type: 'load' });
    }

    panel.addEventListener('toggle', () => {
        if (!panel.open) return;
        fitCanvas();
        if (modelState === 'idle' || modelState === 'failed') startWorker();
    });
    window.addEventListener('resize', () => { if (panel.open) fitCanvas(); });
    // Repaint the ink when Dark Mode or high contrast changes its color.
    new MutationObserver(redraw).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    updateButtons();
}

