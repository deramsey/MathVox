# MathVox — Project Notes

Internal reference doc. Read this before doing further work on MathVox — it captures the state of the project, decisions made (and why), and what's queued up next.

- **Repo:** https://github.com/deramsey/MathVox.git
- **Live:** https://math-vox.vercel.app/ (Vercel, auto-deploys on push)
- **Owner:** Derek Ramsey, Cleveland Community College
- **Stack:** vanilla HTML/CSS/JS. No bundler, no backend, no build step.

## What this project is

MathVox started as a small tool (type an equation, hear it read aloud) and is being
grown into a robust math-accessibility utility for instructors: enter an equation once,
export it in whatever form is needed to make it accessible in an online course or
document (screen-reader text, Braille, portable HTML, interchange formats for other
tools, etc.).

Explicitly **not** in scope right now: instructor workflow features (batch processing,
equation libraries, direct Canvas API push). Derek treats this as a different kind of
project from his other Canvas tooling — keep it focused on the accessibility
conversion pipeline itself.

## Current architecture

- `index.html` — page shell, loads all vendored libraries via plain `<script>`/`<link>` tags.
- `resources/script.js` — the only app logic file, loaded as `type="module"`.
- `resources/style.css` — all styling, including dark mode and dyslexia-font variants.
- `resources/vendor/` — **self-hosted copies of every third-party library's built files.**
  This is the single most important architectural fact about the project — see below.

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

## Current feature set (built and deployed)

- MathLive `<math-field>` visual equation editor.
- Output format picker (native `<select>`, not a custom ARIA widget — deliberate
  choice for guaranteed keyboard/screen-reader behavior). Now placed **above** the
  equation input (moved per instructor accessibility feedback, July 2026) so
  screen-reader users can choose the target format before entering data — the
  output re-renders as soon as they're done either way.
- Raw LaTeX text entry (`#latex-input` textarea + `#convert` button), added
  July 2026 in response to feedback that editing things like stray braces
  inside the rendered math-field was difficult. Two-way sync with the
  math-field: typing in the visual editor updates the textarea (unless it's
  focused, to avoid clobbering in-progress edits); the Convert button (or
  Ctrl/Cmd+Enter) calls `mf.setValue()` to push the textarea's LaTeX into the
  math-field. This was already the planned design in "Researched, not yet
  built → Raw LaTeX input" below — now implemented.
