import { ComputeEngine } from './vendor/compute-engine/compute-engine.min.esm.js';
import {
    findMathJsonError,
    unquote,
    describeMathJsonError,
    escapeXmlText,
    LATEX_ERROR_MESSAGES,
    describeLatexError,
    findBraceImbalance,
    describeAmbiguities,
    findAmbiguousOccurrences,
    meaningsFor,
    applyIntents,
    cleanUpMathLiveMathml,
    rewriteLatexForExport,
    findConversionProblems,
    resolveIntentChoices,
    defaultMeaning,
    suggestMeaning
} from './pure-logic.js';

// MathLive needs a Compute Engine instance available before it can export
// the "math-json" format. This must be set before any getValue('math-json')
// call is made.
window.MathfieldElement.computeEngine = new ComputeEngine();

// Use Speech Rule Engine's "mathspeak" rules (the same academic-standard
// speech rules already used for Braille below, via the same vendored `sre.js`)
// for both the "spoken-text" format and the "Read Equation Aloud" button,
// instead of MathLive's simpler built-in speech rules. QA found the built-in
// rules wrap single-letter variables in literal quotes and capitalize them
// (e.g. "'x' equals..."), which reads like a typo in the Description panel
// and can make some TTS engines audibly say "quote" -- undercutting the
// exact thing this tool exists to do. Must be set before any getValue()
// or 'speak' command.
window.MathfieldElement.textToSpeechRules = 'sre';
window.MathfieldElement.textToSpeechRulesOptions = {
    domain: 'mathspeak',
    ruleset: 'mathspeak-default'
};

const mf = document.querySelector('#formula');

// MathLive doesn't pass the host's aria-label (or the sr-only <label>) on
// to the role="textbox" element inside its shadow root that actually takes
// focus, so screen readers announced an unnamed edit field. MathLive itself
// sets that element's aria-label to the spoken equation after some edits
// (its announce hook, "line" action) and leaves it blank otherwise -- so
// keep its text when there is some, and fill in a real label when blank.
function labelMathfieldInput() {
    const sink = mf.shadowRoot && mf.shadowRoot.querySelector('[role="textbox"]');
    if (!sink) return;
    const fallback = mf.getAttribute('aria-label') || 'Enter a math expression';
    const ensureLabel = () => {
        if (!(sink.getAttribute('aria-label') || '').trim()) sink.setAttribute('aria-label', fallback);
    };
    ensureLabel();
    new MutationObserver(ensureLabel).observe(sink, { attributes: true, attributeFilter: ['aria-label'] });
}
labelMathfieldInput();
const formatSelect = document.querySelector('#format-select');
const formatNameEl = document.querySelector('#format-name');
const textCont = document.querySelector('#text-cont');
const copyBtn = document.querySelector('#copy');
const shareBtn = document.querySelector('#share-link');
const readBtn = document.querySelector('#read');
const themeToggle = document.querySelector('#theme-toggle');
const dyslexiaToggle = document.querySelector('#dyslexia-toggle');
const latexInput = document.querySelector('#latex-input');
const convertBtn = document.querySelector('#convert');
const latexErrorEl = document.querySelector('#latex-error');
const svgPreviewEl = document.querySelector('#svg-preview');
const downloadSvgBtn = document.querySelector('#download-svg');
const svgAltWrapEl = document.querySelector('#svg-alt-wrap');
const suggestedAltEl = document.querySelector('#svg-alt-suggestion');
const copyAltTextBtn = document.querySelector('#copy-alt-text');
const mathmlNotesEl = document.querySelector('#mathml-notes');
const conversionWarningEl = document.querySelector('#conversion-warning');
const outputStatusEl = document.querySelector('#output-status');
const codeDetailsEl = document.querySelector('#code-details');
const codeSummaryEl = document.querySelector('#code-summary');
const downloadSvgCornerBtn = document.querySelector('#download-svg-corner');

// localStorage can be unavailable (private browsing, blocked site data,
// quota) and then throws on *any* access -- including at startup, where an
// uncaught error would stop this whole module before a single listener is
// attached. Losing persistence isn't fatal, so every access goes through
// these.
function storageGet(key) {
    try {
        return localStorage.getItem(key);
    } catch (err) {
        return null;
    }
}

function storageSet(key, value) {
    try {
        localStorage.setItem(key, value);
    } catch (err) {
        // Skip persistence; see storageGet.
    }
}

// Short screen-reader announcement via the #output-status live region
// (the output panel itself isn't live -- see index.html). Cleared first so
// repeating the same message (e.g. copying twice) is still announced.
function announce(message) {
    outputStatusEl.textContent = '';
    setTimeout(() => { outputStatusEl.textContent = message; }, 50);
}

const MATHML_NAMESPACE = 'http://www.w3.org/1998/Math/MathML';
const LATEX_STORAGE_KEY = 'mathvox-latex';
const FORMAT_STORAGE_KEY = 'mathvox-format';
// URL hash param names for the shareable-link feature (see updateUrlHash()/
// restoreEquationState() below) -- kept short since they end up in a URL
// someone might paste somewhere.
const EQ_HASH_PARAM = 'eq';
const FORMAT_HASH_PARAM = 'format';
// Author-chosen MathML intents (see "MathML intent" in pure-logic.js):
// an object mapping an ambiguous shape's key (e.g. "(0, 5)#1") to the
// intent concept picked for it (e.g. "open-interval"). Saved alongside the
// equation, and carried in shareable links, so a choice isn't lost on
// reload or when sending the link to someone.
const INTENT_HASH_PARAM = 'intent';
const INTENT_STORAGE_KEY = 'mathvox-intents';
let intentChoices = {};

