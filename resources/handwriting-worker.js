// Web Worker for handwriting recognition: runs the Texo model
// (github.com/alephpi/Texo, AGPL-3.0; 8-bit quantized ONNX files in
// vendor/texo/) with Transformers.js + ONNX Runtime Web (vendor/transformers/).
// Everything loads from MathVox's own site; nothing is sent anywhere.
// Kept in a worker so recognition (about half a second) never freezes the page.
import { env, VisionEncoderDecoderModel, PreTrainedTokenizer, Tensor, cat } from './vendor/transformers/transformers.min.js';

const vendor = new URL('./vendor/', import.meta.url).href;
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = vendor;
// The plain WebAssembly build (11MB), not the 21MB WebGPU one.
env.backends.onnx.wasm.wasmPaths = {
    mjs: `${vendor}transformers/ort-wasm-simd-threaded.mjs`,
    wasm: `${vendor}transformers/ort-wasm-simd-threaded.wasm`
};
// Several threads only work when the page is cross-origin isolated (the
// COOP/COEP headers in vercel.json); otherwise ONNX Runtime uses one.
if (self.crossOriginIsolated) {
    env.backends.onnx.wasm.numThreads = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
}

let ready = null;
let model, tokenizer;

function load() {
    if (!ready) {
        ready = (async () => {
            const progress = (p) => {
                if (p.status === 'progress' && p.total) {
                    postMessage({ type: 'progress', file: p.file, loaded: p.loaded, total: p.total });
                }
            };
            model = await VisionEncoderDecoderModel.from_pretrained('texo', { dtype: 'q8', device: 'wasm', progress_callback: progress });
            tokenizer = await PreTrainedTokenizer.from_pretrained('texo');
            postMessage({ type: 'ready' });
        })();
        ready.catch(() => { ready = null; });
    }
    return ready;
}

self.onmessage = async ({ data }) => {
    try {
        if (data.type === 'load') {
            await load();
        } else if (data.type === 'recognize') {
            await load();
            const input = new Tensor('float32', data.pixels, [1, 1, 384, 384]);
            const ids = await model.generate({ inputs: cat([input, input, input], 1), max_new_tokens: 256 });
            const latex = tokenizer.batch_decode(ids, { skip_special_tokens: true })[0] || '';
            postMessage({ type: 'result', id: data.id, latex });
        }
    } catch (err) {
        postMessage({ type: 'error', id: data.id, message: String((err && err.message) || err) });
    }
};
