/*
 * Scheduler.js
 * ---------------------------------------------------------------------------
 * ROLE: decide WHAT needs updating. Never decides HOW an update happens —
 * that's the tracker prompts' job (Scene Agent, World Agent, Relationship
 * Agent, etc.), invoked by index.js after consulting this module.
 *
 * Each tier (scene, npc, weather, faction, world, ...) has its own cadence
 * in RP-minutes. Every time TimelineEngine reports elapsedMinutes for a
 * message, that amount is added to EVERY tier's running accumulator. A tier
 * becomes "due" once its accumulator reaches its configured interval.
 *
 * CATCHUP HANDLING: if a big time skip pushes a tier's accumulator past
 * MULTIPLE intervals at once (e.g. "three days later" pushes a 120-minute
 * weather tier past its threshold 36 times), this module caps how many
 * ticks fire in one evaluate() call (`maxCatchupTicks`), same principle as
 * the old extension's `maxWorldTicks` cap. Anything beyond the cap is NOT
 * discarded — its interval-time remains in the accumulator and will trigger
 * again on the next evaluate() call. Nothing is silently lost, only
 * deferred, mirroring how the old World Agent's lastTickTime worked.
 *
 * Pure module, zero dependencies beyond TimelineEngine's date helpers
 * (reused so tick timestamps use the exact same DD/MM/YYYY + HH:MM format
 * and rollover math as the rest of the engine — no duplicated date logic).
 * ---------------------------------------------------------------------------
 */

import { parseDateTime, addMinutesToDate, formatTime, formatDate } from "./TimelineEngine.js";

// =============================================================================
// CONFIG
// =============================================================================

// Natural dependency order — scene is the innermost/fastest tier (what's
// immediately visible), world is the outermost/slowest (big-picture,
// geopolitical-scale). index.js should generally process due tiers in this
// order, since higher tiers (world) often want the lower tiers' freshly
// updated state (e.g. current scene) as context.
export const defaultTierOrder = ["scene", "npc", "weather", "faction", "world"];

export const defaultSchedulerConfig = {
    intervals: {
        scene: 5,      // minutes
        npc: 30,
        weather: 1440,
        faction: 360,
        world: 1440,
    },
    // Global fallback cap on how many ticks a single tier can catch up on
    // in one evaluate() call. Can be overridden per-tier below.
    maxCatchupTicks: 3,
    // Optional per-tier overrides, e.g. { world: 1 } to force world-tier
    // catchups to always collapse into a single tick regardless of the
    // global default. Any tier not listed here falls back to the global
    // maxCatchupTicks number above.
    maxCatchupTicksPerTier: {},
    // Per-tier: when the catchup cap is hit, should the leftover (undue-to-cap)
    // backlog be DISCARDED instead of carried forward in `accumulated`?
    //
    // The default (false / unlisted) behavior — defer — is correct for tiers
    // where a caller actually uses the tick COUNT for something (e.g. the
    // faction tier tags each generated event to a specific point across a
    // batched timestamp list, so catching up gradually over a few messages
    // makes sense and nothing is lost, only spread out).
    //
    // Tiers marked true here instead fire ONCE per due-tier no matter how
    // large the backlog is (their caller only ever looks at "is this tier
    // due", never the tick count) — for those, deferring gains nothing but
    // creates a stranded remainder that stays >= interval and re-triggers
    // 'due' on every subsequent message until it fully drains, even though
    // the one real update already happened. Discarding the excess instead
    // means: still bounded to maxCatchupTicks worth of "gap" for the prompt,
    // fires once, and the accumulator cleanly resets — no stranded debt, and
    // no risk of a single bad elapsed-time estimate forcing an oversized
    // batch through in one call.
    discardExcessTicksPerTier: {},
};

function mergeConfig(overrides) {
    overrides = overrides || {};
    return {
        intervals: Object.assign({}, defaultSchedulerConfig.intervals, overrides.intervals),
        maxCatchupTicks: overrides.maxCatchupTicks != null ? overrides.maxCatchupTicks : defaultSchedulerConfig.maxCatchupTicks,
        maxCatchupTicksPerTier: Object.assign({}, defaultSchedulerConfig.maxCatchupTicksPerTier, overrides.maxCatchupTicksPerTier),
        discardExcessTicksPerTier: Object.assign({}, defaultSchedulerConfig.discardExcessTicksPerTier, overrides.discardExcessTicksPerTier),
    };
}

function resolveMaxTicks(config, tier) {
    if (config.maxCatchupTicksPerTier.hasOwnProperty(tier)) {
        return config.maxCatchupTicksPerTier[tier];
    }
    return config.maxCatchupTicks;
}

// =============================================================================
// PUBLIC ENTRY POINT
// =============================================================================

