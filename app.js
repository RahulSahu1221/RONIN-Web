/*app.js 

"use strict";

/* ═══════════════════════════════════════════════════════════════════════════════
   RONIN — app.js
   Core engine: background FX, store, dashboard, review (SRS), quiz, routing,
   command palette, theming, SRS dock magnification.
   ═══════════════════════════════════════════════════════════════════════════════ */

/* ─────────────────────────────────────────────────────────────────────────────
   Single shared key helper — every feature (favorites/learned/weak/SRS/decks)
   must use the EXACT same identity for a word, or state silently desyncs for
   any hiragana-only entry. This is the one and only place that decision lives.
   ───────────────────────────────────────────────────────────────────────────── */
function wordKey(w) {
    if (!w) return "";
    return w.kanji || w.hiragana || "";
}
window.wordKey = wordKey;

function _scheduleReviewNotification() {
    const now = Date.now();
    const due = Object.values(srsData).filter(v => v && v.dueDate <= now + 86400000).length;
    if (due > 0) {
        setTimeout(() => {
            if (typeof Notification !== "undefined" && Notification.permission === "granted") {
                try {
                    new Notification("RONIN 🎌", {
                        body: `You have ${due} word${due > 1 ? "s" : ""} ready for review!`,
                        icon: "./data/assets/logo.png"
                    });
                } catch (_) { /* permission revoked between check and fire */ }
            }
        }, 5000);
    }
}


/* ═══════════════════════════════════════════════════════════════════════════════
   GLOBAL HELPERS & PWA INIT
   ═══════════════════════════════════════════════════════════════════════════════ */
const $ = id => document.getElementById(id);
window.$ = $;

function haptic(ms = 15) {
    if (navigator.vibrate) {
        try { navigator.vibrate(ms); } catch (_) { /* some browsers throw on invalid pattern */ }
    }
}
window.haptic = haptic;

function safeText(el, text) { if (el) el.textContent = String(text ?? ""); }

// Escapes a string for safe innerHTML insertion. Always run any user-, API-,
// or third-party-sourced text through this before placing it in markup.
function sanitizeHTML(str) {
    const temp = document.createElement("div");
    temp.textContent = String(str ?? "");
    return temp.innerHTML;
}
window.sanitizeHTML = sanitizeHTML;

// Escapes a string for safe placement inside a single-quoted HTML attribute
// (e.g. inline onclick="fn('...')"). sanitizeHTML alone is NOT enough here
// because it doesn't escape the quote character itself.
function sanitizeAttr(str) {
   return sanitizeHTML(str).replace(/'/g, "&#39;").replace(/"/g, "&quot;");
}
window.sanitizeAttr = sanitizeAttr;

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}
window.shuffleArray = shuffleArray;

// Production-safe global error handling: log full detail to console for
// developers, but never leak raw stack/error text to the end user via toast.
const IS_LOCALHOST = ["localhost", "127.0.0.1", ""].includes(location.hostname);
window.onerror = (msg, url, line, col, err) => {
    console.error("[RONIN]", msg, url, line, col, err);
    if (IS_LOCALHOST) showToast(`Dev error: ${msg}`, "error");
    else showToast("Something went wrong. Please try again.", "error");
    return false;
};
window.addEventListener("unhandledrejection", e => {
    console.error("[RONIN] Unhandled rejection:", e.reason);
    if (IS_LOCALHOST) showToast(`Dev rejection: ${e.reason}`, "error");
    else showToast("Something went wrong. Please try again.", "error");
});

if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
        if (location.hostname === "localhost" || location.hostname === "127.0.0.1" || location.hostname === "") {
            navigator.serviceWorker.getRegistrations().then(registrations => {
                for (let r of registrations) r.unregister();
            });
            caches.keys().then(names => {
                for (let n of names) caches.delete(n);
            });
        } else {
            /* Update flow: a new worker installs and waits. We show a banner;
               only when the person taps "Update" do we tell it to take over,
               and only that reload is allowed (updateRequested). The very
               first install also fires controllerchange (clients.claim), and
               must NOT reload the page, which is why the flag exists. */
            let updateRequested = false;
            const banner = document.getElementById("updateBanner");
            const showUpdateBanner = worker => {
                if (!banner || !worker) return;
                banner.classList.remove("hidden");
                const btn = document.getElementById("updateBannerBtn");
                if (btn) btn.onclick = () => {
                    updateRequested = true;
                    btn.disabled = true;
                    worker.postMessage("SKIP_WAITING");
                };
                const dismiss = document.getElementById("updateBannerDismiss");
                if (dismiss) dismiss.onclick = () => banner.classList.add("hidden");
            };

            navigator.serviceWorker.register("sw.js").then(reg => {
                /* A worker already waiting from an earlier visit. */
                if (reg.waiting && navigator.serviceWorker.controller) showUpdateBanner(reg.waiting);
                reg.addEventListener("updatefound", () => {
                    const w = reg.installing;
                    if (!w) return;
                    w.addEventListener("statechange", () => {
                        if (w.state === "installed" && navigator.serviceWorker.controller) showUpdateBanner(w);
                    });
                });
                /* Check for a new version when the app returns to the foreground. */
                document.addEventListener("visibilitychange", () => {
                    if (document.visibilityState === "visible") reg.update().catch(() => {});
                });
            }).catch(err => console.warn("SW registration failed:", err));

            navigator.serviceWorker.addEventListener("controllerchange", () => {
                if (updateRequested) window.location.reload();
            });
        }
    });
}

let japaneseVoice = null;
function initSpeechVoices() {
    if (!window.speechSynthesis) return;
    const voices = speechSynthesis.getVoices();
    japaneseVoice =
        voices.find(v => v.lang === "ja-JP") ||
        voices.find(v => v.lang.startsWith("ja")) ||
        null;
}
if (window.speechSynthesis) {
    speechSynthesis.onvoiceschanged = initSpeechVoices;
}
document.addEventListener("click", initSpeechVoices, { once: true });

/* ═══════════════════════════════════════════════════════════════════════════════
   DATA STORE
   ═══════════════════════════════════════════════════════════════════════════════ */
const store = {
    get(key, fb) {
        try {
            const raw = localStorage.getItem(key);
            if (raw === null) return fb;
            const parsed = JSON.parse(raw);
            return parsed === null || parsed === undefined ? fb : parsed;
        } catch {
            return fb;
        }
    },
    set(key, val) {
        try {
            localStorage.setItem(key, JSON.stringify(val));
            return true;
        } catch {
            showToast("Storage quota exceeded!", "error");
            return false;
        }
    },
    export() {
        const data = {
            profile: store.get("jlpt_profile", {}),
            srs: store.get("jlpt_srs", {}),
            lesson: store.get("jlpt_lastLesson", 1),
            decks: store.get("jlpt_decks", []),
            xp: store.get("jlpt_xp", 0),
            heatmap: store.get("jlpt_heatmap", {})
        };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
        const a = document.createElement("a");
        const objectUrl = URL.createObjectURL(blob);
        a.href = objectUrl;
        a.download = `jlpt_backup_${new Date().toISOString().split("T")[0]}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(objectUrl), 150);
    },
    import(file) {
        const reader = new FileReader();
        reader.onload = e => {
            try {
                const data = JSON.parse(e.target.result);
                if (!data || typeof data !== 'object' || Array.isArray(data)) {
                    showToast("Invalid backup file format.", "error"); return;
                }
                const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
                const isArr = v => Array.isArray(v);
                if (data.profile && isObj(data.profile)) {
                    const p = data.profile;
                    const clean = {
                        learned:   isArr(p.learned)   ? p.learned.filter(s => typeof s === 'string').slice(0, 10000) : [],
                        favorites: isArr(p.favorites) ? p.favorites.filter(s => typeof s === 'string').slice(0, 10000) : [],
                        weak:      isArr(p.weak)      ? p.weak.filter(s => typeof s === 'string').slice(0, 10000) : [],
                        achievements: isArr(p.achievements) ? p.achievements.filter(s => typeof s === 'string').slice(0, 500) : [],
                        streak:    typeof p.streak === 'number'    ? p.streak    : 0,
                        bestStreak:typeof p.bestStreak === 'number'? p.bestStreak: 0,
                        lastActive:typeof p.lastActive === 'number'? p.lastActive: 0,
                        dailyGoal: typeof p.dailyGoal === 'number' ? p.dailyGoal : 20,
                        wordsStudiedToday: typeof p.wordsStudiedToday === 'number' ? p.wordsStudiedToday : 0,
                        autoPlay:  typeof p.autoPlay === 'boolean' ? p.autoPlay  : false
                    };
                    store.set("jlpt_profile", clean);
                }
                if (data.srs && isObj(data.srs)) store.set("jlpt_srs", data.srs);
                if (data.decks && isArr(data.decks)) store.set("jlpt_decks", data.decks);
                if (typeof data.xp === 'number') store.set("jlpt_xp", data.xp);
                if (data.heatmap && isObj(data.heatmap)) store.set("jlpt_heatmap", data.heatmap);
                showToast("Data restored successfully!", "success");
                setTimeout(() => location.reload(), 1200);
            } catch {
                showToast("Invalid backup file.", "error");
            }
        };
        reader.readAsText(file);
    }
};
window.store = store;

let userProfile = store.get("jlpt_profile", {
    learned: [], favorites: [], weak: [], streak: 0, bestStreak: 0, lastActive: 0,
    dailyGoal: 20, wordsStudiedToday: 0, autoPlay: false, achievements: []
});
// Defensive defaults in case an older/partial profile is loaded from storage.
userProfile.learned = userProfile.learned || [];
userProfile.favorites = userProfile.favorites || [];
userProfile.weak = userProfile.weak || [];
userProfile.achievements = userProfile.achievements || [];
userProfile.dailyGoal = userProfile.dailyGoal || 20;
userProfile.streakFreezes = userProfile.streakFreezes || 0;

let srsData = store.get("jlpt_srs", {});

const todayStr = new Date().toDateString();
if (store.get("jlpt_lastActiveDate", "") !== todayStr) {
    const lastDateStr = store.get("jlpt_lastActiveDate", "");
    if (lastDateStr) {
        const lastDate  = new Date(lastDateStr);
        const todayDate = new Date(todayStr);
        const diffDays  = Math.round((todayDate - lastDate) / 86400000);
        if (diffDays === 1) {
            userProfile.streak++;
        } else if (diffDays > 1) {
            let freezes = userProfile.streakFreezes || 0;
            let daysMissed = diffDays - 1;
            
            if (freezes >= daysMissed) {
                userProfile.streakFreezes = freezes - daysMissed;
                userProfile.streak++;
                if (typeof showToast === "function") setTimeout(() => showToast(`❄️ Streak Freeze used! (${daysMissed} consumed)`, "success"), 1000);
            } else {
                userProfile.streak = 1;
                userProfile.streakFreezes = 0;
            }
        }
    } else {
        userProfile.streak = userProfile.streak || 1;
    }

    userProfile.wordsStudiedToday = 0;
    store.set("jlpt_lastActiveDate", todayStr);
}
userProfile.bestStreak = Math.max(userProfile.bestStreak || 0, userProfile.streak);
userProfile.lastActive = Date.now();
store.set("jlpt_profile", userProfile);
window.userProfile = userProfile;
window.srsData = srsData;

/* ═══════════════════════════════════════════════════════════════════════════════
   STATE
   ═══════════════════════════════════════════════════════════════════════════════ */
let vocabulary = [], filteredVocabulary = [], currentView = "dashboardView";
let reviewIndex = 0;
let quizMode = "kanjiToMeaning", score = 0, qNum = 0, quizQueue = [];
window.vocabulary = vocabulary;
window.filteredVocabulary = filteredVocabulary;

/* ═══════════════════════════════════════════════════════════════════════════════
   INTERSECTION OBSERVER (card reveal-on-scroll)
   ═══════════════════════════════════════════════════════════════════════════════ */
const revealObserver = new IntersectionObserver((entries) => {
    entries.forEach(e => {
        if (e.isIntersecting) { e.target.classList.add("revealed"); revealObserver.unobserve(e.target); }
    });
}, { threshold: 0.05, rootMargin: "0px 0px 50px 0px" });

/* ═══════════════════════════════════════════════════════════════════════════════
   ROMAJI → HIRAGANA
   ═══════════════════════════════════════════════════════════════════════════════ */
const r2k = { "a": "あ", "i": "い", "u": "う", "e": "え", "o": "お", "ka": "か", "ki": "き", "ku": "く", "ke": "け", "ko": "こ", "sa": "さ", "shi": "し", "su": "す", "se": "せ", "so": "そ", "ta": "た", "chi": "ち", "tsu": "つ", "te": "て", "to": "と", "na": "な", "ni": "に", "nu": "ぬ", "ne": "ね", "no": "の", "ha": "は", "hi": "ひ", "fu": "ふ", "he": "へ", "ho": "ほ", "ma": "ま", "mi": "み", "mu": "む", "me": "め", "mo": "も", "ya": "や", "yu": "ゆ", "yo": "よ", "ra": "ら", "ri": "り", "ru": "る", "re": "れ", "ro": "ろ", "wa": "わ", "wo": "を", "nn": "ん", "ga": "が", "gi": "ぎ", "gu": "ぐ", "ge": "げ", "go": "ご", "za": "ざ", "ji": "じ", "zu": "ず", "ze": "ぜ", "zo": "ぞ", "da": "だ", "de": "で", "do": "ど", "ba": "ば", "bi": "び", "bu": "ぶ", "be": "べ", "bo": "ぼ", "pa": "ぱ", "pi": "ぴ", "pu": "ぷ", "pe": "ぺ", "po": "ぽ", "kya": "きゃ", "kyu": "きゅ", "kyo": "きょ", "sha": "しゃ", "shu": "しゅ", "sho": "しょ", "cha": "ちゃ", "chu": "ちゅ", "cho": "ちょ", "nya": "にゃ", "nyu": "にゅ", "nyo": "にょ", "hya": "ひゃ", "hyu": "ひゅ", "hyo": "ひょ", "mya": "みゃ", "myu": "みゅ", "myo": "みょ", "rya": "りゃ", "ryu": "りゅ", "ryo": "りょ", "gya": "ぎゃ", "gyu": "ぎゅ", "gyo": "ぎょ", "ja": "じゃ", "ju": "じゅ", "jo": "じょ", "bya": "びゃ", "byu": "びゅ", "byo": "びょ", "pya": "ぴゃ", "pyu": "ぴゅ", "pyo": "ぴょ" };
function normalizeRomaji(str) {
    let s = String(str || "").toLowerCase(), res = "";
    while (s.length) {
        /* "n" on its own (before a consonant or at the end) is ん; a doubled consonant is っ */
        if (s[0] === "n" && (s.length === 1 || !/[aiueoyn']/.test(s[1]) || (s[1] === "n" && /[aiueoy]/.test(s[2] || "")))) { res += "ん"; s = s.substring(1); continue; }
        if (s.length > 1 && s[0] === s[1] && /[kstpcgzdbfhjmrw]/.test(s[0])) { res += "っ"; s = s.substring(1); continue; }
        if (s.length >= 3 && r2k[s.substring(0, 3)]) { res += r2k[s.substring(0, 3)]; s = s.substring(3); }
        else if (s.length >= 2 && r2k[s.substring(0, 2)]) { res += r2k[s.substring(0, 2)]; s = s.substring(2); }
        else if (r2k[s.substring(0, 1)]) { res += r2k[s.substring(0, 1)]; s = s.substring(1); }
        else { res += s[0]; s = s.substring(1); }
    }
    return res;
}
window.normalizeRomaji = normalizeRomaji;

/* ═══════════════════════════════════════════════════════════════════════════════
   GLASS DROPDOWN — turns any <select data-glass="true"> into the same
   frosted-glass dropdown design/animation used by the Lesson selector,
   while keeping the original <select> fully working (value, disabled,
   change event) so no other code has to change.
   ═══════════════════════════════════════════════════════════════════════════════ */
function enhanceGlassSelect(selectEl) {
    if (!selectEl || selectEl.dataset.glassEnhanced) return;
    selectEl.dataset.glassEnhanced = "true";
    selectEl.classList.add("glass-select-native");

    const wrap = document.createElement("div");
    wrap.className = "glass-dropdown settings-dropdown";
    wrap.tabIndex = 0;
    wrap.setAttribute("role", "listbox");
    wrap.setAttribute("aria-label", selectEl.getAttribute("aria-label") || "");
    wrap.setAttribute("aria-expanded", "false");
    if (selectEl.getAttribute("style")) wrap.setAttribute("style", selectEl.getAttribute("style"));

    const selectedDiv = document.createElement("div");
    selectedDiv.className = "dropdown-selected";

    const optionsDiv = document.createElement("div");
    optionsDiv.className = "dropdown-options glass-options-portal";
    optionsDiv.setAttribute("role", "listbox");

    Array.from(selectEl.options).forEach(opt => {
        const o = document.createElement("div");
        o.className = "dropdown-option";
        o.setAttribute("role", "option");
        o.tabIndex = 0;
        o.textContent = opt.textContent;
        o.dataset.value = opt.value;
        o.addEventListener("click", e => {
            e.stopPropagation();
            selectEl.value = opt.value;
            selectEl.dispatchEvent(new Event("change", { bubbles: true }));
            closeDropdown();
        });
        optionsDiv.appendChild(o);
    });

    wrap.appendChild(selectedDiv);
    wrap.appendChild(optionsDiv);
    selectEl.insertAdjacentElement("afterend", wrap);

    function syncLabel() {
        const cur = selectEl.options[selectEl.selectedIndex];
        selectedDiv.textContent = cur ? cur.textContent : "";
        optionsDiv.querySelectorAll(".dropdown-option").forEach(o => {
            o.classList.toggle("dropdown-option-active", o.dataset.value === selectEl.value);
        });
    }
    syncLabel();
    selectEl._glassSync = syncLabel;
    selectEl.addEventListener("change", syncLabel);

    function refreshDisabled() {
        wrap.classList.toggle("dropdown-disabled", !!selectEl.disabled);
    }
    refreshDisabled();
    new MutationObserver(refreshDisabled).observe(selectEl, { attributes: true, attributeFilter: ["disabled"] });

    const scrollHandler = (e) => {
        if (optionsDiv.contains(e.target)) return;
        closeDropdown();
    };
    const resizeHandler = () => closeDropdown();

    function closeDropdown() {
        if (!wrap.classList.contains("open")) return;
        wrap.classList.remove("open");
        optionsDiv.classList.remove("portal-open");
        wrap.setAttribute("aria-expanded", "false");
        window.removeEventListener("scroll", scrollHandler, true);
        window.removeEventListener("resize", resizeHandler);
        
        setTimeout(() => {
            if (!wrap.classList.contains("open") && optionsDiv.parentNode === document.body) {
                wrap.appendChild(optionsDiv);
            }
        }, 250);
    }

    wrap.addEventListener("click", e => {
        e.stopPropagation();
        if (selectEl.disabled) return;
        const willOpen = !wrap.classList.contains("open");
        
        if (willOpen) {
            document.querySelectorAll(".glass-dropdown.open").forEach(el => {
                if (el !== wrap) el.click();
            });

            const r = wrap.getBoundingClientRect();
            optionsDiv.style.position = "fixed";
            optionsDiv.style.right = "auto";
            optionsDiv.style.top = (r.bottom + 8) + "px";
            optionsDiv.style.left = r.left + "px";
            optionsDiv.style.width = r.width + "px";
            optionsDiv.style.zIndex = "99999";
            
            document.body.appendChild(optionsDiv);
            
            window.addEventListener("scroll", scrollHandler, true);
            window.addEventListener("resize", resizeHandler, { passive: true });
        }
        wrap.classList.toggle("open", willOpen);
        optionsDiv.classList.toggle("portal-open", willOpen);
        wrap.setAttribute("aria-expanded", String(willOpen));
    });
    
    wrap.addEventListener("keydown", e => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); wrap.click(); }
    });
    
    document.addEventListener("click", e => {
        if (!wrap.contains(e.target) && !optionsDiv.contains(e.target)) closeDropdown();
    });
}

function initGlassSelects(root = document) {
    root.querySelectorAll("select[data-glass]").forEach(enhanceGlassSelect);
}
window.initGlassSelects = initGlassSelects;
window.refreshGlassSelect = function (id) {
    const el = document.getElementById(id);
    if (el && typeof el._glassSync === "function") el._glassSync();
};
document.addEventListener("DOMContentLoaded", () => initGlassSelects());

/* ═══════════════════════════════════════════════════════════════════════════════
   TOASTS & ACHIEVEMENTS
   ═══════════════════════════════════════════════════════════════════════════════ */
function showToast(msg, type = "success") {
    const container = $("toastContainer");
    if (!container) return;
    const t = document.createElement("div");
    t.className = `toast toast-${type}`;
    t.textContent = msg; // textContent only — never innerHTML for toasts.
    container.appendChild(t);
    setTimeout(() => t.remove(), 3000);
}
window.showToast = showToast;

function checkAchievement(id, title) {
    if (!userProfile.achievements.includes(id)) {
        userProfile.achievements.push(id);
        store.set("jlpt_profile", userProfile);
        showToast(`🏆 Achievement Unlocked: ${title}!`, "success");
        updateDashboard();
    }
}

/* ═══════════════════════════════════════════════════════════════════════════════
   LEVEL STRUCTURE  (single source of truth for lesson / kanji file locations)
   Minna no Nihongo: Shokyu I = N5 (lessons 1-25), Shokyu II = N4 (26-50),
   Chukyu I = N3 (1-12), Chukyu II = N2 (13-24).
   N3 numbers overlap N5 numbers, so a lesson is ALWAYS identified by
   (level, number), never by the number alone.
   File names are case-sensitive on most servers: N5/N4 use "lesson",
   N3/N2 use "Lesson". Kanji files are kanji-L<n>.json inside the level folder.
   ═══════════════════════════════════════════════════════════════════════════════ */
// <LEVELS-START>  (tests extract this block: keep it free of DOM / other globals)
const LEVELS = {
    n5: { label: "N5", dir: "n5", prefix: "lesson", from: 1,   to: 25,  kanji: { from: 1, to: 7 } },
    n4: { label: "N4", dir: "n4", prefix: "lesson", from: 26,  to: 50,  kanji: { from: 8, to: 26 } },
    n3: { label: "N3", dir: "n3", prefix: "Lesson", from: 1,   to: 12,  kanji: null },
    n2: { label: "N2", dir: "n2", prefix: "Lesson", from: 13,  to: 24,  kanji: null },
    n1: { label: "N1", dir: "n1", prefix: "lesson", from: 101, to: 125, kanji: null }
};
const LEVEL_ORDER = ["n5", "n4", "n3", "n2", "n1"];

function levelKey(level) {
    const k = String(level == null ? "" : level).trim().toLowerCase();
    return LEVELS[k] ? k : "n5";
}
function isValidLesson(level, num) {
    const L = LEVELS[levelKey(level)];
    return Number.isInteger(num) && num >= L.from && num <= L.to;
}
function isValidKanjiLesson(level, num) {
    const K = LEVELS[levelKey(level)].kanji;
    return !!K && Number.isInteger(num) && num >= K.from && num <= K.to;
}
function lessonUrl(level, num) {
    const L = LEVELS[levelKey(level)];
    return `data/${L.dir}/${L.prefix}${num}.json`;
}
function kanjiUrl(level, num) {
    const L = LEVELS[levelKey(level)];
    return `data/${L.dir}/kanji-L${num}.json`;
}
/* Only used for progress saved before levels were stored: first level whose range holds the number. */
function levelForLesson(num) {
    return LEVEL_ORDER.find(k => isValidLesson(k, num)) || "n5";
}
// <LEVELS-END>

/* Where to open the app: the last lesson that loaded successfully, with its level.
   userProfile.lastLevel is part of the synced profile, so it follows the account across devices. */
// <STARTPOS-START>  (tests extract this block; it only needs `store`, `userProfile` and the LEVELS helpers)
function resolveStartPosition() {
    const num = Math.round(Number(store.get("jlpt_lastLesson", 1))) || 1;
    const saved = userProfile && userProfile.lastLevel;
    if (saved && LEVELS[saved] && isValidLesson(saved, num)) return { level: saved, num };
    const lvl = levelForLesson(num);
    return isValidLesson(lvl, num) ? { level: lvl, num } : { level: "n5", num: 1 };
}
// <STARTPOS-END>

/* ═══════════════════════════════════════════════════════════════════════════════
   LOAD LESSON
   ═══════════════════════════════════════════════════════════════════════════════ */
let currentLevel = "n5";   // level of the lesson that is actually loaded
function syncLevelUi(level, num) {
    safeText($("levelSelected"), LEVELS[level].label);
    safeText($("lessonSelected"), `Lesson ${num}`);
    if (typeof populateLessonOptions === "function" && lessonListLevel !== level) populateLessonOptions(level, true);
}
async function loadLesson(num, level = currentLevel, isRetry = false) {
    level = levelKey(level);
    num = Number(num);
    const url = lessonUrl(level, num);
    try {
        if (!isValidLesson(level, num)) {
            throw new Error(`lesson ${num} is outside ${LEVELS[level].label}'s range (${LEVELS[level].from}-${LEVELS[level].to})`);
        }
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const raw = await res.json();
        const data = Array.isArray(raw) ? raw : (raw.vocabulary || raw.words || raw.items || []);
        if (!Array.isArray(data)) throw new Error("Malformed lesson data");

        vocabulary = data.map(item => ({
            kanji: item.kanji || item.word || "",
            hiragana: item.hiragana || item.reading || "",
            meaning: item.meaning || item.english || "",
            memory: item.memory || "",
            example: item.example || "",
            section: item.section || "Vocabulary",
            emoji: item.emoji || "📘"
        })).filter(w => w.kanji || w.hiragana || w.meaning);

        filteredVocabulary = [...vocabulary];
        window.vocabulary = vocabulary;
        window.filteredVocabulary = filteredVocabulary;

        currentLevel = level;
        store.set("jlpt_lastLesson", num);
        if (userProfile.lastLevel !== level) {
            userProfile.lastLevel = level;
            store.set("jlpt_profile", userProfile);
        }
        syncLevelUi(level, num);

        vocabulary.forEach(v => {
            const key = wordKey(v);
            if (key && !srsData[key]) srsData[key] = { interval: 0, repetition: 0, eFactor: 2.5, dueDate: Date.now() };
        });
        store.set("jlpt_srs", srsData);

        updateDashboard();
        if (currentView === "vocabView") renderVocabulary();
        if (currentView === "reviewView") startReview();
        if (currentView === "kanjiView" && typeof window.kanjiLevelChanged === "function") window.kanjiLevelChanged();

    } catch (err) {
        console.warn(`[RONIN] ${url} failed:`, err);
        const problem = err instanceof SyntaxError ? "is not valid JSON" : "could not be loaded";
        showToast(`${LEVELS[level].label} Lesson ${num}: ${url} ${problem}.`, "error");
        if (!isRetry) {
            /* Put the menus back on the last lesson that worked and reload it. */
            const back = resolveStartPosition();
            syncLevelUi(back.level, back.num);
            if (back.level !== level || back.num !== num) await loadLesson(back.num, back.level, true);
        }
    }
}
window.loadLesson = loadLesson;

