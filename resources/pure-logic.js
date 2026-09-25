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
