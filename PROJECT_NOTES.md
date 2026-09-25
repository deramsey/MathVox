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
- **Shareable link** (built September 2026) — a "Copy shareable link" button
  next to Copy, plus a live-updated URL hash, so sending someone the page's
  own address reproduces the exact equation and output format instead of a
  blank app. See "Feature ideas raised in conversation" below for the
  implementation notes.

| Format | Source |
|---|---|
| LaTeX | `mf.getValue('latex')` |
| ASCII Math | `mf.getValue('ascii-math')` |
| MathML | `mf.getValue('math-ml')` |
| MathJSON | `mf.getValue('math-json')` — requires Compute Engine wired to `MathfieldElement.computeEngine` |
| Description (plain-language text) | `mf.getValue('spoken-text')` — this is what Derek referred to once as "MathText" |
| Braille (Nemeth) | Speech Rule Engine, `SRE.setupEngine({modality:'braille', locale:'nemeth'})` then `SRE.toSpeech(mathml)` |
| Portable SVG | MathJax `MathJax.mathml2svgPromise()`, fed MathLive's `mf.getValue('math-ml')` wrapped in a `<math>` root — see "MathJax integration" below |

- **Portable SVG format** (built August 2026, see
  `MATHJAX_SVG_IMPLEMENTATION_PLAN.md` for the full design/research doc) — a
  seventh output format for pasting equations somewhere that doesn't already
  render MathML well (Word docs, other LMSs, plain web pages; Canvas doesn't
  need this since its Rich Content Editor already runs its own MathJax and
  handles MathVox's existing MathML/LaTeX fine). Shows both a rendered
  preview (fixed light background regardless of MathVox's own theme, since
  the exported SVG hardcodes black strokes, and `aria-hidden` since it's a
  sighted-user "does this look right" check, not a second accessible
  channel — Description/Braille/Read Aloud already cover that) and the
  copyable SVG source in the usual output panel. See "MathJax integration"
  below for the vendoring/config details.
  - **The exported SVG source itself carries its own accessible name**
    (added after a direct question about it): `mf.getValue('spoken-text')` is
    embedded as a `<title>` (SVG's equivalent of an `<img>` `alt`), with
    `role="img"` set explicitly for reliable accessible-name computation
    across browsers/AT. This matters because once the SVG is copied out of
    MathVox, none of the page's other accessibility features travel with
    it — it's on its own from that point on, so it needs to be
    self-describing. Reuses the same spoken-text string already powering the
    Description format and Read Equation Aloud (one source of truth,
    benefits automatically from the SRE mathspeak fix below, not a second
    description to maintain). This is a simpler, different mechanism than
    MathJax's own `assistiveMml` extension (deferred separately below) —
    plain `<title>`/`role="img"`, no MathJax accessibility extensions needed.
- **MathML semantic ambiguity audit** (built August 2026, see
  `MATHML_SEMANTIC_LINT_PLAN.md` for the full research/design doc). Prompted
  by prepping for a DAISY math-a11y presentation: audited whether MathVox's
  MathML output counts as "semantic" by today's standard, and found it
  doesn't — `mf.getValue('math-ml')` is pure Presentation MathML with zero
  occurrences of `intent` anywhere in the vendored `mathlive.js` bundle
  (confirmed via grep), and MathLive shows no sign of adding support. `intent`
  (new in MathML 4/MathML Core) is the mechanism current AT actually uses to
  resolve notational ambiguity — it's what MathCAT (the engine behind math
  support in JAWS and NVDA) reads to disambiguate, e.g., whether `(a, b)`
  means a point or an open interval. MathVox's existing `<semantics>` +
  `<annotation encoding="application/x-tex">` wrapper doesn't solve this
  (the LaTeX source is exactly as ambiguous as the rendered notation).
  Since MathVox has no way to know the author's true intended meaning, this
  feature doesn't try to auto-generate `intent` values — it's a read-only
  audit that parses the MathML (via `DOMParser`, walking the tree rather than
  regexing LaTeX text, since LaTeX has many equivalent spellings for the same
  shape) and flags two known-ambiguous patterns:
  - **Bare parenthesized comma-groups** (`(a, b)` — point? interval? GCD?).
    Carefully guarded against false-positiving on ordinary function calls
    like `f(x, y)`, which share the same shape but are structurally
    unambiguous (MathML marks them with an invisible U+2061 FUNCTION
    APPLICATION operator) — verified with a 7-case Node test harness
    (`@xmldom/xmldom` standing in for browser `DOMParser`) covering nested
    and flattened function-call shapes, negative controls, and repeated/
    combined shapes in one equation.
  - **Vertical-bar pairs** (`|x|` — absolute value? set-builder? "divides"?).
  - Deliberately **out of scope**: matrix-vs-binomial-coefficient visual
    confusion, colon ambiguity (ratio/mapping/set-builder — too many
    unambiguous everyday uses, e.g. `f(x) := ...`), and domain-specific
    superscript ambiguity (`x^2` vs. Lebesgue-space `L^2`) — all judged
    untractable or too false-positive-prone for a mechanical pass; see the
    plan doc §2c for the full reasoning.
  - Surfaces as a new `#mathml-notes` element, shown only for the MathML
    format, reset on every `updateOutput()` call — kept separate from
    `#text-cont` (same pattern as the SVG preview/suggested-alt-text) so the
    Copy button still copies clean MathML, not the note along with it.
  - **Not yet verified against real MathLive/browser output** — the test
    harness uses hand-built representative MathML snippets (best-effort
    approximations of what MathLive is documented to produce), not real
    MathLive output, since no browser is available in this sandbox. Two
    specific unknowns flagged for real-browser confirmation: the exact
    character(s)/attributes MathLive emits for `|`/`\vert`/stretchy fences
    (the detector matches a candidate set — `|`, `∣` U+2223, `‖` U+2016 —
    rather than one hardcoded character), and whether `doc.querySelector('parsererror')`
    reliably detects malformed-XML parse failures across browsers the way it
    does in the `@xmldom/xmldom` test harness.
  - **Explicitly deferred, larger follow-on** (not part of this build):
    auto-injecting correct `intent` values for the subset of cases where the
    *LaTeX command itself* already unambiguously implies the meaning — e.g.
    `\binom{n}{k}` → `intent="binomial($n,$k)"`, `\hat{x}` → `intent="hat($x)"`.
    Unlike the bare-tuple/vertical-bar cases, these don't require guessing at
    author intent, so they're a plausible next step if this audit pass proves
    useful — see plan doc §7.
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
  - Equation + selected output format now persist across reloads
    (`localStorage`, keys `mathvox-latex` / `mathvox-format`), same pattern as
    the theme/dyslexia-font toggles — no more losing your work on refresh.
  - Convert now checks `mf.errors` after `setValue()` and shows an inline,
    plain-language `role="alert"` message (`#latex-error`) if the LaTeX didn't
    fully parse, instead of silently applying whatever MathLive could salvage.
  - The LaTeX textarea auto-grows with content (`autoGrowLatexInput()`)
    instead of being a fixed 2 rows with an internal scrollbar.
  - Full-page WCAG contrast pass (not just the two originally flagged
    buttons): found and fixed two more real failures — the skip-link's solid
    blue fill in dark mode (same root cause as the button fixes), and the
    `:focus-visible` amber outline (`#ffb703`), which was only ~1.75:1 against
    a white background (well under the 3:1 a focus indicator needs). Light
    mode now uses a darker amber (`#a83e00`, ~6.25:1 vs white); dark mode kept
    the original amber, which was already ~10.5:1 against the dark background.
    Also added a dedicated `--error-text` variable (red, tuned per theme) for
    the new inline LaTeX error message.
- August 2026 QA pass (four findings, all fixed):
  - **MathJSON silently embedding a raw error node.** Compute Engine can
    "succeed" (no thrown exception) while burying an
    `["Error", ["ErrorCode", ...]]` node inside an otherwise-valid MathJSON
    tree — QA's exact repro was `\pm` inside a `\frac` (the quadratic-formula
    shape), since `\pm` represents two possible values and dividing that hits
    an `incompatible-type` error. `findMathJsonError()` now recursively
    scans the tree for that shape and, if found, shows a plain-language
    explanation above the raw (still-shown, for reference) JSON instead of
    leaking the internal error blob as if it were normal output.
  - **Unclosed braces not caught.** `mf.errors` missed `\frac{1}{` (a single
    unclosed brace) entirely — MathLive is lenient enough to silently accept
    it and render a broken/incomplete result rather than flagging it, while
    still correctly catching more severely broken input. `findBraceImbalance()`
    now counts `{`/`}` directly on the raw textarea input (escaped `\{`/`\}`
    excluded, since those are literal characters, not grouping delimiters) as
    a backstop independent of MathLive's own error detection, feeding into
    the same `#latex-error` message.
  - **No heading structure.** Added `<h1 class="sr-only">` for the page title
    and `<h2 class="sr-only">` headings for the format-picker and
    equation-entry sections (visually hidden since the visible label/heading
    text already covers sighted users) — previously the only heading on the
    entire page was the dynamic output-panel label (`#format-name`), leaving
    screen reader users navigating by heading with almost nothing to land on.
  - **Spoken-text quoting/capitalization, round 1.** Description output and
    Read Equation Aloud both use `mf.getValue('spoken-text')` / the `speak`
    command, which by default use MathLive's simple built-in speech rules —
    QA found these wrap single-letter variables in literal quotes and
    capitalize them (`'x' equals...`), which reads like a typo and can make
    some TTS engines audibly say "quote." First fix attempt: set
    `MathfieldElement.textToSpeechRules = 'sre'` (with
    `textToSpeechRulesOptions: {domain: 'mathspeak', ruleset: 'mathspeak-default'}`)
    to use Speech Rule Engine's academic-standard mathspeak rules instead of
    MathLive's built-in ones — this config is still in place and still
    correct (it's what tells MathLive which rule engine to consult at all).
  - **Round 2: missing spaces, and the real root cause.** After round 1, a
    follow-up check found the *displayed* description text was missing
    spaces between words. Verified directly in a Node sandbox
    (`speech-rule-engine` installed standalone, same version vendored here):
    SRE's mathspeak output is genuinely fine when the engine is configured
    correctly (`SRE.setupEngine({modality:'speech', domain:'mathspeak',
    style:'default', locale:'en'})` on the quadratic formula produces
    `"x equals StartFraction negative b plus or minus StartRoot b squared
    minus 4 a c EndRoot Over 2 a EndFraction"` — properly spaced). The actual
    bug: **SRE is a single shared engine with a stateful modality**
    (braille vs. speech), and MathVox's own Braille feature configures it
    for `'braille'` eagerly on page load. `mf.getValue('spoken-text')` goes
    through MathLive's own internal bridge to that *same* shared engine —
    if the engine was last configured for Braille (or the bridge doesn't
    reconfigure it reliably itself), speech generation runs against a
    mis-configured engine. Confirmed empirically that a stale/wrong modality
    doesn't error, it silently returns output for the *wrong* modality —
    exactly the kind of silent-wrong-output failure this whole project has
    been chasing.
    **Fix:** stopped trusting `mf.getValue('spoken-text')` (MathLive's
    opaque internal bridge) entirely. `getSpokenText()` now explicitly
    reasserts the engine's modality to `'speech'`
    (`getSreSpeechReady()`) immediately before calling `SRE.toSpeech()`
    directly — the exact same pattern Braille output already used, just
    generalized so *every* SRE consumer (Braille, Description, the SVG
    title, and now Read Equation Aloud before triggering `speak`)
    reasserts the modality it needs immediately before use, rather than
    assuming a one-time page-load setup stays valid. `setSreModality()` is
    the shared helper; nothing is permanently cached anymore, on purpose.
    **Not yet confirmed in a real browser** — no headless browser is
    available in this sandbox, so this is verified against SRE directly in
    Node, not against MathLive's actual in-browser behavior end-to-end.
    Specifically worth re-checking: Description panel text, the SVG title,
    and — since it goes through MathLive's own `speak` command rather than
    our direct `getSpokenText()` — whether Read Equation Aloud's *audio* is
    also affected (a garbled string could still be audible as run-together
    words even if we can't inspect it as text). If it's still off after this
    fix, the next step would be replacing MathLive's `speak` command with a
    direct Web Speech API call using our now-verified `getSpokenText()`
    string — a bigger change, deliberately not made yet without a browser
    to validate it against.
  - **Suggested alt text for the SVG format.** SVG has no native `alt`
    attribute (that's an `<img>`-only HTML attribute) — the `<title>` now
    embedded in the SVG source (see "Portable SVG format" above) covers
    pasting it as inline markup, but if someone instead saves it as an image
    file and references it with `<img>`, the embedded `<title>` is typically
    ignored by browsers/AT in that context. Added a `#svg-alt-suggestion`
    line under the preview showing the same spoken-text string as a
    ready-to-paste alt-text suggestion for that scenario.

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
| `mathjax/` | `core.js`, `startup.js`, `input/mml.js`, `output/svg.js` | Modular components only (not a combined component — see "MathJax integration" above). `startup.js` is the `<script>` entry point; it dynamically fetches the sibling files relative to its own location, same self-locating pattern as `mathlive/` |
| `mathjax-newcm-font/` | `svg.js` (base glyphs), `svg/dynamic/*.js` (40 files, ~9.6MB, non-Latin scripts) | Only `svg.js` loads upfront; the `dynamic/` files are fetched on demand only if an equation actually uses those characters — vendored anyway so lazy-loading never 404s |

`package.json` versions (for reference/tracking only — not loaded at runtime):
`mathlive ^0.105.3`, `speech-rule-engine ^5.0.0-rc.3` (this is npm's current `latest`
tag — a v5 release candidate, not yet a final release; worth checking back on),
`@cortex-js/compute-engine ^0.66.0`, `mathjax ^4.1.3`,
`@mathjax/mathjax-newcm-font ^4.1.3`.

### MathJax integration for portable SVG output — ✅ built (August 2026)

Full research/design doc: `MATHJAX_SVG_IMPLEMENTATION_PLAN.md` (kept as a
standing reference, not just a historical artifact — it has the reasoning
behind the vendoring choice in more depth than is repeated here).

What shipped, and what changed from the earlier plan below:

- **MathJax version is 4.1.3** (was 4.1.2 when last checked).
- **Not a combined component.** The obvious choice, the `mml-svg` combined
  component, was actually inspected (installed via npm, real files measured)
  rather than assumed — it's **1.7MB**, almost entirely because it bundles
  MathJax's *own* internal copy of Speech Rule Engine (for its speech/Braille/
  explorer extensions) plus a contextual menu, none of which MathVox needs or
  uses, and which would duplicate the `speech-rule-engine` already vendored
  separately for Braille. Loading only `input/mml` + `output/svg` via
  MathJax's modular loader (`startup.js` + a `loader.load` config, an
  officially supported path, not a hack) comes to **340KB**. Plus the
  `mathjax-newcm` font's SVG data (956KB, vendored from the separate
  `@mathjax/mathjax-newcm-font` package — fonts split out of the core
  package as of v4), total new footprint is **~1.3MB**, in line with what's
  already vendored for MathLive/SRE/Compute Engine.
