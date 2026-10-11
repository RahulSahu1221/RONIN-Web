//game.js 

"use strict";

/* ═══════════════════════════════════════════════════════════════════════════════
   GAMES.JS — v4.0 Industrial Rewrite
   Security : XSS-hardened, CSP-safe, zero inline event handlers, zero eval
   Performance : requestAnimationFrame meteor loop, delta-time physics,
                 DocumentFragment batch DOM builds, no per-frame querySelector
   Quality   : consistent micro-animations, zero memory leaks,
                proper AbortController timeouts, ES2020+
   ═══════════════════════════════════════════════════════════════════════════════ */

/* ─── Cross-lesson vocabulary cache ─────────────────────────────────────────
   Loads all lessons (1–50) in parallel with per-fetch AbortController timeout.
   Deduplicates by primary key. Cached after first successful load.
   ─────────────────────────────────────────────────────────────────────────── */
let _allLessonsVocab = null;
let _gameScope = "lesson"; // "lesson" = current lesson only, "all" = every lesson

async function loadAllLessonsVocab(filterFn) {
    // If a filter function was passed in (used by Smart Decks / vocab filter chips),
    // always search across every lesson — it wouldn't make sense to only check
    // "am I weak on this word" against the one lesson currently on screen.
    const needAllLessons = typeof filterFn === "function" || _gameScope === "all";

    let pool;

    if (!needAllLessons) {
        pool = (window.vocabulary && window.vocabulary.length) ? window.vocabulary : [];
    } else if (_allLessonsVocab !== null && _allLessonsVocab.length > 0) {
        pool = _allLessonsVocab;
    } else {
        const BATCH = 6;
        const results = [];
        for (let start = 1; start <= 50; start += BATCH) {
            const batch = [];
            for (let i = start; i < start + BATCH && i <= 50; i++) {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), 5000);
                batch.push(
                    fetch(`data/lesson${i}.json`, { signal: controller.signal })
                        .then(r => { clearTimeout(timer); return r.ok ? r.json() : null; })
                        .catch(() => null)
                );
            }
            const batchResults = await Promise.allSettled(batch);
            results.push(...batchResults);
        }
        const all = [];

        results.forEach(res => {
            if (res.status !== 'fulfilled' || !res.value) return;
            const raw  = res.value;
            const data = Array.isArray(raw) ? raw : (raw.vocabulary || raw.words || raw.items || []);
            if (!Array.isArray(data)) return;
            data.forEach(item => {
                const word = {
                    kanji:    item.kanji    || item.word    || '',
                    hiragana: item.hiragana || item.reading || '',
                    meaning:  item.meaning  || item.english || '',
                    memory:   item.memory   || '',
                    example:  item.example  || '',
                    section:  item.section  || 'Vocabulary',
                    emoji:    item.emoji    || '📘'
                };
                if (wordKey(word) || word.meaning) all.push(word);
            });
        });

        const seen = new Set();
        _allLessonsVocab = all.filter(w => {
            const key = wordKey(w);
            if (!key || seen.has(key)) return false;
            seen.add(key);
            return true;
        });

        pool = _allLessonsVocab;
    }

    return typeof filterFn === "function" ? pool.filter(filterFn) : pool;
}

function _setGameScope(scope) {
    _gameScope = scope;
    const lessonBtn = document.getElementById("gameScopeLessonBtn");
    const allBtn    = document.getElementById("gameScopeAllBtn");
    if (lessonBtn && allBtn) {
        lessonBtn.classList.toggle("active-chip", scope === "lesson");
        allBtn.classList.toggle("active-chip", scope === "all");
        lessonBtn.setAttribute("aria-pressed", String(scope === "lesson"));
        allBtn.setAttribute("aria-pressed", String(scope === "all"));
    }
    if (typeof showToast === "function") {
        showToast(scope === "lesson" ? "🎮 Games will use your current lesson" : "🎮 Games will use all lessons", "success");
    }
}
window.addEventListener("DOMContentLoaded", () => {
    document.getElementById("gameScopeLessonBtn")?.addEventListener("click", () => _setGameScope("lesson"));
    document.getElementById("gameScopeAllBtn")?.addEventListener("click", () => _setGameScope("all"));
});

/* ─── Answer matching ────────────────────────────────────────────────────────
   Exact match only (trimmed, lowercased). Checks comma-separated alternatives.
   Prefix matching removed — caused too many false positives in a vocab game.
   ─────────────────────────────────────────────────────────────────────────── */
function answerMatches(userInput, correctAnswer) {
    if (!userInput || !correctAnswer) return false;
    const u     = userInput.trim().toLowerCase();
    const c     = correctAnswer.trim().toLowerCase();
    if (u === c) return true;
    const uHira = typeof normalizeRomaji === 'function' ? normalizeRomaji(u) : u;
    if (uHira === c) return true;
    return c.split(',').map(p => p.trim().toLowerCase()).some(p => p === u || p === uHira);
}

/* ─── Unique shuffled pool ───────────────────────────────────────────────────
   Returns up to maxCount unique (by key) items, gracefully handles small sets.
   ─────────────────────────────────────────────────────────────────────────── */
function getShuffledUniquePool(sourceArray, maxCount) {
    if (!Array.isArray(sourceArray) || sourceArray.length === 0) return [];
    const pool   = shuffleArray([...sourceArray]);
    const seen   = new Set();
    const result = [];
    for (const item of pool) {
        const key = wordKey(item);
        if (key && !seen.has(key)) {
            seen.add(key);
            result.push(item);
            if (result.length >= maxCount) break;
        }
    }
    return result;
}

/* ═══════════════════════════════════════════════════════════════════════════════
   GAME STATE — single source of truth, no window.* pollution
   ═══════════════════════════════════════════════════════════════════════════════ */
const GS = {
    conc:  { cards: [], flipped: [], matched: [], moves: 0, timer: null, elapsed: 0 },
    meteor:{ score: 0, lives: 3, level: 1, active: false, rafId: null, lastTime: 0, _pool: [], _poolIdx: 0, _usedKeys: new Set(), _spawnTimer: null },
    shir:  { current: null, score: 0, chain: 0, used: new Set(), target: 10, active: false, _pool: [] },
    mock:  { questions: [], current: 0, answers: {}, flagged: new Set(), timer: null, timeLeft: 300 }
};

// Module-level (not window.*) active meteor words
let _meteorWords  = [];
// Module-level concentration lock (replaces window._concLocked)
let _concLocked   = false;

/* ─── Micro-animation helpers ────────────────────────────────────────────────*/
function popIn(el, delay = 0) {
    if (!el) return;
    el.style.transition = 'none';
    el.style.transform  = 'scale(0.6)';
    el.style.opacity    = '0';
    setTimeout(() => {
        el.style.transition = 'transform 0.38s cubic-bezier(0.34,1.56,0.64,1), opacity 0.25s ease';
        el.style.transform  = '';
        el.style.opacity    = '';
    }, delay);
}

function wiggle(el) {
    if (!el) return;
    el.classList.remove('game-wiggle');
    void el.offsetWidth;
    el.classList.add('game-wiggle');
    setTimeout(() => el.classList.remove('game-wiggle'), 500);
}

function flashScore(el) {
    if (!el) return;
    el.classList.remove('score-flash');
    void el.offsetWidth;
    el.classList.add('score-flash');
    setTimeout(() => el.classList.remove('score-flash'), 400);
}

