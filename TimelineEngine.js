/*
 * TimelineEngine.js
 * ---------------------------------------------------------------------------
 * ARCHITECTURE (v2 — LLM-driven, replaces the old regex-heuristic pipeline):
 *
 *   BASELINE (always, zero cost): every message advances the RP clock by
 *   config.baseAdvanceMinutes (default 1 minute). This never stops running,
 *   on or off — it's the same "message intervals" fallback philosophy the
 *   Relationship tracker already uses, just expressed as clock-minutes
 *   instead of message-count.
 *
 *   TRIGGER (cheap, local, deliberately dumb): detectTimeSkipTrigger(text)
 *   scans for a SMALL set of high-precision forward-transition phrases
 *   ("the next day", "meanwhile", "3 hours later", "eventually"), OR'd with
 *   the full TIME_OF_DAY_ANCHORS set below (dawn, sunrise, morning, noon/
 *   midday, afternoon, dusk, sunset, evening, night, midnight — both "by/at
 *   X" transition phrasing AND present-tense "it's now X" statements). The
 *   anchor set is defined once, below, and reused for THREE things: seeding
 *   the genesis time, firing this trigger, and (via TIME_ANCHOR_GUIDE)
 *   giving Scene Agent's prompt the exact same target hours to compute
 *   "elapsed" minutes against — so a bare "it's noon" mid-story is just as
 *   recognized as it would be if it opened the RP, and the model always
 *   lands on the same hour genesis would have picked for that label. This
 *   is NOT trying to estimate a duration and NOT trying to be clever — its
 *   only job is "does this look like time might have moved forward, yes or
 *   no". A false positive here just costs one cheap resolver call; it never
 *   touches the clock directly.
 *   Deliberately excludes past-tense/backstory framing ("a few hours ago",
 *   "already", "last night") so those never even reach the resolver, and
 *   deliberately excludes ordinary RP verbs (eating, walking, talking,
 *   fighting) by simply never matching on them in the first place — the
 *   trigger list only contains skip/transition language, not activity verbs.
 *
 *   RESOLVER (opt-in, LLM call — as of Phase 5, folded into SceneAgent's own
 *   prompt rather than a dedicated call; see SceneAgent.js's file header):
 *   when the trigger fires (Smart Time) or Scene's cadence comes due (Message
 *   Mode), Scene Agent's response includes a `time_advance` field, which
 *   index.js validates with TimelineEngine.applyTimeResolverResponse() (via
 *   SceneAgent.applySceneTimeAdvance()). The reply is always ONE of:
 *     - "elapsed"          — real narrative time genuinely passed; advance by N.
 *     - "schedule"         — a promise/ETA was stated ("ship arrives in 3h");
 *                            nothing has happened yet, caller creates an
 *                            EventQueue entry instead of touching the clock.
 *     - "advance_to_event" — the scene is explicitly filling time until an
 *                            already-pending event (e.g. "they talk until
 *                            dinner" with a 6PM event already queued);
 *                            caller resolves the referenced event and this
 *                            module advances EXACTLY to its time.
 *     - "none"             — nothing notable; the baseline +1 minute stands.
 *   The LLM is NEVER handed the ability to set currentTime/currentDate
 *   directly — it only ever proposes a duration (or references an existing
 *   event's time), and applyResolverResult() is the one place that turns
 *   that into an actual clock value, with a hard ceiling either way. This
 *   module still never calls an LLM itself and has no side effects — it's a
 *   pure function of its inputs, same contract as before.
 *
 *   OPT-OUT: if the user disables LLM time-control, only the BASELINE ever
 *   runs — flat +1 minute per message, forever, no trigger checks, no
 *   resolver calls, no regex heuristics of any kind.
 *
 * This file is a standalone ES module with zero dependencies on SillyTavern,
 * jQuery, or index.js globals, so it can be loaded with a plain
 * `await import("./TimelineEngine.js")` and unit tested with plain node.
 * ---------------------------------------------------------------------------
 */

// =============================================================================
// CONFIG
// =============================================================================

export const defaultConfig = {
    baseAdvanceMinutes: 1,    // flat per-message clock advance — ALWAYS applied, LLM control or not
    maxResolverMinutes: 1440, // hard ceiling on an ORDINARY "elapsed"-type answer (one calendar day) —
                               // this is the guard against an ordinary pacing guess going wildly wrong.
    maxExplicitSkipMinutes: 5256000, // ~10 years. Separate, much higher ceiling for an "elapsed" answer
                               // the model has flagged explicitSkip:true on — i.e. the text itself stated
                               // a duration/target beyond a single day ("six months later", "next spring").
                               // Still a hard cap (never fully unbounded — one bad number shouldn't be able
                               // to detonate the calendar), just sized for real narrative skips instead of
                               // ordinary-beat pacing.
                               // "advance_to_event" is not capped here since it's bounded by an
                               // already-existing, already-sane scheduled event's own time.
};

function mergeConfig(overrides) {
    return Object.assign({}, defaultConfig, overrides || {});
}

// =============================================================================
// DATE / TIME HELPERS
// Format convention matches the rest of the extension: HH:MM (24h) and
// DD/MM/YYYY. Self-contained on purpose — no dependency on index.js helpers.
// Depended on directly by Scheduler.js, EventQueue.js, and index.js — keep
// this section's exports stable even across internal rewrites of this file.
// =============================================================================

function padZero(n) {
    return n < 10 ? "0" + n : String(n);
}

