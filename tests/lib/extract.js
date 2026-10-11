// tests/lib/extract.js
// Pulls the marked, self-contained blocks out of app.js (so tests exercise the real
// shipped code, not a copy) and runs them in an isolated vm context.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const APP = path.join(__dirname, "..", "..", "app.js");

function extractBlock(name, file) {
    const src = fs.readFileSync(file || APP, "utf8");
    const a = src.indexOf(`// <${name}-START>`);
    const b = src.indexOf(`// <${name}-END>`);
    if (a < 0 || b < 0 || b < a) throw new Error(`marker block ${name} not found in ${file || APP}`);
    return src.slice(a, b);
}

/* Returns { LEVELS, levelKey, ..., normalizeKanjiFile, resolveStartPosition, ctx } from app.js.
   `ctx.store` / `ctx.userProfile` are the stand-ins resolveStartPosition reads; tests assign to them. */
function loadAppBlocks() {
    const code = extractBlock("LEVELS") + "\n" + extractBlock("KANJI") + "\n" + extractBlock("STARTPOS") +
        "\n;__exports = { LEVELS, LEVEL_ORDER, levelKey, isValidLesson, isValidKanjiLesson, lessonUrl, kanjiUrl, levelForLesson, normalizeKanjiFile, resolveStartPosition };";
    const ctx = vm.createContext({ __exports: null, userProfile: {}, store: { get: (k, fb) => fb } });
    vm.runInContext(code, ctx, { filename: "app.js (extracted blocks)" });
    return Object.assign({}, ctx.__exports, { ctx });
}

/* The pure search engine (SEARCH block): scoring, ranking, typo tolerance. */
function loadSearchBlock() {
    const code = extractBlock("SEARCH") + "\n;__exports = { srchNorm, prepareQuery, makeEntry, scoreEntry, searchEntries, withinOneEdit };";
    const ctx = vm.createContext({ __exports: null });
    vm.runInContext(code, ctx, { filename: "app.js (SEARCH block)" });
    return ctx.__exports;
}

module.exports = { extractBlock, loadAppBlocks, loadSearchBlock };