/* ─── Inject game micro-animation CSS (idempotent) ───────────────────────────*/
(function injectGameStyles() {
    if (document.getElementById('game-micro-styles')) return;
    const s  = document.createElement('style');
    s.id     = 'game-micro-styles';
    s.textContent = `
        @keyframes game-wiggle-kf {
            0%,100%{ transform:translateX(0) rotate(0deg); }
            20%    { transform:translateX(-5px) rotate(-3deg); }
            40%    { transform:translateX(5px)  rotate(3deg); }
            60%    { transform:translateX(-4px) rotate(-2deg); }
            80%    { transform:translateX(4px)  rotate(2deg); }
        }
        .game-wiggle { animation: game-wiggle-kf 0.5s ease both !important; }

        @keyframes score-flash-kf {
            0%  { transform:scale(1); }
            40% { transform:scale(1.35); color:var(--accent2); }
            100%{ transform:scale(1); }
        }
        .score-flash { animation: score-flash-kf 0.4s ease both !important; }

        @keyframes meteor-drop-in {
            from { opacity:0; transform:translateX(-50%) translateY(-20px) scale(0.7); }
            to   { opacity:1; transform:translateX(-50%) translateY(0)     scale(1); }
        }
        .meteor-kanji-entering { animation: meteor-drop-in 0.28s cubic-bezier(0.34,1.56,0.64,1) both; }

        @keyframes meteor-explode-kf {
            0%  { opacity:1; transform:translateX(-50%) scale(1); }
            50% { opacity:.5; transform:translateX(-50%) scale(1.9); }
            100%{ opacity:0; transform:translateX(-50%) scale(0); }
        }
        .meteor-explode .meteor-kanji { animation: meteor-explode-kf 0.45s ease forwards !important; }

        @keyframes meteor-impact-kf {
            0%  { transform:translateX(-50%) scale(1); }
            50% { transform:translateX(-50%) scale(1.3) rotate(-8deg); background:rgba(248,113,113,0.6); }
            100%{ transform:translateX(-50%) scale(0); opacity:0; }
        }
        .meteor-impact .meteor-kanji { animation: meteor-impact-kf 0.35s ease forwards !important; }

        @keyframes life-lost-kf {
            0%,100%{ transform:scale(1); }
            50%    { transform:scale(1.5); filter:drop-shadow(0 0 6px var(--danger)); }
        }
        .life-lost { animation: life-lost-kf 0.4s ease both; }

        @keyframes blast-press-kf {
            0%  { transform:scale(1); }
            40% { transform:scale(0.88); }
            100%{ transform:scale(1); }
        }
        .blast-press { animation: blast-press-kf 0.2s ease both; }

        @keyframes conc-match-kf {
            0%  { transform:scale(1); }
            50% { transform:scale(1.12); filter:drop-shadow(0 0 10px var(--success)); }
            100%{ transform:scale(1); }
        }
        .conc-match-anim { animation: conc-match-kf 0.45s ease both; }

        @keyframes shir-chain-kf {
            0%  { transform:scale(1) rotate(0); }
            40% { transform:scale(1.2) rotate(-4deg); }
            70% { transform:scale(0.95) rotate(2deg); }
            100%{ transform:scale(1) rotate(0); }
        }
        .shir-chain-anim { animation: shir-chain-kf 0.4s cubic-bezier(0.34,1.56,0.64,1) both; }

        @keyframes mock-slide-kf {
            from { opacity:0; transform:translateX(20px); }
            to   { opacity:1; transform:translateX(0); }
        }
        .mock-slide-in { animation: mock-slide-kf 0.25s cubic-bezier(0.34,1.56,0.64,1) both; }

        @keyframes game-card-enter-kf {
            from { opacity:0; transform:translateY(24px) scale(0.95); }
            to   { opacity:1; transform:translateY(0)    scale(1);    }
        }

        .meteor-field {
            background:
                radial-gradient(ellipse at top, rgba(96,165,250,0.06) 0%, transparent 60%),
                linear-gradient(180deg, rgba(0,0,0,0.32) 0%, rgba(0,0,0,0.04) 100%);
        }
        .game-card {
            transition: transform 0.28s cubic-bezier(0.34,1.56,0.64,1),
                        box-shadow 0.28s ease !important;
        }
        .game-card:hover  { transform: translateY(-10px) scale(1.03) !important; }
        .game-card:active { transform: scale(0.97) !important; transition-duration:0.1s !important; }

        .mock-option {
            transition: background 0.15s, border-color 0.15s,
                        transform 0.22s cubic-bezier(0.34,1.56,0.64,1) !important;
        }
        .mock-option:not([disabled]):hover {
            transform: translateX(6px) scale(1.01) !important;
        }
        #concentrationGrid .conc-card {
            transition: transform 0.2s cubic-bezier(0.34,1.56,0.64,1) !important;
        }
        #concentrationGrid .conc-card:hover:not(.flipped):not(.matched) {
            transform: scale(1.07) !important;
        }
        .meteor-input-row .nav-btn:active {
            transform: scale(0.91) !important;
            transition-duration: 0.08s !important;
        }
    `;
    document.head.appendChild(s);
})();
// Ensure overlay click-outside cleanup fires closeGame for all game overlays
document.addEventListener("DOMContentLoaded", () => {
    const gameOverlayMap = {
        concentrationOverlay: "concentration",
        meteorOverlay:        "meteor",
        shiritorOverlay:      "shiritori",
        mockTestOverlay:      "mocktest"
    };
    Object.entries(gameOverlayMap).forEach(([overlayId, gameType]) => {
        const el = document.getElementById(overlayId);
        if (!el) return;
        el.addEventListener("click", e => {
            if (e.target === el) closeGame(gameType);
        });
    });
});

/* ═══════════════════════════════════════════════════════════════════════════════
   closeGame — unified cleanup, no leaks
   ═══════════════════════════════════════════════════════════════════════════════ */
function closeGame(type) {
    const overlayMap = {
        concentration: 'concentrationOverlay',
        meteor:        'meteorOverlay',
        shiritori:     'shiritorOverlay',
        mocktest:      'mockTestOverlay'
    };

    switch (type) {
        case 'meteor':
            GS.meteor.active = false;
            if (GS.meteor.rafId !== null) {
                cancelAnimationFrame(GS.meteor.rafId);
                GS.meteor.rafId = null;
            }
            if (GS.meteor._spawnTimer !== null) {
                clearTimeout(GS.meteor._spawnTimer);
                GS.meteor._spawnTimer = null;
            }
            _meteorWords = [];
            document.getElementById('meteorField')?.replaceChildren();
            break;

        case 'concentration':
            if (GS.conc.timer) { clearInterval(GS.conc.timer); GS.conc.timer = null; }
            _concLocked = false;
            break;

        case 'mocktest':
            if (GS.mock.timer) { clearInterval(GS.mock.timer); GS.mock.timer = null; }
            break;

        case 'shiritori':
            GS.shir.active = false;
            const lenSel = document.getElementById('shirLengthSelect');
            if (lenSel) { lenSel.disabled = false; lenSel.title = ''; }
            break;
    }

    closeModal(overlayMap[type] || '');
}
window.closeGame = closeGame;

/* ═══════════════════════════════════════════════════════════════════════════════
   GAMES HUB
   ═══════════════════════════════════════════════════════════════════════════════ */
const GAME_RULES_CONFIG = {
    concentration: {
        title: "Memory Match",
        desc: "Flip cards to pair Kanji with their meanings. Train visual memory!",
        objective: "Find all matching pairs of Kanji and their English meanings.",
        rules: [
            "You can flip two cards at a time.",
            "If the Kanji matches the meaning, they stay face up.",
            "If they don't match, they flip back over."
        ],
        winCondition: "Match every single card on the board in the fewest moves possible.",
        tips: "Try to remember the position of cards even when they don't match."
    },
    meteor: {
        title: "Kanji Meteor",
        desc: "Words fall from above — type meanings before they hit the ground!",
        objective: "Prevent the falling Kanji meteors from hitting the ground by typing their readings or meanings.",
        rules: [
            "Meteors will fall from the top of the screen.",
            "Type the correct reading (Romaji) or English meaning into the input box.",
            "Press Enter or Space to submit your answer.",
            "Correct answers destroy the meteor."
        ],
        winCondition: "Survive as long as possible and earn the highest score.",
        tips: "Focus on accuracy first; speed comes naturally!"
    },
    shiritori: {
        title: "Word Chain",
        desc: "Chain vocab words by starting kana. Build combos for bonus points!",
        objective: "Create a continuous chain of Japanese words where the next word starts with the last Kana of the previous word.",
        rules: [
            "The system gives you a starting word.",
            "You must select a word that starts with the last Kana of the previous word.",
            "Words ending in 'ん' (n) cannot be used.",
            "A word cannot be used twice."
        ],
        winCondition: "Build the longest chain possible within the time limit.",
        tips: "Look ahead at the ending kana of the word you are about to pick!"
    },
    mockTest: {
        title: "JLPT Mock Test",
        desc: "20 questions, 5-minute timer, flagging system. Simulate the real JLPT!",
        objective: "Test your knowledge under simulated exam conditions.",
        rules: [
            "You have a strict 5-minute time limit.",
            "There are 20 multiple-choice questions.",
            "You can flag questions to review them later.",
            "You can navigate freely between questions."
        ],
        winCondition: "Finish all questions before the timer runs out and score as high as possible.",
        tips: "Don't get stuck on one question; flag it and come back later."
    }
};

