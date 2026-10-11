// tests/structure.test.js
// Level structure, lesson/kanji file paths, kanji file parsing, start position,
// the data-folder checker, and the service worker's handling of data/*.json.
// Usage: node tests/structure.test.js   (no browser, no network)
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const { loadAppBlocks } = require("./lib/extract");
const { checkData } = require("./data-check");

const ROOT = path.join(__dirname, "..");
const api = loadAppBlocks();
const J = x => JSON.parse(JSON.stringify(x));          // vm objects have a different prototype; compare plain copies
const fixture = n => JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", `kanji-L${n}.json`), "utf8"));

let passed = 0, failed = 0;
async function test(name, fn) {
    try { await fn(); console.log("  PASS  " + name); passed++; }
    catch (e) { console.log("  FAIL  " + name + "\n        " + String((e && e.stack) || e).split("\n").slice(0, 4).join("\n        ")); failed++; }
}

(async () => {
    console.log("Level structure and file paths");

    await test("N5 = lessons 1-25, N4 = 26-50, N3 = 1-12, N2 = 13-24", () => {
        const r = k => [api.LEVELS[k].from, api.LEVELS[k].to];
        assert.deepStrictEqual(J([r("n5"), r("n4"), r("n3"), r("n2")]), [[1, 25], [26, 50], [1, 12], [13, 24]]);
    });
    await test("N5/N4 lesson files are lowercase, N3/N2 are capital L", () => {
        assert.strictEqual(api.lessonUrl("n5", 1), "data/n5/lesson1.json");
        assert.strictEqual(api.lessonUrl("n5", 25), "data/n5/lesson25.json");
        assert.strictEqual(api.lessonUrl("n4", 26), "data/n4/lesson26.json");
        assert.strictEqual(api.lessonUrl("n4", 50), "data/n4/lesson50.json");
        assert.strictEqual(api.lessonUrl("n3", 1), "data/n3/Lesson1.json");
        assert.strictEqual(api.lessonUrl("n3", 12), "data/n3/Lesson12.json");
        assert.strictEqual(api.lessonUrl("n2", 13), "data/n2/Lesson13.json");
        assert.strictEqual(api.lessonUrl("n2", 24), "data/n2/Lesson24.json");
    });
    await test("kanji files: N5 L1-L7 in data/n5, N4 L8-L26 in data/n4", () => {
        assert.strictEqual(api.kanjiUrl("n5", 1), "data/n5/kanji-L1.json");
        assert.strictEqual(api.kanjiUrl("n5", 7), "data/n5/kanji-L7.json");
        assert.strictEqual(api.kanjiUrl("n4", 8), "data/n4/kanji-L8.json");
        assert.strictEqual(api.kanjiUrl("n4", 26), "data/n4/kanji-L26.json");
        assert.ok(api.isValidKanjiLesson("n5", 7) && !api.isValidKanjiLesson("n5", 8));
        assert.ok(api.isValidKanjiLesson("n4", 8) && api.isValidKanjiLesson("n4", 26) && !api.isValidKanjiLesson("n4", 7) && !api.isValidKanjiLesson("n4", 27));
        assert.ok(!api.isValidKanjiLesson("n3", 1) && !api.isValidKanjiLesson("n2", 13), "no kanji files for N3/N2 yet");
    });
    await test("lesson ranges are enforced per level (the old N3 = 51-75 is gone)", () => {
        assert.ok(api.isValidLesson("n3", 1) && api.isValidLesson("n3", 12));
        assert.ok(!api.isValidLesson("n3", 0) && !api.isValidLesson("n3", 13) && !api.isValidLesson("n3", 51));
        assert.ok(api.isValidLesson("n2", 13) && api.isValidLesson("n2", 24) && !api.isValidLesson("n2", 12) && !api.isValidLesson("n2", 25) && !api.isValidLesson("n2", 76));
        assert.ok(!api.isValidLesson("n5", 26) && !api.isValidLesson("n4", 25));
        assert.ok(!api.isValidLesson("n5", 1.5) && !api.isValidLesson("n5", NaN));
    });
    await test("levelKey tolerates junk and falls back to N5", () => {
        assert.strictEqual(api.levelKey("N3"), "n3");
        assert.strictEqual(api.levelKey(" n2 "), "n2");
        assert.strictEqual(api.levelKey("N9"), "n5");
        assert.strictEqual(api.levelKey(undefined), "n5");
    });
    await test("every URL the app builds exists in a tree named by your rules (independent of the app's helpers)", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ronin-tree-"));
        const put = (rel, obj) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), JSON.stringify(obj)); };
        const vocab = [{ kanji: "私", hiragana: "わたし", meaning: "I" }];
        for (let n = 1; n <= 25; n++) put(`data/n5/lesson${n}.json`, vocab);      // rules written out by hand
        for (let n = 26; n <= 50; n++) put(`data/n4/lesson${n}.json`, vocab);
        for (let n = 1; n <= 12; n++) put(`data/n3/Lesson${n}.json`, vocab);
        for (let n = 13; n <= 24; n++) put(`data/n2/Lesson${n}.json`, vocab);
        for (let n = 1; n <= 7; n++) put(`data/n5/kanji-L${n}.json`, Object.assign(fixture(6), { lesson: n }));
        for (let n = 8; n <= 26; n++) put(`data/n4/kanji-L${n}.json`, Object.assign(fixture(19), { lesson: n }));
        const missing = [];
        for (const k of ["n5", "n4", "n3", "n2"]) {
            for (let n = api.LEVELS[k].from; n <= api.LEVELS[k].to; n++) if (!fs.existsSync(path.join(dir, api.lessonUrl(k, n)))) missing.push(api.lessonUrl(k, n));
            const K = api.LEVELS[k].kanji;
            if (K) for (let n = K.from; n <= K.to; n++) if (!fs.existsSync(path.join(dir, api.kanjiUrl(k, n)))) missing.push(api.kanjiUrl(k, n));
        }
        assert.deepStrictEqual(missing, []);
        const res = checkData(path.join(dir, "data"), api);
        assert.deepStrictEqual(res.errors, [], "a correct tree must produce no errors");
        fs.rmSync(dir, { recursive: true, force: true });
    });

    console.log("Start position (which level + lesson opens)");
    const setPos = (num, lastLevel) => { api.ctx.store = { get: (k, fb) => (k === "jlpt_lastLesson" ? num : fb) }; api.ctx.userProfile = lastLevel ? { lastLevel } : {}; return J(api.resolveStartPosition()); };
    await test("saved level is honoured, so N3 Lesson 5 does not turn into N5 Lesson 5", () => {
        assert.deepStrictEqual(setPos(5, "n3"), { level: "n3", num: 5 });
        assert.deepStrictEqual(setPos(15, "n2"), { level: "n2", num: 15 });
        assert.deepStrictEqual(setPos(30, "n4"), { level: "n4", num: 30 });
    });
    await test("old progress with no saved level still opens correctly", () => {
        assert.deepStrictEqual(setPos(7, null), { level: "n5", num: 7 });
        assert.deepStrictEqual(setPos(30, null), { level: "n4", num: 30 });
    });
    await test("a saved level that does not contain the lesson is ignored, not trusted", () => {
        assert.deepStrictEqual(setPos(30, "n3"), { level: "n4", num: 30 });   // N3 only has 1-12
        assert.deepStrictEqual(setPos(5, "n2"), { level: "n5", num: 5 });     // N2 starts at 13
    });
    await test("garbage progress falls back to N5 lesson 1", () => {
        assert.deepStrictEqual(setPos("abc", undefined), { level: "n5", num: 1 });
        assert.deepStrictEqual(setPos("abc", "n3"), { level: "n3", num: 1 });   // lesson 1 exists in N3, so a saved N3 is kept
        assert.deepStrictEqual(setPos(999, "n5"), { level: "n5", num: 1 });
    });

    console.log("Kanji file format (your real kanji-L6 / kanji-L19)");
    await test("kanji-L19.json parses: 9 kanji, readings, examples, related words", () => {
        const d = J(api.normalizeKanjiFile(fixture(19), 19));
        assert.strictEqual(d.lesson, 19);
        assert.strictEqual(d.title, "おぼえましょう");
        assert.strictEqual(d.subtitle, "ことばを つくる 漢字");
        assert.strictEqual(d.subtitleMeaning, "Kanji used to form words");
        assert.strictEqual(d.kanji.length, 9);
        const ni = d.kanji.find(k => k.char === "内");
        assert.deepStrictEqual([ni.onyomi, ni.kunyomi, ni.strokes, ni.examples.length], [["ナイ"], ["うち"], 4, 4]);
        assert.deepStrictEqual(ni.related, [{ word: "外側", reading: "そとがわ", meaning: "", relation: "opposite" }]);
        const du = d.kanji.find(k => k.char === "度");
        assert.deepStrictEqual(du.onyomi, ["ド", "タク"], "two on-yomi kept");
        const fuku = d.kanji.find(k => k.char === "服");
        assert.strictEqual(fuku.related.length, 2);
        assert.strictEqual(fuku.related[0].relation, "", "missing relation becomes an empty string");
    });
    await test("kanji-L6.json parses: 17 kanji, kun-only and on-only kanji both fine", () => {
        const d = J(api.normalizeKanjiFile(fixture(6), 6));
        assert.strictEqual(d.kanji.length, 17);
        const hana = d.kanji.find(k => k.char === "花");
        assert.deepStrictEqual([hana.onyomi, hana.kunyomi], [["カ"], ["はな"]]);
        const mimi = d.kanji.find(k => k.char === "耳");
        assert.deepStrictEqual([mimi.onyomi, mimi.kunyomi], [[], ["みみ"]]);
        const ashi = d.kanji.find(k => k.char === "足");
        assert.deepStrictEqual(ashi.kunyomi, ["あし", "た（-りる / -す）"]);
        assert.ok(d.kanji.every(k => k.strokes > 0 && k.examples.length > 0));
    });
    await test("blank meanings are kept as empty strings (the card then simply hides them)", () => {
        assert.ok(J(api.normalizeKanjiFile(fixture(6), 6)).kanji.every(k => k.meaning === ""));
    });
    await test("bad input is tolerated or rejected with a readable reason", () => {
        assert.strictEqual(J(api.normalizeKanjiFile([{ char: "山", onyomi: "サン", kunyomi: null, strokes: "3" }], 9)).kanji[0].onyomi[0], "サン");
        assert.strictEqual(api.normalizeKanjiFile([{ char: "山", strokes: "3" }], 9).kanji[0].strokes, 3);
        assert.strictEqual(api.normalizeKanjiFile({ kanji: [{ meaning: "no char" }, null, { char: "川" }] }, 4).kanji.length, 1, "entries without a char are dropped");
        assert.strictEqual(api.normalizeKanjiFile({ kanji: [] }, 4).lesson, 4, "lesson falls back to the number from the file name");
        assert.throws(() => api.normalizeKanjiFile({ lesson: 3 }, 3), /no "kanji" list/);
        assert.throws(() => api.normalizeKanjiFile("nope", 3), /no "kanji" list/);
        assert.throws(() => api.normalizeKanjiFile(null, 3), /no "kanji" list/);
    });

    console.log("Data folder checker (reproduces the mistakes visible in your screenshot)");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ronin-data-"));
    const put = (rel, content) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof content === "string" ? content : JSON.stringify(content)); };
    const vocab = [{ kanji: "私", hiragana: "わたし", meaning: "I" }];
    put("n5/lesson1.json", vocab);
    put("n5/Lesson3.json", vocab);                                                   // wrong case for N5
    put("n5/kanji-L6.json", fixture(6));
    put("n5/kanji-L7.json", fixture(19));                                            // says lesson 19, file says 7
    put("n4/kanji-L19.json", fixture(19));
    put("n4/kanji-L22json", fixture(19));                                            // missing dot
    put("n4/kanji-L23son", fixture(19));                                             // missing dot and j
    put("n4/kanji-L24.json", "{ not json");
    put("n4/lesson26.json", vocab);
    put("n4/lesson27.json", []);
    put("n4/lesson99.json", vocab);                                                  // outside N4's 26-50
    put("n3/lesson1.json", vocab);                                                   // should be Lesson1.json
    put("n3/Lesson2.json", vocab);
    put("n2/Lesson13.json", vocab);
    const res = checkData(dir, api);
    const has = (list, re) => list.some(m => re.test(m));
    await test("wrong letter case is an error (works on Windows, breaks on a web server)", () => {
        assert.ok(has(res.errors, /N5: found "Lesson3\.json" but the app looks for "lesson3\.json"/));
        assert.ok(has(res.errors, /N3: found "lesson1\.json" but the app looks for "Lesson1\.json"/));
    });
    await test('missing dot is caught and the fix is suggested ("kanji-L22json" -> kanji-L22.json)', () => {
        assert.ok(has(res.errors, /"kanji-L22json".*Did you mean "kanji-L22\.json"/));
        assert.ok(has(res.errors, /"kanji-L23son".*Did you mean "kanji-L23\.json"/));
    });
    await test("invalid JSON, empty lesson, and a lesson-number mismatch are errors", () => {
        assert.ok(has(res.errors, /kanji-L24\.json is not valid JSON/));
        assert.ok(has(res.errors, /lesson27\.json contains no words/));
        assert.ok(has(res.errors, /kanji-L7\.json: "lesson" is 19 but the file name says 7/));
    });
    await test("good files are reported OK and are not flagged", () => {
        assert.ok(has(res.ok, /N5: 1 kanji file OK/) && has(res.ok, /N4: 1 kanji file OK/));
        assert.ok(!has(res.errors, /kanji-L6\.json|kanji-L19\.json|Lesson2\.json|Lesson13\.json|lesson26\.json/));
    });
    await test("out-of-range files and missing N1 are warnings, not errors", () => {
        assert.ok(has(res.warnings, /lesson99\.json" is outside the lesson range for N4/));
        assert.ok(has(res.warnings, /N1: folder data\/n1\/ does not exist/));
        assert.ok(!has(res.errors, /lesson99|N1/));
    });
    fs.rmSync(dir, { recursive: true, force: true });

    console.log("Service worker: data/*.json is network-first at any depth and letter case");
    const swSrc = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");
    function makeCaches() {
        const stores = new Map();
        const get = n => { if (!stores.has(n)) stores.set(n, new Map()); return stores.get(n); };
        const key = r => (typeof r === "string" ? r : r.url);
        return {
            stores,
            open: async n => ({ put: async (r, res) => { get(n).set(key(r), res); }, add: async () => {}, match: async r => get(n).get(key(r)) }),
            keys: async () => [...stores.keys()],
            delete: async n => stores.delete(n),
            match: async (r, o) => (o && o.cacheName ? get(o.cacheName).get(key(r)) : undefined)
        };
    }
    function bootSw(fetchImpl) {
        const listeners = {};
        const caches = makeCaches();
        const sandbox = {
            self: { addEventListener: (t, f) => { listeners[t] = f; }, location: { origin: "https://ronin.test" }, skipWaiting: () => {}, clients: { claim: async () => {} }, registration: {} },
            caches, fetch: fetchImpl, Response, URL, Promise, JSON, console: { warn() {}, log() {}, error() {} }, clients: {}
        };
        vm.createContext(sandbox);
        vm.runInContext(swSrc, sandbox);
        const names = vm.runInContext("({ lessons: CACHE_LESSONS, statics: CACHE_STATIC })", sandbox);
        const run = async url => {
            let p; listeners.fetch({ request: { method: "GET", url, mode: "cors" }, respondWith: x => { p = x; } });
            return p ? await p : null;
        };
        return { run, caches, names };
    }
    const U = p => "https://ronin.test/" + p;
    const body = async r => (r ? r.text() : null);

    for (const p of ["data/n5/lesson1.json", "data/n3/Lesson4.json", "data/n2/Lesson13.json", "data/n4/kanji-L19.json"]) {
        await test(`${p}: fresh copy wins over a stale cached one, and is re-cached`, async () => {
            const sw = bootSw(async () => new Response("NEW", { status: 200 }));
            (await sw.caches.open(sw.names.lessons)).put(U(p), new Response("OLD"));
            assert.strictEqual(await body(await sw.run(U(p))), "NEW");
            assert.strictEqual(await body(sw.caches.stores.get(sw.names.lessons).get(U(p)).clone()), "NEW");
        });
    }
    await test("offline: a previously opened lesson is served from the cache", async () => {
        const sw = bootSw(async () => { throw new Error("offline"); });
        (await sw.caches.open(sw.names.lessons)).put(U("data/n3/Lesson1.json"), new Response("CACHED"));
        assert.strictEqual(await body(await sw.run(U("data/n3/Lesson1.json"))), "CACHED");
    });
    await test("offline and never opened: a clear JSON error (503), not a crash", async () => {
        const sw = bootSw(async () => { throw new Error("offline"); });
        const r = await sw.run(U("data/n4/kanji-L20.json"));
        assert.strictEqual(r.status, 503);
        assert.strictEqual(JSON.parse(await r.text()).error, "offline");
    });
    await test("a 404 (typo'd or missing file) is passed through and never cached", async () => {
        const sw = bootSw(async () => new Response("nf", { status: 404 }));
        const r = await sw.run(U("data/n4/kanji-L22json"));
        assert.strictEqual(r.status, 404);
        assert.ok(!sw.caches.stores.get(sw.names.lessons) || !sw.caches.stores.get(sw.names.lessons).has(U("data/n4/kanji-L22json")));
    });
    await test("app files and images in data/assets stay cache-first (offline shell unaffected)", async () => {
        const sw = bootSw(async () => new Response("NETWORK"));
        (await sw.caches.open(sw.names.statics)).put(U("style.min.css"), new Response("CACHED-CSS"));
        (await sw.caches.open(sw.names.statics)).put(U("data/assets/logo.png"), new Response("CACHED-PNG"));
        assert.strictEqual(await body(await sw.run(U("style.min.css"))), "CACHED-CSS");
        assert.strictEqual(await body(await sw.run(U("data/assets/logo.png"))), "CACHED-PNG");
    });

    console.log("\n" + passed + " passed, " + failed + " failed");
    process.exit(failed ? 1 : 0);
})();
