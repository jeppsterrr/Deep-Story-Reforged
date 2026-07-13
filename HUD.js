/*
 * HUD.js
 * ---------------------------------------------------------------------------
 * The floating "snapshot" widget. Extracted from index.js and redesigned —
 * the drag/collapse/scale MECHANICS are unchanged (same DOM ids, same
 * clamping math, same event wiring), but renderHUD()'s content and markup
 * are new. The old version stacked up to seven independently-optional
 * sections (clock, location, weather, upcoming events, world pulse,
 * characters, world summary, relationship signal) each with their own icon
 * and inline styles — informative, but it read as a wall of text and wrapped
 * badly (icon + text sat on one inline line with no hanging indent, so a
 * wrapped second line started back at the widget's left edge under the icon
 * instead of under the text).
 *
 * This version:
 *   - Every row is a real flex row (icon in a fixed gutter, text in a
 *     flex:1 column) so wrapped lines indent under the text, never the icon.
 *   - Meta (time/date/location/weather) is one compact block instead of
 *     three separately-styled rows.
 *   - Characters are stacked name-then-state (mirrors the modal's character
 *     cards) instead of "Name: state" inline, which is what was causing the
 *     worst wrapping — a long state description competing with a bold name
 *     label on the same line.
 *   - Only ONE "signal" line is shown at a time (the most time-sensitive of:
 *     an imminent scheduled event, a world pulse, or a relationship shift),
 *     picked by priority, instead of showing all three stacked. The full
 *     detail behind any of them is one tap away in the modal — the HUD's
 *     job is a glance, not a feed.
 * ---------------------------------------------------------------------------
 */

import * as Store from "./Store.js";
import { save, parseRpDateTime, loadStoryData } from "./Persistence.js";

