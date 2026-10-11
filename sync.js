// sync.js
// RONIN WEB: Supabase login + cross-device progress sync.
// Loads AFTER app.js/decks.js/games.js so it can wrap store.set.
(function () {
"use strict";

/* ── Connection ───────────────────────────────────────────────────────────
   URL and publishable key are PUBLIC by design; Row Level Security on the
   user_progress table is the real access control. Never put a service_role
   key anywhere in client code. */
const SUPABASE_URL = "https://wfwmihxzztzmnebyscml.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_HzVKOpTn7Ny5oie9urmRjA_tiUpio6L";

let sb = null;
try {
    sb = supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
} catch (e) {
    console.warn("[sync] Supabase unavailable:", e);
}

/* ═══════════════════════════════════════════════════════════════════════════
   PURE LOGIC (no DOM, no network): kept separate so it can be unit-tested
   ═══════════════════════════════════════════════════════════════════════════ */

/* localStorage key -> cloud column */
const SYNC_KEYS = {
    jlpt_profile:    "profile",
    jlpt_srs:        "srs",
    jlpt_lastLesson: "last_lesson",
    jlpt_decks:      "decks",
    jlpt_xp:         "xp",
    jlpt_heatmap:    "heatmap"
};
const META_KEY = "ronin_sync_meta";

const isObj = v => v && typeof v === "object" && !Array.isArray(v);

/* Make any loosely-shaped state safe: right types, integer xp/lesson. */
function normalizeState(s) {
    s = s || {};
    return {
        profile:    isObj(s.profile) ? s.profile : {},
        srs:        isObj(s.srs) ? s.srs : {},
        lastLesson: Math.max(1, Math.round(Number(s.lastLesson)) || 1),
        decks:      Array.isArray(s.decks) ? s.decks : [],
        xp:         Math.max(0, Math.round(Number(s.xp)) || 0),
        heatmap:    isObj(s.heatmap) ? s.heatmap : {}
    };
}

/* JSON with sorted keys: Postgres jsonb reorders object keys, so plain
   JSON.stringify would call identical data "different". */
function canon(v) {
    if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
    if (isObj(v)) {
        return "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
    }
    return JSON.stringify(v === undefined ? null : v);
}

/* FNV-1a 32-bit over the canonical form: cheap fingerprint of "what was
   last synced", so dirty-detection never depends on every write being
   observed. */
function hashState(state) {
    const str = canon(normalizeState(state));
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16) + ":" + str.length;
}

/* Does this state hold real progress (as opposed to a fresh install)?
   SRS entries alone don't count: app.js creates one per word on load. */
function hasProgress(state) {
    const s = normalizeState(state);
    const p = s.profile;
    return s.xp > 0
        || (Array.isArray(p.learned) && p.learned.length > 0)
        || (Array.isArray(p.favorites) && p.favorites.length > 0)
        || (Array.isArray(p.weak) && p.weak.length > 0)
        || s.decks.length > 0
        || Object.keys(s.heatmap).length > 0;
}

function unionArr(a, b) {
    const out = [], seen = new Set();
    for (const x of [].concat(Array.isArray(a) ? a : [], Array.isArray(b) ? b : [])) {
        const k = typeof x === "string" ? x : canon(x);
        if (!seen.has(k)) { seen.add(k); out.push(x); }
    }
    return out;
}

/* Better SRS record = more repetitions, then longer interval, then later due. */
function betterSrs(a, b) {
    if (!isObj(a)) return b;
    if (!isObj(b)) return a;
    const ka = [a.repetition || 0, a.interval || 0, a.dueDate || 0];
    const kb = [b.repetition || 0, b.interval || 0, b.dueDate || 0];
    for (let i = 0; i < 3; i++) {
        if (ka[i] !== kb[i]) return ka[i] > kb[i] ? a : b;
    }
    return a;
}

/* Merge two devices' states without losing either side's progress.
   Known trade-off: if one device deliberately lapsed a word (repetition
   reset to 0) the merge keeps the other device's more advanced record. */
function mergeStates(a, b) {
    a = normalizeState(a); b = normalizeState(b);
    const aNewer = (a.profile.lastActive || 0) >= (b.profile.lastActive || 0);
    const base = aNewer ? a : b, other = aNewer ? b : a;

    const profile = Object.assign({}, other.profile, base.profile, {
        learned:      unionArr(a.profile.learned, b.profile.learned),
        favorites:    unionArr(a.profile.favorites, b.profile.favorites),
        weak:         unionArr(a.profile.weak, b.profile.weak),
        achievements: unionArr(a.profile.achievements, b.profile.achievements),
        bestStreak:   Math.max(a.profile.bestStreak || 0, b.profile.bestStreak || 0)
    });

    const srs = {};
    for (const k of new Set([...Object.keys(a.srs), ...Object.keys(b.srs)])) {
        srs[k] = betterSrs(a.srs[k], b.srs[k]);
    }

    const deckMap = new Map();
    for (const d of [...b.decks, ...a.decks]) {
        const id = isObj(d) && d.id ? d.id : canon(d);
        const prev = deckMap.get(id);
        const size = x => (isObj(x) && Array.isArray(x.words) ? x.words.length : 0);
        if (!prev || size(d) >= size(prev)) deckMap.set(id, d);
    }

    const heatmap = {};
    for (const k of new Set([...Object.keys(a.heatmap), ...Object.keys(b.heatmap)])) {
        heatmap[k] = Math.max(Number(a.heatmap[k]) || 0, Number(b.heatmap[k]) || 0);
    }

    return {
        profile, srs,
        lastLesson: base.lastLesson,
        decks: Array.from(deckMap.values()),
        xp: Math.max(a.xp, b.xp),
        heatmap
    };
}

/* Friendlier text for the handful of errors a person will actually hit. */
function friendlyAuthError(err) {
    const m = String((err && err.message) || err || "").toLowerCase();
    if (!navigator.onLine || m.includes("failed to fetch") || m.includes("network")) return "No internet connection. Try again when you're online.";
    if (m.includes("invalid login")) return "Wrong email or password.";
    if (m.includes("email not confirmed")) return "Please confirm your email first (check your inbox), then sign in.";
    if (m.includes("already registered") || m.includes("already been registered")) return "That email already has an account. Try Sign In.";
    if (m.includes("rate limit") || m.includes("too many")) return "Too many attempts. Wait a minute and try again.";
    if (m.includes("password") && m.includes("characters")) return "Password needs at least 6 characters.";
    if (m.includes("valid email") || m.includes("invalid email")) return "That doesn't look like a valid email address.";
    return "Something went wrong. Please try again.";
}

/* Expose the pure parts for the test script. */
window.RoninSyncLogic = { normalizeState, canon, hashState, hasProgress, mergeStates, friendlyAuthError };

/* ═══════════════════════════════════════════════════════════════════════════
   STORAGE HELPERS
   ═══════════════════════════════════════════════════════════════════════════ */

function readLocalState() {
    const get = (k, fb) => {
        try {
            const raw = localStorage.getItem(k);
            return raw === null ? fb : JSON.parse(raw);
        } catch (_) { return fb; }
    };
    return normalizeState({
        profile:    get("jlpt_profile", {}),
        srs:        get("jlpt_srs", {}),
        lastLesson: get("jlpt_lastLesson", 1),
        decks:      get("jlpt_decks", []),
        xp:         get("jlpt_xp", 0),
        heatmap:    get("jlpt_heatmap", {})
    });
}

/* Writes bypass the store.set wrapper below on purpose: applying cloud data
   must not look like a fresh local edit. */
function writeLocalState(state) {
    const s = normalizeState(state);
    const entries = {
        jlpt_profile: s.profile, jlpt_srs: s.srs, jlpt_lastLesson: s.lastLesson,
        jlpt_decks: s.decks, jlpt_xp: s.xp, jlpt_heatmap: s.heatmap
    };
    for (const k of Object.keys(entries)) localStorage.setItem(k, JSON.stringify(entries[k]));
}

function rowToState(row) {
    return normalizeState({
        profile: row.profile, srs: row.srs, lastLesson: row.last_lesson,
        decks: row.decks, xp: row.xp, heatmap: row.heatmap
    });
}

function stateToRow(s) {
    return { profile: s.profile, srs: s.srs, last_lesson: s.lastLesson, decks: s.decks, xp: s.xp, heatmap: s.heatmap };
}

function loadMeta() {
    try { return JSON.parse(localStorage.getItem(META_KEY)) || {}; } catch (_) { return {}; }
}
function saveMeta(m) {
    try { localStorage.setItem(META_KEY, JSON.stringify(m)); } catch (_) { /* quota: sync still works this session */ }
}

function toast(msg, type) {
    try { if (typeof showToast === "function") showToast(msg, type || "success"); } catch (_) { /* no toast available */ }
}

/* ═══════════════════════════════════════════════════════════════════════════
   SYNC ENGINE
   One sync at a time (mutex). Each push is a compare-and-set on `rev`, so a
   second device can never be silently overwritten: if the cloud moved on,
   the push fails cleanly and we merge instead.
   ═══════════════════════════════════════════════════════════════════════════ */

let currentSession = null;
let syncRunning = false;
let syncAgain = false;
let pushTimer = null;
let retryDelay = 0;

function setSyncStatus(text, isError) {
    const el = document.getElementById("sdSyncStatus");
    if (!el) return;
    el.textContent = text || "";
    el.style.color = isError ? "var(--danger)" : "var(--text-muted)";
}

function applyAndReload(state, message) {
    writeLocalState(state);
    /* Loop guard: never reload twice within 10 seconds. */
    let last = 0;
    try { last = Number(sessionStorage.getItem("ronin_sync_reloaded")) || 0; } catch (_) { /* ignore */ }
    if (Date.now() - last < 10000) return false;
    try { sessionStorage.setItem("ronin_sync_reloaded", String(Date.now())); } catch (_) { /* ignore */ }
    toast(message, "success");
    setTimeout(() => location.reload(), 1200);
    return true;
}

async function pushState(uid, state, knownRev) {
    const payload = Object.assign(stateToRow(state), { updated_at: new Date().toISOString() });
    if (knownRev === null) {
        const { data, error } = await sb.from("user_progress")
            .insert(Object.assign({ user_id: uid, rev: 1 }, payload)).select("rev").maybeSingle();
        if (error) return { conflict: error.code === "23505", error };
        return { rev: data ? data.rev : 1 };
    }
    const { data, error } = await sb.from("user_progress")
        .update(Object.assign({ rev: knownRev + 1 }, payload))
        .eq("user_id", uid).eq("rev", knownRev).select("rev");
    if (error) return { error };
    if (!data || data.length === 0) return { conflict: true };
    return { rev: data[0].rev };
}

async function fetchFullRow(uid) {
    const { data, error } = await sb.from("user_progress").select("*").eq("user_id", uid).maybeSingle();
    if (error) throw error;
    return data;
}

async function runSync(attempt) {
    attempt = attempt || 0;
    if (!sb || !currentSession) return;
    if (!navigator.onLine) { setSyncStatus("Offline. Changes are saved on this device and will sync later."); return; }

    const uid = currentSession.user.id;
    const meta = loadMeta();
    const local = readLocalState();
    const localHash = hashState(local);
    const sameAccount = meta.uid === uid;
    const dirty = meta.hash !== localHash;

    setSyncStatus("Syncing…");
    /* Cheap check first: only the revision number, not the whole progress
       blob. Most syncs (tab switches, token refreshes) end right here. */
    const { data: head, error: headErr } = await sb.from("user_progress").select("rev").eq("user_id", uid).maybeSingle();
    if (headErr) throw headErr;
    const cloudRev = head ? head.rev : null;

    /* Different account than this device last synced with: local data
       belongs to someone else, so never merge it into this account. */
    if (meta.uid && !sameAccount) {
        const ok = confirm("This device holds progress from a different account.\n\nSigning in here will REPLACE it with this account's saved progress.\n\nOK = replace   Cancel = sign out and keep it");
        if (!ok) { await sb.auth.signOut(); return; }
        const row = head ? await fetchFullRow(uid) : null;
        const next = row ? rowToState(row) : normalizeState({});
        saveMeta({ uid, rev: row ? row.rev : null, hash: hashState(next) });
        applyAndReload(next, "Loaded this account's progress");
        return;
    }

    /* No cloud row yet. */
    if (!head) {
        if (!hasProgress(local)) { saveMeta({ uid, rev: null, hash: localHash }); setSyncStatus("Signed in. Nothing to sync yet."); return; }
        const res = await pushState(uid, local, null);
        if (res.conflict && attempt < 3) return runSync(attempt + 1);
        if (res.error) throw res.error;
        saveMeta({ uid, rev: res.rev, hash: localHash });
        setSyncStatus("Synced just now.");
        return;
    }

    /* Cloud unchanged since we last looked. */
    if (sameAccount && meta.rev === cloudRev) {
        if (!dirty) { setSyncStatus("Up to date."); return; }
        const res = await pushState(uid, local, cloudRev);
        if (res.conflict && attempt < 3) return runSync(attempt + 1);
        if (res.error) throw res.error;
        saveMeta({ uid, rev: res.rev, hash: localHash });
        setSyncStatus("Synced just now.");
        return;
    }

    /* Cloud has changed (or this is the first link): now fetch it in full. */
    const row = await fetchFullRow(uid);
    if (!row) return runSync(attempt + 1 > 3 ? 3 : attempt + 1);
    const cloud = rowToState(row);
    const localIsFresh = sameAccount ? !dirty : !hasProgress(local);

    if (localIsFresh) {
        const cloudHash = hashState(cloud);
        saveMeta({ uid, rev: row.rev, hash: cloudHash });
        if (cloudHash === localHash) { setSyncStatus("Up to date."); return; }
        applyAndReload(cloud, "Progress updated from your other device");
        return;
    }

    /* Both sides have changes: merge, so neither device loses anything. */
    const merged = mergeStates(local, cloud);
    const mergedHash = hashState(merged);
    const res = await pushState(uid, merged, row.rev);
    if (res.conflict && attempt < 3) return runSync(attempt + 1);
    if (res.error) throw res.error;
    saveMeta({ uid, rev: res.rev, hash: mergedHash });
    if (mergedHash !== localHash) applyAndReload(merged, "Progress from both devices merged");
    else setSyncStatus("Synced just now.");
}

/* Public entry: serialises runs, retries with backoff, never throws. */
async function syncNow() {
    if (!sb || !currentSession) return;
    if (syncRunning) { syncAgain = true; return; }
    syncRunning = true;
    try {
        await runSync(0);
        retryDelay = 0;
    } catch (e) {
        console.warn("[sync] failed:", e);
        setSyncStatus("Sync problem. Will retry. Your progress is safe on this device.", true);
        retryDelay = Math.min(retryDelay ? retryDelay * 2 : 5000, 60000);
        clearTimeout(pushTimer);
        pushTimer = setTimeout(syncNow, retryDelay);
    } finally {
        syncRunning = false;
        if (syncAgain) { syncAgain = false; schedulePush(500); }
    }
}

function schedulePush(delay) {
    if (!currentSession) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(syncNow, delay === undefined ? 2000 : delay);
}

/* Any write to a synced key schedules a debounced sync. Dirty-detection
   itself does not depend on this hook (it uses the content hash), so a
   missed write can delay a push but never lose data. */
function installStoreHook() {
    if (typeof store === "undefined" || !store || store.__ronSyncHooked) return;
    const original = store.set.bind(store);
    store.set = function (key, val) {
        const ok = original(key, val);
        if (ok && Object.prototype.hasOwnProperty.call(SYNC_KEYS, key)) schedulePush();
        return ok;
    };
    store.__ronSyncHooked = true;
}

/* Reset: clear this app's keys but keep the login, and push the empty state
   so the cloud copy doesn't resurrect everything on the next sync. */
async function resetEverything() {
    if (pushTimer) clearTimeout(pushTimer);
    const toRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.indexOf("jlpt_") === 0) toRemove.push(k);
    }
    toRemove.forEach(k => localStorage.removeItem(k));

    if (sb && currentSession && navigator.onLine) {
        try {
            const uid = currentSession.user.id;
            const empty = normalizeState({});
            const { data: row } = await sb.from("user_progress").select("rev").eq("user_id", uid).maybeSingle();
            const res = await Promise.race([
                pushState(uid, empty, row ? row.rev : null),
                new Promise(r => setTimeout(() => r({ timeout: true }), 5000))
            ]);
            if (res && res.rev) { saveMeta({ uid, rev: res.rev, hash: hashState(empty) }); return; }
        } catch (_) { /* fall through to the offline path */ }
    }
    /* Couldn't reach the cloud: leave meta stale so the empty local state
       counts as dirty and is pushed on the next successful sync. */
}

