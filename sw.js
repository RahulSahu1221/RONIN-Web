//sw.js

"use strict";

/* ═══════════════════════════════════════════════════════════════════════════
   SERVICE WORKER — RONIN WEB
   Strategy : Cache-first for static shell, Network-first for lesson JSON,
              Stale-while-revalidate for CDN assets.
   Security : No eval, no dynamic import, strict origin checks.
   Version  : Bump CACHE_VERSION on every production deploy.
═══════════════════════════════════════════════════════════════════════════ */

const CACHE_VERSION = "v24"; // bumped: level-aware lessons (N3/N2), kanji lessons, data/*.json now network-first
const CACHE_STATIC   = `ronin-static-${CACHE_VERSION}`;
const CACHE_LESSONS  = `ronin-lessons-${CACHE_VERSION}`;
const CACHE_CDN      = `ronin-cdn-${CACHE_VERSION}`;

/* Assets that must be cached at install time (app shell).
   Every path is relative to the SW scope (project root). */
const STATIC_ASSETS = [
    "./",
    "./index.html",
    "./style.min.css",
    "./app.min.js",
    "./decks.min.js",
    "./games.min.js",
    "./theme-shutter.min.js",
    "./supabase.min.js",
    "./sync.min.js",
    "./manifest.json",
    "./data/assets/logo.png",
    "./data/assets/logo_name.png",
    "./data/assets/logo.ico"
];

/* CDN assets cached with stale-while-revalidate. */
const CDN_ASSETS = [
    "https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/gsap.min.js"
];

/* ── Helpers ─────────────────────────────────────────────────────────────── */

/* Lesson / kanji data files. */
const DATA_JSON = /\/data\/.+\.json$/i;

/** Returns true only for same-origin requests or explicitly allowed CDN URLs. */
function isTrustedOrigin(url) {
    const parsed = new URL(url);
    if (parsed.origin === self.location.origin) return true;
    return CDN_ASSETS.some(cdn => url.startsWith(cdn));
}

/** Opens a named cache and puts a cloned response. Silently ignores errors
 *  (e.g. opaque CDN response that exceeds quota). */
async function cachePut(cacheName, request, response) {
    if (!response || !response.ok) return;
    try {
        const cache = await caches.open(cacheName);
        await cache.put(request, response.clone());
    } catch (_) { /* quota or opaque-response error — safe to swallow */ }
}

/* ── Install ─────────────────────────────────────────────────────────────── */

self.addEventListener("install", event => {
    event.waitUntil(
        (async () => {
            /* Cache static shell — individual failures must not block install. */
            const staticCache = await caches.open(CACHE_STATIC);
            await Promise.allSettled(
                STATIC_ASSETS.map(url =>
                    staticCache.add(url).catch(err =>
                        console.warn(`[SW] Static cache miss: ${url}`, err)
                    )
                )
            );

            /* Cache CDN assets separately (stale-while-revalidate bucket). */
            const cdnCache = await caches.open(CACHE_CDN);
            await Promise.allSettled(
                CDN_ASSETS.map(url =>
                    cdnCache.add(url).catch(err =>
                        console.warn(`[SW] CDN cache miss: ${url}`, err)
                    )
                )
            );

            /* Do NOT auto-activate here. A new worker taking over at once fires
               "controllerchange" in every open tab, and the page reloads on it,
               which would reload the app out from under someone mid-quiz.
               Instead this worker waits until the page asks it to take over
               (the "message" listener below), after showing an "Update
               available" prompt the person controls. */
        })()
    );
});

/* ── Update handshake ────────────────────────────────────────────────────── */
/* app.js posts "SKIP_WAITING" after the person taps Update, so the reload
   that follows is always something they asked for. */
self.addEventListener("message", event => {
    if (event.data === "SKIP_WAITING") self.skipWaiting();
});

/* ── Activate ────────────────────────────────────────────────────────────── */

self.addEventListener("activate", event => {
    event.waitUntil(
        (async () => {
            /* Delete all caches whose name does not match current version. */
            const allKeys     = await caches.keys();
            const currentKeys = new Set([CACHE_STATIC, CACHE_LESSONS, CACHE_CDN]);
            await Promise.allSettled(
                allKeys
                    .filter(key => !currentKeys.has(key))
                    .map(key => caches.delete(key))
            );
            /* Take control of all open clients immediately. */
            await self.clients.claim();
        })()
    );
});

