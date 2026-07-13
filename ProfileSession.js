/*
 * ProfileSession.js
 * ---------------------------------------------------------------------------
 * Connection-profile switching for the three trackers (Scene, World,
 * Relationship), extracted verbatim from index.js. See the original file's
 * "Cross-tracker connection profile session" comment (preserved below) for
 * why this exists as a shared session rather than each tracker independently
 * switching and restoring.
 * ---------------------------------------------------------------------------
 */

import * as Store from "./Store.js";
import { save } from "./Persistence.js";

export function getProfileList() {
    try {
        var cm = Store.extSettings && Store.extSettings.connectionManager;
        if (!cm || !Array.isArray(cm.profiles)) return [];
        return cm.profiles;
    } catch (e) { return []; }
}

export function getCurrentProfileName() {
    try {
        var cm = Store.extSettings && Store.extSettings.connectionManager;
        if (!cm) return "";
        var sel = cm.selectedProfile;
        if (!sel) return "";
        var found = (cm.profiles || []).find(function (p) { return p.id === sel; });
        return found ? (found.name || "") : "";
    } catch (e) { return ""; }
}

// Confirms a profile name actually exists before we try to switch to it.
// Switching to a name ConnectionManager doesn't recognize sends a slash
// command that fails to resolve a target element/profile, which can leave
// the active connection in a broken state for the generation call that follows.
export function profileExists(name) {
    if (!name) return false;
    return getProfileList().some(function (p) { return p.name === name; });
}

