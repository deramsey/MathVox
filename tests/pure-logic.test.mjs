// Automated regression tests for the DOM-free logic helpers in
// resources/pure-logic.js. See that file's header comment for why these
// were split out, and PROJECT_NOTES.md's "September 2026 real-browser QA
// pass" section for the two bugs these specifically guard against. Run with
// `npm test` (node --test tests/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

import {
    findMathJsonError,
    unquote,
    describeMathJsonError,
    escapeXmlText,
    LATEX_ERROR_MESSAGES,
    describeLatexError,
    findBraceImbalance
} from '../resources/pure-logic.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('findMathJsonError finds a nested Error node', () => {
    const tree = ['Divide', ['Error', ['ErrorCode', "'incompatible-type'", "'number'", "'tuple<number, real>'"]], ['Multiply', 2, 'a']];
    const found = findMathJsonError(tree);
    assert.ok(found);
    assert.equal(found[0], 'Error');
});

test('findMathJsonError returns null for a clean tree', () => {
    const tree = ['Add', ['Power', 'x', 2], 1];
    assert.equal(findMathJsonError(tree), null);
});

test('findMathJsonError returns null for non-array input', () => {
    assert.equal(findMathJsonError('not an array'), null);
    assert.equal(findMathJsonError(42), null);
});

// Regression test for the September 2026 bug: mf.getValue('math-json')
// returns a JSON *string*, not an already-parsed structure. This confirms
// the fix (JSON.parse'ing it in script.js before calling
// findMathJsonError) is actually necessary: calling findMathJsonError
// directly on the raw string (the old, broken behavior) must fail to find
// the error, while parsing it first (the fix) must find it.
test('regression: a math-json value from MathLive is a JSON string and must be parsed before searching it', () => {
    const rawJsonString = JSON.stringify([
        'Divide',
        ['Error', ['ErrorCode', "'incompatible-type'", "'number'", "'tuple<number, real>'"]],
        ['Multiply', 2, 'a']
    ]);
    assert.equal(typeof rawJsonString, 'string');

    // Pre-fix behavior: searching the raw string directly never finds
    // anything, because Array.isArray('...') is false.
    assert.equal(findMathJsonError(rawJsonString), null);

    // Post-fix behavior: parse first, then search.
    const parsed = JSON.parse(rawJsonString);
    const found = findMathJsonError(parsed);
    assert.ok(found);
    assert.equal(found[0], 'Error');
    assert.match(describeMathJsonError(found), /\\pm/);
});

test('describeMathJsonError explains incompatible-type errors in plain language', () => {
    const errorNode = ['Error', ['ErrorCode', "'incompatible-type'", "'number'", "'tuple<number, real>'"]];
    const message = describeMathJsonError(errorNode);
    assert.match(message, /expected number but got tuple<number, real>/);
});

test('describeMathJsonError falls back gracefully for unknown error shapes', () => {
    assert.equal(
        describeMathJsonError(['Error', 'not-an-errorcode-array']),
        'hit an internal error MathJSON could not fully resolve'
    );
    assert.match(describeMathJsonError(['Error', ['ErrorCode', "'some-other-code'"]]), /some-other-code/);
});

test("unquote strips Compute Engine's single-quote wrapping", () => {
    assert.equal(unquote("'incompatible-type'"), 'incompatible-type');
    assert.equal(unquote('no-quotes'), 'no-quotes');
    assert.equal(unquote(42), '42');
});

test('escapeXmlText escapes &, <, > for safe XML embedding', () => {
    assert.equal(escapeXmlText('a < b & c > d'), 'a &lt; b &amp; c &gt; d');
    assert.equal(escapeXmlText('no special chars'), 'no special chars');
});

test('findBraceImbalance detects missing/extra/balanced braces', () => {
    assert.equal(findBraceImbalance('\\frac{1}{'), 1);
    assert.equal(findBraceImbalance('\\frac{1}{2}'), 0);
    assert.equal(findBraceImbalance('1}2'), -1);
});

test('findBraceImbalance ignores escaped literal braces', () => {
    assert.equal(findBraceImbalance('\\{not a group\\}'), 0);
});

test('LATEX_ERROR_MESSAGES / describeLatexError cover known codes and fall back for unknown ones', () => {
    assert.equal(describeLatexError({ code: 'unbalanced-braces' }), LATEX_ERROR_MESSAGES['unbalanced-braces']);
    assert.match(describeLatexError({ code: 'totally-made-up-code' }), /totally-made-up-code/);
});

// Regression test for the September 2026 "Illegal return statement" bug:
// findAmbiguousNotation's nested walk() helper was missing its own function
// declaration, which shifted a closing brace and left a bare `return`
// outside any function -- legal under CommonJS (Node's implicit module
// wrapper hides it) but a hard SyntaxError under a real ES module, which is
// how the browser actually loads this file (`<script type="module">` in
// index.html). Plain `node --check script.js` doesn't catch this because it
// defaults to CommonJS rules; copying to a .mjs file forces the same ES
// module parser the real page uses.
function assertParsesAsEsModule(relativePath) {
    const sourcePath = path.join(__dirname, '..', relativePath);
    const tmpPath = path.join(os.tmpdir(), `mathvox-esm-check-${process.pid}-${Date.now()}.mjs`);
    fs.copyFileSync(sourcePath, tmpPath);
    try {
        execFileSync(process.execPath, ['--check', tmpPath], { stdio: 'pipe' });
    } finally {
        fs.rmSync(tmpPath, { force: true });
    }
}

test('regression: resources/script.js parses cleanly as an ES module (not just CommonJS)', () => {
    assertParsesAsEsModule('resources/script.js');
});

test('regression: resources/pure-logic.js parses cleanly as an ES module', () => {
    assertParsesAsEsModule('resources/pure-logic.js');
});
