import { ComputeEngine } from './vendor/compute-engine/compute-engine.min.esm.js';

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
const formatSelect = document.querySelector('#format-select');
const formatNameEl = document.querySelector('#format-name');
const textCont = document.querySelector('#text-cont');
const copyBtn = document.querySelector('#copy');
const readBtn = document.querySelector('#read');
const themeToggle = document.querySelector('#theme-toggle');
const dyslexiaToggle = document.querySelector('#dyslexia-toggle');
const latexInput = document.querySelector('#latex-input');
const convertBtn = document.querySelector('#convert');
const latexErrorEl = document.querySelector('#latex-error');
const svgPreviewEl = document.querySelector('#svg-preview');
const suggestedAltEl = document.querySelector('#svg-alt-suggestion');
const mathmlNotesEl = document.querySelector('#mathml-notes');

const MATHML_NAMESPACE = 'http://www.w3.org/1998/Math/MathML';
const LATEX_STORAGE_KEY = 'mathvox-latex';
const FORMAT_STORAGE_KEY = 'mathvox-format';

// Compute Engine can "succeed" (no thrown exception) while still embedding
// an ["Error", ["ErrorCode", ...]] node somewhere inside an otherwise-valid
// MathJSON tree -- e.g. QA found "\pm" inside a "\frac" produces exactly this
// (± isn't a single number, so dividing it hits an incompatible-type error),
// silently leaking a raw internal error blob into the output instead of a
// message a user could act on. Recursively search for that shape.
function findMathJsonError(node) {
    if (!Array.isArray(node)) return null;
    if (node[0] === 'Error') return node;
    for (const child of node) {
        const found = findMathJsonError(child);
        if (found) return found;
    }
    return null;
}

// Strips the single-quote wrapping Compute Engine puts around each string
// literal inside an ErrorCode node, e.g. "'incompatible-type'" -> "incompatible-type".
function unquote(value) {
    return typeof value === 'string' ? value.replace(/^'|'$/g, '') : String(value);
}

function describeMathJsonError(errorNode) {
    const detail = errorNode[1];
    if (!Array.isArray(detail) || detail[0] !== 'ErrorCode') {
        return 'hit an internal error MathJSON could not fully resolve';
    }
    const code = unquote(detail[1]);
    if (code === 'incompatible-type') {
        const expected = detail[2] ? unquote(detail[2]) : 'a single value';
        const actual = detail[3] ? unquote(detail[3]) : 'something else';
        return `expected ${expected} but got ${actual} -- this commonly happens with "±" (\\pm) inside a fraction or another spot that expects one number, since ± really represents two possible values`;
    }
    return `hit a "${code}" error`;
}

