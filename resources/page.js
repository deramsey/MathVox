// Shared by the info pages (help.html, privacy.html): applies the same
// saved Dark Mode / Dyslexia-Friendly Font preferences as the main app and
// wires up their toggles. Kept separate from script.js so these pages don't
// load MathLive, Speech Rule Engine or MathJax. Same storage keys and
// behavior as setTheme()/setDyslexiaFont() in script.js.
function storageGet(key) {
    try { return localStorage.getItem(key); } catch (err) { return null; }
}
function storageSet(key, value) {
    try { localStorage.setItem(key, value); } catch (err) { /* no storage: preference lasts this visit */ }
}

const themeToggle = document.querySelector('#theme-toggle');
const dyslexiaToggle = document.querySelector('#dyslexia-toggle');

function setTheme(dark, save) {
    document.documentElement.classList.toggle('theme-dark', dark);
    themeToggle.setAttribute('aria-pressed', String(dark));
    if (save) storageSet('mathvox-theme', dark ? 'dark' : 'light');
}

function setDyslexiaFont(on, save) {
    document.documentElement.classList.toggle('dyslexia-font', on);
    dyslexiaToggle.setAttribute('aria-pressed', String(on));
    if (save) storageSet('mathvox-dyslexia-font', on ? 'on' : 'off');
}

const savedTheme = storageGet('mathvox-theme');
const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
setTheme(savedTheme ? savedTheme === 'dark' : prefersDark, false);
setDyslexiaFont(storageGet('mathvox-dyslexia-font') === 'on', false);

themeToggle.addEventListener('click', () => setTheme(!document.documentElement.classList.contains('theme-dark'), true));
dyslexiaToggle.addEventListener('click', () => setDyslexiaFont(!document.documentElement.classList.contains('dyslexia-font'), true));