function parseIntentChoices(raw) {
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const clean = {};
        for (const [k, v] of Object.entries(parsed)) {
            if (typeof v === 'string') clean[k] = v;
        }
        return clean;
    } catch (err) {
        return {};
    }
}

// MathML "semantic ambiguity" audit + author-chosen intent (see
// MATHML_SEMANTIC_LINT_PLAN.md for background, and PROJECT_NOTES.md for the
// September 2026 redesign and the intent feature built on top of it). The
// tree logic lives in pure-logic.js (findAmbiguousOccurrences/applyIntents)
// so it can be unit-tested in Node against @xmldom/xmldom-built trees; this
// file just handles the browser-only DOMParser/XMLSerializer steps.
function parseMathmlFragment(mathmlFragment) {
    try {
        // Wrapped in a synthetic root: mf.getValue('math-ml') isn't
        // guaranteed to have exactly one top-level element, and XML parsing
        // requires a single root.
        const doc = new DOMParser().parseFromString(`<root>${mathmlFragment}</root>`, 'application/xml');
        if (doc.querySelector('parsererror')) return null;
        return doc;
    } catch (err) {
        return null;
    }
}

// Forget choices for shapes that are no longer in the equation, so the
// saved state and shareable link don't accumulate stale entries.
function pruneIntentChoices(occurrences) {
    const live = new Set(occurrences.map((o) => o.key));
    let changed = false;
    for (const key of Object.keys(intentChoices)) {
        if (!live.has(key)) {
            delete intentChoices[key];
            changed = true;
        }
    }
    return changed;
}

function serializeChildren(root) {
    const serializer = new XMLSerializer();
    return Array.from(root.childNodes).map((n) => serializer.serializeToString(n)).join('');
}

// MathLive's MathML for the current equation. MathLive's exporter drops
// or garbles a handful of commands (\overline, \overrightarrow,
// \widehat, "\not=", ... -- see rewriteLatexForExport in pure-logic.js),
// so when the LaTeX contains one, convert a rewritten copy instead
// (MathLive.convertLatexToMathMl gives the same output as
// mf.getValue('math-ml') for everything else -- checked September 2026).
// The placeholders are swapped for the right symbols during cleanup.
function getRawMathml() {
    const latex = mf.getValue('latex') || '';
    const { latex: rewritten, placeholders, changed } = rewriteLatexForExport(latex);
    if (changed && window.MathLive && typeof window.MathLive.convertLatexToMathMl === 'function') {
        try {
            return { mathml: window.MathLive.convertLatexToMathMl(rewritten), placeholders };
        } catch (err) {
            console.error('Converting the rewritten LaTeX failed; using MathLive’s own MathML', err);
        }
    }
    return { mathml: mf.getValue('math-ml'), placeholders: [] };
}

// Parses and cleans up the current MathML once (see cleanUpMathLiveMathml
// in pure-logic.js). `raw` is the unparsed string, used as-is whenever
// nothing needed changing.
function getCleanedTree() {
    const { mathml, placeholders } = getRawMathml();
    const doc = parseMathmlFragment(mathml);
    if (!doc) return { raw: mathml, doc: null, changed: 0 };
    return { raw: mathml, doc, changed: cleanUpMathLiveMathml(doc.documentElement, placeholders) };
}

// MathLive's MathML with its known mistakes cleaned up (see
// cleanUpMathLiveMathml in pure-logic.js). E.g. a typed "|x|" otherwise
// comes out as "divides" characters with invisible multiplication, which
// Speech Rule Engine reads as "times" and brailles as Nemeth
// multiplication dots, and "f'(x)" loses its prime in braille entirely.
// Every output that feeds SRE or MathJax uses this, not the raw value.
function getCleanMathml() {
    try {
        const { raw, doc, changed } = getCleanedTree();
        if (!doc) return raw;
        return changed ? serializeChildren(doc.documentElement) : raw;
    } catch (err) {
        console.error('MathML cleanup failed; using MathLive’s MathML as-is', err);
        return mf.getValue('math-ml');
    }
}

// Formats built from MathML -- the ones a lost piece of the equation would
// silently break.
const MATHML_BASED_FORMATS = new Set(['math-ml', 'spoken-text', 'braille', 'svg']);

// Shows a warning above the output when the final MathML is visibly
// missing something (see findConversionProblems), so an incomplete
// description or braille string isn't passed on as if it were complete.
function updateConversionWarning(format, label) {
    conversionWarningEl.textContent = '';
    if (!MATHML_BASED_FORMATS.has(format)) return;
    const latex = (mf.getValue('latex') || '').trim();
    if (!latex) return;
    let problems = [];
    try {
        const { doc } = getCleanedTree();
        problems = findConversionProblems(latex, doc ? doc.documentElement : null);
    } catch (err) {
        problems = ['the equation could not be checked'];
    }
    if (problems.length) {
        conversionWarningEl.textContent = `Heads up: part of this equation didn’t convert correctly (${problems.join('; ')}), so the ${label} output below may be incomplete. Check it against the equation above before sharing it.`;
    }
}