/* ═══════════════════════════════════════════════════════════════════════════════
   DASHBOARD
   ═══════════════════════════════════════════════════════════════════════════════ */
function updateDashboard() {
    const greeting = document.getElementById("dashGreeting");
    if (greeting) greeting.textContent = `Welcome Back, ${userProfile.name || "Learner"}!`;
    
    safeText($("streakStat"), `🔥 ${userProfile.streak} Days`);
    safeText($("totalLearnedStat"), `${userProfile.learned.length} Words`);

    const now = Date.now();
    const dueCount = Object.values(srsData).filter(v => v && v.dueDate <= now).length;
    safeText($("dueReviewStat"), `${dueCount} Due`);

    const pct = Math.min(100, Math.round((userProfile.wordsStudiedToday / userProfile.dailyGoal) * 100));
    safeText($("dailyGoalStat"), `${userProfile.wordsStudiedToday} / ${userProfile.dailyGoal}`);
    if ($("goalProgressFill")) $("goalProgressFill").style.width = `${pct}%`;

    const lessonLearned = vocabulary.filter(item => userProfile.learned.includes(wordKey(item))).length;
    const lPct = vocabulary.length ? Math.round((lessonLearned / vocabulary.length) * 100) : 0;
    if ($("progressFill")) $("progressFill").style.width = lPct + "%";
    safeText($("lessonTitle"), `${LEVELS[currentLevel].label} Lesson ${store.get("jlpt_lastLesson", 1)} · ${lessonLearned}/${vocabulary.length} learned`);

    const achList = $("achievementsList");
    if (achList) {
        const milestones = [
            { id: "first_10", t: "10 Words" },
            { id: "first_100", t: "100 Words Master" },
            { id: "first_500", t: "500 Words Master" },
            { id: "streak_7", t: "7 Day Streak" },
            { id: "streak_30", t: "30 Day Streak" }
        ];
        achList.innerHTML = milestones.map(m => {
            const unlocked = userProfile.achievements.includes(m.id);
            return `<div class="achievement-badge ${unlocked ? "" : "locked"}">${unlocked ? "🏅" : "🔒"} ${sanitizeHTML(m.t)}</div>`;
        }).join("");
    }

    if (typeof updateXPBar === "function") updateXPBar();
    if (typeof updateHeatmap === "function") updateHeatmap();
    if (typeof updateReadiness === "function") updateReadiness();

    awardAchievements();
}
window.updateDashboard = updateDashboard;

function awardAchievements() {
    let changed = false;
    const learned = userProfile.learned.length;
    
    if (learned >= 10 && !userProfile.achievements.includes("first_10")) {
        userProfile.achievements.push("first_10");
        showToast("Achievement Unlocked: 10 Words!", "success");
        changed = true;
    }
    if (learned >= 100 && !userProfile.achievements.includes("first_100")) {
        userProfile.achievements.push("first_100");
        showToast("Achievement Unlocked: 100 Words Master!", "success");
        changed = true;
    }
    if (learned >= 500 && !userProfile.achievements.includes("first_500")) {
        userProfile.achievements.push("first_500");
        showToast("Achievement Unlocked: 500 Words Master!", "success");
        changed = true;
    }
    if (userProfile.streak >= 7 && !userProfile.achievements.includes("streak_7")) {
        userProfile.achievements.push("streak_7");
        showToast("Achievement Unlocked: 7 Day Streak!", "success");
        changed = true;
    }
    if (userProfile.streak >= 30 && !userProfile.achievements.includes("streak_30")) {
        userProfile.achievements.push("streak_30");
        showToast("Achievement Unlocked: 30 Day Streak!", "success");
        changed = true;
    }

    if (changed) {
        store.set("jlpt_profile", userProfile);
        // re-render the badges
        const achList = $("achievementsList");
        if (achList) {
            const milestones = [
                { id: "first_10", t: "10 Words" },
                { id: "first_100", t: "100 Words Master" },
                { id: "first_500", t: "500 Words Master" },
                { id: "streak_7", t: "7 Day Streak" },
                { id: "streak_30", t: "30 Day Streak" }
            ];
            achList.innerHTML = milestones.map(m => {
                const unlocked = userProfile.achievements.includes(m.id);
                return `<div class="achievement-badge ${unlocked ? "" : "locked"}">${unlocked ? "🏅" : "🔒"} ${sanitizeHTML(m.t)}</div>`;
            }).join("");
        }
    }
}

function recordStudy() {
    userProfile.wordsStudiedToday++;
    store.set("jlpt_profile", userProfile);
    updateDashboard();
    if (userProfile.wordsStudiedToday === 10) checkAchievement("first_10", "First 10 Words");
    if (userProfile.learned.length >= 100) checkAchievement("first_100", "100 Words Master");
    if (userProfile.streak >= 7) checkAchievement("streak_7", "7 Day Streak");
}
window.recordStudy = recordStudy;

/* ═══════════════════════════════════════════════════════════════════════════════
   UNIFIED REVIEW ENGINE (Flashcards + SRS)
   ═══════════════════════════════════════════════════════════════════════════════ */
let reviewList = [];
window.reviewList = reviewList;

function startReview(customList) {
    if (Array.isArray(customList) && customList.length) {
        reviewList = customList;
    } else {
        const due = [];
        const newCards = [];
        const now = Date.now();
        const ncpd = store.get("jlpt_settings_newCardsPerDay", 10);
        
        const realDue = [];
        const realNew = [];
        for (const w of vocabulary) {
            const key = wordKey(w);
            const data = srsData[key];
            if (!data) continue;
            const isSeen = userProfile.learned.includes(key) || data.repetition > 0;
            if (!isSeen) {
                realNew.push(w);
            } else if (data.dueDate <= now) {
                realDue.push(w);
            }
        }
        let sessionList = realDue.concat(realNew.slice(0, ncpd));
        
        const order = store.get("jlpt_settings_reviewOrder", "due-soonest");
        if (order === "random") {
            sessionList.sort(() => Math.random() - 0.5);
        } else if (order === "hardest-first") {
            sessionList.sort((a, b) => {
                const da = srsData[wordKey(a)]?.difficulty || 0;
                const db = srsData[wordKey(b)]?.difficulty || 0;
                return db - da;
            });
        } else {
            sessionList.sort((a, b) => {
                const da = srsData[wordKey(a)]?.dueDate || 0;
                const db = srsData[wordKey(b)]?.dueDate || 0;
                return da - db;
            });
        }
        
        reviewList = sessionList;
    }
    
    window.reviewList = reviewList;
    if (!reviewList.length) {
        showToast("No reviews due right now! 🎉", "success");
        return;
    }
    
    reviewIndex = 0;
    window.reviewIndex = reviewIndex;
    showReviewCard();
}
window.startReview = startReview;

function showReviewCard() {
    const w = reviewList[reviewIndex];
    if (!w) return;

    const card = $("srsFlashcard");
    card?.classList.remove("flipped");
    card?.setAttribute("aria-pressed", "false");
    const front = $("srsFront");
    const back  = $("srsBack");
    if (front) front.setAttribute("aria-hidden", "false");
    if (back)  back.setAttribute("aria-hidden",  "true");
    safeText($("srsCounter"), `Card ${reviewIndex + 1} / ${reviewList.length}`);

    if (front) {
        front.innerHTML = `<div class="flash-accent-line"></div><div style="font-size:40px">${sanitizeHTML(w.emoji)}</div><div class="kanji" style="margin-top:16px">${sanitizeHTML(w.kanji || w.hiragana)}</div>`;
    }

    if (back) {
        back.innerHTML = `
            <div class="flash-accent-line"></div>
            <h2 style="color:var(--accent3)">${sanitizeHTML(w.hiragana)}</h2>
            <button class="fc-speak" type="button" data-speak-text="${sanitizeAttr(w.hiragana || w.kanji)}" title="Play Audio">🔊</button>
            <div class="meaning" style="font-size:20px;margin-top:12px;">${sanitizeHTML(w.meaning)}</div>
            ${w.memory ? `<div class="memory">${sanitizeHTML(w.memory)}</div>` : ""}
        `;
        const speakBtn = back.querySelector(".fc-speak");
        if (speakBtn) {
            speakBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                speakJapanese(speakBtn.dataset.speakText);
            });
        }
    }

    if ($("reviewPrevBtn")) $("reviewPrevBtn").disabled = reviewIndex === 0;
    if ($("reviewNextBtn")) $("reviewNextBtn").disabled = reviewIndex === reviewList.length - 1;
}
window.showReviewCard = showReviewCard;

function updateSrsData(grade, currentData) {
    let { interval, repetition, eFactor, stability, difficulty } = currentData || {};
    interval = interval || 0;
    repetition = repetition || 0;
    eFactor = eFactor || 2.5;
    let isWeakened = false;

    const isAdvanced = store.get("jlpt_srs_algo") === "advanced";
    if (isAdvanced) {
        if (stability === undefined) stability = 1.0;
        if (difficulty === undefined) difficulty = 5.0;

        if (grade === 1) { // Again
            difficulty = Math.min(10, difficulty + 2.0);
            stability = Math.max(0.5, stability * 0.3);
            interval = 0; repetition = 0; isWeakened = true;
        } else if (grade === 2) { // Hard
            difficulty = Math.min(10, difficulty + 1.0);
            stability = stability * 1.2;
            interval = Math.round(stability);
            repetition = Math.max(1, repetition);
        } else if (grade === 3) { // Good
            difficulty = Math.max(1, difficulty - 0.5);
            stability = stability * (3.0 - (difficulty / 10));
            interval = Math.round(stability);
            repetition++;
        } else { // Easy
            difficulty = Math.max(1, difficulty - 1.5);
            stability = stability * (3.5 - (difficulty / 10));
            interval = Math.round(stability);
            repetition++;
        }
        if (interval < 1 && grade > 1) interval = 1;
        if (interval > 3650) interval = 3650;
    } else {
        if (grade === 1) {
            repetition = 0; interval = 0; eFactor = eFactor - 0.3; isWeakened = true;
        } else if (grade === 2) {
            interval = 1; repetition = Math.max(1, repetition); eFactor = eFactor - 0.15;
        } else if (grade === 3) {
            repetition++; interval = repetition === 1 ? 3 : Math.round(interval * eFactor); eFactor = eFactor + 0.05;
        } else {
            repetition++; interval = repetition === 1 ? 7 : Math.round(interval * eFactor * 1.3); eFactor = eFactor + 0.15;
        }
        if (eFactor < 1.3) eFactor = 1.3;
        if (eFactor > 3.0) eFactor = 3.0;
    }

    return {
        interval,
        repetition,
        eFactor,
        stability,
        difficulty,
        dueDate: Date.now() + interval * 86400000,
        isWeakened
    };
}
window.updateSrsData = updateSrsData;

function processSRSGrade(grade) {
    if (!reviewList.length) return;
    const word = reviewList[reviewIndex];
    if (!word) return;
    const key = wordKey(word);
    if (!key) return;

    const result = updateSrsData(grade, srsData[key]);
    srsData[key] = { 
        interval: result.interval, 
        repetition: result.repetition, 
        eFactor: result.eFactor, 
        stability: result.stability,
        difficulty: result.difficulty,
        dueDate: result.dueDate 
    };

    let _addedToWeakThisGrade = false;
    if (result.isWeakened && !userProfile.weak.includes(key)) {
        userProfile.weak.push(key);
        _addedToWeakThisGrade = true;
    }

    store.set("jlpt_srs", srsData);
    
    if (grade >= 3 && !userProfile.learned.includes(key)) {
        userProfile.learned.push(key);
    }
    store.set("jlpt_profile", userProfile);

    recordStudy();
    window._lastGradedWord = word;
    window._lastGradedAddedWeak = _addedToWeakThisGrade;

    if (reviewIndex < reviewList.length - 1) {
        transitionCard("left", () => {
            reviewIndex++;
            window.reviewIndex = reviewIndex;
            showReviewCard();
        });
    } else {
        showToast("Lesson review complete! 🎉", "success");
        setTimeout(() => {
            if (typeof showView === "function") {
                showView("dashboardView");
                syncNavPill("dashboard");
            }
        }, 1500);
    }
}
window.processSRSGrade = processSRSGrade;

let isAnimatingCard = false;
function transitionCard(direction, callback) {
    if (isAnimatingCard) return;
    isAnimatingCard = true;

    const card = $("srsFlashcard");
    if (!card) { isAnimatingCard = false; return; }

    const outClass = direction === "left" ? "slide-out-left" : "slide-out-right";
    const inClass = direction === "left" ? "slide-in-left" : "slide-in-right";

    card.classList.add(outClass);

    setTimeout(() => {
        card.classList.remove(outClass);
        try {
            callback();
        } catch (e) {
            isAnimatingCard = false;
            console.warn("transitionCard callback error:", e);
            return;
        }
        void card.offsetWidth;
        card.classList.add(inClass);
        setTimeout(() => {
            card.classList.remove(inClass);
            isAnimatingCard = false;
        }, 300);
    }, 220);
}

$("srsFlashcard")?.addEventListener("click", () => {
    if (isAnimatingCard) return;
    const card = $("srsFlashcard");
    card.classList.toggle("flipped");
    haptic();
    if (card.classList.contains("flipped") && userProfile.autoPlay) {
        const w = reviewList[reviewIndex];
        if (w) speakJapanese(w.hiragana || w.kanji);
    }
});

$("srsFlashcard")?.addEventListener("keydown", e => {
    if (e.key === "ArrowLeft") { $("reviewPrevBtn")?.click(); }
    if (e.key === "ArrowRight") { $("reviewNextBtn")?.click(); }
    if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        $("srsFlashcard").click();
    }
});

$("reviewPrevBtn")?.addEventListener("click", () => {
    if (reviewIndex > 0) {
        transitionCard("right", () => {
            reviewIndex--;
            window.reviewIndex = reviewIndex;
            showReviewCard();
        });
    }
});

$("reviewNextBtn")?.addEventListener("click", () => {
    if (reviewIndex < reviewList.length - 1) {
        transitionCard("left", () => {
            reviewIndex++;
            window.reviewIndex = reviewIndex;
            showReviewCard();
        });
    }
});

function speakJapanese(txt) {
    if (!window.speechSynthesis || !txt) return;
    if (store.get("jlpt_settings_muteAudio", false)) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(txt);
    u.lang = "ja-JP";
    u.rate = store.get("jlpt_settings_ttsRate", 0.95);
    
    const prefVoice = store.get("jlpt_settings_ttsVoice", "default");
    if (prefVoice !== "default") {
        const v = speechSynthesis.getVoices().find(v => v.name === prefVoice);
        if (v) u.voice = v;
        else if (japaneseVoice) u.voice = japaneseVoice;
    } else if (japaneseVoice) {
        u.voice = japaneseVoice;
    }
    
    speechSynthesis.speak(u);
}
window.speakJapanese = speakJapanese;