/** Parse "HH:MM" + "DD/MM/YYYY" into a JS Date. Returns null if unparseable. */
export function parseDateTime(timeStr, dateStr) {
    if (!timeStr || !dateStr) return null;

    var tParts = String(timeStr).split(":");
    if (tParts.length < 2) return null;
    var hour = parseInt(tParts[0], 10);
    var min = parseInt(tParts[1], 10);
    if (isNaN(hour) || isNaN(min)) return null;

    var dParts = String(dateStr).split(/[\/\-.,]/).map(function (s) { return s.trim(); }).filter(Boolean);
    if (dParts.length < 3) return null;
    var day = parseInt(dParts[0], 10);
    var month = parseInt(dParts[1], 10);
    var year = parseInt(dParts[2], 10);
    if (isNaN(day) || isNaN(month) || isNaN(year)) return null;

    var d = new Date(year, month - 1, day, hour, min, 0, 0);
    return isNaN(d.getTime()) ? null : d;
}

export function formatTime(d) {
    return padZero(d.getHours()) + ":" + padZero(d.getMinutes());
}

export function formatDate(d) {
    return padZero(d.getDate()) + "/" + padZero(d.getMonth() + 1) + "/" + d.getFullYear();
}

// =============================================================================
// PROMPT-FACING TIME DISPLAY — AM/PM + day-part disambiguation
// ---------------------------------------------------------------------------
// The clock is stored and computed in 24h "HH:MM" everywhere (see above) — that
// part is fine and stays unchanged. The problem this section fixes is narrower:
// every tracker prompt (Scene/NPC/Weather/Faction/World/Resolver) was handing
// the model a bare 24h string like "04:00" with no other cue, and 24h times are
// a known LLM weak spot — models frequently misjudge whether e.g. "04:00" or
// "20:00" is day or night, especially right after a time-skip jumps across a
// day boundary with nothing else in context to anchor it. describeTimeOfDay()
// and formatTimeForPrompt() give every prompt an explicit, unambiguous label
// alongside the raw time, so the model never has to infer day/night from a
// bare number. Purely a prompt-display concern — nothing here touches how the
// clock is stored, parsed, or advanced.
// =============================================================================

var DAY_PART_LABELS = [
    { belowHour: 5, label: "night" },          // 00:00-04:59
    { belowHour: 7, label: "early morning" },  // 05:00-06:59
    { belowHour: 12, label: "morning" },       // 07:00-11:59
    { belowHour: 14, label: "midday" },        // 12:00-13:59
    { belowHour: 18, label: "afternoon" },     // 14:00-17:59
    { belowHour: 21, label: "evening" },       // 18:00-20:59
    { belowHour: 24, label: "night" },         // 21:00-23:59
];

/** Returns a plain-English day-part label ("morning", "night", ...) for an "HH:MM" string, or "" if unparseable. */
export function describeTimeOfDay(timeStr) {
    var hour = parseInt(String(timeStr || "").split(":")[0], 10);
    if (isNaN(hour)) return "";
    for (var i = 0; i < DAY_PART_LABELS.length; i++) {
        if (hour < DAY_PART_LABELS[i].belowHour) return DAY_PART_LABELS[i].label;
    }
    return "night";
}

/**
 * formatTimeForPrompt(timeStr)
 * "04:00" -> "04:00 (4:00 AM, night)". Falls back to the raw input unchanged
 * if it can't be parsed, so this is always safe to wrap around any time
 * value headed into a prompt string.
 */
export function formatTimeForPrompt(timeStr) {
    var parts = String(timeStr || "").split(":");
    var hour = parseInt(parts[0], 10);
    var minute = parts[1];
    if (isNaN(hour) || minute == null) return timeStr;
    var meridiem = hour < 12 ? "AM" : "PM";
    var hour12 = hour % 12;
    if (hour12 === 0) hour12 = 12;
    var dayPart = describeTimeOfDay(timeStr);
    return timeStr + " (" + hour12 + ":" + minute + " " + meridiem + (dayPart ? ", " + dayPart : "") + ")";
}

/** Adds minutes to a Date, correctly rolling over day/month/year via native Date math. */
export function addMinutesToDate(date, minutes) {
    return new Date(date.getTime() + minutes * 60000);
}

function resolveBaseDate(previousState) {
    var baseDate = (typeof previousState.currentEpoch === "number" && !isNaN(previousState.currentEpoch))
        ? new Date(previousState.currentEpoch)
        : parseDateTime(previousState.currentTime, previousState.currentDate);
    if (!baseDate) {
        throw new Error("TimelineEngine: previousState.currentTime/currentDate is missing or unparseable.");
    }
    return baseDate;
}

// =============================================================================
// BASELINE — always-on, zero-cost clock advance
// =============================================================================

/**
 * advanceBaseline(previousState, config)
 *
 * The permanent floor under the whole system: every message advances the
 * clock by config.baseAdvanceMinutes (default 1), full stop. This is what
 * runs on its own when LLM time-control is off, and it's also what runs
 * whenever the trigger doesn't fire (or the resolver says "none"/"schedule")
 * when it's on — those two cases never need a *different* clock outcome,
 * only "should we ask" differs.
 */
export function advanceBaseline(previousState, config) {
    config = mergeConfig(config);
    var baseDate = resolveBaseDate(previousState);
    var newDate = addMinutesToDate(baseDate, config.baseAdvanceMinutes);
    return {
        elapsedMinutes: config.baseAdvanceMinutes,
        currentTime: formatTime(newDate),
        currentDate: formatDate(newDate),
        currentEpoch: newDate.getTime(),
        source: "baseline",
    };
}

