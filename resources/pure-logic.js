// Pure, DOM-free logic helpers shared between the app (resources/script.js)
// and the automated tests (tests/pure-logic.test.mjs). Kept in their own
// module specifically so they can be unit-tested directly in Node, without a
// browser or DOM -- the rest of script.js touches `document`/`window`/`mf`
// at module-load time, which makes it impossible to import safely outside a
// real page.
//
// Split out September 2026 after a real-browser QA pass found two silent
// bugs in this exact class of function (one in findMathJsonError's caller,
// where mf.getValue('math-json') turned out to return a JSON *string*
// rather than an already-parsed structure -- see the regression test for
// it) that months of Node-level testing in isolation had missed, precisely
// because nothing exercised these functions against real MathLive/DOM
// output. Automated tests here don't replace a real-browser pass, but they
// do make sure a fix like today's can't silently regress.

// Compute Engine can "succeed" (no thrown exception) while still embedding
// an ["Error", ["ErrorCode", ...]] node somewhere inside an otherwise-valid
// MathJSON tree -- e.g. QA found "\pm" inside a "\frac" produces exactly this
// (± isn't a single number, so dividing it hits an incompatible-type error),
// silently leaking a raw internal error blob into the output instead of a
// message a user could act on. Recursively search for that shape.
export function findMathJsonError(node) {
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
export function unquote(value) {
    return typeof value === 'string' ? value.replace(/^'|'$/g, '') : String(value);
}

export function describeMathJsonError(errorNode) {
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
export function escapeXmlText(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export const LATEX_ERROR_MESSAGES = {
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

export function describeLatexError(err) {
    return LATEX_ERROR_MESSAGES[err.code] || `has a problem MathLive calls "${err.code}"`;
}

// QA found that mf.errors misses common typos like an unclosed brace
// ("\frac{1}{") -- MathLive is lenient enough to silently treat it as valid
// (rendering a broken/incomplete result) rather than flagging it, while
// catching only more severely broken input. This counts braces directly on
// the raw text as a backstop, independent of MathLive's own leniency.
// Escaped braces ("\{" / "\}") are literal characters, not grouping
// delimiters, so they're stripped before counting.
export function findBraceImbalance(rawLatex) {
    const stripped = rawLatex.replace(/\\\{|\\\}/g, '');
    let depth = 0;
    for (const ch of stripped) {
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
    }
    return depth;
}

// --- MathML semantic ambiguity audit ------------------------------------
//
// Flags two known-ambiguous MathML shapes (see docs/MATHML_SEMANTIC_LINT_PLAN.md
// for the full design rationale on why only these two, and why auto-fixing
// isn't attempted): a bare parenthesized comma-group ("(a, b)" -- point?
// interval? gcd?) and a pair of vertical bars ("|x|" -- absolute value?
// set-builder? "divides"?).
//
// Redesigned September 2026 after a real-browser QA pass confirmed the
// original version never actually fired against real MathLive output (see
// docs/HISTORY.md, "Open items for next session"). Two structural bugs,
// both fixed here:
//
// 1. Point-or-interval never matched because MathLive wraps a
//    comma-separated group in its own single <mrow> -- e.g. "(0,5)" is
//    <mrow><mo>(</mo><mrow><mn>0</mn><mo separator="true">,</mo><mn>5</mn></mrow><mo>)</mo></mrow>.
//    The "(" and ")" ARE direct siblings (as the original code assumed),
//    but the comma between them is one level deeper, inside that inner
//    <mrow> -- so checking `between` itself for a literal comma node never
//    found it. Fixed by unwrapping exactly one level of pure grouping (see
//    unwrapGroup below) before checking for a top-level comma, while still
//    falling back to checking the nodes directly for the rarer case where
//    there's no such wrapping.
// 2. Absolute-value/set-builder never matched because MathLive emits the
//    "|" in "|x|" as <mi> (an identifier), not <mo> (an operator) --
//    confirmed real shape:
//    <mrow><mi>&#8739;</mi><mo>&#8290;</mo><mi>x</mi><mo>&#8290;</mo><mi>&#8739;</mi></mrow>
//    (the &#8290; in between is U+2062 INVISIBLE TIMES). The old check
//    only looked at <mo> elements. Fixed by also matching <mi>.
//
// Function-call suppression (e.g. "f(x,y)" must NOT flag as an interval)
// was already correctly designed in the original code -- it wasn't part of
// either bug -- so that part is unchanged: it looks for MathLive's invisible
// "function application" operator (U+2061) immediately preceding the "(",
// whether that's a sibling within the same row or (when the parenthesized
// group is its own wrapped <mrow>) the sibling preceding that wrapper in
// its parent row.

const FUNCTION_APPLICATION = '\u2061'; // MathLive's invisible "function application" operator


const AMBIGUITY_NOTES = {
    'point-or-interval': 'This expression contains "(a, b)" — a shape that could mean a point, an open interval, a greatest common divisor, or something else depending on context. Without an "intent" attribute (new in MathML 4) saying which one you mean, screen readers have to guess.',
    'absolute-value-or-set-builder': 'This expression contains a pair of vertical bars ("|...|") — commonly absolute value, but the same shape is also used for the number of elements in a set (cardinality) or the determinant of a matrix. Without an "intent" attribute saying which one you mean, screen readers have to guess.',
    'bracketed-interval': 'This expression contains interval notation with a square bracket (like "[a, b]" or "(a, b]"). MathVox marks it as an interval with an "intent" attribute automatically, so screen readers don\u2019t have to work it out \u2014 change it below if it means something else (for example a commutator).',
    'function-or-product': 'This expression has a letter right before parentheses (like "y(t)") — that can mean a function ("y of t") or multiplication ("y times t"). MathVox treats it as multiplication unless you choose otherwise below; screen readers follow whichever the MathML says.'
};

// Invisible operators MathLive inserts between tokens. U+2061 FUNCTION
// APPLICATION is FUNCTION_APPLICATION above; U+2062 INVISIBLE TIMES is what
// MathLive puts between "|" and "x" in "|x|" (see bug "2." above).
const INVISIBLE_TIMES = '⁢';
const INVISIBLE_CHARS = /[⁡-⁤]/g;

// MathML elements whose children are positional arguments (base,
// superscript, numerator, ...) rather than a free sequence. Wrapping a run
// of their children in a new <mrow> would change their arity and break
// the layout, so occurrences found directly inside one are reported (the
// note still shows) but not offered a meaning picker.
const FIXED_ARITY_ELEMENTS = new Set([
    'mfrac', 'msup', 'msub', 'msubsup', 'mroot', 'munder', 'mover',
    'munderover', 'mmultiscripts', 'mtable', 'mtr', 'mlabeledtr', 'semantics'
]);

function elementChildren(node) {
    return Array.from(node.childNodes).filter((n) => n.nodeType === 1);
}

function textOf(node) {
    return node.textContent || '';
}

function nameOf(node) {
    return node.localName || node.tagName;
}

// `between` is whatever sits directly between a matched "(" and ")" pair
// within one row. MathLive commonly wraps a comma-separated group in its
// own single <mrow> rather than putting the comma directly alongside the
// parens (see bug "1." above) -- unwrap exactly one level of pure grouping
// before checking for a top-level comma, falling back to checking the
// nodes directly (already flat, or a lone comma with no wrapping at all)
// if that doesn't apply. Also reports which element (if any) was unwrapped,
// since applyIntents() needs to know where the operands actually live.
function unwrapGroup(between) {
    if (between.length === 1 && elementChildren(between[0]).length > 0) {
        return { nodes: elementChildren(between[0]), container: between[0] };
    }
    return { nodes: between, container: null };
}

function isComma(node) {
    return nameOf(node) === 'mo' && textOf(node) === ',';
}

// Splits "a , b , c" into [[a], [b], [c]] at top-level commas.
function splitOnCommas(nodes) {
    const segments = [[]];
    for (const n of nodes) {
        if (isComma(n)) segments.push([]);
        else segments[segments.length - 1].push(n);
    }
    return segments;
}

function isInvisibleTimes(node) {
    return nameOf(node) === 'mo' && textOf(node) === INVISIBLE_TIMES;
}

function isInvisibleOp(node) {
    return nameOf(node) === 'mo' && /^[⁡-⁤]$/.test(textOf(node));
}

// --- Vertical-bar pairing -------------------------------------------------
//
// Single bars: "|" and U+2223 (the "divides" character MathLive uses for a
// typed "|" and for \vert). Double bars: U+2016 and U+2225 (the "parallel
// to" character MathLive uses for \|).
const SINGLE_BARS = new Set(['|', '∣']);
const DOUBLE_BARS = new Set(['‖', '∥']);
const CLOSING_FENCES = new Set([')', ']', '}', '⟩', '〉']);

function barFamily(node) {
    const n = nameOf(node);
    if (n !== 'mi' && n !== 'mo') return null;
    const t = textOf(node);
    if (SINGLE_BARS.has(t)) return 'single';
    if (DOUBLE_BARS.has(t)) return 'double';
    return null;
}

// Pairs up the bars in one row the way a reader would, adapted from the
// approach in MathCAT's canonicalize.rs (determine_vertical_bar_op): a bar
// closes the most recent open bar of the same kind when it follows
// something that can end an operand (a variable, number, group, closing
// fence, or another closing bar); otherwise it opens a new pair. So
// "|x| + |y|" is two pairs, "||x| - |y||" nests correctly, and "2|x|"
// (implied multiplication) opens after the 2. MathLive's invisible
// operators are skipped when deciding.
//
// Returns [[openIndex, closeIndex], ...] sorted by openIndex, or null if
// any bar is left unmatched (e.g. a lone "divides" bar) or any pair is
// empty -- callers leave such a row alone rather than guess.
export function pairBars(children) {
    const stack = [];
    const pairs = [];
    let prev = null;
    children.forEach((c, i) => {
        if (isInvisibleOp(c)) return;
        const family = barFamily(c);
        if (!family) {
            prev = { closesOperand: nameOf(c) !== 'mo' || CLOSING_FENCES.has(textOf(c)) };
            return;
        }
        const top = stack[stack.length - 1];
        if (prev && prev.closesOperand && top && top.family === family) {
            stack.pop();
            pairs.push([top.index, i]);
            prev = { closesOperand: true };
        } else {
            stack.push({ family, index: i });
            prev = { closesOperand: false };
        }
    });
    if (stack.length) return null;
    for (const [a, b] of pairs) {
        if (!children.slice(a + 1, b).some((n) => !isInvisibleOp(n))) return null;
    }
    return pairs.sort((x, y) => x[0] - y[0]);
}

// MathLive writes a typed "|x|" as
//   <mi>&#x2223;</mi><mo>&#x2062;</mo><mi>x</mi><mo>&#x2062;</mo><mi>&#x2223;</mi>
// -- the bars are the "divides" character tagged as variables, with
// invisible multiplication on both sides. Downstream readers take that
// literally (confirmed September 2026): Speech Rule Engine says
// "StartAbsoluteValue times x times EndAbsoluteValue" and writes Nemeth
// multiplication dots (⠈⠡) into the braille, and MathCAT (NVDA/JAWS) says
// "divides x divides". "\|v\|" has the same problem with U+2225 (braille
// comes out as "parallel to").
//
// This rewrites each such pair into the shape MathLive itself emits for
// \left|x\right| -- plain <mo>|</mo> (or <mo>‖</mo>) fences, no invisible
// operators just inside them, grouped in their own <mrow> -- which both
// engines read correctly ("StartAbsoluteValue x EndAbsoluteValue" / ⠳⠭⠳,
// and "the absolute value of x"). Edits the tree in place; returns the
// number of pairs rewritten.
//
// <mo>&#x2223;</mo> pairs (MathLive's \lvert ... \rvert) are only
// rewritten when they are the whole row, since the same <mo> is also
// "\mid" ("such that", "divides"), and two of those in one row must not
// be mistaken for a pair of fences.
export function normalizeFenceBars(root) {
    if (!root) return 0;
    let changed = 0;

    function visit(node) {
        elementChildren(node).forEach(visit);
        if (FIXED_ARITY_ELEMENTS.has(nameOf(node))) return;
        const children = elementChildren(node);
        const pairs = pairBars(children);
        if (!pairs || !pairs.length) return;

        const meaningful = children.filter((c) => !isInvisibleOp(c));
        const needsFix = (open, close) => {
            if (nameOf(open) === 'mi' || nameOf(close) === 'mi') return true;
            if (['∣', '∥'].includes(textOf(open)) || ['∣', '∥'].includes(textOf(close))) {
                return meaningful[0] === open && meaningful[meaningful.length - 1] === close;
            }
            return false;
        };
        const todo = pairs
            .map(([a, b]) => ({ open: children[a], close: children[b], span: b - a }))
            .filter((p) => needsFix(p.open, p.close))
            .sort((x, y) => x.span - y.span); // innermost first

        const doc = node.ownerDocument;
        const ns = node.namespaceURI || null;
        for (const { open, close } of todo) {
            const ch = barFamily(open) === 'double' ? '‖' : '|';
            const newOpen = doc.createElementNS(ns, 'mo');
            newOpen.appendChild(doc.createTextNode(ch));
            const newClose = doc.createElementNS(ns, 'mo');
            newClose.appendChild(doc.createTextNode(ch));
            node.replaceChild(newOpen, open);
            node.replaceChild(newClose, close);

            const between = [];
            for (let n = newOpen.nextSibling; n && n !== newClose; n = n.nextSibling) {
                if (n.nodeType === 1) between.push(n);
            }
            while (between.length && isInvisibleOp(between[0])) node.removeChild(between.shift());
            while (between.length && isInvisibleOp(between[between.length - 1])) node.removeChild(between.pop());

            let content = between[0];
            if (between.length > 1) {
                content = doc.createElementNS(ns, 'mrow');
                node.insertBefore(content, between[0]);
                for (const el of between) content.appendChild(el);
            }
            const rowIsJustThisPair = nameOf(node) === 'mrow' && elementChildren(node).length === 3;
            if (!rowIsJustThisPair) {
                const group = doc.createElementNS(ns, 'mrow');
                node.insertBefore(group, newOpen);
                group.appendChild(newOpen);
                group.appendChild(content);
                group.appendChild(newClose);
            }
            changed++;
        }
    }

    visit(root);
    return changed;
}

// --- Other MathLive MathML cleanups --------------------------------------
//
// Found September 2026 by running real MathLive output through both Speech
// Rule Engine and MathCAT (see tests/braille-report.mjs and docs/HISTORY.md, "Ideas borrowed from MathCAT").
// Each one fixes MathML that MathLive gets wrong, not a reading preference.

const PRIMES = /^[′″‴⁗]+$/;
// Angles and shapes that name a figure by the letters after them (∠ABC,
// □ABCD, △ABC): grouped with those letters, see groupAngleName.
const ANGLE_SYMBOLS = new Set(['∠', '∡', '∢', '□', '△', '▱', '▭']);
// ∂ and ∇ too: as <mi> with invisible times after them, SRE says
// "partial differential times f" / "nabla times f".
// ∀/∃ likewise ("there exists times x").
const PREFIX_SYMBOLS = new Set([...ANGLE_SYMBOLS, '∂', '∇', '∀', '∃', '∄']);
// Operators MathLive tags as identifiers in some contexts (x^{2/3} -> <mi>/</mi>,
// read "2 times slash 3"); made <mo> with the invisible times on both sides dropped.
const INFIX_SYMBOLS = new Set(['/']);
const POSTFIX_SYMBOLS = new Set(['%', '‰', '‱']); // percent, per mille, per ten thousand

function makeMo(doc, ns, text) {
    const mo = doc.createElementNS(ns, 'mo');
    mo.appendChild(doc.createTextNode(text));
    return mo;
}

// "f'(x)": MathLive emits <msup><mi>f</mi><mo>&#x2061;</mo><mi>′</mi></msup>
// -- three children in a two-child element, with the function-application
// operator stuck inside. SRE then drops the prime entirely (braille
// "⠋⠘⠀⠐⠷⠭⠾", speech "f Superscript of Baseline ..."). Move the invisible
// operator out after the script element, where it belongs. The same
// stray operator shows up after a script's letter in \overset{f}{\to}
// (<mover><mo>→</mo><mi>f</mi><mo>&#x2061;</mo></mover>); there it's
// just dropped.
const SCRIPT_ARITY = { msup: 2, msub: 2, mover: 2, munder: 2, msubsup: 3, munderover: 3 };

function fixScriptArity(node) {
    const arity = SCRIPT_ARITY[nameOf(node)];
    if (!arity) return 0;
    const kids = elementChildren(node);
    if (kids.length <= arity) return 0;
    const invisible = kids.filter(isInvisibleOp);
    if (kids.length - invisible.length !== arity) return 0;
    const parent = node.parentNode;
    for (const op of invisible) {
        node.removeChild(op);
        // Right after the base, a function-application operator applies
        // to the whole scripted name ("f'" in "f'(x)"): keep it, outside.
        if (op === kids[1] && textOf(op) === FUNCTION_APPLICATION && parent) {
            parent.insertBefore(op, node.nextSibling);
        }
    }
    return 1;
}

// "x'^2": MathLive puts the prime inside the superscript --
// <msup><mi>x</mi><mrow><mi>′</mi><mn>2</mn></mrow></msup> -- which SRE
// reads as "x Superscript prime 2" (braille ⠭⠘⠄⠼⠆). Nest it as
// (x′)² instead: "x prime squared", ⠭⠄⠘⠆ -- what MathCAT produces too.
function fixPrimeInSuperscript(node) {
    if (nameOf(node) !== 'msup') return 0;
    const [base, script] = elementChildren(node);
    if (!base || !script || nameOf(script) !== 'mrow') return 0;
    const parts = elementChildren(script);
    if (parts.length < 2 || !PRIMES.test(textOf(parts[0])) || elementChildren(parts[0]).length) return 0;
    const doc = node.ownerDocument;
    const ns = node.namespaceURI || null;
    const inner = doc.createElementNS(ns, 'msup');
    node.insertBefore(inner, base);
    inner.appendChild(base);
    inner.appendChild(makeMo(doc, ns, PRIME_RUNS[textOf(parts[0])] || textOf(parts[0])));
    script.removeChild(parts[0]);
    const rest = elementChildren(script);
    if (rest.length === 1) node.replaceChild(rest[0], script);
    return 1;
}

// "50%" and "∠ABC": MathLive tags % and ∠ as variables and puts invisible
// multiplication next to them, so SRE says "50 times percent" / "angle
// times A B C" and writes a Nemeth multiplication dot (⠈⠡). Make them
// operators and drop the invisible times on the side they attach to.
function fixAttachedSymbols(node) {
    const doc = node.ownerDocument;
    const ns = node.namespaceURI || null;
    let changed = 0;
    for (const child of elementChildren(node)) {
        if (nameOf(child) !== 'mi') continue;
        const t = textOf(child);
        const prefix = PREFIX_SYMBOLS.has(t);
        const postfix = POSTFIX_SYMBOLS.has(t);
        const infix = INFIX_SYMBOLS.has(t);
        if (!prefix && !postfix && !infix) continue;
        const mo = makeMo(doc, ns, t);
        node.replaceChild(mo, child);
        const dirs = infix ? ['nextSibling', 'previousSibling'] : [prefix ? 'nextSibling' : 'previousSibling'];
        for (const dir of dirs) {
            let sib = mo[dir];
            while (sib && sib.nodeType !== 1) sib = sib[dir];
            if (sib && isInvisibleTimes(sib)) node.removeChild(sib);
        }
        if (ANGLE_SYMBOLS.has(t)) groupAngleName(node, mo);
        changed++;
    }
    return changed;
}

// "m∠ABC" (measure of angle ABC): with ∠ and the letters loose in the row,
// SRE reads the invisible times between "m" and "∠" as "m times angle"
// and brailles a multiplication dot. Grouping ∠ with the point letters
// that follow -- <mrow><mo>∠</mo>A B C</mrow> -- gives "m angle A B C" in
// SRE (⠍⠫⠪⠀⠠⠁⠠⠃⠠⠉, same as MathCAT) and changes nothing for a bare "∠ABC".
function groupAngleName(row, angleMo) {
    if (nameOf(row) !== 'mrow' && nameOf(row) !== 'math' && nameOf(row) !== 'root') return;
    const parts = [angleMo];
    let n = angleMo.nextSibling;
    while (n) {
        if (n.nodeType !== 1) { n = n.nextSibling; continue; }
        // point letters (∠ABC), a number (∠1) or a Greek letter (∠θ)
        const isLetter = (nameOf(n) === 'mi' && /^([A-Za-z]|[\u0391-\u03C9])$/.test(textOf(n))) || nameOf(n) === 'mn';
        if (!isLetter && !isInvisibleTimes(n)) break;
        parts.push(n);
        n = n.nextSibling;
    }
    while (parts.length > 1 && isInvisibleTimes(parts[parts.length - 1])) parts.pop();
    if (parts.length < 2) return;
    const kids = elementChildren(row);
    if (nameOf(row) === 'mrow' && kids.length === parts.length) return; // already its own group
    const doc = row.ownerDocument;
    const group = doc.createElementNS(row.namespaceURI || null, 'mrow');
    row.insertBefore(group, angleMo);
    for (const p of parts) group.appendChild(p);
}

// "90^\circ": MathLive writes the degree as <mo>∘</mo> (U+2218 RING
// OPERATOR, i.e. function composition). SRE reads it "90 Superscript
// ring"; with the real degree sign U+00B0 it says "90 degree" (MathCAT
// says "degrees" either way). Only when ∘ is the entire superscript.
function fixDegreeSign(node) {
    if (nameOf(node) !== 'msup') return 0;
    const script = elementChildren(node)[1];
    if (!script || nameOf(script) !== 'mo' || textOf(script) !== '∘') return 0;
    script.textContent = '°';
    return 1;
}

// A function-application operator (U+2061) with nothing to apply to:
// MathLive leaves one after "f" in "\partial f", "\nabla f" and
// "\frac{\partial f}{\partial x}" -- MathCAT then says "f of", as if a
// "(x)" were coming. Dropped when it ends its row or is followed by an
// ordinary operator rather than an argument.
function dropDanglingFunctionApplication(node) {
    let changed = 0;
    for (const child of elementChildren(node)) {
        if (nameOf(child) !== 'mo' || textOf(child) !== FUNCTION_APPLICATION) continue;
        let next = child.nextSibling;
        while (next && next.nodeType !== 1) next = next.nextSibling;
        const isArgument = next && !(nameOf(next) === 'mo' && !['(', '[', '{', '|', '‖', '⟨'].includes(textOf(next)));
        if (!isArgument) {
            node.removeChild(child);
            changed++;
        }
    }
    return changed;
}

// Set-builder "{x | x > 0}": MathLive writes the separator as
// <mo>∣</mo> (\mid) or, when typed, <mi>∣</mi> with invisible times. MathCAT
// reads both as "divides" ("open brace, x divides x is greater than 0");
// with a plain <mo>|</mo> it reads "the set of all x such that x is greater
// than 0" and brailles the Nemeth "such that" bar with spaces.
//
// Runs before normalizeFenceBars: in "{x \mid |x| < 1}" the separator and
// the absolute-value bars are all loose in one row, so the bar pairing
// alone can't tell them apart. When there's more than one bar, the
// separator is the one whose removal leaves the rest pairable (a \mid
// <mo> is tried first), and each side of it gets its own <mrow> so the
// |x| pair can then be grouped normally.
// --- HTML entities in MathLive's MathML ------------------------------------
//
// MathLive's exporter writes a few HTML named entities -- "&ne;" for \ne /
// \neq, "&nbsp;" for "\ " -- which aren't defined in XML. Parsing then
// fails, so (before this fix) every cleanup and the intent picker were
// silently skipped for any equation containing ≠ or a "\ " space, and the
// MathML format exported "&ne;" as-is (fine in HTML, an error in XHTML or
// any XML tool). This swaps them for the characters themselves. The table
// is every named entity found in the vendored mathlive.js (September 2026).
const HTML_ENTITIES = {
    ne: '≠', nbsp: ' ', infin: '∞', times: '×', divide: '÷', InvisibleTimes: '⁢',
    alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', zeta: 'ζ', eta: 'η', theta: 'θ', iota: 'ι',
    kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', omicron: 'ο', pi: 'π', rho: 'ρ',
    sigma: 'σ', tau: 'τ', upsilon: 'υ', chi: 'χ', psi: 'ψ', omega: 'ω'
};

export function normalizeHtmlEntities(mathml) {
    return (mathml || '').replace(/&([A-Za-z][A-Za-z0-9]*);/g, (m, name) =>
        Object.prototype.hasOwnProperty.call(HTML_ENTITIES, name) ? HTML_ENTITIES[name] : m);
}

const TOKEN_ELEMENTS = new Set(['mi', 'mn', 'mo', 'mtext', 'ms', 'annotation']);

// "\ " comes out as a bare no-break-space text node between elements
// (<mrow>…,&nbsp;<msup>…), which isn't valid MathML. Make it an <mspace>.
function fixLooseSpaces(node) {
    if (TOKEN_ELEMENTS.has(nameOf(node))) return 0;
    let changed = 0;
    for (const t of Array.from(node.childNodes)) {
        if (t.nodeType !== 3 || !t.data.includes(' ') || t.data.replace(/[\s ]/g, '') !== '') continue;
        const sp = node.ownerDocument.createElementNS(node.namespaceURI || null, 'mspace');
        sp.setAttribute('width', '0.25em');
        node.replaceChild(sp, t);
        changed++;
    }
    return changed;
}

// h(x), F(x), P(A), E[X]: MathLive treats only f and g as function names --
// every other letter before parentheses gets invisible *multiplication*,
// so MathCAT reads "cap p times, open paren, cap a ..." and SRE's braille
// can carry a multiplication dot. These letters are almost always
// functions in the courses MathVox serves (h(x); F(b) - F(a) for an
// antiderivative; P(A) for probability; E[X] for expected value), so
// switch them to function application. Other letters (a(b+c), x(x+1),
// y(t)) stay multiplication -- that's genuinely ambiguous and is left to
// the author. P gets one guard: "P(1 + rt)" (principal times ...) has a
// top-level + or - and stays multiplication. Also treated as functions:
// multi-letter names (\operatorname{tr}(A), \mathrm{rank}(A)), styled
// letters (\mathcal{P}(S)), a letter right after "~" (X ~ N(0,1)),
// composition ((f∘g)(x)) and d/dx applied to what follows.
const FUNCTION_LETTERS = new Set(['h', 'F', 'G', 'H', 'P', 'E']);

function isParenGroup(n) {
    const first = n && nameOf(n) === 'mrow' ? elementChildren(n)[0] : n;
    return Boolean(first && nameOf(first) === 'mo' && ['(', '['].includes(textOf(first)));
}

// Top-level + or − inside a parenthesized group: "P(1 + rt)" (principal
// times ...) is multiplication; "P(A ∩ B)", "P(X = k)" are probabilities.
function hasTopLevelPlusMinus(group) {
    const inner = elementChildren(group).slice(1, -1);
    const items = inner.length === 1 && nameOf(inner[0]) === 'mrow' ? elementChildren(inner[0]) : inner;
    return items.some((n) => nameOf(n) === 'mo' && ['+', '−', '-', '±'].includes(textOf(n)));
}

function isDerivativeOperator(n) {
    // d/dx, d^2/dx^2, ∂/∂x as an operator fraction
    if (!n || nameOf(n) !== 'mfrac') return false;
    const [num, den] = elementChildren(n);
    const lead = (x) => (nameOf(x) === 'msup' ? elementChildren(x)[0] : x);
    const firstOf = (x) => (nameOf(x) === 'mrow' ? elementChildren(x)[0] : x);
    const isD = (x) => x && ['d', '∂'].includes(textOf(lead(x)).trim()) && !elementChildren(lead(x)).length;
    return isD(num) && isD(firstOf(den));
}

// Is `name` (followed by a parenthesized group) a function rather than a
// factor? See the comment above FUNCTION_LETTERS.
function looksLikeFunctionName(name, group, prev) {
    const t = textOf(name);
    if (nameOf(name) === 'mi') {
        if (FUNCTION_LETTERS.has(t)) return t !== 'P' || !hasTopLevelPlusMinus(group);
        // multi-letter operator names: \operatorname{tr}(A), \mathrm{rank}(A), \mathrm{Re}(z)
        if (/^[A-Za-z]{2,}$/.test(t)) return true;
        // styled letters: \mathcal{P}(S) (power set), \mathscr{L}\{f\} etc.
        if (/^[\u{1D400}-\u{1D7FF}ℂ-⅏]$/u.test(t)) return true;
        // a distribution after "~": X ~ N(0, 1), X ~ B(n, p)
        if (/^[A-Za-z]$/.test(t) && prev && nameOf(prev) === 'mo' && ['∼', '~'].includes(textOf(prev))) return true;
        return false;
    }
    // (f ∘ g)(x)
    if (nameOf(name) === 'mrow' && isParenGroup(name)) {
        return elementChildren(name).some((c) => (nameOf(c) === 'mrow' ? elementChildren(c) : [c]).some((x) => nameOf(x) === 'mo' && textOf(x) === '∘'));
    }
    return false;
}

function fixFunctionLetters(node) {
    const kids = elementChildren(node);
    let changed = 0;
    for (let i = 0; i < kids.length - 1; i++) {
        const name = kids[i];
        const op = kids[i + 1];
        // d/dx followed directly by what it applies to (\frac{d}{dx}\sin x,
        // \frac{d}{dx}[f(x)]): MathCAT otherwise reads "times"
        if (isDerivativeOperator(name)) {
            if (isInvisibleTimes(op)) {
                op.textContent = FUNCTION_APPLICATION;
                changed++;
            } else if (!(nameOf(op) === 'mo' && !/[A-Za-z]/.test(textOf(op)) && !['(', '['].includes(textOf(op))) && !isInvisibleOp(op)) {
                node.insertBefore(makeMo(node.ownerDocument, node.namespaceURI || null, FUNCTION_APPLICATION), op);
                changed++;
            }
            continue;
        }
        const arg = kids[i + 2];
        if (!arg || !isInvisibleTimes(op) || !isParenGroup(arg)) continue;
        if (!looksLikeFunctionName(name, arg, kids[i - 1])) continue;
        op.textContent = FUNCTION_APPLICATION;
        changed++;
    }
    return changed;
}

// "z^*", "t^*": MathLive uses U+2217 ASTERISK OPERATOR, which MathCAT reads
// as "z superscript times". The plain asterisk reads "z star" (MathCAT) /
// "z Superscript asterisk" (SRE), with the same braille.
function fixSuperscriptStar(node) {
    if (nameOf(node) !== 'msup') return 0;
    const s = elementChildren(node)[1];
    if (!s || nameOf(s) !== 'mo' || textOf(s) !== '∗') return 0;
    s.textContent = '*';
    return 1;
}

// "{}_nC_r", "_{n}P_{r}": with an empty base, MathLive exports the
// pre-subscript as a one-child <msub> (invalid -- MathCAT errors out and
// the conversion warning fires). Rebuild it as the MathML for
// prescripts, <mmultiscripts>, which MathCAT reads as "n choose r" /
// "r permutations of n". Same for a lone pre-superscript ({}^{14}C).
function fixEmptyBaseScripts(node) {
    const kids = elementChildren(node);
    let changed = 0;
    for (let i = 0; i < kids.length - 1; i++) {
        const pre = kids[i];
        const kind = nameOf(pre);
        if ((kind !== 'msub' && kind !== 'msup') || elementChildren(pre).length !== 1) continue;
        const next = kids[i + 1];
        const doc = node.ownerDocument;
        const ns = node.namespaceURI || null;
        const none = () => doc.createElementNS(ns, 'none');
        const multi = doc.createElementNS(ns, 'mmultiscripts');
        let base = next;
        let postSub = none();
        let postSup = none();
        if ((nameOf(next) === 'msub' || nameOf(next) === 'msup') && elementChildren(next).length === 2) {
            const [b, s] = elementChildren(next);
            base = b;
            if (nameOf(next) === 'msub') postSub = s; else postSup = s;
        } else if (!['mi', 'mn', 'mrow'].includes(nameOf(next))) {
            continue;
        }
        const preScript = elementChildren(pre)[0];
        node.insertBefore(multi, pre);
        multi.appendChild(base);
        multi.appendChild(postSub);
        multi.appendChild(postSup);
        multi.appendChild(doc.createElementNS(ns, 'mprescripts'));
        if (kind === 'msub') { multi.appendChild(preScript); multi.appendChild(none()); }
        else { multi.appendChild(none()); multi.appendChild(preScript); }
        node.removeChild(pre);
        if (next.parentNode === node) node.removeChild(next);
        changed++;
        i++;
    }
    return changed;
}

// "f''(x)": MathLive writes the superscript as <mi>′′</mi> -- two prime
// characters as one identifier. SRE says "f Superscript prime prime
// Baseline"; MathCAT reads the raw characters ("f ′′, of x"). The single
// double-prime character as an operator gives "f double prime" in both.
const PRIME_RUNS = { '′′': '″', '′′′': '‴', '′′′′': '⁗' };

function fixPrimeRuns(node) {
    if (nameOf(node) !== 'mi' && nameOf(node) !== 'mo') return 0;
    const t = textOf(node);
    if (!PRIME_RUNS[t]) return 0;
    const mo = makeMo(node.ownerDocument, node.namespaceURI || null, PRIME_RUNS[t]);
    node.parentNode.replaceChild(mo, node);
    return 1;
}

function isSingleBar(n) {
    return (nameOf(n) === 'mo' || nameOf(n) === 'mi') && (textOf(n) === '∣' || textOf(n) === '|');
}

function fixSetBuilderBar(node) {
    const kids = elementChildren(node);
    if (kids.length < 3 || nameOf(kids[0]) !== 'mo' || nameOf(kids[kids.length - 1]) !== 'mo') return 0;
    const open = textOf(kids[0]);
    const close = textOf(kids[kids.length - 1]);
    // {x | x > 0} (set-builder, "such that") and P(A | B) (conditional
    // probability, "given") -- MathCAT reads a plain <mo>|</mo> as either,
    // from the brackets around it.
    if (!((open === '{' && close === '}') || (open === '(' && close === ')'))) return 0;
    // MathLive keeps {…} contents flat but wraps (…) contents in one <mrow>.
    let content = node;
    let inner = kids.slice(1, -1);
    if (inner.length === 1 && nameOf(inner[0]) === 'mrow') {
        content = inner[0];
        inner = elementChildren(content);
    }
    if (inner.length < 3) return 0;
    const bars = inner.filter(isSingleBar);
    if (!bars.length || bars.length % 2 === 0) return 0;

    let sep = null;
    if (bars.length === 1) {
        sep = bars[0];
    } else {
        const candidates = [...bars.filter((b) => nameOf(b) === 'mo'), ...bars.filter((b) => nameOf(b) !== 'mo')];
        sep = candidates.find((b) => {
            const i = inner.indexOf(b);
            return pairBars(inner.slice(0, i)) !== null && pairBars(inner.slice(i + 1)) !== null;
        }) || null;
    }
    if (!sep) return 0;
    const si = inner.indexOf(sep);
    const meaningful = (list) => list.some((n) => !isInvisibleOp(n));
    if (!meaningful(inner.slice(0, si)) || !meaningful(inner.slice(si + 1))) return 0;
    const sideCount = (list) => list.filter((n) => !isInvisibleOp(n)).length;
    if (nameOf(sep) === 'mo' && textOf(sep) === '|' && bars.length === 1 &&
        sideCount(inner.slice(0, si)) <= 1 && sideCount(inner.slice(si + 1)) <= 1) return 0; // already right

    const doc = node.ownerDocument;
    const ns = node.namespaceURI || null;
    const mo = makeMo(doc, ns, '|');
    content.replaceChild(mo, sep);
    for (const dir of ['previousSibling', 'nextSibling']) {
        let s = mo[dir];
        while (s && s.nodeType !== 1) s = s[dir];
        if (s && isInvisibleOp(s)) content.removeChild(s);
    }
    {
        // Group each side: normalizeFenceBars then sees |x| on its own, and
        // MathCAT needs the condition as one unit when it contains a comma
        // ("{x | x ∈ ℤ, x > 0}" otherwise reads "x divides ...").
        const stop = new Set(content === node ? [kids[0], kids[kids.length - 1]] : []);
        for (const side of ['left', 'right']) {
            const parts = [];
            let n = side === 'left' ? mo.previousSibling : mo.nextSibling;
            while (n && !stop.has(n)) {
                if (n.nodeType === 1) parts.push(n);
                n = side === 'left' ? n.previousSibling : n.nextSibling;
            }
            if (parts.length < 2) continue;
            if (side === 'left') parts.reverse();
            const g = doc.createElementNS(ns, 'mrow');
            content.insertBefore(g, parts[0]);
            for (const p of parts) g.appendChild(p);
        }
    }
    return 1;
}

function isFence(node) {
    return nameOf(node) === 'mo' && ['(', ')', '[', ']', '{', '}'].includes(textOf(node));
}

// "1,000,000": MathLive splits it into <mn>1</mn><mo>,</mo><mn>000</mn>...,
// which SRE reads (and brailles) as a list: "1 comma 000 comma 000". Merge
// comma-separated digit groups back into one <mn> when they look like
// thousands grouping -- 1 to 3 leading digits, then groups of exactly 3 --
// the same heuristic idea as MathCAT's merge_number_blocks (US-style
// commas only). Skipped when the run is the whole content of a bracketed
// group, since "(1,000)" or "{1,000}" can just as well be two numbers.
function mergeDigitGroups(node) {
    const kids = elementChildren(node);
    const parent = node.parentNode;
    if (parent && parent.nodeType === 1) {
        const pk = elementChildren(parent);
        if (pk.length === 3 && pk[1] === node && isFence(pk[0]) && isFence(pk[2])) return 0;
    }
    const isMn = (n, re) => n && nameOf(n) === 'mn' && re.test(textOf(n));
    let changed = 0;
    for (let i = 0; i < kids.length; i++) {
        if (!isMn(kids[i], /^\d{1,3}$/)) continue;
        let j = i;
        while (kids[j + 1] && isComma(kids[j + 1]) && isMn(kids[j + 2], /^\d{3}(\.\d+)?$/)) j += 2;
        if (j === i) continue;
        // don't swallow the start of a longer list like "1,000,00"
        if (kids[j + 1] && isComma(kids[j + 1]) && kids[j + 2] && nameOf(kids[j + 2]) === 'mn') continue;
        const text = kids.slice(i, j + 1).map(textOf).join('');
        const doc = node.ownerDocument;
        const mn = doc.createElementNS(node.namespaceURI || null, 'mn');
        mn.appendChild(doc.createTextNode(text));
        node.insertBefore(mn, kids[i]);
        for (const k of kids.slice(i, j + 1)) node.removeChild(k);
        changed++;
        i = j;
    }
    return changed;
}

// --- Working around MathLive's MathML exporter -----------------------------
//
// MathLive renders these commands correctly in the math field, but its
// MathML export drops or garbles them (confirmed September 2026 against the
// vendored 0.105.3): \overline{AB} and \underline come out EMPTY (so
// "\overline{x}+1" exports as just "+1"); \overrightarrow{AB} and friends,
// \overbrace/\underbrace lose their base ("<mover >→</mover>"); \widehat,
// \widetilde, \overarc give "<mo>undefined</mo>"; \mathring gives
// "<mo>730</mo>"; "\not=" and most "\not..." come out empty; \stackrel
// makes a two-child <munderover>.
//
// rewriteLatexForExport() rewrites just those commands into ones MathLive
// does export -- \overset / \underset with a \text{} placeholder as the
// accent, e.g. \overline{AB} -> \overset{\text{mathvoxph0}}{AB} -- and
// returns the list of placeholders. After MathLive.convertLatexToMathMl()
// on the rewritten LaTeX, replaceExportPlaceholders() swaps each
// placeholder <mtext> for the right <mo> (the same characters and
// attributes MathJax uses for these commands). The math field itself is
// never touched.

export const EXPORT_PLACEHOLDER = 'mathvoxph';

// pos: 'over' | 'under'; accent: whether it's a tight accent (sets
// accent / accentunder); label: 'sup' / 'sub' when the command takes a
// label as a script (\overbrace{..}^{label}, \underbrace{..}_{label}).
const EXPORT_ACCENTS = {
    overline: { pos: 'over', ch: '¯', accent: true },
    underline: { pos: 'under', ch: '‾', accent: true },
    overlinesegment: { pos: 'over', ch: '¯', accent: true },
    underlinesegment: { pos: 'under', ch: '‾', accent: true },
    overrightarrow: { pos: 'over', ch: '→' },
    overleftarrow: { pos: 'over', ch: '←' },
    overleftrightarrow: { pos: 'over', ch: '↔' },
    underrightarrow: { pos: 'under', ch: '→' },
    underleftarrow: { pos: 'under', ch: '←' },
    underleftrightarrow: { pos: 'under', ch: '↔' },
    overrightharpoon: { pos: 'over', ch: '⇀' },
    overleftrightharpoon: { pos: 'over', ch: '⥊' },
    overleftharpoon: { pos: 'over', ch: '↼' },
    overbrace: { pos: 'over', ch: '⏞', label: 'sup' },
    underbrace: { pos: 'under', ch: '⏟', label: 'sub' },
    overbracket: { pos: 'over', ch: '⎴', label: 'sup' },
    underbracket: { pos: 'under', ch: '⎵', label: 'sub' },
    overparen: { pos: 'over', ch: '⌢' }, // an arc, as MathCAT reads it
    underparen: { pos: 'under', ch: '⌣' },
    overgroup: { pos: 'over', ch: '⏠' },
    undergroup: { pos: 'under', ch: '⏡' },
    widehat: { pos: 'over', ch: '^', accent: true },
    widetilde: { pos: 'over', ch: '~', accent: true },
    utilde: { pos: 'under', ch: '~', accent: true },
    overarc: { pos: 'over', ch: '⌢' },
    wideparen: { pos: 'over', ch: '⌢' },
    mathring: { pos: 'over', ch: '˚', accent: true }
};

// "\not X" -> the negated relation. MathLive exports only a few of the
// \n... commands, and no "\not ..." at all, so these become placeholders too.
const NEGATED = {
    '=': '≠', '<': '≮', '>': '≯',
    in: '∉', ni: '∌', le: '≰', leq: '≰', ge: '≱', geq: '≱',
    subset: '⊄', supset: '⊅', subseteq: '⊈', supseteq: '⊉',
    sim: '≁', simeq: '≄', cong: '≇', approx: '≉', equiv: '≢',
    parallel: '∦', mid: '∤', exists: '∄'
};
// Negated-relation commands MathLive's exporter drops outright.
const NEGATED_COMMANDS = { napprox: '≉', nequiv: '≢' };

// Other commands MathLive's exporter drops (checked September 2026):
// operator names that vanish, and \\x...arrow (base arrow lost).
const DROPPED_OPERATORS = {
    bmod: 'mod', mod: 'mod',
    limsup: 'lim sup', liminf: 'lim inf', varlimsup: 'lim sup', varliminf: 'lim inf'
};
const EXTENSIBLE_ARROWS = {
    xrightarrow: '→', xleftarrow: '←', xleftrightarrow: '↔',
    xRightarrow: '⇒', xLeftarrow: '⇐', xLeftrightarrow: '⇔', xmapsto: '↦'
};
// Plain renames: same meaning, a command MathLive does export. \\mathcal
// otherwise exports as a plain letter (the script style is lost), so use
// \\mathscr's script letters (U+1D49C...) -- read as "script A".
// \boldsymbol / \bm / \pmb export with the bold dropped (\boldsymbol{\beta}
// -> plain β); \mathbf keeps it (mathvariant="bold", read "bold beta").
const RENAMES = { iff: 'Longleftrightarrow', stackrel: 'overset', mathcal: 'mathscr', boldsymbol: 'mathbf', bm: 'mathbf', pmb: 'mathbf' };
// Reads one LaTeX argument starting at i (after optional spaces): a {...}
// group (balanced, honouring \{ and \}), a \command, or one character.
// Returns { text, end } with text excluding the outer braces, or null.
function readLatexArgument(src, i) {
    while (i < src.length && /\s/.test(src[i])) i++;
    if (i >= src.length) return null;
    if (src[i] === '{') {
        let depth = 0;
        for (let j = i; j < src.length; j++) {
            if (src[j] === '\\') { j++; continue; }
            if (src[j] === '{') depth++;
            else if (src[j] === '}' && --depth === 0) return { text: src.slice(i + 1, j), end: j + 1 };
        }
        return null; // unbalanced -- leave it to MathLive
    }
    if (src[i] === '\\') {
        const m = /^\\([a-zA-Z]+|.)/.exec(src.slice(i));
        return m ? { text: m[0], end: i + m[0].length } : null;
    }
    return { text: src[i], end: i + 1 };
}

// Reads an optional [...] argument (as in \xrightarrow[below]{above}).
function readOptionalArgument(src, i) {
    let j = i;
    while (j < src.length && /\s/.test(src[j])) j++;
    if (src[j] !== '[') return null;
    let depth = 0;
    for (let k = j; k < src.length; k++) {
        if (src[k] === '\\') { k++; continue; }
        if (src[k] === '{') depth++;
        else if (src[k] === '}') depth--;
        else if (src[k] === ']' && depth === 0) return { text: src.slice(j + 1, k), end: k + 1 };
    }
    return null;
}

export function rewriteLatexForExport(latex) {
    const placeholders = [];
    // Returns \text{id} (MathLive exports it as <mtext>), or the bare id
    // for use inside \operatorname{} (exported as <mi>).
    const add = (spec, bare = false) => {
        const id = `${EXPORT_PLACEHOLDER}${placeholders.length}`;
        placeholders.push({ id, ...spec });
        return bare ? id : `\\text{${id}}`;
    };

    function rewrite(src) {
        let out = '';
        let i = 0;
        while (i < src.length) {
            if (src[i] !== '\\') { out += src[i++]; continue; }
            const m = /^\\([a-zA-Z]+)/.exec(src.slice(i));
            if (!m) { out += src.slice(i, i + 2); i += 2; continue; }
            const name = m[1];
            const after = i + m[0].length;

            if (EXPORT_ACCENTS[name]) {
                const arg = readLatexArgument(src, after);
                if (arg) {
                    const spec = EXPORT_ACCENTS[name];
                    const ph = add({ command: name, ...spec });
                    out += `\\${spec.pos}set{${ph}}{${rewrite(arg.text)}}`;
                    i = arg.end;
                    continue;
                }
            } else if (name === 'not') {
                const arg = readLatexArgument(src, after);
                const key = arg && (arg.text.startsWith('\\') ? arg.text.slice(1) : arg.text);
                if (arg && NEGATED[key]) {
                    // Bare \text{}: MathLive's exporter drops anything inside
                    // \mathrel{...} (checked), so the placeholder can't go there.
                    out += add({ command: `not ${arg.text}`, relation: NEGATED[key] });
                    i = arg.end;
                    continue;
                }
            } else if (NEGATED_COMMANDS[name]) {
                out += add({ command: name, relation: NEGATED_COMMANDS[name] });
                i = after;
                continue;
            } else if (DROPPED_OPERATORS[name] && name !== 'mod') {
                // \operatorname keeps sub/superscripts attached (\limsup_{n}).
                out += `\\operatorname{${add({ command: name, relation: DROPPED_OPERATORS[name], operator: true }, true)}}`;
                i = after;
                continue;
            } else if (name === 'mod' || name === 'pmod') {
                const arg = readLatexArgument(src, after);
                if (arg) {
                    const op = add({ command: name, relation: 'mod', operator: true });
                    out += name === 'pmod'
                        ? `\\left(${op}\\,${rewrite(arg.text)}\\right)`
                        : `\\;${op}\\,${rewrite(arg.text)}`;
                    i = arg.end;
                    continue;
                }
            } else if (EXTENSIBLE_ARROWS[name]) {
                const below = readOptionalArgument(src, after);
                const above = readLatexArgument(src, below ? below.end : after);
                if (above) {
                    let arrow = add({ command: name, relation: EXTENSIBLE_ARROWS[name], stretchy: true });
                    arrow = `\\overset{${rewrite(above.text)}}{${arrow}}`;
                    if (below) arrow = `\\underset{${rewrite(below.text)}}{${arrow}}`;
                    out += arrow;
                    i = above.end;
                    continue;
                }
            } else if (RENAMES[name]) {
                out += `\\${RENAMES[name]}`;
                i = after;
                continue;
            }
            out += m[0];
            i = after;
        }
        return out;
    }

    const rewritten = rewrite(latex || '');
    return { latex: rewritten, placeholders, changed: rewritten !== (latex || '') };
}

// Swaps each placeholder <mtext> produced from rewriteLatexForExport()'s
// output for the right operator, in place. Returns how many were replaced;
// any placeholder left behind (count < placeholders.length) means the
// conversion didn't go as planned -- see findConversionProblems.
export function replaceExportPlaceholders(root, placeholders) {
    if (!root || !placeholders || !placeholders.length) return 0;
    const byId = new Map(placeholders.map((p) => [p.id, p]));
    const doc = root.ownerDocument;
    const found = [];
    (function walk(n) {
        if ((nameOf(n) === 'mtext' || nameOf(n) === 'mi') && byId.has(textOf(n).trim())) found.push(n);
        elementChildren(n).forEach(walk);
    })(root);

    let replaced = 0;
    for (const mtext of found) {
        const spec = byId.get(textOf(mtext).trim());
        const parent = mtext.parentNode;
        const ns = mtext.namespaceURI || null;
        const mo = doc.createElementNS(ns, 'mo');
        mo.appendChild(doc.createTextNode(spec.relation || spec.ch));

        if (spec.relation) {
            // "a \not\equiv b", "a \bmod b", \xrightarrow's arrow: drop the
            // invisible operators MathLive puts around a \text{} so it
            // reads as an operator.
            if (spec.stretchy) mo.setAttribute('stretchy', 'true');
            parent.replaceChild(mo, mtext);
            for (const dir of ['previousSibling', 'nextSibling']) {
                let s = mo[dir];
                while (s && s.nodeType !== 1) s = s[dir];
                if (s && isInvisibleOp(s)) parent.removeChild(s);
            }
            replaced++;
            continue;
        }

        const script = nameOf(parent);
        if ((spec.pos === 'over' && script !== 'mover') || (spec.pos === 'under' && script !== 'munder')) continue;
        if (!spec.accent) mo.setAttribute('stretchy', 'true');
        parent.replaceChild(mo, mtext);
        if (spec.accent) parent.setAttribute(spec.pos === 'over' ? 'accent' : 'accentunder', 'true');

        // \overbrace{x}^{label} comes back as <msup><mover>...</mover>label</msup>;
        // MathJax (and MathCAT/SRE) expect the label stacked:
        // <mover><mover>...</mover>label</mover>.
        const outer = parent.parentNode;
        const wantScript = spec.label === 'sup' ? 'msup' : spec.label === 'sub' ? 'msub' : null;
        if (wantScript && outer && nameOf(outer) === wantScript && elementChildren(outer)[0] === parent) {
            const label = elementChildren(outer)[1];
            const stacked = doc.createElementNS(outer.namespaceURI || null, spec.pos === 'over' ? 'mover' : 'munder');
            outer.parentNode.replaceChild(stacked, outer);
            stacked.appendChild(parent);
            if (label) stacked.appendChild(label);
        }
        replaced++;
    }
    return replaced;
}

// MathLive exports \vec{v} with U+20D7 COMBINING RIGHT ARROW ABOVE as the
// accent; SRE has no braille for it and copies the raw character into the
// Nemeth output ("⠐⠧⠣⃗⠻"). Use the spacing arrow U+2192, which both SRE
// (⠐⠧⠣⠫⠕⠻) and MathCAT read as an arrow/vector.
function fixCombiningVectorArrow(node) {
    if (nameOf(node) !== 'mover') return 0;
    const accent = elementChildren(node)[1];
    if (!accent || nameOf(accent) !== 'mo' || textOf(accent) !== '\u20D7') return 0;
    accent.textContent = '\u2192';
    return 1;
}

// MathLive exports \binom{n}{k} as a <mtable> whose <mtr>s have no <mtd>
// (invalid MathML). Rewrite it as the standard zero-thickness fraction,
// which MathCAT reads as "n choose k" and MathJax renders correctly.
function fixBinomialTable(node) {
    if (nameOf(node) !== 'mtable') return 0;
    const rows = elementChildren(node);
    if (rows.length !== 2 || !rows.every((r) => nameOf(r) === 'mtr' && elementChildren(r).length === 1 && nameOf(elementChildren(r)[0]) !== 'mtd')) return 0;
    const parent = node.parentNode;
    const sibs = parent ? elementChildren(parent) : [];
    if (sibs.length !== 3 || sibs[1] !== node || textOf(sibs[0]) !== '(' || textOf(sibs[2]) !== ')') return 0;
    const doc = node.ownerDocument;
    const frac = doc.createElementNS(node.namespaceURI || null, 'mfrac');
    frac.setAttribute('linethickness', '0');
    frac.appendChild(elementChildren(rows[0])[0]);
    frac.appendChild(elementChildren(rows[1])[0]);
    parent.replaceChild(frac, node);
    return 1;
}

// Things in the final MathML that mean part of the equation was lost:
// empty output, "undefined", a leftover placeholder, or an over/under
// script with its base missing. Returns short descriptions (empty = fine).
export function findConversionProblems(latex, root) {
    const problems = [];
    const hasLatex = Boolean((latex || '').trim());
    if (!root) return hasLatex ? ['the equation could not be converted to MathML at all'] : problems;
    if (hasLatex && !elementChildren(root).length) problems.push('the equation could not be converted to MathML at all');
    (function walk(n) {
        const name = nameOf(n);
        const t = elementChildren(n).length ? '' : textOf(n).trim();
        if (t === 'undefined') problems.push('a symbol came out as "undefined"');
        if (t.startsWith(EXPORT_PLACEHOLDER)) problems.push('an accent or arrow could not be placed');
        if (['mover', 'munder', 'msup', 'msub', 'mfrac', 'mroot'].includes(name) && elementChildren(n).length < 2) {
            problems.push(`a <${name}> is missing part of its content`);
        }
        elementChildren(n).forEach(walk);
    })(root);
    return Array.from(new Set(problems));
}

// Runs every cleanup above plus normalizeFenceBars over MathLive's MathML,
// in place -- first swapping in any rewriteLatexForExport() placeholders. Returns the number of changes made (0 = leave the original
// markup untouched).
export function cleanUpMathLiveMathml(root, placeholders) {
    if (!root) return 0;
    let changed = replaceExportPlaceholders(root, placeholders);
    const all = [];
    (function collect(n) {
        all.push(n);
        elementChildren(n).forEach(collect);
    })(root);
    for (const n of all) changed += fixScriptArity(n);
    for (const n of all) changed += fixPrimeInSuperscript(n);
    for (const n of all) changed += fixAttachedSymbols(n);
    for (const n of all) changed += mergeDigitGroups(n);
    for (const n of all) changed += fixBinomialTable(n);
    for (const n of all) changed += fixCombiningVectorArrow(n);
    for (const n of all) changed += fixDegreeSign(n);
    for (const n of all) changed += dropDanglingFunctionApplication(n);
    for (const n of all) changed += fixSetBuilderBar(n);
    for (const n of all) changed += fixLooseSpaces(n);
    for (const n of all) changed += fixFunctionLetters(n);
    for (const n of all) changed += fixSuperscriptStar(n);
    for (const n of all) changed += fixEmptyBaseScripts(n);
    for (const n of all) if (n.parentNode) changed += fixPrimeRuns(n);
    changed += normalizeFenceBars(root);
    return changed;
}

function containsBracket(nodes) {
    const BRACKETS = new Set(['(', ')', '[', ']', '{', '}']);
    const check = (n) => (nameOf(n) === 'mo' && BRACKETS.has(textOf(n))) || elementChildren(n).some(check);
    return nodes.some(check);
}

const BRACKETED_INTERVAL_TYPES = {
    '[]': 'closed-interval',
    '[)': 'closed-open-interval',
    '(]': 'open-closed-interval'
};

// Plain-text rendering of a subtree for labels: "a/b" for a fraction,
// "x^2" for a superscript, "√(x)" for a root -- so "|a/b|" doesn't show up
// in the picker as "|ab|".
function readableText(node) {
    const kids = elementChildren(node);
    if (!kids.length) return textOf(node);
    const r = kids.map(readableText);
    const g = (s) => (s.replace(INVISIBLE_CHARS, '').length > 1 ? `(${s})` : s);
    switch (nameOf(node)) {
        case 'mfrac': return `${g(r[0])}/${g(r[1])}`;
        case 'msup': return `${r[0]}^${g(r[1])}`;
        case 'msub': return `${r[0]}_${g(r[1])}`;
        case 'msubsup': return `${r[0]}_${g(r[1])}^${g(r[2])}`;
        case 'msqrt': return `√(${r.join('')})`;
        case 'mroot': return `root ${r[1]} of (${r[0]})`;
        default: return r.join('');
    }
}

// Human-readable label for the picker, e.g. "(0, 5)" or "|x|" -- the
// members' text with MathLive's invisible operators removed.
function labelFor(members) {
    return members
        .map(readableText)
        .join('')
        .replace(INVISIBLE_CHARS, '')
        .replace(/∣/g, '|')
        .replace(/∥/g, '‖')
        .replace(/\s*,\s*/g, ', ')
        .trim();
}

// Recursively walks an already-parsed MathML element tree looking for the
// two ambiguous shapes described above, returning every occurrence in
// document order (not deduplicated -- see findAmbiguousShapes for the
// per-kind Set the ambiguity notes use). Each occurrence carries live
// element references so applyIntents() can edit the tree in place:
//
//   kind        'point-or-interval' | 'absolute-value-or-set-builder'
//   parent      the row the shape was found in
//   members     the elements making up the whole shape, delimiters included
//   operands    one element array per argument ((a, b) -> [[a], [b]])
//   operandParent  where the operands live if not directly in the group
//   fixable     false when the tree can't safely take an intent here
//   label       readable text for the UI, e.g. "(0, 5)"
//   key         label plus a per-label counter, e.g. "(0, 5)#1" -- stable
//               across edits elsewhere in the equation, used to remember
//               the author's choice
//
// Takes an Element (e.g. `doc.documentElement` from a DOMParser or
// @xmldom/xmldom parse), not a raw string -- parsing/error-handling for a
// raw MathML string is the caller's job (see parseMathmlFragment in
// resources/script.js), which keeps this function DOM-implementation-
// agnostic and directly unit-testable in Node.
export function findAmbiguousOccurrences(root) {
    const found = [];
    if (!root) return found;

    function walk(node, precedingSibling) {
        const children = elementChildren(node);
        const fixedArity = FIXED_ARITY_ELEMENTS.has(nameOf(node));

        // Scan for "(" ... ")" as a subsequence anywhere within this row's
        // children -- not just when the whole row is exactly that shape. A
        // flattened row can contain a parenthesized group alongside other
        // content (e.g. "(a,b) + |x|" as one un-nested row), so requiring
        // the group to span the entire row would miss it.
        for (let i = 0; i < children.length; i++) {
            const openCh = textOf(children[i]);
            if (nameOf(children[i]) !== 'mo' || (openCh !== '(' && openCh !== '[')) continue;
            for (let j = i + 1; j < children.length; j++) {
                const closeCh = textOf(children[j]);
                if (nameOf(children[j]) !== 'mo' || (closeCh !== ')' && closeCh !== ']')) continue;
                const { nodes: between, container } = unwrapGroup(children.slice(i + 1, j));
                const hasComma = between.some(isComma);
                // What immediately precedes this "(" -- either an earlier
                // sibling in this same row, or (if "(" is the row's first
                // child) whatever preceded the row itself.
                const opener = i > 0 ? children[i - 1] : precedingSibling;
                const isFunctionCall =
                    opener && nameOf(opener) === 'mo' && textOf(opener) === FUNCTION_APPLICATION;
                if (hasComma && !isFunctionCall && (openCh !== '(' || closeCh !== ')')) {
                    // "[a, b]", "[a, b)", "(a, b]": interval notation (the
                    // same shapes MathCAT's intent rules treat as intervals
                    // without further clues). Only exactly two endpoints,
                    // and not when brackets nest inside -- MathCAT excludes
                    // that too.
                    const operands = splitOnCommas(between);
                    if (operands.length === 2 && operands.every((seg) => seg.length > 0) && !containsBracket(between)) {
                        found.push({
                            kind: 'bracketed-interval',
                            intervalType: BRACKETED_INTERVAL_TYPES[openCh + closeCh],
                            parent: node,
                            members: children.slice(i, j + 1),
                            operands,
                            operandParent: container,
                            fixable: !fixedArity
                        });
                    }
                } else if (hasComma && !isFunctionCall) {
                    const operands = splitOnCommas(between);
                    found.push({
                        kind: 'point-or-interval',
                        parent: node,
                        members: children.slice(i, j + 1),
                        operands,
                        operandParent: container,
                        fixable: !fixedArity && operands.every((seg) => seg.length > 0)
                    });
                }
                break; // paired this "(" with its nearest ")"; move on to any further "(" in this row
            }
        }

        // Single-bar pairs only ("|x|"); double bars ("‖v‖") are
        // conventionally a norm and aren't flagged. See pairBars for how
        // "|x| + |y|" and nested "||x| - |y||" are paired, and why a lone
        // bar (e.g. "divides") is left unflagged.
        const pairs = (pairBars(children) || []).filter(([b0]) => barFamily(children[b0]) === 'single');
        if (pairs.length) {
            for (const [b0, b1] of pairs) {
                let inside = children.slice(b0 + 1, b1);
                while (inside.length && isInvisibleTimes(inside[0])) inside = inside.slice(1);
                while (inside.length && isInvisibleTimes(inside[inside.length - 1])) inside = inside.slice(0, -1);
                found.push({
                    kind: 'absolute-value-or-set-builder',
                    parent: node,
                    members: children.slice(b0, b1 + 1),
                    operands: inside.length ? [inside] : [],
                    operandParent: null,
                    fixable: !fixedArity && inside.length > 0
                });
            }
        }

        // A letter right before parentheses that the cleanup left as
        // multiplication -- "y(t)", "p(x)", "u(x, y)": a function or a
        // product? (Letters the cleanup already made functions -- h, F, P,
        // ... see fixFunctionLetters -- carry U+2061 instead and aren't
        // flagged.) Only when the parentheses hold a single term: "a(b + c)",
        // "x(x + 1)" are near-certainly multiplication and asking about every
        // one would bury the real questions.
        for (let i = 0; i + 2 < children.length; i++) {
            const [nm, op, grp] = [children[i], children[i + 1], children[i + 2]];
            if (nameOf(nm) !== 'mi' || !/^([A-Za-z]|[\u0391-\u03C9\u03D5])$/.test(textOf(nm))) continue;
            if (!isInvisibleTimes(op) || nameOf(grp) !== 'mrow') continue;
            const first = elementChildren(grp)[0];
            if (!first || nameOf(first) !== 'mo' || textOf(first) !== '(') continue;
            if (hasTopLevelPlusMinus(grp)) continue;
            found.push({
                kind: 'function-or-product',
                parent: node,
                members: [nm, op, grp],
                operands: [],
                operandParent: null,
                fixable: !fixedArity,
                op,
                group: grp
            });
        }

        children.forEach((child, i) => walk(child, i > 0 ? children[i - 1] : null));
    }

    walk(root, null);

    // "u(x, y)" also looks like a bare "(a, b)" point/interval. If the author
    // says u is a function, that second question goes away (see
    // isSuppressedOccurrence).
    for (const occ of found) {
        if (occ.kind !== 'point-or-interval') continue;
        const owner = found.find((o) => o.kind === 'function-or-product' && o.group === occ.parent);
        if (owner) occ.ifNotFunction = owner;
    }

    const seen = new Map();
    for (const occ of found) {
        occ.label = labelFor(occ.members);
        const n = (seen.get(occ.label) || 0) + 1;
        seen.set(occ.label, n);
        occ.key = `${occ.label}#${n}`;
    }
    return found;
}

// Per-kind Set, deduplicated, so a shape appearing multiple times in one
// equation still produces just one note.
export function findAmbiguousShapes(root) {
    return new Set(findAmbiguousOccurrences(root).map((o) => o.kind));
}

export function describeAmbiguities(kinds) {
    return Array.from(kinds).map((kind) => AMBIGUITY_NOTES[kind]).filter(Boolean);
}

// --- MathML intent (MathML 4) --------------------------------------------
//
// Lets the author say what an ambiguous shape flagged above actually means,
// and writes that into the MathML as an `intent` attribute -- what MathCAT
// (the math engine in NVDA and JAWS) reads instead of guessing. E.g. "(0,5)"
// as an open interval becomes
//
//   <mrow intent="open-interval($a1,$a2)">
//     <mo>(</mo><mrow><mn arg="a1">0</mn><mo>,</mo><mn arg="a2">5</mn></mrow><mo>)</mo>
//   </mrow>
//
// Concept names are from the W3C MathML Core Concept list
// (https://w3c.github.io/mathml-docs/intent-core-concepts/), checked
// September 2026. Speech Rule Engine (Description/Braille/Read Aloud) does
// not read intent -- zero references to it in the vendored sre.js -- so
// this only changes the MathML output format.
export const INTENT_MEANINGS = {
    'point-or-interval': [
        { value: 'coordinate', label: 'Point (coordinates)', minArgs: 2 },
        { value: 'open-interval', label: 'Open interval', minArgs: 2, maxArgs: 2 },
        { value: 'greatest-common-divisor', label: 'Greatest common divisor', minArgs: 2 }
    ],
    'absolute-value-or-set-builder': [
        { value: 'absolute-value', label: 'Absolute value', minArgs: 1, maxArgs: 1 },
        { value: 'cardinality', label: 'Cardinality (number of elements in a set)', minArgs: 1, maxArgs: 1 },
        { value: 'determinant', label: 'Determinant of a matrix', minArgs: 1, maxArgs: 1 }
    ],
    // Not an intent: "function" switches the invisible operator from times
    // (U+2062) to function application (U+2061); see applyIntents.
    'function-or-product': [
        { value: 'function', label: 'A function ("of")', minArgs: 0 }
    ],
    // Only the one matching the brackets is offered (see meaningsFor).
    'bracketed-interval': [
        { value: 'closed-interval', label: 'Closed interval (both endpoints included)', minArgs: 2, maxArgs: 2 },
        { value: 'closed-open-interval', label: 'Interval including the left endpoint only', minArgs: 2, maxArgs: 2 },
        { value: 'open-closed-interval', label: 'Interval including the right endpoint only', minArgs: 2, maxArgs: 2 }
    ]
};

// The meanings that make sense for this particular occurrence -- e.g. an
// open interval needs exactly two endpoints, so "(1, 2, 3)" doesn't offer it.
export function meaningsFor(occurrence) {
    if (!occurrence || !occurrence.fixable) return [];
    const n = occurrence.operands.length;
    return (INTENT_MEANINGS[occurrence.kind] || []).filter(
        (m) => n >= (m.minArgs || 0) && n <= (m.maxArgs ?? Infinity) &&
            (occurrence.kind !== 'bracketed-interval' || m.value === occurrence.intervalType)
    );
}

// Kinds whose notation is conventional enough to get an intent without the
// author choosing one -- currently just bracketed intervals. The author can
// still opt out (stored choice '').
export function defaultMeaning(occurrence) {
    if (occurrence && occurrence.kind === 'bracketed-interval') {
        const m = meaningsFor(occurrence)[0];
        return m ? m.value : undefined;
    }
    return undefined;
}

// Merges the author's stored choices with defaults: a stored key always
// wins, including '' ("no intent", to opt out of a default).
export function resolveIntentChoices(occurrences, stored) {
    const effective = {};
    for (const occ of occurrences || []) {
        if (stored && Object.prototype.hasOwnProperty.call(stored, occ.key)) {
            effective[occ.key] = stored[occ.key];
        } else {
            const d = defaultMeaning(occ);
            if (d) effective[occ.key] = d;
        }
    }
    return effective;
}

// Relations that, just before or after "(a, b)", point to an interval --
// the same context clues MathCAT's interval rule uses ("=" and its
// SubsetOperators list, trimmed to the common ones).
const INTERVAL_CONTEXT_OPS = new Set([
    '=', '∈', '∊', '∉', '⊂', '⊃', '⊆', '⊇',
    '⊊', '⊋', '⊄', '⊅', '⊈', '⊉'
]);

function meaningfulNeighbor(occ, dir) {
    const kids = elementChildren(occ.parent).filter((n) => !isInvisibleOp(n));
    const edge = dir < 0 ? occ.members[0] : occ.members[occ.members.length - 1];
    const idx = kids.indexOf(edge);
    if (idx === -1) return null;
    if (kids[idx + dir]) return kids[idx + dir];
    // The shape is its whole row (MathLive's usual wrapping): look beside the row.
    const row = occ.parent;
    const gp = row.parentNode;
    if (!gp || gp.nodeType !== 1) return null;
    const gk = elementChildren(gp).filter((n) => !isInvisibleOp(n));
    const ri = gk.indexOf(row);
    return ri === -1 ? null : gk[ri + dir] || null;
}

// For "(a, b)", a suggested meaning when the context makes one likely --
// adapted from MathCAT's interval rule (Rules/Intent/general.yaml): an
// endpoint containing infinity, or "=" / "∈" / a subset symbol right next
// to it. Returns { value, reason } or null. Only a suggestion: nothing is
// added to the MathML unless the author picks it. Call before
// applyIntents, which may regroup the tree.
export function suggestMeaning(occurrence) {
    if (!occurrence || occurrence.kind !== 'point-or-interval' ||
        !meaningsFor(occurrence).some((m) => m.value === 'open-interval')) {
        return null;
    }
    if (occurrence.operands.some((seg) => seg.some((n) => textOf(n).includes('∞')))) {
        return { value: 'open-interval', reason: 'an endpoint is infinity' };
    }
    for (const dir of [-1, 1]) {
        const nb = meaningfulNeighbor(occurrence, dir);
        if (nb && nameOf(nb) === 'mo' && INTERVAL_CONTEXT_OPS.has(textOf(nb))) {
            return { value: 'open-interval', reason: `it comes ${dir < 0 ? 'right after' : 'right before'} "${textOf(nb)}"` };
        }
    }
    return null;
}

function liftToChildOf(el, parent) {
    let cur = el;
    while (cur && cur.parentNode !== parent) cur = cur.parentNode;
    return cur || null;
}

// Makes `els` (siblings under `parent`, possibly already moved one level
// down by an earlier wrap) a single element: returns it directly if it's
// already one element, reuses `parent` itself if it's an <mrow> containing
// exactly these elements and `reuseParent` is set, or else wraps them in a
// new <mrow> at their position.
function wrapRange(parent, els, reuseParent) {
    const lifted = [];
    for (const el of els) {
        const l = liftToChildOf(el, parent);
        if (l && !lifted.includes(l)) lifted.push(l);
    }
    if (!lifted.length) return null;
    if (lifted.length === 1) return lifted[0];
    if (reuseParent && nameOf(parent) === 'mrow' && elementChildren(parent).length === lifted.length) {
        return parent;
    }
    const wrapper = parent.ownerDocument.createElementNS(parent.namespaceURI || null, 'mrow');
    parent.insertBefore(wrapper, lifted[0]);
    for (const el of lifted) wrapper.appendChild(el);
    return wrapper;
}

function subtreeSize(el) {
    return 1 + elementChildren(el).reduce((sum, c) => sum + subtreeSize(c), 0);
}

// Applies the author's choices (an object mapping occurrence key -> intent
// concept name, e.g. { "(0, 5)#1": "open-interval" }) to the tree the
// occurrences were found in, editing it in place. Unknown or invalid
// choices are skipped. Returns the number of intents actually added.
//
// Innermost shapes are applied first (smallest subtree first): wrapping an
// outer shape first would move the inner shape's elements out from under
// the row they were found in. E.g. "|(a, b)|" in one flat row -- the paren
// group gets its own <mrow> first, then the bar group wraps around it.
// True when an occurrence no longer applies given the other choices -- a
// "(x, y)" point/interval question inside "u(x, y)" once u is a function.
export function isSuppressedOccurrence(occurrence, choices) {
    const owner = occurrence && occurrence.ifNotFunction;
    return Boolean(owner && choices && choices[owner.key] === 'function');
}

export function applyIntents(occurrences, choices) {
    if (!occurrences || !choices) return 0;
    const ordered = occurrences
        .filter((occ) => choices[occ.key] && !isSuppressedOccurrence(occ, choices))
        .map((occ) => ({ occ, size: occ.members.reduce((s, m) => s + subtreeSize(m), 0) }))
        .sort((a, b) => a.size - b.size)
        .map((x) => x.occ);

    // Argument names are numbered across the whole expression (a1, a2, a3,
    // ...) rather than restarting per shape. MathML 4 scopes a "$a1"
    // reference so it doesn't reach inside a nested intent anyway, but
    // unique names mean a consumer that gets that rule wrong still can't
    // resolve a reference to the wrong element.
    let nextArg = 1;
    let applied = 0;
    for (const occ of ordered) {
        const meaning = meaningsFor(occ).find((m) => m.value === choices[occ.key]);
        if (!meaning) continue;
        if (occ.kind === 'function-or-product') {
            occ.op.textContent = FUNCTION_APPLICATION;
            applied++;
            continue;
        }
        const group = wrapRange(occ.parent, occ.members, true);
        if (!group || group.getAttribute('intent')) continue;
        const operandParent = occ.operandParent || group;
        const refs = occ.operands.map((seg) => {
            const el = wrapRange(liftToChildOf(seg[0], operandParent) ? operandParent : seg[0].parentNode, seg, false);
            const name = `a${nextArg++}`;
            el.setAttribute('arg', name);
            return `$${name}`;
        });
        group.setAttribute('intent', `${meaning.value}(${refs.join(',')})`);
        applied++;
    }
    return applied;
}

// --- "SVG + hidden MathML" snippet ----------------------------------------
//
// For pasting into HTML (a web page, an LMS page's HTML view): the SVG is
// what sighted readers see, marked aria-hidden so screen readers skip it,
// and a visually hidden copy of the MathML sits beside it for screen
// readers -- which, unlike an image's alt text, lets NVDA/JAWS (MathCAT)
// and VoiceOver move through the equation piece by piece. This is the
// pattern MathJax v3 used by default ("assistive MathML"), built here by
// hand because MathVox deliberately doesn't load MathJax's accessibility
// bundle (see docs/MATHJAX_SVG_IMPLEMENTATION_PLAN.md).
//
// Everything is inline (no stylesheet travels with a paste). The hiding
// style is the standard "visually hidden" recipe: still in the
// accessibility tree, unlike display:none / visibility:hidden.
export const VISUALLY_HIDDEN_STYLE =
    'position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;' +
    'clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0';

// svgMarkup: a decorative SVG (aria-hidden, no <title>/role) from
// MathJax. presentation: the cleaned-up presentation MathML (with any
// chosen intents), without the <math> wrapper. latex: the original LaTeX,
// kept as an annotation the same way the MathML format does.
export function buildAssistiveSnippet(svgMarkup, presentation, latex) {
    const annotation = latex
        ? `<annotation encoding="application/x-tex">${escapeXmlText(latex)}</annotation>`
        : '';
    const math =
        `<math xmlns="http://www.w3.org/1998/Math/MathML" display="block" style="${VISUALLY_HIDDEN_STYLE}">` +
        `<semantics>${presentation}${annotation}</semantics></math>`;
    return `<span class="mathvox-equation" style="display:inline-block;position:relative">${svgMarkup}${math}</span>`;
}

// --- Word equation ("Copy for Word") ---------------------------------------
//
// Word turns MathML pasted as plain text into a native, editable Word
// equation (its own MathML-to-OMML converter does the work), which JAWS and
// NVDA can explore. Word has nowhere to keep MathML 4 `intent`/`arg`
// attributes, so they're removed rather than risk the converter rejecting
// them; the "function" choice survives because it's a character (U+2061),
// not an attribute. No <semantics>/<annotation> wrapper either: Word only
// wants the presentation markup.
const WORD_DROPPED_ATTRIBUTES = ['intent', 'arg'];

// Removes the attributes above from root and every descendant element.
// Returns how many were removed.
export function stripAttributesForWord(root) {
    let removed = 0;
    const walk = (el) => {
        for (const name of WORD_DROPPED_ATTRIBUTES) {
            if (el.hasAttribute && el.hasAttribute(name)) {
                el.removeAttribute(name);
                removed++;
            }
        }
        for (let child = el.firstChild; child; child = child.nextSibling) {
            if (child.nodeType === 1) walk(child);
        }
    };
    walk(root);
    return removed;
}

// MathLive writes function names as operators with no function-application
// marker after them ("<mo>sin</mo><mi>θ</mi>"). Speech Rule Engine reads
// that fine, but Word's converter would make "sin" a loose operator rather
// than a Word function (upright name, argument grouped with it). Rewrite to
// "<mi>sin</mi><mo>U+2061</mo>" -- the form MathML spells out for functions.
// "sin^2 x" (the name as a script base) gets the marker after the script.
// Limits ("lim" under munder) are left alone; Word handles those already.
// Returns how many names were changed.
const SCRIPT_PARENTS = new Set(['msub', 'msup', 'msubsup']);

function nextElement(node) {
    let next = node.nextSibling;
    while (next && next.nodeType !== 1) next = next.nextSibling;
    return next;
}

export function markFunctionNamesForWord(root) {
    let changed = 0;
    const names = [];
    const collect = (el) => {
        for (const child of elementChildren(el)) {
            if (nameOf(child) === 'mo' && /^[A-Za-z]{2,}$/.test(textOf(child).trim())) names.push(child);
            collect(child);
        }
    };
    collect(root);
    for (const mo of names) {
        const parent = mo.parentNode;
        const parentName = parent && parent.nodeType === 1 ? nameOf(parent) : '';
        if (['munder', 'mover', 'munderover'].includes(parentName)) continue;
        const asBase = SCRIPT_PARENTS.has(parentName) && elementChildren(parent)[0] === mo;
        if (SCRIPT_PARENTS.has(parentName) && !asBase) continue;
        const doc = mo.ownerDocument;
        const ns = mo.namespaceURI || null;
        const mi = doc.createElementNS(ns, 'mi');
        mi.appendChild(doc.createTextNode(textOf(mo).trim()));
        parent.replaceChild(mi, mo);
        changed++;
        // Same "is an argument coming?" test as dropDanglingFunctionApplication.
        const target = asBase ? parent : mi;
        const next = nextElement(target);
        if (!next) continue;
        if (nameOf(next) === 'mo' && textOf(next) === FUNCTION_APPLICATION) continue;
        const isArgument = !(nameOf(next) === 'mo' && !['(', '[', '{', '|', '‖', '⟨'].includes(textOf(next)));
        if (isArgument) target.parentNode.insertBefore(makeMo(doc, ns, FUNCTION_APPLICATION), next);
    }
    return changed;
}

// presentation: the inner presentation MathML (no <math> wrapper). Kept on
// one line: Word's paste detection looks at the start of the clipboard
// text, which must be the <math> start tag itself.
export function wrapWordMathml(presentation) {
    return `<math xmlns="http://www.w3.org/1998/Math/MathML" display="block">${presentation.trim()}</math>`;
}

// --- Handwriting input (Texo) ----------------------------------------------
//
// Turns a drawing into the 384x384 input the Texo model expects. A port of
// Texo-web's preprocessImg (github.com/alephpi/Texo-web, AGPL-3.0): invert
// if the picture is mostly dark, crop to the ink, scale so the shorter side
// fits (shrinking further if the longer side would overflow), center on a
// black square, then normalize with the training set's mean/std. Works on a
// plain greyscale array so it can be tested without a canvas.
export const TEXO_SIZE = 384;
const TEXO_MEAN = 0.7931;
const TEXO_STD = 0.1738;

function bilinearResize(src, sw, sh, dw, dh) {
    const out = new Uint8ClampedArray(dw * dh);
    const xRatio = sw / dw, yRatio = sh / dh;
    for (let y = 0; y < dh; y++) {
        const sy = Math.min(Math.max((y + 0.5) * yRatio - 0.5, 0), sh - 1);
        const y0 = Math.floor(sy), y1 = Math.min(y0 + 1, sh - 1), fy = sy - y0;
        for (let x = 0; x < dw; x++) {
            const sx = Math.min(Math.max((x + 0.5) * xRatio - 0.5, 0), sw - 1);
            const x0 = Math.floor(sx), x1 = Math.min(x0 + 1, sw - 1), fx = sx - x0;
            const top = src[y0 * sw + x0] * (1 - fx) + src[y0 * sw + x1] * fx;
            const bottom = src[y1 * sw + x0] * (1 - fx) + src[y1 * sw + x1] * fx;
            out[y * dw + x] = top * (1 - fy) + bottom * fy;
        }
    }
    return out;
}

// grey: Uint8 values 0-255, row by row (w*h). Returns a Float32Array of
// TEXO_SIZE*TEXO_SIZE, or null when there is no ink at all.
export function preprocessInk(grey, w, h) {
    let g = Uint8ClampedArray.from(grey);
    let dark = 0;
    for (const v of g) if (v < 200) dark++;
    if (dark >= g.length - dark) g = g.map((v) => 255 - v);
    let min = 255, max = 0;
    for (const v of g) { if (v < min) min = v; if (v > max) max = v; }
    if (max === min) return null;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            if (((g[y * w + x] - min) / (max - min)) * 255 < 200) {
                if (x < x0) x0 = x; if (x > x1) x1 = x;
                if (y < y0) y0 = y; if (y > y1) y1 = y;
            }
        }
    }
    if (x1 < x0) return null;
    // Same crop as Texo-web (the far edge is exclusive), at least 1 pixel.
    const cw = Math.max(x1 - x0, 1), ch = Math.max(y1 - y0, 1);
    const crop = new Uint8ClampedArray(cw * ch);
    for (let y = 0; y < ch; y++) crop.set(g.subarray((y + y0) * w + x0, (y + y0) * w + x0 + cw), y * cw);
    const scale = TEXO_SIZE / Math.min(cw, ch);
    let nw = Math.round(cw * scale), nh = Math.round(ch * scale);
    if (nw > TEXO_SIZE || nh > TEXO_SIZE) {
        const r = Math.min(TEXO_SIZE / nw, TEXO_SIZE / nh);
        nw = Math.round(nw * r); nh = Math.round(nh * r);
    }
    nw = Math.max(nw, 1); nh = Math.max(nh, 1);
    const resized = bilinearResize(crop, cw, ch, nw, nh);
    const padX = Math.floor((TEXO_SIZE - nw) / 2), padY = Math.floor((TEXO_SIZE - nh) / 2);
    const pixels = new Float32Array(TEXO_SIZE * TEXO_SIZE).fill((0 - TEXO_MEAN) / TEXO_STD);
    for (let y = 0; y < nh; y++) {
        for (let x = 0; x < nw; x++) {
            pixels[(y + padY) * TEXO_SIZE + x + padX] = (resized[y * nw + x] / 255 - TEXO_MEAN) / TEXO_STD;
        }
    }
    return pixels;
}

// Texo writes LaTeX with spaces between tokens ("x ^ { 2 } + 1"), which
// MathLive reads fine. Tidy it for the LaTeX box, and swap the few commands
// MathLive doesn't know (found by running Texo's output on the CROHME test
// set through MathLive: only \dots).
const RECOGNIZED_RENAMES = [[/\\dots\b/g, '\\ldots']];

export function normalizeRecognizedLatex(latex) {
    let s = (latex || '').trim();
    for (const [from, to] of RECOGNIZED_RENAMES) s = s.replace(from, to);
    // Drop spaces Texo puts around grouping and script characters, but keep
    // the one after a command name ("\sin x" must not become "\sinx").
    s = s.replace(/\s*([{}^_])\s*/g, '$1');
    s = s.replace(/(\\[A-Za-z]+)\s+(?=[A-Za-z])/g, '$1\u0000');
    s = s.replace(/\s+/g, ' ').replace(/ ?([=+\-<>]) ?/g, '$1').replace(/\u0000/g, ' ');
    return s.trim();
}

// --- Portable SVG: size and colors (large print) -----------------------------
//
// Options for the Portable SVG format, aimed at low-vision readers of
// handouts and slides. Every color pair is at least 7:1 (WCAG AAA). "default"
// keeps the original export: black ink, transparent background.
export const SVG_SIZES = ['100', '150', '200', '300', '400'];
export const SVG_COLOR_SCHEMES = {
    'default': { label: 'Black, no background', ink: 'black', background: null },
    'black-on-white': { label: 'Black on white', ink: '#000000', background: '#ffffff' },
    'white-on-black': { label: 'White on black', ink: '#ffffff', background: '#000000' },
    'yellow-on-black': { label: 'Yellow on black', ink: '#ffff00', background: '#000000' },
    'black-on-yellow': { label: 'Black on yellow', ink: '#000000', background: '#ffff00' },
    'black-on-cream': { label: 'Black on cream', ink: '#000000', background: '#fdf6e3' }
};

// "9.402ex" * 2 -> "18.804ex". Keeps the unit; rounds to 3 decimals the way
// MathJax writes them. Returns the input unchanged if it isn't a length.
export function scaleSvgLength(value, factor) {
    const m = /^(-?\d*\.?\d+)([a-z%]*)$/i.exec(String(value || '').trim());
    if (!m) return value;
    return `${+(parseFloat(m[1]) * factor).toFixed(3)}${m[2]}`;
}

// Works out the new viewBox, width, height and vertical-align for a MathJax
// SVG when it's scaled and (with a background) given some breathing room.
// MathJax units are 1000 per em; `pad` is in those units.
// attrs: { viewBox, width, height, verticalAlign } as MathJax wrote them.
export function svgLayoutFor(attrs, { scale = 1, pad = 0 } = {}) {
    const [x, y, w, h] = String(attrs.viewBox).trim().split(/[\s,]+/).map(Number);
    const viewBox = [x - pad, y - pad, w + 2 * pad, h + 2 * pad].map((n) => +n.toFixed(3)).join(' ');
    const grow = (len, ratio) => scaleSvgLength(len, ratio * scale);
    const width = grow(attrs.width, (w + 2 * pad) / w);
    const height = grow(attrs.height, (h + 2 * pad) / h);
    let verticalAlign = attrs.verticalAlign;
    const va = /^(-?\d*\.?\d+)ex$/.exec(String(attrs.verticalAlign || '').trim());
    const hm = /^(-?\d*\.?\d+)ex$/.exec(String(attrs.height || '').trim());
    if (va && hm) {
        const exPerUnit = parseFloat(hm[1]) / h;
        verticalAlign = `${+((parseFloat(va[1]) - pad * exPerUnit) * scale).toFixed(3)}ex`;
    }
    return { viewBox, width, height, verticalAlign, background: { x: x - pad, y: y - pad, width: w + 2 * pad, height: h + 2 * pad } };
}