[1, 2, 3, 4].forEach(grade => {
    $(`srsBtn${grade}`)?.addEventListener("click", (e) => {
        e.stopPropagation();
        if (isAnimatingCard) return;
        processSRSGrade(grade);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════════
   UI & VIEW ROUTING
   ═══════════════════════════════════════════════════════════════════════════════ */
function syncNavPill(activeId) {
    document.querySelectorAll(".pill").forEach(p => p.classList.remove("active-pill"));
    const btn = $(activeId + "Btn");
    if (btn) btn.classList.add("active-pill");
}
window.syncNavPill = syncNavPill;

/* ── Back / forward: every section the user opens is a history entry ───────────
   showView() records it, popstate (browser back, phone back gesture, Android PWA
   back button, Alt+←) replays it. Nothing else needs to know about history. */
const VIEW_IDS = ["dashboardView", "vocabView", "kanjiView", "reviewView", "quizView", "gamesView", "analyticsView"];
const viewFromHash = h => { const id = String(h || "").replace(/^#/, "") + "View"; return VIEW_IDS.includes(id) ? id : null; };
let _navFromPop = false;
function navRecord(id) {
    if (_navFromPop) return;
    try {
        const st = history.state;
        const hash = id === "dashboardView" ? location.pathname + location.search : "#" + id.replace(/View$/, "");
        if (!st || !st.ronin) history.replaceState({ ronin: 1, view: id }, "", hash);
        else if (st.view !== id) history.pushState({ ronin: 1, view: id }, "", hash);
    } catch (_) { /* history unavailable (sandboxed iframe): navigation still works, just without back */ }
}

function showView(id) {
    navRecord(id);
    const currentlyVisible = document.querySelector(".view-panel:not(.hidden)");
    const target = $(id);

    const finishSwitch = () => {
        // Close any modal overlays left open (NOT the view panels themselves —
        // closeModal() schedules a delayed re-hide that must never run against
        // the panel we are about to show, or it will vanish ~220ms later).
        document.querySelectorAll(".modal-overlay:not(.hidden)").forEach(el => closeModal(el.id));

        document.querySelectorAll(".view-panel").forEach(el => {
            el.classList.remove("fading-out");
            if (el !== target) el.classList.add("hidden");
        });
        if (target) {
            target.classList.remove("hidden");
            target.style.animation = "none";
            void target.offsetWidth;
            target.style.animation = "viewFadeIn 0.45s cubic-bezier(0.34,1.56,0.64,1) both";
        }
        currentView = id;
        window.currentView = id;
        if ($("mobilePopover")) {
            $("mobilePopover").setAttribute("aria-hidden", "true");
            $("hamburgerBtn")?.setAttribute("aria-expanded", "false");
        }
    };

    if (currentlyVisible && currentlyVisible !== target) {
        currentlyVisible.classList.add("fading-out");
        setTimeout(finishSwitch, 170);
    } else {
        finishSwitch();
    }
}
window.showView = showView;

["dashboard", "vocab", "kanji", "review", "quiz", "games", "analytics"].forEach(v => {
    $(`${v}Btn`)?.addEventListener("click", () => {
        document.body.style.overflow = "";
        if (typeof closeSettingsDrawer === "function") closeSettingsDrawer();
        if (window._dailyChallengeWords && v !== "review") {
            window._dailyChallengeWords = null;
            loadLesson(store.get("jlpt_lastLesson", 1));
        }
        showView(`${v}View`);
        handleViewLogic(v);
    });
    $(`m${v.charAt(0).toUpperCase() + v.slice(1)}Btn`)?.addEventListener("click", () => {
        document.body.style.overflow = "";
        if (typeof closeSettingsDrawer === "function") closeSettingsDrawer();
        showView(`${v}View`);
        handleViewLogic(v);
    });
});
$("mThemeBtn")?.addEventListener("click", () => $("themeToggleBtn")?.click());
$("settingsBtn")?.addEventListener("click", () => window.openSettingsDrawer?.());
$("mSettingsBtn")?.addEventListener("click", () => window.openSettingsDrawer?.());

function handleViewLogic(v) {
    syncNavPill(v);
    if (v === "dashboard") updateDashboard();
    if (v === "vocab") { filteredVocabulary = [...vocabulary]; window.filteredVocabulary = filteredVocabulary; if ($("searchBox")) $("searchBox").value = ""; renderVocabulary(); }
    if (v === "kanji") { if (typeof window.kanjiViewOpened === "function") window.kanjiViewOpened(); }
    if (v === "review") startReview();
    if (v === "quiz") {
        if (typeof showRules === "function") showRules("quiz", startNewQuiz);
        else startNewQuiz();
    }
    if (v === "games") { if (typeof renderGamesHub === "function") renderGamesHub(); }
    if (v === "analytics") { if (typeof updateHeatmap === "function") updateHeatmap(); if (typeof updateReadiness === "function") updateReadiness(); renderQuizHistory(); }
}
window.handleViewLogic = handleViewLogic;

window.addEventListener("popstate", e => {
    const st = e.state;
    const id = st && st.ronin && VIEW_IDS.includes(st.view) ? st.view : viewFromHash(location.hash) || (location.hash ? null : "dashboardView");
    if (!id) return;                                  // some other #anchor (e.g. the skip link): not ours
    if (typeof closeSettingsDrawer === "function") closeSettingsDrawer();
    document.getElementById("contextMenu")?.classList.add("hidden");
    if (typeof closeSearchDropdown === "function") closeSearchDropdown();
    document.body.style.overflow = "";
    _navFromPop = true;
    try { showView(id); handleViewLogic(id.replace(/View$/, "")); }
    finally { _navFromPop = false; }
});
$("logoLink")?.addEventListener("click", e => { e.preventDefault(); $("dashboardBtn")?.click(); });

function renderQuizHistory() {
    const tbody = $("quizHistoryTableBody");
    if (!tbody) return;
    const history = store.get("jlpt_quizHistory", []);
    if (!history.length) {
        tbody.innerHTML = "<tr><td colspan='5' class='text-center'>No quiz history found.</td></tr>";
        return;
    }
    tbody.innerHTML = history.slice().reverse().map(entry => `
        <tr>
            <td>${entry.date}</td>
            <td>${entry.time}</td>
            <td>${entry.score}</td>
            <td>${entry.accuracy}%</td>
            <td>${entry.mode}</td>
        </tr>
    `).join("");
}
window.renderQuizHistory = renderQuizHistory;

$("favBtn")?.addEventListener("click", () => {
    showView("vocabView"); syncNavPill("vocab");
    filteredVocabulary = vocabulary.filter(v => userProfile.favorites.includes(wordKey(v)));
    window.filteredVocabulary = filteredVocabulary;
    renderVocabulary();
});
$("weakBtn")?.addEventListener("click", () => {
    showView("vocabView"); syncNavPill("vocab");
    filteredVocabulary = vocabulary.filter(v => userProfile.weak.includes(wordKey(v)));
    window.filteredVocabulary = filteredVocabulary;
    renderVocabulary();
});

$("hamburgerBtn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    const btn = $("hamburgerBtn");
    const menu = $("mobilePopover");
    const isExpanded = btn.getAttribute("aria-expanded") === "true";
    btn.setAttribute("aria-expanded", String(!isExpanded));
    menu.setAttribute("aria-hidden", String(isExpanded));
});

document.addEventListener("click", (e) => {
    const btn = $("hamburgerBtn");
    const menu = $("mobilePopover");
    if (menu && btn && !menu.contains(e.target) && !btn.contains(e.target) && btn.getAttribute("aria-expanded") === "true") {
        btn.setAttribute("aria-expanded", "false");
        menu.setAttribute("aria-hidden", "true");
    }
});

/* ═══════════════════════════════════════════════════════════════════════════════
   VOCABULARY RENDERING (grouped by section)
   ═══════════════════════════════════════════════════════════════════════════════ */
function renderVocabulary() {
    const frag = document.createDocumentFragment();
    const cont = $("vocabularyContainer");
    if (!cont) return;

    if (!filteredVocabulary.length) {
        cont.innerHTML = `<div class="dash-card text-center" style="grid-column:1/-1;"><h3>No words found</h3></div>`;
        return;
    }

    const groupedVocab = {};
    filteredVocabulary.forEach(item => {
        const sectionName = item.section || "Vocabulary";
        if (!groupedVocab[sectionName]) groupedVocab[sectionName] = [];
        groupedVocab[sectionName].push(item);
    });

    Object.keys(groupedVocab).forEach(section => {
        const sectionHeader = document.createElement("div");
        sectionHeader.className = "vocab-section-header";
        sectionHeader.innerHTML = `<span>${sanitizeHTML(section)}</span>`;
        frag.appendChild(sectionHeader);

        groupedVocab[section].forEach(item => {
            const key = wordKey(item);
            const isLearned = userProfile.learned.includes(key);
            const isFav = userProfile.favorites.includes(key);

            const c = document.createElement("div");
            c.className = `card spatial-card ${isLearned ? "card-learned" : ""}`;
            c.dataset.wordKey  = key;
            c.dataset.kanji    = item.kanji    || "";
            c.dataset.hiragana = item.hiragana || "";
            c.dataset.meaning  = item.meaning  || "";
            c.dataset.memory   = item.memory   || "";
            c.dataset.example  = item.example  || "";
            c.dataset.emoji    = item.emoji    || "";

            c.innerHTML = `
                <div class="card-top">
                    <span class="emoji">${sanitizeHTML(item.emoji)}</span>
                    ${isLearned ? `<span class="learned-badge" title="Learned">✅</span>` : ""}
                </div>
                <div class="card-content">
                    <div class="kanji">${sanitizeHTML(item.kanji || item.hiragana)}</div>
                    <div class="hiragana">${sanitizeHTML(item.hiragana)}</div>
                    <div class="meaning">${sanitizeHTML(item.meaning)}</div>
                    ${item.memory ? `<div class="memory">${sanitizeHTML(item.memory)}</div>` : ""}
                </div>
                <div class="card-actions">
                    <button class="action-btn speak-btn" type="button" title="Listen">🔊</button>
                    <button class="action-btn favorite-btn ${isFav ? "favorited" : ""}" type="button" title="Favorite">${isFav ? "⭐" : "☆"}</button>
                </div>`;

            c.querySelector(".speak-btn").addEventListener("click", (e) => {
                e.stopPropagation();
                speakJapanese(item.hiragana || item.kanji);
            });
            c.querySelector(".favorite-btn").addEventListener("click", (e) => {
                e.stopPropagation();
                const idx = userProfile.favorites.indexOf(key);
                if (idx > -1) userProfile.favorites.splice(idx, 1);
                else userProfile.favorites.push(key);
                store.set("jlpt_profile", userProfile);
                renderVocabulary();
                updateDashboard();
            });
            frag.appendChild(c);
        });
    });

    cont.replaceChildren(frag);

    requestAnimationFrame(() => {
        document.querySelectorAll(".card:not(.revealed)").forEach(c => revealObserver.observe(c));
    });
}
window.renderVocabulary = renderVocabulary;

/* ═══════════════════════════════════════════════════════════════════════════════
   SEARCH: everything the app knows (lessons, kanji, decks, sections). Never goes online.
   ═══════════════════════════════════════════════════════════════════════════════ */
// <SEARCH-START>  (tests extract this block: keep it free of DOM / other globals)
const SEARCH_TYPE_ORDER = { vocab: 0, kanji: 1, deck: 2, section: 3 };

/* Case-, width- and katakana/hiragana-insensitive text */
function srchNorm(s) {
    return String(s == null ? "" : s).normalize("NFKC").toLowerCase()
        .replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

/* toKana: optional romaji -> hiragana converter ("tori" -> "とり") */
function prepareQuery(q, toKana) {
    const raw = String(q == null ? "" : q).trim();
    const n = srchNorm(raw);
    let kana = n;
    if (toKana && /^[a-z' -]+$/.test(n)) { try { kana = srchNorm(toKana(n)); } catch (_) { kana = n; } }
    return { raw, n, kana, words: n.split(/[^\p{L}\p{N}]+/u).filter(Boolean) };
}

/* o: { type, kanji, reading, meaning, extra, ...anything else the caller wants back } */
function makeEntry(o) {
    o._k = srchNorm(o.kanji);
    o._r = srchNorm(o.reading);
    o._m = srchNorm(o.meaning);
    o._x = srchNorm(o.extra);
    o._mw = o._m.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    return o;
}

function withinOneEdit(a, b) {
    if (a === b) return true;
    const la = a.length, lb = b.length;
    if (Math.abs(la - lb) > 1) return false;
    let i = 0, j = 0, edits = 0;
    while (i < la && j < lb) {
        if (a[i] === b[j]) { i++; j++; continue; }
        if (++edits > 1) return false;
        if (la > lb) i++; else if (lb > la) j++; else { i++; j++; }
    }
    return edits + (la - i) + (lb - j) <= 1;
}

/* 0 = no match; higher = better */
function scoreEntry(e, Q) {
    if (!Q.n) return 0;
    let best = 0;
    const up = v => { if (v > best) best = v; };
    const fieldScore = (field, q, exact, prefix, inc) => {
        if (!field || !q) return;
        if (field === q) up(exact);
        else if (field.startsWith(q)) up(prefix);
        else if (field.includes(q)) up(inc);
    };
    for (const q of Q.kana === Q.n ? [Q.n] : [Q.n, Q.kana]) {
        fieldScore(e._k, q, 100, 85, 60);
        fieldScore(e._r, q, 98, 82, 55);
    }
    /* meaning: whole word > word prefix > anywhere */
    if (e._m) {
        if (e._m === Q.n) up(95);
        else if (e._mw.includes(Q.n)) up(88);
        else if (e._mw.some(w => w.startsWith(Q.n))) up(72);
        else if (e._m.includes(Q.n)) up(48);
        else if (Q.words.length > 1 && Q.words.every(w => e._mw.some(m => m.startsWith(w)))) up(66);
    }
    if (e._x && e._x.includes(Q.n)) up(34);
    if (Q.kana !== Q.n && e._x && e._x.includes(Q.kana)) up(34);
    /* one-letter typo in an English word ("hosptal" -> hospital) */
    if (!best && /^[a-z]{4,}$/.test(Q.n) && e._mw.some(w => w.length >= 4 && withinOneEdit(w, Q.n))) up(28);
    return best;
}

function searchEntries(entries, Q, limit) {
    const hits = [];
    for (let i = 0; i < entries.length; i++) {
        const s = scoreEntry(entries[i], Q);
        if (s > 0) hits.push({ e: entries[i], s, i });
    }
    hits.sort((a, b) => b.s - a.s || SEARCH_TYPE_ORDER[a.e.type] - SEARCH_TYPE_ORDER[b.e.type] || a.i - b.i);
    return limit ? hits.slice(0, limit) : hits;
}
// <SEARCH-END>

const SEARCH_SECTIONS = [
    { label: "Home",      view: "dashboard", kw: "dashboard home progress streak goal" },
    { label: "Vocab",     view: "vocab",     kw: "vocabulary words cards list" },
    { label: "Kanji",     view: "kanji",     kw: "kanji strokes onyomi kunyomi" },
    { label: "Review",    view: "review",    kw: "srs spaced repetition flashcards due" },
    { label: "Quiz",      view: "quiz",      kw: "test practice questions" },
    { label: "Games",     view: "games",     kw: "play mini games shiritori meteor" },
    { label: "Analytics", view: "analytics", kw: "stats statistics heatmap history readiness" },
    { label: "Decks",     view: "decks",     kw: "my decks custom lists" },
    { label: "Settings",  view: "settings",  kw: "theme dark light language sync account backup export import reset audio" }
];

const searchIndex = new Map();        // id -> entry, filled from every lesson / kanji file
const searchState = { started: false, done: false, lessons: 0, kanji: 0, version: 0 };

function searchLessonEntries(level, num, words) {
    const out = [];
    words.forEach((w, i) => out.push(makeEntry({
        type: "vocab", id: `v|${level}|${num}|${i}`, level, num,
        kanji: w.kanji, reading: w.hiragana, meaning: w.meaning, extra: `${w.memory || ""} ${w.example || ""}`,
        word: w
    })));
    return out;
}
function searchKanjiEntries(level, num, data) {
    return data.kanji.map((k, i) => makeEntry({
        type: "kanji", id: `k|${level}|${num}|${i}`, level, num, char: k.char,
        kanji: k.char, reading: `${k.onyomi.join(" ")} ${k.kunyomi.join(" ")}`, meaning: k.meaning,
        extra: k.examples.map(e => `${e.word} ${e.reading} ${e.meaning}`).join(" ")
    }));
}

/* Loads every lesson + kanji file once (4 at a time, in the background) so search covers the
   whole app, not just the lesson on screen. Missing / offline files are skipped silently. */
async function ensureSearchIndex() {
    if (searchState.started) return;
    searchState.started = true;
    const jobs = [];
    LEVEL_ORDER.forEach(level => {
        const L = LEVELS[level];
        for (let n = L.from; n <= L.to; n++) jobs.push({ level, n, kind: "lesson" });
        if (L.kanji) for (let n = L.kanji.from; n <= L.kanji.to; n++) jobs.push({ level, n, kind: "kanji" });
    });
    const deadLevels = new Set();
    let next = 0, finished = 0;
    const tick = () => { searchState.version++; if (typeof window._searchRefresh === "function") window._searchRefresh(); };
    async function worker() {
        while (next < jobs.length) {
            const job = jobs[next++];
            if (deadLevels.has(job.level)) { finished++; continue; }
            try {
                const res = await fetch(job.kind === "lesson" ? lessonUrl(job.level, job.n) : kanjiUrl(job.level, job.n));
                if (!res.ok) {
                    if (res.status === 404 && job.kind === "lesson" && job.n === LEVELS[job.level].from) deadLevels.add(job.level);
                    continue;
                }
                const raw = await res.json();
                if (job.kind === "lesson") {
                    const list = Array.isArray(raw) ? raw : (raw.vocabulary || raw.words || raw.items || []);
                    const words = list.map(item => ({
                        kanji: item.kanji || item.word || "", hiragana: item.hiragana || item.reading || "",
                        meaning: item.meaning || item.english || "", memory: item.memory || "", example: item.example || "",
                        section: item.section || "Vocabulary", emoji: item.emoji || "📘"
                    })).filter(w => w.kanji || w.hiragana || w.meaning);
                    searchLessonEntries(job.level, job.n, words).forEach(e => searchIndex.set(e.id, e));
                    searchState.lessons++;
                } else {
                    searchKanjiEntries(job.level, job.n, normalizeKanjiFile(raw, job.n)).forEach(e => searchIndex.set(e.id, e));
                    searchState.kanji++;
                }
            } catch (_) { /* offline, bad JSON, or missing: that file just isn't searchable */ }
            finally { finished++; if (finished % 10 === 0) tick(); }
        }
    }
    await Promise.all([worker(), worker(), worker(), worker()]);
    searchState.done = true;
    tick();
}

/* Things that can change while the app runs: decks, the lesson on screen, app sections. */
function searchLiveEntries() {
    const out = [];
    if (!searchState.done) {
        /* index still loading: make sure the current lesson is searchable right away */
        const num = store.get("jlpt_lastLesson", 1);
        searchLessonEntries(currentLevel, num, vocabulary).forEach(e => { if (!searchIndex.has(e.id)) out.push(e); });
    }
    try {
        (store.get("jlpt_decks", []) || []).forEach((dk, di) => {
            out.push(makeEntry({ type: "deck", id: `d|${di}`, deckIndex: di, kanji: "", reading: "", meaning: dk.name || "Deck", extra: dk.desc || "" }));
            /* words added to a deck that are not part of any lesson (e.g. custom ones) */
            (dk.words || []).forEach((w, wi) => {
                if (!w || !(w.kanji || w.hiragana)) return;
                out.push(makeEntry({ type: "vocab", id: `dw|${di}|${wi}`, deck: dk.name, kanji: w.kanji, reading: w.hiragana, meaning: w.meaning, extra: "", word: w }));
            });
        });
    } catch (_) { /* decks unreadable: skip */ }
    SEARCH_SECTIONS.forEach(s => out.push(makeEntry({ type: "section", id: `s|${s.view}`, view: s.view, kanji: "", reading: "", meaning: s.label, extra: s.kw })));
    return out;
}

function runSearch(q, limit) {
    const Q = prepareQuery(q, normalizeRomaji);
    if (!Q.n) return { Q, hits: [] };
    const all = [...searchIndex.values(), ...searchLiveEntries()];
    /* the same word can come from a lesson and from a deck: show it once */
    const seen = new Set(), hits = [];
    searchEntries(all, Q).forEach(h => {
        const k = h.e.type === "vocab" ? `v|${h.e.kanji}|${h.e.reading}|${h.e.meaning}` : h.e.id;
        if (seen.has(k)) return;
        seen.add(k); hits.push(h);
    });
    return { Q, hits: limit ? hits.slice(0, limit) : hits };
}

/* ── dropdown UI ───────────────────────────────────────────────────────────── */
const searchBoxEl = $("searchBox");
const searchDd = $("searchDropdown");
let searchActive = -1, searchShown = [], searchTimer = 0, searchQuery = "";

function closeSearchDropdown() {
    if (!searchDd) return;
    searchDd.classList.add("hidden");
    searchDd.replaceChildren();
    searchActive = -1; searchShown = [];
    searchBoxEl?.setAttribute("aria-expanded", "false");
}
function positionSearchDropdown() {
    if (!searchBoxEl || !searchDd) return;
    const r = searchBoxEl.getBoundingClientRect();
    const w = Math.min(Math.max(r.width, 360), window.innerWidth - 24);
    searchDd.style.top = (r.bottom + 8) + "px";
    searchDd.style.left = Math.max(12, Math.min(r.left, window.innerWidth - w - 12)) + "px";
    searchDd.style.width = w + "px";
}
function searchBadge(e) { return { vocab: "Vocab", kanji: "Kanji", deck: "Deck", section: "Go to" }[e.type]; }
function searchWhere(e) {
    if (e.type === "vocab" && e.level) return `${LEVELS[e.level].label} · Lesson ${e.num}`;
    if (e.type === "vocab" && e.deck) return `Deck · ${e.deck}`;
    if (e.type === "kanji") return `${LEVELS[e.level].label} · Kanji L${e.num}`;
    return "";
}

function renderSearchDropdown() {
    if (!searchDd) return;
    const q = searchQuery;
    const { hits } = runSearch(q, 400);
    const vocabCount = hits.filter(h => h.e.type === "vocab").length;
    searchShown = hits.slice(0, 8).map(h => h.e);
    searchDd.replaceChildren();
    searchActive = -1;

    if (!searchShown.length) {
        const none = document.createElement("div");
        none.className = "sr-empty";
        none.textContent = searchState.done ? `Nothing in RONIN WEB matches "${q}".` : `No match yet for "${q}"; still indexing the lessons…`;
        searchDd.appendChild(none);
    }
    searchShown.forEach((e, i) => {
        const row = document.createElement("div");
        row.className = "sr-row"; row.setAttribute("role", "option"); row.id = `sr-opt-${i}`;
        const badge = document.createElement("span"); badge.className = `sr-badge sr-${e.type}`; badge.textContent = searchBadge(e);
        const main = document.createElement("span"); main.className = "sr-main";
        const head = document.createElement("span"); head.className = "sr-head";
        head.textContent = e.type === "section" ? e.meaning : (e.type === "deck" ? e.meaning : (e.kanji || e.reading));
        main.appendChild(head);
        const sub = document.createElement("span"); sub.className = "sr-sub";
        if (e.type === "vocab") sub.textContent = [e.kanji ? e.reading : "", e.meaning].filter(Boolean).join(" · ");
        else if (e.type === "kanji") sub.textContent = [e.meaning, e.reading.trim()].filter(Boolean).join(" · ");
        else if (e.type === "deck") sub.textContent = "Open your decks";
        else sub.textContent = "Open this section";
        main.appendChild(sub);
        const where = document.createElement("span"); where.className = "sr-where"; where.textContent = searchWhere(e);
        row.append(badge, main, where);
        row.addEventListener("mousedown", ev => ev.preventDefault());       // keep focus in the box
        row.addEventListener("click", () => chooseSearchEntry(e));
        searchDd.appendChild(row);
    });
    if (vocabCount > 1) {
        const all = document.createElement("div");
        all.className = "sr-all"; all.setAttribute("role", "option");
        all.textContent = `Show all ${vocabCount} word matches in Vocab ↵`;
        all.addEventListener("mousedown", ev => ev.preventDefault());
        all.addEventListener("click", () => showAllVocabMatches(q));
        searchDd.appendChild(all);
    }
    const foot = document.createElement("div");
    foot.className = "sr-foot";
    foot.textContent = searchState.done
        ? `Searched ${searchState.lessons} lessons and ${searchState.kanji} kanji lessons on this device`
        : `Indexing lessons… (${searchState.lessons + searchState.kanji} loaded)`;
    searchDd.appendChild(foot);

    positionSearchDropdown();
    searchDd.classList.remove("hidden");
    searchBoxEl?.setAttribute("aria-expanded", "true");
}
window._searchRefresh = () => { if (searchQuery && document.activeElement === searchBoxEl) renderSearchDropdown(); };

function setSearchActive(i) {
    const rows = [...searchDd.querySelectorAll(".sr-row")];
    if (!rows.length) return;
    searchActive = (i + rows.length) % rows.length;
    rows.forEach((r, k) => r.classList.toggle("active", k === searchActive));
    rows[searchActive].scrollIntoView({ block: "nearest" });
    searchBoxEl.setAttribute("aria-activedescendant", rows[searchActive].id);
}

function flashTile(el) {
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.add("tile-flash");
    setTimeout(() => el.classList.remove("tile-flash"), 1800);
}

async function chooseSearchEntry(e) {
    closeSearchDropdown();
    searchBoxEl?.blur();
    if (e.type === "section") {
        if (e.view === "settings") window.openSettingsDrawer?.();
        else if (e.view === "decks") window.openDeckView?.();
        else $(`${e.view}Btn`)?.click();
    } else if (e.type === "deck") {
        window.openDeckView?.();
    } else if (e.type === "kanji") {
        showView("kanjiView"); syncNavPill("kanji");
        await loadKanjiLesson(e.level, e.num);
        setTimeout(() => flashTile([...document.querySelectorAll("#kanjiList .kj-char")].find(c => c.textContent === e.char)?.closest(".kj-card")), 60);
    } else if (e.type === "vocab") {
        if (e.level && (e.level !== currentLevel || e.num !== Number(store.get("jlpt_lastLesson", 1)))) await loadLesson(e.num, e.level);
        showView("vocabView"); syncNavPill("vocab");
        filteredVocabulary = [...vocabulary]; window.filteredVocabulary = filteredVocabulary;
        renderVocabulary();
        const key = wordKey(e.word);
        setTimeout(() => flashTile([...document.querySelectorAll("#vocabularyContainer .card")].find(c => c.dataset.wordKey === key)), 260);
    }
}

function showAllVocabMatches(q) {
    const { hits } = runSearch(q);
    const list = hits.filter(h => h.e.type === "vocab").map(h => (
        h.e.level ? { ...h.e.word, section: `${LEVELS[h.e.level].label} · Lesson ${h.e.num} · ${h.e.word.section || "Vocabulary"}` } : { ...h.e.word, section: `Deck · ${h.e.deck}` }
    ));
    closeSearchDropdown();
    if (!list.length) { showToast("No word matches.", "error"); return; }
    showView("vocabView"); syncNavPill("vocab");
    filteredVocabulary = list; window.filteredVocabulary = filteredVocabulary;
    renderVocabulary();
}

searchBoxEl?.addEventListener("focus", () => { ensureSearchIndex(); searchQuery = searchBoxEl.value.trim(); if (searchQuery) renderSearchDropdown(); });
searchBoxEl?.addEventListener("input", e => {
    clearTimeout(searchTimer);
    const q = e.target.value.trim();
    searchQuery = q;
    ensureSearchIndex();
    if (!q) {
        closeSearchDropdown();
        filteredVocabulary = [...vocabulary]; window.filteredVocabulary = filteredVocabulary;
        if (currentView === "vocabView") renderVocabulary();
        return;
    }
    searchTimer = setTimeout(renderSearchDropdown, 90);
});
searchBoxEl?.addEventListener("keydown", e => {
    if (e.key === "ArrowDown") { e.preventDefault(); if (searchDd.classList.contains("hidden")) renderSearchDropdown(); else setSearchActive(searchActive + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSearchActive(searchActive - 1); }
    else if (e.key === "Escape") { closeSearchDropdown(); }
    else if (e.key === "Enter") {
        e.preventDefault();
        if (!searchQuery) return;
        clearTimeout(searchTimer);
        if (searchDd.classList.contains("hidden")) renderSearchDropdown();
        if (searchActive >= 0 && searchShown[searchActive]) chooseSearchEntry(searchShown[searchActive]);
        else if (runSearch(searchQuery).hits.some(h => h.e.type === "vocab")) showAllVocabMatches(searchQuery);
        else if (searchShown[0]) chooseSearchEntry(searchShown[0]);
    }
});
document.addEventListener("click", e => {
    if (!searchDd || searchDd.classList.contains("hidden")) return;
    if (!searchBoxEl.contains(e.target) && !searchDd.contains(e.target)) closeSearchDropdown();
});
window.addEventListener("resize", () => { if (!searchDd?.classList.contains("hidden")) positionSearchDropdown(); }, { passive: true });
window.addEventListener("scroll", () => { if (!searchDd?.classList.contains("hidden")) positionSearchDropdown(); }, { passive: true });

/* ═══════════════════════════════════════════════════════════════════════════════
   QUIZ MODE
   ═══════════════════════════════════════════════════════════════════════════════ */
let quizStreak = 0;
let quizBestStreak = 0;
let quizHistory = [];
let quizAudioTimeout = null;
let currentQuizLength = 20;
let quizTimerId = null;
let quizTimeLeft = 0;

function resetQuizState(mode) {
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    if (quizAudioTimeout) clearTimeout(quizAudioTimeout);
    if (quizTimerId) clearInterval(quizTimerId);
    quizMode = mode;
    
    ['modeKanjiBtn', 'modeMeaningBtn', 'modeListenBtn'].forEach(id => {
        if (document.getElementById(id)) {
            document.getElementById(id).classList.remove('active-mode');
            document.getElementById(id).setAttribute('aria-pressed', 'false');
        }
    });
    
    const activeBtn = mode === 'kanjiToMeaning' ? document.getElementById('modeKanjiBtn') 
                    : mode === 'meaningToKanji' ? document.getElementById('modeMeaningBtn') 
                    : document.getElementById('modeListenBtn');
                    
    if (activeBtn) {
        activeBtn.classList.add('active-mode');
        activeBtn.setAttribute('aria-pressed', 'true');
    }
    
    startNewQuiz();
}

document.getElementById('modeKanjiBtn')?.addEventListener('click', () => {
    if (quizMode !== 'kanjiToMeaning') resetQuizState('kanjiToMeaning');
});

document.getElementById('modeMeaningBtn')?.addEventListener('click', () => {
    if (quizMode !== 'meaningToKanji') resetQuizState('meaningToKanji');
});

document.getElementById('modeListenBtn')?.addEventListener('click', () => {
    if (quizMode !== 'listening') resetQuizState('listening');
});

function startNewQuiz() {
    if (!vocabulary.length) { showToast("Load a lesson first!", "error"); return; }
    
    currentQuizLength = store.get("jlpt_settings_quizLength", 20);
    // Don't force quizMode here to allow the user's manual mode clicks to work, 
    // but on initial app load, quizMode is "kanjiToMeaning".
    // We could apply jlpt_settings_defaultQuizMode on first load, but that might be complex to intercept here without resetting.
    
    qNum = 0;
    score = 0;
    quizStreak = 0;
    quizHistory = [];
    if (quizTimerId) clearInterval(quizTimerId);
    
    const pool = [...vocabulary].sort((a, b) => {
        const aKey = wordKey(a);
        const bKey = wordKey(b);
        const aSrs = srsData[aKey] || {};
        const bSrs = srsData[bKey] || {};
        const aLeech = (aSrs.eFactor < 1.7 && aSrs.repetition > 0) ? 1 : 0;
        const bLeech = (bSrs.eFactor < 1.7 && bSrs.repetition > 0) ? 1 : 0;
        if (aLeech !== bLeech) return bLeech - aLeech;
        return Math.random() - 0.5;
    });
    quizQueue = pool;
    const resBox = document.getElementById("quizResult");
    if (resBox) resBox.innerHTML = "";

    if (document.getElementById("quizQuestion")) document.getElementById("quizQuestion").style.display = "block";
    
    const typingWrap = document.getElementById("typingModeWrap");
    const optIds = ["optionA", "optionB", "optionC", "optionD"];
    
    optIds.forEach(id => { if (document.getElementById(id)) document.getElementById(id).style.display = "block"; });
    if (typingWrap) closeModal("typingWrap");

    updateQuizUI();
    nextQuizQuestion();
}
window.startNewQuiz = startNewQuiz;

function updateQuizUI() {
    safeText(document.getElementById("scoreDisplay"), `⭐ Score: ${score}`);
    safeText(document.getElementById("streakDisplay"), `🔥 Streak: ${quizStreak}`);
    safeText(document.getElementById("bestStreakDisplay"), `🏆 Best: ${quizBestStreak}`);
    safeText(document.getElementById("quizCounter"), `Question ${Math.min(qNum + 1, currentQuizLength)} / ${currentQuizLength}`);

    const fill = document.getElementById("quizProgressFill");
    if (fill) fill.style.width = `${(qNum / currentQuizLength) * 100}%`;
}

function startQuizTimer() {
    if (quizTimerId) clearInterval(quizTimerId);
    const isTimed = store.get("jlpt_settings_quizTimed", false);
    const timerBar = document.getElementById("quizTimerBar");
    if (!isTimed) {
        if (timerBar) timerBar.style.display = "none";
        return;
    }
    
    if (timerBar) timerBar.style.display = "block";
    quizTimeLeft = 100;
    const timerFill = document.getElementById("quizTimerFill");
    if (timerFill) timerFill.style.width = "100%";
    
    quizTimerId = setInterval(() => {
        quizTimeLeft -= (100 / (10 * 10)); // 10 seconds total
        if (timerFill) timerFill.style.width = Math.max(0, quizTimeLeft) + "%";
        
        if (quizTimeLeft <= 0) {
            clearInterval(quizTimerId);
            handleQuizTimeout();
        }
    }, 100);
}

function handleQuizTimeout() {
    const ans = (quizMode === "meaningToKanji") ? (window._currentQuizWord.kanji || window._currentQuizWord.hiragana) : window._currentQuizWord.meaning;
    
    quizStreak = 0;
    
    ["optionA", "optionB", "optionC", "optionD"].forEach(id => {
        const b = $(id);
        if (b) {
            b.disabled = true;
            if (b.innerText === ans) b.classList.add("correct");
        }
    });

    const resBox = document.getElementById("quizResult");
    if (resBox) {
        resBox.innerHTML = `<div class="text-center slide-in-top">
            <h2 style="color:var(--danger)">Time's up!</h2>
            <p>The answer was: <strong>${sanitizeHTML(ans)}</strong></p>
        </div>`;
    }
    
    const key = wordKey(window._currentQuizWord);
    if (key && !userProfile.weak.includes(key)) userProfile.weak.push(key);
    store.set("jlpt_profile", userProfile);

    updateQuizUI();

    setTimeout(() => {
        const quizBox = document.querySelector(".quiz-box");
        quizBox?.classList.add("slide-out-left");
        setTimeout(() => {
            quizBox?.classList.remove("slide-out-left");
            qNum++;
            nextQuizQuestion();
            quizBox?.classList.add("slide-in-right");
            setTimeout(() => quizBox?.classList.remove("slide-in-right"), 300);
        }, 220);
    }, 1200);
}

function nextQuizQuestion() {
    if (quizTimerId) clearInterval(quizTimerId);
    
    if (vocabulary.length < 4) {
        showToast("Not enough words in this lesson to quiz!", "error");
        return;
    }
    if (qNum >= currentQuizLength || quizQueue.length === 0) {
        endQuiz();
        return;
    }

    updateQuizUI();

    const w = quizQueue.pop();
    if (!w) return;
    window._currentQuizWord = w;

    const qText = document.getElementById("quizQuestion");
    if (qText) {
        qText.classList.remove("q-in");
        void qText.offsetWidth;
        qText.classList.add("q-in");
        
        if (quizMode === "listening") {
            safeText(qText, "👂 Listen carefully...");
        } else if (quizMode === "meaningToKanji") {
            safeText(qText, w.meaning);
        } else {
            safeText(qText, w.kanji || w.hiragana);
        }
    }

    const ans = (quizMode === "meaningToKanji") ? (w.kanji || w.hiragana) : w.meaning;

    if (document.getElementById("quizSpeakBtn")) {
        if (quizMode === "meaningToKanji") {
            document.getElementById("quizSpeakBtn").style.display = "none";
        } else {
            document.getElementById("quizSpeakBtn").style.display = "block";
            document.getElementById("quizSpeakBtn").onclick = () => speakJapanese(w.hiragana || w.kanji);
            
            if (quizMode === "listening") {
                quizAudioTimeout = setTimeout(() => {
                    speakJapanese(w.hiragana || w.kanji);
                }, 250);
            }
        }
    }

    const distractorsList = vocabulary.filter(x => ((quizMode === "meaningToKanji") ? (x.kanji || x.hiragana) : x.meaning) !== ans);
    distractorsList.sort((a, b) => {
        const aKey = wordKey(a);
        const bKey = wordKey(b);
        const aSrs = srsData[aKey] || {};
        const bSrs = srsData[bKey] || {};
        const aLeech = (aSrs.eFactor < 1.7 && aSrs.repetition > 0) ? 1 : 0;
        const bLeech = (bSrs.eFactor < 1.7 && bSrs.repetition > 0) ? 1 : 0;
        if (aLeech !== bLeech) return bLeech - aLeech;
        return Math.random() - 0.5;
    });
    const pool = distractorsList.slice(0, 3);
    const opts = shuffleArray([ans, ...pool.map(x => ((quizMode === "meaningToKanji") ? (x.kanji || x.hiragana) : x.meaning))]);

    ["optionA", "optionB", "optionC", "optionD"].forEach((id, i) => {
        const b = $(id);
        if (!b || opts[i] === undefined) return;
        b.className = "quiz-option opt-enter";
        b.disabled = false;
        b.style.opacity = "1";
        b.style.transform = "none";
        safeText(b, opts[i]);

        setTimeout(() => b.classList.remove("opt-enter"), 400);

        b.onclick = () => {
            if (quizTimerId) clearInterval(quizTimerId);
            
            document.querySelectorAll(".quiz-option").forEach(btn => {
                btn.disabled = true;
                if (btn.textContent === ans) btn.classList.add("correct");
            });

            const key = wordKey(w);
            if (opts[i] === ans) {
                score++;
                quizStreak++;
                quizBestStreak = Math.max(quizBestStreak, quizStreak);
                b.classList.add("correct");
                quizHistory.push({ word: w, correct: true });
                recordStudy();
            } else {
                quizStreak = 0;
                b.classList.add("wrong");
                quizHistory.push({ word: w, correct: false });
                if (key && !userProfile.weak.includes(key)) userProfile.weak.push(key);
            }

            store.set("jlpt_profile", userProfile);
            updateQuizUI();

            setTimeout(() => {
                const quizBox = document.querySelector(".quiz-box");
                quizBox?.classList.add("slide-out-left");
                setTimeout(() => {
                    quizBox?.classList.remove("slide-out-left");
                    qNum++;
                    nextQuizQuestion();
                    quizBox?.classList.add("slide-in-right");
                    setTimeout(() => quizBox?.classList.remove("slide-in-right"), 300);
                }, 220);
            }, 1000);
        };
    });
    
    startQuizTimer();
}
window.nextQuizQuestion = nextQuizQuestion;

function endQuiz() {
    if ($("quizQuestion")) $("quizQuestion").style.display = "none";
    if ($("quizSpeakBtn")) $("quizSpeakBtn").style.display = "none";
    ["optionA", "optionB", "optionC", "optionD"].forEach(id => { if ($(id)) $(id).style.display = "none"; });
    safeText($("quizCounter"), "Quiz Complete");
    if ($("quizProgressFill")) $("quizProgressFill").style.width = "100%";

    const pct = quizHistory.length ? Math.round((score / quizHistory.length) * 100) : 0;

    // Save to quiz history
    const d = new Date();
    const hist = store.get("jlpt_quizHistory", []);
    let modeName = "Kanji";
    if ($("modeMeaningBtn")?.classList.contains("active-mode")) modeName = "Meaning";
    if ($("modeListenBtn")?.classList.contains("active-mode")) modeName = "Listening";
    
    hist.push({
        date: d.toLocaleDateString(),
        time: d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        score: `${score}/${quizHistory.length}`,
        accuracy: pct,
        mode: modeName
    });
    store.set("jlpt_quizHistory", hist);
    const resBox = $("quizResult");
    if (!resBox) return;

    const summary = document.createElement("div");
    summary.className = "quiz-summary";

    const scoreWrap = document.createElement("div");
    scoreWrap.className = "quiz-summary-score";
    const scoreBig = document.createElement("div");
    scoreBig.className = "score-big";
    scoreBig.textContent = `${score} / ${quizHistory.length}`;
    const scoreLabel = document.createElement("div");
    scoreLabel.className = "score-label";
    scoreLabel.textContent = "Final Score";
    scoreWrap.append(scoreBig, scoreLabel);

    const statsWrap = document.createElement("div");
    statsWrap.className = "quiz-summary-stats";
    const mkStat = (val, key) => {
        const s = document.createElement("div"); s.className = "quiz-summary-stat";
        const v = document.createElement("div"); v.className = "stat-val"; v.textContent = String(val);
        const k = document.createElement("div"); k.className = "stat-key"; k.textContent = key;
        s.append(v, k); return s;
    };
    statsWrap.append(mkStat(`${pct}%`, "Accuracy"), mkStat(quizBestStreak, "Best Streak"));

    const radarWrap = document.createElement("div");
    radarWrap.className = "radar-chart-wrap";
    radarWrap.style.margin = "14px 0";
    const radarTitle = document.createElement("div");
    radarTitle.className = "radar-chart-title";
    radarTitle.textContent = "Performance Radar";
    const radarCanvas = document.createElement("canvas");
    radarCanvas.id = "quizRadarCanvas";
    radarCanvas.width = 220; radarCanvas.height = 220;
    radarWrap.append(radarTitle, radarCanvas);

    const reportList = document.createElement("div");
    reportList.className = "quiz-report-list";
    quizHistory.forEach(h => {
        const row = document.createElement("div");
        row.className = `quiz-report-item ${h.correct ? "r-correct" : "r-wrong"}`;
        const icon = document.createElement("span"); icon.className = "r-icon"; icon.textContent = h.correct ? "✅" : "❌";
        const kanji = document.createElement("span"); kanji.className = "r-kanji"; kanji.textContent = h.word.kanji || h.word.hiragana || "";
        const kana  = document.createElement("span"); kana.className  = "r-kana";  kana.textContent  = h.word.hiragana || "";
        const mean  = document.createElement("span"); mean.style.cssText = "margin-left:auto; font-size:12px; opacity:0.8;"; mean.textContent = h.word.meaning || "";
        row.append(icon, kanji, kana, mean);
        reportList.appendChild(row);
    });

    const restartBtn = document.createElement("button");
    restartBtn.className = "quiz-summary-restart";
    restartBtn.type = "button";
    restartBtn.textContent = "Retry Quiz";
    restartBtn.addEventListener("click", startNewQuiz);

    summary.append(scoreWrap, statsWrap, radarWrap, reportList, restartBtn);
    resBox.replaceChildren(summary);

    setTimeout(() => {
        if (typeof drawRadarFromHistory === "function") {
            drawRadarFromHistory("quizRadarCanvas", quizHistory);
        }
    }, 80);
}

/* ═══════════════════════════════════════════════════════════════════════════════
   CUSTOM LESSON DROPDOWN
   ═══════════════════════════════════════════════════════════════════════════════ */
const levelDropBox = $("levelDropdown");
const levelDropSel = $("levelSelected");
const levelDropOpts = $("levelOptions");

const dropBox = $("lessonDropdown");
const dropSel = $("lessonSelected");
const dropOpts = $("lessonOptions");

let lessonListLevel = null;   // which level the lesson menu is currently listing

function populateLessonOptions(level, preventLoad = false) {
    if (!dropOpts) return;
    const key = levelKey(level);
    const L = LEVELS[key];
    lessonListLevel = key;
    dropOpts.innerHTML = "";
    const fragOpts = document.createDocumentFragment();
    for (let i = L.from; i <= L.to; i++) {
        const o = document.createElement("div");
        o.className = "dropdown-option";
        o.setAttribute("role", "option");
        o.tabIndex = 0;
        o.textContent = `Lesson ${i}`;
        o.addEventListener("click", (e) => {
            e.stopPropagation();
            dropSel.textContent = `Lesson ${i}`;
            dropBox.classList.remove("open");
            dropBox.setAttribute("aria-expanded", "false");
            loadLesson(i, key);
        });
        fragOpts.appendChild(o);
    }
    dropOpts.appendChild(fragOpts);

    if (!preventLoad) {
        dropSel.textContent = `Lesson ${L.from}`;
        loadLesson(L.from, key);
    }
}

if (levelDropBox && levelDropSel && levelDropOpts && dropBox && dropSel && dropOpts) {
    levelDropBox.addEventListener("click", (e) => {
        e.stopPropagation();
        const willOpen = !levelDropBox.classList.contains("open");
        levelDropBox.classList.toggle("open");
        levelDropBox.setAttribute("aria-expanded", String(willOpen));
        dropBox.classList.remove("open");
        dropBox.setAttribute("aria-expanded", "false");
    });
    levelDropBox.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            levelDropBox.click();
        }
    });

    const levelOptions = levelDropOpts.querySelectorAll(".dropdown-option");
    levelOptions.forEach(opt => {
        opt.addEventListener("click", (e) => {
            e.stopPropagation();
            const key = levelKey(opt.textContent);
            levelDropSel.textContent = LEVELS[key].label;
            levelDropBox.classList.remove("open");
            levelDropBox.setAttribute("aria-expanded", "false");
            /* Loads the level's first lesson. currentLevel only changes once that
               lesson actually loads; on failure loadLesson restores the previous
               level and lesson in the menus. The kanji view refreshes itself
               from loadLesson (kanjiLevelChanged). */
            populateLessonOptions(key);
        });
    });

    dropBox.addEventListener("click", (e) => {
        e.stopPropagation();
        const willOpen = !dropBox.classList.contains("open");
        dropBox.classList.toggle("open");
        dropBox.setAttribute("aria-expanded", String(willOpen));
        levelDropBox.classList.remove("open");
        levelDropBox.setAttribute("aria-expanded", "false");
    });
    dropBox.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            dropBox.click();
        }
    });

    document.addEventListener("click", e => {
        if (!levelDropBox.contains(e.target)) {
            levelDropBox.classList.remove("open");
            levelDropBox.setAttribute("aria-expanded", "false");
        }
        if (!dropBox.contains(e.target)) {
            dropBox.classList.remove("open");
            dropBox.setAttribute("aria-expanded", "false");
        }
    });

    // Initial populate based on store
    const startPos = resolveStartPosition();
    currentLevel = startPos.level;
    levelDropSel.textContent = LEVELS[startPos.level].label;
    dropSel.textContent = `Lesson ${startPos.num}`;
    populateLessonOptions(startPos.level, true);
}

/* ═══════════════════════════════════════════════════════════════════════════════
   COMMAND PALETTE
   ═══════════════════════════════════════════════════════════════════════════════ */
const commands = [
    { n: "Go to Dashboard", k: "H", a: () => $("dashboardBtn")?.click() },
    { n: "Go to Vocabulary", k: "V", a: () => $("vocabBtn")?.click() },
    { n: "Review SRS", k: "R", a: () => $("reviewBtn")?.click() },
    { n: "Start Quiz", k: "Q", a: () => $("quizBtn")?.click() },
    { n: "Open Games", k: "", a: () => $("gamesBtn")?.click() },
    { n: "My Decks", k: "D", a: () => $("decksNavBtn")?.click() },
    { n: "Toggle Theme", k: "", a: () => $("themeToggleBtn")?.click() },
    { n: "Open Settings", k: "", a: () => $("settingsBtn")?.click() },
    { n: "Export Backup", k: "", a: () => store.export() },
    { n: "Daily Challenge", k: "", a: () => window.startDailyChallenge?.() },
    { n: "Speed Round", k: "", a: () => window.startSpeedRound?.() },
    { n: "Keyboard Shortcuts", k: "?", a: () => openModal("shortcutOverlay") }
];

document.addEventListener("keydown", e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        toggleCmdPalette();
        return;
    }


    if (currentView === "reviewView") {
        const tag = document.activeElement?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        if (e.key === "ArrowRight") $("reviewNextBtn")?.click();
        if (e.key === "ArrowLeft") $("reviewPrevBtn")?.click();
        if (e.key === " ") { e.preventDefault(); $("srsFlashcard")?.click(); }
        if (e.key === "1") $("srsBtn1")?.click();
        if (e.key === "2") $("srsBtn2")?.click();
        if (e.key === "3") $("srsBtn3")?.click();
        if (e.key === "4") $("srsBtn4")?.click();
    }

    if (currentView === "quizView") {
        const tag = document.activeElement?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") {
            if (e.key === "Enter") { e.preventDefault(); $("typingSubmitBtn")?.click(); }
            return;
        }
        
        if (e.key === "1") { e.preventDefault(); $("optionA")?.click(); }
        if (e.key === "2") { e.preventDefault(); $("optionB")?.click(); }
        if (e.key === "3") { e.preventDefault(); $("optionC")?.click(); }
        if (e.key === "4") { e.preventDefault(); $("optionD")?.click(); }
        
        if (e.key === " " || e.key === "Enter") {
            e.preventDefault();
            const resultBox = document.getElementById("quizResult");
            if (resultBox && resultBox.innerHTML.trim() !== "") {
                const nextBtns = resultBox.querySelectorAll("button");
                if (nextBtns.length > 0) nextBtns[0].click();
            } else if (typeof quizMode !== "undefined" && quizMode === "listening") {
                const btn = document.getElementById("quizSpeakBtn");
                if (btn) btn.click();
            }
        }
    }
});

