// tests/sync.test.js
// Runs sync.js against a fake Supabase and two simulated devices.
// Usage: node tests/sync.test.js   (no dependencies, no network)
"use strict";
const vm = require("vm");
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const SYNC_FILE = process.env.SYNC_FILE || "sync.js";   // SYNC_FILE=sync.min.js tests the shipped build
const SYNC_SRC = fs.readFileSync(path.join(__dirname, "..", SYNC_FILE), "utf8");

/* ── Fake cloud (one table, keyed by user_id) ─────────────────────────── */
function makeCloud() {
    const rows = new Map();
    const cloud = { rows, beforeUpdate: null, calls: { full: 0, head: 0, insert: 0, update: 0 } };

    function builder(table) {
        const st = { op: "select", cols: "*", filters: [], payload: null, single: false };
        const b = {
            select(cols) { st.cols = cols || "*"; return b; },
            insert(obj) { st.op = "insert"; st.payload = obj; return b; },
            update(obj) { st.op = "update"; st.payload = obj; return b; },
            eq(k, v) { st.filters.push([k, v]); return b; },
            maybeSingle() { st.single = true; return b; },
            then(res, rej) { return Promise.resolve(run()).then(res, rej); }
        };
        function pick(row) {
            if (st.cols === "*") return JSON.parse(JSON.stringify(row));
            const o = {}; st.cols.split(",").forEach(c => { o[c.trim()] = row[c.trim()]; }); return o;
        }
        function run() {
            const uid = (st.filters.find(f => f[0] === "user_id") || [])[1];
            if (st.op === "select") {
                const row = rows.get(uid);
                if (st.cols === "*") cloud.calls.full++; else cloud.calls.head++;
                return { data: row ? pick(row) : null, error: null };
            }
            if (st.op === "insert") {
                cloud.calls.insert++;
                const id = st.payload.user_id;
                if (rows.has(id)) return { data: null, error: { code: "23505", message: "duplicate" } };
                rows.set(id, JSON.parse(JSON.stringify(st.payload)));
                return { data: pick(rows.get(id)), error: null };
            }
            if (st.op === "update") {
                cloud.calls.update++;
                if (cloud.beforeUpdate) { const f = cloud.beforeUpdate; cloud.beforeUpdate = null; f(); }
                const row = rows.get(uid);
                const revF = (st.filters.find(f => f[0] === "rev") || [])[1];
                if (!row || (revF !== undefined && row.rev !== revF)) return { data: [], error: null };
                Object.assign(row, JSON.parse(JSON.stringify(st.payload)));
                return { data: [pick(row)], error: null };
            }
        }
        return b;
    }
    cloud.client = {
        from: builder,
        auth: {
            _cb: null, signedOut: 0,
            onAuthStateChange(cb) { this._cb = cb; },
            async signOut() { this.signedOut++; return { error: null }; }
        }
    };
    return cloud;
}