let _pendingGameFn = null;

        function renderGamesHub() {
    const hub = document.getElementById('gamesHubGrid');
    if (!hub) return;

    const games = [
        { id: 'concentration', emoji: '🎴', title: 'Memory Match',   desc: 'Flip cards to pair Kanji with their meanings. Train visual memory!',     color: 'var(--accent)',  fn: startConcentration },
        { id: 'meteor',        emoji: '☄️', title: 'Kanji Meteor',   desc: 'Words fall from above — type meanings before they hit the ground!',      color: 'var(--danger)',  fn: startMeteor        },
        { id: 'shiritori',     emoji: '🔗', title: 'Word Chain',     desc: 'Chain vocab words by starting kana. Build combos for bonus points!',     color: 'var(--success)', fn: startShiritori     },
        { id: 'mockTest',      emoji: '📝', title: 'JLPT Mock Test', desc: '20 questions, 5-minute timer, flagging system. Simulate the real JLPT!', color: 'var(--accent2)', fn: startMockTest      }
    ];

    hub.replaceChildren();

    games.forEach((g, idx) => {
        const card = document.createElement('div');
        card.className  = 'game-card';
        card.setAttribute('role', 'button');
        card.setAttribute('tabindex', '0');
        card.setAttribute('aria-label', `Play ${g.title}`);
        card.style.setProperty('--game-color', g.color);
        card.style.animation = `game-card-enter-kf 0.45s cubic-bezier(0.34,1.56,0.64,1) ${idx * 90}ms both`;

        const emojiEl  = document.createElement('div');
        emojiEl.className   = 'game-card-emoji';
        emojiEl.textContent = g.emoji;

        const titleEl  = document.createElement('div');
        titleEl.className   = 'game-card-title';
        titleEl.textContent = g.title;

        const descEl   = document.createElement('div');
        descEl.className   = 'game-card-desc';
        descEl.textContent = g.desc;

        const playEl   = document.createElement('span');
        playEl.className   = 'game-card-play';
        playEl.textContent = 'Play ▶';

        card.append(emojiEl, titleEl, descEl, playEl);
        
        const launchRules = () => {
            const config = GAME_RULES_CONFIG[g.id];
            if (!config) return;
            
            _pendingGameFn = g.fn;
            
            const titleEl = document.getElementById('rulesTitle');
            const descEl = document.getElementById('rulesDesc');
            const objEl = document.getElementById('rulesObjective');
            const listEl = document.getElementById('rulesList');
            const winEl = document.getElementById('rulesWin');
            const tipsEl = document.getElementById('rulesTips');
            const tipsWrap = document.getElementById('rulesTipsWrap');
            
            if (titleEl) titleEl.textContent = config.title;
            if (descEl) descEl.textContent = config.desc;
            if (objEl) objEl.textContent = config.objective;
            if (winEl) winEl.textContent = config.winCondition;
            
            if (listEl) {
                listEl.innerHTML = '';
                config.rules.forEach(r => {
                    const li = document.createElement('li');
                    li.textContent = r;
                    listEl.appendChild(li);
                });
            }
            
            if (config.tips && tipsEl && tipsWrap) {
                tipsEl.textContent = config.tips;
                tipsWrap.style.display = 'block';
            } else if (tipsWrap) {
                tipsWrap.style.display = 'none';
            }
            
            window.openModal?.('rulesOverlay');
        };

        card.addEventListener('click', launchRules);
        card.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); launchRules(); }
        });
        hub.appendChild(card);
    });
}
window.renderGamesHub = renderGamesHub;

window.addEventListener('DOMContentLoaded', () => {
    const cancelBtn = document.getElementById('rulesCancelBtn');
    const startBtn = document.getElementById('rulesStartBtn');
    
    if (cancelBtn) {
        cancelBtn.addEventListener('click', () => {
            window.closeModal?.('rulesOverlay');
            _pendingGameFn = null;
        });
    }
    
    if (startBtn) {
        startBtn.addEventListener('click', () => {
            window.closeModal?.('rulesOverlay');
            if (typeof _pendingGameFn === 'function') {
                _pendingGameFn();
            }
            _pendingGameFn = null;
        });
    }
});

/* ═══════════════════════════════════════════════════════════════════════════════
   GAME 1 — MEMORY MATCH (CONCENTRATION)
   ═══════════════════════════════════════════════════════════════════════════════ */
function startConcentration() {
    loadAllLessonsVocab().then(allVocab => {
        const pool = (allVocab && allVocab.length) ? allVocab : (vocabulary || []);
        if (!pool.length) { showToast('No vocabulary available!', 'error'); return; }

        const s   = GS.conc;
        s.moves   = 0;
        s.flipped = [];
        s.matched = [];
        s.elapsed = 0;
        if (s.timer) { clearInterval(s.timer); s.timer = null; }
        _concLocked = false;

        const words = getShuffledUniquePool(pool, 8);
        const pairs = [];
        words.forEach((w, i) => {
            pairs.push({ pairId: i, type: 'kanji',   text: wordKey(w) });
            pairs.push({ pairId: i, type: 'meaning', text: (w.meaning || '').split(',')[0].trim() });
        });
        s.cards = shuffleArray(pairs);

        const grid = document.getElementById('concentrationGrid');
        if (!grid) return;
        grid.replaceChildren();

        s.cards.forEach((c, idx) => {
            const cell  = document.createElement('div');
            cell.className = 'conc-card';
            cell.id        = `cc${idx}`;
            cell.setAttribute('role', 'button');
            cell.setAttribute('tabindex', '0');
            cell.setAttribute('aria-label', 'Memory card — click to flip');

            const inner = document.createElement('div');
            inner.className = 'conc-card-inner';

            const front = document.createElement('div');
            front.className   = 'conc-card-front';
            front.textContent = '?';
            front.setAttribute('aria-hidden', 'true');

            const back    = document.createElement('div');
            back.className = 'conc-card-back';
            const textEl  = document.createElement('span');
            textEl.className   = c.type === 'kanji' ? 'conc-kanji' : 'conc-meaning';
            textEl.textContent = c.text;   // Safe — textContent
            back.appendChild(textEl);

            inner.append(front, back);
            cell.appendChild(inner);

            cell.addEventListener('click',   () => flipConcCard(idx));
            cell.addEventListener('keydown', e => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flipConcCard(idx); }
            });

            grid.appendChild(cell);
            popIn(cell, idx * 45);
        });

        requestAnimationFrame(() => {
            grid.querySelectorAll('.conc-card-back > span').forEach(autoFitText);
        });

        const movesEl   = document.getElementById('concMoves');
        const matchesEl = document.getElementById('concMatches');
        const timerEl   = document.getElementById('concTimer');
        if (movesEl)   movesEl.textContent   = 'Moves: 0';
        if (matchesEl) matchesEl.textContent = `Matches: 0/${words.length}`;
        if (timerEl)   timerEl.textContent   = '0:00';

        s.timer = setInterval(() => {
            s.elapsed++;
            const m   = Math.floor(s.elapsed / 60);
            const sec = s.elapsed % 60;
            const el  = document.getElementById('concTimer');
            if (el) el.textContent = `${m}:${String(sec).padStart(2, '0')}`;
        }, 1000);

        window.openModal?.('concentrationOverlay');

    }).catch(err => {
        console.error('[Games] startConcentration:', err);
        showToast('Could not load vocabulary.', 'error');
    });
}
window.startConcentration = startConcentration;