function esc(t) {
    var d = document.createElement("div");
    d.textContent = t == null ? "" : t;
    // innerHTML only escapes & < > — quotes must be escaped too because this
    // helper's output also lands inside HTML *attributes* (title="...", data-
    // name="..."), where an unescaped quote in LLM-authored text breaks out of
    // the attribute (and a crafted one could inject live handlers).
    return d.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// =============================================================================
// BUILD / DRAG / COLLAPSE (mechanics unchanged from the original)
// =============================================================================

export function buildHUD() {
    if (document.getElementById("st-hud")) return;
    var h = '<div id="st-hud" class="st-hud st-hud-collapsed">' +
        '<div class="st-hud-head">' +
        '<i class="fa-solid fa-book-open-reader"></i>' +
        '<span class="st-hud-head-text">Tracker</span>' +
        '<span id="st-hud-status" class="st-hud-head-status"></span>' +
        '<i class="fa-solid fa-chevron-up st-hud-head-chevron"></i>' +
        '</div>' +
        '<div class="st-hud-body" id="st-hud-body"></div>' +
        '</div>';
    document.body.insertAdjacentHTML("beforeend", h);

    $(document).on("click", ".st-hud-head", function () {
        if ($("#st-hud").attr("data-dragging") === "true") return;
        $("#st-hud").toggleClass("st-hud-collapsed");
    });
    $(document).on("click", "#st-hud-body", function () {
        if ($("#st-hud").attr("data-dragging") === "true") return;
        loadStoryData();
        window.renderModal();
        $("#st-modal").fadeIn(150);
    });

    makeHudDraggable(document.getElementById("st-hud"));
    renderHUD();
}

export function applyHudStyle() {
    var $h = $("#st-hud");
    if (!$h.length) return;

    var scale = (Store.settings.hudScale || 100) / 100;
    var origin = "top right";

    if (Store.settings.hudLeft !== null && Store.settings.hudTop !== null) {
        var clamped = clampHudPosition(Store.settings.hudLeft, Store.settings.hudTop);
        $h.css({ left: clamped.x + "px", top: clamped.y + "px", right: "auto", bottom: "auto" });
        var oX = (clamped.x + ($h.outerWidth() || 0) / 2) > window.innerWidth / 2 ? "right" : "left";
        var oY = (clamped.y + ($h.outerHeight() || 0) / 2) > window.innerHeight / 2 ? "bottom" : "top";
        origin = oY + " " + oX;
    } else {
        // No saved position — explicitly set a safe bottom-right default rather than
        // clearing to empty strings. Some browsers (notably Firefox) can render a
        // position:fixed element with no offsets in normal document flow instead of
        // the stylesheet's intended corner, making the HUD invisible/off-screen.
        $h.css({ left: "auto", top: "auto", right: "20px", bottom: "90px" });
    }

    $h.css({ transform: "scale(" + scale + ")", "transform-origin": origin });
}

function getSafeAreaInsets() {
    try {
        var el = document.createElement("div");
        el.style.cssText =
            "position:fixed;top:env(safe-area-inset-top,0px);left:env(safe-area-inset-left,0px);" +
            "width:env(safe-area-inset-right,0px);height:env(safe-area-inset-bottom,0px);" +
            "pointer-events:none;visibility:hidden;z-index:-1;";
        document.body.appendChild(el);
        var rect = el.getBoundingClientRect();
        var s = {
            top: rect.top, left: rect.left,
            right: parseFloat(getComputedStyle(el).width) || 0,
            bottom: parseFloat(getComputedStyle(el).height) || 0,
        };
        document.body.removeChild(el);
        return s;
    } catch (e) {
        return { top: 0, bottom: 0, left: 0, right: 0 };
    }
}

export function clampHudPosition(x, y) {
    var $h = $("#st-hud");
    if (!$h.length) return { x: x, y: y };

    var hudWidth = $h.outerWidth() || 260;
    var hudHeight = $h.outerHeight() || 200;
    var safe = getSafeAreaInsets();
    var margin = 10;
    var minX = Math.max(margin, safe.left + margin);
    var minY = Math.max(margin, safe.top + margin);
    var maxX = window.innerWidth - hudWidth - Math.max(margin, safe.right + margin);
    var maxY = window.innerHeight - hudHeight - Math.max(margin, safe.bottom + margin);

    return { x: Math.max(minX, Math.min(x, maxX)), y: Math.max(minY, Math.min(y, maxY)) };
}

function makeHudDraggable(el) {
    var isDragging = false;
    var startX, startY, initialX, initialY;

    function onDown(e) {
        if (e.target.closest && e.target.closest("button, input, select, textarea, a, .st-hud-body")) return;
        var clientX = e.clientX !== undefined ? e.clientX : (e.touches && e.touches[0] ? e.touches[0].clientX : undefined);
        var clientY = e.clientY !== undefined ? e.clientY : (e.touches && e.touches[0] ? e.touches[0].clientY : undefined);
        if (clientX === undefined) return;

        isDragging = false;
        el.removeAttribute("data-dragging");
        startX = clientX; startY = clientY;
        var rect = el.getBoundingClientRect();
        initialX = rect.left; initialY = rect.top;

        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
        document.addEventListener("touchmove", onMove, { passive: false });
        document.addEventListener("touchend", onUp);
    }

    function onMove(e) {
        var clientX = e.clientX !== undefined ? e.clientX : (e.touches && e.touches[0] ? e.touches[0].clientX : undefined);
        var clientY = e.clientY !== undefined ? e.clientY : (e.touches && e.touches[0] ? e.touches[0].clientY : undefined);
        if (clientX === undefined) return;
        var dx = clientX - startX, dy = clientY - startY;

        if (!isDragging && Math.sqrt(dx * dx + dy * dy) > 5) {
            isDragging = true;
            el.setAttribute("data-dragging", "true");
        }
        if (isDragging) {
            e.preventDefault();
            var clamped = clampHudPosition(initialX + dx, initialY + dy);
            el.style.left = clamped.x + "px";
            el.style.top = clamped.y + "px";
            el.style.right = "auto";
            el.style.bottom = "auto";
        }
    }

    function onUp() {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.removeEventListener("touchmove", onMove);
        document.removeEventListener("touchend", onUp);

        if (isDragging) {
            Store.settings.hudLeft = parseFloat(el.style.left) || 0;
            Store.settings.hudTop = parseFloat(el.style.top) || 0;
            save();
            applyHudStyle();
        }
        setTimeout(function () { isDragging = false; el.removeAttribute("data-dragging"); }, 50);
    }

    el.addEventListener("mousedown", onDown);
    el.addEventListener("touchstart", onDown, { passive: true });

    window.addEventListener("resize", function () {
        if (Store.settings.hudLeft === null || Store.settings.hudTop === null) return;
        var clamped = clampHudPosition(Store.settings.hudLeft, Store.settings.hudTop);
        if (clamped.x !== Store.settings.hudLeft || clamped.y !== Store.settings.hudTop) {
            Store.settings.hudLeft = clamped.x;
            Store.settings.hudTop = clamped.y;
            el.style.left = clamped.x + "px";
            el.style.top = clamped.y + "px";
            save();
        }
    });
}

export function setHudStatus() {
    $("#st-hud .fa-book-open-reader").removeClass("fa-book-open-reader").addClass("fa-spinner fa-spin st-hud-was-book");
    $("#st-hud-status").hide();
    $("#st-hud").addClass("st-hud-busy");
}

export function clearHudStatus() {
    $("#st-hud .fa-spinner.st-hud-was-book").removeClass("fa-spinner fa-spin st-hud-was-book").addClass("fa-book-open-reader");
    $("#st-hud-status").hide().html("");
    $("#st-hud").removeClass("st-hud-busy");
}

// =============================================================================
// TIME-OF-DAY AMBIANCE — the HUD's background carries a subtle tint that
// tracks the RP clock: cool navy at night, violet pre-dawn, warm gold through
// the day, ember at sunset. Applied as a CSS variable (--st-hud-tint) that
// style.css layers as a gradient over the normal HUD background, so it reads
// as atmosphere, not a repaint — and it doubles as an at-a-glance clock.
// =============================================================================

// Keyframes across the 24h day: [hour, [r,g,b], alpha]. Linearly interpolated,
// wrapping midnight (the h:24 entry mirrors h:0).
var TINT_KEYFRAMES = [
    [0,    [24, 34, 78],    0.34], // deep night
    [4,    [30, 44, 96],    0.32], // late night
    [5.5,  [96, 92, 160],   0.26], // pre-dawn violet
    [7,    [255, 148, 88],  0.22], // sunrise
    [9.5,  [255, 214, 140], 0.13], // morning gold
    [13,   [255, 248, 224], 0.07], // midday — near-neutral
    [16.5, [255, 198, 120], 0.14], // late afternoon
    [19,   [255, 118, 68],  0.24], // sunset ember
    [20.5, [108, 78, 148],  0.27], // dusk violet
    [22,   [34, 44, 96],    0.31], // night falls
    [24,   [24, 34, 78],    0.34], // wraps to 00:00
];

/** "HH:MM" -> "rgba(r,g,b,a)" tint for that moment, or null if unparseable. */
export function computeTimeTint(timeStr) {
    var parts = String(timeStr || "").split(":");
    var hour = parseInt(parts[0], 10);
    var minute = parseInt(parts[1], 10);
    if (isNaN(hour) || isNaN(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    var t = hour + minute / 60;

    for (var i = 0; i < TINT_KEYFRAMES.length - 1; i++) {
        var a = TINT_KEYFRAMES[i], b = TINT_KEYFRAMES[i + 1];
        if (t >= a[0] && t <= b[0]) {
            var span = b[0] - a[0] || 1;
            var f = (t - a[0]) / span;
            var r = Math.round(a[1][0] + (b[1][0] - a[1][0]) * f);
            var g = Math.round(a[1][1] + (b[1][1] - a[1][1]) * f);
            var bl = Math.round(a[1][2] + (b[1][2] - a[1][2]) * f);
            var alpha = a[2] + (b[2] - a[2]) * f;
            return "rgba(" + r + ", " + g + ", " + bl + ", " + alpha.toFixed(3) + ")";
        }
    }
    return null;
}

function applyHudTimeAmbiance() {
    var el = document.getElementById("st-hud");
    if (!el) return;
    var enabled = Store.settings.hudTimeTint !== false;
    var tint = (enabled && Store.storyData && Store.storyData._initialized)
        ? computeTimeTint(Store.storyData.time)
        : null;
    if (tint) el.style.setProperty("--st-hud-tint", tint);
    else el.style.removeProperty("--st-hud-tint");
}

// =============================================================================
// CONTENT (redesigned)
// =============================================================================

var WEATHER_ICONS = [
    [/rain|дожд/, "fa-cloud-rain"],
    [/snow|снег/, "fa-snowflake"],
    [/storm|гроз/, "fa-bolt"],
    [/fog|туман/, "fa-smog"],
    [/clear|ясн|солн/, "fa-sun"],
    [/cloud|облач/, "fa-cloud"],
];
function weatherIconFor(text) {
    var w = (text || "").toLowerCase();
    for (var i = 0; i < WEATHER_ICONS.length; i++) {
        if (WEATHER_ICONS[i][0].test(w)) return WEATHER_ICONS[i][1];
    }
    return "fa-cloud-sun";
}

/** One flex row: icon in a fixed gutter, text taking the rest of the width so a
 * wrap indents under the text rather than back under the icon. */
function metaRow(icon, html, extraClass) {
    return '<div class="st-hud-meta-row' + (extraClass ? " " + extraClass : "") + '">' +
        '<i class="fa-solid ' + icon + '"></i><span class="st-hud-meta-text">' + html + "</span></div>";
}

/** Picks the single most relevant "what's worth knowing right now" line, in
 * priority order: an imminent scheduled event > a world pulse > the most-shifted
 * relationship. Only one is ever shown — see the file header for why. */
function pickSignal() {
    var storyData = Store.storyData, worldData = Store.worldData, settings = Store.settings;

    if (Store.EventQueue && worldData && worldData._eventQueue) {
        var nowObj = parseRpDateTime(storyData.time, storyData.date);
        var upcoming = Store.EventQueue.getUpcoming(worldData._eventQueue, storyData.time, storyData.date, 2880)
            .map(function (ev) {
                var dueObj = parseRpDateTime(ev.executeTime, ev.executeDate);
                var minsUntil = (nowObj && dueObj) ? Math.round((dueObj.getTime() - nowObj.getTime()) / 60000) : null;
                return { ev: ev, minsUntil: minsUntil };
            })
            .filter(function (u) { return u.minsUntil != null; })
            .sort(function (a, b) { return a.minsUntil - b.minsUntil; });
        if (upcoming.length > 0) {
            var u = upcoming[0];
            var etaStr = u.minsUntil <= 0 ? "any moment now"
                : u.minsUntil < 60 ? "~" + u.minsUntil + "min"
                : "~" + (u.minsUntil / 60).toFixed(u.minsUntil % 60 === 0 ? 0 : 1) + "h";
            return {
                icon: "fa-hourglass-half",
                html: esc(u.ev.action) + ' <span class="st-hud-signal-meta">(' + etaStr + ")</span>",
                title: u.ev.action,
            };
        }
    }

    if (settings.worldEnabled && Store.WorldAgent && worldData && worldData.worldEvents && worldData.worldEvents.length > 0) {
        var pulseCtx = { onscreenNames: (storyData.characters || []).map(function (c) { return c.name; }), currentLocation: storyData.location };
        // Deterministic pick of the single highest-scoring world event — NO
        // "exclude what was shown last time" rotation. renderHUD() runs on every
        // cosmetic redraw (tint toggle, drag, resize, showHUD toggle), so any
        // state mutation here made the displayed signal flip-flop between events
        // on actions that changed no story data at all. The most-relevant line
        // SHOULD persist across redraws; it now only changes when worldEvents do.
        var pulse = Store.WorldAgent.selectWorldPulse(worldData.worldEvents, pulseCtx);
        if (pulse) {
            return { icon: "fa-globe", html: '<span class="st-hud-signal-italic">' + esc(pulse.text) + "</span>", title: "World pulse" };
        }
    }

    if (settings.relationsEnabled && Store.relationshipData && Store.relationshipData._initialized &&
        Store.relationshipData.edges && Store.relationshipData.edges.length > 0) {
        var mostChanged = null, biggestDelta = 0;
        Store.relationshipData.edges.forEach(function (edge) {
            if (edge.history && edge.history.length > 0) {
                var delta = Math.abs((edge.strength || 0) - (edge.history[0].strength || 0));
                if (delta > biggestDelta) { biggestDelta = delta; mostChanged = edge; }
            }
        });
        if (mostChanged) {
            // hasReciprocalEdge === true means the pair is stored as TWO asymmetric
            // edges (rule 4b), so THIS edge is one-sided -> "\u2192"; a lone edge is the
            // mutual case -> "\u2194". This was inverted here relative to everywhere else
            // (Pipeline's injection, the graph detail panel, the edit panel).
            var isAsymmetric = Store.RelationshipAgent && Store.RelationshipAgent.hasReciprocalEdge(Store.relationshipData.edges, mostChanged.from, mostChanged.to);
            var arrow = ((mostChanged.strength || 0) > (mostChanged.history[0].strength || 0)) ? "\u2197" : "\u2198";
            return {
                icon: "fa-share-nodes",
                html: esc(mostChanged.from) + (isAsymmetric ? " \u2192 " : " \u2194 ") + esc(mostChanged.to) +
                    ' <span class="st-hud-signal-meta">' + arrow + " " + esc(mostChanged.type) + "</span>",
                title: "Relationship shift",
            };
        }
    }

    return null;
}

export function renderHUD() {
    $("#st-hud").toggle(Store.settings.showHUD);
    applyHudStyle();
    applyHudTimeAmbiance();

    if (!Store.isChatOpen() || !Store.storyData || !Store.storyData._initialized) {
        $("#st-hud-body").html('<div class="st-hud-waiting">Waiting for the story to begin…</div>');
        return;
    }

    var storyData = Store.storyData, settings = Store.settings;
    var dow = window.getDayOfWeek ? window.getDayOfWeek(storyData.date) : null;

    var h = '<div class="st-hud-meta">';
    h += metaRow("fa-clock", "<strong>" + esc(storyData.time) + "</strong> &middot; " + (dow ? esc(dow) + ", " : "") + esc(storyData.date));
    h += metaRow("fa-location-dot", esc(storyData.location));
    if (settings.showCityCountry) {
        var city = storyData.city || "", country = storyData.country || "";
        var ccText = [city, country].filter(function (v) { return v && v !== "Unknown"; }).join(", ");
        if (ccText) h += metaRow("fa-earth-europe", esc(ccText));
    }
    if ((storyData.temperature && storyData.temperature !== "Unknown") || (storyData.weather && storyData.weather !== "Unknown")) {
        var tempStr = storyData.temperature && storyData.temperature !== "Unknown" ? esc(storyData.temperature) : "";
        var weatherStr = storyData.weather && storyData.weather !== "Unknown" ? esc(storyData.weather) : "";
        var sep = tempStr && weatherStr ? " &middot; " : "";
        h += metaRow(weatherIconFor(storyData.weather), tempStr + sep + weatherStr);
    }
    h += "</div>";

    var outfit = window.getInventoryOutfit ? window.getInventoryOutfit() : null;
    var userName = (Store.scriptModule && Store.scriptModule.name1) ? Store.scriptModule.name1 : null;

    if (storyData.characters && storyData.characters.length > 0) {
        // Every character is rendered — no more hard cap at 3 with a "+N more" stub.
        // The list itself scrolls (see .st-hud-chars in style.css: max-height +
        // overflow-y auto) so a crowded scene grows into a scrollable panel instead
        // of either hiding people or stretching the HUD down the screen.
        h += '<div class="st-hud-divider"></div><div class="st-hud-chars">';
        storyData.characters.forEach(function (c) {
            var stateText = c.state;
            var isUser = (userName && c.name.toLowerCase() === userName.toLowerCase()) || c.name.toLowerCase() === "\u0432\u044b" || c.name === "{{user}}";
            if (outfit && isUser && outfit.userEquipped.length > 0) {
                stateText += ", wearing " + outfit.userEquipped.map(function (it) { return it.name; }).join(", ");
            }
            if (outfit && outfit.charItems.length > 0) {
                var held = outfit.charItems.filter(function (ci) { return ci.heldBy && ci.heldBy.toLowerCase() === c.name.toLowerCase(); });
                if (held.length > 0) stateText += ", holding " + held.map(function (ci) { return ci.name; }).join(", ");
            }
            h += '<div class="st-hud-char-row"><div class="st-hud-char-name">' + esc(c.name) + '</div>' +
                '<div class="st-hud-char-state">' + esc(stateText) + "</div></div>";
        });
        h += "</div>";
    }

    var signal = pickSignal();
    if (signal) {
        h += '<div class="st-hud-divider"></div>';
        h += '<div class="st-hud-signal" title="' + esc(signal.title || "") + '">' +
            '<i class="fa-solid ' + signal.icon + '"></i><span class="st-hud-signal-text">' + signal.html + "</span></div>";
    }

    $("#st-hud-body").html(h);
}