// Returns the presentation MathML (bars cleaned up, chosen and default
// intents applied), the ambiguous-shape occurrences found, and any
// suggested meanings (both for the picker UI). Falls back to the untouched
// original markup whenever nothing changed or parsing fails, so the common
// case never goes through a re-serialization at all.
function buildIntentMathml() {
    const { raw: inner, doc, changed: cleaned } = getCleanedTree();
    if (!doc) return { markup: inner, occurrences: [], suggestions: {} };
    const root = doc.documentElement;
    const occurrences = findAmbiguousOccurrences(root);
    if (pruneIntentChoices(occurrences)) saveEquationState();
    // Suggestions look at the tree around each shape, so take them before
    // applyIntents regroups anything.
    const suggestions = {};
    for (const occ of occurrences) {
        const s = suggestMeaning(occ);
        if (s) suggestions[occ.key] = s;
    }
    const applied = applyIntents(occurrences, resolveIntentChoices(occurrences, intentChoices));
    if (!applied && !cleaned) return { markup: inner, occurrences, suggestions };
    return { markup: serializeChildren(root), occurrences, suggestions };
}

// mf.getValue('math-ml') returns only the inner markup (e.g. <mrow>...</mrow>),
// not a full document. Wrap it in the root <math> element with the required
// namespace so this can be pasted straight into HTML and actually render/be
// recognized as MathML.
//
// Also wrap the presentation markup in <semantics> with an
// <annotation encoding="application/x-tex"> sibling containing the
// original LaTeX -- the standard MathML "parallel markup" pattern
// (the same thing MathJax's own MathML output does). Gives any
// downstream tool/screen reader that looks for it a LaTeX fallback
// alongside the presentation markup, for free.
function wrapMathmlDocument(presentation, latex) {
    const annotation = `<annotation encoding="application/x-tex">${escapeXmlText(latex)}</annotation>`;
    return `<math xmlns="${MATHML_NAMESPACE}" display="block">\n  <semantics>\n    ${presentation}\n    ${annotation}\n  </semantics>\n</math>`;
}

// Re-renders just the MathML text after a picker change -- deliberately
// not a full updateOutput(), which would rebuild the picker and pull
// keyboard focus out of the <select> the person just used.
function refreshMathmlText() {
    if (formatSelect.value !== 'math-ml') return;
    const latex = (mf.getValue('latex') || '').trim();
    if (!latex) return;
    const { markup } = buildIntentMathml();
    textCont.textContent = wrapMathmlDocument(markup, latex);
}

// The accessibility note(s) for flagged shapes, plus a "what does this
// mean?" <select> for each one that can take an intent.
function renderIntentPicker(occurrences, suggestions = {}) {
    mathmlNotesEl.textContent = '';
    if (!occurrences.length) return;

    const notes = describeAmbiguities(new Set(occurrences.map((o) => o.kind)));
    const noteEl = document.createElement('p');
    noteEl.className = 'hint';
    noteEl.textContent = `Accessibility note${notes.length > 1 ? 's' : ''}: ${notes.join(' ')}`;
    mathmlNotesEl.append(noteEl);

    const pickable = occurrences.filter((o) => meaningsFor(o).length);
    if (!pickable.length) return;

    const fieldset = document.createElement('fieldset');
    fieldset.className = 'intent-picker';
    const legend = document.createElement('legend');
    legend.textContent = 'Say what it means';
    fieldset.append(legend);

    const help = document.createElement('p');
    help.className = 'hint';
    help.textContent = 'Your choice is added to the MathML output as an "intent" attribute, which screen readers using MathCAT (NVDA, JAWS) read instead of guessing. It doesn\u2019t change the Description, Braille, or Read Aloud output.';
    fieldset.append(help);

    const status = document.createElement('p');
    status.className = 'hint intent-status';
    status.setAttribute('aria-live', 'polite');

    pickable.forEach((occ, idx) => {
        const id = `intent-choice-${idx}`;
        const row = document.createElement('div');
        row.className = 'intent-row';

        const label = document.createElement('label');
        label.htmlFor = id;
        const code = document.createElement('code');
        code.textContent = occ.label;
        label.append(code);
        const n = Number(occ.key.split('#').pop());
        label.append(n > 1 ? ` (occurrence ${n}) means:` : ' means:');

        // Bracketed intervals get their intent by default (defaultMeaning),
        // so "none" there is an explicit opt-out, stored as ''.
        const hasDefault = Boolean(defaultMeaning(occ));
        const suggestion = suggestions[occ.key];

        const select = document.createElement('select');
        select.id = id;
        const none = document.createElement('option');
        none.value = '';
        none.textContent = hasDefault ? 'Something else (no intent)' : 'Not specified (screen readers guess)';
        select.append(none);
        for (const meaning of meaningsFor(occ)) {
            const opt = document.createElement('option');
            opt.value = meaning.value;
            opt.textContent = suggestion && suggestion.value === meaning.value
                ? `${meaning.label} (suggested)`
                : meaning.label;
            select.append(opt);
        }
        select.value = resolveIntentChoices([occ], intentChoices)[occ.key] || '';
        select.addEventListener('change', () => {
            const picked = meaningsFor(occ).find((m) => m.value === select.value);
            if (picked) {
                intentChoices[occ.key] = picked.value;
                status.textContent = `Added intent "${picked.value}" for ${occ.label} to the MathML output.`;
            } else {
                if (hasDefault) intentChoices[occ.key] = '';
                else delete intentChoices[occ.key];
                status.textContent = `Removed the intent for ${occ.label}.`;
            }
            saveEquationState();
            refreshMathmlText();
        });

        row.append(label, select);
        if (suggestion) {
            const why = document.createElement('p');
            why.className = 'hint intent-suggestion';
            why.id = `${id}-why`;
            const picked = meaningsFor(occ).find((m) => m.value === suggestion.value);
            why.textContent = `Suggested: ${picked ? picked.label.toLowerCase() : suggestion.value}, because ${suggestion.reason}.`;
            select.setAttribute('aria-describedby', why.id);
            row.append(why);
        }
        fieldset.append(row);
    });

    fieldset.append(status);
    mathmlNotesEl.append(fieldset);
}