/* ─── Auto-fit text inside a fixed concentration card ───────────────────────*/
function autoFitText(el) {
    if (!el || !el.parentElement) return;
    const container = el.parentElement;
    let lo = 8, hi = 22;
    el.style.fontSize = `${hi}px`;
    void container.offsetHeight;
    if (el.scrollWidth <= container.clientWidth && el.scrollHeight <= container.clientHeight) return;
    while (lo < hi) {
        const mid = Math.floor((lo + hi + 1) / 2);
        el.style.fontSize = `${mid}px`;
        void el.offsetWidth;
        if (el.scrollWidth <= container.clientWidth && el.scrollHeight <= container.clientHeight) {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    el.style.fontSize = `${lo}px`;
}
window.autoFitText = autoFitText;

function flipConcCard(idx) {
    if (_concLocked) return;
    const s    = GS.conc;
    const card = s.cards[idx];
    if (!card || s.matched.includes(idx) || s.flipped.includes(idx)) return;

    const el = document.getElementById(`cc${idx}`);
    if (!el) return;
    el.classList.add('flipped');
    el.setAttribute('aria-label', `Card face: ${card.text}`);
    s.flipped.push(idx);

    if (s.flipped.length !== 2) return;

    s.moves++;
    const movesEl = document.getElementById('concMoves');
    if (movesEl) movesEl.textContent = `Moves: ${s.moves}`;
    _concLocked = true;

    const [a, b] = s.flipped;
    setTimeout(() => {
        if (s.cards[a].pairId === s.cards[b].pairId) {
            const elA = document.getElementById(`cc${a}`);
            const elB = document.getElementById(`cc${b}`);
            elA?.classList.add('matched', 'conc-match-anim');
            elB?.classList.add('matched', 'conc-match-anim');
            elA?.setAttribute('aria-label', `Matched: ${s.cards[a].text}`);
            elB?.setAttribute('aria-label', `Matched: ${s.cards[b].text}`);
            s.matched.push(a, b);

            const matchesEl = document.getElementById('concMatches');
            if (matchesEl) {
                matchesEl.textContent = `Matches: ${s.matched.length / 2}/${s.cards.length / 2}`;
                flashScore(matchesEl);
            }
            haptic([20, 20, 40]);

            if (s.matched.length === s.cards.length) {
                clearInterval(s.timer);
                s.timer      = null;
                const xpEarn = Math.max(20, 200 - s.moves * 5);
                addXP(xpEarn, 'Memory Match complete! 🎴');
                setTimeout(() => {
                    showToast(`🎉 All pairs matched! ${s.moves} moves · +${xpEarn} XP`, 'success');
                    haptic([50, 50, 100, 50, 200]);
                }, 300);
            }
        } else {
            const elA = document.getElementById(`cc${a}`);
            const elB = document.getElementById(`cc${b}`);
            wiggle(elA); wiggle(elB);
            setTimeout(() => {
                elA?.classList.remove('flipped');
                elB?.classList.remove('flipped');
                elA?.setAttribute('aria-label', 'Memory card — click to flip');
                elB?.setAttribute('aria-label', 'Memory card — click to flip');
            }, 320);
            haptic(30);
        }
        s.flipped   = [];
        _concLocked = false;
    }, 900);
}
window.flipConcCard = flipConcCard;

/* ═══════════════════════════════════════════════════════════════════════════════
   GAME 2 — KANJI METEOR  (requestAnimationFrame, delta-time physics)
   ═══════════════════════════════════════════════════════════════════════════════ */
const METEOR_WORD_WIDTH = 110;  // px reserved horizontally per word
const METEOR_MIN_GAP    = 18;   // px minimum horizontal gap between words

function _getMeteorOccupiedSlots(fieldWidth) {
    return _meteorWords.map(m => {
        const lPx = (m.xPct / 100) * fieldWidth;
        return { left: lPx - METEOR_WORD_WIDTH / 2, right: lPx + METEOR_WORD_WIDTH / 2 };
    });
}

function _pickSafeXPct(fieldWidth) {
    const margin    = (METEOR_WORD_WIDTH / fieldWidth) * 50 + 2;
    const slots     = _getMeteorOccupiedSlots(fieldWidth);
    const MAX_TRIES = 30;
    for (let t = 0; t < MAX_TRIES; t++) {
        const pct  = margin + Math.random() * (100 - margin * 2);
        const lPx  = (pct / 100) * fieldWidth;
        const newL = lPx - METEOR_WORD_WIDTH / 2;
        const newR = lPx + METEOR_WORD_WIDTH / 2;
        if (!slots.some(s => newL < s.right + METEOR_MIN_GAP && newR > s.left - METEOR_MIN_GAP)) {
            return pct;
        }
    }
    return null;
}

function startMeteor() {
    loadAllLessonsVocab().then(allVocab => {
        const pool = (allVocab && allVocab.length) ? allVocab : (vocabulary || []);
        if (!pool.length) { showToast('No vocabulary available!', 'error'); return; }

        const s       = GS.meteor;
        s.score       = 0;
        s.lives       = 3;
        s.level       = 1;
        s.active      = true;
        s._cachedField = null; // reset cache on new game start
        s._usedKeys   = new Set();
        s._pool       = shuffleArray([...pool]);
        s._poolIdx    = 0;

        // Cancel any existing loop / spawn timer
        if (s.rafId !== null)       { cancelAnimationFrame(s.rafId); s.rafId = null; }
        if (s._spawnTimer !== null) { clearTimeout(s._spawnTimer);   s._spawnTimer = null; }
        _meteorWords = [];

        const field = document.getElementById('meteorField');
        if (field) field.replaceChildren();

        const scoreEl = document.getElementById('meteorScore');
        const livesEl = document.getElementById('meteorLives');
        const levelEl = document.getElementById('meteorLevel');
        if (scoreEl) scoreEl.textContent = 'Score: 0';
        if (livesEl) livesEl.textContent = '❤️❤️❤️';
        if (levelEl) levelEl.textContent = 'Lv.1';

        window.openModal?.('meteorOverlay');
        const inputEl = document.getElementById('meteorInput');
        if (inputEl) { inputEl.value = ''; inputEl.focus(); }

        _bindMeteorInput();
        _spawnMeteorWord();
        s._spawnTimer = setTimeout(_meteorSpawnLoop, _meteorSpawnDelay());
        s.lastTime    = performance.now();
        s.rafId       = requestAnimationFrame(_meteorFrame);

    }).catch(err => {
        console.error('[Games] startMeteor:', err);
        showToast('Could not load vocabulary.', 'error');
    });
}
window.startMeteor = startMeteor;

function _meteorSpawnDelay() {
    return Math.max(1200, 3000 - GS.meteor.level * 180);
}

function _meteorSpawnLoop() {
    if (!GS.meteor.active) return;
    _spawnMeteorWord();
    GS.meteor._spawnTimer = setTimeout(_meteorSpawnLoop, _meteorSpawnDelay());
}

function _spawnMeteorWord() {
    const s    = GS.meteor;
    if (!s.active || _meteorWords.length >= 5) return;

    const field = document.getElementById('meteorField');
    if (!field) return;
    const fw   = field.clientWidth || 400;
    const xPct = _pickSafeXPct(fw);
    if (xPct === null) return;

    // Pick next unique word from pool
    const pool = s._pool;
    let w = null;
    for (let tries = 0; tries < pool.length; tries++) {
        const candidate = pool[s._poolIdx % pool.length];
        s._poolIdx++;
        const key = wordKey(candidate);
        if (key && !s._usedKeys.has(key)) { s._usedKeys.add(key); w = candidate; break; }
    }
    if (!w) {
        s._usedKeys.clear();
        w = pool[Math.floor(Math.random() * pool.length)];
        if (!w) return;
    }

    const wordEl  = document.createElement('div');
    wordEl.className  = 'meteor-word';
    wordEl.style.cssText = `position:absolute; left:${xPct}%; top:-64px; transform:translateX(-50%);`;

    const label   = document.createElement('div');
    label.className   = 'meteor-kanji meteor-kanji-entering';
    label.textContent = wordKey(w); // Safe — textContent
    wordEl.appendChild(label);
    field.appendChild(wordEl);

    _meteorWords.push({ word: w, el: wordEl, y: -64, xPct, speed: 0.30 + s.level * 0.05 });
}

/* ─── rAF-based meteor physics loop ─────────────────────────────────────────*/
function _meteorFrame(timestamp) {
    const s = GS.meteor;
    if (!s.active) return;

    // Cap delta at 50 ms to survive tab-switch resumption
    const dt     = Math.min(timestamp - s.lastTime, 50);
    s.lastTime   = timestamp;

    const field  = s._cachedField || (s._cachedField = document.getElementById('meteorField'));
    const fieldH = field ? (field.clientHeight || 310) : 310;

    for (let i = _meteorWords.length - 1; i >= 0; i--) {
        const m = _meteorWords[i];
        m.y += m.speed * (dt / 16.667); // normalise to 60 fps
        m.el.style.top = `${m.y}px`;

        if (m.y >= fieldH - 48) {
            m.el.classList.add('meteor-impact');
            const dead = m.el;
            setTimeout(() => dead.remove(), 380);
            _meteorWords.splice(i, 1);

            s.lives--;
            _updateMeteorLives(s.lives);
            haptic(40);

            const livesEl = document.getElementById('meteorLives');
            if (livesEl) {
                livesEl.classList.remove('life-lost');
                void livesEl.offsetWidth;
                livesEl.classList.add('life-lost');
                setTimeout(() => livesEl.classList.remove('life-lost'), 420);
            }

            if (s.lives <= 0) {
                s.active      = false;
                s.rafId       = null;
                clearTimeout(s._spawnTimer);
                s._spawnTimer = null;
                const xp = Math.floor(s.score / 2);
                if (xp > 0) addXP(xp, 'Kanji Meteor!');
                setTimeout(() => {
                    showToast(`💥 Game Over! Score: ${s.score}${xp ? ` · +${xp} XP` : ''}`, 'success');
                    closeGame('meteor');
                }, 600);
                return; // Stop — no further rAF scheduled
            }
        }
    }

    // Level-up check
    const newLevel = Math.min(8, 1 + Math.floor(s.score / 8));
    if (newLevel > s.level) {
        s.level = newLevel;
        const lvEl = document.getElementById('meteorLevel');
        if (lvEl) { lvEl.textContent = `Lv.${s.level}`; flashScore(lvEl); }
        showToast(`⬆️ Level ${s.level}!`, 'success');
        haptic([20, 30, 60]);
    }

    s.rafId = requestAnimationFrame(_meteorFrame);
}

function _updateMeteorLives(lives) {
    const el = document.getElementById('meteorLives');
    if (!el) return;
    const hearts = ['💀', '❤️', '❤️❤️', '❤️❤️❤️'];
    el.textContent = hearts[Math.max(0, Math.min(3, lives))];
}

/* ─── Meteor answer check ────────────────────────────────────────────────────*/
function checkMeteorInput() {
    const s = GS.meteor;
    if (!s.active) return;

    const inputEl = document.getElementById('meteorInput');
    if (!inputEl) return;
    const val = inputEl.value.trim();
    if (!val) return;

    const valLow  = val.toLowerCase();
    const valHira = typeof normalizeRomaji === 'function' ? normalizeRomaji(valLow) : valLow;
    const field   = document.getElementById('meteorField');
    let   hit     = false;

    for (let i = _meteorWords.length - 1; i >= 0; i--) {
        const m         = _meteorWords[i];
        const w         = m.word;
        const allAnswers = [
            ...(w.meaning || '').split(',').map(x => x.trim()).filter(Boolean),
            w.hiragana || '',
            w.kanji    || ''
        ].filter(Boolean);

        if (allAnswers.some(ans => answerMatches(val, ans) || answerMatches(valHira, ans))) {
            s.score++;
            const scoreEl = document.getElementById('meteorScore');
            if (scoreEl) { scoreEl.textContent = `Score: ${s.score}`; flashScore(scoreEl); }

            m.el.classList.add('meteor-explode');

            if (field) {
                const fx       = document.createElement('div');
                fx.className   = 'meteor-hit-fx';
                fx.textContent = '+1 ✓'; // Safe
                fx.style.cssText = `left:${m.el.style.left}; top:${m.y - 12}px; transform:translateX(-50%);`;
                field.appendChild(fx);
                setTimeout(() => fx.remove(), 750);
            }

            const dead = m.el;
            setTimeout(() => dead.remove(), 460);
            _meteorWords.splice(i, 1);
            hit = true;
            haptic(15);
            addXP(4, 'Kanji Meteor hit!');
            break;
        }
    }

    if (!hit) wiggle(document.getElementById('meteorInput'));
    inputEl.value = '';
}
window.checkMeteorInput = checkMeteorInput;

function _bindMeteorInput() {
    const inputEl  = document.getElementById('meteorInput');
    const submitEl = document.getElementById('meteorSubmit');
    if (!inputEl || !submitEl) return;

    // Clone nodes to strip all pre-existing listeners
    const ni = inputEl.cloneNode(true);
    const ns = submitEl.cloneNode(true);
    inputEl.replaceWith(ni);
    ni.value = '';
    submitEl.replaceWith(ns);

    ni.addEventListener('keydown', e => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        ns.classList.add('blast-press');
        setTimeout(() => ns.classList.remove('blast-press'), 200);
        checkMeteorInput();
    });
    ns.addEventListener('click', () => {
        ns.classList.add('blast-press');
        setTimeout(() => ns.classList.remove('blast-press'), 200);
        checkMeteorInput();
    });
}

/* ═══════════════════════════════════════════════════════════════════════════════
   GAME 3 — WORD CHAIN (SHIRITORI)
   ═══════════════════════════════════════════════════════════════════════════════ */
function startShiritori() {
    const originalScope = _gameScope;
    _gameScope = 'all';
    loadAllLessonsVocab().then(allVocab => {
        _gameScope = originalScope;
        const pool = (_gameScope === 'all' && allVocab && allVocab.length) ? allVocab : (vocabulary || []);
        if (!pool.length) { showToast('No vocabulary available!', 'error'); return; }

        const s   = GS.shir;
        s.score   = 0;
        s.chain   = 0;
        s.used    = new Set();
        s._pool   = pool;
        s.active  = true;

        const lenSel = document.getElementById('shirLengthSelect');
        s.target     = lenSel ? (parseInt(lenSel.value, 10) || 10) : 10;

        const startWord = pool[Math.floor(Math.random() * pool.length)];
        s.current       = startWord;
        s.used.add(wordKey(startWord));

        const scoreEl  = document.getElementById('shirScore');
        const chainEl  = document.getElementById('shirChain');
        const targetEl = document.getElementById('shirTarget');
        const fbEl     = document.getElementById('shirFeedback');
        if (scoreEl)  scoreEl.textContent  = 'Score: 0';
        if (chainEl)  chainEl.textContent  = 'Chain: 0';
        if (targetEl) targetEl.textContent = `Target: ${s.target}`;
        if (fbEl)     fbEl.textContent     = '';

        _renderShiritoriWord(false);
        window.openModal?.('shiritorOverlay');

        // Clone inputs to strip stale listeners
        const si = document.getElementById('shirInput');
        const ss = document.getElementById('shirSubmit');
        const eb = document.getElementById('shirEndBtn');
        const ls = document.getElementById('shirLengthSelect');

        if (si && ss) {
            const ni = si.cloneNode(true);
            const ns = ss.cloneNode(true);
            si.replaceWith(ni); ss.replaceWith(ns);
            ni.value = '';
            ni.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); checkShiritori(); } });
            ns.addEventListener('click',   checkShiritori);
            setTimeout(() => ni.focus(), 150);
        }
        if (eb) {
            const ne = eb.cloneNode(true);
            eb.replaceWith(ne);
            ne.addEventListener('click', () => finishShiritori('manual'));
        }
        if (ls) { ls.value = String(s.target); ls.disabled = true; ls.title = 'Change takes effect next round'; }
        window.refreshGlassSelect?.("shirLengthSelect");

    }).catch(err => {
        console.error('[Games] startShiritori:', err);
        showToast('Could not load vocabulary.', 'error');
    });
}
window.startShiritori = startShiritori;