export async function switchProfile(name) {
    if (!Store.runSlash || !name) return false;
    if (!profileExists(name)) {
        console.warn("[Story Tracker] Connection profile '" + name + "' was not found in the profile list; skipping switch and using the currently active profile instead.");
        return false;
    }
    var t0 = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
    try {
        await Store.runSlash('/profile "' + String(name).replace(/"/g, '\\"') + '"');
        // Poll for the switch to actually take effect instead of trusting a fixed delay —
        // different profile pairs (e.g. different API sources) can take very different
        // amounts of time to fully activate, and a fixed 150ms undershoots on some.
        var attempts = 0;
        while (getCurrentProfileName() !== name && attempts < 20) {
            await new Promise(function (r) { setTimeout(r, 100); });
            attempts++;
        }
        var elapsed = Math.round(((typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now()) - t0);
        var finalProfile = getCurrentProfileName();
        if (finalProfile !== name) {
            console.warn("[Story Tracker] Profile switch to '" + name + "' did not confirm after " + elapsed + "ms (" + attempts + " poll attempts). Current profile is still '" + finalProfile + "'. Proceeding anyway.");
        } else {
            console.log("[Story Tracker] Profile switch to '" + name + "' confirmed after " + elapsed + "ms (" + attempts + " poll attempts).");
        }
        return true;
    } catch (e) {
        console.warn("[Story Tracker] Failed to switch to profile '" + name + "':", e);
        return false;
    }
}

// --- Cross-tracker connection profile session ---
// PROBLEM this replaces: each tracker (Scene, World, Relationship) used to independently
// switch to ITS OWN target profile, run its call(s), then immediately switch back to
// whatever was active before it. When more than one tracker fires for the same message
// (e.g. Scene fires, then a World tier batch, then Relationship), that meant switching
// away and back multiple times per message even when several trackers share the same
// target profile — pure overhead, and on a slow/rate-limited backend the extra /profile
// round trips (each with a 150ms settle delay, see switchProfile) add up for no benefit.
// It also meant Scene Agent's OWN two calls (main analysis + optional city/country
// fallback, see Pipeline.js's doLLMUpdate) each independently switched/restored, even
// back-to-back.
//
// FIX: a single shared "session" object spans an entire tracker pipeline run (one message's
// worth of Scene + World + Relationship, or one manual button's worth of work — see the
// entry points in Pipeline.js that open one). The session remembers the TRUE original
// profile once, and which target is currently active; each tracker's with*ConnectionProfile
// call below just asks the session to point at ITS target, which is a no-op if that's
// already the active one. The real ST-wide profile only gets switched when the target
// actually changes, and only restored to the true original ONCE, when the whole pipeline
// finishes — not once per tracker.

export async function runTrackerProfileSession(task) {
    if (Store.trackerProfileSession) return await task(); // nested — already inside an open session
    var original = getCurrentProfileName();
    Store.setTrackerProfileSession({ original: original, current: original });
    try {
        return await task();
    } finally {
        var session = Store.trackerProfileSession;
        Store.setTrackerProfileSession(null);
        if (session.current !== session.original && session.original) {
            await switchProfile(session.original);
        }
        if (Store.settings._restoreTrackerProfile) { Store.settings._restoreTrackerProfile = ""; save(); }
    }
}

// Shared implementation behind withConnectionProfile / withWorldConnectionProfile /
// withRelConnectionProfile below — same enabled/target/profile-exists checks either way,
// the only difference between the three is which settings fields and which log label
// they use, so that's parameterized rather than tripled.
export async function withTrackerProfile(enabled, targetRaw, label, task) {
    if (!enabled || !Store.runSlash) return await task();
    var target = (targetRaw || "").trim();
    if (!target || getProfileList().length === 0) return await task();

    if (Store.trackerProfileSession) {
        // Part of an open pipeline session — just point the session at this tracker's
        // target if it isn't already there. Deliberately does NOT restore in a finally
        // here; runTrackerProfileSession restores the true original exactly once, after
        // every tracker that runs in this pipeline has had its turn.
        if (Store.trackerProfileSession.current !== target) {
            var switched = await switchProfile(target);
            if (switched) {
                Store.trackerProfileSession.current = target;
                // Crash-safety: if the page reloads before the session closes and restores,
                // recoverProfileIfNeeded() uses this on next load to put the original back —
                // only needs setting once per session, the first time it actually diverges.
                if (!Store.settings._restoreTrackerProfile && Store.trackerProfileSession.original) {
                    Store.settings._restoreTrackerProfile = Store.trackerProfileSession.original;
                    save();
                }
            } else {
                console.warn("[Story Tracker] " + label + " switch failed; running on current profile.");
            }
        }
        return await task();
    }

    // No open session (shouldn't normally happen now that every entry point opens one —
    // kept as a safety net for any future/overlooked call site). Switch and restore locally,
    // same behavior the old per-tracker wrappers had.
    var original = getCurrentProfileName();
    if (original === target) return await task();
    var switchedStandalone = false;
    try {
        switchedStandalone = await switchProfile(target);
        if (!switchedStandalone) console.warn("[Story Tracker] " + label + " switch failed; running on current profile.");
        if (switchedStandalone && original) {
            Store.settings._restoreTrackerProfile = original;
            save();
        }
        return await task();
    } finally {
        if (switchedStandalone && original) {
            await switchProfile(original);
        }
        if (Store.settings._restoreTrackerProfile) { Store.settings._restoreTrackerProfile = ""; save(); }
    }
}

export async function withConnectionProfile(task) {
    return await withTrackerProfile(Store.settings.useConnectionProfile, Store.settings.connectionProfile, "Connection Profile", task);
}

export async function withWorldConnectionProfile(task) {
    return await withTrackerProfile(Store.settings.useWorldProfile, Store.settings.worldConnectionProfile, "World Connection Profile", task);
}

export async function withRelConnectionProfile(task) {
    return await withTrackerProfile(Store.settings.useRelProfile, Store.settings.relConnectionProfile, "Relationship Connection Profile", task);
}

export async function recoverProfileIfNeeded() {
    var settings = Store.settings;
    var pendingTracker = settings._restoreTrackerProfile;
    if (pendingTracker && Store.runSlash) {
        try {
            var currentTracker = getCurrentProfileName();
            if (currentTracker !== pendingTracker && getProfileList().some(function (p) { return p.name === pendingTracker; })) {
                console.log("[Story Tracker] Recovering interrupted tracker profile session -> restoring '" + pendingTracker + "'.");
                await switchProfile(pendingTracker);
            }
        } catch (e) {
            console.warn("[Story Tracker] Tracker profile recovery failed:", e);
        } finally {
            settings._restoreTrackerProfile = ""; save();
        }
    }

    // Legacy per-tracker markers from before the unified session (previous extension
    // version) — handled here too so anyone updating mid-interrupted-switch still recovers
    // cleanly instead of being left on the wrong profile with no code left that clears it.
    var pending = settings._restoreProfile;
    if (pending && Store.runSlash) {
        try {
            var current = getCurrentProfileName();
            if (current !== pending && getProfileList().some(function (p) { return p.name === pending; })) {
                console.log("[Story Tracker] Recovering interrupted profile switch -> restoring '" + pending + "'.");
                await switchProfile(pending);
            }
        } catch (e) {
            console.warn("[Story Tracker] Profile recovery failed:", e);
        } finally {
            settings._restoreProfile = ""; save();
        }
    }

    var pendingRel = settings._restoreRelProfile;
    if (pendingRel && Store.runSlash) {
        try {
            await switchProfile(pendingRel);
        } catch (e) { console.warn("[Story Tracker] Relationship profile recovery failed:", e); }
        settings._restoreRelProfile = ""; save();
    }

    var pendingWorld = settings._restoreWorldProfile;
    if (pendingWorld && Store.runSlash) {
        try {
            var currentWorld = getCurrentProfileName();
            if (currentWorld !== pendingWorld && getProfileList().some(function (p) { return p.name === pendingWorld; })) {
                console.log("[Story Tracker] Recovering interrupted world profile switch -> restoring '" + pendingWorld + "'.");
                await switchProfile(pendingWorld);
            }
        } catch (e) {
            console.warn("[Story Tracker] World profile recovery failed:", e);
        } finally {
            settings._restoreWorldProfile = ""; save();
        }
    }
}
