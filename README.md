# RONIN WEB

Japanese vocabulary PWA (SRS review, quizzes, games, analytics) with optional
cloud sync through Supabase.

## What loads in the browser

`index.html` loads the **minified** files: `style.min.css`, `app.min.js`,
`decks.min.js`, `games.min.js`, `theme-shutter.min.js`, `sync.min.js`, plus the
self-hosted `supabase.min.js`. The readable sources (`style.css`, `app.js`, ...)
are what you edit.

## Everyday workflow

1. Edit a source file (for example `app.js`).
2. `npm run build`  (regenerates the `.min` files and `build-manifest.json`)
3. `npm test`       (sync-logic tests + static checks; fails if you forgot step 2)
4. Bump `CACHE_VERSION` in `sw.js` (otherwise installed copies keep the old version).
5. Upload the folder.

First time only: `npm install`.

## Commands

| Command | What it does |
| --- | --- |
| `npm run build` | Minify JS and CSS |
| `npm test` | sync, structure, search/history/tile tests + static checks (needs no browser) |
| `npm run check-data` | Checks your `data/` folder: file names, letter case, JSON validity, missing fields |
| `npm run smoke` | Opens the site in headless Chrome, checks for errors and blur, saves screenshots to `tests/out/` |
| `npm start` | Local server at http://localhost:3000 |

## Lesson and kanji files (`data/`)

| Level | Lessons | Lesson files | Kanji files |
| --- | --- | --- | --- |
| N5 | 1-25 | `data/n5/lesson1.json` ... `lesson25.json` | `data/n5/kanji-L1.json` ... `kanji-L7.json` |
| N4 | 26-50 | `data/n4/lesson26.json` ... `lesson50.json` | `data/n4/kanji-L8.json` ... `kanji-L26.json` |
| N3 | 1-12 | `data/n3/Lesson1.json` ... `Lesson12.json` (capital L) | none yet |
| N2 | 13-24 | `data/n2/Lesson13.json` ... `Lesson24.json` (capital L) | none yet |

A lesson is identified by level + number, because N3/N2 numbers overlap N5/N4. Letter case matters on a web server, so run `npm run check-data` after adding files.

## Search, history, tiles

- **Search** is local only. It indexes every lesson, every kanji lesson, your decks and the app's sections the first time you click the box (4 files at a time, in the background). It understands kanji, kana, katakana, romaji (`ginkou`) and English, suggests as you type, and forgives a one-letter typo. Nothing is sent anywhere.
- **Back button**: every section you open is a history entry (`#kanji`, `#quiz`, ...), so Back / the phone back gesture / Alt+Left walk back through the sections you visited, and Forward works too.
- **Tiles**: one flat design everywhere (see the "ONE TILE DESIGN" block at the end of `style.css`). Vocab tiles have no top strip and nothing moves on hover.
- **Kanji tile columns**: kanji | meaning + on/kun | example words | speaker + star | strokes. Right-click (or long-press) gives the same menu as vocab.

## Cloud sync in one paragraph

Signed-in devices keep their progress (XP, SRS, decks, heatmap, profile) in one
row of the `user_progress` table. Each push is a compare-and-set on the `rev`
column, so one device can never silently overwrite another: if the cloud
changed, the two versions are merged (union of learned words, highest XP, best
SRS record per word). Everything also stays in `localStorage`, so the app works
fully offline.

## Database (run once in the Supabase SQL Editor)

```sql
alter table public.user_progress add column if not exists rev int not null default 0;
```