// =============================================================================
// TRIGGER — cheap, local, deliberately dumb "should we ask the LLM" check
// =============================================================================

// High-precision forward-transition markers ONLY. Not a general-purpose
// duration matcher (that was the entire source of every past false-positive
// bug in the old pipeline: "three hours ago", "the village is three hours
// away", "one day, she'd tell him the truth" all matched a bare number+unit).
// Requiring an explicit forward-transition phrase instead of any number+unit
// mention means ordinary RP prose (eating, walking, talking, fighting) simply
// never matches at all — there is nothing here that looks like an activity
// verb, only skip/transition language.
var TIME_SKIP_TRIGGER_RE = new RegExp(
    "\\b(" + [
        "the next (?:day|morning|night|week|hour)",
        "(?:minutes?|hours?|days?|weeks?)\\s+(?:later|passed?|went by|go(?:es)? by)",
        "after (?:a while|some time|a long while|much time|several (?:hours|days|minutes))",
        "meanwhile",
        "eventually",
        "some time (?:passed|later)",
        "time (?:skip|jump|passes|passed)",
        "by (?:the time|evening|nightfall|dawn|morning|dusk|sunset|sunrise)",
        "when (?:night fell|morning came|dawn broke|the sun (?:rose|set))",
        "hours pass(?:ed)?",
        "days pass(?:ed)?",
        "at dawn|by dawn|dawn (?:breaks|broke)",
        "at dusk|by dusk|dusk (?:falls|fell)",
        "at midnight|by midnight",
        "the following (?:day|morning|night|week|month|year|spring|summer|autumn|winter|season)",
        "a (?:few|couple of|several) (?:hours|days|weeks|months|years) (?:later|pass(?:ed)?|go(?:es)? by)",
        "(?:months?|years?)\\s+(?:later|passed?|went by|go(?:es)? by)",
        "next (?:month|year|spring|summer|autumn|winter|season)",
        "(?:the following|come) (?:spring|summer|autumn|winter)",
    ].join("|") + ")\\b",
    "i"
);

// Safety net, kept intentionally small: if a past-tense/backstory marker is
// present, don't fire at all — even a legitimate-looking transition phrase
// nearby is almost always narrating something already behind the characters
// ("a few hours later, she recalled, they'd found the cave" is describing a
// memory, not a live skip). This is a local, zero-cost short-circuit — no
// resolver call happens at all when this matches, exactly the "should not
// fire" behavior requested for past-event mentions.
var PAST_TENSE_GUARD_RE = /\b(ago|already|earlier|previously|before (?:this|that|now)|last night|yesterday|the other (?:day|night)|used to|remembered|recalled|had already|years? ago|back then|in the past|in (?:her|his|their) dream|nightmares?|flashback)\b/i;

/**
 * detectTimeSkipTrigger(text, customPhrases)
 *
 * Returns true if the message is worth sending to the resolver at all.
 * This is intentionally the ONLY exact-regex step left in this file — its
 * job is "should we bother asking", not "figure out the answer". Erring
 * toward firing a bit more than strictly necessary is fine and expected: a
 * false positive costs one small LLM call (which will itself just answer
 * "none"), never a wrong clock value.
 *
 * Exact phrase match is tried first (cheap, zero false-positive risk beyond
 * what's already tuned into TIME_SKIP_TRIGGER_RE). If that misses, a fuzzy
 * lexicon pass (see below) catches typos and minor paraphrases of the same
 * phrases ("meanwhil", "a good few hours later on") that the exact regex
 * would otherwise let slip through silently. PAST_TENSE_GUARD_RE still
 * short-circuits BOTH passes — a backstory/past-tense marker means "don't
 * even ask", regardless of which pass would have fired.
 *
 * customPhrases: optional array of extra plain-text phrases (the user-editable
 * "extra time-skip phrases" setting, parsed by parseCustomSkipPhrases below) —
 * fuzzy-matched the same way as the built-in lexicon. This is also the ONLY
 * path that works for non-English RP: the built-in regexes/lexicon are
 * English-only, so without custom phrases a non-English story never fires the
 * skip trigger at all and silently degrades to the interval fallback. Omit for
 * the default built-in-only behavior.
 */
export function detectTimeSkipTrigger(text, customPhrases) {
    if (!text) return false;
    if (PAST_TENSE_GUARD_RE.test(text)) return false;
    if (TIME_SKIP_TRIGGER_RE.test(text)) return true;
    // Reuses the SAME anchor table seedInitialTime() scans the genesis
    // message with (see TIME_OF_DAY_ANCHOR_TRIGGER_RE, built further down
    // this file right after TIME_OF_DAY_ANCHORS). Without this, phrasing
    // like "it's noon" or "afternoon arrives" mid-story matched at genesis
    // but was silently invisible to this trigger — Smart Time mode would
    // never fire Scene Agent for it, so the clock just kept ticking on the
    // flat baseline and the stated time-of-day was ignored.
    if (TIME_OF_DAY_ANCHOR_TRIGGER_RE.test(text)) return true;
    return detectTimeSkipTriggerFuzzy(text, customPhrases);
}

// =============================================================================
// FUZZY LEXICON — typo/paraphrase-tolerant backstop for the trigger above.
// Deliberately conservative: this is a SECOND chance for the same narrow set
// of skip/transition phrases TIME_SKIP_TRIGGER_RE already matches, not a
// general "guess if time might have passed" classifier. It only ever adds
// recall for near-misses of the known lexicon; it does not introduce any new
// categories of phrase and does not touch PAST_TENSE_GUARD_RE's veto.
// =============================================================================

