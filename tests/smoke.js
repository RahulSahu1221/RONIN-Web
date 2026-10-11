// tests/smoke.js: loads the real site in headless Chrome and checks the basics.
// Usage (from the project folder, after `npm install`):  npm run smoke
// Needs internet the first time (puppeteer downloads Chrome).
// NOTE: written without being able to run a browser in the authoring
// environment, so if a check fails, read the message first: it may be a
// selector that needs adjusting rather than a real bug.
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(__dirname, "out");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
    ".png": "image/png", ".ico": "image/x-icon", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };

function serve() {
    return new Promise(resolve => {
        const srv = http.createServer((req, res) => {
            let p = decodeURIComponent(req.url.split("?")[0]);
            if (p.endsWith("/")) p += "index.html";
            const file = path.join(ROOT, path.normalize(p));
            if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end("nf"); }
            res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
            fs.createReadStream(file).pipe(res);
        }).listen(0, "127.0.0.1", () => resolve(srv));
    });
}

let fails = 0;
const ok = m => console.log("  PASS  " + m);
const bad = m => { console.log("  FAIL  " + m); fails++; };
const check = (c, pass, fail) => (c ? ok(pass) : bad(fail));

(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const srv = await serve();
    const url = "http://127.0.0.1:" + srv.address().port + "/index.html";
    const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
    const errors = [];

    try {
        const page = await browser.newPage();
        page.on("pageerror", e => errors.push("pageerror: " + e.message));
        page.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });

        /* ── Phone-sized viewport (the one that used to blur) ───────── */
        await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
        await page.goto(url, { waitUntil: "networkidle2", timeout: 45000 });
        await new Promise(r => setTimeout(r, 1500));

        check(await page.title() === "RONIN WEB", "title is RONIN WEB", "page title is not RONIN WEB");
        check(await page.$("#lightRaysCanvas") === null, "no light-rays canvas", "light-rays canvas is back");
        check(await page.$("#sdAuthLoggedOut") !== null && await page.$("#sdSyncNowBtn") !== null, "account section present", "account section missing");

        const blurry = await page.evaluate(() => {
            const bad = [];
            for (const el of [document.documentElement, document.body]) {
                const f = getComputedStyle(el).filter;
                if (f && f !== "none") bad.push(el.tagName + " filter=" + f);
            }
            const vt = document.getAnimations().filter(a => a.effect && a.effect.pseudoElement && /view-transition/.test(a.effect.pseudoElement));
            if (vt.length) bad.push(vt.length + " view-transition animation(s) still running");
            return bad;
        });
        check(blurry.length === 0, "nothing is blurring the page on a phone viewport", "blur sources found: " + blurry.join("; "));

        /* ── Theme toggle, then resize (the exact sequence that blurred) ── */
        const toggle = await page.$("#themeToggleBtn") || await page.$("#mThemeBtn");
        if (toggle) {
            await toggle.click();
            await page.setViewport({ width: 390, height: 700, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
            await new Promise(r => setTimeout(r, 1500));
            const after = await page.evaluate(() => ({
                filter: getComputedStyle(document.documentElement).filter,
                running: document.getAnimations().filter(a => a.effect && a.effect.pseudoElement && /view-transition/.test(a.effect.pseudoElement)).length
            }));
            check((after.filter === "none" || !after.filter) && after.running === 0, "theme toggle + resize leaves no blur behind", "blur remained after toggle+resize: " + JSON.stringify(after));
        } else {
            console.log("  SKIP  theme toggle not found (check the selector in tests/smoke.js)");
        }
        await page.screenshot({ path: path.join(OUT, "mobile.png") });

        /* ── Desktop viewport ─────────────────────────────────────────── */
        await page.setViewport({ width: 1280, height: 800 });
        await new Promise(r => setTimeout(r, 800));
        await page.screenshot({ path: path.join(OUT, "desktop.png") });

        /* Errors from third-party/optional resources shouldn't fail the run. */
        const real = errors.filter(e => !/favicon|ERR_BLOCKED|net::ERR_FAILED.*(fonts|gstatic|googleapis)/i.test(e));
        check(real.length === 0, "no JavaScript errors while loading", "errors:\n          " + real.join("\n          "));
        console.log("  Screenshots saved to tests/out/ (look at mobile.png for blur)");
    } finally {
        await browser.close();
        srv.close();
    }
    console.log(fails ? "\nSMOKE TEST FAILED" : "\nSMOKE TEST OK");
    process.exit(fails ? 1 : 0);
})().catch(e => { console.error("Smoke test crashed:", e.message); process.exit(1); });