- **Correction to a claim below:** "MathJax bakes in a hidden assistive
  MathML annotation automatically for screen readers" was true for MathJax
  v3, but **v4 flipped that default off** — the accessibility extensions
  that *are* on by default in v4 combined components are a different,
  heavier system (semantic enrichment, speech, Braille, an interactive
  "explorer", all tied to MathJax's own menu), which is itself part of why
  the combined component was skipped here. Whether to add an
  assistive-MathML fallback into the exported SVG some other way is logged
  as a deferred item below, not solved by this feature.
- **CHTML was not pursued** — still true that it isn't portable on its own
  (needs MathJax's runtime CSS/fonts present on the destination page), so
  SVG remains the right shape for a "paste this anywhere" export.
- Feeds MathLive's `mf.getValue('math-ml')` into `MathJax.mathml2svgPromise()`
  (not a LaTeX-through-`tex2svgPromise()` path) — same MathML the MathML
  format already exports, so there's no risk of MathJax's TeX parser and
  MathLive's MathML exporter interpreting an expression differently, and no
  need to vendor MathJax's (much larger) TeX input processor at all.
- `svg: { fontCache: 'local' }` and the CSS-inlining/attribute-stripping
  recipe follow MathJax's own documented "Creating Stand-Alone SVG Images"
  pattern, so each exported SVG is genuinely self-contained.
- UI: went with a flat new dropdown entry ("Portable SVG"), not the
  segmented MathML/SVG toggle sketched below — simpler, no extra
  state/persistence, consistent with the six existing entries. Shows a
  rendered preview (fixed light background, `aria-hidden`) above the usual
  copyable-text panel.
- **Not yet verified in a real browser** (see "Open items for next session").

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

### From the July 2026 accessibility feedback pass — flagged but not yet built

Identified as related good ideas while fixing the five reported issues above;
Derek chose to revisit these later rather than build them immediately. Two
have since been built (see below); the rest are still deferred:

- ~~**MathML companion annotation**~~ — ✅ built. `math-ml` output now wraps
  the presentation markup in `<semantics>` with an
  `<annotation encoding="application/x-tex">` sibling containing the original
  LaTeX (escaped for `&`/`<`/`>`) — the standard MathML parallel-markup
  pattern, same thing MathJax's own MathML output does.
- ~~**Portable HTML5/SVG output via MathJax**~~ — ✅ built, see "MathJax
  integration for portable SVG output" above.
- **Respect `forced-colors` / `prefers-contrast: more`** — no support yet for
  Windows High Contrast mode or the `prefers-contrast` media feature.
- **Verify `:focus-visible` actually renders on the math-field's internal
  icons** (virtual-keyboard-toggle, menu-toggle) — they live in MathLive's
  shadow DOM and may not inherit the page's focus-ring styling. The current
  fix (documented keyboard shortcuts in `#kbd-help`) sidesteps needing to tab
  to them at all, but this is still worth confirming directly.
- **Confirm MathLive supplies real accessible names** for those same shadow-DOM
  icon buttons, rather than relying solely on the keyboard-shortcut workaround.
- ~~**Bigger touch/click targets**~~ — ✅ built. `#copy` and the math-field's
  `virtual-keyboard-toggle`/`menu-toggle` parts now get explicit
  `min-width`/`min-height: 44px` (WCAG 2.5.5). The math-field ones are
  best-effort since they're in MathLive's shadow DOM — worth a visual check
  in case MathLive's own internal sizing/padding wins on specificity.
- **Downloadable BRF file for Braille** output, not just the on-screen Unicode
  dot-pattern text, for anyone using an actual braille display/embosser.

### Feature ideas raised in conversation (August 2026)

A round-up requested after the SVG/QA work above — some overlap with items
already listed elsewhere in this file (noted inline); the rest are net-new
ideas not yet designed or built:

- Downloadable BRF file for Braille output — *already listed just above.*
- Windows High Contrast (`forced-colors`) / `prefers-contrast: more` support
  — *already listed just above.*
- Verify (and fix if needed) accessible names and `:focus-visible` on the
  math-field's internal shadow-DOM icons — *already listed just above (two
  separate bullets).*
- Replace "Read Equation Aloud" with a direct Web Speech API call using our
  verified SRE text, if MathLive's own `speak` command still has the same
  issue in audio — *already logged under "Round 2: missing spaces" above.*
- **"Download as .svg file" button** alongside Copy, for the Portable SVG
  format — net-new.
- **SSML output format** — SRE can produce it; useful for higher-quality
  external TTS or tools that accept SSML directly — net-new.
- **Copy button for the suggested alt-text line** (currently just displayed
  as text, no dedicated copy action) — net-new.
- **Choice of Braille code** — Nemeth vs. UEB Math — instead of
  Nemeth-only — net-new.
- **Additional spoken-description languages** — SRE/mathspeak supports
  French, Spanish, German, and Italian beyond English — net-new.
- **Equation history / recent-equations list**, beyond just remembering the
  last one (current persistence is single-slot) — net-new.
- ~~**Shareable link**~~ — ✅ built (September 2026). The URL hash stays in
  sync with the current equation/format as you type or change format
  (`updateUrlHash()`, via `history.replaceState` so it doesn't spam browser
  history) — same pattern already used in the OrgChart app. A new "Copy
  shareable link" button next to Copy copies `location.href` directly. On
  load, a link's hash (`?`-style `eq`/`format` params after the `#`) takes
  priority over the locally saved equation, and then overwrites it -- so
  following a shared link also becomes your last-used equation on that
  browser going forward.
- **Automated regression tests for the pure-logic helpers** specifically
  (`findMathJsonError`, `findBraceImbalance`, `describeMathJsonError`, etc.)
  so future changes can't silently reintroduce the bugs the August 2026 QA
  pass found — more specific than the general "no automated tests or CI
  exist yet" note below.

## September 2026 real-browser QA pass

First real-browser verification this project has had (Derek ran a local
static server; Claude drove it via an automated browser). Found and fixed
two bugs that no amount of Node-level testing could have caught, confirmed
several previously-unverified things now work, and confirmed one whole
feature has never actually worked. Details below; "Open items for next
session" (further down) reflects what's left after this pass.

- **CRITICAL, fixed: the entire app failed to load in a real browser.**
  `findAmbiguousNotation()`'s nested `walk()` helper (added for the MathML
  semantic ambiguity audit, see below) was missing its own
  `function walk(node, precedingSibling) {` declaration line and
  `const children = elementChildren(node);` -- the code that's supposed to
  be walk's *body* was sitting directly inside `findAmbiguousNotation`
  instead, which shifted the brace that was meant to close `walk` into
  closing `findAmbiguousNotation` early, leaving `walk(doc.documentElement,
  null); return found;` as orphaned top-level statements. Node's plain
  `node --check` never caught this because CommonJS wraps the whole file in
  an implicit function (making a stray top-level `return` legal there), but
  the browser loads `script.js` as a real ES module (`<script
  type="module">` in index.html), where top-level `return` is a hard
  `SyntaxError: Illegal return statement` -- which aborts evaluation of the
  *entire file*, before a single event listener gets attached. Fixed by
  restoring the missing two lines. Lesson for future edits to this file:
  check syntax with `cp resources/script.js /tmp/x.mjs && node --check
  /tmp/x.mjs` (forces ESM parsing rules), not plain `node --check
  resources/script.js` (silently CommonJS, hides this exact class of bug).