function _getLastKana(hira) {
    return (hira || '').trim().slice(-1);
}

function _renderShiritoriWord(animate) {
    const s    = GS.shir;
    if (!s.current) return;
    const w    = s.current;
    const disp = document.getElementById('shirDisplay');
    if (!disp) return;

    // Build purely with DOM — no innerHTML
    disp.replaceChildren();

    const kanjiEl  = document.createElement('div');
    kanjiEl.className   = `shir-kanji${animate ? ' shir-chain-anim' : ''}`;
    kanjiEl.textContent = wordKey(w);

    const hiraEl   = document.createElement('div');
    hiraEl.className   = 'shir-hira';
    hiraEl.textContent = w.hiragana || '';

    const meanEl   = document.createElement('div');
    meanEl.className   = 'shir-meaning';
    meanEl.textContent = (w.meaning || '').split(',')[0].trim();

    const hintEl   = document.createElement('div');
    hintEl.className   = 'shir-hint';
    hintEl.textContent = 'Next word must start with: ';
    const kanaSpan = document.createElement('span');
    kanaSpan.className   = 'shir-kana-highlight';
    kanaSpan.textContent = _getLastKana(w.hiragana || '');
    hintEl.appendChild(kanaSpan);

    const chainEl  = document.createElement('div');
    chainEl.className   = 'shir-chain-display';
    chainEl.textContent = `🔗 Chain: ${s.chain}   ⭐ Score: ${s.score}`;

    disp.append(kanjiEl, hiraEl, meanEl, hintEl, chainEl);
}