function toggleCmdPalette() {
    const o = $("cmdOverlay"), i = $("cmdInput");
    if (!o || !i) return;
    if (o.classList.contains("hidden")) { o.classList.remove("hidden"); i.value = ""; i.focus(); renderCmd(); }
    else { window.closeModal?.("cmdOverlay"); }
}
window.toggleCmdPalette = toggleCmdPalette;
$("cmdPaletteMobileBtn")?.addEventListener("click", toggleCmdPalette);
$("cmdCloseBtn")?.addEventListener("click", () => window.closeModal?.("cmdOverlay"));

$("cmdInput")?.addEventListener("input", e => renderCmd(e.target.value.toLowerCase()));
function renderCmd(q = "") {
    const r = $("cmdResults");
    if (!r) return;
    r.innerHTML = "";
    const matches = commands.filter(c => c.n.toLowerCase().includes(q));
    matches.forEach(c => {
        const li = document.createElement("li");
        li.className = "cmd-item";
        li.tabIndex = 0;
        const nameSpan = document.createElement("span");
        nameSpan.textContent = c.n;
        const kbdSpan = document.createElement("span");
        kbdSpan.className = "cmd-kbd";
        kbdSpan.textContent = c.k;
        li.appendChild(nameSpan);
        li.appendChild(kbdSpan);
        li.addEventListener("click", () => { c.a(); toggleCmdPalette(); });
        r.appendChild(li);
    });
}

