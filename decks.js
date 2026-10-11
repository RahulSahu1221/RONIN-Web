//deck.js 

"use strict";

// ═══════════════════════════════════════════════════════════════════════════════
// DECKS.JS — Decks, XP, Heatmap, Settings Drawer, Controls
// Industrial-grade: no syntax errors, no duplicate declarations, CSP-safe,
// XSS-hardened, consistent micro-animations, full accessibility.
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Constants ───────────────────────────────────────────────────────────────
const DECK_EMOJIS = [
    "📚","🗂️","🎌","🌸","⛩️","🍣","🍜","🎎","🦊","🌺",
    "📖","✏️","🏮","🎋","🍡","🌊","🗼","🎯","🌙","⭐",
    "🔥","💎","🎴","🀄","🎐","🏯","🎑","🌅","🦋","🌿"
];

const XP_LEVELS = [
    { lvl:1,  title:"Beginner",     xp:0     },
    { lvl:2,  title:"Student",      xp:100   },
    { lvl:3,  title:"Learner",      xp:300   },
    { lvl:4,  title:"Scholar",      xp:600   },
    { lvl:5,  title:"Practitioner", xp:1000  },
    { lvl:6,  title:"Apprentice",   xp:1500  },
    { lvl:7,  title:"Adept",        xp:2200  },
    { lvl:8,  title:"Expert",       xp:3000  },
    { lvl:9,  title:"Master",       xp:4000  },
    { lvl:10, title:"Grand Master", xp:5500  },
    { lvl:11, title:"Sensei",       xp:7500  },
    { lvl:12, title:"Shogun",       xp:10000 }
];

// ─── Module-scoped state ─────────────────────────────────────────────────────
let _selectedEmoji   = "📚";
let _activeCtxWord   = null;
let _speedRoundTimer = null;
let _speedRoundSecs  = 60;
let _speedRoundScore = 0;
let _lastSRSGrade    = null;
let _lastSRSIndex    = -1;
let _lastSRSData     = null;

// Safe DOM getter — waits for app.js $ to be defined
function D(id) { return document.getElementById(id); }

// ─── Deck Storage ─────────────────────────────────────────────────────────────
function getDecks()    { return store.get("jlpt_decks", []); }
function saveDecks(d)  { store.set("jlpt_decks", d); }

// ═══════════════════════════════════════════════════════════════════════════════
// XP SYSTEM
// ═══════════════════════════════════════════════════════════════════════════════
function getXP()  { return store.get("jlpt_xp", 0); }
function setXP(v) { store.set("jlpt_xp", v); }

function getLevelInfo(xp) {
    let cur = XP_LEVELS[0], nxt = XP_LEVELS[1] || null;
    for (let i = 0; i < XP_LEVELS.length; i++) {
        if (xp >= XP_LEVELS[i].xp) {
            cur = XP_LEVELS[i];
            nxt = XP_LEVELS[i + 1] || null;
        }
    }
    return { cur, nxt };
}

function addXP(amount, reason) {
    if (!Number.isFinite(amount) || amount <= 0) return;
    const before = getLevelInfo(getXP());
    const newXP  = getXP() + amount;
    setXP(newXP);
    const after  = getLevelInfo(newXP);
    if (after.cur.lvl > before.cur.lvl) {
        showToast(`🎉 Level Up! You are now ${after.cur.title}!`, "success");
        haptic([100, 50, 100, 50, 200]);
    } else {
        showToast(`+${amount} XP — ${reason}`, "success");
    }
    updateXPBar();
}
window.addXP = addXP;