function _hasValidNextWord(targetKana, pool) {
    const s = GS.shir;
    return pool.some(w => {
        const key = wordKey(w);
        if (!key || s.used.has(key)) return false;
        if (_getLastKana(w.hiragana || '') === 'ん') return false;
        return (w.hiragana || '').trim()[0] === targetKana;
    });
}

function checkShiritori() {
    const inputEl = document.getElementById('shirInput');
    if (!inputEl) return;
    const val = inputEl.value.trim();
    if (!val) return;
    inputEl.value = '';

    const s          = GS.shir;
    const pool       = s._pool.length ? s._pool : (vocabulary || []);
    const neededKana = _getLastKana(s.current.hiragana || '');
    const fbEl       = document.getElementById('shirFeedback');
    const valClean   = val.toLowerCase();
    const valHira    = typeof normalizeRomaji === 'function' ? normalizeRomaji(valClean) : valClean;

    const findMatch = (vocabArray) => {
        return vocabArray.find(w => {
            const key = wordKey(w);
            if (!key || s.used.has(key)) return false;
            const wHira    = (w.hiragana || '').toLowerCase();
            const wKanji   = (w.kanji   || '').toLowerCase();
            const wMeaning = (w.meaning || '').split(',')[0].trim().toLowerCase();
            return valClean === wKanji  || valClean === wHira  || valHira === wHira  ||
                   answerMatches(val, w.kanji) || answerMatches(val, w.hiragana)  ||
                   answerMatches(valHira, w.hiragana) || answerMatches(val, wMeaning);
        });
    };

    let match = findMatch(pool);
    if (!match && _allLessonsVocab && _allLessonsVocab.length) {
        match = findMatch(_allLessonsVocab);
    }

    if (!match) {
        if (fbEl) { fbEl.style.color = 'var(--danger)'; fbEl.textContent = `❌ "${val}" not found (try hiragana or romaji).`; }
        wiggle(document.getElementById('shirDisplay'));
        haptic(30);
        return;
    }

    const firstKana = (match.hiragana || '').trim()[0] || '';
    if (neededKana && firstKana !== neededKana) {
        if (fbEl) {
            fbEl.style.color = 'var(--danger)';
            fbEl.textContent = `❌ Must start with 「${neededKana}」— "${match.hiragana || match.kanji}" starts with 「${firstKana}」`;
        }
        wiggle(document.getElementById('shirDisplay'));
        haptic(30);
        return;
    }

    const key = wordKey(match);
    s.used.add(key);
    s.chain++;
    s.score += s.chain;

    const scoreEl = document.getElementById('shirScore');
    const chainEl = document.getElementById('shirChain');
    if (scoreEl) { scoreEl.textContent = `Score: ${s.score}`; flashScore(scoreEl); }
    if (chainEl) { chainEl.textContent = `Chain: ${s.chain}`;  flashScore(chainEl); }

    s.current = match;
    if (fbEl) { fbEl.style.color = 'var(--success)'; fbEl.textContent = `✅ Correct! +${s.chain} pts`; }
    haptic(15);
    addXP(Math.min(15, s.chain * 2), 'Word Chain!');
    _renderShiritoriWord(true);

    const nextKana = _getLastKana(match.hiragana || '');
    if (nextKana === 'ん') {
        setTimeout(() => finishShiritori('n-ending'), 800);
        return;
    }

    if (!_hasValidNextWord(nextKana, pool)) {
        if (typeof showToast === 'function') {
            showToast(`No words left starting with 「${nextKana}」! Changing word...`, 'warning');
        }
        const safeWords = pool.filter(w => {
            const k = wordKey(w);
            return k && !s.used.has(k) && _getLastKana(w.hiragana || '') !== 'ん';
        });
        if (safeWords.length) {
            const nextW = safeWords[Math.floor(Math.random() * safeWords.length)];
            s.used.add(wordKey(nextW));
            s.current = nextW;
            setTimeout(() => _renderShiritoriWord(true), 1500);
        } else {
            setTimeout(() => finishShiritori('target-reached'), 800);
            return;
        }
    }

    if (s.chain >= s.target) setTimeout(() => finishShiritori('target-reached'), 800);
}
window.checkShiritori = checkShiritori;

function finishShiritori(reason) {
    const s = GS.shir;
    if (!s.active) return; // Guard against double-fire
    s.active = false;

    const ls = document.getElementById('shirLengthSelect');
    if (ls) { ls.disabled = false; ls.title = ''; }

    const msg = reason === 'n-ending'
        ? `💀 Word ended with ん — round over! Score: ${s.score}`
        : reason === 'target-reached'
            ? `🎯 Reached ${s.target} words! Score: ${s.score}`
            : `⏹ Round ended. Score: ${s.score} (Chain: ${s.chain})`;

    showToast(msg, 'success');
    const xp = s.score * 2;
    if (xp > 0) addXP(xp, 'Word Chain complete!');
    closeGame('shiritori');
}
window.finishShiritori = finishShiritori;

/* ═══════════════════════════════════════════════════════════════════════════════
   GAME 4 — JLPT MOCK TEST
   All DOM construction is done programmatically — zero inline onclick strings.
   ═══════════════════════════════════════════════════════════════════════════════ */
function startMockTest() {
    loadAllLessonsVocab().then(allVocab => {
        const pool = (allVocab && allVocab.length) ? allVocab : (vocabulary || []);
        if (!pool || pool.length < 4) { showToast('Need at least 4 words available!', 'error'); return; }

        const s    = GS.mock;
        s.answers  = {};
        s.flagged  = new Set();
        s.current  = 0;
        s.timeLeft = 300;
        if (s.timer) { clearInterval(s.timer); s.timer = null; }

        const uniquePool = getShuffledUniquePool(pool, 20);

        s.questions = uniquePool.map((w, qi) => {
            const isRev = qi % 2 === 1;
            const ans   = isRev
                ? (wordKey(w))
                : (w.meaning || '').split(',')[0].trim();
            const distractors = shuffleArray(
                pool.filter(x => (wordKey(x)) !== (wordKey(w)))
            )
                .slice(0, 3)
                .map(x => isRev ? (wordKey(x)) : (x.meaning || '').split(',')[0].trim());
            return {
                qi, word: w, isRev,
                question: isRev ? (w.meaning || '').split(',')[0].trim() : (wordKey(w)),
                answer:   ans,
                options:  shuffleArray([ans, ...distractors])
            };
        });

        const timerEl = document.getElementById('mockTimer');
        if (timerEl) { timerEl.textContent = '⏱ 5:00'; timerEl.style.color = ''; }

        s.timer = setInterval(() => {
            s.timeLeft--;
            const el = document.getElementById('mockTimer');
            if (el) {
                el.textContent = `⏱ ${Math.floor(s.timeLeft / 60)}:${String(s.timeLeft % 60).padStart(2, '0')}`;
                if (s.timeLeft <= 30) el.style.color = 'var(--danger)';
            }
            if (s.timeLeft <= 0) { clearInterval(s.timer); s.timer = null; finishMockTest(); }
        }, 1000);

        window.openModal?.('mockTestOverlay');
        _renderMockQuestion();

    }).catch(err => {
        console.error('[Games] startMockTest:', err);
        showToast('Could not load vocabulary.', 'error');
    });
}
window.startMockTest = startMockTest;