/* ═══════════════════════════════════════════════════════════════════════════════
   FEEDBACK MODAL
   ═══════════════════════════════════════════════════════════════════════════════ */
$("feedbackFab")?.addEventListener("click", () => openModal("feedbackOverlay"));
function closeFeedback() {
    window.closeModal?.("feedbackOverlay");
    if ($("feedbackText")) $("feedbackText").value = "";
}
window.closeFeedback = closeFeedback;

$("submitFeedbackBtn")?.addEventListener("click", () => {
    const c = $("feedbackCategory")?.value || "Other";
    const t = $("feedbackText")?.value || "";
    const FEEDBACK_EMAIL = "sahurahulcoc@gmail.com";
    const to = FEEDBACK_EMAIL;
    const subject = encodeURIComponent(`RONIN Feedback: ${c}`);
    const body = encodeURIComponent(t);

    const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

    if (isIOS) {
        window.location.href = `googlegmail:///co?to=${to}&subject=${subject}&body=${body}`;
    } else if (isMobile) {
        window.open(`https://mail.google.com/mail/?view=cm&fs=1&to=${to}&su=${subject}&body=${body}`, "_blank", "noopener,noreferrer");
    } else {
        const mailtoLink = `mailto:${to}?subject=${subject}&body=${body}`;
        window.open(`https://mail.google.com/mail/u/0/?extsrc=mailto&url=${encodeURIComponent(mailtoLink)}`, "_blank", "noopener,noreferrer");
    }
    closeFeedback();
    showToast("Opening Gmail...", "success");
});

/* ═══════════════════════════════════════════════════════════════════════════════
   THEME
   ═══════════════════════════════════════════════════════════════════════════════ */
function updateThemeLabels(isLight) {
    const label = $("themeLabel");
    const hoverLabel = $("themeLabelHover");
    const mLabel = $("mThemeBtn");

    // This can run very early during initial page setup (before the `i18n`
    // dictionary further down the file has actually been declared), so it
    // must never assume `i18n` is ready. Fall back to English in that case —
    // initI18n()/updateLanguage() will correct the label to the saved
    // language a moment later once i18n does exist.
    let dict;
    try {
        const lang = (typeof store !== "undefined" ? store.get("jlpt_settings_lang", "en") : "en");
        dict = i18n[lang] || i18n.en;
    } catch (_) {
        dict = {
            theme_dark_short: "🌙 Dark", theme_light_short: "☀️ Light",
            theme_dark_full: "🌙 Dark Mode", theme_light_full: "☀️ Light Mode"
        };
    }

    if (label)      label.textContent      = isLight ? dict.theme_dark_short : dict.theme_light_short;
    if (hoverLabel) hoverLabel.textContent = isLight ? dict.theme_light_short : dict.theme_dark_short;
    if (mLabel)     mLabel.textContent     = isLight ? dict.theme_dark_full : dict.theme_light_full;
}

async function toggleTheme(forceTheme) {
    const currentTheme = document.body.classList.contains("light-theme") ? "light" : "dark";
    const nextTheme = forceTheme || (currentTheme === "dark" ? "light" : "dark");
    if (currentTheme === nextTheme) return;

    await window.runShutterTransition(() => {
        document.body.classList.toggle("light-theme", nextTheme === "light");

        store.set("jlpt_settings_themeMode", nextTheme);
        store.set("jlpt_theme", nextTheme);

        updateThemeLabels(nextTheme === "light");

        const metaThemeInit = document.getElementById("metaThemeColor");
        if (metaThemeInit) metaThemeInit.content = nextTheme === "light" ? "#e2e8f0" : "#07080d";
    });
}
window.toggleTheme = toggleTheme;

$("themeToggleBtn")?.addEventListener("click", () => toggleTheme());

const initTheme = store.get("jlpt_settings_themeMode") || store.get("jlpt_theme", "dark");
if (initTheme === "light") document.body.classList.add("light-theme");
else document.body.classList.remove("light-theme");
updateThemeLabels(initTheme === "light");
const metaThemeInit = document.getElementById("metaThemeColor");
if (metaThemeInit) metaThemeInit.content = initTheme === "light" ? "#e2e8f0" : "#07080d";

/* ═══════════════════════════════════════════════════════════════════════════════
   INITIALIZATION
   ═══════════════════════════════════════════════════════════════════════════════ */
const _startPos = resolveStartPosition();
loadLesson(_startPos.num, _startPos.level);

const _startView = viewFromHash(window.location.hash);
if (_startView && _startView !== "dashboardView") {
    /* opened on a deep link (#kanji, #review, …): Home goes underneath, so Back leads to it */
    try { history.replaceState({ ronin: 1, view: "dashboardView" }, "", location.pathname + location.search); } catch (_) {}
    showView(_startView);
    syncNavPill(_startView.replace(/View$/, ""));
    if (_startView === "reviewView") setTimeout(() => startReview(), 50);
    else if (_startView === "quizView") setTimeout(() => startNewQuiz(), 50);
    else setTimeout(() => handleViewLogic(_startView.replace(/View$/, "")), 50);
} else {
    showView("dashboardView");
    syncNavPill("dashboard");
}

/* ═══════════════════════════════════════════════════════════════════════════════
   GSAP FLUID PILL-HOVER ANIMATION
   ═══════════════════════════════════════════════════════════════════════════════ */
function setupGSAPPill(pill) {
    const circle = pill.querySelector(".hover-circle");
    const label = pill.querySelector(".pill-label");
    const white = pill.querySelector(".pill-label-hover");

    if (!circle || !label || !white || pill.dataset.gsapBound || typeof gsap === "undefined") return;
    pill.dataset.gsapBound = "true";
    let tl;

    const updateLayout = () => {
        const w = pill.offsetWidth || 120;
        const h = pill.offsetHeight || 36;
        const R = ((w * w) / 4 + h * h) / (2 * h);
        const D = Math.ceil(2 * R) + 2;
        const delta = Math.ceil(R - Math.sqrt(Math.max(0, R * R - (w * w) / 4))) + 1;
        const originY = D - delta;

        circle.style.width = `${D}px`;
        circle.style.height = `${D}px`;
        circle.style.bottom = `-${delta}px`;

        gsap.set(circle, { xPercent: -50, scale: 0, transformOrigin: `50% ${originY}px` });
        gsap.set(label, { y: 0 });
        gsap.set(white, { y: h + 10, opacity: 0 });

        if (tl) tl.kill();
        tl = gsap.timeline({ paused: true });
        tl.to(circle, { scale: 1.2, duration: 0.35, ease: "power2.out" }, 0);
        tl.to(label, { y: -(h + 5), duration: 0.35, ease: "power2.out" }, 0);
        tl.to(white, { y: 0, opacity: 1, duration: 0.35, ease: "power2.out" }, 0);
    };

    pill.addEventListener("mouseenter", () => { updateLayout(); tl.play(); });
    pill.addEventListener("mouseleave", () => { if (tl) tl.reverse(); });
}

function initAllPillAnimations() {
    document.querySelectorAll(".pill, .pill-anim").forEach(setupGSAPPill);
}

/* ═══════════════════════════════════════════════════════════════════════════════
   MANUAL NAV TOGGLE — replaces the old scroll-triggered auto-hide entirely.
   The nav always starts visible on load/reload; the user controls hide/show
   themselves via the "∧" / "v" button. Works the same way on any screen size
   since it's driven by a click, not a scroll-position heuristic.
   ═══════════════════════════════════════════════════════════════════════════════ */
const pillNavWrap = $("pillNavWrap");
const floatingToolbar = $("floatingToolbar");
const navToggleBtn = $("navToggleBtn");

function measureNavHeight() {
    if (!pillNavWrap) return;
    // Measure while visible so a collapsed nav doesn't report 0 height.
    const wasHidden = pillNavWrap.classList.contains("nav-hidden");
    if (wasHidden) pillNavWrap.classList.remove("nav-hidden");
    const h = pillNavWrap.offsetHeight;
    if (wasHidden) pillNavWrap.classList.add("nav-hidden");
    if (h > 0) document.documentElement.style.setProperty("--nav-h", `${h}px`);
}

function setNavCollapsed(collapsed) {
    if (!pillNavWrap || !navToggleBtn) return;
    pillNavWrap.classList.toggle("nav-hidden", collapsed);
    floatingToolbar?.classList.toggle("toolbar-hidden", collapsed);
    navToggleBtn.classList.toggle("nav-is-collapsed", collapsed);
    navToggleBtn.textContent = collapsed ? "v" : "∧";
    navToggleBtn.setAttribute("aria-expanded", String(!collapsed));
    navToggleBtn.setAttribute("aria-label", collapsed ? "Show navigation bar" : "Hide navigation bar");
}

if (navToggleBtn) {
    measureNavHeight();
    window.addEventListener("resize", measureNavHeight, { passive: true });
    // Nav always starts visible on load/reload — no persisted collapsed state.
    setNavCollapsed(false);

    navToggleBtn.addEventListener("click", () => {
        const isCollapsed = pillNavWrap?.classList.contains("nav-hidden");
        setNavCollapsed(!isCollapsed);
        haptic(10);
    });
}

/* ═══════════════════════════════════════════════════════════════════════════════
   SRS DOCK — mouse-proximity magnification (macOS-dock style)
   ═══════════════════════════════════════════════════════════════════════════════ */
function setupSRSDock() {
    const dock = $("srsDock");
    if (!dock) return;

    const items = Array.from(dock.querySelectorAll(".srs-dock-item"));
    const buttons = items.map(item => item.querySelector(".srs-dock-btn")).filter(Boolean);
    const BASE_SIZE = 56;
    const MAX_SIZE = 88;
    const INFLUENCE = 150;

    let centers = [];
    let rafPending = false;
    let lastClientX = 0;

    function recalcCenters() {
        centers = buttons.map(btn => {
            const rect = btn.getBoundingClientRect();
            return rect.left + rect.width / 2;
        });
    }

    function applyMagnification(clientX) {
        buttons.forEach((btn, i) => {
            const dist = Math.abs(clientX - centers[i]);
            let size = dist < INFLUENCE
                ? BASE_SIZE + (MAX_SIZE - BASE_SIZE) * Math.pow(1 - dist / INFLUENCE, 1.8)
                : BASE_SIZE;
            size = Math.round(size);
            btn.style.width = size + "px";
            btn.style.height = size + "px";
            btn.style.fontSize = Math.round(size * 0.40) + "px";
            btn.style.borderRadius = Math.round(size * 0.265) + "px";
        });
        rafPending = false;
    }

    dock.addEventListener("mouseenter", recalcCenters);
    dock.addEventListener("mousemove", e => {
        lastClientX = e.clientX;
        if (!rafPending) {
            rafPending = true;
            requestAnimationFrame(() => applyMagnification(lastClientX));
        }
    });
    dock.addEventListener("mouseleave", () => {
        buttons.forEach(btn => {
            btn.style.width = "";
            btn.style.height = "";
            btn.style.fontSize = "";
            btn.style.borderRadius = "";
        });
    });

    window.addEventListener("resize", () => {
        if (dock.matches(":hover")) recalcCenters();
    }, { passive: true });

    buttons.forEach(btn => {
        btn.addEventListener("touchstart", () => {
            btn.style.width = MAX_SIZE + "px";
            btn.style.height = MAX_SIZE + "px";
            btn.style.fontSize = Math.round(MAX_SIZE * 0.40) + "px";
        }, { passive: true });
        btn.addEventListener("touchend", () => {
            btn.style.width = "";
            btn.style.height = "";
            btn.style.fontSize = "";
        }, { passive: true });
    });
}

document.addEventListener("DOMContentLoaded", () => {
    requestAnimationFrame(initAllPillAnimations);
});
setupSRSDock();

/* ═══════════════════════════════════════════════════════════════════════════════
   HELPERS & UTILS
   ═══════════════════════════════════════════════════════════════════════════════ */


function sortByLeechPriority(list) {
    return list.sort((a, b) => {
        const aKey = wordKey(a);
        const bKey = wordKey(b);
        const aSrs = srsData[aKey] || {};
        const bSrs = srsData[bKey] || {};
        const aLeech = (aSrs.eFactor < 1.7 && aSrs.repetition > 0) ? 1 : 0;
        const bLeech = (bSrs.eFactor < 1.7 && bSrs.repetition > 0) ? 1 : 0;
        if (aLeech !== bLeech) return bLeech - aLeech;
        return Math.random() - 0.5;
    });
}
window.sortByLeechPriority = sortByLeechPriority;

/* ═══════════════════════════════════════════════════════════════════════════════
   PWA INSTALL PROMPT — lives inside Settings → Data Management, not as a
   floating FAB, so it doesn't sit on top of content forever.
   ═══════════════════════════════════════════════════════════════════════════════ */
let deferredPrompt;
window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;

    const btn = document.getElementById("sdInstallAppBtn");
    if (!btn) return;
    btn.classList.remove("hidden");

    btn.addEventListener('click', async () => {
        if (!deferredPrompt) return;
        deferredPrompt.prompt();
        const { outcome } = await deferredPrompt.userChoice;
        if (outcome === "accepted") btn.classList.add("hidden");
        deferredPrompt = null;
    });
});
window.addEventListener('appinstalled', () => {
    document.getElementById("sdInstallAppBtn")?.classList.add("hidden");
    deferredPrompt = null;
});

/* ═══════════════════════════════════════════════════════════════════════════════
   REMINDER SCHEDULING
   ═══════════════════════════════════════════════════════════════════════════════ */
document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
        checkAndShowReminders();
    }
});

function checkAndShowReminders() {
    if (!store.get("jlpt_settings_dailyReminder", true)) return;
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    
    const remTimeStr = store.get("jlpt_settings_reminderTime", "19:00");
    const [remH, remM] = remTimeStr.split(":").map(Number);
    const now = new Date();
    
    // Check if current time is past the reminder time
    if (now.getHours() > remH || (now.getHours() === remH && now.getMinutes() >= remM)) {
        const lastNotified = store.get("jlpt_last_notified_date", "");
        const todayStr = now.toDateString();
        
        if (lastNotified !== todayStr) {
            // Check if there are due reviews
            let dueCount = 0;
            const nowMs = Date.now();
            for (const key in srsData) {
                if (srsData[key].dueDate <= nowMs) dueCount++;
            }
            if (dueCount > 0) {
                new Notification("RONIN 🎌", {
                    body: `You have ${dueCount} SRS reviews due!`,
                    icon: "data/assets/logo.png"
                });
                store.set("jlpt_last_notified_date", todayStr);
            } else if (store.get("jlpt_settings_streakWarning", true) && userProfile.wordsStudiedToday < userProfile.dailyGoal) {
                new Notification("RONIN 🎌", {
                    body: `Don't lose your ${userProfile.streak}-day streak! Keep studying!`,
                    icon: "data/assets/logo.png"
                });
                store.set("jlpt_last_notified_date", todayStr);
            }
        }
    }
}

/* ═══════════════════════════════════════════════════════════════════════════
   MODALS.JS — Centralized open/close for every .modal-overlay in the app.
   Single source of truth for the open/close micro-animation timing so it
   never drifts out of sync with the CSS keyframes above.
   ═══════════════════════════════════════════════════════════════════════════ */

const MODAL_CLOSE_MS = 220; // must match the modalOut animation-duration in style.css

let openModalsCount = 0;
const modalStack = [];