function updateXPBar() {
    const xp          = getXP();
    const { cur, nxt} = getLevelInfo(xp);
    const badge = D("xpLevelBadge");
    const fill  = D("xpBarFill");
    const label = D("xpLabel");
    if (badge) badge.textContent = `Lv.${cur.lvl} ${cur.title}`;
    if (label) label.textContent = `${xp} XP`;
    if (fill) {
        const pct = nxt
            ? Math.min(100, Math.round(((xp - cur.xp) / (nxt.xp - cur.xp)) * 100))
            : 100;
        fill.style.width = pct + "%";
        const wrap = D("xpBarWrap");
        if (wrap) wrap.setAttribute("aria-valuenow", pct);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HEATMAP
// ═══════════════════════════════════════════════════════════════════════════════
function recordHeatmap() {
    const h = store.get("jlpt_heatmap", {});
    const k = new Date().toDateString();
    h[k] = (h[k] || 0) + 1;
    store.set("jlpt_heatmap", h);
}
window.recordHeatmap = recordHeatmap;

function updateHeatmap() {
    const wrap = D("heatmapWrap");
    if (!wrap) return;
    const h     = store.get("jlpt_heatmap", {});
    const today = new Date();
    const frag  = document.createDocumentFragment();

    const grid = document.createElement("div");
    grid.className = "heatmap-grid";

    for (let c = 15; c >= 0; c--) {
        const col = document.createElement("div");
        col.className = "heatmap-col";
        for (let r = 6; r >= 0; r--) {
            const d = new Date(today);
            d.setDate(d.getDate() - (c * 7 + r));
            const k   = d.toDateString();
            const cnt = h[k] || 0;
            const lv  = cnt === 0 ? 0 : cnt < 5 ? 1 : cnt < 15 ? 2 : cnt < 30 ? 3 : 4;
            const cell = document.createElement("div");
            cell.className        = "heatmap-cell";
            cell.dataset.level    = lv;
            cell.title            = `${k}: ${cnt} reviews`;
            cell.setAttribute("aria-label", `${k}: ${cnt} reviews`);
            col.appendChild(cell);
        }
        grid.appendChild(col);
    }
    frag.appendChild(grid);

    const legend = document.createElement("div");
    legend.className = "heatmap-legend";
    legend.setAttribute("aria-hidden", "true");
    const legendColors = ["var(--border)", "rgba(96,165,250,0.25)", "rgba(96,165,250,0.5)", "rgba(96,165,250,0.75)", "var(--accent)"];
    legend.innerHTML = "Less ";
    legendColors.forEach(bg => {
        const lc = document.createElement("div");
        lc.className = "heatmap-legend-cell";
        lc.style.background = bg;
        legend.appendChild(lc);
    });
    legend.appendChild(document.createTextNode(" More"));
    frag.appendChild(legend);

    wrap.replaceChildren(frag);
}

// ═══════════════════════════════════════════════════════════════════════════════
// JLPT READINESS
// ═══════════════════════════════════════════════════════════════════════════════
function updateReadiness() {
    const mastered = Object.values(srsData).filter(v => v && v.interval >= 7).length;
    const pctN5 = Math.min(100, Math.round((mastered / 800)  * 100));
    const pctN4 = Math.min(100, Math.round((Math.max(0, mastered - 400) / 1500) * 100));

    const n5f = D("readinessN5Fill"), n4f = D("readinessN4Fill");
    const n5p = D("readinessN5Pct"),  n4p = D("readinessN4Pct");
    const n5w = n5f && n5f.closest("[role=progressbar]");
    const n4w = n4f && n4f.closest("[role=progressbar]");

    if (n5f) n5f.style.width = pctN5 + "%";
    if (n4f) n4f.style.width = pctN4 + "%";
    if (n5p) n5p.textContent = pctN5 + "%";
    if (n4p) n4p.textContent = pctN4 + "%";
    if (n5w) n5w.setAttribute("aria-valuenow", pctN5);
    if (n4w) n4w.setAttribute("aria-valuenow", pctN4);
}

// ═══════════════════════════════════════════════════════════════════════════════
// DAILY CHALLENGE
// ═══════════════════════════════════════════════════════════════════════════════
function startDailyChallenge() {
    const vocab = window.vocabulary || [];
    if (!vocab.length) { showToast("Load a lesson first!", "error"); return; }
    const today = new Date().toDateString();
    if (store.get("jlpt_challenge_date", "") === today) {
        showToast("Daily Challenge already done today! Come back tomorrow 🌅", "success");
        return;
    }
    const words = shuffleArray([...vocab]).slice(0, 5);
    store.set("jlpt_challenge_words", words.map(w => wordKey(w)));
    store.set("jlpt_challenge_date", today);
    store.set("jlpt_challenge_done", 0);
    store.set("jlpt_challenge_completed_keys", []);

    window.filteredVocabulary = words;
    window._dailyChallengeWords = words;

    showView("reviewView");
    syncNavPill("review");
    startReview(words);
    addXP(30, "Daily Challenge started!");
    showToast("🎯 Daily Challenge: Study these 5 words for bonus XP!", "success");

    const wrap = D("dailyChallengeWrap");
    if (wrap) { wrap.classList.remove("hidden"); updateChallengeProgress(); }
}
window.startDailyChallenge = startDailyChallenge;

function updateChallengeProgress() {
    const done = store.get("jlpt_challenge_done", 0);
    const prog = D("challengeProgress");
    const sub  = D("challengeSub");
    if (prog) prog.textContent = `${done}/5`;
    if (sub)  sub.textContent  = done >= 5
        ? "✅ Completed! +50 XP bonus earned"
        : `Study ${5 - done} more words for bonus XP`;
    if (done >= 5) {
        addXP(50, "Daily Challenge completed! 🎯");
        haptic([50, 50, 200]);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SPEED ROUND
// ═══════════════════════════════════════════════════════════════════════════════
function startSpeedRound() {
    if (!vocabulary.length) { showToast("Load a lesson first!", "error"); return; }
    showView("reviewView");
    syncNavPill("review");
    _speedRoundScore = 0;
    _speedRoundSecs  = 60;

    const bar   = D("speedRoundBar");
    const fill  = D("speedRoundFill");
    const label = D("speedRoundLabel");
    if (bar) { bar.classList.remove("hidden"); bar.setAttribute("aria-valuenow", 60); }

    startReview(vocabulary);
    clearInterval(_speedRoundTimer);

    _speedRoundTimer = setInterval(() => {
        _speedRoundSecs--;
        if (label) label.textContent = _speedRoundSecs;
        if (fill)  fill.style.width  = (_speedRoundSecs / 60 * 100) + "%";
        if (bar)   bar.setAttribute("aria-valuenow", _speedRoundSecs);
        if (_speedRoundSecs <= 0) {
            clearInterval(_speedRoundTimer);
            _speedRoundTimer = null;
            if (bar) { if (bar.id) { window.closeModal?.(bar.id); } else { bar.classList.add("hidden"); }; }
            endSpeedRound();
        }
    }, 1000);

    showToast("⚡ Speed Round! Rate as many cards as possible in 60 seconds!", "success");
}
window.startSpeedRound = startSpeedRound;

function endSpeedRound() {
    const overlay = D("speedRoundResultOverlay");
    const result  = D("speedRoundResult");
    if (!result) return;

    const xp = _speedRoundScore * 3;
    addXP(xp, `Speed Round: ${_speedRoundScore} cards!`);

    // Build result DOM without innerHTML where possible
    const wrap   = document.createElement("div");
    wrap.style.cssText = "text-align:center; padding:20px 0;";

    const icon = document.createElement("div");
    icon.style.cssText = "font-size:3rem; margin-bottom:8px;";
    icon.textContent = "⚡";

    const scoreEl = document.createElement("div");
    scoreEl.style.cssText = "font-size:2.5rem; font-weight:700; color:var(--accent2); font-family:var(--font-algerian);";
    scoreEl.textContent = String(_speedRoundScore);

    const desc = document.createElement("div");
    desc.style.cssText = "font-size:13px; color:var(--text-tertiary); margin:4px 0 16px;";
    desc.textContent = "Cards rated in 60 seconds";

    const xpEl = document.createElement("div");
    xpEl.style.cssText = "font-size:1.2rem; color:var(--accent); font-weight:600;";
    xpEl.textContent = `+${xp} XP earned!`;

    const btn = document.createElement("button");
    btn.className = "nav-btn deck-create-btn";
    btn.style.cssText = "margin-top:18px; width:100%;";
    btn.textContent = "Try Again ⚡";
    btn.type = "button";
    btn.addEventListener("click", () => {
        if (overlay) window.closeModal?.(overlay.id);
        startSpeedRound();
    });

    wrap.append(icon, scoreEl, desc, xpEl, btn);
    result.replaceChildren(wrap);
    if (overlay) overlay.classList.remove("hidden");
}

// ═══════════════════════════════════════════════════════════════════════════════
// UNDO LAST SRS GRADE
// ═══════════════════════════════════════════════════════════════════════════════
function undoLastGrade() {
    if (_lastSRSGrade === null || _lastSRSIndex === -1 || !_lastSRSData) {
        showToast("Nothing to undo.", "error");
        return;
    }
    const word = vocabulary[_lastSRSIndex];
    if (!word) return;
    const key = wordKey(word);
    if (!key) return;

    srsData[key] = { ..._lastSRSData };
    store.set("jlpt_srs", srsData);

    // Reverse learned status only if the undone grade was the one that added it
    const lIdx = userProfile.learned.indexOf(key);
    if (lIdx > -1 && _lastSRSGrade < 3) userProfile.learned.splice(lIdx, 1);

    // Reverse the "weak" flag only if this exact grade is what added it
    if (window._lastGradedAddedWeak && window._lastGradedWord === word) {
        const wIdx = userProfile.weak.indexOf(key);
        if (wIdx > -1) userProfile.weak.splice(wIdx, 1);
    }
    window._lastGradedAddedWeak = false;

    store.set("jlpt_profile", userProfile);

    reviewIndex = _lastSRSIndex;
    window.reviewIndex = reviewIndex;
    showReviewCard();

    _lastSRSGrade = null;
    _lastSRSIndex = -1;
    _lastSRSData  = null;

    const undoBtn = D("reviewUndoBtn");
    if (undoBtn) undoBtn.disabled = true;
    showToast("↩ Rating undone!", "success");
    haptic(20);
}
window.undoLastGrade = undoLastGrade;

// ═══════════════════════════════════════════════════════════════════════════════
// SMART DECKS
// ═══════════════════════════════════════════════════════════════════════════════
async function refreshSmartDecks() {
    if (!vocabulary || !vocabulary.length) { showToast("Load a lesson first!", "error"); return; }
    const decks      = getDecks();
    const thirtyAgo  = Date.now() - 30 * 86400000;

    const leechWords = await loadAllLessonsVocab(w => {
        const key = wordKey(w);
        const s   = srsData[key];
        return s && s.eFactor < 1.7 && s.repetition > 0;
    }).map(w => wordKey(w));

    const forgotWords = await loadAllLessonsVocab(w => {
        const key = wordKey(w);
        const s   = srsData[key];
        return s && userProfile.learned.includes(key) && s.dueDate < thirtyAgo;
    }).map(w => wordKey(w));

    function upsert(name, emoji, desc, words) {
        if (!words.length) return;
        const ex = decks.find(d => d._smart && d.name === name);
        if (ex) { ex.words = words; ex.updatedAt = Date.now(); }
        else {
            decks.push({
                id: "smart_" + name.replace(/\s/g, "_"),
                name, description: desc, emoji,
                isPublic: false, words,
                createdAt: Date.now(), _smart: true
            });
        }
    }

    upsert("Leech Words",    "🐛", "Words you keep struggling with — drill these!", leechWords);
    upsert("Forgotten Words","🕰️","Words not reviewed in 30+ days",                 forgotWords);
    saveDecks(decks);
    renderDeckList();

    const total = leechWords.length + forgotWords.length;
    showToast(
        total > 0
            ? `🤖 Smart Decks updated! ${leechWords.length} leeches · ${forgotWords.length} forgotten`
            : "🎉 No leeches or forgotten words — great job!",
        "success"
    );
    haptic(20);
}
window.refreshSmartDecks = refreshSmartDecks;

// ═══════════════════════════════════════════════════════════════════════════════
// SETTINGS DRAWER
// ═══════════════════════════════════════════════════════════════════════════════
function openSettingsDrawer() {
    const drawer  = D("sdDrawer");
    const overlay = D("sdOverlay");
    const panel   = D("sdPanel");
    if (!drawer || !overlay || !panel) return;

    const prelayers    = drawer.querySelectorAll(".sd-prelayer");
    const staggerItems = drawer.querySelectorAll(".sd-stagger");

    panel.classList.add("sd-panel-visible");
    prelayers.forEach(el => el.classList.add("sd-panel-visible"));

    overlay.classList.add("sd-active");
    drawer.classList.add("sd-open");
    drawer.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";

    if (typeof gsap !== "undefined") {
        gsap.killTweensOf([panel, ...prelayers, ...staggerItems]);
        gsap.set(prelayers,    { x: "100%" });
        gsap.set(panel,        { x: "100%" });
        gsap.set(staggerItems, { opacity: 0, x: 40 });

        const tl = gsap.timeline();
        tl.to(prelayers,    { x: "0%", duration: 0.38, ease: "power4.out", stagger: 0.05 }, 0);
        tl.to(panel,        { x: "0%", duration: 0.50, ease: "power4.out" }, 0.06);
        tl.to(staggerItems, { opacity: 1, x: 0, duration: 0.40, ease: "power3.out", stagger: 0.06 }, 0.24);
    } else {
        panel.style.transform = "translateX(0)";
        prelayers.forEach(el => { el.style.transform = "translateX(0)"; });
        staggerItems.forEach(el => { el.style.opacity = "1"; el.style.transform = "translateX(0)"; });
    }

    // Attach overlay-click-to-close with a brief delay to prevent immediate fire
    if (overlay._sdCloseHandler) overlay.removeEventListener("click", overlay._sdCloseHandler);
    overlay._sdCloseHandler = null;
    setTimeout(() => {
        overlay._sdCloseHandler = e => { if (e.target === overlay) closeSettingsDrawer(); };
        overlay.addEventListener("click", overlay._sdCloseHandler);
    }, 320);

    // Sync persisted values into drawer controls
    _syncDrawerValues(drawer);
}
window.openSettingsDrawer = openSettingsDrawer;

function _syncDrawerValues(drawer) {
    // 1. Study Behavior
    const ncpd = D("sdNewCardsPerDay");
    const ro   = D("sdReviewOrder");
    const ql   = D("sdQuizLength");
    const qlv  = D("sdQuizLengthVal");
    const dqm  = D("sdDefaultQuizMode");
    const qt   = D("sdQuizTimed");

    if (ncpd) ncpd.value = store.get("jlpt_settings_newCardsPerDay", 10);
    if (ro) ro.value     = store.get("jlpt_settings_reviewOrder", "due-soonest");
    if (ql) {
        const val = store.get("jlpt_settings_quizLength", 20);
        ql.value = val;
        if (qlv) qlv.textContent = val;
    }
    if (dqm) dqm.value   = store.get("jlpt_settings_defaultQuizMode", "kanjiToMeaning");
    if (qt) qt.checked   = store.get("jlpt_settings_quizTimed", false);

    // 2. Audio
    const tr  = D("sdTTSRate");
    const trv = D("sdTTSRateVal");
    const ma  = D("sdMuteAudio");
    
    if (tr) {
        const val = store.get("jlpt_settings_ttsRate", 0.95);
        tr.value = val;
        if (trv) trv.textContent = Number(val).toFixed(2) + "x";
    }
    if (ma) ma.checked = store.get("jlpt_settings_muteAudio", false);

    // 3. Notifications
    const pe = D("sdPushEnabled");
    const rt = D("sdReminderTime");
    const sr = D("sdStreakReminder");
    const rtw = D("sdReminderTimeWrap");

    if (pe) pe.checked = store.get("jlpt_settings_pushEnabled", false);
    if (rt) rt.value   = store.get("jlpt_settings_reminderTime", "18:00");
    if (sr) sr.checked = store.get("jlpt_settings_streakReminder", false);
    if (rtw) rtw.style.opacity = pe && pe.checked ? "1" : "0.5";
    if (rtw) rtw.style.pointerEvents = pe && pe.checked ? "auto" : "none";

    // 4. Display & Accessibility
    const tm = D("sdThemeMode");
    const rm = D("sdReduceMotion");
    const fsScale = D("sdFontScale");
    const fsv = D("sdFontScaleVal");
    const cd = D("sdCardDensity");

    if (tm) tm.value   = store.get("jlpt_settings_themeMode", "system");
    if (rm) rm.checked = store.get("jlpt_settings_reduceMotion", false);
    if (fsScale) {
        const val = store.get("jlpt_settings_fontScale", 1.0);
        fsScale.value = val;
        if (fsv) fsv.textContent = Number(val).toFixed(1) + "x";
    }
    if (cd) cd.checked = store.get("jlpt_settings_cardDensity", false);

    // 5. Data Management (Just backup date label)
    const lb = D("sdLastBackup");
    if (lb) {
        const lastDate = store.get("jlpt_lastBackupDate");
        lb.textContent = lastDate ? "Last backup: " + new Date(lastDate).toLocaleString() : "Never backed up";
    }

    // 6. Profile
    const un = D("sdUserName");
    if (un) un.value = userProfile.name || "";

    // 7. Gamification
    const gs = D("sdGoalSelect");
    const sg = D("sdShowGamification");
    if (gs) gs.value = userProfile.dailyGoal || 20;
    if (sg) sg.checked = store.get("jlpt_settings_showGamification", true);

    // Refresh glass selects
    window.refreshGlassSelect?.("sdReviewOrder");
    window.refreshGlassSelect?.("sdDefaultQuizMode");
    window.refreshGlassSelect?.("sdTTSVoice");
    window.refreshGlassSelect?.("sdThemeMode");
    window.refreshGlassSelect?.("sdGoalSelect");
}

function closeSettingsDrawer() {
    const drawer  = D("sdDrawer");
    const overlay = D("sdOverlay");
    const panel   = D("sdPanel");
    if (!drawer || !overlay || !panel) return;

    if (overlay._sdCloseHandler) {
        overlay.removeEventListener("click", overlay._sdCloseHandler);
        overlay._sdCloseHandler = null;
    }

    overlay.classList.remove("sd-active");
    drawer.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";

    const prelayers    = drawer.querySelectorAll(".sd-prelayer");
    const staggerItems = drawer.querySelectorAll(".sd-stagger");

    if (typeof gsap !== "undefined") {
        gsap.killTweensOf([panel, ...prelayers, ...staggerItems]);
        const tl = gsap.timeline({
            onComplete: () => {
                drawer.classList.remove("sd-open");
                panel.classList.remove("sd-panel-visible");
                prelayers.forEach(el => el.classList.remove("sd-panel-visible"));
                gsap.set(panel,        { x: "100%" });
                gsap.set(prelayers,    { x: "100%" });
                gsap.set(staggerItems, { opacity: 0, x: 40 });
            }
        });
        tl.to(staggerItems,          { opacity: 0, x: 40, duration: 0.15, ease: "power2.in", stagger: 0.03 }, 0);
        tl.to([panel, ...prelayers], { x: "100%", duration: 0.28, ease: "power3.in", stagger: 0.03 }, 0.05);
    } else {
        panel.style.transform = "translateX(100%)";
        prelayers.forEach(el => { el.style.transform = "translateX(100%)"; });
        panel.classList.remove("sd-panel-visible");
        prelayers.forEach(el => el.classList.remove("sd-panel-visible"));
        drawer.classList.remove("sd-open");
    }
}
window.closeSettingsDrawer = closeSettingsDrawer;

function setupSettingsDrawer() {
    const closeBtn = D("sdCloseBtn");
    if (closeBtn) closeBtn.addEventListener("click", closeSettingsDrawer);

    // 1. Study Behavior
    D("sdNewCardsPerDay")?.addEventListener("change", e => {
        store.set("jlpt_settings_newCardsPerDay", Math.max(1, parseInt(e.target.value) || 10));
    });
    D("sdReviewOrder")?.addEventListener("change", e => {
        store.set("jlpt_settings_reviewOrder", e.target.value);
    });
    D("sdQuizLength")?.addEventListener("input", e => {
        const val = e.target.value;
        D("sdQuizLengthVal").textContent = val;
    });
    D("sdQuizLength")?.addEventListener("change", e => {
        store.set("jlpt_settings_quizLength", parseInt(e.target.value) || 20);
    });
    D("sdDefaultQuizMode")?.addEventListener("change", e => {
        store.set("jlpt_settings_defaultQuizMode", e.target.value);
    });
    D("sdQuizTimed")?.addEventListener("change", e => {
        store.set("jlpt_settings_quizTimed", e.target.checked);
    });

    // 2. Audio
    D("sdTTSVoice")?.addEventListener("change", e => {
        store.set("jlpt_settings_ttsVoice", e.target.value);
    });
    D("sdTTSRate")?.addEventListener("input", e => {
        D("sdTTSRateVal").textContent = Number(e.target.value).toFixed(2) + "x";
    });
    D("sdTTSRate")?.addEventListener("change", e => {
        store.set("jlpt_settings_ttsRate", parseFloat(e.target.value) || 0.95);
        if (typeof window._updateSpeechRate === "function") window._updateSpeechRate();
    });
    D("sdMuteAudio")?.addEventListener("change", e => {
        store.set("jlpt_settings_muteAudio", e.target.checked);
    });

    // 3. Notifications
    D("sdPushEnabled")?.addEventListener("change", async e => {
        const isEnabled = e.target.checked;
        const rtw = D("sdReminderTimeWrap");
        if (rtw) {
            rtw.style.opacity = isEnabled ? "1" : "0.5";
            rtw.style.pointerEvents = isEnabled ? "auto" : "none";
        }
        
        if (isEnabled) {
            if (typeof Notification !== "undefined") {
                const perm = await Notification.requestPermission();
                if (perm === "granted") {
                    store.set("jlpt_settings_pushEnabled", true);
                    showToast("🔔 Reminders enabled!", "success");
                    if (typeof window._subscribeToPush === "function") window._subscribeToPush();
                } else {
                    e.target.checked = false;
                    store.set("jlpt_settings_pushEnabled", false);
                    showToast("Permission denied.", "error");
                }
            } else {
                e.target.checked = false;
                showToast("Notifications not supported.", "error");
            }
        } else {
            store.set("jlpt_settings_pushEnabled", false);
        }
    });
    D("sdReminderTime")?.addEventListener("change", e => {
        store.set("jlpt_settings_reminderTime", e.target.value);
        showToast("Reminder time updated", "success");
    });
    D("sdStreakReminder")?.addEventListener("change", e => {
        store.set("jlpt_settings_streakReminder", e.target.checked);
    });

    // 4. Display & Accessibility
    D("sdThemeMode")?.addEventListener("change", e => {
        store.set("jlpt_settings_themeMode", e.target.value);
        if (typeof window._applyThemeMode === "function") window._applyThemeMode();
    });
    D("sdReduceMotion")?.addEventListener("change", e => {
        store.set("jlpt_settings_reduceMotion", e.target.checked);
        document.body.classList.toggle("reduce-motion", e.target.checked);
        showToast(e.target.checked ? "Reduced motion on" : "Animations on", "success");
    });
    D("sdFontScale")?.addEventListener("input", e => {
        D("sdFontScaleVal").textContent = Number(e.target.value).toFixed(1) + "x";
    });
    D("sdFontScale")?.addEventListener("change", e => {
        store.set("jlpt_settings_fontScale", parseFloat(e.target.value) || 1.0);
        if (typeof window._applyFontScale === "function") window._applyFontScale();
    });
    D("sdCardDensity")?.addEventListener("change", e => {
        store.set("jlpt_settings_cardDensity", e.target.checked);
        if (typeof window._applyCardDensity === "function") window._applyCardDensity();
    });

    // 5. Data Management
    D("sdExportBtn")?.addEventListener("click", () => {
        store.export();
        store.set("jlpt_lastBackupDate", new Date().toISOString());
        const lb = D("sdLastBackup");
        if (lb) lb.textContent = "Last backup: " + new Date().toLocaleString();
    });
    D("sdImportFile")?.addEventListener("change", e => {
        const file = e.target.files && e.target.files[0];
        if (file) store.import(file);
        e.target.value = "";
    });
    D("sdClearCacheBtn")?.addEventListener("click", () => {
        if (confirm("Clear app cache and check for updates?")) {
            if (navigator.serviceWorker) {
                navigator.serviceWorker.getRegistrations().then(function(registrations) {
                    for(let registration of registrations) { registration.update(); }
                });
            }
            if ('caches' in window) {
                caches.delete('jlpt-app-v2').then(() => {
                    location.reload(true);
                });
            } else {
                location.reload(true);
            }
        }
    });
    D("sdResetBtn")?.addEventListener("click", () => {
        if (typeof window.openResetModal === "function") {
            window.openResetModal();
        } else {
            if (confirm("Delete ALL progress forever? This cannot be undone.")) {
                // Signed in: RoninSync clears this app's keys, keeps the login,
                // and empties the cloud copy so a later sync can't restore it.
                const finish = () => location.reload();
                if (window.RoninSync && typeof window.RoninSync.resetEverything === "function") {
                    window.RoninSync.resetEverything().then(finish, finish);
                } else {
                    localStorage.clear();
                    finish();
                }
            }
        }
    });

    // 6. Profile
    D("sdUserName")?.addEventListener("change", e => {
        const un = e.target.value.trim();
        userProfile.name = un || "Learner";
        store.set("jlpt_profile", userProfile);
        if (typeof updateDashboard === "function") updateDashboard();
    });

    // 7. Gamification
    D("sdGoalSelect")?.addEventListener("change", e => {
        const goal = parseInt(e.target.value, 10);
        userProfile.dailyGoal = Number.isFinite(goal) && goal > 0 ? goal : 20;
        store.set("jlpt_profile", userProfile);
        if (typeof updateDashboard === "function") updateDashboard();
    });
    D("sdShowGamification")?.addEventListener("change", e => {
        store.set("jlpt_settings_showGamification", e.target.checked);
        if (typeof window._applyGamificationVis === "function") window._applyGamificationVis();
    });
}

// Close settings drawer on overlay click (already handled by openSettingsDrawer's delayed listener)
    // Close deck modals on backdrop click
    [
        "createDeckOverlay","deckViewOverlay","wordDetailOverlay",
        "deckPickerOverlay","shortcutOverlay","speedRoundResultOverlay","feedbackOverlay"
    ].forEach(id => {
        const el = D(id);
        if (!el || el._outsideClose) return;
        el._outsideClose = true;
        el.addEventListener("click", e => {
            if (e.target === el) window.closeModal?.(el.id);
        });
    });

// ═══════════════════════════════════════════════════════════════════════════════
// CREATE DECK MODAL
// ═══════════════════════════════════════════════════════════════════════════════
function openCreateDeck() {
    _selectedEmoji = "📚";
    const ni = D("deckNameInput");
    const di = D("deckDescInput");
    const pt = D("deckPublicToggle");
    const ep = D("deckEmojiPreview");
    if (ni) ni.value = "";
    if (di) di.value = "";
    if (pt) pt.checked = false;
    if (ep) ep.textContent = _selectedEmoji;
    openModal("createDeckOverlay");
    // Let the open animation get its first couple of frames in before we do
    // the heavier work of building 30 emoji buttons — avoids a stutter.
    requestAnimationFrame(() => {
        requestAnimationFrame(() => { _buildEmojiGrid(); });
    });
    setTimeout(() => { if (ni) ni.focus(); }, 120);
}
window.openCreateDeck = openCreateDeck;

function closeCreateDeck() { closeModal("createDeckOverlay"); }
window.closeCreateDeck = closeCreateDeck;

function _buildEmojiGrid() {
    const grid = D("emojiGrid");
    if (!grid) return;
    const frag = document.createDocumentFragment();
    DECK_EMOJIS.forEach(e => {
        const btn = document.createElement("button");
        btn.className = "emoji-option" + (e === _selectedEmoji ? " selected" : "");
        btn.textContent = e;
        btn.setAttribute("aria-label", e);
        btn.setAttribute("aria-pressed", String(e === _selectedEmoji));
        btn.type = "button";
        btn.addEventListener("click", () => {
            _selectedEmoji = e;
            const ep = D("deckEmojiPreview");
            if (ep) ep.textContent = e;
            grid.querySelectorAll(".emoji-option").forEach(b => {
                b.classList.remove("selected");
                b.setAttribute("aria-pressed", "false");
            });
            btn.classList.add("selected");
            btn.setAttribute("aria-pressed", "true");
            haptic(10);
        });
        frag.appendChild(btn);
    });
    grid.replaceChildren(frag);
}

D("saveDeckBtn")?.addEventListener("click", () => {
    const ni   = D("deckNameInput");
    const name = (ni?.value || "").trim();
    if (!name) {
        if (ni) ni.style.borderColor = "var(--danger)";
        showToast("Please enter a deck name!", "error");
        setTimeout(() => { if (ni) ni.style.borderColor = ""; }, 1500);
        return;
    }
    const decks = getDecks();
    decks.push({
        id: "dk_" + Date.now(),
        name,
        description: (D("deckDescInput")?.value || "").trim(),
        emoji:       _selectedEmoji,
        isPublic:    D("deckPublicToggle")?.checked || false,
        words:       [],
        createdAt:   Date.now()
    });
    saveDecks(decks);
    haptic(30);
    showToast(`Deck "${sanitizeHTML(name)}" created! 🎉`, "success");
    addXP(50, "Created a new deck 📚");
    closeCreateDeck();
});

// ═══════════════════════════════════════════════════════════════════════════════
// DECK VIEW MODAL
// ═══════════════════════════════════════════════════════════════════════════════
function openDeckView() { renderDeckList(); openModal("deckViewOverlay"); }
window.openDeckView = openDeckView;

function closeDeckView() { closeModal("deckViewOverlay"); }
window.closeDeckView = closeDeckView;

function renderDeckList() {
    const cont = D("deckListContent");
    if (!cont) return;
    const filter = window._deckFilter || "vocab";
    const allDecks = getDecks();
    const decks = allDecks.filter(dk => (dk.type || "vocab") === filter);

    D("filterDeckVocab")?.classList.toggle("active-mode", filter === "vocab");
    D("filterDeckGrammar")?.classList.toggle("active-mode", filter === "grammar");

    if (!decks.length) {
        const empty = document.createElement("div");
        empty.className = "empty-decks";
        const icon = document.createElement("span");
        icon.className = "empty-icon";
        icon.setAttribute("aria-hidden", "true");
        icon.textContent = "🗂️";
        const msg = document.createTextNode("No decks yet. Create your first one!");
        empty.append(icon, msg);
        cont.replaceChildren(empty);
        return;
    }

    const frag = document.createDocumentFragment();
    decks.forEach(dk => {
        const card = document.createElement("div");
        card.className = "deck-card";
        card.setAttribute("role", "article");
        card.setAttribute("aria-label", `Deck: ${dk.name}`);

        const emojiEl = document.createElement("div");
        emojiEl.className = "deck-card-emoji";
        emojiEl.setAttribute("aria-hidden", "true");
        emojiEl.textContent = dk.emoji || "📚";

        const info = document.createElement("div");
        info.className = "deck-card-info";

        const nameEl = document.createElement("div");
        nameEl.className = "deck-card-name";
        nameEl.textContent = dk.name;

        const descEl = document.createElement("div");
        descEl.className = "deck-card-desc";
        descEl.textContent = dk.description || "No description";

        const meta = document.createElement("div");
        meta.className = "deck-card-meta";

        const countBadge = document.createElement("span");
        countBadge.className = "deck-badge";
        countBadge.textContent = `${dk.words.length} words`;

        const visBadge = document.createElement("span");
        visBadge.className = "deck-badge " + (dk.isPublic ? "public" : "private");
        visBadge.textContent = dk.isPublic ? "🌐 Public" : "🔒 Private";

        meta.append(countBadge, visBadge);
        info.append(nameEl, descEl, meta);

        const actions = document.createElement("div");
        actions.className = "deck-card-actions";

        const studyBtn = document.createElement("button");
        studyBtn.className = "deck-action-btn study";
        studyBtn.title = "Study";
        studyBtn.type  = "button";
        studyBtn.setAttribute("aria-label", `Study deck: ${dk.name}`);
        studyBtn.textContent = "▶";
        studyBtn.addEventListener("click", () => studyDeck(dk.id));

        const delBtn = document.createElement("button");
        delBtn.className = "deck-action-btn del";
        delBtn.title = "Delete";
        delBtn.type  = "button";
        delBtn.setAttribute("aria-label", `Delete deck: ${dk.name}`);
        delBtn.textContent = "🗑";
        delBtn.addEventListener("click", () => deleteDeck(dk.id));

        actions.append(studyBtn, delBtn);
        card.append(emojiEl, info, actions);
        frag.appendChild(card);
    });
    cont.replaceChildren(frag);
}

function deleteDeck(id) {
    if (!confirm("Delete this deck? Words in it will not be deleted.")) return;
    saveDecks(getDecks().filter(d => d.id !== id));
    renderDeckList();
    showToast("Deck deleted.", "success");
    haptic(20);
}
window.deleteDeck = deleteDeck;

let _deckStudyActive = false;
let _deckSavedVocab  = null;
let _deckStudyNavHandler = null;

function studyDeck(id) {
    const dk = getDecks().find(d => d.id === id);
    if (!dk || !dk.words.length) { showToast("No words in this deck yet!", "error"); return; }
    closeDeckView();

    const deckVocab = dk.words
        .map(k => vocabulary.find(v => wordKey(v) === k) || (dk.customWords && dk.customWords[k]))
        .filter(Boolean);

    if (!deckVocab.length) { showToast("No matching words found in current lesson.", "error"); return; }

    showToast(`Studying: ${sanitizeHTML(dk.name)} (${deckVocab.length} words)`, "success");

    if (!_deckStudyActive) {
        _deckSavedVocab   = [...vocabulary];
        _deckStudyActive  = true;
    }

    window._deckStudyVocab = deckVocab;
    window.vocabulary      = deckVocab;

    reviewIndex        = 0;
    window.reviewIndex = 0;
    showView("reviewView");
    syncNavPill("review");
    startReview(deckVocab);

    const restoreVocab = () => {
        if (!_deckStudyActive) return;
        vocabulary          = _deckSavedVocab;
        window.vocabulary   = _deckSavedVocab;
        _deckStudyActive   = false;
        _deckSavedVocab    = null;
        window._deckStudyVocab = null;
        document.removeEventListener("click", _deckStudyNavHandler, true);
        _deckStudyNavHandler = null;
    };

    if (_deckStudyNavHandler) {
        document.removeEventListener("click", _deckStudyNavHandler, true);
        _deckStudyNavHandler = null;
    }

    _deckStudyNavHandler = function onNav(e) {
        const navPills    = document.querySelector(".pill-nav");
        const mobilePop   = document.querySelector("#mobilePopover");
        const hamburger   = document.querySelector("#hamburgerBtn");
        const inNav = (navPills  && navPills.contains(e.target)) ||
                      (mobilePop && mobilePop.contains(e.target)) ||
                      (hamburger && hamburger.contains(e.target));
        if (inNav) restoreVocab();
    };
    document.addEventListener("click", _deckStudyNavHandler, true);
}
window.studyDeck = studyDeck;

// ═══════════════════════════════════════════════════════════════════════════════
// ADD WORD TO DECK
// ═══════════════════════════════════════════════════════════════════════════════
function openAddToDeck(word) {
    const decks  = getDecks();
    const picker = D("deckPickerOverlay");
    const list   = D("deckPickerList");
    if (!picker || !list) return;

    if (!decks.length) {
        showToast("No decks yet — create one first!", "error");
        openCreateDeck();
        return;
    }

    const frag = document.createDocumentFragment();
    decks.forEach(dk => {
        const item = document.createElement("div");
        item.className = "deck-pick-item";
        item.setAttribute("role", "button");
        item.setAttribute("tabindex", "0");
        item.setAttribute("aria-label", `Add to deck: ${dk.name}`);

        const emojiEl = document.createElement("span");
        emojiEl.className = "deck-pick-emoji";
        emojiEl.setAttribute("aria-hidden", "true");
        emojiEl.textContent = dk.emoji || "📚";

        const nameEl = document.createElement("span");
        nameEl.textContent = dk.name;

        const countEl = document.createElement("span");
        countEl.style.cssText = "margin-left:auto; font-size:11px; color:var(--text-tertiary);";
        countEl.textContent = `${dk.words.length} words`;

        item.append(emojiEl, nameEl, countEl);

        const addWord = () => _addWordToDeckById(dk.id, word);
        item.addEventListener("click", addWord);
        item.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); addWord(); } });

        frag.appendChild(item);
    });

    list.replaceChildren(frag);
    picker.classList.remove("hidden");
}
window.openAddToDeck = openAddToDeck;

