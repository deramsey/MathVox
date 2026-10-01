# MathVox — Project Notes

Internal reference doc. Read this before doing further work on MathVox. It
describes the project **as it is now** -- how it's built, what it does, the
decisions behind it, and what's open. The dated record of how things got this
way (build notes, QA passes, resolved issues, with all the detail and
reasoning) is in [`docs/HISTORY.md`](docs/HISTORY.md); sections below point
there by title.

- **Repo:** https://github.com/deramsey/MathVox.git
- **Live:** https://math-vox.vercel.app/ (Vercel, auto-deploys on push)
- **Owner:** Derek Ramsey, Cleveland Community College
- **Stack:** vanilla HTML/CSS/JS. No bundler, no backend, no build step.
- **Git:** Derek commits himself -- don't commit unless asked.
- **Last reorganized:** October 1, 2026.

## What this project is

MathVox started as a small tool (type an equation, hear it read aloud) and is
being grown into a robust math-accessibility utility for instructors: enter an
equation once, export it in whatever form is needed to make it accessible in an
online course or document (screen-reader text, Braille, portable SVG/HTML,
interchange formats for other tools).

**Focus:** the MathML is the most important output. Students' screen readers
(NVDA/JAWS via MathCAT, VoiceOver) read MathML themselves, so getting it right
-- cleaned up, with intents where meaning is ambiguous -- matters more than
MathVox's own Description/Braille text. Braille options are secondary (Derek,
October 2026).

Out of scope (Derek): instructor workflow features (batch processing, equation
libraries, direct Canvas API push) -- keep it focused on the accessibility
conversion pipeline. Graph description/sonification is pinned for later and
would likely need its own interface rather than another output format.

## Project layout

- `index.html` -- page shell; loads all vendored libraries via plain
  `<script>`/`<link>` tags.
- `resources/script.js` -- app logic that touches the page (DOM, MathLive, SRE,
  MathJax), loaded as `type="module"`.