const FORMAT_LABELS = {
    'latex': 'LaTeX',
    'ascii-math': 'ASCII Math',
    'math-ml': 'MathML',
    'math-json': 'MathJSON',
    'spoken-text': 'Description (plain-language text)',
    'braille': 'Braille (Nemeth)',
    'svg': 'Portable SVG'
};

const EMPTY_MESSAGE = 'Enter a math expression above to see it here.';

// Speech Rule Engine (SRE) is a single shared engine with a stateful
// "modality" (braille vs. speech) -- MathVox uses it both directly (Braille
// output below) and indirectly (MathLive's textToSpeechRules='sre' bridge,
// for spoken-text/Read Aloud, configured above). Whichever modality was
// configured most recently wins for BOTH, so -- unlike a one-time setup --
// this has to be reasserted immediately before each actual use, not cached
// permanently after the first call. Verified directly in a Node sandbox: a
// stale/wrong modality doesn't error, it just silently returns output for
// the wrong modality (e.g. Braille dot patterns when speech text was
// expected), which is exactly the kind of silent-wrong-output bug this
// project has been hunting all along.
function setSreModality(modality, options) {
    return SRE.setupEngine(Object.assign({ modality }, options));
}

// Runs setup-then-use as one step, one at a time. setupEngine is async, so
// two overlapping requests (a Braille render and a Description render, or
// Read Aloud during an SVG render) could otherwise interleave as
// "setup A, setup B, use A" -- and A would get B's modality.
let sreQueue = Promise.resolve();
function runSre(setup, use) {
    const run = sreQueue.then(async () => {
        await setup();
        return use();
    });
    sreQueue = run.catch(() => {});
    return run;
}

function getSreBrailleReady() {
    return setSreModality('braille', { locale: 'nemeth' });
}

// Matches the exact config verified in a Node sandbox to produce clean,
// correctly-spaced mathspeak text (e.g. "x equals StartFraction negative b
// plus or minus StartRoot ... EndFraction") -- domain/style names here are
// SRE's own option names, distinct from (but equivalent to) the
// domain/ruleset names MathLive's textToSpeechRulesOptions uses above.
function getSreSpeechReady() {
    return setSreModality('speech', { domain: 'mathspeak', style: 'default', locale: 'en' });
}

// Generates the spoken-language description directly via SRE, rather than
// trusting mf.getValue('spoken-text') (MathLive's own bridge to the same
// SRE engine) -- QA found that path missing spaces between words in
// practice. Calling SRE directly, the same way Braille output already does,
// sidesteps whatever's going on in MathLive's internal bridging and gives a
// result that's been verified to come out correctly spaced.
function getSpokenText() {
    return runSre(getSreSpeechReady, () => SRE.toSpeech(getCleanMathml()) || '');
}

function getBraille() {
    return runSre(getSreBrailleReady, () => SRE.toSpeech(getCleanMathml()) || '');
}

// Kick off loading the Nemeth ruleset as soon as the page loads, so the
// first Braille request doesn't have to wait on the network fetch. The
// modality is reasserted again immediately before each actual use (above),
// since it may have been switched to 'speech' in between.
runSre(getSreBrailleReady, () => {});

// MathJax (modular input/mml + output/svg only -- see
// MATHJAX_SVG_IMPLEMENTATION_PLAN.md for why not a combined component) is
// only needed for the Portable SVG format. Same lazy-readiness pattern as
// SRE above: MathJax.mathml2svgPromise doesn't exist as a callable function
// until MathJax's own startup sequence finishes creating it, so anything
// that calls it must wait on this first.
let mathJaxReady = null;
function getMathJaxReady() {
    if (!mathJaxReady) {
        mathJaxReady = MathJax.startup.promise;
    }
    return mathJaxReady;
}
getMathJaxReady();

// Produces a standalone, self-contained SVG string for the current MathML --
// following MathJax's own documented recipe for stand-alone SVG images
// (inlining the handful of CSS rules the SVG output depends on, since a
// snippet copied out of this page won't have MathVox's stylesheet available
// wherever it's pasted).
const SVG_INLINE_CSS = [
    'svg a{fill:blue;stroke:blue}',
    '[data-mml-node="merror"]>g{fill:red;stroke:red}',
    '[data-mml-node="merror"]>rect[data-background]{fill:yellow;stroke:none}',
    '[data-frame],[data-line]{stroke-width:70px;fill:none}',
    '.mjx-dashed{stroke-dasharray:140}',
    '.mjx-dotted{stroke-linecap:round;stroke-dasharray:0,140}',
    'use[data-c]{stroke-width:3px}'
].join('');