/**
 * evaluate(input)
 *
 * input: {
 *   elapsedMinutes: number,       // from this message's TimelineEngine clock advance (baseline or resolver)
 *   accumulated: {                // per-tier running total since each tier's last tick
 *     scene: number, npc: number, weather: number, faction: number, world: number, ...
 *   },
 *   config: {...}                 // optional partial override of defaultSchedulerConfig
 * }
 *
 * returns: {
 *   due: {
 *     [tier]: {
 *       tier, ticksDue, ticksDeferred, intervalMinutes
 *     }
 *   },                             // only tiers that are actually due are present here
 *   accumulated: {...}             // updated running totals — caller MUST persist this
 * }
 *
 * A tier with ticksDeferred > 0 means it hit the catchup cap this round —
 * the remaining due-time was preserved in `accumulated` and will surface
 * again (fully or partially) on a future evaluate() call as elapsedMinutes
 * keeps accruing, never silently dropped.
 */
export function evaluate(input) {
    input = input || {};
    var config = mergeConfig(input.config);
    var elapsedMinutes = input.elapsedMinutes || 0;
    var accumulated = input.accumulated || {};

    var due = {};
    var newAccumulated = {};

    Object.keys(config.intervals).forEach(function (tier) {
        var interval = config.intervals[tier];
        if (!interval || interval <= 0) {
            // Misconfigured/disabled tier (interval 0 or missing) — never fires.
            newAccumulated[tier] = 0;
            return;
        }

        var prevAccum = accumulated[tier] || 0;
        var total = prevAccum + elapsedMinutes;
        var ticksDue = Math.floor(total / interval);

        if (ticksDue <= 0) {
            newAccumulated[tier] = total;
            return;
        }

        var maxTicks = resolveMaxTicks(config, tier);
        var cappedTicks = Math.min(ticksDue, maxTicks);

        if (cappedTicks <= 0) {
            // maxCatchupTicks (or a per-tier override) configured to 0 — without this
            // guard the tier would still be marked "due" below with ticksDue: 0, which
            // fires the tier's LLM call with zero elapsed time instead of correctly
            // treating it as "not due yet." Keep the full backlog in the accumulator
            // (never discarded here, regardless of discardExcessTicksPerTier) so a
            // misconfigured cap of 0 doesn't silently throw away the pending time.
            newAccumulated[tier] = total;
            return;
        }

        var consumed = cappedTicks * interval;
        var remainder = total - consumed;
        var discardExcess = !!config.discardExcessTicksPerTier[tier];

        newAccumulated[tier] = discardExcess ? 0 : remainder;
        due[tier] = {
            tier: tier,
            ticksDue: cappedTicks,
            ticksDeferred: discardExcess ? 0 : (ticksDue - cappedTicks),
            intervalMinutes: interval,
        };
    });

    return { due: due, accumulated: newAccumulated };
}

/**
 * computeTickTimestamps(previousTime, previousDate, intervalMinutes, tickCount)
 *
 * Given a tier's last-fired time/date, its interval, and how many ticks are
 * due, returns an array of { time, date } — one per tick, evenly spaced —
 * for the caller to hand to a tracker prompt (e.g. as the interval list in
 * a batched World Agent call). Pure date math, reuses TimelineEngine's
 * formatting so output is always consistent with the rest of the engine.
 */
export function computeTickTimestamps(previousTime, previousDate, intervalMinutes, tickCount) {
    var base = parseDateTime(previousTime, previousDate);
    if (!base) {
        throw new Error("Scheduler.computeTickTimestamps: previousTime/previousDate is missing or unparseable.");
    }

    var out = [];
    for (var i = 1; i <= tickCount; i++) {
        var d = addMinutesToDate(base, i * intervalMinutes);
        out.push({ time: formatTime(d), date: formatDate(d) });
    }
    return out;
}

/**
 * orderDueTiers(due, tierOrder)
 *
 * Returns the due tiers sorted into the recommended processing order
 * (scene first, world last, by default) so index.js doesn't have to decide
 * the ordering itself. Tiers not present in `due` are skipped. Tiers
 * present in `due` but missing from tierOrder are appended at the end,
 * preserving Object.keys() order as a fallback rather than being dropped.
 */
export function orderDueTiers(due, tierOrder) {
    tierOrder = tierOrder || defaultTierOrder;
    var seen = {};
    var ordered = [];

    tierOrder.forEach(function (tier) {
        if (due.hasOwnProperty(tier)) {
            ordered.push(due[tier]);
            seen[tier] = true;
        }
    });
    Object.keys(due).forEach(function (tier) {
        if (!seen[tier]) ordered.push(due[tier]);
    });

    return ordered;
}
