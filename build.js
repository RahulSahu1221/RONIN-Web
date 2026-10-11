// build.js: produces the minified files the site actually loads.
// Usage: npm run build
// Sources (readable, edit these):  app.js decks.js games.js sync.js theme-shutter.js style.css
// Output  (what index.html loads): *.min.js and style.min.css
// Also writes build-manifest.json (hashes of the sources) so `npm test`
// can warn you if you edited a source file and forgot to rebuild.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { minify } = require("terser");
const CleanCSS = require("clean-css");

const JS = ["app.js", "decks.js", "games.js", "sync.js", "theme-shutter.js"];
const CSS = ["style.css"];
const sha = s => crypto.createHash("sha1").update(s).digest("hex");

(async () => {
    const manifest = {};
    let before = 0, after = 0;

    for (const f of JS) {
        const src = fs.readFileSync(path.join(__dirname, f), "utf8");
        /* No `toplevel` option: these are classic scripts that share globals
           (store, $, showToast...), so top-level names must stay intact. */
        const out = await minify(src, { compress: true, mangle: true, format: { comments: false } });
        if (out.error || !out.code) throw out.error || new Error("empty output for " + f);
        const target = f.replace(/\.js$/, ".min.js");
        fs.writeFileSync(path.join(__dirname, target), out.code);
        manifest[f] = sha(src);
        before += src.length; after += out.code.length;
        console.log(`${f.padEnd(18)} ${String(src.length).padStart(7)} -> ${String(out.code.length).padStart(7)}  ${target}`);
    }

    for (const f of CSS) {
        const src = fs.readFileSync(path.join(__dirname, f), "utf8");
        const out = new CleanCSS({ level: 2 }).minify(src);
        if (out.errors.length) throw new Error(out.errors.join("; "));
        const target = f.replace(/\.css$/, ".min.css");
        fs.writeFileSync(path.join(__dirname, target), out.styles);
        manifest[f] = sha(src);
        before += src.length; after += out.styles.length;
        console.log(`${f.padEnd(18)} ${String(src.length).padStart(7)} -> ${String(out.styles.length).padStart(7)}  ${target}`);
    }

    fs.writeFileSync(path.join(__dirname, "build-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    console.log(`\nTotal ${before} -> ${after} bytes (${Math.round(100 - (after / before) * 100)}% smaller)`);
})().catch(e => { console.error("BUILD FAILED:", e.message || e); process.exit(1); });