window.RoninSync = { syncNow, resetEverything };

/* ═══════════════════════════════════════════════════════════════════════════
   AUTH UI
   ═══════════════════════════════════════════════════════════════════════════ */

function setAuthStatus(msg, isError) {
    const el = document.getElementById("sdAuthStatus");
    if (!el) return;
    el.textContent = msg || "";
    el.style.color = isError ? "var(--danger)" : "var(--text-muted)";
}

function showLoggedInUI(session) {
    const out = document.getElementById("sdAuthLoggedOut");
    const inn = document.getElementById("sdAuthLoggedIn");
    const emailEl = document.getElementById("sdAuthEmail");
    if (out) out.classList.add("hidden");
    if (inn) inn.classList.remove("hidden");
    if (emailEl) emailEl.textContent = (session && session.user && session.user.email) || "";
}

function showLoggedOutUI() {
    const out = document.getElementById("sdAuthLoggedOut");
    const inn = document.getElementById("sdAuthLoggedIn");
    if (out) out.classList.remove("hidden");
    if (inn) inn.classList.add("hidden");
    setSyncStatus("");
}

function readCredentials() {
    const email = (document.getElementById("sdAuthEmailInput") || {}).value;
    const password = (document.getElementById("sdAuthPasswordInput") || {}).value;
    return { email: (email || "").trim(), password: password || "" };
}

