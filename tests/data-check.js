// tests/data-check.js: checks your data/ folder against the structure the app expects.
// Usage:  npm run check-data            (checks ./data)
//         node tests/data-check.js path/to/data
//
// It catches the mistakes that fail silently on a web server: wrong letter case
// (lesson1.json vs Lesson1.json), missing dots (kanji-L22json), invalid JSON,
// and lesson/kanji files with missing fields.
"use strict";
const fs = require("fs");
const path = require("path");
const { loadAppBlocks } = require("./lib/extract");

const readJson = file => JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));

function ranges(nums) {
    const out = []; let i = 0;
    while (i < nums.length) {
        let j = i;
        while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
        out.push(i === j ? String(nums[i]) : `${nums[i]}-${nums[j]}`);
        i = j + 1;
    }
    return out.join(", ");
}

function checkLessonFile(file) {
    const raw = readJson(file);
    const list = Array.isArray(raw) ? raw : (raw.vocabulary || raw.words || raw.items);
    if (!Array.isArray(list)) return "has no vocabulary list (expected an array, or an object with vocabulary / words / items)";
    if (list.length === 0) return "contains no words";
    const bad = list.filter(w => !w || typeof w !== "object" || !(w.kanji || w.word || w.hiragana || w.reading || w.meaning || w.english)).length;
    if (bad) return `has ${bad} entr${bad === 1 ? "y" : "ies"} with no kanji / hiragana / meaning`;
    return null;
}

function checkKanjiFile(file, expectedNum, api) {
    const problems = [], notes = [];
    let raw;
    raw = readJson(file);
    let data;
    try { data = api.normalizeKanjiFile(raw, expectedNum); } catch (e) { return { problems: [e.message], notes }; }
    if (!Array.isArray(raw) && Number(raw.lesson) !== expectedNum) problems.push(`"lesson" is ${JSON.stringify(raw.lesson)} but the file name says ${expectedNum}`);
    if (data.kanji.length === 0) problems.push("contains no kanji");
    const seen = new Set();
    const rawList = Array.isArray(raw) ? raw : raw.kanji;
    rawList.forEach((k, i) => {
        const label = `kanji #${i + 1}${k && k.char ? ` (${k.char})` : ""}`;
        if (!k || typeof k.char !== "string" || !k.char) { problems.push(`${label}: missing "char"`); return; }
        if (seen.has(k.char)) problems.push(`${label}: appears twice in this lesson`);
        seen.add(k.char);
        if (!Array.isArray(k.onyomi) || !Array.isArray(k.kunyomi)) problems.push(`${label}: "onyomi" and "kunyomi" must both be lists (use [] when empty)`);
        if (!(Number(k.strokes) > 0)) notes.push(`${label}: no stroke count`);
        if (!Array.isArray(k.examples) || k.examples.length === 0) notes.push(`${label}: no examples`);
        (Array.isArray(k.examples) ? k.examples : []).forEach((e, j) => {
            if (!e || !e.word || !e.reading) problems.push(`${label}: example #${j + 1} needs "word" and "reading"`);
        });
    });
    return { problems, notes };
}

function checkData(dataDir, api) {
    api = api || loadAppBlocks();
    const errors = [], warnings = [], ok = [];
    if (!fs.existsSync(dataDir)) { errors.push(`data folder not found: ${dataDir}`); return { errors, warnings, ok }; }

    for (const key of api.LEVEL_ORDER) {
        const L = api.LEVELS[key];
        const dir = path.join(dataDir, L.dir);
        const tag = `${L.label}`;
        if (!fs.existsSync(dir)) {
            (key === "n1" ? warnings : errors).push(`${tag}: folder data/${L.dir}/ does not exist`);
            continue;
        }
        const entries = fs.readdirSync(dir).filter(n => !n.startsWith(".") && fs.statSync(path.join(dir, n)).isFile());
        const lower = new Map(entries.map(n => [n.toLowerCase(), n]));
        const claimed = new Set();

        /* expected files of one kind (lesson | kanji) */
        const expectFiles = (kind, from, to, nameFor, validate) => {
            const missing = []; let good = 0;
            for (let n = from; n <= to; n++) {
                const want = nameFor(n);
                const have = entries.includes(want) ? want : lower.get(want.toLowerCase());
                if (!have) { missing.push(n); continue; }
                claimed.add(have);
                if (have !== want) { errors.push(`${tag}: found "${have}" but the app looks for "${want}" (letter case matters on web servers)`); continue; }
                try {
                    const msg = validate(path.join(dir, have), n);
                    if (msg && msg.problems) {
                        msg.problems.forEach(p => errors.push(`${tag}: ${have}: ${p}`));
                        msg.notes.forEach(p => warnings.push(`${tag}: ${have}: ${p}`));
                        if (!msg.problems.length) good++;
                    } else if (msg) errors.push(`${tag}: ${have} ${msg}`);
                    else good++;
                } catch (e) { errors.push(`${tag}: ${have} is not valid JSON (${e.message})`); }
            }
            if (good) ok.push(`${tag}: ${good} ${kind} file${good === 1 ? "" : "s"} OK`);
            if (missing.length) warnings.push(`${tag}: no ${kind} file yet for ${kind} ${ranges(missing)}`);
        };

        expectFiles("lesson", L.from, L.to, n => `${L.prefix}${n}.json`, file => checkLessonFile(file));
        if (L.kanji) expectFiles("kanji", L.kanji.from, L.kanji.to, n => `kanji-L${n}.json`, (file, n) => checkKanjiFile(file, n, api));

        /* leftovers: typos, wrong numbers, files the app never reads */
        for (const name of entries) {
            if (claimed.has(name)) continue;
            const m = /^(kanji|lesson)[-_ ]?l?(\d+)/i.exec(name);
            if (m) {
                const kind = m[1].toLowerCase(), num = Number(m[2]);
                const inRange = kind === "lesson" ? api.isValidLesson(key, num) : api.isValidKanjiLesson(key, num);
                const want = kind === "lesson" ? `${L.prefix}${num}.json` : `kanji-L${num}.json`;
                if (inRange) errors.push(`${tag}: "${name}" is not a name the app can load. Did you mean "${want}"? (check the dot and the letter case)`);
                else warnings.push(`${tag}: "${name}" is outside the ${kind} range for ${L.label}, so the app never loads it`);
            } else if (/\.json$/i.test(name)) warnings.push(`${tag}: "${name}" is not used by the app`);
            else warnings.push(`${tag}: ignoring unrecognised file "${name}"`);
        }
    }
    return { errors, warnings, ok };
}

module.exports = { checkData };

if (require.main === module) {
    const dir = path.resolve(process.argv[2] || path.join(__dirname, "..", "data"));
    const { errors, warnings, ok } = checkData(dir);
    console.log(`Checking ${dir}\n`);
    ok.forEach(m => console.log("  OK    " + m));
    warnings.forEach(m => console.log("  WARN  " + m));
    errors.forEach(m => console.log("  FAIL  " + m));
    console.log(`\n${errors.length ? "PROBLEMS FOUND" : "DATA OK"}: ${errors.length} error(s), ${warnings.length} warning(s)`);
    process.exit(errors.length ? 1 : 0);
}