/* ── One "page load" of one device. Shares localStorage across reloads. ── */
function boot(storage, cloud, opts) {
    opts = opts || {};
    const timers = []; let tid = 0;
    const ctx = { reloads: 0, toasts: [], confirms: [], timers };
    const ls = {
        getItem: k => (storage.has(k) ? storage.get(k) : null),
        setItem: (k, v) => storage.set(k, String(v)),
        removeItem: k => storage.delete(k),
        key: i => Array.from(storage.keys())[i] || null,
        get length() { return storage.size; }
    };
    const win = {};
    const sandbox = {
        window: win, localStorage: ls, sessionStorage: opts.session || { getItem: () => null, setItem: () => {} },
        navigator: { get onLine() { return ctx.online !== false; } },
        document: { getElementById: () => null, addEventListener: () => {}, readyState: "complete", visibilityState: "visible" },
        location: { reload: () => { ctx.reloads++; }, origin: "https://x", pathname: "/" },
        supabase: { createClient: () => cloud.client },
        confirm: msg => { ctx.confirms.push(msg); return opts.confirmAnswer !== false; },
        prompt: () => null,
        showToast: (m, t) => ctx.toasts.push(m),
        setTimeout: (fn, ms) => { timers.push({ id: ++tid, fn, ms }); return tid; },
        clearTimeout: id => { const i = timers.findIndex(t => t.id === id); if (i >= 0) timers.splice(i, 1); },
        console: { warn() {}, log() {}, error() {} },
        Math, JSON, Object, Array, Set, Map, Date, Number, String, Promise
    };
    sandbox.addEventListener = () => {};
    win.addEventListener = () => {};
    Object.assign(win, { localStorage: ls });
    /* The app's store wrapper, as in app.js */
    sandbox.store = {
        set(key, val) { try { ls.setItem(key, JSON.stringify(val)); return true; } catch (_) { return false; } },
        get(key, fb) { const r = ls.getItem(key); return r === null ? fb : JSON.parse(r); }
    };
    vm.createContext(sandbox);
    vm.runInContext(SYNC_SRC, sandbox);
    ctx.sandbox = sandbox;
    ctx.sync = sandbox.window.RoninSync;
    ctx.logic = sandbox.window.RoninSyncLogic;
    ctx.signIn = async uid => {
        cloud.client.auth._cb("SIGNED_IN", { user: { id: uid, email: uid + "@t.dev" } });
        await flush(ctx);
    };
    ctx.sets = (k, v) => sandbox.store.set(k, v);
    ctx.state = () => ({
        xp: storage.has("jlpt_xp") ? JSON.parse(storage.get("jlpt_xp")) : 0,
        profile: storage.has("jlpt_profile") ? JSON.parse(storage.get("jlpt_profile")) : {},
        srs: storage.has("jlpt_srs") ? JSON.parse(storage.get("jlpt_srs")) : {},
        decks: storage.has("jlpt_decks") ? JSON.parse(storage.get("jlpt_decks")) : []
    });
    return ctx;
}
const tick = () => new Promise(r => setImmediate(r));
async function flush(ctx) {
    for (let i = 0; i < 30; i++) {
        await tick();
        const t = ctx.timers.splice(0);
        for (const x of t) { await x.fn(); }
        await tick();
        if (!ctx.timers.length) { await tick(); if (!ctx.timers.length) break; }
    }
}

let passed = 0, failed = 0;
async function test(name, fn) {
    try { await fn(); console.log("  PASS  " + name); passed++; }
    catch (e) { console.log("  FAIL  " + name + "\n        " + (e && e.stack || e).split("\n").slice(0, 4).join("\n        ")); failed++; }
}