/* Disable the buttons during a request so double-taps can't fire twice. */
async function withBusy(fn) {
    const ids = ["sdSignInBtn", "sdSignUpBtn", "sdForgotBtn", "sdSignOutBtn", "sdSyncNowBtn"];
    const btns = ids.map(id => document.getElementById(id)).filter(Boolean);
    btns.forEach(b => { b.disabled = true; });
    try { await fn(); } finally { btns.forEach(b => { b.disabled = false; }); }
}

async function ronSignUp() {
    if (!sb) return setAuthStatus("Sign-in is unavailable right now.", true);
    const { email, password } = readCredentials();
    if (!email || !password) return setAuthStatus("Enter an email and password.", true);
    if (password.length < 6) return setAuthStatus("Password needs at least 6 characters.", true);
    if (!navigator.onLine) return setAuthStatus("You're offline. Account creation needs internet; your progress is safe on this device.", true);

    setAuthStatus("Creating account…");
    const { data, error } = await sb.auth.signUp({ email, password });
    if (error) return setAuthStatus(friendlyAuthError(error), true);
    setAuthStatus(data.session ? "Account created. Signed in." : "Check your inbox to confirm your email, then sign in.");
}

async function ronSignIn() {
    if (!sb) return setAuthStatus("Sign-in is unavailable right now.", true);
    const { email, password } = readCredentials();
    if (!email || !password) return setAuthStatus("Enter an email and password.", true);
    if (!navigator.onLine) return setAuthStatus("You're offline. Sign-in needs internet; your progress is safe on this device.", true);

    setAuthStatus("Signing in…");
    const { error } = await sb.auth.signInWithPassword({ email, password });
    setAuthStatus(error ? friendlyAuthError(error) : "Signed in.", !!error);
}