- `resources/pure-logic.js` -- DOM-free logic imported by `script.js`: the
  MathLive MathML cleanup, the LaTeX rewrite that works around MathLive's
  export gaps, the ambiguity audit and intents, the "SVG + hidden MathML"
  snippet, error-message helpers. Kept separate (and one file, Derek's call)
  so it can be unit-tested in Node.
- `resources/style.css` -- all styling: light/dark, dyslexia font, forced
  colors / `prefers-contrast`, phone layout.
- `resources/vendor/` -- **self-hosted copies of every third-party library's
  built files** (see "Why vendoring" below). The single most important
  architectural fact.
- `tests/pure-logic.test.mjs` -- `npm test` (83 tests, October 1, 2026).
  `tests/braille-report.mjs` -- `npm run braille-report`. `tests/fixtures/` --
  MathCAT's Nemeth suite (+ its MIT license) and the 315-expression LaTeX
  corpus. See "Testing and QA".
- `docs/` -- `HISTORY.md` (dated build/QA log), the two design docs
  (`MATHJAX_SVG_IMPLEMENTATION_PLAN.md`, `MATHML_SEMANTIC_LINT_PLAN.md`),
  `DAISY_TALKING_POINTS.md`, and the two pitch `.docx` files. `.gitignore`
  excludes `*.md` and `*.docx` on purpose, so new or moved files there need
  `git add -f` to be tracked.
- `package.json` -- `"type": "module"`; dependencies are for local
  development and version tracking only (nothing at runtime uses
  `node_modules`).

## How an equation becomes output

Every MathML-based format (MathML, Description, Braille, Portable SVG,
SVG + hidden MathML, Read Aloud) goes through the same path in `script.js`
(`getRawMathml` -> `getCleanedTree` -> `buildIntentMathml`):

1. **LaTeX** from the math field (`mf.getValue('latex')`). The math field
   itself is never modified by any of the steps below.
2. **Export-gap rewrite** (`rewriteLatexForExport`): MathLive's MathML exporter
   drops or garbles some commands (`\overline`, `\overrightarrow`, braces,
   `\widehat`, `\not=`, `\pmod`, `\limsup`, `\xrightarrow`, `\boldsymbol`, ...).
   When one is present, a rewritten copy (placeholders inside `\overset` etc.)
   is converted with `MathLive.convertLatexToMathMl`; otherwise
   `mf.getValue('math-ml')` is used.
3. **HTML entities** (`normalizeHtmlEntities`): MathLive writes `&ne;`,
   `&nbsp;` etc., which aren't valid XML; without this nothing below runs.
4. **Cleanup** (`cleanUpMathLiveMathml`): fixes MathML MathLive gets wrong --
   placeholders swapped for the right symbols; vertical bars (`|x|`, nested,
   norms, set-builder and conditional-probability separators); primes;
   `%`, `∠`, `∂`, `∇`, `∀`, `∃`, `/`; degrees; digit grouping; `\binom`;
   empty-base prescripts; misplaced invisible operators; function letters
   (`h`, `F`, `P`, `E`, operator names, `d/dx`, ...).
5. **Ambiguity audit + intents** (MathML format only): flags `(a, b)`, `|x|`,
   bracketed intervals and "function or multiplication?" letters; the
   author's choices (and the interval defaults) are written in as MathML 4
   `intent` attributes or function application.
6. **Outputs:** MathML wraps it in `<semantics>` with a LaTeX annotation;
   Description and Braille run Speech Rule Engine (SRE) on the cleaned MathML
   (SRE ignores intents); the SVG formats run MathJax on it.
7. **Conversion warning** (`findConversionProblems`): if the final MathML is
   visibly missing something, a warning shows above MathML-based outputs.

Details, before/after tables and the reasoning for each fix: docs/HISTORY.md,
"MathML intent picker", "Ideas borrowed from MathCAT", "Workaround for
MathLive's MathML export gaps", "MathML cleanup, round 2" and '"Function or
multiplication?" choice'.

## Current features

- **Input:** MathLive `<math-field>` visual editor (visible label "Enter or
  edit the equation visually", which also focuses the field when clicked; the
  same text is the accessible name on its inner textbox) and a raw LaTeX box (`#latex-input` + Convert /
  Ctrl+Enter) kept in two-way sync; `#kbd-help` keyboard shortcut panel.
- **Format picker** (native `<select>`, placed above the input on purpose) with
  eight formats:
  - **LaTeX**, **ASCII Math**, **MathJSON** (via Compute Engine, with a
    plain-language explanation when it can't represent something).
  - **MathML** -- cleaned, with LaTeX annotation and the "Say what it means"
    picker: `(a, b)` (point / open interval / GCD, with "suggested" hints),
    `|x|` (absolute value / cardinality / determinant), `[a, b]`-style
    intervals (intent by default, opt-out), and letters before parentheses
    (function or multiplication). Choices persist and travel in links.
  - **Description** -- SRE text in the chosen **Description style**:
    MathSpeak (default; "StartFraction ... EndFraction") or ClearSpeak
    ("the fraction with numerator ... and denominator ..."). The style picker
    sits under the format picker and also drives Read Aloud, the SVG
    `<title>` and the suggested alt text. Saved (`mathvox-speech-style`) and
    put in shared links as `speech=` only when it isn't MathSpeak; a link
    without it keeps the viewer's own choice.
  - **Braille (Nemeth)** -- SRE.
  - **Portable SVG** -- MathJax, self-contained, with `<title>`/`role="img"`,
    Download .svg, suggested alt text with Copy, and a Word hint (Word ignores
    the built-in alt text).
  - **SVG + hidden MathML** -- an HTML snippet for web pages/LMS HTML: SVG
    `aria-hidden`, visually hidden MathML beside it for screen readers.
- **Clear Equation** -- empties the visual field and the LaTeX box and drops
  the meaning choices (saved state and link too), keeping format, Description
  style, theme and font. Focus goes to the field; a one-step **Undo Clear**
  appears until the next edit (MathLive's own undo doesn't cover `setValue`).
- **Read Equation Aloud** -- Web Speech API with the Description text
  (MathLive's `speak` only as a fallback).
- **Copy** buttons with spoken + visual confirmation; **shareable link** (URL
  hash carries equation, format and meaning choices); localStorage
  persistence (all access guarded -- the app runs without storage).
- **Accessibility of the app itself:** skip link, `#output-status` live
  region (short announcements, not the whole output), focus rings, 44px
  targets, dark mode, dyslexia-friendly font, forced-colors /
  `prefers-contrast` support, phone layout, collapsible long SVG/HTML code.

## Key decisions

### Why vendoring, not `node_modules`

Original approach was to reference libraries straight out of `node_modules` (e.g.
`./node_modules/mathlive/mathlive.js`). This worked locally but broke completely on
Vercel: **Vercel excludes `node_modules` from static deployments even when it's
committed to git.** Every library 404'd in production, which cascaded into a total
failure — MathLive never loaded so `<math-field>` never upgraded (editor "disappeared"),
and script.js (as an ES module) failed outright because one of its static imports
404'd, so *none* of the app's JS ran.

Fix: copy only the specific built/dist files each library needs into
`resources/vendor/<library>/`, committed to git as regular project files, and point
every reference at those paths instead. `node_modules` and `package.json` are still
used for local dependency management and version tracking, but nothing at runtime
depends on `node_modules` existing.

**Rule going forward: any new third-party library must be vendored into
`resources/vendor/`, not referenced from `node_modules`.** When bumping a library
version, re-copy the relevant files from a fresh `npm install` output into the vendor
folder and update paths/config if the internal file layout changed.

### Loading order / module notes

- `mathlive.js` and `sre.js` are loaded as classic (non-module) `<script>` tags in
  `<head>`, so they execute synchronously before anything else and define
  `globalThis.MathfieldElement` / `globalThis.SRE`.
- `script.js` is `type="module"`, so it's deferred and always runs after those classic
  scripts, regardless of tag order in the HTML. It does a static `import` of the
  Compute Engine bundle at the top.
- SRE needs `var SREfeature = { json: '<path-to-mathmaps>' }` set in an inline
  `<script>` **before** `sre.js` loads, so it knows where to fetch locale JSON from.
- Because of the module script and the local JSON/font fetches several libraries do at
  runtime, **the app must be served over http(s), never opened via `file://`.**

### Why Speech Rule Engine and not MathCAT for Braille

MathCAT produces excellent Nemeth braille but its own maintainer explicitly
recommends against using it in-browser (it's a Rust/WASM library, not packaged for
JS consumption). Speech Rule Engine (SRE) is the maintained, TypeScript, browser-ready
alternative — same Nemeth output quality tier, no WASM/Rust toolchain needed. Verified
empirically (Node sandbox test) that `{modality:'braille', locale:'nemeth'}` produces
correct Unicode Nemeth braille strings.

*Update (September 2026):* the cross-check against MathCAT showed SRE's Nemeth
has some rule gaps (see "Known limitations"), so it isn't quite "the same
quality tier". SRE is still the right choice under the current constraints;
see the pinned MathCAT item.

### Other standing decisions

- **MathJax: modular components, not a combined one** (`mml-svg` bundles its
  own SRE copy and a menu; 1.7MB vs. 340KB). SVG, not CHTML, because only SVG
  is portable on its own. Full reasoning: docs/MATHJAX_SVG_IMPLEMENTATION_PLAN.md.
- **MathJax gets MathML, not LaTeX** (`mathml2svgPromise` on the same cleaned
  MathML) -- one source of truth, no TeX input component to vendor.
- **SRE is one shared engine with a global modality** (braille vs. speech), so
  every use goes through `runSre()`, which reasserts the modality and queues
  calls one at a time; a stale modality silently returns the wrong output.
- **Description comes from SRE directly**, not `mf.getValue('spoken-text')`
  (MathLive's bridge dropped spaces between words).
- **Async renders are versioned** (`renderId`): a slow Braille/SVG render
  never overwrites a newer format's output.
- **Intents only where the author decided** -- except bracketed intervals,
  whose notation is conventional enough to default (and can be opted out of).

### Vendored dependencies (`resources/vendor/`)

| Folder | Contents | Notes |
|---|---|---|
| `mathlive/` | `mathlive.js` (UMD), `mathlive-fonts.css`, `mathlive-static.css`, `fonts/`, `sounds/` | Whole folder must move together — MathLive auto-detects its asset base path from its own `<script>` tag location |
| `speech-rule-engine/` | `sre.js` (UMD, global `SRE`), `mathmaps/base.json`, `mathmaps/en.json`, `mathmaps/nemeth.json` | Trimmed from the full multi-language `mathmaps/` (~4.2MB) down to just what we use (~800KB) |
| `compute-engine/` | `compute-engine.min.esm.js` | Self-contained ESM bundle from `@cortex-js/compute-engine`, zero external imports — safe to import via relative path with no bundler |
| `mathjax/` | `core.js`, `startup.js`, `input/mml.js`, `output/svg.js` | Modular components only (not a combined component — see docs/MATHJAX_SVG_IMPLEMENTATION_PLAN.md and docs/HISTORY.md, "MathJax integration for portable SVG output"). `startup.js` is the `<script>` entry point; it dynamically fetches the sibling files relative to its own location, same self-locating pattern as `mathlive/` |
| `mathjax-newcm-font/` | `svg.js` (base glyphs), `svg/dynamic/*.js` (40 files, ~9.6MB, non-Latin scripts) | Only `svg.js` loads upfront; the `dynamic/` files are fetched on demand only if an equation actually uses those characters — vendored anyway so lazy-loading never 404s |

`package.json` versions (for reference/tracking only — not loaded at runtime):
`mathlive ^0.105.3`, `speech-rule-engine ^5.0.0-rc.3` (this is npm's current `latest`
tag — a v5 release candidate, not yet a final release; worth checking back on),
`@cortex-js/compute-engine ^0.66.0`, `mathjax ^4.1.3`,
`@mathjax/mathjax-newcm-font ^4.1.3`.

## Testing and QA

- **`npm test`** (`node --test`): 83 unit tests on `pure-logic.js`, built with
  `@xmldom/xmldom` trees shaped like real MathLive output; several run the real
  SRE from `node_modules` to lock in reading/braille fixes. Also checks that
  `script.js` and `pure-logic.js` parse as ES modules. No CI -- tests run only
  when someone runs them.
- **`npm run braille-report`**: SRE vs. MathCAT's 758-case Nemeth suite
  (511 exact as of September 2026). A report, not a gate.
- **Corpus scan:** `tests/fixtures/mathlive-corpus.txt` (315 expressions) was
  run through the app's pipeline in headless Chromium, then SRE and the
  MathCAT command-line tool, with automatic flags for invalid MathML and odd
  readings. The tooling lived in a sandbox, not the repo; re-run it after a
  MathLive upgrade, since the cleanup depends on MathLive's exact output.
- **Browser QA** so far has been headless (Playwright/Chromium, puppeteer +
  axe-core). **No real screen-reader pass yet** -- see open items.

## Open items and backlog

Resolved items and their history are in docs/HISTORY.md ("Open items for next
session" and the dated sections).

**Needs Derek**
- **NVDA (or JAWS) listen-through** -- never done. Should cover: Read Aloud
  in both Description styles; MathML with
  chosen meanings ("open interval", "absolute value", "y of t"); a few cleanup
  cases (`|x|+|y|`, `f'(x)`, `\{x \mid x>0\}`, `P(A|B)`); the `#output-status`
  announcements and the equation field's label; a pasted "SVG + hidden
  MathML" snippet. MathCAT's command-line tool already reads all of these
  correctly.
- **Untrack `node_modules`** (now in `.gitignore`; still tracked in git, about
  3,500 files) and commit the work since September 25.
- **Ask disability services / braille transcribers whether students need UEB
  math** -- that's the deciding question for MathCAT (below).
- Optional: one look at a normal DevTools console to retire the old
  "Illegal return statement" question (it never appeared in automated runs
  after the first tool).

**Next candidates**
- SSML output format -- built into SRE.
- Report MathLive's export gaps and MathML quirks upstream (the tables in
  docs/HISTORY.md are the repro list).

**Backlog**
- Downloadable BRF file for Braille (secondary).
- More Description languages (Spanish, French, ... -- SRE has them; each needs
  its mathmaps JSON vendored).
- Recent-equations list (persistence is single-slot today).
- Verify focus rings and accessible names on MathLive's shadow-DOM icon
  buttons (virtual keyboard, menu); axe's `nested-interactive` on
  `<math-field>` is inside MathLive and not fixable here.
- How "SVG + hidden MathML" survives specific destinations (Canvas's HTML
  editor may strip the inline style or `<math>`).

**Pinned (Derek)**
- **MathCAT in the browser** (WebAssembly, replacing SRE): would add UEB and
  other braille codes, languages, ClearSpeak/SimpleSpeak, SSML, intent-aware
  Description/Braille, and fix SRE's Nemeth gaps. No npm package; would need
  a small wasm-bindgen wrapper built by GitHub Actions and vendored (~1.5-2.5MB
  estimated, unmeasured). Downsides: maintainer's caution about in-browser
  use, Description wording would change (no MathSpeak), build pipeline to
  maintain. Not worth it unless UEB is needed. Full write-up: docs/HISTORY.md,
  "Ideas borrowed from MathCAT".

**Known limitations (accepted for now)**
- `a\equiv 1\pmod 4`: MathCAT reads "1 times (mod 4)".
- Arcs (`\overarc`, `\overset{\frown}`): SRE has no speech word or braille.
- SRE Nemeth gaps: multipurpose indicator (`|x||y|`, `10+-5`), comma in
  subscripts (`x_{i,j}`), extra blank after `\cdots`; layout differences for
  matrices, `cases`, display sums.
- Description and Braille ignore intents (SRE doesn't read them).
- Letters before multi-term parentheses (`a(b+c)`) are always multiplication
  and aren't asked about; `P(1+rt)` stays "P times" on purpose.

**Maintenance**
- `speech-rule-engine` is pinned to `5.0.0-rc.3` (npm's `latest`); re-vendor
  when a stable `5.0.0` ships, then re-run `npm test` and the braille report.
- Open question: whether MathJax's `startup.js` alone is enough or
  `loader.js` should be vendored too (everything has worked without it).
- After any MathLive upgrade: re-run `npm test` and the corpus scan; the
  cleanup and export workaround depend on MathLive's exact output.
