/*
 * WorldAgent.js
 * ---------------------------------------------------------------------------
 * Phase 4 of the Timeline Engine rewrite.
 *
 * The old monolithic World Agent (one call producing summary + events +
 * npc_updates + pending_reveals together, every tick) is now split into 4
 * independent, narrower LLM calls — one per Scheduler tier:
 *
 *   npc     (fast,   ~30min default): what tracked NPCs are doing offscreen
 *   weather (medium, ~2h default):    broader REGIONAL weather/climate trend
 *                                     — NOT the immediate on-scene weather,
 *                                     which SceneAgent already covers every
 *                                     ~5min. No overlap in scope.
 *   faction (slow,   ~6h default):    offscreen plot/faction-level events
 *                                     + pending reveals
 *   world   (daily):                  the rolling world summary synthesis
 *
 * TIME-BLINDNESS, same enforcement pattern as SceneAgent.js: JS supplies the
 * tick's fixed timestamp(s) via Scheduler.computeTickTimestamps(); no tier's
 * schema has a free-text "time"/"date" field for the model to fill in.
 *
 * The one place multiple timestamps genuinely matter — faction-tier BATCH
 * catchup, where several offscreen events span several intervals — uses an
 * `interval_index` INTEGER the model tags each event with, referencing a
 * JS-provided numbered list. JS maps that index to the exact precomputed
 * timestamp and clamps anything out of range. This is strictly stronger
 * than the old prompt's "STRICT TIME VALIDATION" instruction, which asked
 * the model to write a well-formed HH:MM string correctly — a request, not
 * a guarantee. An integer index into a fixed list cannot be malformed.
 *
 * Pure module: prompt building + response validation only. No LLM calls,
 * no side effects, no ST dependency. All array-returning functions are
 * non-mutating (same convention as EventQueue.js).
 * ---------------------------------------------------------------------------
 */

import { formatTimeForPrompt } from "./TimelineEngine.js";

// =============================================================================
// SHARED UTILITIES (ported from the pre-rewrite index.js, made pure/testable)
// =============================================================================