function openModal(id) {
    const overlay = document.getElementById(id);
    if (!overlay || !overlay.classList.contains("hidden")) return;

    modalStack.push({
        id: id,
        previousFocus: document.activeElement
    });

    overlay.classList.remove("closing");
    overlay.classList.remove("hidden");

    openModalsCount++;
    if (openModalsCount === 1) {
        document.body.classList.add("modal-open-scroll-lock");
    }

    // Focus first focusable element inside
    const focusable = overlay.querySelector('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (focusable) focusable.focus();
}
window.openModal = openModal;

function closeModal(id, onClosed) {
    const overlay = document.getElementById(id);
    if (!overlay || overlay.classList.contains("hidden") || overlay.classList.contains("closing")) return;

    overlay.classList.add("closing");

    const index = modalStack.findIndex(m => m.id === id);
    let previousFocus = null;
    if (index !== -1) {
        previousFocus = modalStack[index].previousFocus;
        modalStack.splice(index, 1);
    }

    openModalsCount = Math.max(0, openModalsCount - 1);
    if (openModalsCount === 0) {
        document.body.classList.remove("modal-open-scroll-lock");
    }

    setTimeout(() => {
        overlay.classList.add("hidden");
        overlay.classList.remove("closing");
        if (previousFocus && typeof previousFocus.focus === 'function') {
            previousFocus.focus();
        }
        if (typeof onClosed === "function") onClosed();
    }, MODAL_CLOSE_MS);
}
window.closeModal = closeModal;

// Global Escape Key and Tab Trap Handler
document.addEventListener("keydown", (e) => {
    if (modalStack.length === 0) return;
    const topModal = modalStack[modalStack.length - 1];

    if (e.key === "Escape") {
        e.preventDefault();
        closeModal(topModal.id);
    } else if (e.key === "Tab") {
        const overlay = document.getElementById(topModal.id);
        if (!overlay) return;
        const focusables = overlay.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
        // Filter out disabled or hidden elements
        const visibleFocusables = Array.from(focusables).filter(el => !el.disabled && el.offsetParent !== null);
        if (visibleFocusables.length === 0) {
            e.preventDefault();
            return;
        }
        const first = visibleFocusables[0];
        const last = visibleFocusables[visibleFocusables.length - 1];
        
        if (e.shiftKey) { // Shift + Tab
            if (document.activeElement === first || !overlay.contains(document.activeElement)) {
                last.focus();
                e.preventDefault();
            }
        } else { // Tab
            if (document.activeElement === last || !overlay.contains(document.activeElement)) {
                first.focus();
                e.preventDefault();
            }
        }
    }
});

// Global Outside Click Handler
document.addEventListener("click", (e) => {
    if (e.target.classList.contains("modal-overlay") && !e.target.classList.contains("no-outside-click")) {
        closeModal(e.target.id);
    }
});

const i18n = {
    en: {
        nav_home: "Home",
        nav_vocab: "Vocab",
        nav_kanji: "🈶 Kanji",
        nav_review: "Review",
        nav_quiz: "Quiz",
        nav_games: "Games",
        nav_analytics: "Analytics",
        nav_decks: "Decks",
        nav_settings: "Settings",
        nav_review_mobile: "SRS Review",
        nav_decks_mobile: "My Decks",
        sd_study_behavior: "Study Behavior",
        sd_audio: "Audio",
        sd_notifications: "Notifications",
        sd_display: "Display & Accessibility",
        sd_data: "Data Management",
        sd_profile: "Profile",
        sd_gamification: "Gamification",
        sd_about: "About",
        sd_language: "Language",
        sd_language_label: "App Language:",
        sd_language_note: "Translates menus and app chrome. Vocabulary content stays in Japanese/English.",
        dash_daily_goal: "Daily Goal",
        dash_streak: "Current Streak",
        dash_total_learned: "Total Learned",
        dash_due_reviews: "Due Reviews",
        dash_start_review: "Start Review",
        dash_quick_actions: "Quick Actions",
        dash_favorites: "Favorites",
        dash_weak_words: "Weak Words",
        dash_my_decks: "My Decks",
        dash_daily_challenge: "Daily Challenge",
        dash_speed_round: "Speed Round",
        dash_challenge_active: "Daily Challenge Active!",
        dash_achievements: "Achievements",
        an_title: "Study Analytics",
        an_heatmap: "Study Heatmap",
        an_readiness: "JLPT Readiness",
        an_quiz_history: "Quiz History",
        view_kanji_title: "Kanji Reference",
        view_review_title: "Spaced Repetition",
        view_games_title: "Mini Games",
        modal_feedback: "Send Feedback",
        modal_create_deck: "Create Deck",
        modal_my_decks: "My Decks",
        modal_word_detail: "Word Detail",
        modal_add_to_deck: "Add to Deck",
        modal_settings: "Settings",
        sd_new_cards: "New Cards / Day:",
        sd_review_order: "Review Order:",
        sd_due_soonest: "Due Soonest",
        sd_random: "Random",
        sd_hardest_first: "Hardest First",
        sd_quiz_length: "Quiz Length (Questions):",
        sd_default_quiz_mode: "Default Quiz Mode:",
        sd_kanji_to_meaning: "Kanji → Meaning",
        sd_meaning_to_kanji: "Meaning → Kanji",
        sd_listening: "Listening",
        sd_timed_quizzes: "Timed Quizzes (10s/q)",
        sd_tts_voice: "TTS Voice:",
        sd_auto_default: "Auto (System Default)",
        sd_speech_rate: "Speech Rate:",
        sd_mute_audio: "Mute All Audio",
        sd_enable_reminders: "Enable Review Reminders",
        sd_reminder_time: "Reminder Time:",
        sd_streak_warning: "Streak-at-Risk Warning",
        sd_theme_mode: "Theme Mode:",
        sd_sync_system: "Sync with System",
        sd_dark: "Dark",
        sd_light: "Light",
        sd_reduce_motion: "Reduce Motion",
        sd_font_scale: "Font Size Scaling:",
        sd_card_density: "Compact Card Density",
        sd_export: "⬇️ Export Backup",
        sd_never_backed_up: "Never backed up",
        sd_import: "⬆️ Import Backup",
        sd_clear_cache: "🧹 Clear Cache / Force Update",
        sd_install: "📲 Install RONIN App",
        sd_reset: "⚠️ Reset Progress",
        sd_display_name: "Display Name:",
        sd_daily_goal_words: "Daily Goal (Words):",
        sd_10_words: "10 Words",
        sd_20_words: "20 Words",
        sd_50_words: "50 Words",
        sd_show_gamification: "Show XP & Achievements",
        btn_send: "Send",
        btn_cancel: "Cancel",
        btn_create_deck: "Create Deck",
        btn_submit: "Submit",
        btn_lets_go: "Let's Go",
        theme_dark_short: "🌙 Dark",
        theme_light_short: "☀️ Light",
        theme_dark_full: "🌙 Dark Mode",
        theme_light_full: "☀️ Light Mode",
        sc_title: "Keyboard Shortcuts",
        sc_group_nav: "Navigation",
        sc_home: "Go Home",
        sc_vocab: "Go to Vocab",
        sc_review: "Go to Review",
        sc_quiz: "Go to Quiz",
        sc_games: "Open Games (press again to leave)",
        sc_decks: "Open / close My Decks",
        sc_group_actions: "Actions",
        sc_theme: "Toggle dark / light theme",
        sc_settings: "Open / close Settings",
        sc_export: "Export backup",
        sc_challenge: "Start / close Daily Challenge",
        sc_speedround: "Start / close Speed Round",
        sc_group_review: "During Review (S doubles as Play Audio here)",
        sc_flip: "Flip card",
        sc_flip2: "Flip card",
        sc_prevnext: "Prev / Next card",
        sc_again: "Again",
        sc_hard: "Hard",
        sc_good: "Good",
        sc_easy: "Easy",
        sc_undo: "Undo last rating",
        sc_fav: "Favorite current word",
        sc_audio: "Play audio",
        sc_detail: "Word detail",
        sc_group_general: "General",
        sc_cheatsheet: "This cheatsheet",
        sc_palette: "Command palette",
        sc_esc: "Close any modal",
    },
    es: {
        nav_home: "Inicio",
        nav_vocab: "Vocabulario",
        nav_kanji: "🈶 Kanji",
        nav_review: "Repaso",
        nav_quiz: "Prueba",
        nav_games: "Juegos",
        nav_analytics: "Análisis",
        nav_decks: "Mazos",
        nav_settings: "Ajustes",
        nav_review_mobile: "Repaso SRS",
        nav_decks_mobile: "Mis Mazos",
        sd_study_behavior: "Comportamiento de estudio",
        sd_audio: "Audio",
        sd_notifications: "Notificaciones",
        sd_display: "Pantalla y accesibilidad",
        sd_data: "Gestión de datos",
        sd_profile: "Perfil",
        sd_gamification: "Gamificación",
        sd_about: "Acerca de",
        sd_language: "Idioma",
        sd_language_label: "Idioma de la app:",
        sd_language_note: "Traduce los menús y la interfaz. El vocabulario permanece en japonés/inglés.",
        dash_daily_goal: "Meta diaria",
        dash_streak: "Racha actual",
        dash_total_learned: "Total aprendido",
        dash_due_reviews: "Repasos pendientes",
        dash_start_review: "Iniciar repaso",
        dash_quick_actions: "Acciones rápidas",
        dash_favorites: "Favoritos",
        dash_weak_words: "Palabras débiles",
        dash_my_decks: "Mis Mazos",
        dash_daily_challenge: "Desafío diario",
        dash_speed_round: "Ronda rápida",
        dash_challenge_active: "¡Desafío diario activo!",
        dash_achievements: "Logros",
        an_title: "Análisis de estudio",
        an_heatmap: "Mapa de calor de estudio",
        an_readiness: "Preparación JLPT",
        an_quiz_history: "Historial de pruebas",
        view_kanji_title: "Referencia de Kanji",
        view_review_title: "Repetición espaciada",
        view_games_title: "Minijuegos",
        modal_feedback: "Enviar comentarios",
        modal_create_deck: "Crear mazo",
        modal_my_decks: "Mis Mazos",
        modal_word_detail: "Detalle de palabra",
        modal_add_to_deck: "Añadir al mazo",
        modal_settings: "Ajustes",
        sd_new_cards: "Tarjetas nuevas / día:",
        sd_review_order: "Orden de repaso:",
        sd_due_soonest: "Vence primero",
        sd_random: "Aleatorio",
        sd_hardest_first: "Más difícil primero",
        sd_quiz_length: "Duración de la prueba (preguntas):",
        sd_default_quiz_mode: "Modo de prueba predeterminado:",
        sd_kanji_to_meaning: "Kanji → Significado",
        sd_meaning_to_kanji: "Significado → Kanji",
        sd_listening: "Escucha",
        sd_timed_quizzes: "Pruebas cronometradas (10s/preg)",
        sd_tts_voice: "Voz TTS:",
        sd_auto_default: "Automático (predeterminado del sistema)",
        sd_speech_rate: "Velocidad de voz:",
        sd_mute_audio: "Silenciar todo el audio",
        sd_enable_reminders: "Activar recordatorios de repaso",
        sd_reminder_time: "Hora del recordatorio:",
        sd_streak_warning: "Aviso de racha en riesgo",
        sd_theme_mode: "Modo de tema:",
        sd_sync_system: "Sincronizar con el sistema",
        sd_dark: "Oscuro",
        sd_light: "Claro",
        sd_reduce_motion: "Reducir movimiento",
        sd_font_scale: "Escala de tamaño de fuente:",
        sd_card_density: "Densidad de tarjetas compacta",
        sd_export: "⬇️ Exportar copia de seguridad",
        sd_never_backed_up: "Nunca se hizo copia de seguridad",
        sd_import: "⬆️ Importar copia de seguridad",
        sd_clear_cache: "🧹 Borrar caché / Forzar actualización",
        sd_install: "📲 Instalar app RONIN",
        sd_reset: "⚠️ Restablecer progreso",
        sd_display_name: "Nombre para mostrar:",
        sd_daily_goal_words: "Meta diaria (palabras):",
        sd_10_words: "10 palabras",
        sd_20_words: "20 palabras",
        sd_50_words: "50 palabras",
        sd_show_gamification: "Mostrar XP y logros",
        btn_send: "Enviar",
        btn_cancel: "Cancelar",
        btn_create_deck: "Crear mazo",
        btn_submit: "Enviar",
        btn_lets_go: "¡Vamos!",
        theme_dark_short: "🌙 Oscuro",
        theme_light_short: "☀️ Claro",
        theme_dark_full: "🌙 Modo oscuro",
        theme_light_full: "☀️ Modo claro",
        sc_title: "Atajos de teclado",
        sc_group_nav: "Navegación",
        sc_home: "Ir a Inicio",
        sc_vocab: "Ir a Vocabulario",
        sc_review: "Ir a Repaso",
        sc_quiz: "Ir a Prueba",
        sc_games: "Abrir Juegos (pulsa de nuevo para salir)",
        sc_decks: "Abrir / cerrar Mis Mazos",
        sc_group_actions: "Acciones",
        sc_theme: "Alternar tema oscuro / claro",
        sc_settings: "Abrir / cerrar Ajustes",
        sc_export: "Exportar copia de seguridad",
        sc_challenge: "Iniciar / cerrar Desafío diario",
        sc_speedround: "Iniciar / cerrar Ronda rápida",
        sc_group_review: "Durante el repaso (S también reproduce audio aquí)",
        sc_flip: "Voltear tarjeta",
        sc_flip2: "Voltear tarjeta",
        sc_prevnext: "Tarjeta anterior / siguiente",
        sc_again: "Otra vez",
        sc_hard: "Difícil",
        sc_good: "Bien",
        sc_easy: "Fácil",
        sc_undo: "Deshacer última calificación",
        sc_fav: "Marcar palabra actual como favorita",
        sc_audio: "Reproducir audio",
        sc_detail: "Detalle de palabra",
        sc_group_general: "General",
        sc_cheatsheet: "Esta chuleta",
        sc_palette: "Paleta de comandos",
        sc_esc: "Cerrar cualquier ventana",
    },
    id: {
        nav_home: "Beranda",
        nav_vocab: "Kosakata",
        nav_kanji: "🈶 Kanji",
        nav_review: "Ulasan",
        nav_quiz: "Kuis",
        nav_games: "Permainan",
        nav_analytics: "Analitik",
        nav_decks: "Dek",
        nav_settings: "Pengaturan",
        nav_review_mobile: "Ulasan SRS",
        nav_decks_mobile: "Dek Saya",
        sd_study_behavior: "Perilaku Belajar",
        sd_audio: "Audio",
        sd_notifications: "Notifikasi",
        sd_display: "Tampilan & Aksesibilitas",
        sd_data: "Manajemen Data",
        sd_profile: "Profil",
        sd_gamification: "Gamifikasi",
        sd_about: "Tentang",
        sd_language: "Bahasa",
        sd_language_label: "Bahasa Aplikasi:",
        sd_language_note: "Menerjemahkan menu dan tampilan aplikasi. Konten kosakata tetap dalam bahasa Jepang/Inggris.",
        dash_daily_goal: "Target Harian",
        dash_streak: "Rentetan Saat Ini",
        dash_total_learned: "Total Dipelajari",
        dash_due_reviews: "Ulasan Jatuh Tempo",
        dash_start_review: "Mulai Ulasan",
        dash_quick_actions: "Aksi Cepat",
        dash_favorites: "Favorit",
        dash_weak_words: "Kata Lemah",
        dash_my_decks: "Dek Saya",
        dash_daily_challenge: "Tantangan Harian",
        dash_speed_round: "Ronde Cepat",
        dash_challenge_active: "Tantangan Harian Aktif!",
        dash_achievements: "Pencapaian",
        an_title: "Analitik Belajar",
        an_heatmap: "Peta Panas Belajar",
        an_readiness: "Kesiapan JLPT",
        an_quiz_history: "Riwayat Kuis",
        view_kanji_title: "Referensi Kanji",
        view_review_title: "Pengulangan Berjarak",
        view_games_title: "Mini Games",
        modal_feedback: "Kirim Masukan",
        modal_create_deck: "Buat Dek",
        modal_my_decks: "Dek Saya",
        modal_word_detail: "Detail Kata",
        modal_add_to_deck: "Tambah ke Dek",
        modal_settings: "Pengaturan",
        sd_new_cards: "Kartu Baru / Hari:",
        sd_review_order: "Urutan Ulasan:",
        sd_due_soonest: "Jatuh Tempo Terdekat",
        sd_random: "Acak",
        sd_hardest_first: "Tersulit Dulu",
        sd_quiz_length: "Panjang Kuis (Pertanyaan):",
        sd_default_quiz_mode: "Mode Kuis Default:",
        sd_kanji_to_meaning: "Kanji → Arti",
        sd_meaning_to_kanji: "Arti → Kanji",
        sd_listening: "Mendengarkan",
        sd_timed_quizzes: "Kuis Waktu Terbatas (10dtk/soal)",
        sd_tts_voice: "Suara TTS:",
        sd_auto_default: "Otomatis (Default Sistem)",
        sd_speech_rate: "Kecepatan Bicara:",
        sd_mute_audio: "Bisukan Semua Audio",
        sd_enable_reminders: "Aktifkan Pengingat Ulasan",
        sd_reminder_time: "Waktu Pengingat:",
        sd_streak_warning: "Peringatan Rentetan Berisiko",
        sd_theme_mode: "Mode Tema:",
        sd_sync_system: "Sinkron dengan Sistem",
        sd_dark: "Gelap",
        sd_light: "Terang",
        sd_reduce_motion: "Kurangi Gerakan",
        sd_font_scale: "Skala Ukuran Font:",
        sd_card_density: "Kepadatan Kartu Ringkas",
        sd_export: "⬇️ Ekspor Cadangan",
        sd_never_backed_up: "Belum pernah dicadangkan",
        sd_import: "⬆️ Impor Cadangan",
        sd_clear_cache: "🧹 Hapus Cache / Paksa Perbarui",
        sd_install: "📲 Instal Aplikasi RONIN",
        sd_reset: "⚠️ Atur Ulang Progres",
        sd_display_name: "Nama Tampilan:",
        sd_daily_goal_words: "Target Harian (Kata):",
        sd_10_words: "10 Kata",
        sd_20_words: "20 Kata",
        sd_50_words: "50 Kata",
        sd_show_gamification: "Tampilkan XP & Pencapaian",
        btn_send: "Kirim",
        btn_cancel: "Batal",
        btn_create_deck: "Buat Dek",
        btn_submit: "Kirim",
        btn_lets_go: "Ayo Mulai",
        theme_dark_short: "🌙 Gelap",
        theme_light_short: "☀️ Terang",
        theme_dark_full: "🌙 Mode Gelap",
        theme_light_full: "☀️ Mode Terang",
        sc_title: "Pintasan Keyboard",
        sc_group_nav: "Navigasi",
        sc_home: "Ke Beranda",
        sc_vocab: "Ke Kosakata",
        sc_review: "Ke Ulasan",
        sc_quiz: "Ke Kuis",
        sc_games: "Buka Permainan (tekan lagi untuk keluar)",
        sc_decks: "Buka / tutup Dek Saya",
        sc_group_actions: "Aksi",
        sc_theme: "Alihkan tema gelap / terang",
        sc_settings: "Buka / tutup Pengaturan",
        sc_export: "Ekspor cadangan",
        sc_challenge: "Mulai / tutup Tantangan Harian",
        sc_speedround: "Mulai / tutup Ronde Cepat",
        sc_group_review: "Selama Ulasan (S juga berfungsi Putar Audio di sini)",
        sc_flip: "Balik kartu",
        sc_flip2: "Balik kartu",
        sc_prevnext: "Kartu sebelumnya / berikutnya",
        sc_again: "Lagi",
        sc_hard: "Sulit",
        sc_good: "Bagus",
        sc_easy: "Mudah",
        sc_undo: "Batalkan penilaian terakhir",
        sc_fav: "Favoritkan kata saat ini",
        sc_audio: "Putar audio",
        sc_detail: "Detail kata",
        sc_group_general: "Umum",
        sc_cheatsheet: "Lembar contekan ini",
        sc_palette: "Palet Perintah",
        sc_esc: "Tutup jendela apa pun",
    },
    "zh-TW": {
        nav_home: "首頁",
        nav_vocab: "單字",
        nav_kanji: "🈶 漢字",
        nav_review: "複習",
        nav_quiz: "測驗",
        nav_games: "遊戲",
        nav_analytics: "分析",
        nav_decks: "牌組",
        nav_settings: "設定",
        nav_review_mobile: "間隔複習",
        nav_decks_mobile: "我的牌組",
        sd_study_behavior: "學習行為",
        sd_audio: "音訊",
        sd_notifications: "通知",
        sd_display: "顯示與無障礙",
        sd_data: "資料管理",
        sd_profile: "個人檔案",
        sd_gamification: "遊戲化",
        sd_about: "關於",
        sd_language: "語言",
        sd_language_label: "應用程式語言：",
        sd_language_note: "僅翻譯選單與介面文字，單字內容仍保留日文/英文。",
        dash_daily_goal: "每日目標",
        dash_streak: "目前連續天數",
        dash_total_learned: "已學習總數",
        dash_due_reviews: "待複習",
        dash_start_review: "開始複習",
        dash_quick_actions: "快速操作",
        dash_favorites: "收藏",
        dash_weak_words: "待加強單字",
        dash_my_decks: "我的牌組",
        dash_daily_challenge: "每日挑戰",
        dash_speed_round: "極速挑戰",
        dash_challenge_active: "每日挑戰進行中！",
        dash_achievements: "成就",
        an_title: "學習分析",
        an_heatmap: "學習熱力圖",
        an_readiness: "JLPT 準備度",
        an_quiz_history: "測驗紀錄",
        view_kanji_title: "漢字參考",
        view_review_title: "間隔重複",
        view_games_title: "小遊戲",
        modal_feedback: "傳送意見回饋",
        modal_create_deck: "建立牌組",
        modal_my_decks: "我的牌組",
        modal_word_detail: "單字詳情",
        modal_add_to_deck: "加入牌組",
        modal_settings: "設定",
        sd_new_cards: "每日新卡數：",
        sd_review_order: "複習順序：",
        sd_due_soonest: "最快到期",
        sd_random: "隨機",
        sd_hardest_first: "最難優先",
        sd_quiz_length: "測驗長度（題數）：",
        sd_default_quiz_mode: "預設測驗模式：",
        sd_kanji_to_meaning: "漢字 → 意思",
        sd_meaning_to_kanji: "意思 → 漢字",
        sd_listening: "聽力",
        sd_timed_quizzes: "限時測驗（每題10秒）",
        sd_tts_voice: "語音合成音色：",
        sd_auto_default: "自動（系統預設）",
        sd_speech_rate: "語速：",
        sd_mute_audio: "靜音所有音效",
        sd_enable_reminders: "啟用複習提醒",
        sd_reminder_time: "提醒時間：",
        sd_streak_warning: "連續天數中斷警告",
        sd_theme_mode: "主題模式：",
        sd_sync_system: "與系統同步",
        sd_dark: "深色",
        sd_light: "淺色",
        sd_reduce_motion: "減少動態效果",
        sd_font_scale: "字體大小縮放：",
        sd_card_density: "精簡卡片密度",
        sd_export: "⬇️ 匯出備份",
        sd_never_backed_up: "從未備份",
        sd_import: "⬆️ 匯入備份",
        sd_clear_cache: "🧹 清除快取／強制更新",
        sd_install: "📲 安裝 RONIN 應用程式",
        sd_reset: "⚠️ 重設進度",
        sd_display_name: "顯示名稱：",
        sd_daily_goal_words: "每日目標（單字數）：",
        sd_10_words: "10 個單字",
        sd_20_words: "20 個單字",
        sd_50_words: "50 個單字",
        sd_show_gamification: "顯示經驗值與成就",
        btn_send: "傳送",
        btn_cancel: "取消",
        btn_create_deck: "建立牌組",
        btn_submit: "送出",
        btn_lets_go: "開始吧",
        theme_dark_short: "🌙 深色",
        theme_light_short: "☀️ 淺色",
        theme_dark_full: "🌙 深色模式",
        theme_light_full: "☀️ 淺色模式",
        sc_title: "鍵盤快速鍵",
        sc_group_nav: "導覽",
        sc_home: "回到首頁",
        sc_vocab: "前往單字",
        sc_review: "前往複習",
        sc_quiz: "前往測驗",
        sc_games: "開啟遊戲（再按一次離開）",
        sc_decks: "開啟／關閉我的牌組",
        sc_group_actions: "操作",
        sc_theme: "切換深色／淺色主題",
        sc_settings: "開啟／關閉設定",
        sc_export: "匯出備份",
        sc_challenge: "開始／關閉每日挑戰",
        sc_speedround: "開始／關閉極速挑戰",
        sc_group_review: "複習期間（此處 S 兼作播放語音）",
        sc_flip: "翻卡",
        sc_flip2: "翻卡",
        sc_prevnext: "上一張／下一張卡",
        sc_again: "再來一次",
        sc_hard: "困難",
        sc_good: "還可以",
        sc_easy: "簡單",
        sc_undo: "復原上一次評分",
        sc_fav: "收藏目前單字",
        sc_audio: "播放語音",
        sc_detail: "單字詳情",
        sc_group_general: "一般",
        sc_cheatsheet: "這份快速鍵表",
        sc_palette: "指令面板",
        sc_esc: "關閉任何視窗",
    },
    vi: {
        nav_home: "Trang chủ",
        nav_vocab: "Từ vựng",
        nav_kanji: "🈶 Kanji",
        nav_review: "Ôn tập",
        nav_quiz: "Kiểm tra",
        nav_games: "Trò chơi",
        nav_analytics: "Phân tích",
        nav_decks: "Bộ thẻ",
        nav_settings: "Cài đặt",
        nav_review_mobile: "Ôn tập SRS",
        nav_decks_mobile: "Bộ thẻ của tôi",
        sd_study_behavior: "Chế độ học",
        sd_audio: "Âm thanh",
        sd_notifications: "Thông báo",
        sd_display: "Hiển thị & Trợ năng",
        sd_data: "Quản lý dữ liệu",
        sd_profile: "Hồ sơ",
        sd_gamification: "Trò chơi hóa",
        sd_about: "Giới thiệu",
        sd_language: "Ngôn ngữ",
        sd_language_label: "Ngôn ngữ ứng dụng:",
        sd_language_note: "Chỉ dịch menu và giao diện. Nội dung từ vựng vẫn giữ tiếng Nhật/Anh.",
        dash_daily_goal: "Mục tiêu hàng ngày",
        dash_streak: "Chuỗi ngày hiện tại",
        dash_total_learned: "Tổng số đã học",
        dash_due_reviews: "Cần ôn tập",
        dash_start_review: "Bắt đầu ôn tập",
        dash_quick_actions: "Thao tác nhanh",
        dash_favorites: "Yêu thích",
        dash_weak_words: "Từ còn yếu",
        dash_my_decks: "Bộ thẻ của tôi",
        dash_daily_challenge: "Thử thách hàng ngày",
        dash_speed_round: "Vòng tốc độ",
        dash_challenge_active: "Thử thách hàng ngày đang diễn ra!",
        dash_achievements: "Thành tựu",
        an_title: "Phân tích học tập",
        an_heatmap: "Bản đồ nhiệt học tập",
        an_readiness: "Mức độ sẵn sàng JLPT",
        an_quiz_history: "Lịch sử kiểm tra",
        view_kanji_title: "Tra cứu Kanji",
        view_review_title: "Lặp lại ngắt quãng",
        view_games_title: "Trò chơi nhỏ",
        modal_feedback: "Gửi phản hồi",
        modal_create_deck: "Tạo bộ thẻ",
        modal_my_decks: "Bộ thẻ của tôi",
        modal_word_detail: "Chi tiết từ",
        modal_add_to_deck: "Thêm vào bộ thẻ",
        modal_settings: "Cài đặt",
        sd_new_cards: "Thẻ mới / ngày:",
        sd_review_order: "Thứ tự ôn tập:",
        sd_due_soonest: "Sắp đến hạn nhất",
        sd_random: "Ngẫu nhiên",
        sd_hardest_first: "Khó nhất trước",
        sd_quiz_length: "Độ dài bài kiểm tra (số câu):",
        sd_default_quiz_mode: "Chế độ kiểm tra mặc định:",
        sd_kanji_to_meaning: "Kanji → Nghĩa",
        sd_meaning_to_kanji: "Nghĩa → Kanji",
        sd_listening: "Nghe",
        sd_timed_quizzes: "Kiểm tra tính giờ (10s/câu)",
        sd_tts_voice: "Giọng đọc TTS:",
        sd_auto_default: "Tự động (Mặc định hệ thống)",
        sd_speech_rate: "Tốc độ nói:",
        sd_mute_audio: "Tắt tất cả âm thanh",
        sd_enable_reminders: "Bật nhắc nhở ôn tập",
        sd_reminder_time: "Thời gian nhắc nhở:",
        sd_streak_warning: "Cảnh báo nguy cơ mất chuỗi",
        sd_theme_mode: "Chế độ giao diện:",
        sd_sync_system: "Đồng bộ với hệ thống",
        sd_dark: "Tối",
        sd_light: "Sáng",
        sd_reduce_motion: "Giảm chuyển động",
        sd_font_scale: "Tỉ lệ cỡ chữ:",
        sd_card_density: "Mật độ thẻ gọn",
        sd_export: "⬇️ Xuất bản sao lưu",
        sd_never_backed_up: "Chưa từng sao lưu",
        sd_import: "⬆️ Nhập bản sao lưu",
        sd_clear_cache: "🧹 Xóa bộ nhớ đệm / Buộc cập nhật",
        sd_install: "📲 Cài đặt ứng dụng RONIN",
        sd_reset: "⚠️ Đặt lại tiến trình",
        sd_display_name: "Tên hiển thị:",
        sd_daily_goal_words: "Mục tiêu hàng ngày (từ):",
        sd_10_words: "10 từ",
        sd_20_words: "20 từ",
        sd_50_words: "50 từ",
        sd_show_gamification: "Hiện XP & Thành tựu",
        btn_send: "Gửi",
        btn_cancel: "Hủy",
        btn_create_deck: "Tạo bộ thẻ",
        btn_submit: "Gửi",
        btn_lets_go: "Bắt đầu",
        theme_dark_short: "🌙 Tối",
        theme_light_short: "☀️ Sáng",
        theme_dark_full: "🌙 Chế độ tối",
        theme_light_full: "☀️ Chế độ sáng",
        sc_title: "Phím tắt",
        sc_group_nav: "Điều hướng",
        sc_home: "Về Trang chủ",
        sc_vocab: "Đến Từ vựng",
        sc_review: "Đến Ôn tập",
        sc_quiz: "Đến Kiểm tra",
        sc_games: "Mở Trò chơi (bấm lại để thoát)",
        sc_decks: "Mở / đóng Bộ thẻ của tôi",
        sc_group_actions: "Hành động",
        sc_theme: "Chuyển đổi giao diện tối / sáng",
        sc_settings: "Mở / đóng Cài đặt",
        sc_export: "Xuất bản sao lưu",
        sc_challenge: "Bắt đầu / đóng Thử thách hàng ngày",
        sc_speedround: "Bắt đầu / đóng Vòng tốc độ",
        sc_group_review: "Trong khi Ôn tập (S còn dùng để Phát âm thanh ở đây)",
        sc_flip: "Lật thẻ",
        sc_flip2: "Lật thẻ",
        sc_prevnext: "Thẻ trước / sau",
        sc_again: "Lại",
        sc_hard: "Khó",
        sc_good: "Tốt",
        sc_easy: "Dễ",
        sc_undo: "Hoàn tác đánh giá cuối",
        sc_fav: "Yêu thích từ hiện tại",
        sc_audio: "Phát âm thanh",
        sc_detail: "Chi tiết từ",
        sc_group_general: "Chung",
        sc_cheatsheet: "Bảng tra cứu này",
        sc_palette: "Bảng lệnh",
        sc_esc: "Đóng mọi hộp thoại",
    },
    ko: {
        nav_home: "홈",
        nav_vocab: "단어",
        nav_kanji: "🈶 한자",
        nav_review: "복습",
        nav_quiz: "퀴즈",
        nav_games: "게임",
        nav_analytics: "분석",
        nav_decks: "덱",
        nav_settings: "설정",
        nav_review_mobile: "SRS 복습",
        nav_decks_mobile: "내 덱",
        sd_study_behavior: "학습 설정",
        sd_audio: "오디오",
        sd_notifications: "알림",
        sd_display: "화면 및 접근성",
        sd_data: "데이터 관리",
        sd_profile: "프로필",
        sd_gamification: "게이미피케이션",
        sd_about: "정보",
        sd_language: "언어",
        sd_language_label: "앱 언어:",
        sd_language_note: "메뉴와 화면 UI만 번역됩니다. 단어 콘텐츠는 일본어/영어로 유지됩니다.",
        dash_daily_goal: "일일 목표",
        dash_streak: "현재 연속 기록",
        dash_total_learned: "총 학습 단어",
        dash_due_reviews: "복습 예정",
        dash_start_review: "복습 시작",
        dash_quick_actions: "빠른 작업",
        dash_favorites: "즐겨찾기",
        dash_weak_words: "취약 단어",
        dash_my_decks: "내 덱",
        dash_daily_challenge: "일일 챌린지",
        dash_speed_round: "스피드 라운드",
        dash_challenge_active: "일일 챌린지 진행 중!",
        dash_achievements: "업적",
        an_title: "학습 분석",
        an_heatmap: "학습 히트맵",
        an_readiness: "JLPT 준비도",
        an_quiz_history: "퀴즈 기록",
        view_kanji_title: "한자 참고",
        view_review_title: "간격 반복 학습",
        view_games_title: "미니게임",
        modal_feedback: "피드백 보내기",
        modal_create_deck: "덱 만들기",
        modal_my_decks: "내 덱",
        modal_word_detail: "단어 상세",
        modal_add_to_deck: "덱에 추가",
        modal_settings: "설정",
        sd_new_cards: "일일 새 카드:",
        sd_review_order: "복습 순서:",
        sd_due_soonest: "가장 임박한 순",
        sd_random: "무작위",
        sd_hardest_first: "어려운 순",
        sd_quiz_length: "퀴즈 길이(문항 수):",
        sd_default_quiz_mode: "기본 퀴즈 모드:",
        sd_kanji_to_meaning: "한자 → 의미",
        sd_meaning_to_kanji: "의미 → 한자",
        sd_listening: "듣기",
        sd_timed_quizzes: "시간제 퀴즈 (문항당 10초)",
        sd_tts_voice: "TTS 음성:",
        sd_auto_default: "자동 (시스템 기본값)",
        sd_speech_rate: "말하기 속도:",
        sd_mute_audio: "모든 오디오 음소거",
        sd_enable_reminders: "복습 알림 사용",
        sd_reminder_time: "알림 시간:",
        sd_streak_warning: "연속 기록 위험 경고",
        sd_theme_mode: "테마 모드:",
        sd_sync_system: "시스템과 동기화",
        sd_dark: "다크",
        sd_light: "라이트",
        sd_reduce_motion: "모션 줄이기",
        sd_font_scale: "글꼴 크기 배율:",
        sd_card_density: "카드 밀도 축소",
        sd_export: "⬇️ 백업 내보내기",
        sd_never_backed_up: "백업한 적 없음",
        sd_import: "⬆️ 백업 가져오기",
        sd_clear_cache: "🧹 캐시 지우기 / 강제 업데이트",
        sd_install: "📲 RONIN 앱 설치",
        sd_reset: "⚠️ 진행 상황 초기화",
        sd_display_name: "표시 이름:",
        sd_daily_goal_words: "일일 목표 (단어 수):",
        sd_10_words: "단어 10개",
        sd_20_words: "단어 20개",
        sd_50_words: "단어 50개",
        sd_show_gamification: "XP 및 업적 표시",
        btn_send: "보내기",
        btn_cancel: "취소",
        btn_create_deck: "덱 만들기",
        btn_submit: "제출",
        btn_lets_go: "시작하기",
        theme_dark_short: "🌙 다크",
        theme_light_short: "☀️ 라이트",
        theme_dark_full: "🌙 다크 모드",
        theme_light_full: "☀️ 라이트 모드",
        sc_title: "키보드 단축키",
        sc_group_nav: "탐색",
        sc_home: "홈으로 이동",
        sc_vocab: "단어로 이동",
        sc_review: "복습으로 이동",
        sc_quiz: "퀴즈로 이동",
        sc_games: "게임 열기 (다시 누르면 나가기)",
        sc_decks: "내 덱 열기/닫기",
        sc_group_actions: "작업",
        sc_theme: "다크/라이트 테마 전환",
        sc_settings: "설정 열기/닫기",
        sc_export: "백업 내보내기",
        sc_challenge: "일일 챌린지 시작/닫기",
        sc_speedround: "스피드 라운드 시작/닫기",
        sc_group_review: "복습 중 (여기서는 S가 오디오 재생도 겸함)",
        sc_flip: "카드 뒤집기",
        sc_flip2: "카드 뒤집기",
        sc_prevnext: "이전/다음 카드",
        sc_again: "다시",
        sc_hard: "어려움",
        sc_good: "좋음",
        sc_easy: "쉬움",
        sc_undo: "마지막 평가 취소",
        sc_fav: "현재 단어 즐겨찾기",
        sc_audio: "오디오 재생",
        sc_detail: "단어 상세",
        sc_group_general: "일반",
        sc_cheatsheet: "이 단축키 목록",
        sc_palette: "명령 팔레트",
        sc_esc: "모든 창 닫기",
    },
    "pt-BR": {
        nav_home: "Início",
        nav_vocab: "Vocabulário",
        nav_kanji: "🈶 Kanji",
        nav_review: "Revisão",
        nav_quiz: "Teste",
        nav_games: "Jogos",
        nav_analytics: "Análises",
        nav_decks: "Baralhos",
        nav_settings: "Configurações",
        nav_review_mobile: "Revisão SRS",
        nav_decks_mobile: "Meus Baralhos",
        sd_study_behavior: "Comportamento de Estudo",
        sd_audio: "Áudio",
        sd_notifications: "Notificações",
        sd_display: "Exibição e Acessibilidade",
        sd_data: "Gerenciamento de Dados",
        sd_profile: "Perfil",
        sd_gamification: "Gamificação",
        sd_about: "Sobre",
        sd_language: "Idioma",
        sd_language_label: "Idioma do aplicativo:",
        sd_language_note: "Traduz os menus e a interface. O conteúdo do vocabulário permanece em japonês/inglês.",
        dash_daily_goal: "Meta Diária",
        dash_streak: "Sequência Atual",
        dash_total_learned: "Total Aprendido",
        dash_due_reviews: "Revisões Pendentes",
        dash_start_review: "Iniciar Revisão",
        dash_quick_actions: "Ações Rápidas",
        dash_favorites: "Favoritos",
        dash_weak_words: "Palavras Fracas",
        dash_my_decks: "Meus Baralhos",
        dash_daily_challenge: "Desafio Diário",
        dash_speed_round: "Rodada Rápida",
        dash_challenge_active: "Desafio Diário Ativo!",
        dash_achievements: "Conquistas",
        an_title: "Análises de Estudo",
        an_heatmap: "Mapa de Calor de Estudo",
        an_readiness: "Prontidão para o JLPT",
        an_quiz_history: "Histórico de Testes",
        view_kanji_title: "Referência de Kanji",
        view_review_title: "Repetição Espaçada",
        view_games_title: "Minijogos",
        modal_feedback: "Enviar Feedback",
        modal_create_deck: "Criar Baralho",
        modal_my_decks: "Meus Baralhos",
        modal_word_detail: "Detalhe da Palavra",
        modal_add_to_deck: "Adicionar ao Baralho",
        modal_settings: "Configurações",
        sd_new_cards: "Novos Cartões / Dia:",
        sd_review_order: "Ordem de Revisão:",
        sd_due_soonest: "Mais Urgente Primeiro",
        sd_random: "Aleatório",
        sd_hardest_first: "Mais Difícil Primeiro",
        sd_quiz_length: "Duração do Teste (Perguntas):",
        sd_default_quiz_mode: "Modo de Teste Padrão:",
        sd_kanji_to_meaning: "Kanji → Significado",
        sd_meaning_to_kanji: "Significado → Kanji",
        sd_listening: "Escuta",
        sd_timed_quizzes: "Testes Cronometrados (10s/pergunta)",
        sd_tts_voice: "Voz TTS:",
        sd_auto_default: "Automático (Padrão do Sistema)",
        sd_speech_rate: "Velocidade da Fala:",
        sd_mute_audio: "Silenciar Todo o Áudio",
        sd_enable_reminders: "Ativar Lembretes de Revisão",
        sd_reminder_time: "Horário do Lembrete:",
        sd_streak_warning: "Aviso de Sequência em Risco",
        sd_theme_mode: "Modo de Tema:",
        sd_sync_system: "Sincronizar com o Sistema",
        sd_dark: "Escuro",
        sd_light: "Claro",
        sd_reduce_motion: "Reduzir Movimento",
        sd_font_scale: "Escala do Tamanho da Fonte:",
        sd_card_density: "Densidade de Cartão Compacta",
        sd_export: "⬇️ Exportar Backup",
        sd_never_backed_up: "Nunca foi feito backup",
        sd_import: "⬆️ Importar Backup",
        sd_clear_cache: "🧹 Limpar Cache / Forçar Atualização",
        sd_install: "📲 Instalar App RONIN",
        sd_reset: "⚠️ Redefinir Progresso",
        sd_display_name: "Nome de Exibição:",
        sd_daily_goal_words: "Meta Diária (Palavras):",
        sd_10_words: "10 Palavras",
        sd_20_words: "20 Palavras",
        sd_50_words: "50 Palavras",
        sd_show_gamification: "Mostrar XP e Conquistas",
        btn_send: "Enviar",
        btn_cancel: "Cancelar",
        btn_create_deck: "Criar Baralho",
        btn_submit: "Enviar",
        btn_lets_go: "Vamos Lá",
        theme_dark_short: "🌙 Escuro",
        theme_light_short: "☀️ Claro",
        theme_dark_full: "🌙 Modo Escuro",
        theme_light_full: "☀️ Modo Claro",
        sc_title: "Atalhos de Teclado",
        sc_group_nav: "Navegação",
        sc_home: "Ir para Início",
        sc_vocab: "Ir para Vocabulário",
        sc_review: "Ir para Revisão",
        sc_quiz: "Ir para Teste",
        sc_games: "Abrir Jogos (pressione novamente para sair)",
        sc_decks: "Abrir / fechar Meus Baralhos",
        sc_group_actions: "Ações",
        sc_theme: "Alternar tema escuro / claro",
        sc_settings: "Abrir / fechar Configurações",
        sc_export: "Exportar backup",
        sc_challenge: "Iniciar / fechar Desafio Diário",
        sc_speedround: "Iniciar / fechar Rodada Rápida",
        sc_group_review: "Durante a Revisão (S também toca o áudio aqui)",
        sc_flip: "Virar cartão",
        sc_flip2: "Virar cartão",
        sc_prevnext: "Cartão anterior / próximo",
        sc_again: "De Novo",
        sc_hard: "Difícil",
        sc_good: "Bom",
        sc_easy: "Fácil",
        sc_undo: "Desfazer última avaliação",
        sc_fav: "Favoritar palavra atual",
        sc_audio: "Tocar áudio",
        sc_detail: "Detalhe da palavra",
        sc_group_general: "Geral",
        sc_cheatsheet: "Esta folha de atalhos",
        sc_palette: "Paleta de Comandos",
        sc_esc: "Fechar qualquer modal",
    },
    th: {
        nav_home: "หน้าแรก",
        nav_vocab: "คำศัพท์",
        nav_kanji: "🈶 คันจิ",
        nav_review: "ทบทวน",
        nav_quiz: "แบบทดสอบ",
        nav_games: "เกม",
        nav_analytics: "วิเคราะห์",
        nav_decks: "ชุดคำศัพท์",
        nav_settings: "การตั้งค่า",
        nav_review_mobile: "ทบทวนแบบ SRS",
        nav_decks_mobile: "ชุดคำศัพท์ของฉัน",
        sd_study_behavior: "รูปแบบการเรียน",
        sd_audio: "เสียง",
        sd_notifications: "การแจ้งเตือน",
        sd_display: "การแสดงผลและการช่วยการเข้าถึง",
        sd_data: "การจัดการข้อมูล",
        sd_profile: "โปรไฟล์",
        sd_gamification: "ระบบเกม",
        sd_about: "เกี่ยวกับ",
        sd_language: "ภาษา",
        sd_language_label: "ภาษาของแอป:",
        sd_language_note: "แปลเฉพาะเมนูและหน้าจอแอป เนื้อหาคำศัพท์ยังคงเป็นภาษาญี่ปุ่น/อังกฤษ",
        dash_daily_goal: "เป้าหมายรายวัน",
        dash_streak: "สถิติต่อเนื่องปัจจุบัน",
        dash_total_learned: "เรียนรู้ทั้งหมด",
        dash_due_reviews: "ถึงกำหนดทบทวน",
        dash_start_review: "เริ่มทบทวน",
        dash_quick_actions: "การดำเนินการด่วน",
        dash_favorites: "รายการโปรด",
        dash_weak_words: "คำศัพท์ที่อ่อน",
        dash_my_decks: "ชุดคำศัพท์ของฉัน",
        dash_daily_challenge: "ความท้าทายรายวัน",
        dash_speed_round: "รอบความเร็ว",
        dash_challenge_active: "ความท้าทายรายวันกำลังทำงาน!",
        dash_achievements: "ความสำเร็จ",
        an_title: "การวิเคราะห์การเรียน",
        an_heatmap: "แผนที่ความร้อนการเรียน",
        an_readiness: "ความพร้อม JLPT",
        an_quiz_history: "ประวัติแบบทดสอบ",
        view_kanji_title: "อ้างอิงคันจิ",
        view_review_title: "การทบทวนแบบเว้นระยะ",
        view_games_title: "มินิเกม",
        modal_feedback: "ส่งความคิดเห็น",
        modal_create_deck: "สร้างชุดคำศัพท์",
        modal_my_decks: "ชุดคำศัพท์ของฉัน",
        modal_word_detail: "รายละเอียดคำศัพท์",
        modal_add_to_deck: "เพิ่มลงชุดคำศัพท์",
        modal_settings: "การตั้งค่า",
        sd_new_cards: "การ์ดใหม่ / วัน:",
        sd_review_order: "ลำดับการทบทวน:",
        sd_due_soonest: "ใกล้ครบกำหนดที่สุด",
        sd_random: "สุ่ม",
        sd_hardest_first: "ยากที่สุดก่อน",
        sd_quiz_length: "ความยาวแบบทดสอบ (จำนวนข้อ):",
        sd_default_quiz_mode: "โหมดแบบทดสอบเริ่มต้น:",
        sd_kanji_to_meaning: "คันจิ → ความหมาย",
        sd_meaning_to_kanji: "ความหมาย → คันจิ",
        sd_listening: "การฟัง",
        sd_timed_quizzes: "แบบทดสอบจับเวลา (10 วิ/ข้อ)",
        sd_tts_voice: "เสียงอ่านออกเสียง:",
        sd_auto_default: "อัตโนมัติ (ค่าเริ่มต้นระบบ)",
        sd_speech_rate: "ความเร็วเสียงพูด:",
        sd_mute_audio: "ปิดเสียงทั้งหมด",
        sd_enable_reminders: "เปิดใช้การแจ้งเตือนทบทวน",
        sd_reminder_time: "เวลาแจ้งเตือน:",
        sd_streak_warning: "เตือนสถิติต่อเนื่องเสี่ยงขาด",
        sd_theme_mode: "โหมดธีม:",
        sd_sync_system: "ซิงค์กับระบบ",
        sd_dark: "มืด",
        sd_light: "สว่าง",
        sd_reduce_motion: "ลดการเคลื่อนไหว",
        sd_font_scale: "ปรับขนาดตัวอักษร:",
        sd_card_density: "ความหนาแน่นการ์ดแบบกระชับ",
        sd_export: "⬇️ ส่งออกข้อมูลสำรอง",
        sd_never_backed_up: "ยังไม่เคยสำรองข้อมูล",
        sd_import: "⬆️ นำเข้าข้อมูลสำรอง",
        sd_clear_cache: "🧹 ล้างแคช / บังคับอัปเดต",
        sd_install: "📲 ติดตั้งแอป RONIN",
        sd_reset: "⚠️ รีเซ็ตความคืบหน้า",
        sd_display_name: "ชื่อที่แสดง:",
        sd_daily_goal_words: "เป้าหมายรายวัน (คำ):",
        sd_10_words: "10 คำ",
        sd_20_words: "20 คำ",
        sd_50_words: "50 คำ",
        sd_show_gamification: "แสดง XP และความสำเร็จ",
        btn_send: "ส่ง",
        btn_cancel: "ยกเลิก",
        btn_create_deck: "สร้างชุดคำศัพท์",
        btn_submit: "ส่ง",
        btn_lets_go: "เริ่มกันเลย",
        theme_dark_short: "🌙 มืด",
        theme_light_short: "☀️ สว่าง",
        theme_dark_full: "🌙 โหมดมืด",
        theme_light_full: "☀️ โหมดสว่าง",
        sc_title: "ปุ่มลัดคีย์บอร์ด",
        sc_group_nav: "การนำทาง",
        sc_home: "ไปหน้าแรก",
        sc_vocab: "ไปคำศัพท์",
        sc_review: "ไปทบทวน",
        sc_quiz: "ไปแบบทดสอบ",
        sc_games: "เปิดเกม (กดอีกครั้งเพื่อออก)",
        sc_decks: "เปิด/ปิดชุดคำศัพท์ของฉัน",
        sc_group_actions: "การดำเนินการ",
        sc_theme: "สลับธีมมืด/สว่าง",
        sc_settings: "เปิด/ปิดการตั้งค่า",
        sc_export: "ส่งออกข้อมูลสำรอง",
        sc_challenge: "เริ่ม/ปิดความท้าทายรายวัน",
        sc_speedround: "เริ่ม/ปิดรอบความเร็ว",
        sc_group_review: "ระหว่างทบทวน (ปุ่ม S ใช้เล่นเสียงด้วยที่นี่)",
        sc_flip: "พลิกการ์ด",
        sc_flip2: "พลิกการ์ด",
        sc_prevnext: "การ์ดก่อนหน้า/ถัดไป",
        sc_again: "อีกครั้ง",
        sc_hard: "ยาก",
        sc_good: "ดี",
        sc_easy: "ง่าย",
        sc_undo: "เลิกทำการให้คะแนนล่าสุด",
        sc_fav: "เพิ่มคำนี้ในรายการโปรด",
        sc_audio: "เล่นเสียง",
        sc_detail: "รายละเอียดคำศัพท์",
        sc_group_general: "ทั่วไป",
        sc_cheatsheet: "ชีทลัดนี้",
        sc_palette: "แผงคำสั่ง",
        sc_esc: "ปิดหน้าต่างใดก็ได้",
    },
};

function updateLanguage(lang) {
    const dict = i18n[lang] || i18n.en;
    document.querySelectorAll('[data-i18n-key]').forEach(el => {
        const key = el.getAttribute('data-i18n-key');
        if (dict[key]) {
            el.textContent = dict[key];
        } else if (i18n.en[key]) {
            el.textContent = i18n.en[key]; // fall back to English rather than showing broken text
        }
    });
    document.documentElement.setAttribute("lang", lang);

    // Theme toggle labels are JS-driven (they depend on current theme state,
    // not just static markup), so re-apply them here too — otherwise
    // switching language wouldn't retranslate them until the theme was
    // toggled again.
    if (typeof updateThemeLabels === "function") {
        const isLight = document.body.classList.contains("light-theme");
        updateThemeLabels(isLight);
    }
}

function setLanguage(lang) {
    if (!i18n[lang]) lang = "en";
    store.set("jlpt_settings_lang", lang);
    updateLanguage(lang);
}
window.setLanguage = setLanguage;

function initI18n() {
    const savedLang = typeof store !== 'undefined' ? store.get("jlpt_settings_lang", "en") : "en";
    updateLanguage(savedLang);
    
    const langSelect = document.getElementById("sdLangSelect");
    if (langSelect) {
        langSelect.value = i18n[savedLang] ? savedLang : "en";
        langSelect.addEventListener("change", (e) => {
            setLanguage(e.target.value);
        });
    }
}
window.initI18n = initI18n;
document.addEventListener("DOMContentLoaded", initI18n);

/* ═══════════════════════════════════════════════════════════
   RONIN — kanji
   One file per kanji lesson:  data/<level>/kanji-L<n>.json
   (N5: kanji-L1 … L7 in data/n5/,  N4: kanji-L8 … L26 in data/n4/)
   Format: { lesson, title, subtitle, subtitleMeaning,
             kanji: [{ char, meaning, onyomi[], kunyomi[], strokes,
                       examples[{word,reading,meaning}],
                       relatedWords[{word,reading,meaning,relation}] }] }
 ═══════════════════════════════════════════════════════════ */

// <KANJI-START>  (tests extract this block: keep it free of DOM / other globals)
const kjStr = v => (typeof v === "string" ? v : (v == null ? "" : String(v)));
const kjList = v => (Array.isArray(v) ? v.map(kjStr).filter(Boolean) : (typeof v === "string" && v ? [v] : []));
function kjWords(arr) {
    return (Array.isArray(arr) ? arr : [])
        .filter(w => w && typeof w === "object" && kjStr(w.word))
        .map(w => ({ word: kjStr(w.word), reading: kjStr(w.reading), meaning: kjStr(w.meaning), relation: kjStr(w.relation) }));
}
/* Accepts the lesson-file format above (or a bare array of kanji) and returns a
   clean, fully-typed object, so the renderer never has to guard against
   missing or malformed fields. Throws a readable message if the file has no kanji list. */
function normalizeKanjiFile(raw, expectedNum) {
    const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.kanji) ? raw.kanji : null);
    if (!list) throw new Error('the file has no "kanji" list');
    const head = raw && !Array.isArray(raw) ? raw : {};
    return {
        lesson: Number(head.lesson) || expectedNum,
        title: kjStr(head.title),
        subtitle: kjStr(head.subtitle),
        subtitleMeaning: kjStr(head.subtitleMeaning),
        kanji: list.filter(k => k && typeof k === "object" && kjStr(k.char)).map(k => ({
            char: kjStr(k.char),
            meaning: kjStr(k.meaning),
            onyomi: kjList(k.onyomi),
            kunyomi: kjList(k.kunyomi),
            strokes: Number(k.strokes) > 0 ? Math.round(Number(k.strokes)) : 0,
            examples: kjWords(k.examples),
            related: kjWords(k.relatedWords)
        }))
    };
}
// <KANJI-END>

