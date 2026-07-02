import { ComputeEngine } from './vendor/compute-engine/compute-engine.min.esm.js';

// MathLive needs a Compute Engine instance available before it can export
// the "math-json" format. This must be set before any getValue('math-json')
// call is made.
window.MathfieldElement.computeEngine = new ComputeEngine();

const mf = document.querySelector('#formula');
const formatSelect = document.querySelector('#format-select');
const formatNameEl = document.querySelector('#format-name');
const textCont = document.querySelector('#text-cont');
const copyBtn = document.querySelector('#copy');
const readBtn = document.querySelector('#read');
const themeToggle = document.querySelector('#theme-toggle');
const dyslexiaToggle = document.querySelector('#dyslexia-toggle');

const FORMAT_LABELS = {
    'latex': 'LaTeX',
    'ascii-math': 'ASCII Math',
    'math-ml': 'MathML',
    'math-json': 'MathJSON',
    'spoken-text': 'Description (plain-language text)',
    'braille': 'Braille (Nemeth)'
};

const EMPTY_MESSAGE = 'Enter a math expression above to see it here.';

// Speech Rule Engine (SRE) is only needed for the Braille (Nemeth) format.
// Kick off loading its Nemeth rule set as soon as the page loads so the
// first Braille request doesn't have to wait on it. setupEngine() returns
// a promise that resolves once the rules are ready to use.
let sreBrailleReady = null;
function getSreBrailleReady() {
    if (!sreBrailleReady) {
        sreBrailleReady = SRE.setupEngine({ modality: 'braille', locale: 'nemeth' });
    }
    return sreBrailleReady;
}
getSreBrailleReady();

function debounce(fn, delay) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), delay);
    };
}

async function updateOutput() {
    const format = formatSelect.value;
    const label = FORMAT_LABELS[format] || format;
    formatNameEl.textContent = label;
    copyBtn.setAttribute('aria-label', `Copy ${label} output to clipboard`);
    textCont.classList.toggle('braille-output', format === 'braille');

    const latex = (mf.getValue('latex') || '').trim();
    if (!latex) {
        textCont.textContent = EMPTY_MESSAGE;
        return;
    }

    if (format === 'braille') {
        textCont.textContent = 'Generating Braille…';
        try {
            await getSreBrailleReady();
            const mathml = mf.getValue('math-ml');
            const braille = SRE.toSpeech(mathml);
            textCont.textContent = braille || 'No Braille output was generated for this expression.';
        } catch (err) {
            console.error('Braille generation failed', err);
            textCont.textContent = 'Braille output is unavailable right now.';
        }
        return;
    }

    if (format === 'math-json') {
        try {
            const json = mf.getValue('math-json');
            textCont.textContent = JSON.stringify(json, null, 2);
        } catch (err) {
            console.error('MathJSON generation failed', err);
            textCont.textContent = 'MathJSON output is unavailable right now.';
        }
        return;
    }

    textCont.textContent = mf.getValue(format);
}

function speakEquation() {
    mf.executeCommand('speak');
}

async function copyOutput() {
    try {
        await navigator.clipboard.writeText(textCont.textContent);
    } catch (err) {
        console.error('Failed to copy text', err);
    }
}

function setTheme(dark) {
    document.documentElement.classList.toggle('theme-dark', dark);
    themeToggle.setAttribute('aria-pressed', String(dark));
    themeToggle.textContent = dark ? 'Light Mode' : 'Dark Mode';
    localStorage.setItem('mathvox-theme', dark ? 'dark' : 'light');
}

function setDyslexiaFont(on) {
    document.documentElement.classList.toggle('dyslexia-font', on);
    dyslexiaToggle.setAttribute('aria-pressed', String(on));
    localStorage.setItem('mathvox-dyslexia-font', on ? 'on' : 'off');
}

// Restore saved preferences, falling back to the OS-level color scheme
// for the theme when the user hasn't chosen one yet.
const savedTheme = localStorage.getItem('mathvox-theme');
const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
setTheme(savedTheme ? savedTheme === 'dark' : prefersDark);
setDyslexiaFont(localStorage.getItem('mathvox-dyslexia-font') === 'on');

mf.addEventListener('input', debounce(updateOutput, 300));
formatSelect.addEventListener('change', updateOutput);
readBtn.addEventListener('click', speakEquation);
copyBtn.addEventListener('click', copyOutput);
themeToggle.addEventListener('click', () => setTheme(!document.documentElement.classList.contains('theme-dark')));
dyslexiaToggle.addEventListener('click', () => setDyslexiaFont(!document.documentElement.classList.contains('dyslexia-font')));

updateOutput();