/* ─── Build mock question DOM — NO inline event handlers, NO innerHTML ───────*/
function _renderMockQuestion() {
    const s   = GS.mock;
    const q   = s.questions[s.current];
    if (!q) { finishMockTest(); return; }

    const box = document.getElementById('mockQuestionBox');
    if (!box) return;

    const isFlagged = s.flagged.has(s.current);
    const chosen    = s.answers[s.current];
    const pct       = (s.current / s.questions.length) * 100;
    const letters   = ['A', 'B', 'C', 'D'];
    const frag      = document.createDocumentFragment();

    /* ── Header ── */
    const header   = document.createElement('div');
    header.className = 'mock-q-header';

    const numEl    = document.createElement('span');
    numEl.className   = 'mock-q-num';
    numEl.textContent = `Q${s.current + 1} / ${s.questions.length}`;

    const flagBtn  = document.createElement('button');
    flagBtn.type      = 'button';
    flagBtn.className = `mock-flag-btn${isFlagged ? ' flagged' : ''}`;
    flagBtn.title     = 'Flag this question for review';
    flagBtn.setAttribute('aria-pressed', String(isFlagged));
    flagBtn.textContent = `🚩 ${isFlagged ? 'Flagged' : 'Flag'}`;
    flagBtn.addEventListener('click', _toggleMockFlag);

    header.append(numEl, flagBtn);
    frag.appendChild(header);

    /* ── Progress bar ── */
    const progWrap = document.createElement('div');
    progWrap.className = 'mock-q-progress';
    progWrap.setAttribute('role', 'progressbar');
    progWrap.setAttribute('aria-valuemin', '0');
    progWrap.setAttribute('aria-valuemax', '100');
    progWrap.setAttribute('aria-valuenow', String(Math.round(pct)));
    const progFill = document.createElement('div');
    progFill.className = 'mock-q-progress-fill';
    progFill.style.width = `${pct}%`;
    progWrap.appendChild(progFill);
    frag.appendChild(progWrap);

    /* ── Question text ── */
    const qText = document.createElement('div');
    qText.className   = 'mock-question-text';
    qText.textContent = q.question; // textContent — safe
    frag.appendChild(qText);

    /* ── Options (event delegation on container) ── */
    const optsWrap = document.createElement('div');
    optsWrap.className = 'mock-options';
    optsWrap.setAttribute('role', 'group');
    optsWrap.setAttribute('aria-label', 'Answer options');

    q.options.forEach((opt, i) => {
        if (opt == null) return;
        const btn     = document.createElement('button');
        btn.type      = 'button';
        btn.className = 'mock-option';
        // Store answer in data attribute — never in an onclick string
        btn.dataset.answer = opt;

        if (chosen !== undefined) {
            btn.disabled = true;
            if (opt === q.answer)                   btn.classList.add('mock-chosen-correct');
            if (opt === chosen && opt !== q.answer) btn.classList.add('mock-chosen-wrong');
        }

        const ltr = document.createElement('span');
        ltr.className   = 'mock-opt-letter';
        ltr.textContent = letters[i] ?? String(i + 1);

        const txt = document.createElement('span');
        txt.textContent = opt; // textContent — safe

        btn.append(ltr, txt);
        optsWrap.appendChild(btn);
    });

    // Single delegated listener — handles all options, no per-button binding
    optsWrap.addEventListener('click', e => {
        const btn = e.target.closest('.mock-option');
        if (!btn || btn.disabled || s.answers[s.current] !== undefined) return;
        _selectMockAnswer(btn.dataset.answer);
    });

    frag.appendChild(optsWrap);

    /* ── Navigation row ── */
    const navRow = document.createElement('div');
    navRow.className = 'mock-nav-row';

    const prevBtn = document.createElement('button');
    prevBtn.type        = 'button';
    prevBtn.className   = 'nav-btn';
    prevBtn.textContent = '← Prev';
    prevBtn.disabled    = s.current === 0;
    prevBtn.setAttribute('aria-label', 'Previous question');
    prevBtn.addEventListener('click', () => _navMockTest(-1));

    const flagListBtn = document.createElement('button');
    flagListBtn.type        = 'button';
    flagListBtn.className   = 'nav-btn';
    flagListBtn.textContent = `🚩 Flagged (${s.flagged.size})`;
    flagListBtn.style.cssText = 'border-color:var(--accent3); color:var(--accent3);';
    flagListBtn.addEventListener('click', _showFlaggedList);

    if (s.current < s.questions.length - 1) {
        const nextBtn = document.createElement('button');
        nextBtn.type        = 'button';
        nextBtn.className   = 'nav-btn';
        nextBtn.textContent = 'Next →';
        nextBtn.setAttribute('aria-label', 'Next question');
        nextBtn.addEventListener('click', () => _navMockTest(1));
        navRow.append(prevBtn, flagListBtn, nextBtn);
    } else {
        const submitBtn = document.createElement('button');
        submitBtn.type        = 'button';
        submitBtn.className   = 'nav-btn deck-create-btn';
        submitBtn.textContent = '✅ Submit';
        submitBtn.setAttribute('aria-label', 'Submit test and see results');
        submitBtn.addEventListener('click', finishMockTest);
        navRow.append(prevBtn, flagListBtn, submitBtn);
    }

    frag.appendChild(navRow);

    /* ── Swap content with slide animation ── */
    box.replaceChildren(frag);
    box.classList.remove('mock-slide-in');
    void box.offsetWidth; // force reflow to re-trigger animation
    box.classList.add('mock-slide-in');
}

function _selectMockAnswer(opt) {
    const s = GS.mock;
    if (opt == null || s.answers[s.current] !== undefined) return;
    s.answers[s.current] = opt;
    haptic(15);
    _renderMockQuestion();
    setTimeout(() => {
        if (s.current < s.questions.length - 1) _navMockTest(1);
    }, 750);
}
// Public alias kept for consistency
window.selectMockAnswer = _selectMockAnswer;

function _navMockTest(dir) {
    const s = GS.mock;
    s.current = Math.max(0, Math.min(s.questions.length - 1, s.current + dir));
    _renderMockQuestion();
}
window.navMockTest = _navMockTest;

function _toggleMockFlag() {
    const s = GS.mock;
    if (s.flagged.has(s.current)) s.flagged.delete(s.current);
    else                           s.flagged.add(s.current);
    _renderMockQuestion();
    haptic(12);
}
window.toggleMockFlag = _toggleMockFlag;

function _showFlaggedList() {
    const s = GS.mock;
    if (!s.flagged.size) { showToast('No flagged questions.', 'success'); return; }
    const list = [...s.flagged].sort((a, b) => a - b).map(i => `Q${i + 1}`).join(', ');
    showToast(`🚩 Flagged: ${list}`, 'success');
}
window.showFlaggedList = _showFlaggedList;

