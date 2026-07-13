/*
 * EventQueue.js
 * ---------------------------------------------------------------------------
 * ROLE: store future actions and resolve them once enough RP-time has passed.
 * This is what makes promises like "a messenger departs, ETA ~4 hours" a hard
 * guarantee instead of prose sitting in a shrinking summary that the model
 * has to remember on its own. Once JS says the time has come, the event WILL
 * resolve — whether that time arrives one message later or after a
 * multi-day skip that jumps straight past it.
 *
 * Pure module: no LLM calls, no side effects, no dependency on ST/index.js.
 * All functions are non-mutating — they return NEW arrays/objects rather
 * than modifying the queue you pass in. The caller (index.js) owns
 * persisting the returned queue back into storage. This mirrors the
 * append/merge-only philosophy already used elsewhere in the extension —
 * events are never deleted outright, only marked resolved/cancelled, so the
 * full history stays inspectable.
 *
 * Event shape:
 *   {
 *     id, actor, action,
 *     startTime, startDate,       // "HH:MM", "DD/MM/YYYY" — when it began
 *     durationMinutes,            // how long it takes
 *     executeTime, executeDate,   // computed: startTime/Date + durationMinutes
 *     status,                     // 'pending' | 'resolved' | 'cancelled'
 *     meta                        // optional free-form payload (caller-defined)
 *   }
 * ---------------------------------------------------------------------------
 */

import { parseDateTime, addMinutesToDate, formatTime, formatDate } from "./TimelineEngine.js";

/**
 * generateId()
 *
 * Deliberately NOT a module-level counter — a counter resets to 0 on every
 * page reload, so two events created in the same millisecond across a
 * reload boundary (or across two chat tabs sharing a session) could
 * collide on "evt_<sameTimestamp>_1". Random entropy sidesteps the
 * reload-state problem entirely rather than trying to reseed a counter
 * from the longest existing queue on load (which would need queue access
 * this pure module deliberately doesn't have). Date.now() + 4 random
 * base36 chars gives ~1.7M possible suffixes per millisecond — collision
 * odds are negligible for anything this extension will ever generate.
 */
function generateId() {
    var rand = Math.random().toString(36).slice(2, 6);
    return "evt_" + Date.now().toString(36) + "_" + rand;
}

function toEpoch(timeStr, dateStr) {
    var d = parseDateTime(timeStr, dateStr);
    return d ? d.getTime() : null;
}

// =============================================================================
// CREATE / ENQUEUE
// =============================================================================

/**
 * createEvent(input)
 *
 * input: { actor, action, startTime, startDate, durationMinutes, id?, meta? }
 * Computes executeTime/executeDate deterministically from start + duration.
 * Throws if startTime/startDate can't be parsed — same "hard stop, no
 * silent guessing" policy as TimelineEngine.
 */
export function createEvent(input) {
    input = input || {};
    var base = parseDateTime(input.startTime, input.startDate);
    if (!base) {
        throw new Error("EventQueue.createEvent: startTime/startDate is missing or unparseable.");
    }
    var duration = Math.max(0, Number(input.durationMinutes) || 0);
    var executeDateObj = addMinutesToDate(base, duration);

    // Optional recurrence: a positive integer means "after this event resolves,
    // re-enqueue the next occurrence recurringMinutes later" (e.g. 1440 = daily).
    // Anything malformed/non-positive just means "one-shot", same defensive
    // posture as durationMinutes above.
    var recurring = (typeof input.recurringMinutes === "number" && isFinite(input.recurringMinutes) && input.recurringMinutes > 0)
        ? Math.round(input.recurringMinutes)
        : null;

    return {
        id: input.id || generateId(),
        actor: input.actor || null,
        action: input.action || "",
        startTime: input.startTime,
        startDate: input.startDate,
        durationMinutes: duration,
        executeTime: formatTime(executeDateObj),
        executeDate: formatDate(executeDateObj),
        status: "pending",
        recurringMinutes: recurring,
        meta: input.meta || null,
    };
}