- **Fixed: MathJSON format was broken end-to-end, not just the error case.**
  `mf.getValue('math-json')` returns a JSON *string* in the vendored
  MathLive version, not an already-parsed array/object as
  `findMathJsonError()` and the display code assumed. Effects: (1) the
  plain-language error explanation (built for the quadratic-formula `\pm`
  QA fix) never fired -- `Array.isArray()` on a string is `false`, so
  `findMathJsonError` always returned `null` -- and the raw
  `["Error",["ErrorCode",...]]` blob leaked straight to the user exactly as
  it did before that fix; (2) even the *non-error* "happy path" output was
  wrong -- a double-escaped JSON string (`"[\"Add\",...]"` with visible
  backslashes) instead of clean pretty-printed JSON. Fixed by
  `JSON.parse()`-ing the value when it's a string before using it. Verified
  both the plain-language explanation and clean pretty-printing now work
  for the quadratic formula and a plain `x^2+1`.
- **Confirmed working, no code changes needed:**
  - The SRE mathspeak fix -- Description panel for the quadratic formula
    reads "StartFraction negative b plus or minus StartRoot b squared minus
    4 a c EndRoot Over 2 a EndFraction", no stray quotes or capitalization.
  - `\frac{1}{` correctly triggers the `#latex-error` "missing closing
    brace" message.
  - Portable SVG renders correctly for a simple equation (`x^2+1`): visible
    in the preview panel, `<title>x squared plus 1</title>` and `role="img"`
    present in the source, alt-text suggestion populated. Only lightly
    exercised though -- still worth the fuller pass listed below (fractions,
    roots, matrices, big operators, and the actual copy-paste-into-Word
    round-trip).
  - Braille (Nemeth) output renders (dot-pattern Unicode) for a simple
    equation.
  - The new shareable-link feature (see "Current feature set" above):
    clicking "Copy shareable link" does write to the OS clipboard, and a
    link opened fresh (`#eq=...&format=...`) correctly restores both the
    equation and format -- verified for the quadratic formula in
    Description format and a plain equation in MathJSON format.