/* ── Fetch ───────────────────────────────────────────────────────────────── */

self.addEventListener("fetch", event => {
    const { request } = event;

    /* Only handle GET requests. Let POST/PUT/DELETE pass through. */
    if (request.method !== "GET") return;

    const url = request.url;

    /* Reject requests from untrusted origins. */
    if (!isTrustedOrigin(url)) return;

    /* Bypass Live Server / WebSocket / Dev tools completely */
    if (url.includes("sockjs-node") || url.includes("ws:") || url.includes("browser-sync")) return;

    /* ── Strategy 1: Lesson + kanji JSON — Network-first, fall back to cache ──
       Matches ANY .json under /data/, any depth, any letter case:
       data/n5/lesson1.json, data/n3/Lesson4.json, data/n4/kanji-L19.json …
       (The old test looked for "/data/lesson", which none of these paths
       contain, so they were served cache-first and edits never showed up.) */
    if (DATA_JSON.test(new URL(url).pathname)) {
        event.respondWith(
            (async () => {
                try {
                    const networkRes = await fetch(request);
                    await cachePut(CACHE_LESSONS, request, networkRes);
                    return networkRes;
                } catch (_) {
                    const cached = await caches.match(request, { cacheName: CACHE_LESSONS });
                    if (cached) return cached;
                    /* Return a structured JSON error so the app can display
                       a friendly message rather than a blank network error. */
                    return new Response(
                        JSON.stringify({ error: "offline", data: [] }),
                        { status: 503, headers: { "Content-Type": "application/json" } }
                    );
                }
            })()
        );
        return;
    }

    /* ── Strategy 2: CDN assets — Stale-while-revalidate ── */
    if (CDN_ASSETS.some(cdn => url.startsWith(cdn))) {
        event.respondWith(
            (async () => {
                const cached = await caches.match(request, { cacheName: CACHE_CDN });
                const networkFetch = fetch(request)
                    .then(res => { cachePut(CACHE_CDN, request, res); return res; })
                    .catch(() => null);
                return cached || await networkFetch ||
                    new Response("", { status: 503 });
            })()
        );
        return;
    }

    /* ── Strategy 3: Static shell — Cache-first, fall back to network ── */
    event.respondWith(
        (async () => {
            const cached = await caches.match(request, { cacheName: CACHE_STATIC });
            if (cached) return cached;
            try {
                const networkRes = await fetch(request);
                await cachePut(CACHE_STATIC, request, networkRes);
                return networkRes;
            } catch (_) {
                /* For navigation requests, serve the cached shell (SPA fallback). */
                if (request.mode === "navigate") {
                    const shell = await caches.match("./index.html", { cacheName: CACHE_STATIC });
                    if (shell) return shell;
                }
                return new Response("Offline", { status: 503, statusText: "Service Unavailable" });
            }
        })()
    );
});

/* ── Push Notifications ──────────────────────────────────────────────────── */

self.addEventListener("push", event => {
    let payload = { title: "RONIN WEB 🎌", body: "You have SRS reviews due!" };
    try {
        if (event.data) payload = event.data.json();
    } catch (_) { /* malformed push payload — use default */ }

    event.waitUntil(
        self.registration.showNotification(String(payload.title || "RONIN WEB"), {
            body:    String(payload.body  || "Time to review!"),
            icon:    "./data/assets/logo.png",
            badge:   "./data/assets/logo.png",
            vibrate: [200, 100, 200],
            tag:     "jlpt-review-reminder",  /* Replace older notification of same type */
            renotify: false,
            data:    { url: "./" }
        })
    );
});

self.addEventListener("notificationclick", event => {
    event.notification.close();
    event.waitUntil(
        clients.matchAll({ type: "window", includeUncontrolled: true })
            .then(clientList => {
                /* Focus an existing window if one is already open. */
                for (const client of clientList) {
                    if (client.url.includes(self.registration.scope) && "focus" in client) {
                        return client.focus();
                    }
                }
                /* Otherwise open a new window. */
                if (clients.openWindow) return clients.openWindow("./");
            })
    );
});