let kanjiData = [];                       // kanji of the lesson on screen (kept on window for other scripts)
let kanjiSrsData = store.get("jlpt_kanjiSrs", {});
let kanjiLevel = "n5";
let kanjiLessonNum = 0;
let kanjiRequest = 0;                     // guards against out-of-order responses when chips are tapped quickly
const kanjiCache = {};                    // "n4:19" -> normalized lesson, for this session only

function kjEl(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined && text !== "") el.textContent = text;
    return el;
}

function kjMessage(text, detail) {
    const list = document.getElementById("kanjiList");
    if (!list) return;
    list.replaceChildren();
    const box = kjEl("div", "kj-msg", text);
    if (detail) box.appendChild(kjEl("small", "", detail));
    list.appendChild(box);
}

function kjRememberLesson(level, num) {
    const map = store.get("jlpt_kanjiLast", {});
    map[level] = num;
    store.set("jlpt_kanjiLast", map);
}

function renderKanjiChips() {
    const bar = document.getElementById("kanjiLessonBar");
    if (!bar) return;
    bar.replaceChildren();
    const K = LEVELS[kanjiLevel].kanji;
    bar.classList.toggle("hidden", !K);
    if (!K) return;
    for (let n = K.from; n <= K.to; n++) {
        const b = kjEl("button", "kj-chip", `L${n}`);
        b.type = "button";
        b.setAttribute("aria-pressed", String(n === kanjiLessonNum));
        b.setAttribute("aria-label", `Kanji lesson ${n}`);
        b.addEventListener("click", () => loadKanjiLesson(kanjiLevel, n));
        bar.appendChild(b);
    }
    /* centre the active chip inside the bar only; scrollIntoView would also scroll the page */
    const active = bar.querySelector('[aria-pressed="true"]');
    if (active) bar.scrollLeft = active.offsetLeft - (bar.clientWidth - active.offsetWidth) / 2;
}