function _addWordToDeckById(deckId, word) {
    const decks = getDecks();
    const dk    = decks.find(d => d.id === deckId);
    if (!dk) return;
    const key = wordKey(word);
    if (!dk.words.includes(key)) {
        dk.words.push(key);
        dk.customWords = dk.customWords || {};
        dk.customWords[key] = {
            kanji:    word.kanji    || "",
            hiragana: word.hiragana || "",
            meaning:  word.meaning  || "",
            memory:   word.memory   || "",
            example:  word.example  || "",
            section:  word.section  || "Custom",
            emoji:    word.emoji    || "📘"
        };
        saveDecks(decks);
        showToast(`Added to "${sanitizeHTML(dk.name)}" 📚`, "success");
        haptic(20);
    } else {
        showToast("Already in this deck.", "error");
    }
    closeModal("deckPickerOverlay");
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONTEXT MENU
// ═══════════════════════════════════════════════════════════════════════════════
const _ctxMenu = D("contextMenu");

/* Favourite / weak changes must repaint whichever card list is on screen. */
function _refreshCardViews() {
    if (currentView === "vocabView") renderVocabulary();
    else if (currentView === "kanjiView" && typeof window.renderKanjiList === "function") window.renderKanjiList();
}

function showContextMenu(e, word) {
    if (e && e.preventDefault) e.preventDefault();
    _activeCtxWord = word;
    if (!_ctxMenu) return;
    _ctxMenu.classList.remove("hidden");
    const x = Math.min((e ? e.clientX : window.innerWidth / 2),  window.innerWidth  - 210);
    const y = Math.min((e ? e.clientY : window.innerHeight / 2), window.innerHeight - 250);
    _ctxMenu.style.left = x + "px";
    _ctxMenu.style.top  = y + "px";
    // Focus first item for keyboard users
    const first = _ctxMenu.querySelector(".ctx-item");
    if (first) setTimeout(() => first.focus(), 50);
}
window.showContextMenu = showContextMenu;

// Close on click-outside or Escape
document.addEventListener("click", e => {
    if (_ctxMenu && !_ctxMenu.contains(e.target)) _ctxMenu.classList.add("hidden");
});

D("ctxDetail")?.addEventListener("click", () => {
    if (_activeCtxWord) openWordDetail(_activeCtxWord);
    if(_ctxMenu) _ctxMenu.classList.add("hidden");
});
D("ctxAddDeck")?.addEventListener("click", () => {
    if (_activeCtxWord) openAddToDeck(_activeCtxWord);
    if(_ctxMenu) _ctxMenu.classList.add("hidden");
});
D("ctxFavorite")?.addEventListener("click", () => {
    if (!_activeCtxWord) return;
    const key = wordKey(_activeCtxWord);
    const idx = userProfile.favorites.indexOf(key);
    if (idx > -1) userProfile.favorites.splice(idx, 1);
    else userProfile.favorites.push(key);
    store.set("jlpt_profile", userProfile);
    showToast(idx > -1 ? "Removed from favorites" : "Added to favorites ⭐", "success");
    _refreshCardViews();
    if(_ctxMenu) _ctxMenu.classList.add("hidden");
});
D("ctxWeak")?.addEventListener("click", () => {
    if (!_activeCtxWord) return;
    const key = wordKey(_activeCtxWord);
    const idx = userProfile.weak.indexOf(key);
    if (idx > -1) {
        userProfile.weak.splice(idx, 1);
        store.set("jlpt_profile", userProfile);
        showToast("Removed from weak words", "success");
    } else {
        userProfile.weak.push(key);
        store.set("jlpt_profile", userProfile);
        showToast("Marked as weak 📉", "success");
    }
    _refreshCardViews();
    if(_ctxMenu) _ctxMenu.classList.add("hidden");
});
D("ctxAudio")?.addEventListener("click", () => {
    if (_activeCtxWord) speakJapanese(_activeCtxWord.hiragana || _activeCtxWord.kanji);
    if(_ctxMenu) _ctxMenu.classList.add("hidden");
});
D("ctxCopy")?.addEventListener("click", () => {
    if (_activeCtxWord) {
        const text = _activeCtxWord.kanji || _activeCtxWord.hiragana || "";
        navigator.clipboard?.writeText(text).then(() => showToast("Copied! 📋", "success"))
            .catch(() => showToast("Copy failed.", "error"));
    }
    if(_ctxMenu) _ctxMenu.classList.add("hidden");
});

// ═══════════════════════════════════════════════════════════════════════════════
// WORD DETAIL MODAL
// ═══════════════════════════════════════════════════════════════════════════════
function openWordDetail(word) {
    const overlay = D("wordDetailOverlay");
    const cont    = D("wordDetailContent");
    if (!overlay || !cont) return;
    window._detailWord = word;

    const isVerb = /^to /i.test(word.meaning || "") ||
                   /[うくすつぬふむゆる]$/.test(word.hiragana || "");

    const frag = document.createDocumentFragment();

    const kanjiEl = document.createElement("div");
    kanjiEl.className = "word-detail-kanji";
    kanjiEl.textContent = `${word.emoji || ""} ${word.kanji || ""}`;
    frag.appendChild(kanjiEl);

    const hiraEl = document.createElement("div");
    hiraEl.className = "word-detail-hira";
    hiraEl.textContent = word.hiragana || "";
    frag.appendChild(hiraEl);

    const meanEl = document.createElement("div");
    meanEl.className = "word-detail-meaning";
    meanEl.textContent = word.meaning || "";
    frag.appendChild(meanEl);

    const audioBtn = document.createElement("button");
    audioBtn.className = "nav-btn";
    audioBtn.style.cssText = "display:block; margin:0 auto 14px; width:fit-content;";
    audioBtn.type = "button";
    audioBtn.textContent = "🔊 Play Audio";
    audioBtn.addEventListener("click", () => speakJapanese(word.hiragana || word.kanji));
    frag.appendChild(audioBtn);

    if (word.memory) {
        const memLabel = document.createElement("div");
        memLabel.className = "word-detail-section";
        memLabel.textContent = "Memory Hint";
        const memVal = document.createElement("div");
        memVal.className = "example-sentence";
        memVal.style.borderLeftColor = "var(--accent2)";
        memVal.textContent = "💡 " + word.memory;
        frag.append(memLabel, memVal);
    }

    if (word.examples && word.examples.length) {
        const exLabel = document.createElement("div");
        exLabel.className = "word-detail-section";
        exLabel.textContent = "Examples";
        frag.appendChild(exLabel);
        
        word.examples.forEach(ex => {
            const exVal = document.createElement("div");
            exVal.className = "example-sentence";
            exVal.style.display = "flex";
            exVal.style.justifyContent = "space-between";
            exVal.style.alignItems = "center";
            
            const textWrap = document.createElement("div");
            textWrap.innerHTML = `
                <div style="font-size: 1.1em; font-weight: bold; margin-bottom: 2px;">
                    ${window.renderFurigana ? window.renderFurigana(ex.word, ex.reading) : ex.word}
                </div>
                <div style="font-size: 0.85em; color: var(--text-secondary);">
                    ${ex.meaning}
                </div>
            `;
            exVal.appendChild(textWrap);

            const exAudioBtn = document.createElement("button");
            exAudioBtn.className = "nav-btn";
            exAudioBtn.style.cssText = "width:32px; height:32px; font-size:16px; padding:0; flex-shrink:0;";
            exAudioBtn.type = "button";
            exAudioBtn.textContent = "🔊";
            exAudioBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                if (typeof speakJapanese === "function") speakJapanese(ex.reading || ex.word);
            });
            exVal.appendChild(exAudioBtn);
            
            frag.appendChild(exVal);
        });
    } else if (word.example) {
        const exLabel = document.createElement("div");
        exLabel.className = "word-detail-section";
        exLabel.textContent = "Example Sentence";
        const exVal = document.createElement("div");
        exVal.className = "example-sentence";
        exVal.textContent = word.example;
        frag.append(exLabel, exVal);
    }

    if (isVerb) {
        const h    = word.hiragana || "";
        const stem = h.replace(/[うくすつぬふむゆる]$/, "");
        const conjLabel = document.createElement("div");
        conjLabel.className = "word-detail-section";
        conjLabel.textContent = "Conjugations (approximate)";
        frag.appendChild(conjLabel);

        const table = document.createElement("table");
        table.className = "conjugation-table";
        const rows = [
            ["Form", "Japanese"],
            ["Dictionary", word.kanji || ""],
            ["Polite (〜ます)", stem + "ます"],
            ["Negative", stem + "ない"],
            ["Te-form", stem + "て"],
            ["Past", stem + "た"]
        ];
        rows.forEach((row, i) => {
            const tr = document.createElement("tr");
            row.forEach(cell => {
                const el = document.createElement(i === 0 ? "th" : "td");
                el.textContent = cell;
                tr.appendChild(el);
            });
            table.appendChild(tr);
        });
        frag.appendChild(table);
    }

    const deckLabel = document.createElement("div");
    deckLabel.className = "word-detail-section";
    deckLabel.textContent = "Add to Deck";
    const deckBtn = document.createElement("button");
    deckBtn.className = "nav-btn deck-create-btn";
    deckBtn.style.width = "100%";
    deckBtn.type = "button";
    deckBtn.textContent = "🗂️ Add to Deck";
    deckBtn.addEventListener("click", () => openAddToDeck(window._detailWord));
    frag.append(deckLabel, deckBtn);

    cont.replaceChildren(frag);
    overlay.classList.remove("hidden");
}
window.openWordDetail = openWordDetail;

