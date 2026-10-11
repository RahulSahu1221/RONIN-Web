/* theme-shutter.js
   ═══════════════════════════════════════════════════════════════════════════
   RONIN WEB — Japanese shop-shutter theme transition.
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";

const SHUTTER_DURATION_MS = 600; // was 175 — 175ms read as too fast/twitchy; 600ms gives the sweep time to actually register
const SHUTTER_EASING = "cubic-bezier(0.22, 0.61, 0.36, 1)"; // slight accelerate, settle — no overshoot
const SHUTTER_BLUR_PEAK_PX = 7; // how blurry the screen gets at the midpoint of the sweep — tune this one number to make the blur stronger/weaker

function shutterSupported() {
    return typeof document.startViewTransition === "function";
}

/* View Transitions animate a rasterized snapshot of the page. If the
   viewport resizes while that snapshot is still on screen — which
   happens on mobile just from scrolling (the URL bar collapsing fires
   a resize event) — the browser can be left holding a stretched,
   blurred snapshot instead of properly finishing. Below 769px we skip
   the shutter effect entirely and fall back to an instant swap: the
   safest fix for a class of bug, not a patch for one symptom of it. */
function viewportTooUnstableForTransition() {
    return window.innerWidth <= 768;
}

function prefersReducedMotion() {
    try {
        if (typeof store !== "undefined" && store.get("jlpt_settings_reduceMotion", false)) return true;
    } catch (_) { /* store not ready yet */ }
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/* Safety net #1: if a transition is still in flight when the viewport
   resizes, force it to finish immediately instead of leaving a stale
   snapshot behind. skipTransition() is the browser's own mechanism for
   this — it snaps straight to the end state and tears down the
   pseudo-elements cleanly. */
let _activeTransition = null;
window.addEventListener("resize", () => {
    if (_activeTransition) {
        try { _activeTransition.skipTransition(); } catch (_) { /* already done */ }
    }
}, { passive: true });

/**
 * Runs `applyThemeFn` (which flips the theme class + swaps labels/meta color)
 * behind a top-to-bottom shutter sweep. Falls back to an instant, flash-free
 * swap on browsers without View Transitions support, when the user has
 * asked for reduced motion, or on narrow/mobile viewports where the
 * transition's snapshot-based rendering is fragile (see above).
 */
async function runShutterTransition(applyThemeFn) {
    if (prefersReducedMotion() || !shutterSupported() || viewportTooUnstableForTransition()) {
        applyThemeFn();
        return;
    }

    let transition;
    try {
        transition = document.startViewTransition(() => applyThemeFn());
        _activeTransition = transition;
    } catch (_) {
        applyThemeFn();
        return;
    }

    try {
        await transition.ready;
    } catch (_) {
        _activeTransition = null;
        return; // transition was skipped (e.g. tab hidden) — theme already applied
    }

    const edge = document.createElement("div");
    edge.className = "shutter-edge";
    document.body.appendChild(edge);
    const viewportH = window.innerHeight;

    const clipAnim = document.documentElement.animate(
        [
            { clipPath: "inset(0 0 100% 0)", filter: "blur(0px)" },
            { clipPath: "inset(0 0 40% 0)",  filter: `blur(${SHUTTER_BLUR_PEAK_PX}px)`, offset: 0.5 },
            { clipPath: "inset(0 0 0% 0)",   filter: "blur(0px)" }
        ],
        {
            duration: SHUTTER_DURATION_MS,
            easing: SHUTTER_EASING,
            pseudoElement: "::view-transition-new(root)",
            fill: "forwards" // hold the fully-revealed, fully-sharp state — without this, the
                              // moment the animation ends the browser snaps clip-path back to
                              // the base CSS rule (fully hidden), which is exactly what caused
                              // the old-theme blink right after the sweep finished.
        }
    );

    // The old theme blurs in step with the new one, so the whole screen briefly
    // softens as the shutter passes over it rather than only the incoming layer.
    const oldBlurAnim = document.documentElement.animate(
        [
            { filter: "blur(0px)" },
            { filter: `blur(${SHUTTER_BLUR_PEAK_PX}px)`, offset: 0.5 },
            { filter: "blur(0px)" }
        ],
        {
            duration: SHUTTER_DURATION_MS,
            easing: SHUTTER_EASING,
            pseudoElement: "::view-transition-old(root)",
            fill: "forwards"
        }
    );

    const edgeAnim = edge.animate(
        [
            { transform: "translateY(-26px)" },
            { transform: `translateY(${viewportH}px)` }
        ],
        {
            duration: SHUTTER_DURATION_MS,
            easing: SHUTTER_EASING,
            fill: "forwards" // same reasoning — keep the edge bar at its end position
                              // instead of snapping back to translateY(-26px)
        }
    );

    try {
        await Promise.all([clipAnim.finished, oldBlurAnim.finished, edgeAnim.finished]);
    } catch (_) { /* interrupted by a rapid second toggle — fine, just clean up */ }

    edge.remove();
    try { await transition.finished; } catch (_) { /* no-op */ }
    _activeTransition = null;
}

window.runShutterTransition = runShutterTransition;