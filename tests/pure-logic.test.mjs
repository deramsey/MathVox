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
import { createRequire } from 'node:module';

import { DOMParser, XMLSerializer } from '@xmldom/xmldom';

import {
    findMathJsonError,
    unquote,
    describeMathJsonError,
    escapeXmlText,
    LATEX_ERROR_MESSAGES,
    describeLatexError,
    findBraceImbalance,
    findAmbiguousShapes,
    describeAmbiguities,
    findAmbiguousOccurrences,
    meaningsFor,
    applyIntents,
    INTENT_MEANINGS,
    pairBars,
    normalizeFenceBars,
    cleanUpMathLiveMathml,
    rewriteLatexForExport,
    replaceExportPlaceholders,
    findConversionProblems,
    resolveIntentChoices,
    suggestMeaning
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

// --- findAmbiguousShapes ------------------------------------------------
//
// Regression tests for the September 2026 redesign: the original version
// of this feature (see PROJECT_NOTES.md "September 2026 real-browser QA
// pass") never actually fired against real MathLive output, for two
// structural reasons. These tests build DOM trees with @xmldom/xmldom
// standing in for the browser's DOMParser -- the same technique the
// original one-off test harness used -- shaped exactly like MathLive's
// confirmed real output, so a regression in either fix would be caught
// here rather than only in a real browser again.
function parseMathMl(fragment) {
    const doc = new DOMParser().parseFromString(`<root>${fragment}</root>`, 'application/xml');
    return doc.documentElement;
}

test('findAmbiguousShapes flags "(0,5)" -- comma nested one level inside the parens, as MathLive really emits it', () => {
    const root = parseMathMl(
        '<mrow><mo>(</mo><mrow><mn>0</mn><mo separator="true">,</mo><mn>5</mn></mrow><mo>)</mo></mrow>'
    );
    const found = findAmbiguousShapes(root);
    assert.ok(found.has('point-or-interval'));
});

test('findAmbiguousShapes does NOT flag "f(x,y)" -- flat-row function-application variant', () => {
    // f, invisible FUNCTION APPLICATION (U+2061), "(", inner group, ")" all
    // as direct siblings in one row.
    const root = parseMathMl(
        '<mrow><mi>f</mi><mo>&#8289;</mo><mo>(</mo><mrow><mi>x</mi><mo separator="true">,</mo><mi>y</mi></mrow><mo>)</mo></mrow>'
    );
    const found = findAmbiguousShapes(root);
    assert.ok(!found.has('point-or-interval'));
});

test('findAmbiguousShapes does NOT flag "f(x,y)" -- wrapped-mrow function-application variant', () => {
    // Same meaning, but the parenthesized group is its own wrapped <mrow>,
    // preceded by f + the invisible operator in the parent row -- the
    // "precedingSibling" threading through walk() must catch this too.
    const root = parseMathMl(
        '<mrow><mi>f</mi><mo>&#8289;</mo><mrow><mo>(</mo><mrow><mi>x</mi><mo separator="true">,</mo><mi>y</mi></mrow><mo>)</mo></mrow></mrow>'
    );
    const found = findAmbiguousShapes(root);
    assert.ok(!found.has('point-or-interval'));
});

test('findAmbiguousShapes does NOT flag a single-argument parenthesized expression with no comma', () => {
    const root = parseMathMl(
        '<mrow><mo>(</mo><mrow><mi>x</mi><mo>+</mo><mn>1</mn></mrow><mo>)</mo></mrow>'
    );
    const found = findAmbiguousShapes(root);
    assert.equal(found.size, 0);
});

test('findAmbiguousShapes flags "|x|" -- bars tagged <mi>, not <mo>, as MathLive really emits them', () => {
    // Confirmed real shape (see PROJECT_NOTES.md): the bars are <mi>
    // U+2223, with U+2062 INVISIBLE TIMES between them and x.
    const root = parseMathMl(
        '<mrow><mi>&#8739;</mi><mo>&#8290;</mo><mi>x</mi><mo>&#8290;</mo><mi>&#8739;</mi></mrow>'
    );
    const found = findAmbiguousShapes(root);
    assert.ok(found.has('absolute-value-or-set-builder'));
});

test('findAmbiguousShapes does NOT flag a single bar (e.g. "2|4", divides notation) -- needs a pair', () => {
    const root = parseMathMl('<mrow><mn>2</mn><mi>&#8739;</mi><mn>4</mn></mrow>');
    const found = findAmbiguousShapes(root);
    assert.equal(found.size, 0);
});

test('findAmbiguousShapes finds both shapes in one flattened, un-nested row', () => {
    // "(a,b) + |x|" as a single row, per the original design intent that a
    // flattened row can contain a parenthesized group alongside other
    // content, not just when the whole row is exactly one shape.
    const root = parseMathMl(
        '<mrow><mo>(</mo><mrow><mi>a</mi><mo separator="true">,</mo><mi>b</mi></mrow><mo>)</mo>' +
        '<mo>+</mo><mi>&#8739;</mi><mo>&#8290;</mo><mi>x</mi><mo>&#8290;</mo><mi>&#8739;</mi></mrow>'
    );
    const found = findAmbiguousShapes(root);
    assert.ok(found.has('point-or-interval'));
    assert.ok(found.has('absolute-value-or-set-builder'));
});

test('findAmbiguousShapes returns an empty Set for a null root', () => {
    assert.equal(findAmbiguousShapes(null).size, 0);
});

test('describeAmbiguities maps kinds to their explanatory notes and drops unknown kinds', () => {
    const notes = describeAmbiguities(new Set(['point-or-interval', 'not-a-real-kind']));
    assert.equal(notes.length, 1);
    assert.match(notes[0], /point, an open interval/);
});

// --- findAmbiguousOccurrences / applyIntents -----------------------------
//
// The author-chosen `intent` feature (September 2026). Fixtures reuse the
// real MathLive shapes from the audit tests above.
const PAREN_05 = '<mrow><mo>(</mo><mrow><mn>0</mn><mo separator="true">,</mo><mn>5</mn></mrow><mo>)</mo></mrow>';
const ABS_X = '<mrow><mi>&#8739;</mi><mo>&#8290;</mo><mi>x</mi><mo>&#8290;</mo><mi>&#8739;</mi></mrow>';

function serialize(root) {
    const s = new XMLSerializer();
    return Array.from(root.childNodes).map((n) => s.serializeToString(n)).join('');
}

test('findAmbiguousOccurrences gives each shape a readable label and a stable key', () => {
    const occs = findAmbiguousOccurrences(parseMathMl(PAREN_05));
    assert.equal(occs.length, 1);
    assert.equal(occs[0].label, '(0, 5)');
    assert.equal(occs[0].key, '(0, 5)#1');
    assert.equal(occs[0].operands.length, 2);
    assert.ok(occs[0].fixable);

    const bars = findAmbiguousOccurrences(parseMathMl(ABS_X));
    assert.equal(bars[0].label, '|x|');
    // Invisible-times padding around x is not part of the operand.
    assert.equal(bars[0].operands[0].length, 1);
});

test('findAmbiguousOccurrences numbers repeated identical shapes separately', () => {
    const root = parseMathMl(`<mrow>${PAREN_05}<mo>+</mo>${PAREN_05}</mrow>`);
    const keys = findAmbiguousOccurrences(root).map((o) => o.key);
    assert.deepEqual(keys, ['(0, 5)#1', '(0, 5)#2']);
});

test('meaningsFor only offers open interval when there are exactly two endpoints', () => {
    const three = findAmbiguousOccurrences(parseMathMl(
        '<mrow><mo>(</mo><mrow><mn>1</mn><mo>,</mo><mn>2</mn><mo>,</mo><mn>3</mn></mrow><mo>)</mo></mrow>'
    ))[0];
    const values = meaningsFor(three).map((m) => m.value);
    assert.ok(!values.includes('open-interval'));
    assert.ok(values.includes('coordinate'));
    assert.equal(meaningsFor(findAmbiguousOccurrences(parseMathMl(PAREN_05))[0]).length, 3);
});

test('applyIntents: "(0,5)" as an open interval reuses the existing group row and marks both endpoints', () => {
    const root = parseMathMl(PAREN_05);
    const occs = findAmbiguousOccurrences(root);
    assert.equal(applyIntents(occs, { '(0, 5)#1': 'open-interval' }), 1);
    const row = root.getElementsByTagName('mrow')[0];
    assert.equal(row.getAttribute('intent'), 'open-interval($a1,$a2)');
    const nums = root.getElementsByTagName('mn');
    assert.equal(nums[0].getAttribute('arg'), 'a1');
    assert.equal(nums[1].getAttribute('arg'), 'a2');
    // No new wrapper rows were needed -- the tree shape is unchanged.
    assert.equal(root.getElementsByTagName('mrow').length, 2);
});

test('applyIntents: "|x|" as absolute value', () => {
    const root = parseMathMl(ABS_X);
    applyIntents(findAmbiguousOccurrences(root), { '|x|#1': 'absolute-value' });
    assert.equal(root.getElementsByTagName('mrow')[0].getAttribute('intent'), 'absolute-value($a1)');
    assert.equal(root.getElementsByTagName('mi')[1].getAttribute('arg'), 'a1');
});

test('applyIntents wraps a shape that shares its row with other content, leaving the rest alone', () => {
    // "2 + |x|" flat: the bars group must get its own <mrow> so the intent
    // doesn't swallow the "2 +".
    const root = parseMathMl(
        '<mrow><mn>2</mn><mo>+</mo><mi>&#8739;</mi><mo>&#8290;</mo><mi>x</mi><mo>&#8290;</mo><mi>&#8739;</mi></mrow>'
    );
    applyIntents(findAmbiguousOccurrences(root), { '|x|#1': 'determinant' });
    const outer = root.getElementsByTagName('mrow')[0];
    assert.equal(outer.hasAttribute('intent'), false);
    const kids = Array.from(outer.childNodes).filter((n) => n.nodeType === 1);
    assert.equal(kids.length, 3); // mn, mo, new mrow
    assert.equal(kids[2].getAttribute('intent'), 'determinant($a1)');
    assert.equal(serialize(root).replace(/\s/g, '').includes('<mn>2</mn><mo>+</mo><mrowintent'), true);
});

test('applyIntents wraps multi-element operands in their own <mrow>', () => {
    // "(x+1, 5)" -- the first endpoint is three elements.
    const root = parseMathMl(
        '<mrow><mo>(</mo><mrow><mi>x</mi><mo>+</mo><mn>1</mn><mo>,</mo><mn>5</mn></mrow><mo>)</mo></mrow>'
    );
    applyIntents(findAmbiguousOccurrences(root), { '(x+1, 5)#1': 'open-interval' });
    const argged = Array.from(root.getElementsByTagName('*')).filter((e) => e.getAttribute('arg'));
    assert.equal(argged.length, 2);
    assert.equal(argged[0].tagName, 'mrow');
    assert.equal(argged[0].textContent, 'x+1');
    assert.equal(argged[1].textContent, '5');
});

test('applyIntents handles a paren group nested inside bars in one flat row, innermost first', () => {
    // "|(a,b)|" flattened into one row.
    const root = parseMathMl(
        '<mrow><mi>&#8739;</mi><mo>(</mo><mrow><mi>a</mi><mo>,</mo><mi>b</mi></mrow><mo>)</mo><mi>&#8739;</mi></mrow>'
    );
    const occs = findAmbiguousOccurrences(root);
    assert.equal(occs.length, 2);
    const choices = {};
    for (const o of occs) choices[o.key] = o.kind === 'point-or-interval' ? 'coordinate' : 'absolute-value';
    assert.equal(applyIntents(occs, choices), 2);
    const outer = root.getElementsByTagName('mrow')[0];
    const inner = Array.from(root.getElementsByTagName('mrow')).find((e) => (e.getAttribute('intent') || '').startsWith('coordinate'));
    assert.ok(inner);
    // Inner shape applied first takes a1/a2; the outer one's argument is
    // the whole inner group, numbered a3 -- no name reused anywhere.
    assert.equal(inner.getAttribute('intent'), 'coordinate($a1,$a2)');
    assert.equal(inner.getAttribute('arg'), 'a3');
    assert.equal(outer.getAttribute('intent'), 'absolute-value($a3)');
    assert.equal(inner.textContent, '(a,b)');
});

test('applyIntents skips unknown/invalid choices and leaves the tree untouched', () => {
    const root = parseMathMl(PAREN_05);
    const before = serialize(root);
    const occs = findAmbiguousOccurrences(root);
    assert.equal(applyIntents(occs, { '(0, 5)#1': 'absolute-value' }), 0);
    assert.equal(applyIntents(occs, { 'nope#1': 'open-interval' }), 0);
    assert.equal(applyIntents(occs, {}), 0);
    assert.equal(serialize(root), before);
});

test('a shape inside a fixed-arity element (e.g. a superscript base) is flagged but not offered a picker', () => {
    // msubsup with exactly "(", inner, ")" as its three positional children --
    // wrapping them would break the element.
    const root = parseMathMl('<msubsup><mo>(</mo><mrow><mi>a</mi><mo>,</mo><mi>b</mi></mrow><mo>)</mo></msubsup>');
    const occ = findAmbiguousOccurrences(root)[0];
    assert.equal(occ.fixable, false);
    assert.equal(meaningsFor(occ).length, 0);
});

test('INTENT_MEANINGS uses W3C Core concept names', () => {
    const all = Object.values(INTENT_MEANINGS).flat().map((m) => m.value);
    assert.deepEqual(all.sort(), [
        'absolute-value', 'cardinality', 'closed-interval', 'closed-open-interval', 'coordinate',
        'determinant', 'greatest-common-divisor', 'open-closed-interval', 'open-interval'
    ]);
});

test('"|x| + |y|" in one flat row (as MathLive really emits it) is two separate bar pairs', () => {
    // Confirmed real MathLive output, September 2026 real-browser pass.
    const root = parseMathMl(
        '<mrow><mi>&#8739;</mi><mo>&#8290;</mo><mi>x</mi><mo>&#8290;</mo><mi>&#8739;</mi><mo>+</mo>' +
        '<mi>&#8739;</mi><mo>&#8290;</mo><mi>y</mi><mo>&#8290;</mo><mi>&#8739;</mi></mrow>'
    );
    const occs = findAmbiguousOccurrences(root);
    assert.deepEqual(occs.map((o) => o.label), ['|x|', '|y|']);
    assert.equal(applyIntents(occs, { '|x|#1': 'absolute-value', '|y|#1': 'absolute-value' }), 2);
    const groups = Array.from(root.getElementsByTagName('mrow')).filter((e) => e.hasAttribute('intent'));
    assert.deepEqual(groups.map((g) => g.textContent.replace(/[\u2062\u2223]/g, '')), ['x', 'y']);
});

test('nested bars ("||x| - |y||") pair up correctly: three separate shapes', () => {
    const bar = '<mi>&#8739;</mi>';
    const root = parseMathMl(`<mrow>${bar}${bar}<mi>x</mi>${bar}<mo>-</mo>${bar}<mi>y</mi>${bar}${bar}</mrow>`);
    assert.deepEqual(findAmbiguousOccurrences(root).map((o) => o.label), ['||x|-|y||', '|x|', '|y|']);
});

// --- Vertical-bar cleanup (normalizeFenceBars / pairBars) ----------------
//
// Fixtures are real MathLive output, captured in a headless-browser pass
// (September 2026).
const ML = {
    absX: '<mrow><mi>&#x2223;</mi><mo>&#8290;</mo><mi>x</mi><mo>&#8290;</mo><mi>&#x2223;</mi></mrow>',
    twoAbsX: '<mrow><mn>2</mn><mo>&#8290;</mo><mi>&#x2223;</mi><mo>&#8290;</mo><mi>x</mi><mo>&#8290;</mo><mi>&#x2223;</mi></mrow>',
    absXplusAbsY: '<mrow><mi>&#x2223;</mi><mo>&#8290;</mo><mi>x</mi><mo>&#8290;</mo><mi>&#x2223;</mi><mo>+</mo><mi>&#x2223;</mi><mo>&#8290;</mo><mi>y</mi><mo>&#8290;</mo><mi>&#x2223;</mi></mrow>',
    nested: '<mrow><mi>&#x2223;</mi><mo>&#8290;</mo><mi>&#x2223;</mi><mo>&#8290;</mo><mi>x</mi><mo>&#8290;</mo><mi>&#x2223;</mi><mo>&#x2212;</mo><mi>&#x2223;</mi><mo>&#8290;</mo><mi>y</mi><mo>&#8290;</mo><mi>&#x2223;</mi><mo>&#8290;</mo><mi>&#x2223;</mi></mrow>',
    absSum: '<mrow><mi>&#x2223;</mi><mo>&#8290;</mo><mi>x</mi><mo>+</mo><mn>1</mn><mo>&#8290;</mo><mi>&#x2223;</mi></mrow>',
    norm: '<mrow><mi>&#x2225;</mi><mo>&#8290;</mo><mi>v</mi><mo>&#8290;</mo><mi>&#x2225;</mi></mrow>',
    lvert: '<mrow><mo>&#x2223;</mo><mi>x</mi><mo>&#x2223;</mo></mrow>',
    setBuilder: '<mrow><mo>{</mo><mi>x</mi><mo>&#x2223;</mo><mi>x</mi><mo>&gt;</mo><mn>0</mn><mo>}</mo></mrow>',
    divides: '<mrow><mn>2</mn><mo>&#x2223;</mo><mn>4</mn></mrow>',
    leftRight: '<mrow><mo>|</mo><mi>x</mi><mo>|</mo></mrow>'
};

function normalized(fragment) {
    const root = parseMathMl(fragment);
    const n = normalizeFenceBars(root);
    return { n, xml: serialize(root) };
}

test('pairBars pairs bars the way a reader would', () => {
    const kids = (f) => Array.from(parseMathMl(f).firstChild.childNodes).filter((n) => n.nodeType === 1);
    assert.deepEqual(pairBars(kids(ML.absX)), [[0, 4]]);
    assert.deepEqual(pairBars(kids(ML.twoAbsX)), [[2, 6]]);
    assert.deepEqual(pairBars(kids(ML.absXplusAbsY)), [[0, 4], [6, 10]]);
    // ||x| - |y||: outer pair wraps both inner ones.
    assert.deepEqual(pairBars(kids(ML.nested)), [[0, 14], [2, 6], [8, 12]]);
    assert.equal(pairBars(kids(ML.divides)), null); // lone bar
    assert.equal(pairBars(kids(ML.setBuilder)), null);
});

test('normalizeFenceBars: MathLive "|x|" becomes the \\left|x\\right| shape', () => {
    const { n, xml } = normalized(ML.absX);
    assert.equal(n, 1);
    assert.equal(xml, '<mrow><mo>|</mo><mi>x</mi><mo>|</mo></mrow>');
});

test('normalizeFenceBars keeps implied multiplication outside the bars ("2|x|")', () => {
    assert.equal(normalized(ML.twoAbsX).xml, '<mrow><mn>2</mn><mo>⁢</mo><mrow><mo>|</mo><mi>x</mi><mo>|</mo></mrow></mrow>');
});

test('normalizeFenceBars groups "|x| + |y|" and nested "||x| - |y||"', () => {
    assert.equal(normalized(ML.absXplusAbsY).xml,
        '<mrow><mrow><mo>|</mo><mi>x</mi><mo>|</mo></mrow><mo>+</mo><mrow><mo>|</mo><mi>y</mi><mo>|</mo></mrow></mrow>');
    const { n, xml } = normalized(ML.nested);
    assert.equal(n, 3);
    assert.equal(xml,
        '<mrow><mo>|</mo><mrow><mrow><mo>|</mo><mi>x</mi><mo>|</mo></mrow><mo>−</mo><mrow><mo>|</mo><mi>y</mi><mo>|</mo></mrow></mrow><mo>|</mo></mrow>');
});

test('normalizeFenceBars wraps multi-part contents ("|x+1|") and fixes norms ("\\|v\\|")', () => {
    assert.equal(normalized(ML.absSum).xml, '<mrow><mo>|</mo><mrow><mi>x</mi><mo>+</mo><mn>1</mn></mrow><mo>|</mo></mrow>');
    assert.equal(normalized(ML.norm).xml, '<mrow><mo>‖</mo><mi>v</mi><mo>‖</mo></mrow>');
});

test('normalizeFenceBars fixes \\lvert x\\rvert but leaves \\mid (set-builder, divides) and already-good bars alone', () => {
    assert.equal(normalized(ML.lvert).xml, '<mrow><mo>|</mo><mi>x</mi><mo>|</mo></mrow>');
    for (const f of [ML.setBuilder, ML.divides, ML.leftRight, PAREN_05]) {
        const root = parseMathMl(f);
        const before = serialize(root);
        assert.equal(normalizeFenceBars(root), 0);
        assert.equal(serialize(root), before);
    }
});

test('after normalizing, "|x|" is still flagged with the same key, so saved choices keep working', () => {
    const root = parseMathMl(ML.absX);
    normalizeFenceBars(root);
    const occs = findAmbiguousOccurrences(root);
    assert.deepEqual(occs.map((o) => o.key), ['|x|#1']);
    applyIntents(occs, { '|x|#1': 'absolute-value' });
    assert.equal(serialize(root), '<mrow intent="absolute-value($a1)"><mo>|</mo><mi arg="a1">x</mi><mo>|</mo></mrow>');
});

test('a norm ("‖v‖") is not flagged as ambiguous', () => {
    const root = parseMathMl(ML.norm);
    normalizeFenceBars(root);
    assert.equal(findAmbiguousOccurrences(root).length, 0);
});

// Regression for the September 2026 bug: MathVox's Braille and Description
// output for a typed "|x|" contained Nemeth multiplication dots and the
// word "times". Runs the same Speech Rule Engine version MathVox vendors.
test('regression: Speech Rule Engine reads normalized bars correctly (no ⠈⠡, no "times")', async () => {
    const require = createRequire(import.meta.url);
    const sre = require('speech-rule-engine');
    const wrap = (f) => `<math>${f}</math>`;
    const fixed = (f) => wrap(normalized(f).xml);

    await sre.setupEngine({ modality: 'braille', locale: 'nemeth' });
    await sre.engineReady();
    assert.match(sre.toSpeech(wrap(ML.absX)), /⠈⠡/, 'raw MathLive output still shows the bug SRE-side');
    assert.equal(sre.toSpeech(fixed(ML.absX)), '⠳⠭⠳');
    assert.equal(sre.toSpeech(fixed(ML.twoAbsX)), '⠼⠆⠳⠭⠳');
    assert.equal(sre.toSpeech(fixed(ML.absSum)), '⠳⠭⠬⠂⠳');
    assert.equal(sre.toSpeech(fixed(ML.norm)), '⠳⠳⠧⠳⠳');

    await sre.setupEngine({ modality: 'speech', domain: 'mathspeak', style: 'default', locale: 'en' });
    await sre.engineReady();
    assert.equal(sre.toSpeech(fixed(ML.absX)), 'StartAbsoluteValue x EndAbsoluteValue');
    assert.doesNotMatch(sre.toSpeech(fixed(ML.nested)), /times/);
});

// --- Intervals (adapted from MathCAT's intent rules) ---------------------

const ML_INTERVAL = {
    closed: '<mrow><mo>[</mo><mrow><mn>0</mn><mo separator="true">,</mo><mn>5</mn></mrow><mo>]</mo></mrow>',
    closedOpen: '<mrow><mo>[</mo><mrow><mn>0</mn><mo separator="true">,</mo><mn>5</mn></mrow><mo>)</mo></mrow>',
    openClosed: '<mrow><mo>(</mo><mrow><mn>0</mn><mo separator="true">,</mo><mn>5</mn></mrow><mo>]</mo></mrow>',
    list: '<mrow><mo>[</mo><mrow><mn>1</mn><mo>,</mo><mn>2</mn><mo>,</mo><mn>3</mn></mrow><mo>]</mo></mrow>',
    member: '<mrow><mi>x</mi><mo>&#x2208;</mo><mrow><mo>(</mo><mrow><mn>0</mn><mo separator="true">,</mo><mn>5</mn></mrow><mo>)</mo></mrow></mrow>',
    toInfinity: '<mrow><mo>(</mo><mrow><mn>0</mn><mo separator="true">,</mo><mi>&#x221e;</mi></mrow><mo>)</mo></mrow>',
    equalsAfter: '<mrow><mrow><mo>(</mo><mrow><mi>a</mi><mo>,</mo><mi>b</mi></mrow><mo>)</mo></mrow><mo>=</mo><mi>I</mi></mrow>'
};

test('bracketed intervals are detected with the matching interval type', () => {
    const type = (f) => findAmbiguousOccurrences(parseMathMl(f)).map((o) => [o.kind, o.intervalType]);
    assert.deepEqual(type(ML_INTERVAL.closed), [['bracketed-interval', 'closed-interval']]);
    assert.deepEqual(type(ML_INTERVAL.closedOpen), [['bracketed-interval', 'closed-open-interval']]);
    assert.deepEqual(type(ML_INTERVAL.openClosed), [['bracketed-interval', 'open-closed-interval']]);
    assert.deepEqual(type(ML_INTERVAL.list), []); // three items: a list, not an interval
    assert.deepEqual(type(PAREN_05), [['point-or-interval', undefined]]);
});

test('bracketed intervals get their intent by default, and the author can opt out', () => {
    const root = parseMathMl(ML_INTERVAL.closed);
    const occs = findAmbiguousOccurrences(root);
    assert.deepEqual(meaningsFor(occs[0]).map((m) => m.value), ['closed-interval']);
    assert.deepEqual(resolveIntentChoices(occs, {}), { '[0, 5]#1': 'closed-interval' });
    assert.deepEqual(resolveIntentChoices(occs, { '[0, 5]#1': '' }), { '[0, 5]#1': '' });
    applyIntents(occs, resolveIntentChoices(occs, {}));
    assert.equal(root.getElementsByTagName('mrow')[0].getAttribute('intent'), 'closed-interval($a1,$a2)');

    const optedOut = parseMathMl(ML_INTERVAL.closed);
    const o2 = findAmbiguousOccurrences(optedOut);
    assert.equal(applyIntents(o2, resolveIntentChoices(o2, { '[0, 5]#1': '' })), 0);
});

test('"(a, b)" never gets an intent by default -- only a suggestion', () => {
    const occs = findAmbiguousOccurrences(parseMathMl(ML_INTERVAL.member));
    assert.deepEqual(resolveIntentChoices(occs, {}), {});
});

test('suggestMeaning uses MathCAT\'s interval clues: infinity endpoint, or ∈ / = next to it', () => {
    const suggest = (f) => suggestMeaning(findAmbiguousOccurrences(parseMathMl(f))[0]);
    assert.deepEqual(suggest(ML_INTERVAL.member), { value: 'open-interval', reason: 'it comes right after "∈"' });
    assert.deepEqual(suggest(ML_INTERVAL.toInfinity), { value: 'open-interval', reason: 'an endpoint is infinity' });
    assert.deepEqual(suggest(ML_INTERVAL.equalsAfter), { value: 'open-interval', reason: 'it comes right before "="' });
    assert.equal(suggest(PAREN_05), null);
    // three values can't be an interval, so no suggestion
    assert.equal(suggest('<mrow><mi>x</mi><mo>=</mo><mrow><mo>(</mo><mrow><mn>1</mn><mo>,</mo><mn>2</mn><mo>,</mo><mn>3</mn></mrow><mo>)</mo></mrow></mrow>'), null);
});

test('picker labels show structure: "|a/b|", "(x^2, 1)"', () => {
    const label = (f) => findAmbiguousOccurrences(parseMathMl(f)).map((o) => o.label);
    assert.deepEqual(label('<mrow><mo>|</mo><mfrac><mi>a</mi><mi>b</mi></mfrac><mo>|</mo></mrow>'), ['|a/b|']);
    assert.deepEqual(label('<mrow><mo>(</mo><mrow><msup><mi>x</mi><mn>2</mn></msup><mo>,</mo><mn>1</mn></mrow><mo>)</mo></mrow>'), ['(x^2, 1)']);
    assert.deepEqual(label('<mrow><mo>|</mo><mfrac><mrow><mi>a</mi><mo>+</mo><mn>1</mn></mrow><mi>b</mi></mfrac><mo>|</mo></mrow>'), ['|(a+1)/b|']);
});

// --- Other MathLive cleanups (cleanUpMathLiveMathml) ---------------------
//
// Found by cross-checking real MathLive output against MathCAT's Nemeth
// (September 2026). Fixtures are real MathLive output.
function cleaned(fragment) {
    const root = parseMathMl(fragment);
    const n = cleanUpMathLiveMathml(root);
    return { n, xml: serialize(root) };
}

test('cleanup: "f\'(x)" -- function-application operator moved out of the msup', () => {
    const { xml } = cleaned('<mrow><msup><mi>f</mi><mo>&#x2061;</mo><mi>′</mi></msup><mrow><mo>(</mo><mi>x</mi><mo>)</mo></mrow></mrow>');
    assert.equal(xml, '<mrow><msup><mi>f</mi><mi>′</mi></msup><mo>⁡</mo><mrow><mo>(</mo><mi>x</mi><mo>)</mo></mrow></mrow>');
});

test('cleanup: "x\'^2" -- prime nested as (x′)², not inside the superscript', () => {
    assert.equal(cleaned('<msup><mi>x</mi><mrow><mi>′</mi><mn>2</mn></mrow></msup>').xml,
        '<msup><msup><mi>x</mi><mo>′</mo></msup><mn>2</mn></msup>');
    // a lone prime is already fine and is left alone
    assert.equal(cleaned('<msup><mi>y</mi><mi>′</mi></msup>').n, 0);
});

test('cleanup: "50%" and "∠ABC" -- no invisible times next to % or ∠', () => {
    assert.equal(cleaned('<mrow><mn>50</mn><mo>&#8290;</mo><mi>%</mi></mrow>').xml, '<mrow><mn>50</mn><mo>%</mo></mrow>');
    assert.equal(cleaned('<mrow><mi>∠</mi><mo>&#8290;</mo><mi>A</mi><mo>&#8290;</mo><mi>B</mi></mrow>').xml,
        '<mrow><mo>∠</mo><mi>A</mi><mo>⁢</mo><mi>B</mi></mrow>');
});

test('cleanup: "1,000,000" becomes one number, but "(1,000)" and "1,2,3" do not', () => {
    assert.equal(cleaned('<mrow><mn>1</mn><mo separator="true">,</mo><mn>000</mn><mo separator="true">,</mo><mn>000</mn></mrow>').xml,
        '<mrow><mn>1,000,000</mn></mrow>');
    assert.equal(cleaned('<mrow><mi>x</mi><mo>=</mo><mn>12</mn><mo>,</mo><mn>500</mn></mrow>').xml,
        '<mrow><mi>x</mi><mo>=</mo><mn>12,500</mn></mrow>');
    for (const f of [
        '<mrow><mo>(</mo><mrow><mn>1</mn><mo separator="true">,</mo><mn>000</mn></mrow><mo>)</mo></mrow>',
        '<mrow><mn>1</mn><mo>,</mo><mn>2</mn><mo>,</mo><mn>3</mn></mrow>',
        '<mrow><mn>1</mn><mo>,</mo><mn>000</mn><mo>,</mo><mn>00</mn></mrow>'
    ]) {
        assert.equal(cleaned(f).n, 0, f);
    }
});

test('regression: Speech Rule Engine output after cleanup (primes, %, ∠, grouped numbers)', async () => {
    const require = createRequire(import.meta.url);
    const sre = require('speech-rule-engine');
    const b = (f) => sre.toSpeech(`<math>${cleaned(f).xml}</math>`);
    await sre.setupEngine({ modality: 'braille', locale: 'nemeth' });
    await sre.engineReady();
    assert.equal(b('<mrow><msup><mi>f</mi><mo>&#x2061;</mo><mi>′</mi></msup><mrow><mo>(</mo><mi>x</mi><mo>)</mo></mrow></mrow>'), '⠋⠄⠷⠭⠾');
    assert.equal(b('<msup><mi>x</mi><mrow><mi>′</mi><mn>2</mn></mrow></msup>'), '⠭⠄⠘⠆');
    assert.equal(b('<mrow><mn>50</mn><mo>&#8290;</mo><mi>%</mi></mrow>'), '⠼⠢⠴⠈⠴');
    assert.equal(b('<mrow><mi>∠</mi><mo>&#8290;</mo><mi>A</mi><mo>&#8290;</mo><mi>B</mi><mo>&#8290;</mo><mi>C</mi></mrow>'), '⠫⠪⠀⠠⠁⠠⠃⠠⠉');
    assert.equal(b('<mrow><mn>1</mn><mo separator="true">,</mo><mn>000</mn><mo separator="true">,</mo><mn>000</mn></mrow>'), '⠼⠂⠠⠴⠴⠴⠠⠴⠴⠴');
});

// --- Working around MathLive's exporter (rewriteLatexForExport etc.) ------
//
// The "converted" fixtures are real MathLive.convertLatexToMathMl() output
// for the rewritten LaTeX (September 2026).

test('rewriteLatexForExport rewrites only the commands MathLive exports wrongly', () => {
    const r = rewriteLatexForExport('\\overline{AB}+\\bar{x}');
    assert.equal(r.latex, '\\overset{\\text{mathvoxph0}}{AB}+\\bar{x}');
    assert.equal(r.placeholders[0].ch, '¯');
    assert.equal(r.changed, true);
    assert.equal(rewriteLatexForExport('x^2+\\vec{v}').changed, false);
    // nested, unbraced argument, and a \command argument
    assert.equal(rewriteLatexForExport('\\overline{\\overrightarrow{AB}}').latex,
        '\\overset{\\text{mathvoxph0}}{\\overset{\\text{mathvoxph1}}{AB}}');
    assert.equal(rewriteLatexForExport('\\overline x').latex, '\\overset{\\text{mathvoxph0}}{x}');
    assert.equal(rewriteLatexForExport('\\widehat\\theta').latex, '\\overset{\\text{mathvoxph0}}{\\theta}');
    // braces inside the argument, including escaped ones
    assert.equal(rewriteLatexForExport('\\underline{\\{a\\}}').latex, '\\underset{\\text{mathvoxph0}}{\\{a\\}}');
    // \not and \stackrel
    assert.equal(rewriteLatexForExport('a\\not=b').latex, 'a\\text{mathvoxph0}b');
    assert.equal(rewriteLatexForExport('a\\not\\equiv b').placeholders[0].relation, '≢');
    assert.equal(rewriteLatexForExport('\\stackrel{def}{=}').latex, '\\overset{def}{=}');
    // an unbalanced argument is left for MathLive to deal with
    assert.equal(rewriteLatexForExport('\\overline{AB').changed, false);
});

test('replaceExportPlaceholders: \\overline{AB} -> accent bar over AB (MathCAT: "the line segment from A to B")', () => {
    const { placeholders } = rewriteLatexForExport('\\overline{AB}');
    const root = parseMathMl('<mover ><mrow><mi>A</mi><mo>&#8290;</mo><mi>B</mi></mrow><mtext >mathvoxph0</mtext></mover>');
    assert.equal(cleanUpMathLiveMathml(root, placeholders) > 0, true);
    assert.equal(serialize(root), '<mover accent="true"><mrow><mi>A</mi><mo>⁢</mo><mi>B</mi></mrow><mo>¯</mo></mover>');
    assert.deepEqual(findConversionProblems('\\overline{AB}', root), []);
});

test('replaceExportPlaceholders: arrows are stretchy, not accents', () => {
    const { placeholders } = rewriteLatexForExport('\\overrightarrow{AB}');
    const root = parseMathMl('<mover ><mrow><mi>A</mi><mo>&#8290;</mo><mi>B</mi></mrow><mtext >mathvoxph0</mtext></mover>');
    replaceExportPlaceholders(root, placeholders);
    assert.equal(serialize(root), '<mover><mrow><mi>A</mi><mo>⁢</mo><mi>B</mi></mrow><mo stretchy="true">→</mo></mover>');
});

test('replaceExportPlaceholders: \\underbrace{a+b}_{n} stacks the label under the brace', () => {
    const { placeholders } = rewriteLatexForExport('\\underbrace{a+b}_{n}');
    const root = parseMathMl('<msub><munder ><mrow><mi>a</mi><mo>+</mo><mi>b</mi></mrow><mtext >mathvoxph0</mtext></munder><mi>n</mi></msub>');
    replaceExportPlaceholders(root, placeholders);
    assert.equal(serialize(root),
        '<munder><munder><mrow><mi>a</mi><mo>+</mo><mi>b</mi></mrow><mo stretchy="true">⏟</mo></munder><mi>n</mi></munder>');
});

test('replaceExportPlaceholders: "\\not\\equiv" becomes one relation with no invisible times', () => {
    const { placeholders } = rewriteLatexForExport('a\\not\\equiv b');
    // real MathLive output for "a\\text{mathvoxph0}b"
    const root = parseMathMl('<mrow><mi>a</mi><mtext >mathvoxph0</mtext><mo>&#8290;</mo><mi>b</mi></mrow>');
    replaceExportPlaceholders(root, placeholders);
    assert.equal(serialize(root), '<mrow><mi>a</mi><mo>≢</mo><mi>b</mi></mrow>');
});

test('cleanup: MathLive\'s mtd-less \\binom table becomes a zero-thickness fraction', () => {
    const { xml } = cleaned('<mrow><mo>(</mo><mtable><mtr><mrow><mi>n</mi><mo>+</mo><mn>1</mn></mrow></mtr><mtr><mn>2</mn></mtr></mtable><mo>)</mo></mrow>');
    assert.equal(xml, '<mrow><mo>(</mo><mfrac linethickness="0"><mrow><mi>n</mi><mo>+</mo><mn>1</mn></mrow><mn>2</mn></mfrac><mo>)</mo></mrow>');
    // a real 2x1 column vector (with <mtd>s) is left alone
    assert.equal(cleaned('<mrow><mo>(</mo><mtable><mtr><mtd><mn>1</mn></mtd></mtr><mtr><mtd><mn>2</mn></mtd></mtr></mtable><mo>)</mo></mrow>').n, 0);
});

test('findConversionProblems catches what MathLive\'s exporter loses', () => {
    assert.equal(findConversionProblems('\\overline{x}', parseMathMl('')).length, 1); // empty output
    assert.match(findConversionProblems('\\widehat{AB}',
        parseMathMl('<mover accent="true"><mi>A</mi><mo>undefined</mo></mover>')).join(), /undefined/);
    assert.match(findConversionProblems('\\overgroup{AB}', parseMathMl('<mover >⏠</mover>')).join(), /mover/);
    assert.deepEqual(findConversionProblems('x^2', parseMathMl('<msup><mi>x</mi><mn>2</mn></msup>')), []);
    assert.deepEqual(findConversionProblems('', parseMathMl('')), []);
});

test('cleanup: \\vec{v} uses a spacing arrow SRE can braille', () => {
    assert.equal(cleaned('<mover accent="true"><mi>v</mi><mo>&#x20d7;</mo></mover>').xml,
        '<mover accent="true"><mi>v</mi><mo>\u2192</mo></mover>');
});

test('rewriteLatexForExport: mod, lim sup, \\xrightarrow, \\iff, \\mathcal', () => {
    const r = (l) => rewriteLatexForExport(l).latex;
    assert.equal(r('a\\equiv b\\pmod{n}'), 'a\\equiv b\\left(\\text{mathvoxph0}\\,n\\right)');
    assert.equal(r('a\\bmod b'), 'a\\operatorname{mathvoxph0} b');
    assert.equal(r('\\limsup_{n}a_n'), '\\operatorname{mathvoxph0}_{n}a_n');
    assert.equal(r('\\xrightarrow{f}'), '\\overset{f}{\\text{mathvoxph0}}');
    assert.equal(r('\\xrightarrow[g]{f}'), '\\underset{g}{\\overset{f}{\\text{mathvoxph0}}}');
    assert.equal(r('p\\iff q'), 'p\\Longleftrightarrow q');
    assert.equal(r('\\mathcal{L}'), '\\mathscr{L}');
    // commands that merely start with the same letters are left alone
    assert.equal(r('\\models\\iffy'), '\\models\\iffy');
});

test('placeholders: "lim sup" becomes an operator, \\xrightarrow gets its arrow back', () => {
    let ph = rewriteLatexForExport('\\limsup_{n}a_n').placeholders;
    let root = parseMathMl('<mrow><msub><mi>mathvoxph0</mi><mi>n</mi></msub><msub><mi>a</mi><mi>n</mi></msub></mrow>');
    cleanUpMathLiveMathml(root, ph);
    assert.equal(serialize(root), '<mrow><msub><mo>lim sup</mo><mi>n</mi></msub><msub><mi>a</mi><mi>n</mi></msub></mrow>');

    ph = rewriteLatexForExport('\\xrightarrow{f}').placeholders;
    root = parseMathMl('<mover ><mtext >mathvoxph0</mtext><mi>f</mi><mo>&#x2061;</mo></mover>');
    cleanUpMathLiveMathml(root, ph);
    assert.equal(serialize(root), '<mover><mo stretchy="true">→</mo><mi>f</mi></mover>');
});
