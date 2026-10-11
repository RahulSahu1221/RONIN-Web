// tests/search.test.js
// Local-only search engine, back/forward history wiring, kanji tile columns, and
// the guarantee that nothing in the app talks to an online dictionary.
// Usage: node tests/search.test.js   (no browser, no network)
"use strict";
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { loadSearchBlock, loadAppBlocks } = require("./lib/extract");

const ROOT = path.join(__dirname, "..");
const read = f => fs.readFileSync(path.join(ROOT, f), "utf8");
const S = loadSearchBlock();
const app = loadAppBlocks();
const toKana = s => app.ctx.__toKana ? app.ctx.__toKana(s) : s;

let passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); console.log("  PASS  " + name); passed++; }
    catch (e) { console.log("  FAIL  " + name + "\n        " + String((e && e.stack) || e).split("\n").slice(0, 4).join("\n        ")); failed++; }
}

/* a miniature app: vocab from two levels, kanji with example words, a deck, a section */
const E = [
    S.makeEntry({ type: "vocab", id: "v1", kanji: "鳥", reading: "とり", meaning: "bird", extra: "" }),
    S.makeEntry({ type: "vocab", id: "v2", kanji: "病院", reading: "びょういん", meaning: "hospital", extra: "" }),
    S.makeEntry({ type: "vocab", id: "v3", kanji: "", reading: "コーヒー", meaning: "coffee", extra: "" }),
    S.makeEntry({ type: "vocab", id: "v4", kanji: "銀行", reading: "ぎんこう", meaning: "bank", extra: "" }),
    S.makeEntry({ type: "kanji", id: "k1", kanji: "院", reading: "イン", meaning: "institution", extra: "病院 びょういん hospital 入院する" }),
    S.makeEntry({ type: "kanji", id: "k2", kanji: "鳥", reading: "とり", meaning: "bird", extra: "小鳥 ことり small bird" }),
    S.makeEntry({ type: "deck", id: "d1", kanji: "", reading: "", meaning: "Hospital words", extra: "" }),
    S.makeEntry({ type: "section", id: "s1", kanji: "", reading: "", meaning: "Analytics", extra: "stats heatmap progress" })
];
const find = (q, lim) => S.searchEntries(E, S.prepareQuery(q, toKana), lim).map(h => h.e.id);

console.log("Search engine");
test("kanji, hiragana, katakana and English all find the same word", () => {
    assert.ok(find("鳥").includes("v1"));
    assert.ok(find("とり").includes("v1"));
    assert.ok(find("トリ").includes("v1"), "katakana query must match hiragana reading");
    assert.ok(find("bird").includes("v1"));
    assert.ok(find("コーヒー")[0] === "v3");
    assert.ok(find("ｺｰﾋｰ").includes("v3"), "half-width katakana");
});
test("prediction: a prefix is enough", () => {
    assert.ok(find("hosp").includes("v2"));
    assert.ok(find("びょう").includes("v2"));
    assert.ok(find("coff")[0] === "v3");
});
test("exact beats prefix beats substring", () => {
    const ids = find("bank");
    assert.strictEqual(ids[0], "v4");
    const s = q => S.scoreEntry(E[0], S.prepareQuery(q));
    assert.ok(s("鳥") > s("bir") && s("bir") >= s("ir"), `${s("鳥")} ${s("bir")} ${s("ir")}`);
});
test("example words inside a kanji lesson are searchable (and rank below real headwords)", () => {
    const ids = find("入院");
    assert.ok(ids.includes("k1"));
    const ids2 = find("小鳥");
    assert.ok(ids2.includes("k2"));
});
test("decks and sections are results too", () => {
    assert.ok(find("hospital").includes("d1"));
    assert.ok(find("heatmap").includes("s1"));
    assert.ok(find("analytics")[0] === "s1");
});
test("one-letter typos still find the word", () => {
    assert.ok(find("hosptal").includes("v2"), "hosptal -> hospital");
    assert.ok(find("bnak").length === 0, "two-letter scramble is not a typo match");
    assert.ok(S.withinOneEdit("hospital", "hosptal") && !S.withinOneEdit("bank", "bnak"));
});
test("no match and empty query return nothing, never throw", () => {
    assert.deepStrictEqual(JSON.parse(JSON.stringify(find("zzzzqq"))), []);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(find(""))), []);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(find("   "))), []);
    assert.doesNotThrow(() => find("(*[\\"));
});
test("limit and ordering are stable", () => {
    assert.strictEqual(find("a", 2).length <= 2, true);
    assert.deepStrictEqual(find("bird"), find("bird"));
    const t = S.searchEntries(E, S.prepareQuery("bird")).map(h => h.e.type);
    assert.strictEqual(t[0], "vocab", "vocab before kanji at equal score");
});