// LaTeX commonly contains "<", ">", or "&" (comparisons, "\&", etc.); escape
// them so the annotation stays well-formed when the output is pasted as XML
// text into an HTML document.
function escapeXmlText(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// MathML "semantic ambiguity" audit (see MATHML_SEMANTIC_LINT_PLAN.md for
// full background/rationale). MathLive's math-ml export is pure Presentation
// MathML with no "intent" attribute (MathML 4's mechanism for authors to
// disambiguate notation) and no Content MathML -- confirmed by grepping the
// vendored mathlive.js bundle (zero occurrences of "intent"). Since MathVox
// can't know the author's true intended meaning, this doesn't try to inject
// intent values -- it only flags known-ambiguous shapes so the user knows
// assistive technology may be guessing.

// U+2061 FUNCTION APPLICATION: the invisible operator MathML places between
// a function name and its parenthesized argument list, e.g. "f(x, y)". Its
// presence is what distinguishes an ordinary, unambiguous function call from
// a bare parenthesized comma-group like "(x, y)" (point? interval? GCD?) --
// the single biggest false-positive risk for the check below if not guarded
// against, since multi-argument function calls are extremely common.
const FUNCTION_APPLICATION = '⁡';

// Candidate characters MathLive could plausibly emit for "|" / "\vert" /
// stretchy fence bars -- the exact codepoint hasn't been confirmed against
// real MathLive output (no browser available in this sandbox to check), so
// this matches a small set rather than one hardcoded character. Flagged in
// MATHML_SEMANTIC_LINT_PLAN.md as needing real-browser confirmation.
const VERTICAL_BAR_CHARS = new Set(['|', '∣', '‖']);

const AMBIGUITY_NOTES = {
    'point-or-interval': 'This expression contains "(a, b)" — a shape that could mean a point, an open interval, a greatest common divisor, or something else depending on context. MathML has a newer "intent" attribute (MathML 4) for authors to specify which meaning is intended, but the libraries MathVox uses don’t yet support adding it, so screen readers will fall back to their own best guess.',
    'absolute-value-or-set-builder': 'This expression contains a pair of vertical bars ("|...|") — commonly absolute value, but also used for set-builder notation ("such that") or "divides" depending on context. Same caveat as above: no "intent" annotation is added, so assistive technology will guess based on its own heuristics.'
};

function elementChildren(node) {
    return Array.from(node.childNodes).filter((n) => n.nodeType === 1);
}

function textOf(node) {
    return node.textContent || '';
}

// Recursively walks a parsed MathML fragment looking for the two ambiguous
// shapes described above. Returns a Set of ambiguity "kinds" found --
// deduplicated, so a shape appearing multiple times in one equation still
// produces just one note. Parses defensively: any failure (malformed
// fragment, missing DOMParser support, etc.) yields "found nothing" rather
// than surfacing an error, since this is a supplementary note, not the
// primary MathML output.
function findAmbiguousNotation(mathmlFragment) {
    const found = new Set();
    let doc;
    try {
        // Wrapped in a synthetic root: mf.getValue('math-ml') isn't
        // guaranteed to have exactly one top-level element, and XML parsing
        // requires a single root.
        doc = new DOMParser().parseFromString(`<root>${mathmlFragment}</root>`, 'application/xml');
        if (doc.querySelector('parsererror')) return found;
    } catch (err) {
        return found;
    }

        // Scan for "(" ... "," ... ")" as a subsequence anywhere within this
        // row's children -- not just when the whole row is exactly that
        // shape. A flattened row can contain a parenthesized group alongside
        // other content (e.g. "(a,b) + |x|" as one un-nested row), so
        // requiring the group to span the entire row would miss it.
        for (let i = 0; i < children.length; i++) {
            if (children[i].tagName !== 'mo' || textOf(children[i]) !== '(') continue;
            for (let j = i + 1; j < children.length; j++) {
                if (children[j].tagName !== 'mo' || textOf(children[j]) !== ')') continue;
                const between = children.slice(i + 1, j);
                const hasComma = between.some((c) => c.tagName === 'mo' && textOf(c) === ',');
                // What immediately precedes this "(" -- either an earlier
                // sibling in this same row, or (if "(" is the row's first
                // child) whatever preceded the row itself.
                const opener = i > 0 ? children[i - 1] : precedingSibling;
                const isFunctionCall =
                    opener && opener.tagName === 'mo' && textOf(opener) === FUNCTION_APPLICATION;
                if (hasComma && !isFunctionCall) {
                    found.add('point-or-interval');
                }
                break; // paired this "(" with its nearest ")"; move on to any further "(" in this row
            }
        }

        const barIndices = children
            .map((c, i) => (c.tagName === 'mo' && VERTICAL_BAR_CHARS.has(textOf(c)) ? i : -1))
            .filter((i) => i !== -1);
        if (barIndices.length === 2 && barIndices[1] > barIndices[0] + 1) {
            found.add('absolute-value-or-set-builder');
        }

        children.forEach((child, i) => walk(child, i > 0 ? children[i - 1] : null));
    }

    walk(doc.documentElement, null);
    return found;
}

function describeAmbiguities(kinds) {
    return Array.from(kinds).map((kind) => AMBIGUITY_NOTES[kind]).filter(Boolean);
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
async function getSpokenText() {
    await getSreSpeechReady();
    const mathml = mf.getValue('math-ml');
    return SRE.toSpeech(mathml) || '';
}

// Kick off loading the Nemeth ruleset as soon as the page loads, so the
// first Braille request doesn't have to wait on the network fetch. The
// modality is reasserted again immediately before each actual use (above),
// since it may have been switched to 'speech' in between.
getSreBrailleReady();

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

    // Only the "svg" branch below populates/shows the preview (and the
    // suggested-alt-text note); every other path (including the
    // early-returns) should leave both hidden and empty.
    svgPreviewEl.hidden = true;
    svgPreviewEl.textContent = '';
    suggestedAltEl.textContent = '';
    mathmlNotesEl.textContent = '';

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
        return;
    }

    if (format === 'math-ml') {
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
        const inner = mf.getValue('math-ml');
        const annotation = `<annotation encoding="application/x-tex">${escapeXmlText(latex)}</annotation>`;
        textCont.textContent = `<math xmlns="${MATHML_NAMESPACE}" display="block">\n  <semantics>\n    ${inner}\n    ${annotation}\n  </semantics>\n</math>`;

        // Semantic ambiguity audit (see MATHML_SEMANTIC_LINT_PLAN.md). Runs
        // against the raw presentation markup, not the annotation-wrapped
        // string above, and is kept in its own element so Copy still copies
        // clean MathML.
        try {
            const ambiguities = findAmbiguousNotation(inner);
            const notes = describeAmbiguities(ambiguities);
            mathmlNotesEl.textContent = notes.length
                ? `Accessibility note${notes.length > 1 ? 's' : ''}: ${notes.join(' ')}`
                : '';
        } catch (err) {
            // Supplementary note only -- a failure here shouldn't affect the
            // actual MathML output above.
            console.error('MathML ambiguity audit failed', err);
        }
        return;
    }

    if (format === 'spoken-text') {
        textCont.textContent = 'Generating description…';
        try {
            const spoken = await getSpokenText();
            textCont.textContent = spoken || 'No description was generated for this expression.';
        } catch (err) {
            console.error('Spoken-text generation failed', err);
            textCont.textContent = 'Description output is unavailable right now.';
        }
        return;
    }

    if (format === 'svg') {
        textCont.textContent = 'Generating SVG…';
        try {
            const inner = mf.getValue('math-ml');
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
            textCont.textContent = svgMarkup;
            svgPreviewEl.innerHTML = svgMarkup;
            svgPreviewEl.hidden = false;
            suggestedAltEl.textContent = spokenText
                ? `Suggested alt text (if you save this as an image file rather than pasting the markup directly): ${spokenText}`
                : '';
        } catch (err) {
            console.error('SVG generation failed', err);
            textCont.textContent = 'SVG output is unavailable right now.';
            svgPreviewEl.hidden = true;
            svgPreviewEl.textContent = '';
            suggestedAltEl.textContent = '';
        }
        return;
    }

    textCont.textContent = mf.getValue(format);
}