/** Jaccard token-similarity, unchanged from the original implementation. */
export function getEventSimilarity(str1, str2) {
    if (!str1 || !str2) return 0;
    function tokenize(str) {
        return str.toLowerCase().split(/[\s,.:;!?()"'-]+/).filter(function (w) { return w.length > 1; });
    }
    var set1 = new Set(tokenize(str1));
    var set2 = new Set(tokenize(str2));
    if (set1.size === 0 || set2.size === 0) return 0;
    var intersection = new Set(Array.from(set1).filter(function (x) { return set2.has(x); }));
    var union = new Set(Array.from(set1).concat(Array.from(set2)));
    return intersection.size / union.size;
}

/** True if newEventText is >70% similar to any existing event's text. */
export function isDuplicateEvent(existingEvents, newEventText) {
    if (!existingEvents || existingEvents.length === 0) return false;
    return existingEvents.some(function (e) {
        return getEventSimilarity(newEventText, e.event) > 0.7;
    });
}

/**
 * Same importance-tiered trim as the original trimWorldEvents(), but pure —
 * returns a NEW array capped at maxCount instead of mutating in place.
 * Pass 1: drop oldest low-importance (<=3) events first.
 * Pass 2: drop oldest moderate-importance (<7) events next.
 * Fallback: drop oldest regardless of importance.
 *
 * PINNING: an event with `pinned: true` is never a removal candidate at ANY pass —
 * it's skipped entirely while hunting for something to drop. This is an intentional
 * escape hatch from maxCount: if the caller pins more events than maxCount allows,
 * the array is allowed to sit above maxCount rather than forcibly evicting a
 * plot-critical event to make room. That tradeoff is the whole point of pinning, so
 * it's surfaced here as a real behavior, not silently overridden.
 */
export function trimWorldEvents(events, maxCount) {
    maxCount = maxCount || 15;
    var arr = (events || []).slice();

    while (arr.length > maxCount) {
        var idx = -1;
        for (var i = arr.length - 1; i >= 0; i--) {
            if (!arr[i].pinned && arr[i].importance <= 3) { idx = i; break; }
        }
        if (idx === -1) {
            for (var j = arr.length - 1; j >= 0; j--) {
                if (!arr[j].pinned && arr[j].importance < 7) { idx = j; break; }
            }
        }
        if (idx === -1) {
            // Hard fallback: oldest UNPINNED event regardless of importance.
            for (var k = arr.length - 1; k >= 0; k--) {
                if (!arr[k].pinned) { idx = k; break; }
            }
        }
        if (idx === -1) break; // everything left is pinned — stop even if still over maxCount

        arr.splice(idx, 1);
    }
    return arr;
}

/**
 * togglePinned(events, index)
 *
 * Flips the `pinned` flag on the event at `index`. Pinned events are exempt from
 * trimWorldEvents' pruning above — this is how the UI marks a plot-critical event as
 * "never auto-remove this". Index-based rather than id-based since world events don't
 * carry a stable id (same convention the UI already uses for deleting a scene-history
 * entry by array position). Out-of-range index is a no-op; returns the same array
 * reference in that case, a NEW array otherwise (same non-mutating contract as the
 * rest of this module).
 */
export function togglePinned(events, index) {
    events = events || [];
    if (index < 0 || index >= events.length) return events;
    var next = events.slice();
    next[index] = Object.assign({}, next[index], { pinned: !next[index].pinned });
    return next;
}

/**
 * Dedups newEvents against existingEvents, prepends the survivors, then
 * trims to maxCount. This is the single call site index.js should use after
 * any tier produces new events — replaces the old scattered
 * unshift+isDuplicateEvent+trimWorldEvents sequence with one pure function.
 */
export function mergeWorldEvents(existingEvents, newEvents, maxCount) {
    existingEvents = existingEvents || [];
    newEvents = newEvents || [];
    var accepted = [];
    newEvents.forEach(function (e) {
        if (!isDuplicateEvent(existingEvents.concat(accepted), e.event)) {
            accepted.push(e);
        }
    });
    return trimWorldEvents(accepted.concat(existingEvents), maxCount);
}

/** Same 1200-char cap/tail-trim logic already applied in index.js. */
export function capWorldSummary(text, maxChars) {
    maxChars = maxChars || 1200;
    if (!text || typeof text !== "string") return text;
    if (text.length <= maxChars) return text;
    var truncated = text.slice(text.length - maxChars);
    var firstBreak = truncated.search(/[.!?]\s+/);
    if (firstBreak > -1 && firstBreak < maxChars * 0.4) {
        truncated = truncated.slice(firstBreak + 1).trim();
    } else {
        var firstSpace = truncated.indexOf(" ");
        if (firstSpace > -1 && firstSpace < 40) {
            truncated = truncated.slice(firstSpace + 1);
        }
    }
    return "(earlier history truncated) " + truncated.trim();
}

/**
 * capWorldSnapshot(text, maxChars)
 *
 * Defensive length guardrail for the world summary now that buildWorldTickPrompt
 * asks for a short, self-contained 2-3 sentence SNAPSHOT each tick rather than a
 * rolling log the model appends to. capWorldSummary's tail-keep + "(earlier
 * history truncated)" framing was built for that older rolling-log shape, where
 * the newest text is at the end and older material is being pushed off the
 * front — applying that same logic to a short snapshot produces a confusing
 * result (a 2-3 sentence answer that starts mid-clause and claims "earlier
 * history" was truncated, when there was no history to truncate, just an
 * over-length single answer).
 *
 * This instead trims from the END, keeping the OPENING intact (a snapshot's
 * first clause is where the main point lives — see rule 4 in
 * buildWorldTickPrompt), and drops the misleading prefix entirely. Same
 * head-trim posture as capNpcGoal/capEventText elsewhere in this file.
 */
export function capWorldSnapshot(text, maxChars) {
    maxChars = maxChars || 500;
    if (!text || typeof text !== "string") return text;
    var trimmed = text.trim();
    if (trimmed.length <= maxChars) return trimmed;
    var head = trimmed.slice(0, maxChars);
    var lastBreak = head.search(/[.!?](?!.*[.!?])/); // last sentence-ending punctuation in head
    if (lastBreak > -1 && lastBreak > maxChars * 0.4) {
        return head.slice(0, lastBreak + 1).trim();
    }
    var lastSpace = head.lastIndexOf(" ");
    if (lastSpace > maxChars * 0.5) head = head.slice(0, lastSpace);
    return head.trim() + "…";
}

/**
 * capNpcGoal(text, maxChars)
 * Same defensive-length posture as capWorldSummary/capRelationshipSummary,
 * but trims from the END (keep the start) rather than the front — a goal
 * is a short forward-looking target statement, the opening clause is the
 * part that actually says what it IS ("saving up for passage north..."),
 * not a running log where the newest tail matters most.
 */
export function capNpcGoal(text, maxChars) {
    maxChars = maxChars || 140;
    if (!text || typeof text !== "string") return text;
    var trimmed = text.trim();
    if (trimmed.length <= maxChars) return trimmed;
    var head = trimmed.slice(0, maxChars);
    var lastSpace = head.lastIndexOf(" ");
    if (lastSpace > maxChars * 0.5) head = head.slice(0, lastSpace);
    return head.trim() + "…";
}

/**
 * capEventText(text, maxChars)
 *
 * Defensive length guardrail for a World Event's headline text (faction
 * tier's "event"/"resolution" fields, and the NPC tier's "resolution" —
 * both feed the same worldData.worldEvents list the HUD's "World Events"
 * section renders one-per-line). The prompt now asks for a short, glanceable
 * sentence up front (see buildFactionTickPrompt rule 1 / schemaEventLine),
 * but nothing stops a model from ignoring that and writing a paragraph
 * anyway — same belt-and-suspenders reasoning as capWorldSummary/
 * capRelationshipSummary elsewhere in this file. Same head-trim posture as
 * capNpcGoal (keep the start, cut the tail): an event headline's opening
 * clause is the part that actually says what happened ("A messenger departs
 * the capital..."), trailing clauses are the part safe to lose if it runs long.
 */
export function capEventText(text, maxChars) {
    maxChars = maxChars || 160;
    if (!text || typeof text !== "string") return text;
    var trimmed = text.trim();
    if (trimmed.length <= maxChars) return trimmed;
    var head = trimmed.slice(0, maxChars);
    var lastSpace = head.lastIndexOf(" ");
    if (lastSpace > maxChars * 0.5) head = head.slice(0, lastSpace);
    return head.trim() + "…";
}

/**
 * formatElapsedDurationForPrompt(minutes)
 *
 * "This tick actually covers 45 minutes, not a full day" is the single
 * biggest lever against a tier over-inventing content — a scheduled tick
 * at its normal interval implicitly covers "about one interval's worth" of
 * time, but a MANUAL tick (Run World Tick, or the per-tier wand/regenerate
 * button) can fire after anywhere from a few minutes to a few hours of
 * actual RP-time, especially early in a story before any interval has
 * naturally elapsed. Without this, every tick — scheduled or manual — reads
 * to the model as "produce a normal update," with no signal to scale scope
 * down for a short gap. Returns null (never a fabricated duration) for
 * non-positive/invalid input, so callers can cleanly omit the prompt block.
 */
export function formatElapsedDurationForPrompt(minutes) {
    if (typeof minutes !== "number" || !isFinite(minutes) || minutes <= 0) return null;
    if (minutes < 60) {
        var m = Math.round(minutes);
        return m + " minute" + (m === 1 ? "" : "s");
    }
    var hours = minutes / 60;
    if (hours < 24) {
        var h = Math.round(hours * 10) / 10;
        return h + " hour" + (h === 1 ? "" : "s");
    }
    // Round the FULL hour count ONCE, then derive days/remHours from that
    // single rounded value. Rounding days (via floor) and the leftover
    // fractional hours separately can round e.g. 47.6h into "1 day" (floor)
    // + "24 hours" (the 23.6h leftover rounds up to 24) — a nonsensical
    // "1 day, 24 hours" instead of correctly rolling that into "2 days".
    var totalHoursRounded = Math.round(hours);
    var days = Math.floor(totalHoursRounded / 24);
    var remHours = totalHoursRounded - days * 24;
    var out = days + " day" + (days === 1 ? "" : "s");
    if (remHours > 0) out += ", " + remHours + " hour" + (remHours === 1 ? "" : "s");
    return out;
}

/** Shared prompt line built from the above — identical wording across all four tiers so the "scale scope to actual elapsed time" instruction reads consistently. */
function elapsedDurationBlock(elapsedMinutes) {
    var formatted = formatElapsedDurationForPrompt(elapsedMinutes);
    if (!formatted) return "";
    return "TIME ACTUALLY COVERED BY THIS UPDATE: ~" + formatted + " since this tracker's last update. Scale the SCOPE and AMOUNT of new development to that — a short gap should read as a light touch-up (or even \"nothing notable changed\"), not a full interval's worth of change. Do not narrate as if more time had passed than this.\n\n";
}
/**
 * Find-and-update-or-push, pure — mirrors the original npcStates upsert.
 *
 * GOAL FIELD, FIRST-WRITE-WINS: mirrors RelationshipAgent's character_bios
 * contract exactly — `update.goal` is only ever written if the NPC doesn't
 * already have one (`!npc.goal`), and only for a NEW npc entry does an
 * incoming goal get set directly. Once a goal exists, nothing here ever
 * overwrites it — a goal is meant to be a stable narrative anchor the NPC
 * is working toward, not something that should drift or get re-invented
 * tick to tick. (applyNpcTickResponse below is the other half of this
 * guarantee — it drops any goal the model tries to attach to an NPC name
 * not on the explicit "needs a goal" allow-list, so this first-write-wins
 * check is a backstop, not the only defense.)
 */
export function upsertNpcState(npcStates, update) {
    npcStates = npcStates || [];
    var found = false;
    var next = npcStates.map(function (npc) {
        if (npc.name === update.name) {
            found = true;
            var patch = { change: update.change };
            // _noGoal/_noRoutine are user opt-outs (goal/routine deleted from the UI) —
            // honored here too as a backstop, not just in the candidate-list formatters.
            if (update.goal && !npc.goal && !npc._noGoal) patch.goal = update.goal;
            // routine: same first-write-wins contract as goal — see sanitizeRoutine's
            // section header. A routine that exists is never agent-overwritten.
            if (update.routine && !(Array.isArray(npc.routine) && npc.routine.length > 0) && !npc._noRoutine) patch.routine = update.routine;
            return Object.assign({}, npc, patch);
        }
        return npc;
    });
    if (!found) next = next.concat([{ name: update.name, change: update.change, goal: update.goal || null, routine: update.routine || null }]);
    return next;
}

export function upsertManyNpcStates(npcStates, updates) {
    return (updates || []).reduce(function (acc, u) { return upsertNpcState(acc, u); }, npcStates || []);
}

/** Push + cap to the last maxCount entries (dedup via simple string match). */
export function capPendingReveals(reveals, newReveals, maxCount) {
    maxCount = maxCount || 15;
    reveals = reveals || [];
    var merged = reveals.slice();
    (newReveals || []).forEach(function (r) {
        // Similarity dedupe, not exact-match — over a long RP the faction tier
        // re-derives the same secret in slightly different wording ("...funding
        // the rebels" / "...funding the rebel army"), and exact matching let
        // those stack until they crowded genuinely new reveals off the 15-cap.
        // Threshold is 0.6, deliberately looser than isDuplicateEvent's 0.7:
        // reveals are prose-y sentences where a word or two always drifts
        // between derivations, while genuinely DIFFERENT secrets share far less
        // than 60% of their tokens — so this catches rewording without being
        // able to merge two real, distinct secrets.
        var isDupe = merged.some(function (existing) { return getEventSimilarity(existing, r) > 0.6; });
        if (!isDupe) merged.push(r);
    });
    return merged.slice(-maxCount);
}

/**
 * Formats npcStates for prompt injection, capped to the 20 most relevant
 * (recently-interacted NPCs sorted first), same as the original inline
 * logic in runSingleWorldTick. Returns a plain string, ready to embed.
 */
export function formatNpcStatesForPrompt(npcStates, recentNpcNames, maxCount, currentTime) {
    maxCount = maxCount || 20;
    if (!npcStates || npcStates.length === 0) return "No tracked NPCs yet.";

    var recentSet = new Set(recentNpcNames || []);
    var sorted = npcStates.slice().sort(function (a, b) {
        var aRecent = recentSet.has(a.name) ? 1 : 0;
        var bRecent = recentSet.has(b.name) ? 1 : 0;
        return bRecent - aRecent;
    });
    var capped = sorted.slice(0, maxCount);
    var text = capped.map(function (n) {
        var line = "- " + n.name + ": " + n.change;
        if (n.goal) line += " (goal: " + n.goal + ")";
        // Daily routine + what it says they're doing at the current clock — the
        // "heartbeat" grounding: the model is TOLD where this NPC is right now
        // instead of teleporting them wherever the scene wants.
        if (Array.isArray(n.routine) && n.routine.length > 0) {
            line += " [daily routine: " + formatRoutineForPrompt(n.routine);
            if (currentTime) {
                var current = getRoutineActivityAt(n.routine, currentTime);
                if (current) line += "; right now per routine: " + current.activity;
            }
            line += "]";
        }
        return line;
    }).join("\n");
    if (npcStates.length > maxCount) {
        text += "\n(" + (npcStates.length - maxCount) + " additional NPCs omitted - showing most recently active)";
    }
    return text;
}

/**
 * formatNpcsNeedingGoalForPrompt(npcStates, candidateNames, maxCount)
 *
 * The NPC tier is only ever invited to set a 'goal' for names in THIS list
 * — never a free-for-all. Two-part guarantee against hallucinated/duped
 * goals: (1) the prompt only offers the model a specific, bounded set of
 * names to consider (this function), so it isn't inventing goals out of
 * thin air for arbitrary NPCs; (2) applyNpcTickResponse's allowedGoalNames
 * filter enforces the same allow-list in code, dropping anything the model
 * returns for a name outside it, and upsertNpcState's first-write-wins
 * means even a NAME on the list can only ever get ONE goal, once.
 *
 * candidateNames: onscreen + recently-interacted NPC names (caller's job to
 * assemble, same inputs already used for other NPC-tier context blocks).
 * Returns null (not a string) when nobody currently qualifies, so the
 * caller can omit the whole prompt block instead of showing an empty list.
 */
export function formatNpcsNeedingGoalForPrompt(npcStates, candidateNames, maxCount) {
    maxCount = maxCount || 8;
    // _noGoal: the user deleted this NPC's goal from the World tab — that's an
    // opt-out, not a vacancy. Without it, the name would land right back on this
    // candidate list and the model would re-invent a goal on the next tick,
    // making the delete button a lie. (Deleting the whole NPC entry clears the
    // flag, since a re-tracked NPC starts fresh.)
    var existingGoalNames = new Set(
        (npcStates || []).filter(function (n) { return n && (n.goal || n._noGoal); }).map(function (n) { return n.name; })
    );
    var needing = (candidateNames || []).filter(function (name) { return name && !existingGoalNames.has(name); });
    if (needing.length === 0) return null;
    return needing.slice(0, maxCount).join(", ");
}

// =============================================================================
// NPC DAILY ROUTINES — simple recurring schedules ("07:00 opens the forge")
// stored per-NPC on npcStates (npc.routine = [{ time: "HH:MM", activity }]).
// Same first-write-wins contract as 'goal': the NPC tier is only invited to
// propose a routine for names on an explicit allow-list, and once one exists
// it's never overwritten by the agent (a routine is a stable anchor, not
// something to re-invent tick to tick). The payoff is deterministic: given
// the current RP clock, getRoutineActivityAt() says what that NPC is doing
// RIGHT NOW with zero LLM involvement — pure lookup, survives any time skip.
// =============================================================================

function parseClockToMinutes(timeStr) {
    var m = String(timeStr || "").trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    var hh = parseInt(m[1], 10), mm = parseInt(m[2], 10);
    if (isNaN(hh) || isNaN(mm) || hh > 23 || mm > 59) return null;
    return hh * 60 + mm;
}

function padClock(n) { return n < 10 ? "0" + n : String(n); }

/**
 * sanitizeRoutine(routine, maxEntries)
 *
 * Validates a model-proposed routine: entries must be { time: "HH:MM", activity }
 * with a real 24h time and non-empty activity text. Times are normalized to
 * padded HH:MM, duplicates (same time) collapse to the first, entries are
 * sorted chronologically, activity text is length-capped, and the whole list
 * is capped at maxEntries (default 6). Returns null if nothing valid survives —
 * same "absent means nothing happened" posture as the rest of this module.
 */
export function sanitizeRoutine(routine, maxEntries) {
    maxEntries = maxEntries || 6;
    if (!Array.isArray(routine)) return null;
    var seen = {};
    var out = [];
    routine.forEach(function (r) {
        if (!r || typeof r !== "object") return;
        var mins = parseClockToMinutes(r.time);
        if (mins == null) return;
        var activity = (typeof r.activity === "string") ? r.activity.trim() : "";
        if (!activity) return;
        if (seen[mins]) return;
        seen[mins] = true;
        out.push({
            time: padClock(Math.floor(mins / 60)) + ":" + padClock(mins % 60),
            activity: capEventText(activity, 100),
        });
    });
    if (out.length === 0) return null;
    out.sort(function (a, b) { return parseClockToMinutes(a.time) - parseClockToMinutes(b.time); });
    return out.slice(0, maxEntries);
}

/**
 * getRoutineActivityAt(routine, timeStr)
 *
 * The lookup that makes routines useful: returns the routine entry currently
 * "in effect" at the given clock — the latest entry whose time is <= now,
 * wrapping to the LAST entry of the day when the clock is before the first
 * entry (03:00 with a routine starting at 07:00 means yesterday's final
 * activity — e.g. "went home for the night" — is still what's in effect).
 * Returns null when there's nothing to look up.
 */
export function getRoutineActivityAt(routine, timeStr) {
    if (!Array.isArray(routine) || routine.length === 0) return null;
    var now = parseClockToMinutes(timeStr);
    if (now == null) return null;
    var current = null;
    for (var i = 0; i < routine.length; i++) {
        var t = parseClockToMinutes(routine[i].time);
        if (t != null && t <= now) current = routine[i];
    }
    return current || routine[routine.length - 1];
}

/** "07:00 opens the forge → 19:00 closes up" — compact one-line rendering for prompts/UI. */
export function formatRoutineForPrompt(routine) {
    if (!Array.isArray(routine) || routine.length === 0) return "";
    return routine.map(function (r) { return r.time + " " + r.activity; }).join(" → ");
}

/**
 * formatNpcsNeedingRoutineForPrompt(npcStates, candidateNames, maxCount)
 * Mirror of formatNpcsNeedingGoalForPrompt below — the NPC tier is only ever
 * offered a bounded list of names to propose a routine for, and
 * applyNpcTickResponse enforces the same allow-list in code.
 */
export function formatNpcsNeedingRoutineForPrompt(npcStates, candidateNames, maxCount) {
    maxCount = maxCount || 8;
    // _noRoutine: user deleted this NPC's routine — an opt-out, not a vacancy;
    // same reasoning as _noGoal in formatNpcsNeedingGoalForPrompt above.
    var existing = new Set(
        (npcStates || []).filter(function (n) { return n && ((Array.isArray(n.routine) && n.routine.length > 0) || n._noRoutine); }).map(function (n) { return n.name; })
    );
    var needing = (candidateNames || []).filter(function (name) { return name && !existing.has(name); });
    if (needing.length === 0) return null;
    return needing.slice(0, maxCount).join(", ");
}

// =============================================================================
// LOCATION CODEX — persistent per-place memory. When the scene LEAVES a
// location, the caller (Pipeline.doLLMUpdate) snapshots what it looked like at
// departure (who was there, what had just happened, weather). When the party
// returns — 5 messages or 40 sessions later — that snapshot gets injected so
// the place persists instead of relying on the model's shrinking context.
// Stored as a keyed map in worldData.locationCodex; all helpers here are pure.
// =============================================================================

export function normalizeLocationKey(name) {
    // Leading articles are stripped so the single most common rename between
    // visits ("The Rusty Tankard" vs "Rusty Tankard") still lands on the same
    // codex entry. Deliberately NOTHING fuzzier than that — locations that share
    // words are usually genuinely different places ("North Gate"/"South Gate",
    // "the tavern"/"the tavern cellar"), so fuzzy merging here would corrupt
    // memories of distinct places into each other.
    return String(name || "").toLowerCase().replace(/\s+/g, " ").trim().replace(/^(the|a|an) /, "");
}

/**
 * upsertLocationCodex(codex, entry, maxEntries)
 *
 * entry: { name, time, date, epoch, characters: [{name, state}], recentEvents,
 *          weather, temperature }
 * Returns a NEW codex object with the entry written under its normalized key
 * (visits counter carried forward from any existing entry). When the map
 * exceeds maxEntries (default 30), the entries with the OLDEST departure
 * epoch are dropped first — a place nobody has been near for the longest is
 * the safest memory to forget.
 */
export function upsertLocationCodex(codex, entry, maxEntries) {
    maxEntries = maxEntries || 30;
    codex = codex || {};
    if (!entry || !entry.name) return codex;
    var key = normalizeLocationKey(entry.name);
    if (!key || key === "unknown") return codex;

    var next = Object.assign({}, codex);
    var existing = next[key];
    // Legacy-key merge: an entry saved under an older normalization of the same
    // place name (e.g. "the rusty tankard" from before article-stripping) is
    // absorbed into the current key — its visit count carries over and the old
    // key is removed, instead of the same place splitting into two entries.
    if (!existing) {
        var keysNow = Object.keys(next);
        for (var i = 0; i < keysNow.length; i++) {
            var candidate = next[keysNow[i]];
            if (keysNow[i] !== key && candidate && normalizeLocationKey(candidate.name) === key) {
                existing = candidate;
                delete next[keysNow[i]];
                break;
            }
        }
    }
    next[key] = {
        name: entry.name,
        time: entry.time || "",
        date: entry.date || "",
        epoch: (typeof entry.epoch === "number" && isFinite(entry.epoch)) ? entry.epoch : 0,
        characters: Array.isArray(entry.characters) ? entry.characters : [],
        recentEvents: entry.recentEvents || "",
        weather: entry.weather || "",
        temperature: entry.temperature || "",
        visits: (existing && typeof existing.visits === "number" ? existing.visits : 0) + 1,
    };

    var keys = Object.keys(next);
    if (keys.length > maxEntries) {
        keys.sort(function (a, b) { return (next[a].epoch || 0) - (next[b].epoch || 0); }); // oldest first
        keys.slice(0, keys.length - maxEntries).forEach(function (k) { delete next[k]; });
    }
    return next;
}

export function getLocationCodexEntry(codex, name) {
    if (!codex) return null;
    var key = normalizeLocationKey(name);
    if (!key) return null;
    if (codex[key]) return codex[key];
    // Fallback for entries stored under an older key format (pre-article-strip
    // saves) — O(codex size), which is capped at 30, so effectively free.
    var keys = Object.keys(codex);
    for (var i = 0; i < keys.length; i++) {
        var e = codex[keys[i]];
        if (e && normalizeLocationKey(e.name) === key) return e;
    }
    return null;
}

/** Renders a codex entry as the prompt block injected when the party is back at a remembered place. */
export function formatLocationMemoryForPrompt(entry) {
    if (!entry) return "";
    var lines = [];
    lines.push("The party has been to \"" + entry.name + "\" before" +
        (entry.time && entry.date ? " — last left at " + entry.time + ", " + entry.date : "") +
        (entry.visits > 1 ? " (recorded departures: " + entry.visits + ")" : "") + ".");
    if (entry.recentEvents) lines.push("State when last leaving: " + entry.recentEvents);
    if (entry.characters && entry.characters.length > 0) {
        lines.push("Who was here then: " + entry.characters.map(function (c) {
            return c && c.name ? (c.name + (c.state ? " (" + c.state + ")" : "")) : "";
        }).filter(Boolean).join("; "));
    }
    if ((entry.weather && entry.weather !== "Unknown") || (entry.temperature && entry.temperature !== "Unknown")) {
        lines.push("Conditions then: " + [entry.temperature, entry.weather].filter(function (v) { return v && v !== "Unknown"; }).join(", "));
    }
    lines.push("Keep this place consistent with that remembered state — furniture, damage, items left behind, and who tends to be here don't reset between visits. Changes are fine when the elapsed time plausibly explains them, but don't quietly regenerate the place from scratch.");
    return lines.join("\n");
}

// =============================================================================
// CROSS-TIER GROUNDING — established, already-generated facts from OTHER
// tiers, threaded into a tier that doesn't otherwise see them. This is safe
// specifically because the content is never freshly synthesized for the
// purpose — it's already-validated, already-deduped, already-stored output
// (worldEvents from mergeWorldEvents, npcStates from upsertManyNpcStates)
// being shown as reference material, framed the same "established facts,
// not up for you to re-derive" way RelationshipAgent frames OTHER TRACKED
// RELATIONSHIPS. A tier reading this is being told what already happened
// elsewhere, not asked to invent connections to it.
// =============================================================================

/** Formats a capped, importance-sorted slice of worldEvents for injection into a tier that doesn't normally see them. */
export function formatWorldEventsForPrompt(worldEvents, maxCount) {
    maxCount = maxCount || 5;
    var events = (worldEvents || []).filter(function (e) { return e && e.event; });
    if (events.length === 0) return null;
    var sorted = events.slice().sort(function (a, b) {
        return (typeof b.importance === "number" ? b.importance : 5) - (typeof a.importance === "number" ? a.importance : 5);
    });
    return sorted.slice(0, maxCount).map(function (e) { return "- " + e.event; }).join("\n");
}

// =============================================================================
// RELEVANCE-WEIGHTED REVEALS — surface pending reveals that actually connect
// to what's CURRENTLY onscreen (present characters, current location) ahead
// of ones that don't, instead of a flat chronological list. Pure keyword/name
// overlap, not a semantic model — deliberately simple and deterministic so
// it never introduces its own guesswork about what's "relevant".
// =============================================================================

/** Score a single reveal's textual relevance to the current scene. Higher = more relevant. */
export function scoreRevealRelevance(text, context) {
    context = context || {};
    if (!text) return 0;
    var lower = String(text).toLowerCase();
    var score = 0;
    (context.onscreenNames || []).forEach(function (name) {
        if (name && lower.indexOf(String(name).toLowerCase()) !== -1) score += 3;
    });
    if (context.currentLocation) {
        String(context.currentLocation).toLowerCase().split(/\s+/).filter(function (w) { return w.length > 2; }).forEach(function (w) {
            if (lower.indexOf(w) !== -1) score += 1;
        });
    }
    return score;
}

/**
 * rankRevealsByRelevance(reveals, context, maxCount)
 * Sorts reveals by relevance score (ties broken by recency — later entries
 * in the array are more recently added, per capPendingReveals' push order).
 * Pure — returns a NEW array, does not mutate or drop anything from storage;
 * this only affects what order a tier SEES them in, not what's persisted.
 */
export function rankRevealsByRelevance(reveals, context, maxCount) {
    reveals = reveals || [];
    maxCount = (typeof maxCount === "number") ? maxCount : reveals.length;
    var scored = reveals.map(function (r, idx) { return { text: r, score: scoreRevealRelevance(r, context), idx: idx }; });
    scored.sort(function (a, b) { return b.score !== a.score ? b.score - a.score : b.idx - a.idx; });
    return scored.slice(0, maxCount).map(function (s) { return s.text; });
}

/**
 * selectWorldPulse(worldEvents, context)
 *
 * Picks a single "world pulse" line for a HUD/status surface — the
 * highest (importance + scene-relevance) scoring worldEvent. PURE: same
 * inputs always yield the same pick, so a HUD re-render (which happens on
 * every cosmetic redraw) never changes the displayed line unless the
 * underlying events actually changed. An earlier version excluded "whatever
 * was shown last time" to add variety, but paired with a caller that saved
 * the pick during render, that made the signal flip-flop between events on
 * redraws that changed no story data — the opposite of useful. Deliberately
 * sourced ONLY from worldEvents (already-happened offscreen developments),
 * never from pendingReveals — reveals are explicitly "not yet known to the
 * main characters" and surfacing one in a glanceable HUD would leak a secret
 * the narrative hasn't delivered yet. Returns null if there's nothing to show.
 */
export function selectWorldPulse(worldEvents, context) {
    var events = (worldEvents || []).filter(function (e) { return e && e.event; });
    if (events.length === 0) return null;
    var scored = events.map(function (e) {
        var importance = typeof e.importance === "number" ? e.importance : 5;
        return { event: e, score: importance + scoreRevealRelevance(e.event, context) };
    });
    scored.sort(function (a, b) { return b.score - a.score; });
    var pick = scored[0];
    return { text: pick.event.event, time: pick.event.time, date: pick.event.date };
}

/**
 * pruneNpcStates(npcStates, recentNpcNames, maxCount)
 *
 * formatNpcStatesForPrompt() above only caps what gets SHOWN in a prompt — the
 * underlying npcStates array itself was never capped, so a long campaign that
 * introduces many one-off named NPCs (background characters mentioned once and
 * never revisited) grows it forever. This caps the actual storage: any NPC in
 * recentNpcNames is kept whenever the "recent" bucket itself fits under
 * maxCount, and among the rest, only the maxCount-worth most-recently-added
 * are kept (upsertNpcState always appends new NPCs to the end, so array
 * order is oldest-to-newest for anyone not already tracked). Pure — returns
 * a NEW array.
 *
 * maxCount is a HARD ceiling, not just a target for the "others" bucket — if
 * a single recency window somehow surfaces more distinct NPCs than maxCount
 * on its own (a very large ensemble scene), "recent" itself is trimmed down
 * to the most-recently-relevant maxCount entries rather than being allowed
 * to grow past the cap. array order is the same oldest-to-newest assumption
 * used for "others" below, so slicing off the front keeps the newest.
 */
export function pruneNpcStates(npcStates, recentNpcNames, maxCount) {
    npcStates = npcStates || [];
    maxCount = maxCount || 40;
    if (npcStates.length <= maxCount) return npcStates;

    var recentSet = new Set(recentNpcNames || []);
    var recent = npcStates.filter(function (n) { return recentSet.has(n.name); });
    var others = npcStates.filter(function (n) { return !recentSet.has(n.name); });

    if (recent.length > maxCount) {
        recent = recent.slice(recent.length - maxCount);
    }
    var keptRecentNames = new Set(recent.map(function (n) { return n.name; }));

    var otherBudget = Math.max(0, maxCount - recent.length);
    var keptOthers = others.slice(Math.max(0, others.length - otherBudget));
    var keptOtherNames = new Set(keptOthers.map(function (n) { return n.name; }));

    return npcStates.filter(function (n) {
        return keptRecentNames.has(n.name) || keptOtherNames.has(n.name);
    });
}

/** Clamps an interval_index the model returned into a valid range, never trusting it blindly. */
function clampIntervalIndex(index, listLength) {
    var i = Number.isInteger(index) ? index : 0;
    return Math.max(0, Math.min(listLength - 1, i));
}

function requireTickInput(input, tierName) {
    if (!input || !input.currentTime || !input.currentDate) {
        throw new Error("WorldAgent." + tierName + ": currentTime/currentDate must be supplied by the Scheduler/TimelineEngine — this tier no longer determines these itself.");
    }
}

// =============================================================================
// NPC TIER
// =============================================================================

export function buildNpcTickPrompt(input) {
    input = input || {};
    requireTickInput(input, "buildNpcTickPrompt");
    var isBatch = !!input.isBatch;

    return (
        "[OOC: You are the NPC Offscreen Behavior tracker. You extract/extend background NPC activity — you do NOT continue or advance the current onscreen scene. " +
        (isBatch
            ? "A gap of in-story time has passed (" + formatTimeForPrompt(input.currentTime) + " " + input.currentDate + " is now current). Describe what tracked NPCs did ACROSS THE WHOLE GAP, as one continuous arc — do not repeat the same action, show progression."
            : "It is now " + formatTimeForPrompt(input.currentTime) + " " + input.currentDate + " (fixed by the Timeline system, not by you). Describe what tracked NPCs are doing offscreen right now.") +
        "\n\n" +
        elapsedDurationBlock(input.elapsedMinutesSinceLastTick) +
        "CURRENTLY ONSCREEN (present in the live scene right now — do NOT invent offscreen activity for these, the scene itself already covers them; only mention one of these if something is happening to them specifically elsewhere/simultaneously, which should be rare):\n" +
        (input.onscreenNpcsText || "None identified.") + "\n\n" +
        "RECENTLY INTERACTED, BUT CURRENTLY OFFSCREEN (the player has dealt with these but they are NOT in the current scene — only update one if there's a plausible, grounded continuation of what they were last doing; it is fine and often correct to skip one if nothing meaningful would be happening for them right now):\n" +
        (input.interactedNpcsText || "None.") + "\n\n" +
        "MENTIONED BY NAME ONLY (their name came up in dialogue/narration, but they haven't been seen or spoken to this tick — you have no fresh evidence of what they're doing, so at most infer a brief, LOGICAL, time-of-day-consistent state, not a new development):\n" +
        (input.mentionedNpcsText || "None.") + "\n\n" +
        "ESTABLISHED CHARACTER CARD LORE (ground truth — an NPC's offscreen behavior must stay consistent with this, not contradict it):\n" +
        (input.characterLoreText || "None provided.") + "\n\n" +
        "EXISTING NPC STATES (evolve these naturally, as continuations of their last known activity):\n" +
        (input.npcStatesText || "No tracked NPCs yet.") + "\n\n" +
        "PENDING SCHEDULED EVENTS (already queued and due at the listed time — the system resolves these automatically once RP-time reaches them; don't narrate one of these as already resolved before its due time, and don't invent a duplicate of one already listed here):\n" +
        (input.pendingEventsText || "None currently pending.") + "\n\n" +
        (input.recentWorldEventsText
            ? ("RECENT WORLD-LEVEL DEVELOPMENTS (established facts from the faction/plot tier — background awareness only, so an NPC's offscreen activity can stay consistent with them; do NOT re-narrate one of these as an NPC action, and do NOT invent new plot consequences from them yourself):\n" + input.recentWorldEventsText + "\n\n")
            : "") +
        (input.npcsNeedingGoalText
            ? ("NPCs THAT COULD USE A ONE-SENTENCE GOAL (see rule 9 below — ONLY these names, and only if you have enough grounded info; every other tracked NPC already has one or doesn't need one yet):\n" + input.npcsNeedingGoalText + "\n\n")
            : "") +
        (input.npcsNeedingRoutineText
            ? ("NPCs THAT COULD USE A DAILY ROUTINE (see rule 10 below — ONLY these names, and only where their role makes a regular day plausible; every other tracked NPC already has one or doesn't need one):\n" + input.npcsNeedingRoutineText + "\n\n")
            : "") +
        "RECENT CHAT (for narrative context — do not narrate the onscreen scene, only offscreen NPC behavior):\n" +
        (input.recentChatText || "No messages yet.") + "\n\n" +
        "Rules:\n" +
        "1. Do NOT write dialogue or narrate the active scene, and do NOT continue/advance/resolve whatever plot thread is currently playing out onscreen. This is background noise happening in parallel, elsewhere.\n" +
        "2. Every 'change' should feel like a natural continuation of the NPC's last interaction, not a random new activity or a leap forward in the plot.\n" +
        "3. Do NOT invent brand-new named NPCs, factions, or locations that have no basis in the states/chat above — extend what already exists.\n" +
        "4. If ESTABLISHED CHARACTER CARD LORE is provided above, treat it as ground truth for that character's personality, background, and affiliations — do not write behavior that contradicts it.\n" +
        "5. Give an update for MOST tracked, currently-offscreen NPCs — even a small, mundane continuation of their last known activity counts as a valid update and is preferred over saying nothing (e.g. \"still tending the shop, restocking shelves\", \"continues traveling toward the outpost, another day closer\"). This is the SAME NPC's entry continuing to evolve, not a new one — do not invent a fresh unrelated activity just to have something to say, extend what they were already doing. Only skip an NPC, or return fewer updates than listed, when there truly is no plausible continuation at all (e.g. an NPC whose last known state already resolved and nothing new applies). An empty list should be the rare exception, not the default — reserve it for when there are genuinely no tracked, offscreen NPCs worth reporting on this tick.\n" +
        "6. Do not include a time or date field — it is not needed here.\n" +
        "7. OPTIONAL — SCHEDULED/DELAYED ACTIONS: if an NPC sets off on something that realistically takes time to play out (a journey, a stakeout, waiting on a reply), you MAY add \"duration_minutes\" (integer minutes until it completes, measured from THIS tick's current time above) and \"resolution\" (one sentence describing what that NPC has done/become once it completes). Only use this when the action genuinely spans meaningful time — omit both fields for anything already resolved this tick.\n" +
        "8. For NPCs in the MENTIONED BY NAME ONLY section: give a short, LOW-KEY state that a reasonable person would infer from the current time of day and that NPC's last known state/role (e.g. likely asleep at this hour, likely still at their usual post, likely still en route) — a plausible guess, not a new plot beat. Do not escalate, complicate, or introduce anything not already implied by what's established. Skip an NPC here entirely if there isn't enough established info (role, last known state, lore) to make a reasonable guess — inventing one from nothing is worse than omitting it.\n" +
        "9. OPTIONAL — GOAL: for an NPC listed under NPCs THAT COULD USE A ONE-SENTENCE GOAL above (and ONLY those), you MAY add a \"goal\" field — one short sentence naming something concrete they're working toward, grounded in what's already established (their role, lore, recent activity). This is set ONCE and never revisited, so only include it if there's real evidence to base it on; skip it rather than invent a generic one. NEVER add \"goal\" for any NPC not in that list — they either already have one or there isn't enough established about them yet.\n" +
        "10. OPTIONAL — DAILY ROUTINE: for an NPC listed under NPCs THAT COULD USE A DAILY ROUTINE above (and ONLY those), you MAY add a \"routine\" field — 2 to 5 entries of {\"time\":\"HH:MM\",\"activity\":\"...\"} describing an ordinary repeating day grounded in their established role (a blacksmith opens the forge, a guard walks a shift — nothing plot-driven). Each activity should be a short phrase naming where they are / what they do from that hour onward. Like goals, a routine is set ONCE and never revisited — skip an NPC rather than invent a routine their role doesn't support, and NEVER add one for a name not in that list.\n" +
        "11. RESPECT ESTABLISHED ROUTINES: where a tracked NPC's state above shows a [daily routine: ...], their offscreen 'change' should normally be consistent with what that routine says they're doing at the current hour — deviate only when something already established plausibly pulls them away, and say so in the 'change' text.\n\n" +
        "Respond ONLY with valid JSON (an empty array is a valid, often correct, response):\n" +
        "{\"npc_updates\":[{\"name\":\"NPC name\",\"change\":\"what they are doing offscreen\"}]}\n" +
        "Example of a SCHEDULED NPC action (only include duration_minutes/resolution when genuinely applicable):\n" +
        "{\"npc_updates\":[{\"name\":\"Captain Reyes\",\"change\":\"sets out toward the northern outpost to investigate the reports\",\"duration_minutes\":360,\"resolution\":\"Captain Reyes reaches the northern outpost and confirms the reports were accurate.\"}]}\n" +
        "Example of a NEW goal (only for a name listed under NPCs THAT COULD USE A ONE-SENTENCE GOAL):\n" +
        "{\"npc_updates\":[{\"name\":\"Mira\",\"change\":\"still tending the shop, restocking shelves\",\"goal\":\"saving up enough coin for passage north before winter closes the roads\"}]}\n" +
        "Example of a NEW daily routine (only for a name listed under NPCs THAT COULD USE A DAILY ROUTINE):\n" +
        "{\"npc_updates\":[{\"name\":\"Balthor\",\"change\":\"hammering out a batch of horseshoes\",\"routine\":[{\"time\":\"07:00\",\"activity\":\"opens the forge and stokes the fires\"},{\"time\":\"13:00\",\"activity\":\"breaks for a meal at the tavern\"},{\"time\":\"14:00\",\"activity\":\"back at the forge taking commissions\"},{\"time\":\"19:00\",\"activity\":\"closes up and heads home\"}]}]}\n" +
        "]"
    );
}

/**
 * applyNpcTickResponse(data, allowedGoalNames)
 *
 * allowedGoalNames: optional array/Set of names the prompt actually offered
 * a goal slot to (see formatNpcsNeedingGoalForPrompt). This is the hard
 * code-side half of the goal-hallucination guard — even if the model
 * ignores rule 9 and attaches a "goal" to some other NPC, or re-sends one
 * for a name that already has one, it's silently dropped here and never
 * reaches storage. Omit allowedGoalNames to disable the check (accepts any
 * goal the model returns) — used only if a caller intentionally wants that.
 */
export function applyNpcTickResponse(data, allowedGoalNames, allowedRoutineNames) {
    if (!data || !Array.isArray(data.npc_updates)) return { npc_updates: [] };
    var allowedSet = allowedGoalNames ? new Set(allowedGoalNames) : null;
    var allowedRoutineSet = allowedRoutineNames ? new Set(allowedRoutineNames) : null;
    // String-only name/change — same non-string-poisoning posture as the
    // weather/summary validators (truthiness alone let objects/numbers through).
    var updates = data.npc_updates.filter(function (u) {
        return u && typeof u.name === "string" && u.name.trim() && typeof u.change === "string" && u.change.trim();
    }).map(function (u) {
        // Optional scheduling fields — never trusted blindly, same posture as the faction
        // tier's duration_minutes/resolution. A malformed/negative/zero duration just means
        // "not a scheduled action". The caller (index.js) owns actually enqueuing these into
        // EventQueue; this function only validates/normalizes what the model returned.
        var durationMinutes = (typeof u.duration_minutes === "number" && isFinite(u.duration_minutes) && u.duration_minutes > 0)
            ? Math.round(u.duration_minutes)
            : null;
        var resolution = (typeof u.resolution === "string" && u.resolution.trim())
            ? capEventText(u.resolution.trim())
            : null;

        var goal = null;
        if (typeof u.goal === "string" && u.goal.trim() && (!allowedSet || allowedSet.has(u.name))) {
            goal = capNpcGoal(u.goal.trim());
        }

        // routine: same allow-list enforcement as goal — a routine attached to a
        // name the prompt never offered one to is silently dropped, and whatever
        // survives goes through sanitizeRoutine (validated times, capped length).
        var routine = null;
        if (Array.isArray(u.routine) && (!allowedRoutineSet || allowedRoutineSet.has(u.name))) {
            routine = sanitizeRoutine(u.routine, 6);
        }

        return { name: u.name, change: u.change, durationMinutes: durationMinutes, resolution: resolution, goal: goal, routine: routine };
    });
    return { npc_updates: updates };
}

// =============================================================================
// WEATHER TIER
// =============================================================================

// Cheap, local, deliberately dumb — same philosophy as TimelineEngine's
// detectTimeSkipTrigger: this does not decide anything about the weather
// itself, it only flags "does this message explicitly describe the weather
// changing", so the caller can let the weather tier fire early instead of
// waiting out the full ~24h interval for something that just visibly
// happened on-scene. A false positive just costs one regular weather tick
// slightly ahead of schedule — never something that touches the RP clock or
// any other tracker.
var WEATHER_CHANGE_MENTION_RE = /\b(starts? to rain|starts? raining|begins? to rain|starts? to snow|starts? snowing|clouds? (?:roll|gather|move) in|storm (?:rolls|moves) in|the (?:rain|snow|storm|wind|fog) (?:stops|clears|starts|begins|picks up|dies down)|weather (?:changes|shifts|turns)|skies? (?:clear|darken|turn)|temperature (?:drops|rises|plummets|climbs)|a (?:cold|warm|heat) (?:front|wave) (?:moves in|arrives|hits)|thunder (?:rumbles|claps)|lightning (?:flashes|strikes)|the wind (?:picks up|dies down|howls)|fog (?:rolls in|sets in|lifts)|frost (?:sets in|forms)|the first snow(?:fall)?)\b/i;

export function detectWeatherChangeMention(text) {
    if (!text) return false;
    return WEATHER_CHANGE_MENTION_RE.test(text);
}

export function buildWeatherTickPrompt(input) {
    input = input || {};
    requireTickInput(input, "buildWeatherTickPrompt");
    var isBatch = !!input.isBatch;

    return (
        "[OOC: You are the Regional Weather/Climate tracker. This is DISTINCT from the immediate on-scene weather (already tracked elsewhere) — focus on broader regional trends: incoming fronts, seasonal shifts, storms developing elsewhere, drought conditions, etc.\n\n" +
        (isBatch
            ? "A gap of in-story time has passed, now at " + formatTimeForPrompt(input.currentTime) + " " + input.currentDate + ". Describe how weather/climate trends developed across the WHOLE gap in one continuous blurb."
            : "It is now " + formatTimeForPrompt(input.currentTime) + " " + input.currentDate + " (fixed by the Timeline system, not by you). Describe the current regional weather trend.") +
        "\n\n" +
        elapsedDurationBlock(input.elapsedMinutesSinceLastTick) +
        "Current known region/location: " + (input.currentLocation || "Unknown") + "\n" +
        (input.season ? ("Current season (real-calendar grounding — for an established fantasy/sci-fi calendar that doesn't map to real seasons, treat this as a loose mood cue or ignore it): " + input.season + "\n") : "") +
        "Previous weather trend: " + (input.previousWeatherTrend || "None established yet.") + "\n\n" +
        "RECENT CHAT (for tonal/seasonal context only):\n" +
        (input.recentChatText || "No messages yet.") + "\n\n" +
        "Rules:\n" +
        (isBatch
            ? "1. One to two sentences, grounded and physically plausible given the previous trend — don't contradict it without reason.\n"
            : "1. ONE short sentence, ideally under ~20 words — this is shown as a compact glanceable status line, not a paragraph. Grounded and physically plausible given the previous trend; don't contradict it without reason.\n") +
        "2. Do not include a time or date field.\n\n" +
        "Respond ONLY with valid JSON:\n" +
        "{\"weather_trend\":\"A storm system is rolling in from the coast, expected to reach the capital within a day.\"}\n" +
        "]"
    );
}

export function applyWeatherTickResponse(data) {
    // STRING-ONLY: a JSON-valid response can still carry an object/array/number
    // here, and a non-string weatherTrend persists into worldData and then
    // crashes every consumer that assumes a string (.toLowerCase() in the HUD's
    // weather icon picker, .trim() in the scene prompt's grounding line).
    if (!data || typeof data.weather_trend !== "string") return null;
    var trend = data.weather_trend.trim();
    if (!trend) return null;
    return { weatherTrend: trend.length > 400 ? trend.slice(0, 400) : trend };
}

// =============================================================================
// FACTION TIER — the one tier with genuinely per-event timestamps
// =============================================================================

/**
 * buildFactionTickPrompt(input)
 *
 * input.intervalList (only for batch): [{time, date}, ...] — precomputed by
 * Scheduler.computeTickTimestamps(). When present, the model is asked to
 * tag each event with an interval_index (0-based) into THIS list, never a
 * free-text time/date string.
 */
export function buildFactionTickPrompt(input) {
    input = input || {};
    requireTickInput(input, "buildFactionTickPrompt");
    var intervalList = input.intervalList || null;
    var isBatch = !!intervalList && intervalList.length > 1;

    var intervalBlock = "";
    var schemaEventLine;
    if (isBatch) {
        intervalBlock = "TIME GAP TO COVER (tag every event with the interval_index it belongs to — an integer, NOT a time string):\n" +
            intervalList.map(function (iv, i) { return i + ": " + formatTimeForPrompt(iv.time) + " " + iv.date; }).join("\n") + "\n\n";
        schemaEventLine = "{\"event\":\"One short, glanceable sentence describing the offscreen event\",\"importance\":5,\"interval_index\":0}";
    } else {
        intervalBlock = "This tick's fixed time: " + formatTimeForPrompt(input.currentTime) + " " + input.currentDate + " (set by the Timeline system, not by you — all events below are assumed to occur at this time; no per-event time field needed).\n\n" +
            elapsedDurationBlock(input.elapsedMinutesSinceLastTick);
        schemaEventLine = "{\"event\":\"One short, glanceable sentence describing the offscreen event\",\"importance\":5}";
    }

    return (
        "[OOC: You are the Faction & Plot Progression Agent. Simulate offscreen faction movements, plot developments, and background consequences.\n\n" +
        intervalBlock +
        "CURRENT SCENE DETAILS:\n" +
        "- Current Location: " + (input.currentLocation || "Unknown") + "\n" +
        "- Recent Events: " + (input.recentEventsText || "None yet.") + "\n\n" +
        "WORLD SUMMARY (baseline context — do not restate it, build on it):\n" + (input.worldSummary || "No world summary yet.") + "\n\n" +
        "PENDING REVEALS BEFORE THIS TICK:\n" + (input.pendingRevealsText || "None.") + "\n\n" +
        "PENDING SCHEDULED EVENTS (already queued and due at the listed time — the system resolves these automatically once RP-time reaches them, you do NOT need to and should NOT narrate their resolution yourself; just stay aware of them so you don't invent a duplicate or a contradiction):\n" +
        (input.pendingEventsText || "None currently pending.") + "\n\n" +
        (input.recentNpcActivityText
            ? ("RECENT TRACKED NPC ACTIVITY (established facts from the NPC tier — background awareness only; do NOT re-narrate one of these as a faction event, and do NOT invent a faction-level consequence from one unless there's a genuine, grounded thread to pull):\n" + input.recentNpcActivityText + "\n\n")
            : "") +
        "ESTABLISHED CHARACTER CARD LORE (ground truth — offscreen developments must stay consistent with this, not contradict it):\n" +
        (input.characterLoreText || "None provided.") + "\n\n" +
        "PAST HISTORY TIMELINE:\n" + (input.historyTimelineText || "No history yet.") + "\n\n" +
        "RECENT CHAT (additional grounding and tone — not the only valid source for an event; see rule 2 below):\n" +
        (input.recentChatText || "No messages yet.") + "\n\n" +
        "Rules:\n" +
        "1. Do NOT narrate the onscreen scene or speak as active characters, and do NOT resolve, escalate, or continue whatever plot thread is currently playing out onscreen. These are quiet, parallel developments happening elsewhere at the same time.\n" +
        "1b. KEEP EACH \"event\" SHORT — ONE sentence, ideally under ~20 words. This is shown as a compact, glanceable line in a HUD list, not a paragraph: state WHAT happened, not the full why/how. If it's starting to read like two sentences or a run-on, cut it down. The same limit applies to \"resolution\" when you include one.\n" +
        "2. Events do NOT have to be consequences of the onscreen characters' actions — that's one valid source, but not the only one. Anything already established in WORLD SUMMARY / PAST HISTORY / CHARACTER LORE is fair game to develop further on its own: a faction pursuing its own agenda, a region's situation progressing, a background rivalry playing out — none of it needs a thread back to what the player character(s) just did. The one hard requirement is GROUNDING: every event must connect to something already established somewhere above (a named faction, place, conflict, or figure from the world summary/history/lore), never to something invented wholesale. The goal is a world that feels like it's moving on its own around the characters, not a world that only reacts to them.\n" +
        "3. Do NOT invent brand-new named characters, factions, or locations with no basis in the context provided. If nothing established gives you a thread to extend, keep the event small/vague (e.g. general unrest, routine movement) rather than fabricating a new named entity.\n" +
        "4. If ESTABLISHED CHARACTER CARD LORE is provided above, treat it as ground truth — do not contradict a character's established background, affiliations, or the setting it implies.\n" +
        "5. REALISTIC PACING: news/messengers travel at realistic speed — do not compress time.\n" +
        "6. NO CHRONOLOGICAL COMPRESSION: parallel offscreen developments, not sequential steps of one action chain.\n" +
        (isBatch ? "7. Cover EACH interval listed above at least once (a quiet interval is fine — use a low-importance event, or explicitly note nothing significant happened).\n" : "") +
        "8. It is CORRECT and EXPECTED to return an empty \"events\" array (and/or empty \"pending_reveals\") if nothing meaningful/grounded is plausible right now — do not fabricate events just to fill the response.\n" +
        "9. OPTIONAL — SCHEDULED/DELAYED EVENTS: if an event describes an action whose outcome realistically takes time to arrive (a messenger traveling, a ship sailing, an investigation being carried out), you MAY add \"duration_minutes\" (integer minutes until it completes) and \"resolution\" (one sentence describing what becomes known/happens once it completes). Only use this for events that genuinely have a meaningful delay — omit both fields for anything already complete or effectively instant.\n" +
        "9b. Do NOT invent a new event that's really the same thing as something already listed in PENDING SCHEDULED EVENTS above, and do NOT jump ahead and narrate one of those as already resolved/arrived before its due time — the system handles that resolution automatically, exactly at the right moment, whether or not you mention it. It's fine to build a NEW, related development around an existing pending one (e.g. tension rising WHILE the messenger is still en route) as long as you don't resolve it early yourself.\n" +
        "10. AMBIENT WORLD TEXTURE is a normal, welcome category of event, not just a last-resort filler for empty ticks — ordinary background continuing (a market opening, a patrol rotating through, a minor rumor circulating, a distant region's weather/harvest/festival) purely to keep the world feeling lived-in and populated beyond the immediate plot. Mix these in alongside plot-adjacent events rather than only reaching for them when nothing else fits. Still follow rule 3 (no new named characters/factions/locations) and must not advance or resolve the onscreen plot. This doesn't override rule 8 — a genuinely empty array is still correct whenever even ambient texture feels forced.\n" +
        "\n" +
        "Respond ONLY with valid JSON (an empty events array is a valid, often correct, response):\n" +
        "{\"events\":[" + schemaEventLine + "],\"pending_reveals\":[\"A secret or rumor connected to recent events, not yet known to the main characters\"]}\n" +
        "Example of a SCHEDULED event (only include duration_minutes/resolution when genuinely applicable):\n" +
        "{\"event\":\"A messenger departs the capital for the border garrison.\",\"importance\":6,\"duration_minutes\":240,\"resolution\":\"The messenger reaches the garrison and delivers the sealed orders.\"}\n" +
        "]"
    );
}

/**
 * applyFactionTickResponse(data, intervalList, fixedTime, fixedDate)
 *
 * Validates events, and — for batch responses — maps each event's
 * interval_index to the EXACT precomputed {time, date} from intervalList,
 * clamping any out-of-range/malformed index rather than trusting it. For
 * single-tick responses (no intervalList), every event gets the tier's one
 * known fixed time/date directly.
 */
export function applyFactionTickResponse(data, intervalList, fixedTime, fixedDate) {
    if (!data) return { events: [], pending_reveals: [] };

    var events = Array.isArray(data.events) ? data.events : [];
    // String-only event text — capEventText passes non-strings through unchanged,
    // so an object here would persist and crash the similarity dedupe later.
    var mapped = events.filter(function (e) { return e && typeof e.event === "string" && e.event.trim(); }).map(function (e) {
        var time, date;
        if (intervalList && intervalList.length > 0) {
            var idx = clampIntervalIndex(e.interval_index, intervalList.length);
            time = intervalList[idx].time;
            date = intervalList[idx].date;
        } else {
            time = fixedTime;
            date = fixedDate;
        }

        // Optional scheduling fields — never trusted blindly. A malformed/negative/zero
        // duration_minutes means "not a scheduled event", same as omitting it entirely.
        // See EventQueue.js: the caller (index.js) is responsible for actually enqueuing
        // these, this function only validates/normalizes what the model returned.
        var durationMinutes = (typeof e.duration_minutes === "number" && isFinite(e.duration_minutes) && e.duration_minutes > 0)
            ? Math.round(e.duration_minutes)
            : null;
        var resolution = (typeof e.resolution === "string" && e.resolution.trim())
            ? capEventText(e.resolution.trim())
            : null;

        return {
            event: capEventText(e.event),
            importance: typeof e.importance === "number" ? e.importance : 5,
            time: time,
            date: date,
            durationMinutes: durationMinutes,
            resolution: resolution,
        };
    });

    // String-only reveals — a non-string here would crash the similarity dedupe
    // in capPendingReveals (tokenize calls .toLowerCase()).
    var reveals = Array.isArray(data.pending_reveals)
        ? data.pending_reveals.filter(function (r) { return typeof r === "string" && r.trim(); })
        : [];

    return { events: mapped, pending_reveals: reveals };
}

// =============================================================================
// WORLD TIER (daily macro synthesis)
// =============================================================================

export function buildWorldTickPrompt(input) {
    input = input || {};
    requireTickInput(input, "buildWorldTickPrompt");
    var isBatch = !!input.isBatch;

    return (
        "[OOC: You are the World Synthesis Agent. Produce an updated high-level synthesis of the overall world state outside the immediate scene.\n\n" +
        (isBatch
            ? "A gap of in-story time has passed, now at " + formatTimeForPrompt(input.currentTime) + " " + input.currentDate + ". Synthesize the FULL gap into one updated summary."
            : "It is now " + formatTimeForPrompt(input.currentTime) + " " + input.currentDate + " (fixed by the Timeline system, not by you). Update the world summary.") +
        "\n\n" +
        elapsedDurationBlock(input.elapsedMinutesSinceLastTick) +
        (input.season ? ("Current season (real-calendar grounding — for an established fantasy/sci-fi calendar that doesn't map to real seasons, treat this as a loose mood cue or ignore it): " + input.season + "\n\n") : "") +
        "WORLD SUMMARY BEFORE THIS UPDATE:\n" + (input.worldSummaryBefore || "No world summary yet.") + "\n\n" +
        "RECENT FACTION/PLOT EVENTS (from the faction tier, for context to fold in — these are already shown to the player as their own separate list; see rule 1 below for how this synthesis should relate to them):\n" + (input.recentFactionEventsText || "None yet.") + "\n\n" +
        "ESTABLISHED CHARACTER CARD LORE (ground truth — do not synthesize anything that contradicts this):\n" +
        (input.characterLoreText || "None provided.") + "\n\n" +
        "PAST HISTORY TIMELINE:\n" + (input.historyTimelineText || "No history yet.") + "\n\n" +
        "RECENT CHAT (for narrative grounding):\n" + (input.recentChatText || "No messages yet.") + "\n\n" +
        "Rules:\n" +
        "1. This should be a SYNTHESIS, not a raw log — condense, don't just append. The RECENT FACTION/PLOT EVENTS above are already shown to the player as their own separate list, so do NOT restate one of those lines again here in similar wording — that reads as the same information twice. Instead, step back a level: what do these events, together with everything else above, now mean for the overall state of things (a rising tension, a shifting balance of power, a mood taking hold)? Reference specific story elements, but describe their CUMULATIVE EFFECT, not the events themselves.\n" +
        "2. Keep it grounded, chronicle-like. Avoid flowery language.\n" +
        "3. Do not include a time or date field.\n" +
        "4. BE BRIEF. This is a short snapshot, not a chronicle entry — 2 to 3 sentences, roughly 40-60 words total. Say only what matters most right now; cut anything that isn't essential to understanding the current state of the world.\n\n" +
        "Respond ONLY with valid JSON:\n" +
        "{\"summary\":\"A short (2-3 sentence) snapshot of the overall world state.\"}\n" +
        "]"
    );
}

export function applyWorldTickResponse(data, maxChars) {
    // STRING-ONLY, same reasoning as applyWeatherTickResponse: capWorldSnapshot
    // passes non-strings through unchanged, so an object summary used to persist
    // and then crash renderModal's `worldSummary.trim()` check on every render.
    if (!data || typeof data.summary !== "string" || !data.summary.trim()) return null;
    return { summary: capWorldSnapshot(data.summary, maxChars) };
}