/** Returns a NEW queue array with the event appended. Does not mutate `queue`. */
export function enqueue(queue, eventInput) {
    queue = queue || [];
    var event = createEvent(eventInput);
    return queue.concat([event]);
}

// =============================================================================
// TIME ADVANCEMENT / RESOLUTION
// =============================================================================

/**
 * processTime(queue, currentTime, currentDate)
 *
 * Checks every 'pending' event's executeAt against the current RP clock.
 * Anything due (executeAt <= current, including anything that was skipped
 * PAST due to a large time jump) is marked 'resolved' and returned in
 * `resolved`. Everything else — still-pending events, plus untouched
 * already-resolved/cancelled ones — is returned in `queue` unchanged
 * (as new object references where status changed, per the no-mutation rule).
 *
 * returns: { queue: Event[], resolved: Event[] }
 */
export function processTime(queue, currentTime, currentDate) {
    queue = queue || [];
    var nowEpoch = toEpoch(currentTime, currentDate);
    if (nowEpoch == null) {
        throw new Error("EventQueue.processTime: currentTime/currentDate is missing or unparseable.");
    }

    var resolved = [];
    var nextQueue = queue.map(function (event) {
        if (event.status !== "pending") return event;

        var dueEpoch = toEpoch(event.executeTime, event.executeDate);
        if (dueEpoch != null && dueEpoch <= nowEpoch) {
            var resolvedEvent = Object.assign({}, event, { status: "resolved" });
            resolved.push(resolvedEvent);
            return resolvedEvent;
        }
        return event;
    });

    // Recurring events: each resolved occurrence spawns exactly ONE next pending
    // occurrence. If a large time skip jumped past several occurrences at once,
    // the missed ones are skipped arithmetically (no backlog of instantly-due
    // repeats spamming the next N messages) — the next occurrence always lands
    // strictly in the future relative to the current clock. Cancelling the
    // pending occurrence (cancelEvent/cancelPendingMatching) ends the chain,
    // since re-enqueue only ever happens here, on a genuine resolve.
    var respawned = [];
    resolved.forEach(function (event) {
        if (!event.recurringMinutes || event.recurringMinutes <= 0) return;
        var dueEpoch = toEpoch(event.executeTime, event.executeDate);
        if (dueEpoch == null) return;
        var stepMs = event.recurringMinutes * 60000;
        // O(1) roll-forward past 'now', plus a safety bump for the exact-multiple edge
        // (a next occurrence landing exactly ON the current clock would re-resolve
        // immediately on the very next message).
        var steps = Math.floor((nowEpoch - dueEpoch) / stepMs) + 1;
        var nextEpoch = dueEpoch + steps * stepMs;
        if (nextEpoch <= nowEpoch) nextEpoch += stepMs;
        var prevDue = new Date(dueEpoch);
        var nextDue = new Date(nextEpoch);
        respawned.push({
            id: generateId(),
            actor: event.actor || null,
            action: event.action || "",
            startTime: formatTime(prevDue),
            startDate: formatDate(prevDue),
            durationMinutes: Math.round((nextEpoch - dueEpoch) / 60000),
            executeTime: formatTime(nextDue),
            executeDate: formatDate(nextDue),
            status: "pending",
            recurringMinutes: event.recurringMinutes,
            meta: event.meta || null,
        });
    });

    return { queue: nextQueue.concat(respawned), resolved: resolved };
}

/** Marks a pending event cancelled (kept in the queue for history, not deleted). */
export function cancelEvent(queue, id) {
    queue = queue || [];
    return queue.map(function (event) {
        if (event.id === id && event.status === "pending") {
            return Object.assign({}, event, { status: "cancelled" });
        }
        return event;
    });
}