async function getStandaloneSvg(mathml, spokenText) {
    await getMathJaxReady();
    const result = await MathJax.mathml2svgPromise(mathml, { display: true });
    const adaptor = MathJax.startup.adaptor;
    const svg = adaptor.tags(result, 'svg')[0];

    const defs = adaptor.tags(svg, 'defs')[0] || adaptor.append(svg, adaptor.create('defs'));
    adaptor.append(defs, adaptor.node('style', {}, [adaptor.text(SVG_INLINE_CSS)]));

    // Give the exported SVG its own accessible name, since once it's pasted
    // elsewhere none of MathVox's own accessibility features (Description,
    // Braille, Read Aloud) travel with it -- it's on its own from that point
    // on. <title> as the SVG's first child is the standard SVG equivalent of
    // an <img> alt attribute; explicit role="img" makes accessible-name
    // computation reliable across browsers/AT rather than depending on
    // SVG's historically inconsistent implicit default role. Reuses the same
    // spoken-text string (now via SRE's mathspeak rules, see the
    // textToSpeechRules config above) already used for the Description
    // format and Read Equation Aloud -- one source of truth, not a second
    // description to keep in sync.
    if (spokenText) {
        const titleNode = adaptor.node('title', {}, [adaptor.text(spokenText)]);
        const firstChild = adaptor.firstChild(svg);
        if (firstChild) {
            adaptor.insert(titleNode, firstChild);
        } else {
            adaptor.append(svg, titleNode);
        }
        adaptor.setAttribute(svg, 'role', 'img');
    } else {
        // No description available (shouldn't normally happen) -- fall back
        // to the original standalone-export behavior rather than claim an
        // image role with nothing backing it.
        adaptor.removeAttribute(svg, 'role');
    }

    // These two attributes assume the SVG stays live on a MathJax-managed
    // page, where a hidden MathML sibling is the accessible layer. This is a
    // standalone export with no such sibling, so strip them regardless of
    // whether a title was added above.
    adaptor.removeAttribute(svg, 'focusable');
    adaptor.removeAttribute(svg, 'aria-hidden');

    // Explicit black: a standalone SVG has no way to know what background
    // it'll be pasted onto, so this (MathJax's own recommended default for
    // stand-alone images) is the safest universal choice.
    const g = adaptor.tags(svg, 'g')[0];
    adaptor.setAttribute(g, 'stroke', 'black');
    adaptor.setAttribute(g, 'fill', 'black');

    return adaptor.outerHTML(svg);
}

// Last successfully generated SVG markup / suggested alt text, kept around
// so the Download and Copy-alt-text buttons (both format-specific to
// Portable SVG) have something to act on without re-generating anything --
// cleared any time updateOutput() runs for a different format or fails.
let lastSvgMarkup = '';
let lastAltText = '';

// Portable SVG's markup runs to thousands of characters, so in that format
// the code sits in a collapsed <details> (the preview above it is what
// people check) and the Copy/Link buttons stay close by. Whether it's open
// is remembered for the session, so re-rendering while typing doesn't keep
// snapping it shut. Every other format shows its output open, with no
// summary, as before.
let svgCodeOpen = false;

function setCodeCollapsible(on) {
    codeDetailsEl.classList.toggle('collapsible', on);
    codeDetailsEl.open = on ? svgCodeOpen : true;
    updateCodeSummary();
}

function updateCodeSummary() {
    const size = lastSvgMarkup ? ` (${lastSvgMarkup.length.toLocaleString()} characters)` : '';
    codeSummaryEl.textContent = `${codeDetailsEl.open ? 'Hide' : 'Show'} SVG code${size}`;
}

function debounce(fn, delay) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), delay);
    };
}

// Incremented by every updateOutput() call. The async formats (Braille,
// Description, SVG) check it after each await and drop their result if a
// newer render has started -- otherwise switching SVG -> LaTeX quickly left
// the SVG markup (and preview) showing under the "LaTeX" heading, and Copy
// copied it.
let renderId = 0;