async function ronForgotPassword() {
    if (!sb) return;
    const { email } = readCredentials();
    if (!email) return setAuthStatus("Type your email above first, then tap Forgot password.", true);
    if (!navigator.onLine) return setAuthStatus("You're offline. Try again when you're online.", true);
    setAuthStatus("Sending reset link…");
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
    setAuthStatus(error ? friendlyAuthError(error) : "If that email has an account, a reset link is on its way.", !!error);
}

async function ronSignOut() {
    if (!sb) return;
    setAuthStatus("Saving, then signing out…");
    /* Best effort final push so nothing is stranded on this device. */
    try { if (navigator.onLine) await Promise.race([syncNow(), new Promise(r => setTimeout(r, 4000))]); } catch (_) { /* ignore */ }
    const { error } = await sb.auth.signOut();
    if (error) setAuthStatus(friendlyAuthError(error), true);
    else setAuthStatus("");
}

/* A "password recovery" link brings the person back signed in with a
   temporary session; let them choose a new password right away. */
async function handlePasswordRecovery() {
    const pw = prompt("Choose a new password (at least 6 characters):");
    if (!pw) return;
    if (pw.length < 6) { toast("Password needs at least 6 characters.", "error"); return; }
    const { error } = await sb.auth.updateUser({ password: pw });
    toast(error ? friendlyAuthError(error) : "Password updated.", error ? "error" : "success");
}