// Same phrase set as TIME_SKIP_TRIGGER_RE above, decomposed into ordered
// word-groups for token-level fuzzy scanning. `maxGap` is how many unrelated
// tokens are allowed between consecutive words of the phrase (so "a good few
// hours later on" still hits ["hours","later"] with maxGap 3, but a message
// that merely contains "hours" and "later" 40 words apart does not).
export var TIME_SKIP_LEXICON = [
    { words: ["next", "day"], maxGap: 2 },
    { words: ["next", "morning"], maxGap: 2 },
    { words: ["next", "night"], maxGap: 2 },
    { words: ["next", "week"], maxGap: 2 },
    { words: ["next", "hour"], maxGap: 2 },
    { words: ["hours", "later"], maxGap: 3 },
    { words: ["minutes", "later"], maxGap: 3 },
    { words: ["days", "later"], maxGap: 3 },
    { words: ["weeks", "later"], maxGap: 3 },
    { words: ["hours", "passed"], maxGap: 3 },
    { words: ["days", "passed"], maxGap: 3 },
    { words: ["hours", "go", "by"], maxGap: 2 },
    { words: ["days", "go", "by"], maxGap: 2 },
    { words: ["time", "passed"], maxGap: 2 },
    { words: ["time", "went", "by"], maxGap: 2 },
    { words: ["meanwhile"], maxGap: 0 },
    { words: ["eventually"], maxGap: 0 },
    { words: ["some", "time", "passed"], maxGap: 2 },
    { words: ["some", "time", "later"], maxGap: 2 },
    { words: ["time", "skip"], maxGap: 1 },
    { words: ["time", "jump"], maxGap: 1 },
    { words: ["by", "the", "time"], maxGap: 1 },
    { words: ["by", "evening"], maxGap: 1 },
    { words: ["by", "nightfall"], maxGap: 1 },
    { words: ["by", "dawn"], maxGap: 1 },
    { words: ["by", "morning"], maxGap: 1 },
    { words: ["by", "dusk"], maxGap: 1 },
    { words: ["by", "sunset"], maxGap: 1 },
    { words: ["by", "sunrise"], maxGap: 1 },
    { words: ["night", "fell"], maxGap: 2 },
    { words: ["morning", "came"], maxGap: 2 },
    { words: ["dawn", "broke"], maxGap: 2 },
    { words: ["dawn", "breaks"], maxGap: 2 },
    { words: ["dusk", "falls"], maxGap: 2 },
    { words: ["dusk", "fell"], maxGap: 2 },
    { words: ["sun", "rose"], maxGap: 2 },
    { words: ["sun", "set"], maxGap: 2 },
    { words: ["at", "midnight"], maxGap: 1 },
    { words: ["following", "day"], maxGap: 2 },
    { words: ["following", "morning"], maxGap: 2 },
    { words: ["following", "night"], maxGap: 2 },
    { words: ["following", "week"], maxGap: 2 },
    { words: ["following", "month"], maxGap: 2 },
    { words: ["following", "year"], maxGap: 2 },
    { words: ["months", "later"], maxGap: 3 },
    { words: ["years", "later"], maxGap: 3 },
    { words: ["months", "passed"], maxGap: 3 },
    { words: ["years", "passed"], maxGap: 3 },
    { words: ["next", "month"], maxGap: 2 },
    { words: ["next", "year"], maxGap: 2 },
    { words: ["next", "spring"], maxGap: 2 },
    { words: ["next", "summer"], maxGap: 2 },
    { words: ["next", "autumn"], maxGap: 2 },
    { words: ["next", "winter"], maxGap: 2 },
];