// `announce: true` (format change, Convert) also posts a short "... output
// updated" to the live region; not done while typing, where it would be
// announced on every pause.
async function updateOutput({ announce: shouldAnnounce = false } = {}) {
    const myRender = ++renderId;
    const isStale = () => myRender !== renderId;
    const format = formatSelect.value;
    const label = FORMAT_LABELS[format] || format;
    const done = () => {
        if (shouldAnnounce && !isStale()) announce(`${label} output updated.`);
    };
    formatNameEl.textContent = label;
    copyBtn.setAttribute('aria-label', `Copy ${label} output to clipboard`);
    textCont.classList.toggle('braille-output', format === 'braille');

    // Only the "svg" branch below populates/shows the preview (and the
    // suggested-alt-text note); every other path (including the
    // early-returns) should leave both hidden and empty.
    svgPreviewEl.hidden = true;
    svgPreviewEl.textContent = '';
    downloadSvgBtn.hidden = true;
    downloadSvgCornerBtn.hidden = true;
    lastSvgMarkup = '';
    svgAltWrapEl.hidden = true;
    suggestedAltEl.textContent = '';
    lastAltText = '';
    mathmlNotesEl.textContent = '';
    updateConversionWarning(format, label);

    const latex = (mf.getValue('latex') || '').trim();
    // Only a successfully rendered SVG collapses (see the "svg" branch), so
    // messages like "Generating SVG..." or an error never end up hidden.
    // Left alone while re-rendering an SVG, so the layout doesn't jump.
    if (format !== 'svg' || !latex) setCodeCollapsible(false);
    if (!latex) {
        textCont.textContent = EMPTY_MESSAGE;
        return;
    }

    if (format === 'braille') {
        textCont.textContent = 'Generating Braille…';
        try {
            const braille = await getBraille();
            if (isStale()) return;
            textCont.textContent = braille || 'No Braille output was generated for this expression.';
        } catch (err) {
            if (isStale()) return;
            console.error('Braille generation failed', err);
            textCont.textContent = 'Braille output is unavailable right now.';
        }
        done();
        return;
    }

    if (format === 'math-json') {
        try {
            const rawJson = mf.getValue('math-json');
            // mf.getValue('math-json') returns a JSON *string* in this
            // MathLive version, not an already-parsed structure -- confirmed
            // via real-browser testing (this was previously only verified
            // with Node-level Compute Engine tests in isolation, which
            // didn't catch this). Without parsing it, findMathJsonError()
            // below can never match (Array.isArray() is false on a string),
            // so the plain-language explanation never fires, and the
            // "happy path" output is a double-escaped string instead of
            // clean JSON.
            const json = typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson;
            const errorNode = findMathJsonError(json);
            if (errorNode) {
                const reason = describeMathJsonError(errorNode);
                textCont.textContent = `MathJSON couldn't fully represent this expression: it ${reason}.\n\nThe raw (partially broken) MathJSON is shown below for reference:\n\n${JSON.stringify(json, null, 2)}`;
            } else {
                textCont.textContent = JSON.stringify(json, null, 2);
            }
        } catch (err) {
            console.error('MathJSON generation failed', err);
            textCont.textContent = 'MathJSON output is unavailable right now.';
        }
        done();
        return;
    }

    if (format === 'math-ml') {
        const inner = mf.getValue('math-ml');
        // Semantic ambiguity audit + chosen intents (see buildIntentMathml).
        // Any failure here falls back to the plain MathLive markup -- the
        // audit and intents are extras, never a reason to lose the output.
        let markup = inner;
        let occurrences = [];
        let suggestions = {};
        try {
            ({ markup, occurrences, suggestions } = buildIntentMathml());
        } catch (err) {
            console.error('MathML ambiguity audit / intent pass failed', err);
            markup = inner;
            occurrences = [];
        }
        textCont.textContent = wrapMathmlDocument(markup, latex);
        try {
            renderIntentPicker(occurrences, suggestions);
        } catch (err) {
            console.error('Rendering the MathML meaning picker failed', err);
        }
        done();
        return;
    }

    if (format === 'spoken-text') {
        textCont.textContent = 'Generating description…';
        try {
            const spoken = await getSpokenText();
            if (isStale()) return;
            textCont.textContent = spoken || 'No description was generated for this expression.';
        } catch (err) {
            if (isStale()) return;
            console.error('Spoken-text generation failed', err);
            textCont.textContent = 'Description output is unavailable right now.';
        }
        done();
        return;
    }

    if (format === 'svg') {
        textCont.textContent = 'Generating SVG…';
        try {
            const inner = getCleanMathml();
            const mathmlForConversion = `<math xmlns="${MATHML_NAMESPACE}">${inner}</math>`;
            let spokenText = '';
            try {
                spokenText = await getSpokenText();
            } catch (speechErr) {
                // Non-fatal: the SVG itself is the point of this format, so a
                // description hiccup shouldn't block it -- it'll just export
                // without an embedded accessible title this one time.
                console.error('spoken-text generation for SVG title failed', speechErr);
            }
            const svgMarkup = await getStandaloneSvg(mathmlForConversion, spokenText);
            if (isStale()) return;
            textCont.textContent = svgMarkup;
            svgPreviewEl.innerHTML = svgMarkup;
            svgPreviewEl.hidden = false;
            lastSvgMarkup = svgMarkup;
            downloadSvgBtn.hidden = false;
            downloadSvgCornerBtn.hidden = false;
            setCodeCollapsible(true);
            lastAltText = spokenText || '';
            suggestedAltEl.textContent = spokenText
                ? `Suggested alt text (if you save this as an image file rather than pasting the markup directly): ${spokenText}`
                : '';
            svgAltWrapEl.hidden = !spokenText;
        } catch (err) {
            if (isStale()) return;
            console.error('SVG generation failed', err);
            textCont.textContent = 'SVG output is unavailable right now.';
            svgPreviewEl.hidden = true;
            svgPreviewEl.textContent = '';
            downloadSvgBtn.hidden = true;
            downloadSvgCornerBtn.hidden = true;
            lastSvgMarkup = '';
            setCodeCollapsible(false);
            suggestedAltEl.textContent = '';
            svgAltWrapEl.hidden = true;
            lastAltText = '';
        }
        done();
        return;
    }

    textCont.textContent = mf.getValue(format);
    done();
}

async function speakEquation() {
    // Reads the same verified text the Description format shows (SRE
    // mathspeak over the cleaned-up MathML -- see getCleanMathml), via the
    // browser's own Web Speech API. MathLive's built-in "speak" command
    // sends MathLive's raw MathML to SRE, so it would still say "times"
    // inside every typed "|x|"; it's kept only as a fallback for browsers
    // without speechSynthesis.
    try {
        if ('speechSynthesis' in window && 'SpeechSynthesisUtterance' in window) {
            const text = await getSpokenText();
            if (text) {
                window.speechSynthesis.cancel();
                const utterance = new SpeechSynthesisUtterance(text);
                utterance.lang = 'en-US';
                window.speechSynthesis.speak(utterance);
                return;
            }
        }
    } catch (err) {
        console.error('Web Speech read-aloud failed; falling back to MathLive', err);
    }
    // See getSreSpeechReady() -- MathLive's own "speak" command draws on the
    // same shared SRE engine as everything else here, so its modality needs
    // to be correctly set immediately before use.
    await runSre(getSreSpeechReady, () => mf.executeCommand('speak'));
}

