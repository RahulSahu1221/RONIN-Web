// tests/static-check.js: fast, dependency-free checks to run before every deploy.
// Usage: node tests/static-check.js   (also runs as part of `npm test`)
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const read = f => fs.readFileSync(path.join(ROOT, f), "utf8");
const exists = f => fs.existsSync(path.join(ROOT, f));
const sha = s => crypto.createHash("sha1").update(s).digest("hex");

let fails = 0, warns = 0;
const ok = m => console.log("  PASS  " + m);
const bad = m => { console.log("  FAIL  " + m); fails++; };
const warn = m => { console.log("  WARN  " + m); warns++; };
const check = (cond, pass, fail) => (cond ? ok(pass) : bad(fail));

const html = read("index.html");
const hasDataDir = exists("data");
if (!hasDataDir) warn("data/ folder not found next to index.html, skipping checks on data/* files (lessons, logos)");

/* 1. Every local file index.html loads exists */
const refs = [...html.matchAll(/(?:src|href)="([^"#?]+)"/g)].map(m => m[1].replace(/^\.\//, ""))
    .filter(r => !/^(https?:|data:|mailto:|tel:|\/\/)/.test(r));
const missing = refs.filter(r => !(r.startsWith("data/") && !hasDataDir) && !exists(r.replace(/^\.\//, "")));
check(missing.length === 0, `all ${refs.length} local files referenced by index.html exist`, "index.html references missing files: " + missing.join(", "));

/* 2. Every file the service worker pre-caches exists */
const sw = read("sw.js");
const swBlock = (sw.match(/const STATIC_ASSETS = \[([\s\S]*?)\];/) || [])[1] || "";
const swFiles = [...swBlock.matchAll(/"\.\/([^"]*)"/g)].map(m => m[1]).filter(f => f);
const swMissing = swFiles.filter(f => !(f.startsWith("data/") && !hasDataDir) && !exists(f));
check(swMissing.length === 0, `all ${swFiles.length} service-worker cache entries exist`, "sw.js caches missing files: " + swMissing.join(", "));

/* 3. Everything index.html loads is also pre-cached (else it breaks offline) */
const loaded = refs.filter(r => /\.(min\.)?(js|css)$/.test(r) && !r.startsWith("data/"));
const notCached = loaded.filter(r => !swFiles.includes(r.replace(/^\.\//, "")));
check(notCached.length === 0, "every script/stylesheet the page loads is in the offline cache", "not in sw.js STATIC_ASSETS (will fail offline): " + notCached.join(", "));

/* 4. JS parses */
for (const f of fs.readdirSync(ROOT).filter(n => n.endsWith(".js") && !n.startsWith("."))) {
    try { new vm.Script(read(f), { filename: f }); ok(f + " parses"); }
    catch (e) { bad(f + " has a syntax error: " + e.message); }
}

/* 5. JSON valid */
for (const f of ["manifest.json", "package.json", "build-manifest.json"]) {
    if (!exists(f)) { bad(f + " is missing"); continue; }
    try { JSON.parse(read(f)); ok(f + " is valid JSON"); } catch (e) { bad(f + " is invalid JSON: " + e.message); }
}

/* 6. CSS braces balanced */
for (const f of ["style.css", "style.min.css"]) {
    const c = read(f).replace(/\/\*[\s\S]*?\*\//g, "");
    check((c.match(/{/g) || []).length === (c.match(/}/g) || []).length, f + " braces balanced", f + " has unbalanced braces");
}

/* 7. Minified build is not stale */
try {
    const man = JSON.parse(read("build-manifest.json"));
    const stale = Object.keys(man).filter(f => sha(read(f)) !== man[f]);
    check(stale.length === 0, "minified files match their sources", "STALE BUILD: you changed " + stale.join(", ") + " but did not run `npm run build`");
} catch (_) { /* reported above */ }

/* 8. Element ids the scripts rely on exist (and none are duplicated) */
const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
check(dup.length === 0, "no duplicate element ids", "duplicate ids in index.html: " + [...new Set(dup)].join(", "));
const wanted = new Set([...read("sync.js").matchAll(/"((?:sd|update)[A-Za-z]+)"/g)].map(m => m[1]));
["updateBanner", "updateBannerBtn", "updateBannerDismiss", "kanjiLessonBar", "kanjiHeader", "kanjiList", "searchDropdown"].forEach(i => wanted.add(i));
const lacking = [...wanted].filter(i => !ids.includes(i));
check(lacking.length === 0, `all ${wanted.size} element ids used by sync/update code exist`, "scripts look for ids missing from index.html: " + lacking.join(", "));

/* 9. Script order: sync must load after app (it wraps store.set) */
const order = refs.filter(r => /\.min\.js$/.test(r));
check(order.indexOf("sync.min.js") > order.indexOf("app.min.js") && order.indexOf("sync.min.js") > order.indexOf("games.min.js"),
    "sync.min.js loads after app/decks/games", "sync.min.js must load after app.min.js, decks.min.js and games.min.js");

/* 10. Content-Security-Policy allows the Supabase host */
const supaHost = (read("sync.js").match(/SUPABASE_URL = "([^"]+)"/) || [])[1];
const csp = (html.match(/Content-Security-Policy"\s*content="([^"]+)"/) || [])[1] || "";
check(!!supaHost && /connect-src[^;]*/.test(csp) && csp.match(/connect-src[^;]*/)[0].includes(supaHost),
    "CSP connect-src allows " + supaHost, "CSP connect-src does not allow " + supaHost + " (sync requests would be blocked)");

/* 11. Leftovers / regressions that already bit once */
const stripComments = t => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "");
check(!/lightRaysCanvas/.test(stripComments(html + read("app.js") + read("style.css"))), "light-rays canvas fully removed (comments ignored)", "lightRaysCanvas still referenced in live code");
check(!/vocab[\s-]?trainer/i.test(html + read("manifest.json") + read("package.json")), 'no "Vocab Trainer" branding', 'found "Vocab Trainer" branding');
check(/RONIN WEB/.test(read("manifest.json")), "manifest uses RONIN WEB", "manifest.json is not branded RONIN WEB");
check(!/localStorage\.clear\(\)/.test(read("decks.js").replace(/else \{[\s\S]*?localStorage\.clear\(\);[\s\S]*?\}/, "")),
    "reset goes through RoninSync (keeps login, clears cloud copy)", "decks.js still calls localStorage.clear() outside the RoninSync fallback");
check(!/skipWaiting\(\)\s*;?\s*\n\s*\}\)\(\)/.test(sw) && /SKIP_WAITING/.test(sw), "service worker waits for the user before updating", "sw.js auto-activates new versions (silent reload risk)");

console.log(`\n${fails ? "FAILED" : "OK"}: ${fails} failure(s), ${warns} warning(s)`);
process.exit(fails ? 1 : 0);