- **CONFIRMED BROKEN (not fixed yet -- needs a redesign, not a patch): the
  MathML semantic ambiguity audit has never actually fired against real
  MathLive output.** Tested `(0,5)`, `f(x,y)`, and `|x|` in the MathML
  panel -- `#mathml-notes` was empty for all three. Two separate, structural
  reasons, both contradicting the assumptions `findAmbiguousNotation()` /
  `walk()` were built on:
  - **Point-or-interval detection can never match.** The code scans for a
    literal `(`, `,`, `)` sequence as *siblings* within one row's children.
    But MathLive always nests whatever's between the parens in its own
    `<mrow>` -- e.g. `(0,5)` renders as
    `<mrow><mo>(</mo><mrow><mn>0</mn><mo separator="true">,</mo><mn>5</mn></mrow><mo>)</mo></mrow>`.
    The `(` and `)` are two levels up from the `,` -- they're never siblings
    of it at any single level `walk()` visits, so the pattern can't match
    regardless of recursion. Same shape for `f(x,y)` (with an added
    invisible function-application `<mo>` before the group) -- meaning it
    also could never correctly *suppress* the false-positive case either,
    since it never fires at all.
  - **Absolute-value/set-builder detection can never match.** `VERTICAL_BAR_CHARS`
    is checked against `<mo>` elements only, but MathLive emits the `|` in
    `|x|` as `<mi>∣</mi>` (U+2223, tagged as an *identifier*, not an
    operator): `<mrow><mi>∣</mi><mo>&#8290;</mo><mi>x</mi><mo>&#8290;</mo><mi>∣</mi></mrow>`.
    The `tagName === 'mo'` check silently excludes it.
  - Net effect: this feature has shipped since it was built but has been a
    complete no-op the entire time -- not a false-positive/false-negative
    tuning problem, a "the note never appears for anything" problem. See
    the redesign note under "Open items for next session".