// Keep the plain-text LaTeX box in sync with whatever is in the visual
// math-field, but never overwrite it while someone is actively typing in it
// (Convert is the explicit, predictable moment their edits get applied).
function syncLatexInputFromField() {
    if (document.activeElement === latexInput) return;
    latexInput.value = mf.getValue('latex');
    autoGrowLatexInput();
}

// The textarea should grow with its content instead of scrolling, so long
// equations stay fully visible.
function autoGrowLatexInput() {
    latexInput.style.height = 'auto';
    latexInput.style.height = `${latexInput.scrollHeight}px`;
}

function reportLatexErrors(rawLatex) {
    const messages = [];

    const errors = mf.errors || [];
    if (errors.length) {
        messages.push(`this LaTeX ${errors.map(describeLatexError).join('; ')}`);
    }

    const imbalance = findBraceImbalance(rawLatex);
    if (imbalance > 0) {
        messages.push(`it looks like ${imbalance} closing brace${imbalance === 1 ? '' : 's'} (}) ${imbalance === 1 ? 'is' : 'are'} missing`);
    } else if (imbalance < 0) {
        const extra = -imbalance;
        messages.push(`it looks like ${extra} extra closing brace${extra === 1 ? '' : 's'} (}) ${extra === 1 ? 'is' : 'are'} present without a matching opening brace`);
    }

    if (!messages.length) {
        latexErrorEl.textContent = '';
        return;
    }
    latexErrorEl.textContent = `Heads up: ${messages.join(', and ')}. It was applied as best MathLive could interpret it — double-check the equation field above.`;
}

// Push the text box's content into the math-field. This is the primary way
// for someone to fix something (like a stray brace) that's awkward to edit
// inside the rendered math-field directly: edit the LaTeX as plain text,
// then apply it.
function convertLatex() {
    const rawLatex = latexInput.value;
    mf.setValue(rawLatex);
    reportLatexErrors(rawLatex);
    updateOutput({ announce: true });
    syncLatexInputFromField();
    saveEquationState();
}

// Keep the address-bar hash in sync with the current equation/format, so
// the page's own URL at any moment is a valid shareable link -- same
// pattern as the OrgChart app. replaceState (not pushState) so typing
// doesn't spam browser history with one entry per keystroke.
function updateUrlHash() {
    try {
        const params = new URLSearchParams();
        const latex = mf.getValue('latex') || '';
        if (latex) {
            params.set(EQ_HASH_PARAM, latex);
        }
        params.set(FORMAT_HASH_PARAM, formatSelect.value);
        if (Object.keys(intentChoices).length) {
            params.set(INTENT_HASH_PARAM, JSON.stringify(intentChoices));
        }
        history.replaceState(null, '', `${location.pathname}${location.search}#${params.toString()}`);
    } catch (err) {
        // Not fatal -- the app still works, just without a shareable URL.
        console.warn('Could not update the shareable link', err);
    }
}

// Persist the current equation and chosen output format so a reload (or
// coming back later) doesn't lose someone's work -- matches the existing
// pattern used for the theme and dyslexia-font toggles. Also keeps the
// shareable-link hash (see updateUrlHash() above) current.
function saveEquationState() {
    storageSet(LATEX_STORAGE_KEY, mf.getValue('latex') || '');
    storageSet(FORMAT_STORAGE_KEY, formatSelect.value);
    storageSet(INTENT_STORAGE_KEY, JSON.stringify(intentChoices));
    updateUrlHash();
}

// A shared link (equation/format in the URL hash) takes priority over
// locally saved state -- that's the point of following one. Falls back to
// the locally saved equation only when there's nothing in the hash.
function restoreEquationState() {
    let restoredFromLink = false;
    try {
        const hashParams = new URLSearchParams(location.hash.slice(1));
        const hashFormat = hashParams.get(FORMAT_HASH_PARAM);
        const hashLatex = hashParams.get(EQ_HASH_PARAM);
        if (hashFormat && FORMAT_LABELS[hashFormat]) {
            formatSelect.value = hashFormat;
            restoredFromLink = true;
        }
        if (hashLatex) {
            mf.setValue(hashLatex);
            restoredFromLink = true;
        }
        if (restoredFromLink) {
            // A shared link's meanings travel with its equation; a link
            // without any means "none chosen", not "keep my local ones".
            intentChoices = parseIntentChoices(hashParams.get(INTENT_HASH_PARAM));
        }
    } catch (err) {
        console.warn('Could not parse the shared link', err);
    }

    if (!restoredFromLink) {
        const savedFormat = storageGet(FORMAT_STORAGE_KEY);
        if (savedFormat && FORMAT_LABELS[savedFormat]) {
            formatSelect.value = savedFormat;
        }
        const savedLatex = storageGet(LATEX_STORAGE_KEY);
        if (savedLatex) {
            mf.setValue(savedLatex);
        }
        intentChoices = parseIntentChoices(storageGet(INTENT_STORAGE_KEY));
    }

    // Whichever source won above (or neither), make sure localStorage and
    // the URL hash both reflect it -- this also means following a shared
    // link "sticks" as your last-used equation on future visits.
    saveEquationState();
}