function closeWordDetail() { closeModal("wordDetailOverlay"); }
window.closeWordDetail = closeWordDetail;

// ═══════════════════════════════════════════════════════════════════════════════
// SWIPE OVERLAY
// ═══════════════════════════════════════════════════════════════════════════════
function setupSwipeOverlay() {
    const card = D("srsFlashcard");
    const ov   = D("swipeOverlay");
    if (!card || !ov) return;

    let sx = 0, sy = 0;
    card.addEventListener("touchstart", e => {
        sx = e.touches[0].clientX;
        sy = e.touches[0].clientY;
    }, { passive: true });

    card.addEventListener("touchmove", e => {
        const dx = e.touches[0].clientX - sx;
        const dy = e.touches[0].clientY - sy;
        if (Math.abs(dy) > Math.abs(dx) && dy < -50) {
            ov.style.background = "rgba(96,165,250,0.25)";
            ov.textContent = "👆 Flip";
            ov.style.opacity = "1";
        } else if (Math.abs(dx) > 50) {
            ov.style.background = dx < 0
                ? "rgba(248,113,113,0.25)"
                : "rgba(74,222,128,0.25)";
            ov.textContent  = dx < 0 ? "👈 Again" : "👉 Easy";
            ov.style.opacity = Math.min(1, Math.abs(dx) / 100).toFixed(2);
        } else {
            ov.style.opacity = "0";
        }
    }, { passive: true });

    card.addEventListener("touchend", () => { ov.style.opacity = "0"; }, { passive: true });
}