/**
 * cancelPendingMatching(queue, predicate)
 *
 * Cancels every PENDING event for which predicate(event) returns true — a
 * generalization of cancelEvent() for "this new one supersedes whatever was
 * already queued for the same thing" patterns (e.g. an NPC's earlier
 * in-flight action being replaced by a freshly-generated one, rather than
 * the two stacking as separate overlapping pending events). Pure — returns
 * a NEW array, and (like cancelEvent) never touches already-settled events.
 */
export function cancelPendingMatching(queue, predicate) {
    queue = queue || [];
    if (typeof predicate !== "function") return queue;
    return queue.map(function (event) {
        if (event.status === "pending" && predicate(event)) {
            return Object.assign({}, event, { status: "cancelled" });
        }
        return event;
    });
}

// =============================================================================
// MAINTENANCE
// =============================================================================

/**
 * pruneQueue(queue, maxSettled)
 *
 * The file header's append/merge-only philosophy means resolved/cancelled events are
 * never deleted by processTime()/cancelEvent() — by design, so the history stays
 * inspectable. Left unchecked over a long story that's exactly what it sounds like:
 * unchecked. This is the bounded-cleanup half of that policy — it never touches a
 * 'pending' event (an active/future promise is never at risk of being pruned away),
 * it only caps how much *settled* (resolved + cancelled) history sticks around,
 * dropping the OLDEST settled entries first once the cap is exceeded. Pure —
 * returns a NEW array, same as everything else in this module.
 */
export function pruneQueue(queue, maxSettled) {
    queue = queue || [];
    maxSettled = (typeof maxSettled === "number" && maxSettled >= 0) ? maxSettled : 30;

    var pending = queue.filter(function (e) { return e.status === "pending"; });
    var settled = queue.filter(function (e) { return e.status !== "pending"; });
    if (settled.length <= maxSettled) return queue;

    var withEpoch = settled.map(function (e) {
        var d = parseDateTime(e.executeTime, e.executeDate);
        return { event: e, epoch: d ? d.getTime() : 0 };
    });
    withEpoch.sort(function (a, b) { return b.epoch - a.epoch; }); // most recent first
    var keptIds = {};
    withEpoch.slice(0, maxSettled).forEach(function (w) { keptIds[w.event.id] = true; });

    // Preserve original relative ordering rather than leaving the queue sorted by
    // recency — callers/UI shouldn't have to care that a prune ran.
    return queue.filter(function (e) { return e.status === "pending" || keptIds[e.id]; });
}

// =============================================================================
// QUERIES
// =============================================================================

export function getPending(queue) {
    return (queue || []).filter(function (e) { return e.status === "pending"; });
}

/**
 * getPendingMatching(queue, predicate)
 *
 * Read-only counterpart to cancelPendingMatching() above — same predicate-over-pending-
 * events shape, but only reads, never touches status. Meant for "what is X currently
 * doing" lookups (e.g. surfacing an NPC's in-flight scheduled action next to their name
 * in the World tab) where the caller wants to DISPLAY the match, not cancel it.
 */
export function getPendingMatching(queue, predicate) {
    if (typeof predicate !== "function") return [];
    return getPending(queue).filter(predicate);
}

export function getResolved(queue) {
    return (queue || []).filter(function (e) { return e.status === "resolved"; });
}

/**
 * getUpcoming(queue, currentTime, currentDate, withinMinutes)
 * Pending events whose executeAt falls within the next `withinMinutes` of
 * the current clock — useful for a HUD/preview of "what's about to happen"
 * without actually resolving anything yet.
 */
export function getUpcoming(queue, currentTime, currentDate, withinMinutes) {
    var nowEpoch = toEpoch(currentTime, currentDate);
    if (nowEpoch == null) return [];
    var horizon = nowEpoch + withinMinutes * 60000;

    return getPending(queue).filter(function (event) {
        var dueEpoch = toEpoch(event.executeTime, event.executeDate);
        return dueEpoch != null && dueEpoch >= nowEpoch && dueEpoch <= horizon;
    });
}