function renderKanjiHeader(data) {
    const head = document.getElementById("kanjiHeader");
    if (!head) return;
    head.replaceChildren();
    if (!data) return;
    head.appendChild(kjEl("div", "kj-head-title", `${LEVELS[kanjiLevel].label} · Kanji Lesson ${data.lesson}`));
    const sub = [data.title, data.subtitle].filter(Boolean).join(" · ");
    if (sub) head.appendChild(kjEl("div", "kj-head-sub", sub));
    if (data.subtitleMeaning) head.appendChild(kjEl("div", "kj-head-sub", data.subtitleMeaning));
}

/* A kanji presented as a "word", so the shared actions (word detail, add to deck,
   favourite, weak, audio, copy) work on kanji exactly as they do on vocab. */
function kjReading(k) {
    const clean = r => String(r || "").replace(/[（(].*?[）)]/g, "").replace(/[-‐\s]/g, "");
    return clean(k.kunyomi[0]) || clean(k.onyomi[0]) || (k.examples[0] ? k.examples[0].reading : "");
}
function kjAsWord(k) {
    return {
        kanji: k.char, hiragana: kjReading(k), meaning: k.meaning || "",
        memory: k.examples.slice(0, 3).map(e => `${e.word}（${e.reading}）`).join("、"),
        example: "", emoji: "", section: "Kanji"
    };
}

function kjWordRow(w, withRelation) {
    const row = kjEl("div", "kj-exrow");
    row.appendChild(kjEl("span", "kj-w", w.word));
    if (w.reading) row.appendChild(kjEl("span", "kj-r", w.reading));
    if (w.meaning) row.appendChild(kjEl("span", "kj-m", w.meaning));
    if (withRelation && w.relation) row.appendChild(kjEl("span", "kj-tag", w.relation));
    return row;
}

function kjBuildCard(k) {
    const word = kjAsWord(k);
    const key = wordKey(word);
    const isFav = userProfile.favorites.includes(key);
    const isWeak = userProfile.weak.includes(key);

    const card = kjEl("div", "kj-card");
    card.setAttribute("role", "listitem");
    card.classList.toggle("is-weak", isWeak);

    /* 1 · kanji */
    card.appendChild(kjEl("div", "kj-char", k.char));

    /* 2 · meaning + on / kun */
    const read = kjEl("div", "kj-read");
    if (k.meaning) read.appendChild(kjEl("div", "kj-meaning", k.meaning));
    const on = kjEl("div", "kj-line");
    on.append(kjEl("span", "kj-lbl kj-on", "On"), kjEl("span", "", k.onyomi.join("、") || "—"));
    const kun = kjEl("div", "kj-line");
    kun.append(kjEl("span", "kj-lbl kj-kun", "Kun"), kjEl("span", "", k.kunyomi.join("、") || "—"));
    read.append(on, kun);
    card.appendChild(read);

    /* 3 · example words (+ related words, tagged) */
    const ex = kjEl("div", "kj-exs");
    k.examples.forEach(w => ex.appendChild(kjWordRow(w, false)));
    k.related.forEach(w => ex.appendChild(kjWordRow(w, true)));
    card.appendChild(ex);

    /* 4 · speaker + star, the same two buttons the vocab tiles have */
    const act = kjEl("div", "card-actions kj-act");
    const sp = kjEl("button", "action-btn speak-btn", "🔊");
    sp.type = "button"; sp.title = "Listen"; sp.setAttribute("aria-label", `Listen to ${k.char}`);
    sp.addEventListener("click", e => { e.stopPropagation(); speakJapanese(word.hiragana || word.kanji); });
    const st = kjEl("button", "action-btn favorite-btn" + (isFav ? " favorited" : ""), isFav ? "⭐" : "☆");
    st.type = "button"; st.title = "Favorite"; st.setAttribute("aria-label", `Favorite ${k.char}`);
    st.addEventListener("click", e => {
        e.stopPropagation();
        const i = userProfile.favorites.indexOf(key);
        if (i > -1) userProfile.favorites.splice(i, 1); else userProfile.favorites.push(key);
        store.set("jlpt_profile", userProfile);
        const on2 = i === -1;
        st.classList.toggle("favorited", on2);
        st.textContent = on2 ? "⭐" : "☆";
        if (typeof updateDashboard === "function") updateDashboard();
    });
    act.append(sp, st);
    card.appendChild(act);

    /* 5 · stroke count, far right */
    const sc = kjEl("div", "kj-strokes");
    if (k.strokes) { sc.appendChild(kjEl("b", "", String(k.strokes))); sc.appendChild(kjEl("span", "", k.strokes === 1 ? "stroke" : "strokes")); }
    card.appendChild(sc);

    /* right-click (desktop) / long-press (touch): same menu as the vocab tiles */
    card.addEventListener("contextmenu", e => { if (window.showContextMenu) window.showContextMenu(e, word); });
    let press = null;
    card.addEventListener("touchstart", () => {
        press = setTimeout(() => { if (window.showContextMenu) { haptic(40); window.showContextMenu(null, word); } }, 650);
    }, { passive: true });
    ["touchend", "touchmove", "touchcancel"].forEach(t => card.addEventListener(t, () => clearTimeout(press), { passive: true }));
    return card;
}

function renderKanjiList() {
    const list = document.getElementById("kanjiList");
    if (!list) return;
    if (kanjiData.length === 0) { kjMessage("This lesson has no kanji yet."); return; }
    const frag = document.createDocumentFragment();
    kanjiData.forEach(k => frag.appendChild(kjBuildCard(k)));
    list.replaceChildren(frag);
}
window.renderKanjiList = renderKanjiList;

async function loadKanjiLesson(level, num) {
    kanjiLevel = levelKey(level);
    kanjiLessonNum = num;
    const myRequest = ++kanjiRequest;
    renderKanjiChips();

    const url = kanjiUrl(kanjiLevel, num);
    const cacheKey = `${kanjiLevel}:${num}`;
    try {
        let data = kanjiCache[cacheKey];
        if (!data) {
            kjMessage("Loading…");
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            data = normalizeKanjiFile(await res.json(), num);
            kanjiCache[cacheKey] = data;
        }
        if (myRequest !== kanjiRequest) return;      // a newer tap superseded this one
        kanjiData = data.kanji;
        window.kanjiData = kanjiData;
        kjRememberLesson(kanjiLevel, num);
        renderKanjiHeader(data);
        renderKanjiList();
    } catch (e) {
        if (myRequest !== kanjiRequest) return;
        console.warn("[RONIN] Kanji lesson failed:", url, e);
        kanjiData = [];
        window.kanjiData = kanjiData;
        renderKanjiHeader(null);
        const why = e instanceof SyntaxError ? "is not valid JSON" : (/HTTP 404/.test(e.message) ? "was not found" : `could not be read (${e.message})`);
        kjMessage(`Kanji lesson ${num} ${why}.`, `Expected file: ${url}  (the name must match exactly, including capital L and the .json ending)`);
    }
}

/* Opens the kanji section for a level, on the last lesson viewed there. */
function openKanji(level) {
    kanjiLevel = levelKey(level);
    const L = LEVELS[kanjiLevel];
    if (!L.kanji) {
        kanjiLessonNum = 0;
        kanjiData = [];
        window.kanjiData = kanjiData;
        renderKanjiChips();
        renderKanjiHeader(null);
        kjMessage(`No kanji lessons for ${L.label} yet.`);
        return;
    }
    const last = store.get("jlpt_kanjiLast", {})[kanjiLevel];
    loadKanjiLesson(kanjiLevel, isValidKanjiLesson(kanjiLevel, last) ? last : L.kanji.from);
}

function kanjiStrokePractice(char) {
    // This will open handwritingView in Phase E.4
    // showToast("Handwriting practice coming soon!");
    // For now we'll just show the view if it exists.
    if (typeof window.openHandwritingView === "function") {
        window.openHandwritingView(char);
    } else {
        showToast("Handwriting practice coming soon!");
    }
}

// Opened from the nav, or the level changed while the kanji view is showing.
window.kanjiViewOpened = () => openKanji(currentLevel);
window.kanjiLevelChanged = () => openKanji(currentLevel);
window.loadKanjiSet = openKanji;       // old name, kept for any caller still using it




// =========================================================
// SETTINGS APPLICATION
// =========================================================
window._applyThemeMode = function() {
    const tm = store.get("jlpt_settings_themeMode", "system");
    const themeToSet = tm === "system" ? "dark" : tm;
    const currentIsLight = document.body.classList.contains("light-theme");
    const targetIsLight = themeToSet === "light";
    if (currentIsLight !== targetIsLight) {
        toggleTheme(themeToSet);
    }
};

window._applyFontScale = function() {
    const fs = store.get("jlpt_settings_fontScale", 1.0);
    document.documentElement.style.setProperty('--font-scale', fs);
    // Actually apply it to html font size or just body
    document.body.style.zoom = fs;
};

window._applyCardDensity = function() {
    const cd = store.get("jlpt_settings_cardDensity", false);
    if (cd) {
        document.body.classList.add("dense-cards");
    } else {
        document.body.classList.remove("dense-cards");
    }
};

window._applyGamificationVis = function() {
    const show = store.get("jlpt_settings_showGamification", true);
    if (show) {
        document.body.classList.remove("hide-gamification");
    } else {
        document.body.classList.add("hide-gamification");
    }
};

// Apply on load
document.addEventListener("DOMContentLoaded", () => {
    window._applyThemeMode();
    window._applyFontScale();
    window._applyCardDensity();
    window._applyGamificationVis();
    if (store.get("jlpt_settings_reduceMotion", false)) {
        document.body.classList.add("reduce-motion");
    }
});