function tokenizeForFuzzy(text) {
    // Unicode letters/numbers, not [a-z] — the custom-phrase feature exists largely
    // FOR non-English RP, and an ASCII-only tokenizer reduced any Cyrillic/CJK
    // phrase (and the message text being scanned against it) to zero tokens,
    // making custom phrases silently dead for exactly the users who need them.
    // The built-in lexicon is ASCII, so its matching is unaffected.
    return String(text || "").toLowerCase().match(/[\p{L}\p{N}']+/gu) || [];
}

/**
 * parseCustomSkipPhrases(text)
 *
 * Turns the settings textarea ("one phrase per line") into the customPhrases
 * array detectTimeSkipTrigger() accepts. Blank lines and surrounding whitespace
 * are dropped; phrase length and count are capped so a runaway paste can't turn
 * the per-message fuzzy scan expensive. Returns null (not []) when nothing
 * usable remains, so callers can pass the result straight through.
 */
export function parseCustomSkipPhrases(text) {
    if (!text || typeof text !== "string") return null;
    var phrases = text.split(/\r?\n/)
        .map(function (line) { return line.trim(); })
        .filter(Boolean)
        .map(function (line) { return line.slice(0, 80); })
        .slice(0, 50);
    return phrases.length > 0 ? phrases : null;
}

/** Bounded Levenshtein distance — bails out early once the distance is provably > max. */
function boundedLevenshtein(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    var prev = [];
    for (var j = 0; j <= b.length; j++) prev[j] = j;
    for (var i = 1; i <= a.length; i++) {
        var cur = [i];
        var rowMin = cur[0];
        for (var j2 = 1; j2 <= b.length; j2++) {
            var cost = a[i - 1] === b[j2 - 1] ? 0 : 1;
            var val = Math.min(prev[j2] + 1, cur[j2 - 1] + 1, prev[j2 - 1] + cost);
            cur[j2] = val;
            if (val < rowMin) rowMin = val;
        }
        if (rowMin > max) return max + 1; // entire row already exceeds budget
        prev = cur;
    }
    return prev[b.length];
}

/**
 * fuzzyWordEquals(word, target)
 * Exact match always accepted. Typo tolerance (edit distance <= 1) only
 * kicks in for target words of 4+ chars — short words ("by", "at", "day",
 * "set"...) stay EXACT-only, since a distance-1 allowance on a 2-3 letter
 * word matches almost anything and would gut precision. This is further
 * constrained by phrase context: even a matched word only counts if the
 * rest of its phrase also lines up within maxGap, so a stray 4-letter
 * near-match on its own is never enough by itself.
 */
function fuzzyWordEquals(word, target) {
    if (word === target) return true;
    if (target.length < 4) return false;
    return boundedLevenshtein(word, target, 1) <= 1;
}

/**
 * fuzzyPhraseMatch(tokens, phraseWords, maxGap)
 * True if phraseWords appear, in order, somewhere in tokens — each word
 * fuzzy-matched via fuzzyWordEquals(), with at most maxGap unrelated tokens
 * tolerated between consecutive phrase words.
 */
function fuzzyPhraseMatch(tokens, phraseWords, maxGap) {
    for (var start = 0; start < tokens.length; start++) {
        if (!fuzzyWordEquals(tokens[start], phraseWords[0])) continue;
        var ti = start + 1;
        var ok = true;
        for (var pi = 1; pi < phraseWords.length; pi++) {
            var found = -1;
            for (var look = ti; look <= Math.min(tokens.length - 1, ti + maxGap); look++) {
                if (fuzzyWordEquals(tokens[look], phraseWords[pi])) { found = look; break; }
            }
            if (found === -1) { ok = false; break; }
            ti = found + 1;
        }
        if (ok) return true;
    }
    return false;
}

/**
 * detectTimeSkipTriggerFuzzy(text, customPhrases)
 * The fuzzy pass itself — does NOT apply PAST_TENSE_GUARD_RE, so callers
 * should generally use detectTimeSkipTrigger() (which wraps this) rather
 * than calling this directly.
 */
export function detectTimeSkipTriggerFuzzy(text, customPhrases) {
    if (!text) return false;
    var tokens = tokenizeForFuzzy(text);
    if (tokens.length === 0) return false;

    var hit = TIME_SKIP_LEXICON.some(function (entry) {
        return fuzzyPhraseMatch(tokens, entry.words, entry.maxGap);
    });
    if (hit) return true;

    if (customPhrases && customPhrases.length > 0) {
        return customPhrases.some(function (phrase) {
            var words = tokenizeForFuzzy(phrase);
            return words.length > 0 && fuzzyPhraseMatch(tokens, words, 1);
        });
    }
    return false;
}

// =============================================================================
// RESOLVER — response contract only (index.js makes the actual LLM call)
// ---------------------------------------------------------------------------
// NOTE: as of Phase 5 (see SceneAgent.js's file header), time-authority lives
// inside SceneAgent's own prompt (its `time_advance` field) — there is no more
// standalone "Time Passage Resolver" LLM call, so this file no longer builds
// its own dedicated prompt for one. What DOES still live here, and is still
// actively used:
//   - VALID_RESOLVER_TYPES + applyTimeResolverResponse(): the shared
//     validation contract SceneAgent.applySceneTimeAdvance() runs the model's
//     `time_advance` answer through.
//   - applyResolverResult(): turns a validated result into an actual clock
//     value — called directly by index.js.
//   - PACING_EXAMPLE_GUIDE: the calibration reference spliced into
//     SceneAgent's prompt (imported from there).
// =============================================================================

var VALID_RESOLVER_TYPES = ["elapsed", "schedule", "advance_to_event", "none"];

// Calibration reference for "how many minutes does this beat realistically take" —
// not a lookup table the model should treat as exact, just realistic anchor points
// so "elapsed" guesses land in a sane range instead of being pulled from nowhere.
// Spliced into SceneAgent's prompt (see SceneAgent.js's import of this).
export var PACING_EXAMPLE_GUIDE =
    "PACING GUIDE (realistic anchor points, not a rigid table — use judgment):\n" +
    "- A quick line of dialogue or a single reaction: ~1-3 minutes\n" +
    "- A short back-and-forth conversation: ~3-10 minutes\n" +
    "- Walking to a nearby room or location in the same building: ~2-8 minutes\n" +
    "- Traveling across town or a district: ~15-45 minutes\n" +
    "- A tense standoff or brief skirmish: ~5-15 minutes\n" +
    "- A full combat encounter: ~10-30 minutes\n" +
    "- Getting ready, changing clothes, eating a meal: ~10-30 minutes\n" +
    "- An extended activity summarized in a sentence (\"they spent the afternoon...\"): could be hours\n" +
    "- An explicit stated skip WITH a duration or specific time-of-day (\"three days later\", \"the next morning\", \"by sunset\"): trust the stated duration/target — compute minutes from the clock stated above to land exactly there (e.g. \"the next morning\" from 23:00 means a jump to roughly 07:00-09:00 the following day, not a flat +24h that would land back at 23:00).\n" +
    "- A vague day-boundary phrase with NO stated time-of-day (\"the next day\", \"the following day\", \"a new day\"): still compute from the clock stated above rather than defaulting to a flat +24h — land at a reasonable waking hour (roughly 07:00-09:00) the following day, UNLESS the current time is already in the morning, in which case a same-time-next-day jump is also reasonable. The point is the result should make sense against the current day/night state, not just add exactly 1440 minutes.\n" +
    "- A LARGE explicit skip the text itself states — a specific number of weeks/months/years (\"three weeks later\", \"six months later\", \"two years passed\") or a clear seasonal/calendar target (\"next spring\", \"the following winter\") — set explicit_skip:true and report the FULL real minutes for that duration. Do not round it down or silently substitute a smaller \"safe\" number: an explicit_skip answer is trusted against a much higher ceiling than an ordinary pacing guess, so under-reporting it is the actual mistake here, not over-reporting.\n";

/**
 * applyTimeResolverResponse(data)
 *
 * Validates and normalizes the LLM's JSON reply. Falls back to a safe
 * { type: "none" } on anything malformed, missing, or not one of the four
 * known types — an invalid response should never accidentally do nothing
 * (that's what "none" already means) NOR accidentally do something huge.
 */
export function applyTimeResolverResponse(data) {
    if (!data || VALID_RESOLVER_TYPES.indexOf(data.type) === -1) {
        return { type: "none", minutes: 0, reason: "invalid or missing resolver response" };
    }

    var type = data.type;
    var minutes = Math.max(0, Number(data.minutes) || 0);
    var reason = String(data.reason || data.description || "").trim();

    if (type === "schedule") {
        return {
            type: "schedule",
            minutes: minutes,
            description: String(data.description || reason || "Scheduled event").trim(),
            reason: reason,
        };
    }
    if (type === "advance_to_event") {
        var idx = Number(data.eventIndex);
        if (isNaN(idx) || idx < 1) return { type: "none", minutes: 0, reason: "advance_to_event missing a valid eventIndex" };
        return { type: "advance_to_event", eventIndex: Math.floor(idx), reason: reason };
    }
    if (type === "elapsed") {
        return { type: "elapsed", minutes: minutes, reason: reason, explicitSkip: !!data.explicit_skip };
    }
    return { type: "none", minutes: 0, reason: reason };
}

/**
 * applyResolverResult(previousState, resolverResult, config)
 *
 * Turns a validated resolver result into an actual clock value. ONLY ever
 * called by the caller for "elapsed" or "advance_to_event" types — "schedule"
 * and "none" never touch the clock beyond the baseline advance that already
 * ran this message, so the caller should simply keep advanceBaseline()'s
 * result for those two cases rather than calling this at all.
 *
 * For "advance_to_event", `resolverResult.minutes` must already be the exact
 * minutes-until-target that the caller computed from the actual pending
 * event's stored time/date (this module has no access to the EventQueue
 * itself, by design — it only ever receives a plain number).
 *
 * previousState should be the anchor from BEFORE this message's baseline
 * advance — i.e. elapsed/advance_to_event REPLACE the flat +1 rather than
 * stacking on top of it.
 */
export function applyResolverResult(previousState, resolverResult, config) {
    config = mergeConfig(config);
    var baseDate = resolveBaseDate(previousState);

    var minutes = Math.max(0, Number(resolverResult.minutes) || 0);
    var explicitSkip = !!resolverResult.explicitSkip;
    if (resolverResult.type === "elapsed") {
        var cap = explicitSkip ? config.maxExplicitSkipMinutes : config.maxResolverMinutes;
        minutes = Math.min(cap, minutes);
    }
    // "advance_to_event" is intentionally NOT capped here — it's bounded by an
    // already-existing, already-sane scheduled event's own time, not a fresh guess.

    var newDate = addMinutesToDate(baseDate, minutes);
    return {
        elapsedMinutes: minutes,
        currentTime: formatTime(newDate),
        currentDate: formatDate(newDate),
        currentEpoch: newDate.getTime(),
        source: resolverResult.type,
        explicitSkip: explicitSkip,
    };
}

// =============================================================================
// GENESIS SEEDING — determining the STARTING time from the opening message
// (unchanged from before: deterministic anchor/clock-time scan, no LLM, no
// guessing. This runs once, at RP start, not on every message.)
// =============================================================================

// Each anchor covers TWO phrasing families: transition/statement forms ("it's
// morning", "morning came", "by dusk") AND descriptive scene-setting prose
// ("the morning sun filtered...", "it was a cold evening", "night had fallen").
// The second family is how RP opening messages are almost always written —
// without it, genesis seeding matched mid-story transitions fine but missed
// nearly every real greeting, silently falling back to the 12:00 default.
// Descriptive forms are kept high-confidence (day-part noun + a scene noun, or
// an explicit "it was ..." statement) rather than matching the bare word, so
// "she thought about that morning" still doesn't fire.
export var TIME_OF_DAY_ANCHORS = [
    { re: /\bat dawn\b|\bby dawn\b|\bdawn (?:breaks|broke)\b|\b(?:it'?s|it is)\s+(?:now\s+)?dawn\b|\bit was (?:nearly |almost |just )?dawn\b|\b(?:the )?dawn (?:light|sky|air|mist)\b/i, hour: 6, minute: 0, label: "dawn" },
    { re: /\bat sunrise\b|\bthe sun (?:rises|rose|was rising)\b|\bsunrise (?:breaks|broke)\b/i, hour: 6, minute: 30, label: "sunrise" },
    { re: /\b(?:it'?s|it is)\s+(?:now\s+)?morning\b|\bmorning (?:arrives|arrived|comes|came|breaks|broke)\b|\bit was (?:a |an )?(?:early |late |cold |warm |gray |grey |bright |quiet )*morning\b|\b(?:the )?(?:early |late )?morning (?:sun|light|sunlight|air|breeze|mist|fog|chill|dew)\b/i, hour: 8, minute: 0, label: "morning" },
    { re: /\bat noon\b|\bby noon\b|\bby midday\b|\b(?:it'?s|it is)\s+(?:now\s+)?(?:noon|midday)\b|\bit was (?:nearly |almost |just past )?(?:noon|midday)\b|\b(?:the )?midday (?:sun|heat|light)\b/i, hour: 12, minute: 0, label: "noon" },
    { re: /\bby afternoon\b|\b(?:it'?s|it is)\s+(?:now\s+)?afternoon\b|\bafternoon (?:arrives|arrived|comes|came)\b|\bit was (?:a |an )?(?:early |late |lazy |warm |hot )*afternoon\b|\b(?:the )?(?:early |late )?afternoon (?:sun|light|sunlight|heat|air|breeze)\b/i, hour: 15, minute: 0, label: "afternoon" },
    { re: /\bat dusk\b|\bby dusk\b|\bdusk (?:falls|fell|arrives|arrived|settles|settled)\b|\bit was (?:nearly |almost )?dusk\b/i, hour: 18, minute: 0, label: "dusk" },
    { re: /\bat sunset\b|\bthe sun (?:sets|set|was setting)\b|\bsunset (?:falls|fell|arrives|arrived)\b/i, hour: 18, minute: 30, label: "sunset" },
    { re: /\b(?:it'?s|it is)\s+(?:now\s+)?evening\b|\bevening (?:arrives|arrived|comes|came|falls|fell|settles|settled)\b|\bit was (?:a |an )?(?:early |late |cold |warm |cool |quiet |rainy |stormy )*evening\b|\b(?:the )?(?:early |late )?evening (?:sun|light|air|breeze|sky|chill|rain)\b/i, hour: 19, minute: 0, label: "evening" },
    { re: /\b(?:it'?s|it is)\s+(?:now\s+)?night\b|\bnight (?:falls|fell|arrives|arrived|settles|settled)\b|\bnightfall\b|\bnight had (?:fully )?(?:fallen|settled|descended)\b|\bit was (?:a |an )?(?:late |cold |dark |quiet |stormy |moonless |moonlit )*night\b|\b(?:the )?night (?:air|sky|breeze|chill|rain)\b|\bmoonlight\b|\bmoonlit\b/i, hour: 22, minute: 0, label: "night" },
    { re: /\bat midnight\b|\bby midnight\b|\b(?:it'?s|it is)\s+(?:now\s+)?midnight\b|\bit was (?:nearly |almost |just past )?midnight\b/i, hour: 0, minute: 0, label: "midnight" },
];

/**
 * TIME_OF_DAY_ANCHOR_TRIGGER_RE
 *
 * Every anchor regex above, OR'd into one pattern. Referenced by
 * detectTimeSkipTrigger() further up this file (function bodies resolve
 * module bindings at call time, so the earlier reference to this
 * later-declared var is safe — this whole module is fully evaluated before
 * any external caller can invoke detectTimeSkipTrigger). This is what
 * closes the gap where a mid-story "it's noon" / "afternoon arrives" was
 * recognized at genesis but invisible to the ongoing Smart Time trigger.
 */
var TIME_OF_DAY_ANCHOR_TRIGGER_RE = new RegExp(
    TIME_OF_DAY_ANCHORS.map(function (a) { return a.re.source; }).join("|"),
    "i"
);

/**
 * TIME_ANCHOR_GUIDE
 *
 * The same hour:minute pegs as TIME_OF_DAY_ANCHORS above, formatted for
 * splicing into SceneAgent's prompt (see SceneAgent.js's import and its use
 * alongside PACING_EXAMPLE_GUIDE). PACING_EXAMPLE_GUIDE already tells the
 * model how to compute minutes for a FUTURE transition phrase ("the next
 * morning", "by sunset") — this covers the other case: the text asserts the
 * CURRENT moment directly ("it's now afternoon", "noon has come", "evening
 * falls"). Without a concrete anchor hour to target, the model has to
 * improvise its own number for "afternoon", which won't necessarily agree
 * with what genesis seeding (or the trigger above) would have picked for
 * the same word — this guarantees all three agree.
 */
export var TIME_ANCHOR_GUIDE =
    "TIME-OF-DAY ANCHOR HOURS (use when the text states the CURRENT moment directly as one of these labels — \"it's now afternoon\", \"noon has come\", \"evening falls\" — rather than a future transition already covered above; compute minutes from the clock stated above to land at the matching anchor hour):\n" +
    TIME_OF_DAY_ANCHORS.map(function (a) {
        return "- " + a.label + " \u2248 " + padZero(a.hour) + ":" + padZero(a.minute);
    }).join("\n") + "\n" +
    "If the named anchor's hour has ALREADY passed for the current day (e.g. the clock above reads 20:00 and the text says \"it's now morning\"), land on that anchor the FOLLOWING day — never move the clock backward to reach it.\n";

// Literal clock times stated in prose: "3pm", "9:30 AM", "at 14:00"
var CLOCK_TIME_PATTERN = /\b(\d{1,2})(?::(\d{2}))?\s?(am|pm)\b/i;
var CLOCK_TIME_24H_PATTERN = /\bat (\d{1,2}):(\d{2})\b/i;

function convertTo24Hour(hour, minute, meridiem) {
    hour = hour % 12;
    if (meridiem.toLowerCase() === "pm") hour += 12;
    return { hour: hour, minute: minute };
}

/**
 * seedInitialTime(introText)
 *
 * Scans the opening message ONCE, at RP start, for a deterministic time cue
 * — either a time-of-day anchor ("morning", "dusk") or a literal clock time
 * ("9:00 AM"). Takes the FIRST cue found in reading order (an opening
 * scene-setting sentence is establishing the moment, not escalating through
 * several the way a mid-RP skip might).
 *
 * Returns { time: "HH:MM", confidence: 1.0, reason } if a deterministic cue
 * was found, or null if the text gives no clue at all — this module never
 * fabricates a time and never calls an LLM; a null return is an honest
 * signal that the caller (index.js) must decide its own fallback (a fixed
 * neutral default, or a one-time LLM extraction call).
 *
 * NOTE: this only ever determines a TIME, never a DATE — a bare mention of
 * "morning" gives no year/month/day, only an explicit calendar date could,
 * which is rare enough in RP openings that it's left to the caller/settings.
 */
export function seedInitialTime(introText) {
    if (!introText) return null;

    var anchorHit = null;
    var earliestIndex = Infinity;
    TIME_OF_DAY_ANCHORS.forEach(function (a) {
        var m = introText.match(a.re);
        if (m && m.index < earliestIndex) {
            earliestIndex = m.index;
            anchorHit = a;
        }
    });

    var clockMatch = introText.match(CLOCK_TIME_PATTERN);
    var clock24Match = introText.match(CLOCK_TIME_24H_PATTERN);
    var clockMatchIndex = clockMatch ? clockMatch.index : Infinity;
    var clock24MatchIndex = clock24Match ? clock24Match.index : Infinity;
    var clockIndex = Math.min(clockMatchIndex, clock24MatchIndex);

    // Bugfix: previously this picked whichever pattern object existed (preferring
    // clockMatch unconditionally) rather than whichever pattern actually occurred
    // FIRST in the text. That meant a genuinely earlier "at 14:00" could lose to a
    // later "3pm" mention, or get skipped in favor of a time-of-day anchor that
    // actually appeared after it. Now we compare indices directly and use whichever
    // literal-clock pattern truly comes first.
    if (clockIndex < earliestIndex) {
        if (clockMatchIndex <= clock24MatchIndex) {
            var h = parseInt(clockMatch[1], 10);
            var min = clockMatch[2] ? parseInt(clockMatch[2], 10) : 0;
            var converted = convertTo24Hour(h, min, clockMatch[3]);
            return {
                time: padZero(converted.hour) + ":" + padZero(converted.minute),
                confidence: 1.0,
                reason: "genesis: literal clock time \"" + clockMatch[0].trim() + "\" in opening text",
                source: "genesis-clock",
            };
        }
        var h24 = parseInt(clock24Match[1], 10);
        var min24 = parseInt(clock24Match[2], 10);
        return {
            time: padZero(h24) + ":" + padZero(min24),
            confidence: 1.0,
            reason: "genesis: literal clock time \"" + clock24Match[0].trim() + "\" in opening text",
            source: "genesis-clock",
        };
    }

    if (anchorHit) {
        return {
            time: padZero(anchorHit.hour) + ":" + padZero(anchorHit.minute),
            confidence: 1.0,
            reason: "genesis: time-of-day cue \"" + anchorHit.label + "\" in opening text",
            source: "genesis-anchor",
        };
    }

    return null;
}

// =============================================================================
// SEASON — pure calendar-month lookup, for lightly grounding World/Weather
// prompts ("it's winter, so...") without any new LLM plumbing. Deliberately
// simple: month-based only, no leap/equinox precision, because the prompt
// use case is texture, not simulation accuracy. Returns null (not a guess)
// when the date can't be parsed, same "honest null over fabricated value"
// policy as seedInitialTime — the caller decides whether to omit the block.
// =============================================================================

// Index 0 = January. Meteorological seasons (Dec/Jan/Feb = winter, etc.),
// not astronomical — close enough for narrative grounding and avoids
// equinox-date edge cases entirely.
var SEASON_BY_MONTH_NORTHERN = [
    "winter", "winter", "spring", "spring", "spring", "summer",
    "summer", "summer", "autumn", "autumn", "autumn", "winter",
];
var SOUTHERN_OPPOSITE = { winter: "summer", summer: "winter", spring: "autumn", autumn: "spring" };

/**
 * getSeason(dateStr, hemisphere)
 *
 * dateStr: "DD/MM/YYYY" (same format used everywhere else in this module).
 * hemisphere: "northern" (default) or "southern". Fantasy/sci-fi settings
 * with no real-world calendar mapping should just not call this — it's an
 * optional grounding aid, never a value forced into a prompt.
 */
export function getSeason(dateStr, hemisphere) {
    var parts = String(dateStr || "").split(/[\/\-.,]/).map(function (s) { return s.trim(); }).filter(Boolean);
    if (parts.length < 2) return null;
    var month = parseInt(parts[1], 10);
    if (isNaN(month) || month < 1 || month > 12) return null;

    var northernSeason = SEASON_BY_MONTH_NORTHERN[month - 1];
    return hemisphere === "southern" ? SOUTHERN_OPPOSITE[northernSeason] : northernSeason;
}

/**
 * formatSeasonForPrompt(dateStr, hemisphere)
 * "15/01/2026" -> "winter". Returns "" (never a fabricated value) if the
 * date can't be parsed — safe to always splice into a prompt string, same
 * fail-open-to-empty-string convention as formatTimeForPrompt falling back
 * to the raw input on a parse failure.
 */
export function formatSeasonForPrompt(dateStr, hemisphere) {
    return getSeason(dateStr, hemisphere) || "";
}