async function speakEquation() {
    // See getSreSpeechReady() -- MathLive's own "speak" command draws on the
    // same shared SRE engine as everything else here, so its modality needs
    // to be correctly set immediately before use, same as every other SRE
    // consumer in this file.
    await getSreSpeechReady();
    mf.executeCommand('speak');
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

// Human-readable summaries for MathLive's LatexSyntaxError.code values
// (see https://mathlive.io/mathfield/reference/keybindings/ and the
// Mathfield API reference for the `errors` property). Anything not listed
// falls back to showing the raw code so nothing is silently swallowed.
const LATEX_ERROR_MESSAGES = {
    'unknown-command': 'contains a command MathLive doesn’t recognize',
    'invalid-command': 'uses a command in a way it doesn’t support',
    'unbalanced-braces': 'has a brace ({ or }) without a matching pair',
    'unknown-environment': 'references an environment MathLive doesn’t recognize',
    'unbalanced-environment': 'has a \\begin{...} without a matching \\end{...} (or vice versa)',
    'unbalanced-mode-shift': 'has an unbalanced mode shift (e.g. an unmatched $ or \\text{})',
    'missing-argument': 'is missing an argument a command needs',
    'too-many-infix-commands': 'has more than one infix command (like \\over) in the same group',
    'unexpected-command-in-string': 'has a command that can’t be used in plain text',
    'missing-unit': 'is missing a unit where one is required',
    'unexpected-delimiter': 'has an unexpected delimiter',
    'unexpected-token': 'has an unexpected character',
    'unexpected-end-of-string': 'ends unexpectedly, as if something is missing',
    'improper-alphabetic-constant': 'has an improperly formatted constant'
};

function describeLatexError(err) {
    return LATEX_ERROR_MESSAGES[err.code] || `has a problem MathLive calls "${err.code}"`;
}

// QA found that mf.errors misses common typos like an unclosed brace
// ("\frac{1}{") -- MathLive is lenient enough to silently treat it as valid
// (rendering a broken/incomplete result) rather than flagging it, while
// catching only more severely broken input. This counts braces directly on
// the raw text as a backstop, independent of MathLive's own leniency.
// Escaped braces ("\{" / "\}") are literal characters, not grouping
// delimiters, so they're stripped before counting.
function findBraceImbalance(rawLatex) {
    const stripped = rawLatex.replace(/\\\{|\\\}/g, '');
    let depth = 0;
    for (const ch of stripped) {
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
    }
    return depth;
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
    updateOutput();
    syncLatexInputFromField();
    saveEquationState();
}

// Persist the current equation and chosen output format so a reload (or
// coming back later) doesn't lose someone's work -- matches the existing
// pattern used for the theme and dyslexia-font toggles.
function saveEquationState() {
    try {
        localStorage.setItem(LATEX_STORAGE_KEY, mf.getValue('latex') || '');
        localStorage.setItem(FORMAT_STORAGE_KEY, formatSelect.value);
    } catch (err) {
        // localStorage can be unavailable (private browsing, quota, etc.);
        // losing persistence isn't fatal, so just skip it.
        console.warn('Could not save MathVox state', err);
    }
}

function restoreEquationState() {
    try {
        const savedFormat = localStorage.getItem(FORMAT_STORAGE_KEY);
        if (savedFormat && FORMAT_LABELS[savedFormat]) {
            formatSelect.value = savedFormat;
        }
        const savedLatex = localStorage.getItem(LATEX_STORAGE_KEY);
        if (savedLatex) {
            mf.setValue(savedLatex);
        }
    } catch (err) {
        console.warn('Could not restore MathVox state', err);
    }
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

mf.addEventListener('input', debounce(() => {
    updateOutput();
    syncLatexInputFromField();
    saveEquationState();
}, 300));
formatSelect.addEventListener('change', () => {
    updateOutput();
    saveEquationState();
});
readBtn.addEventListener('click', speakEquation);
copyBtn.addEventListener('click', copyOutput);
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