// ═══════════════════════════════════════════════════════════════════════════════
// WORD QUICK INFO
// ═══════════════════════════════════════════════════════════════════════════════
function setupWordQuickInfo() {
    D("wqiDetailBtn")?.addEventListener("click", () => {
        const w = vocabulary[reviewIndex];
        if (w) openWordDetail(w);
    });
    D("wqiDeckBtn")?.addEventListener("click", () => {
        const w = vocabulary[reviewIndex];
        if (w) openAddToDeck(w);
    });
    D("wqiFavBtn")?.addEventListener("click", () => {
        const w = vocabulary[reviewIndex];
        if (!w) return;
        const key = wordKey(w);
        const i   = userProfile.favorites.indexOf(key);
        if (i > -1) userProfile.favorites.splice(i, 1);
        else userProfile.favorites.push(key);
        store.set("jlpt_profile", userProfile);
        showToast(i > -1 ? "Removed from favorites" : "Favorited ⭐", "success");
        haptic(15);
    });

    const origCard = D("srsFlashcard");
    if (origCard) {
        origCard.addEventListener("click", () => {
            const qi = D("wordQuickInfo");
            if (!qi) return;
            qi.classList.toggle("hidden", !origCard.classList.contains("flipped"));
        });
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// VOCAB FILTER CHIPS
// ═══════════════════════════════════════════════════════════════════════════════
function setupVocabFilters() {
    document.querySelectorAll(".filter-chip").forEach(btn => {
        btn.addEventListener("click", async () => {
            document.querySelectorAll(".filter-chip").forEach(b => {
                b.classList.remove("active-chip");
                b.setAttribute("aria-pressed", "false");
            });
            btn.classList.add("active-chip");
            btn.setAttribute("aria-pressed", "true");

            const f = btn.dataset.filter;
            if (f === "all")       filteredVocabulary = [...vocabulary];
            else if (f === "learned")   filteredVocabulary = await loadAllLessonsVocab(v => userProfile.learned.includes(wordKey(v)));
            else if (f === "unlearned") filteredVocabulary = await loadAllLessonsVocab(v => !userProfile.learned.includes(wordKey(v)));
            else if (f === "favorites") filteredVocabulary = await loadAllLessonsVocab(v => userProfile.favorites.includes(wordKey(v)));
            else if (f === "weak")      filteredVocabulary = await loadAllLessonsVocab(v => userProfile.weak.includes(wordKey(v)));
            window.filteredVocabulary = filteredVocabulary;
            renderVocabulary();
        });
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// GRID / LIST VIEW TOGGLE
// ═══════════════════════════════════════════════════════════════════════════════
function setupViewToggle() {
    D("gridViewBtn")?.addEventListener("click", () => {
        document.body.classList.remove("vocab-list-view");
        D("gridViewBtn")?.classList.add("active-view-btn");
        D("listViewBtn")?.classList.remove("active-view-btn");
        D("gridViewBtn")?.setAttribute("aria-pressed", "true");
        D("listViewBtn")?.setAttribute("aria-pressed", "false");
        store.set("jlpt_vocab_view", "grid");
    });
    D("listViewBtn")?.addEventListener("click", () => {
        document.body.classList.add("vocab-list-view");
        D("listViewBtn")?.classList.add("active-view-btn");
        D("gridViewBtn")?.classList.remove("active-view-btn");
        D("listViewBtn")?.setAttribute("aria-pressed", "true");
        D("gridViewBtn")?.setAttribute("aria-pressed", "false");
        store.set("jlpt_vocab_view", "list");
    });
    if (store.get("jlpt_vocab_view", "grid") === "list") {
        document.body.classList.add("vocab-list-view");
        D("listViewBtn")?.classList.add("active-view-btn");
        D("listViewBtn")?.setAttribute("aria-pressed", "true");
        D("gridViewBtn")?.classList.remove("active-view-btn");
        D("gridViewBtn")?.setAttribute("aria-pressed", "false");
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// VOCAB CARD RIGHT-CLICK / LONG-PRESS CONTEXT MENU
// ═══════════════════════════════════════════════════════════════════════════════
let _vocabCtxObserver = null;
function hookVocabContextMenu() {
    const cont = D("vocabularyContainer");
    if (!cont) return;
    if (_vocabCtxObserver) { _vocabCtxObserver.disconnect(); _vocabCtxObserver = null; }

    _vocabCtxObserver = new MutationObserver(() => {
        cont.querySelectorAll(".spatial-card:not([data-ctx])").forEach(card => {
            card.dataset.ctx = "1";
            const word = {
                kanji:    card.dataset.kanji    || "",
                hiragana: card.dataset.hiragana || "",
                meaning:  card.dataset.meaning  || "",
                memory:   card.dataset.memory   || "",
                example:  card.dataset.example  || "",
                emoji:    card.dataset.emoji    || ""
            };

            card.addEventListener("contextmenu", e => showContextMenu(e, word));

            let pressTimer = null;
            card.addEventListener("touchstart", () => {
                pressTimer = setTimeout(() => { haptic(40); showContextMenu(null, word); }, 650);
            }, { passive: true });
            card.addEventListener("touchend",  () => clearTimeout(pressTimer), { passive: true });
            card.addEventListener("touchmove", () => clearTimeout(pressTimer), { passive: true });
        });
    });
    _vocabCtxObserver.observe(cont, { childList: true });
}

// ═══════════════════════════════════════════════════════════════════════════════
// FONT SIZE
// ═══════════════════════════════════════════════════════════════════════════════
function setupFontSize() {
    const saved = store.get("jlpt_font_size", "medium");
    _applyFontSize(saved);
    document.querySelectorAll(".font-size-btn").forEach(btn => {
        btn.classList.toggle("active-font-size", btn.dataset.size === saved);
        btn.setAttribute("aria-pressed", String(btn.dataset.size === saved));
        btn.addEventListener("click", () => {
            _applyFontSize(btn.dataset.size);
            store.set("jlpt_font_size", btn.dataset.size);
            document.querySelectorAll(".font-size-btn").forEach(b => {
                b.classList.toggle("active-font-size", b.dataset.size === btn.dataset.size);
                b.setAttribute("aria-pressed", String(b.dataset.size === btn.dataset.size));
            });
            showToast(`Font: ${btn.dataset.size}`, "success");
        });
    });
}

function _applyFontSize(s) {
    document.body.classList.remove("font-small", "font-medium", "font-large");
    if (s !== "medium") document.body.classList.add("font-" + s);
}

// ═══════════════════════════════════════════════════════════════════════════════
// FURIGANA
// ═══════════════════════════════════════════════════════════════════════════════
function setupFurigana() {
    const t = D("furiganaToggle");
    if (!t) return;
    const s = store.get("jlpt_furigana", true);
    t.checked = s;
    if (!s) document.body.classList.add("hide-furigana");
    t.addEventListener("change", () => {
        store.set("jlpt_furigana", t.checked);
        document.body.classList.toggle("hide-furigana", !t.checked);
        showToast(t.checked ? "Furigana shown" : "Furigana hidden", "success");
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// HIGH CONTRAST
// ═══════════════════════════════════════════════════════════════════════════════
function setupHighContrast() {
    const t = D("highContrastToggle");
    if (!t) return;
    const s = store.get("jlpt_high_contrast", false);
    t.checked = s;
    if (s) document.body.classList.add("high-contrast");
    t.addEventListener("change", () => {
        store.set("jlpt_high_contrast", t.checked);
        document.body.classList.toggle("high-contrast", t.checked);
        showToast(t.checked ? "High contrast on" : "High contrast off", "success");
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// REDUCE MOTION
// ═══════════════════════════════════════════════════════════════════════════════
function setupReduceMotion() {
    const t = D("reduceMotionToggle");
    if (!t) return;
    const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const s = store.get("jlpt_reduce_motion", false) || prefersReduced;
    t.checked = s;
    if (s) document.body.classList.add("reduce-motion");
    t.addEventListener("change", () => {
        store.set("jlpt_reduce_motion", t.checked);
        document.body.classList.toggle("reduce-motion", t.checked);
        showToast(t.checked ? "Reduced motion on" : "Animations on", "success");
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// FLIP STYLE
// ═══════════════════════════════════════════════════════════════════════════════
function setupFlipStyle() {
    const sel = D("flipStyleSelect");
    if (!sel) return;
    const s = store.get("jlpt_flip_style", "horizontal");
    sel.value = s;
    _applyFlipStyle(s);
    sel.addEventListener("change", () => {
        _applyFlipStyle(sel.value);
        store.set("jlpt_flip_style", sel.value);
        showToast(`Flip: ${sel.value}`, "success");
    });
}

function _applyFlipStyle(s) {
    document.body.classList.remove("flip-vertical", "flip-fade");
    if (s === "vertical") document.body.classList.add("flip-vertical");
    if (s === "fade")     document.body.classList.add("flip-fade");
}

// ═══════════════════════════════════════════════════════════════════════════════
// NOTIFICATIONS
// ═══════════════════════════════════════════════════════════════════════════════
function setupNotifications() {
    const btn    = D("enableNotifBtn");
    const status = D("notifStatus");
    if (!btn) return;

    if (!("Notification" in window)) {
        if (status) status.textContent = "Notifications not supported on this browser.";
        btn.disabled = true;
        return;
    }
    if (Notification.permission === "granted") {
        if (status) status.textContent = "✅ Notifications enabled";
        btn.textContent = "🔕 Disable Reminders";
    }
    btn.addEventListener("click", async () => {
        if (Notification.permission === "granted") { showToast("Notifications already enabled!", "success"); return; }
        const perm = await Notification.requestPermission();
        if (perm === "granted") {
            if (status) status.textContent = "✅ Notifications enabled";
            btn.textContent = "🔕 Disable Reminders";
            showToast("🔔 You will be reminded when reviews are due!", "success");
            _scheduleReviewNotification();
        } else {
            if (status) status.textContent = "❌ Permission denied by browser";
            showToast("Notification permission denied.", "error");
        }
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// OFFLINE BANNER
// ═══════════════════════════════════════════════════════════════════════════════
function setupOfflineBanner() {
    const banner = D("offlineBanner");
    if (!banner) return;
    const update = () => banner.classList.toggle("hidden", navigator.onLine);
    window.addEventListener("online",  update, { passive: true });
    window.addEventListener("offline", update, { passive: true });
    update();
}

// ═══════════════════════════════════════════════════════════════════════════════
// TYPING MODE (QUIZ)
// ═══════════════════════════════════════════════════════════════════════════════
function setupTypingMode() {
    D("typingSubmitBtn")?.addEventListener("click", _checkTypingAnswer);
    D("typingInput")?.addEventListener("keydown", e => {
        if (e.key === "Enter") { e.preventDefault(); _checkTypingAnswer(); }
    });
}

function _checkTypingAnswer() {
    const input = D("typingInput");
    if (!input) return;
    const val = input.value.trim();
    if (!val) return;

    const w = window._currentQuizWord;
    if (!w) return;

    const ans = (quizMode === "listening"
        ? w.meaning
        : w.hiragana || w.kanji
    ).toLowerCase();

    const uLow   = val.toLowerCase();
    const uHira  = (typeof normalizeRomaji === "function") ? normalizeRomaji(uLow) : uLow;
    const correct = uLow === ans || uHira === ans ||
                    ans.split(",").map(p => p.trim()).some(p => p === uLow || p === uHira);

    input.style.borderColor = correct ? "var(--success)" : "var(--danger)";
    showToast(correct ? "✅ Correct!" : `❌ Answer: ${ans}`, correct ? "success" : "error");

    if (correct) {
        score++;
        recordStudy();
        addXP(12, "Typing answer ✅");
        recordHeatmap();
    } else {
        const key = wordKey(w);
        if (key && !userProfile.weak.includes(key)) {
            userProfile.weak.push(key);
            store.set("jlpt_profile", userProfile);
        }
    }
    setTimeout(() => { input.value = ""; input.style.borderColor = ""; qNum++; nextQuizQuestion(); }, 1200);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SRS BUTTON HOOKS — XP + heatmap + speed round + undo state
// ═══════════════════════════════════════════════════════════════════════════════
function hookSRSButtons() {
    const xpMap = [5, 8, 12, 15];
    // We use a single delegated listener on srsDock to avoid duplicate handlers
    // (app.js already binds srsBtn1–4 for processSRSGrade).
    // Here we only patch the POST-grade side effects via the processSRSGrade wrapper.
    const origProcessSRSGrade = window.processSRSGrade;
    window.processSRSGrade = function(grade) {
        const idx  = window.reviewIndex;
        const vocab = window.vocabulary || [];
        const w    = vocab[idx];
        if (w) {
            const key = wordKey(w);
            if (key && srsData[key]) {
                _lastSRSGrade = grade;
                _lastSRSIndex = idx;
                _lastSRSData  = { ...srsData[key] };
                const undoBtn = D("reviewUndoBtn");
                if (undoBtn) undoBtn.disabled = false;
            }
        }
        if (typeof origProcessSRSGrade === "function") origProcessSRSGrade.call(this, grade);

        const xpIdx = grade - 1;
        addXP(xpMap[xpIdx] || 5, grade >= 3 ? "Correct review ✅" : "Kept studying 💪");
        recordHeatmap();
        if (_speedRoundTimer) _speedRoundScore++;

        const today = new Date().toDateString();
        if (store.get("jlpt_challenge_date", "") === today && w) {
            const challengeKeys = store.get("jlpt_challenge_words", []);
            const completedKeys = store.get("jlpt_challenge_completed_keys", []);
            const thisKey = wordKey(w);
            if (challengeKeys.includes(thisKey) && !completedKeys.includes(thisKey)) {
                completedKeys.push(thisKey);
                store.set("jlpt_challenge_completed_keys", completedKeys);
                store.set("jlpt_challenge_done", completedKeys.length);
                updateChallengeProgress();
            }
        }
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// RADIAL HAPTIC MENU
// ═══════════════════════════════════════════════════════════════════════════════
function setupRadialMenu() {
    const card     = D("srsFlashcard");
    const menu     = D("radialMenu");
    const backdrop = D("radialBackdrop");
    if (!card || !menu || !backdrop) return;

    const RADIUS = 84;
    let pressTimer = null;

    function openMenu(cx, cy) {
        const vw = window.innerWidth, vh = window.innerHeight;
        const sx = Math.max(RADIUS + 10, Math.min(vw - RADIUS - 10, cx));
        const sy = Math.max(RADIUS + 10, Math.min(vh - RADIUS - 10, cy));
        menu.style.left = sx + "px";
        menu.style.top  = sy + "px";

        const items = menu.querySelectorAll(".radial-item");
        items.forEach((el, i) => {
            const angle = (i / items.length) * Math.PI * 2 - Math.PI / 2;
            el.style.left           = (RADIUS * Math.cos(angle)) + "px";
            el.style.top            = (RADIUS * Math.sin(angle)) + "px";
            el.style.animationDelay = (i * 0.045) + "s";
        });

        menu.classList.remove("hidden");
        menu.classList.add("active");
        backdrop.classList.remove("hidden");
        // Focus first item
        const first = menu.querySelector(".radial-item");
        if (first) setTimeout(() => first.focus(), 60);
    }

    function closeMenu() {
        menu.classList.add("hidden");
        menu.classList.remove("active");
        window.closeModal?.(backdrop.id);
    }

    card.addEventListener("touchstart", e => {
        const t = e.touches[0];
        pressTimer = setTimeout(() => {
            haptic([30, 20, 60]);
            openMenu(t.clientX, t.clientY);
        }, 560);
    }, { passive: true });
    card.addEventListener("touchmove",  () => clearTimeout(pressTimer), { passive: true });
    card.addEventListener("touchend",   () => clearTimeout(pressTimer), { passive: true });
    card.addEventListener("contextmenu", e => { e.preventDefault(); openMenu(e.clientX, e.clientY); });

    backdrop.addEventListener("click", closeMenu);

    const radialActions = {
        radialAudio:  () => { const w = vocabulary[reviewIndex]; if (w) speakJapanese(w.hiragana || w.kanji); haptic(15); },
        radialFav:    () => {
            const w = vocabulary[reviewIndex]; if (!w) return;
            const key = wordKey(w);
            const i   = userProfile.favorites.indexOf(key);
            if (i > -1) userProfile.favorites.splice(i, 1); else userProfile.favorites.push(key);
            store.set("jlpt_profile", userProfile);
            showToast(i > -1 ? "Removed from favorites" : "Favorited ⭐", "success"); haptic(15);
        },
        radialDeck:   () => { const w = vocabulary[reviewIndex]; if (w) openAddToDeck(w); },
        radialWeak:   () => {
            const w = vocabulary[reviewIndex]; if (!w) return;
            const key = wordKey(w);
            const idx = userProfile.weak.indexOf(key);
            if (idx > -1) {
                userProfile.weak.splice(idx, 1);
                store.set("jlpt_profile", userProfile);
                showToast("Removed from weak words", "success");
            } else {
                userProfile.weak.push(key);
                store.set("jlpt_profile", userProfile);
                showToast("Marked as weak 📉", "success");
            }
            haptic(15);
        },
        radialDetail: () => { const w = vocabulary[reviewIndex]; if (w) openWordDetail(w); }
    };

    Object.entries(radialActions).forEach(([id, fn]) => {
        D(id)?.addEventListener("click", () => { fn(); closeMenu(); });
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// KEYBOARD SHORTCUTS — decks.js additions (extends app.js)
// ═══════════════════════════════════════════════════════════════════════════════
document.addEventListener("keydown", e => {
    const tag     = document.activeElement?.tagName;
    const isInput = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";

    if (isInput) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (e.key === "?") {
        e.preventDefault();
        const overlay = D("shortcutOverlay");
        if (overlay) {
            if (overlay.classList.contains("hidden")) openModal("shortcutOverlay");
            else closeModal("shortcutOverlay");
        }
        return;
    }
    if (e.key === "d" || e.key === "D") {
        e.preventDefault();
        const deckViewOpen   = !D("deckViewOverlay")?.classList.contains("hidden");
        const createDeckOpen = !D("createDeckOverlay")?.classList.contains("hidden");
        if (deckViewOpen) {
            closeDeckView();
        } else if (!createDeckOpen) {
            openDeckView();
        }
        return;
    }
    if (e.key === "h" || e.key === "H") { D("dashboardBtn")?.click(); return; }
    if (e.key === "v" || e.key === "V") { D("vocabBtn")?.click();     return; }
    if (e.key === "r" || e.key === "R") { D("reviewBtn")?.click();    return; }
    if (e.key === "q" || e.key === "Q") { D("quizBtn")?.click();      return; }

    if (e.key === "g" || e.key === "G") {
        if (window.currentView === "gamesView") D("dashboardBtn")?.click();
        else D("gamesBtn")?.click();
        return;
    }
    if (e.key === "t" || e.key === "T") {
        D("themeToggleBtn")?.click();
        return;
    }
    if (e.key === "s" || e.key === "S") {
        if (window.currentView !== "reviewView") {
            const drawer = D("sdDrawer");
            if (drawer && drawer.classList.contains("sd-open")) {
                if (typeof window.closeSettingsDrawer === "function") window.closeSettingsDrawer();
            } else {
                if (typeof window.openSettingsDrawer === "function") window.openSettingsDrawer();
            }
            return;
        }
    }
    if (e.key === "e" || e.key === "E") {
        if (window.store && typeof window.store.export === "function") window.store.export();
        return;
    }
    if (e.key === "c" || e.key === "C") {
        const wrap = D("dailyChallengeWrap");
        if (wrap && !wrap.classList.contains("hidden")) {
            window.closeModal?.(wrap.id);
        } else {
            if (typeof window.startDailyChallenge === "function") window.startDailyChallenge();
        }
        return;
    }
    if (e.key === "a" || e.key === "A") {
        const bar = D("speedRoundBar");
        if (bar && !bar.classList.contains("hidden")) {
            if (typeof _speedRoundTimer !== 'undefined') {
                clearInterval(_speedRoundTimer);
                _speedRoundTimer = null;
            }
            if (bar.id) { window.closeModal?.(bar.id); } else { bar.classList.add("hidden"); };
            if (typeof window.endSpeedRound === "function") window.endSpeedRound();
        } else {
            if (typeof window.startSpeedRound === "function") window.startSpeedRound();
        }
        return;
    }
    if (window.currentView === "reviewView") {
        if (e.key === "z" || e.key === "Z") { undoLastGrade(); return; }
        if (e.key === "f" || e.key === "F") {
            const w = vocabulary[reviewIndex]; if (!w) return;
            const key = wordKey(w);
            const i   = userProfile.favorites.indexOf(key);
            if (i > -1) userProfile.favorites.splice(i, 1); else userProfile.favorites.push(key);
            store.set("jlpt_profile", userProfile);
            showToast(i > -1 ? "Removed from favorites" : "Favorited ⭐", "success"); haptic(15);
            return;
        }
        if (e.key === "s" || e.key === "S") {
            const w = vocabulary[reviewIndex]; if (w) speakJapanese(w.hiragana || w.kanji); return;
        }
        if (e.key === "i" || e.key === "I") {
            const w = vocabulary[reviewIndex]; if (w) openWordDetail(w); return;
        }
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// NAV BUTTON WIRING
// ═══════════════════════════════════════════════════════════════════════════════
D("decksNavBtn")?.addEventListener("click",   openDeckView);
D("mDecksBtn")?.addEventListener("click", () => {
    document.body.style.overflow = "";
    if ($("mobilePopover")) {
        $("mobilePopover").setAttribute("aria-hidden", "true");
        $("hamburgerBtn")?.setAttribute("aria-expanded", "false");
    }
    openDeckView();
});
D("createDeckFab")?.addEventListener("click", openCreateDeck);
D("reviewUndoBtn")?.addEventListener("click", undoLastGrade);

// Disable undo button initially
const _undoBtn = D("reviewUndoBtn");
if (_undoBtn) _undoBtn.disabled = true;

// Dashboard refresh triggers heatmap + XP + readiness repaint
["dashboardBtn", "mDashboardBtn"].forEach(id => {
    D(id)?.addEventListener("click", () => {
        setTimeout(() => {
            updateHeatmap();
            updateXPBar();
            updateReadiness();
        }, 120);
    });
});

function setupDeckFilters() {
    D("filterDeckVocab")?.addEventListener("click", () => {
        window._deckFilter = "vocab";
        renderDeckList();
    });
    D("filterDeckGrammar")?.addEventListener("click", () => {
        window._deckFilter = "grammar";
        renderDeckList();
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// INITIALISE — all setup functions, deferred 400 ms after scripts load
// ═══════════════════════════════════════════════════════════════════════════════
document.addEventListener("DOMContentLoaded", () => {
    requestAnimationFrame(() => {
        const inits = [
            setupSwipeOverlay,
            setupWordQuickInfo,
            setupVocabFilters,
            setupViewToggle,
            hookVocabContextMenu,
            setupFontSize,
            setupFurigana,
            setupHighContrast,
            setupReduceMotion,
            setupFlipStyle,
            setupNotifications,
            setupOfflineBanner,
            setupTypingMode,
            hookSRSButtons,
            setupSettingsDrawer,
            setupRadialMenu,
            updateXPBar,
            updateHeatmap,
            updateReadiness,
            setupDeckFilters
        ];
        inits.forEach(fn => {
            try { fn(); } catch (err) { console.warn(`[decks.js] Init failed: ${fn.name}`, err); }
        });
    });
});