## Open items for next session

- **MathML semantic ambiguity audit needs a redesign, confirmed broken
  above.** To actually detect these shapes against MathLive's real output:
  point-or-interval needs to look at a `<mo>(</mo>` / `<mo>)</mo>` pair
  and inspect the *nested* `<mrow>` between them (not sibling-scan for the
  comma at the same level), and the vertical-bar check needs to also match
  `<mi>` elements (not just `<mo>`) for the bar characters. Re-test against
  `(0,5)`, `f(x,y)` (must *not* fire), `|x|`, and a set-builder expression
  once reworked, plus confirm `doc.querySelector('parsererror')` behavior
  (not directly exercised by any of the above three, since all three parsed
  successfully).
- **Portable SVG: broaden the real-browser pass beyond the one simple
  equation checked above** -- fractions, roots, matrices, Greek letters, big
  operators (`\sum`, `\int`), multi-line expressions, and the actual
  copy-paste round-trip into a Word doc / plain HTML page. Also still open:
  whether `startup.js` alone is sufficient or `loader.js` needs vendoring
  too (not distinguishable from today's pass since it happened to work),
  and whether the SVG `<title>` is actually picked up as the accessible
  name by Word/Canvas's own alt-text UI once pasted externally.
- **A recurring console error during today's QA pass looked environment-specific,
  not a MathVox bug -- worth a quick sanity check in a normal Chrome/Edge
  DevTools console to confirm.** Every page load logged an uncaught
  `SyntaxError: Illegal return statement` plus a `console.error` from
  MathLive's own `getFileUrl()` fallback ("Can't use relative paths to
  specify assets location..."). The stack trace showed the whole page
  running inside nested `eval()` calls (`eval at <anonymous> (:18:16)`),
  which points at the automated browser tool's own instrumentation rather
  than the page's real script-loading path -- `document.currentScript` is
  presumably unavailable under that instrumentation, forcing MathLive's
  `getFileUrl()` fallback (which parses `new Error().stack` to guess its own
  URL) down a path it wouldn't normally take in a real tab. The app was
  fully functional despite it (every format tested rendered correctly), so
  this most likely doesn't affect real users -- but it was never actually
  confirmed absent in an unmodified Chrome/Edge window.
- `speech-rule-engine` is pinned to a pre-release (`5.0.0-rc.3`) because that's npm's
  current `latest` tag — watch for a stable `5.0.0` and consider re-vendoring when it
  ships.
- No automated tests or CI exist yet. Today's pass was manual (one person driving
  a browser through a handful of hand-picked equations) -- worth turning at least
  the confirmed regressions above (the walk() bug, the MathJSON string bug) into
  actual regression tests per the "Automated regression tests for the pure-logic
  helpers" idea above, so they can't silently reappear.