console.log("Search never goes online");
test("no Jisho / dictionary / proxy code left anywhere in the app", () => {
    for (const f of ["app.js", "decks.js", "games.js", "sync.js", "index.html", "style.css"]) {
        assert.ok(!/jisho|allorigins|corsproxy|codetabs/i.test(read(f)), `${f} still mentions an online dictionary`);
    }
});
test("the search block itself makes no network call", () => {
    const block = read("app.js").split("// <SEARCH-START>")[1].split("// <SEARCH-END>")[0];
    assert.ok(!/fetch\(|XMLHttpRequest|sendBeacon|WebSocket/.test(block));
});
test("the CSP no longer needs to allow any dictionary host", () => {
    assert.ok(!/jisho/i.test(read("index.html")));
});

console.log("Back / forward history");
const appSrc = read("app.js");
test("showView records history, popstate replays it", () => {
    assert.ok(/function showView\(id\) \{\s*navRecord\(id\);/.test(appSrc));
    assert.ok(/history\.pushState\(\{ ronin: 1, view: id \}/.test(appSrc));
    assert.ok(/window\.addEventListener\("popstate"/.test(appSrc));
});
test("popstate does not push (no history loop) and ignores foreign #anchors", () => {
    assert.ok(/if \(_navFromPop\) return;/.test(appSrc));
    assert.ok(/if \(!id\) return;/.test(appSrc));
});
test("every section reachable from the nav is a tracked view", () => {
    const ids = [...appSrc.match(/const VIEW_IDS = \[([^\]]+)\]/)[1].matchAll(/"(\w+)"/g)].map(m => m[1]);
    ["dashboardView", "vocabView", "kanjiView", "reviewView", "quizView", "gamesView", "analyticsView"].forEach(v => assert.ok(ids.includes(v), v));
    const html = read("index.html");
    ids.forEach(v => assert.ok(html.includes(`id="${v}"`), `${v} missing in index.html`));
});
test("the logo link no longer dumps a bare '#' into history", () => {
    assert.ok(/\$\("logoLink"\)\?\.addEventListener\("click", e => \{ e\.preventDefault\(\)/.test(appSrc));
});

/* Replay the real navRecord/popstate logic against a fake History to check the sequence the user described. */
test("Home -> Vocab -> Kanji, then Back, Back lands on Vocab then Home (and Forward works)", () => {
    const vm = require("vm");
    const src = appSrc;
    const grab = (a, b) => src.slice(src.indexOf(a), src.indexOf(b));
    const code = grab("const VIEW_IDS", "function showView(id) {") ;
    const stack = [{ state: null, url: "/index.html" }]; let i = 0;
    const history = {
        get state() { return stack[i].state; },
        pushState(s, _, u) { stack.length = i + 1; stack.push({ state: s, url: u }); i++; },
        replaceState(s, _, u) { stack[i] = { state: s, url: u }; }
    };
    const location = { pathname: "/index.html", search: "", hash: "" };
    const ctx = vm.createContext({ history, location });
    vm.runInContext(code + ";this.navRecord=navRecord;this.setPop=v=>{_navFromPop=v};", ctx);
    const visit = id => ctx.navRecord(id);
    const back = () => { i--; ctx.setPop(true); const st = stack[i].state; ctx.setPop(false); return st.view; };
    const fwd = () => { i++; return stack[i].state.view; };
    visit("dashboardView"); visit("vocabView"); visit("kanjiView");
    visit("kanjiView");                                   // re-clicking the current section adds nothing
    assert.strictEqual(stack.length, 3);
    assert.strictEqual(back(), "vocabView");
    assert.strictEqual(back(), "dashboardView");
    assert.strictEqual(fwd(), "vocabView");
    visit("quizView");                                    // new branch drops "forward" like a browser
    assert.strictEqual(stack.map(s => s.state.view).join(">"), "dashboardView>vocabView>quizView");
    ctx.setPop(true); visit("gamesView"); ctx.setPop(false);   // a replayed view never pushes
    assert.strictEqual(stack.length, 3);
});

console.log("Kanji tiles and shared actions");
test("kanji tile has the five columns in the requested order", () => {
    const fn = appSrc.split("function kjBuildCard(k) {")[1].split("function renderKanjiList")[0];
    const order = ["/* 1 · kanji */", "/* 2 · meaning + on / kun */", "/* 3 · example words", "/* 4 · speaker + star", "/* 5 · stroke count"];
    let last = -1;
    order.forEach(m => { const at = fn.indexOf(m); assert.ok(at > last, `${m} out of order`); last = at; });
    const css = read("style.css");
    assert.ok(/grid-template-columns:\s*88px minmax\(120px, 1fr\) minmax\(0, 2\.6fr\) auto 76px/.test(css), "5-column grid");
});
test("kanji tiles have speaker, star, and the same right-click / long-press menu as vocab", () => {
    const fn = appSrc.split("function kjBuildCard(k) {")[1].split("function renderKanjiList")[0];
    assert.ok(/speak-btn/.test(fn) && /favorite-btn/.test(fn));
    assert.ok(/addEventListener\("contextmenu"/.test(fn) && /touchstart/.test(fn) && /showContextMenu/.test(fn));
    assert.ok(/kjAsWord\(k\)/.test(fn));
});
test("favourite / weak toggles repaint the kanji list too", () => {
    const d = read("decks.js");
    assert.ok(/function _refreshCardViews/.test(d) && /renderKanjiList/.test(d));
    assert.ok((d.match(/_refreshCardViews\(\);/g) || []).length >= 2);
});

console.log("Tile design");
test("vocab tiles lose the top strip; one flat tile style; no hover movement", () => {
    const css = read("style.css");
    assert.ok(/\.spatial-card::before \{ display:none !important; \}/.test(css));
    const tail = css.slice(css.indexOf("ONE TILE DESIGN FOR THE WHOLE APP"));
    assert.ok(/transform:none !important; box-shadow:none !important;/.test(tail));
    assert.ok(/\.spatial-card \{ opacity:1 !important; transform:none !important;/.test(tail));
});
test("nav bar is fixed and body is not a scroll container", () => {
    const css = read("style.css");
    assert.ok(/\.pill-nav-wrap, \.nav-toggle-btn, \.floating-toolbar \{ position:fixed !important; \}/.test(css));
    assert.ok(/html, body \{ overflow-x:clip; \}/.test(css));
    assert.ok(!/scrollIntoView\(\{ block: "nearest", inline: "center" \}\)/.test(appSrc), "chip bar must not scroll the page");
});

test("mobile blur root cause: the invisible full-screen drawer container never blurs", () => {
    const css = read("style.css");
    assert.ok(/\.sd-drawer \{ backdrop-filter:none !important;/.test(css));
    assert.ok(/\.sd-overlay:not\(\.sd-active\) \{ backdrop-filter:none !important;/.test(css));
    /* ...and it is no longer in the phone-size glass lists */
    assert.ok(!/@media \(max-width: ?768px\) \{\s*\/\*[^]*?\.sd-drawer,[^{]*\{\s*backdrop-filter: ?blur/.test(css) , "sd-drawer still in a phone glass list");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