/* ═══════════════════════════════════════════════════════════════════════════
   BOOT
   ═══════════════════════════════════════════════════════════════════════════ */

installStoreHook();

if (sb) {
    /* Supabase warns against awaiting other supabase calls inside this
       callback, so the sync is kicked off on the next tick. */
    sb.auth.onAuthStateChange((event, session) => {
        currentSession = session || null;
        if (session) {
            showLoggedInUI(session);
            if (event === "PASSWORD_RECOVERY") setTimeout(handlePasswordRecovery, 0);
            else setTimeout(syncNow, 0);
        } else {
            showLoggedOutUI();
            clearTimeout(pushTimer);
        }
    });

    window.addEventListener("online", () => { setSyncStatus(""); schedulePush(500); });
    window.addEventListener("offline", () => setSyncStatus("Offline. Changes are saved on this device and will sync later."));
    document.addEventListener("visibilitychange", () => {
        if (!currentSession) return;
        if (document.visibilityState === "hidden") { clearTimeout(pushTimer); syncNow(); }
        else schedulePush(500);
    });
}

function wireAuthButtons() {
    const bind = (id, fn) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener("click", () => withBusy(fn));
    };
    bind("sdSignUpBtn", ronSignUp);
    bind("sdSignInBtn", ronSignIn);
    bind("sdForgotBtn", ronForgotPassword);
    bind("sdSignOutBtn", ronSignOut);
    bind("sdSyncNowBtn", syncNow);
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wireAuthButtons);
else wireAuthButtons();
})();