- `#kbd-help` `<details>`/`<summary>` panel next to the equation field
  documenting math-field keyboard shortcuts (virtual keyboard toggle, context
  menu, navigation, speak) sourced from MathLive's own keybindings reference
  (https://mathlive.io/mathfield/reference/keybindings/), so keyboard users
  know they don't need to physically reach the small toolbar icons in the
  field's corner — the same actions are global shortcuts.

| Format | Source |
|---|---|
| LaTeX | `mf.getValue('latex')` |
| ASCII Math | `mf.getValue('ascii-math')` |
| MathML | `mf.getValue('math-ml')` |
| MathJSON | `mf.getValue('math-json')` — requires Compute Engine wired to `MathfieldElement.computeEngine` |
| Description (plain-language text) | `mf.getValue('spoken-text')` — this is what Derek referred to once as "MathText" |
| Braille (Nemeth) | Speech Rule Engine, `SRE.setupEngine({modality:'braille', locale:'nemeth'})` then `SRE.toSpeech(mathml)` |

- "Read Equation Aloud" button — MathLive's built-in `speak` command. Separate from the
  Description format (that's text; this is actual audio).
- Copy-to-clipboard button, `aria-label` updates to name the current format.
- Accessibility polish pass: skip link, labeled math-field (had no label originally),
  `aria-live="polite"` on the output region, visible `:focus-visible` outlines, dark
  mode toggle (localStorage-persisted, defaults to OS `prefers-color-scheme`),
  dyslexia-friendly font toggle (Verdana/Trebuchet MS + spacing — not true
  OpenDyslexic; that would need a bundled font file if ever wanted).
- Earlier bug fixes: PWA manifest icon filename/size mismatch, duplicate/mismatched
  CDN+local MathLive loading, `node_module` (missing "s") typo in a CSS `@import`,
  missing comma in a `font-family` declaration.
- July 2026 accessibility feedback pass:
  - MathML output now wraps `mf.getValue('math-ml')`'s inner markup in the
    required root element (`<math xmlns="http://www.w3.org/1998/Math/MathML"
    display="block">...</math>`) — previously the fragment alone wasn't valid
    to paste into HTML.
  - Dark mode contrast fix: introduced `--blue-text` (lighter blue, for text
    on dark backgrounds) and `--blue-solid` (darker blue, for solid fills
    behind white text) instead of reusing one `--blue` for both jobs, which is
    what caused the "Dyslexia-Friendly Font" button text and the pressed
    "Light Mode" button to fall short of WCAG AA. Buttons also gained
    `font-weight: 600` for extra margin. Light mode is unaffected (its single
    blue already passed both contexts).

### Why Speech Rule Engine and not MathCAT for Braille

MathCAT produces excellent Nemeth braille but its own maintainer explicitly
recommends against using it in-browser (it's a Rust/WASM library, not packaged for
JS consumption). Speech Rule Engine (SRE) is the maintained, TypeScript, browser-ready
alternative — same Nemeth output quality tier, no WASM/Rust toolchain needed. Verified
empirically (Node sandbox test) that `{modality:'braille', locale:'nemeth'}` produces
correct Unicode Nemeth braille strings.

## Vendored dependencies (`resources/vendor/`)

| Folder | Contents | Notes |
|---|---|---|
| `mathlive/` | `mathlive.js` (UMD), `mathlive-fonts.css`, `mathlive-static.css`, `fonts/`, `sounds/` | Whole folder must move together — MathLive auto-detects its asset base path from its own `<script>` tag location |
| `speech-rule-engine/` | `sre.js` (UMD, global `SRE`), `mathmaps/base.json`, `mathmaps/en.json`, `mathmaps/nemeth.json` | Trimmed from the full multi-language `mathmaps/` (~4.2MB) down to just what we use (~800KB) |
| `compute-engine/` | `compute-engine.min.esm.js` | Self-contained ESM bundle from `@cortex-js/compute-engine`, zero external imports — safe to import via relative path with no bundler |

`package.json` versions (for reference/tracking only — not loaded at runtime):
`mathlive ^0.105.3`, `speech-rule-engine ^5.0.0-rc.3` (this is npm's current `latest`
tag — a v5 release candidate, not yet a final release; worth checking back on),
`@cortex-js/compute-engine ^0.66.0`.

## Researched, not yet built

### MathJax integration for portable "HTML5" output

Requested: take LaTeX and produce embeddable HTML5 output via MathJax, as a new format
option alongside the existing six.

- MathJax v4.1.2 current. Conversion via `tex2svgPromise` / `tex2chtmlPromise` /
  `mathml2svgPromise` / etc. — promise-based versions preferred in v4.
- Three candidate output shapes, meaningfully different in portability:
  - **CHTML** — real HTML+CSS, needs MathJax's runtime CSS/fonts loaded on whatever
    page it's pasted into. Not portable on its own.
  - **SVG** — self-contained (`fontCache: 'local'` or `'none'`), renders correctly
    anywhere with no external dependency, and MathJax bakes in a hidden "assistive
    MathML" annotation automatically for screen readers. **Recommended default** for
    a general-purpose "paste this anywhere" output.
  - **MathML** — already available today with zero MathJax needed (MathLive already
    exports it). Native browser support is broad now (Firefox, Safari, Chrome 109+,
    Edge, Opera, Samsung Internet all ship MathML Core), but rendering maturity is
    better in Firefox/Safari than Chromium.
- **Canvas-specific wrinkle:** Canvas's Rich Content Editor already runs its own
  MathJax instance and accepts pasted MathML, or LaTeX wrapped in `\(...\)`/`$$...$$`
  delimiters, directly in its HTML source view — auto-converting to MathML for
  accessibility. For Canvas specifically, MathVox's existing MathML output (or even
  just delimited raw LaTeX) may already be sufficient without adding MathJax at all.
  MathJax pre-rendering earns its keep for destinations that *don't* already run
  MathJax — Word docs, other LMSs, plain web pages.
- Deployment: same vendoring pattern as everything else. `npm install mathjax@4` drops
  ready browser-loadable "combined component" files straight into
  `node_modules/mathjax` (e.g. `tex-svg.js`) — grab the needed one plus the default
  `mathjax-newcm` font into `resources/vendor/mathjax/`.

### Requested follow-up: MathML ⟷ SVG toggle

Instead of always pre-rendering through MathJax's TeX parser, feed the **same MathML
string MathLive already produces** into MathJax's `mathml2svgPromise()` rather than
raw LaTeX into `tex2svgPromise()`. Benefits:
- Both toggle states are guaranteed to represent identical parsed math — no risk of
  MathJax's TeX parser and MathLive's MathML exporter interpreting an expression
  differently.
- Lets us use MathJax's smaller `mml-svg` combined component (MathML-in/SVG-out only,
  no TeX parser bundled) instead of the general `tex-svg.js` — smaller vendor
  footprint.

Planned shape: small native radio/segmented toggle ("Pure MathML" / "Rendered SVG"),
consistent with the project's preference for native form controls over custom ARIA
widgets. Both states can share one "live preview + copyable source" panel — SVG drawn
by MathJax, MathML drawn by the browser's native renderer.

### Raw LaTeX input — ✅ built (July 2026)

Rather than a parallel input/conversion pipeline, the plan is a small "paste LaTeX"
box that calls `mf.setValue(pastedLatex)` to load pasted-in LaTeX straight into the
existing math-field. That instantly makes every existing (and future) output format
available for it — no separate code path to maintain. See "Current feature set"
above.

## Explicitly deferred

- **Natural-language graph description / sonification** — pinned by Derek for later.
  When picked back up, may need its own additional interface on the page (separate
  from the equation format picker) rather than fitting into the existing pattern,
  since a graph isn't a single expression the way the current formats are.
- **Instructor workflow features** (batch processing, equation library/reuse, direct
  Canvas API push) — explicitly out of scope per Derek; treat this project's scope as
  the accessibility conversion pipeline only.

## Open items for next session

- Confirm direction on MathJax: build the SVG/MathML toggle now, or hold.
- `speech-rule-engine` is pinned to a pre-release (`5.0.0-rc.3`) because that's npm's
  current `latest` tag — watch for a stable `5.0.0` and consider re-vendoring when it
  ships.
- No automated tests or CI exist yet. No headless browser was available in the
  sandbox used to build the current feature set, so verification so far has been:
  Node-level testing of SRE/Compute Engine APIs in isolation, manual file/path
  cross-referencing, and Derek's own in-browser checks after deploy. A real
  browser-based smoke test (does every format actually render correctly end-to-end)
  is still worth doing whenever there's time.