(async () => {
    console.log("Pure logic");
    const L = boot(new Map(), makeCloud()).logic;

    await test("hash ignores object key order", () => {
        assert.strictEqual(L.hashState({ profile: { a: 1, b: 2 }, xp: 5 }), L.hashState({ profile: { b: 2, a: 1 }, xp: 5 }));
    });
    await test("hash changes when data changes", () => {
        assert.notStrictEqual(L.hashState({ xp: 5 }), L.hashState({ xp: 6 }));
    });
    await test("srs-only entries do not count as progress", () => {
        assert.strictEqual(L.hasProgress({ srs: { w1: { repetition: 0 } } }), false);
        assert.strictEqual(L.hasProgress({ xp: 1 }), true);
        assert.strictEqual(L.hasProgress({ profile: { learned: ["x"] } }), true);
    });
    await test("normalizeState survives garbage", () => {
        const s = L.normalizeState({ profile: "bad", srs: [], xp: "12.7", lastLesson: 0, decks: {}, heatmap: null });
        assert.deepStrictEqual([s.xp, s.lastLesson, Array.isArray(s.decks)], [13, 1, true]);
    });
    await test("merge: union lists, max xp/bestStreak, best srs, decks by id, heatmap max", () => {
        const a = { xp: 90, profile: { learned: ["a", "b"], weak: ["w"], bestStreak: 5, lastActive: 2, streak: 3 },
            srs: { a: { repetition: 3, interval: 6, dueDate: 10 }, b: { repetition: 1, interval: 1, dueDate: 5 } },
            decks: [{ id: "d1", words: [1, 2] }], heatmap: { d1: 4, d2: 1 }, lastLesson: 4 };
        const b = { xp: 85, profile: { learned: ["a", "c"], weak: [], bestStreak: 9, lastActive: 1, streak: 1 },
            srs: { a: { repetition: 1, interval: 1, dueDate: 3 }, c: { repetition: 2, interval: 3, dueDate: 8 } },
            decks: [{ id: "d1", words: [1] }, { id: "d2", words: [9] }], heatmap: { d1: 2, d3: 7 }, lastLesson: 2 };
        const m = JSON.parse(JSON.stringify(L.mergeStates(a, b)));   // JSON round-trip: sandbox arrays have a different prototype
        assert.deepStrictEqual(m.profile.learned.slice().sort(), ["a", "b", "c"]);
        assert.deepStrictEqual(m.profile.weak, ["w"]);
        assert.strictEqual(m.xp, 90);
        assert.strictEqual(m.profile.bestStreak, 9);
        assert.strictEqual(m.profile.streak, 3, "newer side's streak wins");
        assert.strictEqual(m.srs.a.repetition, 3);
        assert.ok(m.srs.b && m.srs.c);
        assert.strictEqual(m.decks.length, 2);
        assert.strictEqual(m.decks.find(d => d.id === "d1").words.length, 2);
        assert.deepStrictEqual(m.heatmap, { d1: 4, d2: 1, d3: 7 });
        assert.strictEqual(m.lastLesson, 4);
    });
    await test("merge is symmetric for progress totals", () => {
        const a = { xp: 10, profile: { learned: ["x"], lastActive: 1 } };
        const b = { xp: 20, profile: { learned: ["y"], lastActive: 2 } };
        const ab = JSON.parse(JSON.stringify(L.mergeStates(a, b))), ba = JSON.parse(JSON.stringify(L.mergeStates(b, a)));
        assert.strictEqual(ab.xp, ba.xp);
        assert.deepStrictEqual(ab.profile.learned.slice().sort(), ba.profile.learned.slice().sort());
    });
    await test("friendly error messages", () => {
        assert.ok(/Wrong email or password/.test(L.friendlyAuthError({ message: "Invalid login credentials" })));
        assert.ok(/confirm your email/.test(L.friendlyAuthError({ message: "Email not confirmed" })));
        assert.ok(/already has an account/.test(L.friendlyAuthError({ message: "User already registered" })));
        assert.ok(/Something went wrong/.test(L.friendlyAuthError({ message: "weird" })));
    });

    console.log("Sync engine (two devices, one cloud)");
    const cloud = makeCloud();
    const storeA = new Map(), storeB = new Map();
    const UID = "user-1";

    let A = boot(storeA, cloud);
    await A.signIn(UID);

    await test("fresh device with nothing to sync creates no cloud row", () => {
        assert.strictEqual(cloud.rows.size, 0);
    });

    await test("progress on device A is pushed (debounced) to the cloud", async () => {
        A.sets("jlpt_xp", 50);
        A.sets("jlpt_profile", { learned: ["a"], favorites: [], weak: [], achievements: [], bestStreak: 1, lastActive: 1 });
        assert.ok(A.timers.length > 0, "store.set should schedule a push");
        await flush(A);
        const row = cloud.rows.get(UID);
        assert.ok(row, "row created");
        assert.strictEqual(row.xp, 50);
        assert.strictEqual(row.rev, 1);
    });

    let B = boot(storeB, cloud);
    await B.signIn(UID);
    await test("fresh device B pulls A's progress and reloads once", () => {
        assert.strictEqual(B.state().xp, 50);
        assert.strictEqual(B.reloads, 1);
    });

    await test("after the reload, B is up to date and does NOT reload again", async () => {
        B = boot(storeB, cloud);
        await B.signIn(UID);
        assert.strictEqual(B.reloads, 0);
    });

    await test("B's change reaches A (A had no local edits)", async () => {
        B.sets("jlpt_xp", 80);
        await flush(B);
        assert.strictEqual(cloud.rows.get(UID).xp, 80);
        A = boot(storeA, cloud);
        await A.signIn(UID);
        assert.strictEqual(A.state().xp, 80);
        assert.strictEqual(A.reloads, 1);
        A = boot(storeA, cloud);
        await A.signIn(UID);
        assert.strictEqual(A.reloads, 0, "no reload loop");
    });

    await test("unchanged state makes only a tiny revision query, not a full download", async () => {
        const before = cloud.calls.full;
        await A.sync.syncNow();
        await A.sync.syncNow();
        assert.strictEqual(cloud.calls.full, before, "no full-row fetch when nothing changed");
    });

    await test("both devices edit offline: merge keeps everything from both", async () => {
        A.sets("jlpt_xp", 90);
        A.sets("jlpt_profile", { learned: ["a", "b"], favorites: [], weak: [], achievements: [], bestStreak: 2, lastActive: 5 });
        B.sets("jlpt_xp", 85);
        B.sets("jlpt_profile", { learned: ["a", "c"], favorites: [], weak: [], achievements: [], bestStreak: 3, lastActive: 4 });
        await flush(B);                       // B syncs first
        assert.strictEqual(cloud.rows.get(UID).xp, 85);
        await flush(A);                       // A now conflicts and merges
        const row = cloud.rows.get(UID);
        assert.strictEqual(row.xp, 90);
        assert.deepStrictEqual(row.profile.learned.slice().sort(), ["a", "b", "c"]);
        assert.strictEqual(A.state().xp, 90);
        assert.deepStrictEqual(A.state().profile.learned.slice().sort(), ["a", "b", "c"]);
        assert.ok(A.reloads >= 1, "A reloads to show merged data");
    });

    await test("race: cloud changes between the check and the push -> retry, nothing lost", async () => {
        A = boot(storeA, cloud); await A.signIn(UID);
        B = boot(storeB, cloud); await B.signIn(UID);
        A.sets("jlpt_xp", 200);
        cloud.beforeUpdate = () => {          // B sneaks in a push first
            const r = cloud.rows.get(UID);
            r.rev += 1; r.xp = 150; r.profile = { learned: ["a", "b", "c", "z"], bestStreak: 3, lastActive: 9 };
        };
        await flush(A);
        const row = cloud.rows.get(UID);
        assert.strictEqual(row.xp, 200);
        assert.ok(row.profile.learned.includes("z"), "B's concurrent word survived");
    });

    await test("Sync reset: cloud is emptied and the other device does not resurrect it", async () => {
        A = boot(storeA, cloud); await A.signIn(UID);
        await A.sync.resetEverything();
        assert.strictEqual(Array.from(storeA.keys()).filter(k => k.indexOf("jlpt_") === 0).length, 0, "local app keys removed");
        assert.strictEqual(cloud.rows.get(UID).xp, 0);
        A = boot(storeA, cloud); await A.signIn(UID);
        assert.strictEqual(cloud.rows.get(UID).xp, 0, "reset not undone by next sync");
        assert.strictEqual(A.reloads, 0);
        B = boot(storeB, cloud); await B.signIn(UID);
        assert.strictEqual(B.state().xp, 0, "device B receives the reset");
    });

    await test("different account on the same device: asks first, declining signs out and changes nothing", async () => {
        const store = new Map();
        const c = makeCloud();
        const D = boot(store, c); await D.signIn("alice");
        D.sets("jlpt_xp", 40); await flush(D);
        const D2 = boot(store, c, { confirmAnswer: false });
        await D2.signIn("bob");
        assert.strictEqual(D2.confirms.length, 1);
        assert.strictEqual(c.client.auth.signedOut, 1);
        assert.strictEqual(JSON.parse(store.get("jlpt_xp")), 40, "alice's local progress untouched");
        assert.strictEqual(c.rows.has("bob"), false, "nothing leaked into bob's account");
    });

    await test("offline: nothing is sent, nothing is lost, syncs when back online", async () => {
        const store = new Map(), c = makeCloud();
        const E = boot(store, c); await E.signIn("carol");   // signed in, nothing to sync yet
        E.online = false;
        E.sets("jlpt_xp", 7);
        await flush(E);
        assert.strictEqual(c.rows.has("carol"), false, "offline: no push");
        assert.strictEqual(JSON.parse(store.get("jlpt_xp")), 7, "local copy intact");
        E.online = true;
        await E.sync.syncNow(); await flush(E);
        assert.strictEqual(c.rows.get("carol").xp, 7, "pushed once back online");
    });

    await test("a network error is swallowed and retried, never thrown", async () => {
        const store = new Map(), c = makeCloud();
        const D = boot(store, c); await D.signIn("dave");
        const orig = c.client.from;
        c.client.from = () => { throw new Error("boom"); };
        D.sets("jlpt_xp", 3);
        await flush(D).catch(() => assert.fail("flush must not throw"));
        assert.strictEqual(JSON.parse(store.get("jlpt_xp")), 3, "local data intact during outage");
        assert.strictEqual(c.rows.has("dave"), false);
        c.client.from = orig;
        await flush(D);                       // the scheduled retry now succeeds
        assert.strictEqual(c.rows.get("dave").xp, 3, "retry pushed it after the outage");
    });

    console.log("\n" + passed + " passed, " + failed + " failed");
    process.exit(failed ? 1 : 0);
})();