/* ─── Finish mock test ───────────────────────────────────────────────────────*/
function finishMockTest() {
    const s = GS.mock;
    if (s.timer) { clearInterval(s.timer); s.timer = null; }

    let correct = 0;
    s.questions.forEach((q, i) => { if (s.answers[i] === q.answer) correct++; });
    const total = s.questions.length;
    const pct   = Math.round((correct / total) * 100);
    const pass  = pct >= 60;
    const xp    = correct * 8;

    addXP(xp, `Mock Test: ${correct}/${total}`);

    const box = document.getElementById('mockQuestionBox');
    if (!box) return;

    // Build result DOM — no innerHTML
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'text-align:center; padding:16px 0;';

    const iconEl  = document.createElement('div');
    iconEl.style.cssText  = 'font-size:48px; margin-bottom:8px;';
    iconEl.textContent    = pass ? '🎉' : '📖';

    const scoreEl = document.createElement('div');
    scoreEl.style.cssText = 'font-family:var(--font-algerian); font-size:2.5rem; color:var(--accent); font-weight:700;';
    scoreEl.textContent   = `${correct} / ${total}`;

    const labelEl = document.createElement('div');
    labelEl.style.cssText = 'font-size:12px; letter-spacing:3px; text-transform:uppercase; color:var(--text-tertiary); margin:4px 0 14px;';
    labelEl.textContent   = 'Mock Test Score';

    /* ── Stats row ── */
    const statsRow = document.createElement('div');
    statsRow.style.cssText = 'display:flex; justify-content:center; gap:14px; flex-wrap:wrap; margin-bottom:18px;';

    const _mkStat = (val, key, color) => {
        const card   = document.createElement('div');
        card.className = 'quiz-summary-stat';
        if (color) card.style.color = color;
        const v = document.createElement('div'); v.className = 'stat-val'; v.textContent = String(val);
        const k = document.createElement('div'); k.className = 'stat-key'; k.textContent = key;
        card.append(v, k);
        return card;
    };
    statsRow.append(
        _mkStat(`${pct}%`,          'Accuracy'),
        _mkStat(pass ? 'PASS' : 'FAIL', 'Result', pass ? 'var(--success)' : 'var(--danger)'),
        _mkStat(`+${xp}`,           'XP Earned')
    );

    /* ── Radar canvas ── */
    const canvas  = document.createElement('canvas');
    canvas.id     = 'mockRadarCanvas';
    canvas.width  = 220;
    canvas.height = 220;
    canvas.style.cssText = 'display:block; margin:0 auto 16px;';

    /* ── Advice ── */
    const adviceEl = document.createElement('p');
    adviceEl.style.cssText = 'font-size:13px; color:var(--text-secondary); max-width:380px; margin:0 auto 18px; line-height:1.6;';
    adviceEl.textContent   = _generateMockAdvice(correct, total);

    /* ── Retry button ── */
    const retryBtn = document.createElement('button');
    retryBtn.className   = 'quiz-summary-restart';
    retryBtn.type        = 'button';
    retryBtn.textContent = 'Try Again';
    retryBtn.addEventListener('click', startMockTest);

    wrapper.append(iconEl, scoreEl, labelEl, statsRow, canvas, adviceEl, retryBtn);
    box.replaceChildren(wrapper);

    setTimeout(() => {
        drawRadarFromHistory('mockRadarCanvas', s.questions.map((q, i) => ({
            word: q.word, correct: s.answers[i] === q.answer
        })));
    }, 80);
}
window.finishMockTest = finishMockTest;

function _generateMockAdvice(correct, total) {
    const pct = (correct / total) * 100;
    if (pct >= 90) return '🏆 Outstanding! You are well-prepared for the JLPT. Keep reviewing daily to maintain this level.';
    if (pct >= 70) return '✅ Good performance! Focus on the words you got wrong — add them to a Weak Words deck for targeted review.';
    if (pct >= 50) return '📖 Keep going! Aim to do at least one SRS review session daily. Pay special attention to verb forms and particles.';
    return "💪 Don't give up! Start with the flashcard review mode every day and revisit difficult lessons. Consistency beats intensity.";
}

/* ═══════════════════════════════════════════════════════════════════════════════
   RADAR / PENTAGON ANALYTICS CHART (Canvas)
   ═══════════════════════════════════════════════════════════════════════════════ */
function drawRadarFromHistory(canvasId, history) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || !canvas.getContext) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const cats     = ['Nouns', 'Verbs', 'Adj', 'Adv/Part', 'Numbers'];
    const catTests = [
        w => !/^to /i.test(w.meaning || ''),
        w =>  /^to /i.test(w.meaning || ''),
        w => /(い$|な$|big|small|hot|cold|good|bad|long|short)/i.test((w.meaning || '') + (w.hiragana || '')),
        w => /(already|very|now|when|how|where|who|what|also)/i.test(w.meaning || ''),
        w => /(one|two|three|four|five|year|month|day|time|minute|hour)/i.test(w.meaning || '')
    ];

    const scores = cats.map((_, ci) => {
        const fn    = catTests[ci];
        const items = history.filter(h => fn(h.word));
        return items.length ? items.filter(h => h.correct).length / items.length : 0.5;
    });

    const W      = canvas.width;
    const H      = canvas.height;
    const cx     = W / 2;
    const cy     = H / 2;
    const R      = Math.min(W, H) / 2 - 30;
    const N      = cats.length;
    const isDark = !document.body.classList.contains('light-theme');

    ctx.clearRect(0, 0, W, H);

    const pt = (r, i) => ({
        x: cx + r * Math.cos((i / N) * Math.PI * 2 - Math.PI / 2),
        y: cy + r * Math.sin((i / N) * Math.PI * 2 - Math.PI / 2)
    });

    // Grid rings
    [0.25, 0.5, 0.75, 1].forEach(frac => {
        ctx.beginPath();
        for (let i = 0; i < N; i++) {
            const p = pt(R * frac, i);
            i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y);
        }
        ctx.closePath();
        ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.08)';
        ctx.lineWidth   = 1;
        ctx.stroke();
    });

    // Spokes
    for (let i = 0; i < N; i++) {
        const sp = pt(R, i);
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(sp.x, sp.y);
        ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.08)';
        ctx.lineWidth   = 1;
        ctx.stroke();
    }

    // Data polygon
    ctx.beginPath();
    scores.forEach((score, i) => {
        const p = pt(R * score, i);
        i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y);
    });
    ctx.closePath();
    ctx.fillStyle   = isDark ? 'rgba(96,165,250,0.22)'  : 'rgba(29,78,216,0.15)';
    ctx.fill();
    ctx.strokeStyle = isDark ? 'rgba(96,165,250,0.85)'  : 'rgba(29,78,216,0.85)';
    ctx.lineWidth   = 2;
    ctx.stroke();

    // Data points
    scores.forEach((score, i) => {
        const p = pt(R * score, i);
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
        ctx.fillStyle = isDark ? '#60a5fa' : '#1d4ed8';
        ctx.fill();
    });

    // Labels + percentages
    ctx.save();
    cats.forEach((cat, i) => {
        const p  = pt(R + 18, i);
        const lp = pt(R + 5,  i);
        const xAlign = p.x < cx - 2 ? 'right' : p.x > cx + 2 ? 'left' : 'center';
        const yAlign = p.y < cy - 2 ? 'bottom' : p.y > cy + 2 ? 'top' : 'middle';

        ctx.font         = '600 10px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.textAlign    = xAlign;
        ctx.textBaseline = yAlign;
        ctx.fillStyle    = isDark ? 'rgba(212,218,240,0.9)' : 'rgba(30,41,59,0.85)';
        ctx.fillText(cat, p.x, p.y);

        const lxAlign = lp.x < cx - 2 ? 'right' : lp.x > cx + 2 ? 'left' : 'center';
        const lyAlign = lp.y < cy - 2 ? 'bottom' : lp.y > cy + 2 ? 'top' : 'middle';
        ctx.font         = 'bold 9px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.textAlign    = lxAlign;
        ctx.textBaseline = lyAlign;
        ctx.fillStyle    = isDark ? '#60a5fa' : '#1d4ed8';
        ctx.fillText(`${Math.round(scores[i] * 100)}%`, lp.x, lp.y);
    });
    ctx.restore();
}
window.drawRadarFromHistory = drawRadarFromHistory;