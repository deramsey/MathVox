// Braille conformance report: runs the Speech Rule Engine version MathVox
// vendors (5.0.0-rc.3, same as node_modules) over MathCAT's Nemeth test
// suite and lists where the two disagree.
//
// Not part of `npm test` -- SRE and MathCAT are independent Nemeth
// implementations and are expected to differ in places, so this is a
// report for a human to read, not a pass/fail gate. Anything found here
// that matters for MathVox should become a normal regression test in
// pure-logic.test.mjs.
//
// Fixtures: tests/fixtures/mathcat-nemeth.json, extracted from
// https://github.com/daisy/MathCAT (MIT, see tests/fixtures/MathCAT-LICENSE.txt).
//
// Usage: npm run braille-report [-- --all] [-- --grep <text>]
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const sre = require('speech-rule-engine');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'mathcat-nemeth.json'), 'utf8'));

const args = process.argv.slice(2);
const showAll = args.includes('--all');
const grepIdx = args.indexOf('--grep');
const grep = grepIdx !== -1 ? args[grepIdx + 1] : null;

// Differences that are only about blank cells (U+2800 vs. a normal space,
// or doubled blanks) are counted separately from real disagreements.
const squash = (s) => s.replace(/[⠀ ]+/g, ' ').trim();

await sre.setupEngine({ modality: 'braille', locale: 'nemeth' });
await sre.engineReady();

const results = { match: [], spacing: [], differ: [], error: [] };
for (const c of fixtures.cases) {
    if (grep && !c.id.includes(grep) && !c.mathml.includes(grep)) continue;
    let got;
    try {
        got = sre.toSpeech(c.mathml);
    } catch (err) {
        results.error.push({ ...c, got: String(err && err.message || err) });
        continue;
    }
    if (got === c.expected) results.match.push(c);
    else if (squash(got) === squash(c.expected)) results.spacing.push({ ...c, got });
    else results.differ.push({ ...c, got });
}

const total = Object.values(results).reduce((n, list) => n + list.length, 0);
console.log(`MathCAT Nemeth suite vs. Speech Rule Engine ${sre.version || ''} (${total} cases)`);
console.log(`  exact match:         ${results.match.length}`);
console.log(`  blank-cell only:     ${results.spacing.length}`);
console.log(`  different braille:   ${results.differ.length}`);
console.log(`  SRE error:           ${results.error.length}`);

const bySource = {};
for (const c of results.differ) {
    const file = c.id.split('::')[0];
    bySource[file] = (bySource[file] || 0) + 1;
}
console.log('\nDifferent braille, by MathCAT test file:', bySource);

const list = showAll ? results.differ : results.differ.slice(0, 25);
console.log(`\n${showAll ? 'All' : 'First 25'} differences (use --all for everything):`);
for (const c of list) {
    console.log(`\n${c.id}\n  mathml:   ${c.mathml.replace(/\s+/g, ' ').slice(0, 220)}\n  MathCAT:  ${c.expected}\n  SRE:      ${c.got}`);
}
for (const c of results.error) console.log(`\nERROR ${c.id}: ${c.got}`);