// Copies `text` and confirms it both ways: announced for screen readers,
// and a brief checkmark on the button itself (its accessible name comes
// from aria-label, so swapping the visible glyph doesn't change it).
const COPIED_MARK = '✓';
async function copyWithFeedback(button, text, what) {
    const visible = button.querySelector('span') || button;
    try {
        await navigator.clipboard.writeText(text);
    } catch (err) {
        console.error(`Failed to copy ${what}`, err);
        announce(`Couldn’t copy the ${what}. Your browser may have blocked clipboard access.`);
        return;
    }
    announce(`Copied the ${what} to the clipboard.`);
    if (visible.dataset.label === undefined) visible.dataset.label = visible.textContent;
    visible.textContent = visible === button ? COPIED_MARK : 'Copied';
    clearTimeout(button.copiedTimer);
    button.copiedTimer = setTimeout(() => { visible.textContent = visible.dataset.label; }, 1500);
}

async function copyOutput() {
    if (!(mf.getValue('latex') || '').trim()) {
        announce('Nothing to copy yet. Enter an equation first.');
        return;
    }
    const label = FORMAT_LABELS[formatSelect.value] || formatSelect.value;
    await copyWithFeedback(copyBtn, textCont.textContent, `${label} output`);
}

// Copies the current page URL, whose hash already encodes the equation and
// chosen format (kept current by updateUrlHash()) -- following it
// reproduces this exact equation/format instead of the blank app.
async function copyShareLink() {
    updateUrlHash();
    await copyWithFeedback(shareBtn, location.href, 'shareable link');
}

// Copies just the suggested-alt-text payload (lastAltText), not the whole
// "Suggested alt text (if you save this..." lead-in sentence shown on the
// page -- see the "svg" branch of updateOutput() for where it's set.
async function copyAltText() {
    if (!lastAltText) {
        return;
    }
    await copyWithFeedback(copyAltTextBtn, lastAltText, 'suggested alt text');
}

// Saves the last generated Portable SVG (lastSvgMarkup) as a standalone
// .svg file, for anyone who wants an actual image file rather than pasting
// the markup shown on the page. Prepends an XML declaration, since a
// downloaded file (unlike markup pasted inline into an existing HTML
// document) is meant to stand alone.
function downloadSvgFile() {
    if (!lastSvgMarkup) {
        return;
    }
    const xmlDeclaration = '<?xml version="1.0" encoding="UTF-8"?>\n';
    const blob = new Blob([xmlDeclaration + lastSvgMarkup], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'mathvox-equation.svg';
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Give the download a moment to actually start before freeing the URL.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function setTheme(dark) {
    document.documentElement.classList.toggle('theme-dark', dark);
    themeToggle.setAttribute('aria-pressed', String(dark));
    themeToggle.textContent = dark ? 'Light Mode' : 'Dark Mode';
    storageSet('mathvox-theme', dark ? 'dark' : 'light');
}

function setDyslexiaFont(on) {
    document.documentElement.classList.toggle('dyslexia-font', on);
    dyslexiaToggle.setAttribute('aria-pressed', String(on));
    storageSet('mathvox-dyslexia-font', on ? 'on' : 'off');
}

// Restore saved preferences, falling back to the OS-level color scheme
// for the theme when the user hasn't chosen one yet.
const savedTheme = storageGet('mathvox-theme');
const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
setTheme(savedTheme ? savedTheme === 'dark' : prefersDark);
setDyslexiaFont(storageGet('mathvox-dyslexia-font') === 'on');

mf.addEventListener('input', debounce(() => {
    updateOutput();
    syncLatexInputFromField();
    saveEquationState();
}, 300));
formatSelect.addEventListener('change', () => {
    updateOutput({ announce: true });
    saveEquationState();
});
readBtn.addEventListener('click', speakEquation);
copyBtn.addEventListener('click', copyOutput);
shareBtn.addEventListener('click', copyShareLink);
downloadSvgBtn.addEventListener('click', downloadSvgFile);
downloadSvgCornerBtn.addEventListener('click', downloadSvgFile);
// Record the person's own open/close (click fires before the toggle, and
// also for Enter/Space on the summary) -- not the 'toggle' event, which
// also fires for setCodeCollapsible's programmatic changes.
codeSummaryEl.addEventListener('click', () => {
    if (codeDetailsEl.classList.contains('collapsible')) svgCodeOpen = !codeDetailsEl.open;
});
codeDetailsEl.addEventListener('toggle', updateCodeSummary);
copyAltTextBtn.addEventListener('click', copyAltText);
themeToggle.addEventListener('click', () => setTheme(!document.documentElement.classList.contains('theme-dark')));
dyslexiaToggle.addEventListener('click', () => setDyslexiaFont(!document.documentElement.classList.contains('dyslexia-font')));

convertBtn.addEventListener('click', convertLatex);
latexInput.addEventListener('input', autoGrowLatexInput);
// Ctrl/Cmd+Enter converts without leaving the text box (documented in the
// on-page keyboard help and the hint text next to the box).
latexInput.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        convertLatex();
    }
});

// Restore any previously saved equation/format before the first render so
// there's nothing to visibly "jump" after load.
restoreEquationState();
updateOutput();
syncLatexInputFromField();
