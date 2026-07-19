/*
 * SceneAgent.js
 * ---------------------------------------------------------------------------
 * Phase 3 of the Timeline Engine rewrite — Phase 5 update below.
 *
 * PHASE 3 (superseded in part, see PHASE 5): the Scene Tracker LLM call was
 * asked to determine time AND date itself (data.time / data.date in the
 * response), which is exactly the dependency that caused the World Agent's
 * clock to desync — the RP clock only moved when this call happened to fire
 * on its own message-count interval, in whatever irregular chunks the model
 * felt like reporting. Phase 3 fixed that by handing Scene Agent a FIXED
 * clock computed by a separate, dedicated Time Resolver call and never
 * asking Scene to report time back at all.
 *
 * PHASE 5 (this version): time-authority is folded BACK into this same
 * call, mirroring the original single-call design's efficiency — one LLM
 * call per update decides both the scene AND how much time just passed.
 * There is no more standalone Time Resolver call. But this is NOT a
 * reversion to the old, weaker contract that let the model invent a raw
 * date string directly. Instead, this prompt now asks for a `time_advance`
 * section using the exact same validated (type, minutes) contract the old
 * dedicated Time Resolver used (see TimelineEngine.js): "elapsed",
 * "schedule", "advance_to_event", or "none". JS (TimelineEngine) still does
 * all the actual date arithmetic and still enforces the sanity ceiling —
 * the model only ever proposes a duration or references an already-pending
 * event by index, never a literal time/date value.
 *
 * ENFORCEMENT, NOT JUST WORDING: applySceneResponse() below never reads
 * `data.time` or `data.date` from the model's response at all, even
 * defensively — there is no code path left that lets an LLM value reach
 * storyData.time/storyData.date directly. For ONGOING updates the only
 * time-related value read from the response is `data.time_advance`, and even
 * that goes through TimelineEngine.applyTimeResolverResponse() for validation
 * before the caller (index.js) is allowed to touch the clock with it — see
 * applySceneTimeAdvance() below. One narrow, deliberate exception exists for
 * GENESIS only: when deterministic seeding found no time cue (or no date cue)
 * in the opening text, the initial-setup call may return a `starting_time`
 * and/or `starting_date` that establishes the baseline the clock advances
 * from — strictly validated, read exactly once, never after initialization.
 * See extractStartingTime()/extractStartingDate() for why this doesn't weaken
 * the ongoing-clock invariant.
 *
 * Depends on TimelineEngine only for that shared validator and the pacing
 * guide text (both pure, no LLM calls) — still no side effects, no ST
 * dependency, independently testable like the rest of this rewrite.
 * ---------------------------------------------------------------------------
 */

import { applyTimeResolverResponse, PACING_EXAMPLE_GUIDE, TIME_ANCHOR_GUIDE, formatTimeForPrompt, parseDateTime, formatDate } from "./TimelineEngine.js";
import { LORE_DIGEST_GUIDE } from "./WorldAgent.js";

// =============================================================================
// PREVIOUS STATE BLOCK
// =============================================================================

/**
 * buildPreviousStateBlock(previousState)
 *
 * previousState: {
 *   initialized: boolean,
 *   location, city, country, temperature, weather,
 *   userOutfitText?, charItemsText?   // pre-formatted strings, caller's job
 *                                      // to build these from inventory data
 * }
 *
 * Deliberately does NOT include time/date in the "update this" framing —
 * those are stated separately as fixed facts by buildScenePrompt(), not as
 * something this block asks the model to reconsider.
 */
export function buildPreviousStateBlock(previousState) {
    previousState = previousState || {};
    var s;

    if (!previousState.initialized) {
        s = "This is the INITIAL setup. Establish a starting location, weather, and character positions based on the intro message/context.\n\n";
    } else {
        s = "PREVIOUS STATE:\nLocation: " + (previousState.location || "Unknown") + "\n";
        s += "City: " + (previousState.city || "Unknown") + " | Country/Realm: " + (previousState.country || "Unknown") + "\n";
        s += "Temperature: " + (previousState.temperature || "Unknown") + " | Weather: " + (previousState.weather || "Unknown") + "\n";
        if (previousState.userOutfitText) {
            s += "User's current outfit: " + previousState.userOutfitText + "\n";
        }
        if (previousState.charItemsText) {
            s += "Items held by character: " + previousState.charItemsText + "\n";
        }
    }

    return s + "(The clock above is your reference point AS OF the last update — decide in time_advance how much time has passed since then, if any. Do not output a raw \"time\" or \"date\" field yourself; that's computed by the system from your time_advance answer. Confirm or update location, weather, and character positions based on what just happened.)";
}

// =============================================================================
// PROMPT BUILDER
// =============================================================================

/**
 * buildScenePrompt(input)
 *
 * input: {
 *   currentTime: "HH:MM",      // REQUIRED — the clock AS OF the last update (last scene checkpoint)
 *   currentDate: "DD/MM/YYYY", // REQUIRED — ditto
 *   previousState: {...},      // see buildPreviousStateBlock
 *   recentChatText: string,    // pre-formatted "Name: message" block, caller's job to build
 *   userName: string,          // player's display name, for the "never write 'User'" instruction
 *   pendingEventsText: string, // numbered list of pending EventQueue entries with their ETA,
 *                              // e.g. "1. Ship arrives at the dock (due 18:00, 05/07/2026)" — lets
 *                              // the model reference one by INDEX for time_advance's
 *                              // "advance_to_event" case, same contract the old Time Resolver used.
 *   regionalWeatherTrend: string, // OPTIONAL — the World Agent's current broad weather-trend
 *                              // sentence (e.g. "A weak shortwave trough continues its slow
 *                              // drift east, bringing scattered thunderstorms..."). This tier
 *                              // runs on its own much slower cadence (see Scheduler.js), so it
 *                              // may not exist yet (brand-new chat, before the first World Tick).
 *                              // When present, it's given to the model as light GROUNDING for
 *                              // this scene's specific temperature/conditions, instead of the
 *                              // model guessing blind and defaulting to "Unknown" whenever the
 *                              // chat itself hasn't mentioned the weather. It's a hint, not a
 *                              // value to parrot verbatim — the model should still narrow it down
 *                              // to a concrete instantaneous reading (and indoors/unspecified
 *                              // scenes may still correctly resolve to "Unknown").
 * }
 *
 * Throws if currentTime/currentDate are missing — this module refuses to
 * build a prompt that would leave the clock ambiguous, same "hard stop,
 * no silent guessing" policy as TimelineEngine and EventQueue.
 */
export function buildScenePrompt(input) {
    input = input || {};
    if (!input.currentTime || !input.currentDate) {
        throw new Error("SceneAgent.buildScenePrompt: currentTime/currentDate must be supplied — this is the clock as of the last scene update, the reference point time_advance measures from.");
    }

    var prevStateBlock = buildPreviousStateBlock(input.previousState);
    var userName = input.userName || "{{user}}";
    var chatText = input.recentChatText || "No messages yet.";
    var pendingEventsText = input.pendingEventsText || "None currently pending.";
    // Optional numbered list of world secrets currently tracked as unknown-to-the-
    // protagonists (worldData.pendingReveals). When present, the scene tick — the
    // most frequent tracker — doubles as the resolution check for them: it's the
    // only tracker that both reads the recent chat every few RP-minutes AND runs
    // often enough to catch the moment a secret actually surfaces. Without this,
    // nothing ever resolves a reveal; it just slides off the 15-cap eventually,
    // still marked "not yet known" even if the story delivered it 50 messages ago.
    var pendingRevealsText = (input.pendingRevealsText || "").trim();
    var revealsSection = pendingRevealsText
        ? ("TRACKED WORLD SECRETS (currently believed NOT yet known to " + userName + " or the other protagonists):\n" + pendingRevealsText + "\n\n")
        : "";
    var revealsInstruction = pendingRevealsText
        ? ("6. REVEALED SECRETS: If the recent chat shows any numbered TRACKED WORLD SECRET above actually BECOMING KNOWN to " + userName + " or another protagonist — they discover it, witness it, are told it, or clearly deduce it in the text — list those numbers in \"revealed_secrets\". Only count a secret as revealed when the text genuinely delivers it; a hint, partial clue, or near-miss is NOT enough. Return an empty array if none were revealed (the usual case).\n")
        : "";
    var weatherTrendText = (input.regionalWeatherTrend || "").trim();
    var weatherGroundingLine = weatherTrendText
        ? (" The broader regional weather trend right now is: \"" + weatherTrendText + "\" — use this as grounding, not something to always copy verbatim: narrow it down to a plausible specific reading for this exact location and moment (still write 'Unknown' if the scene is indoors/underground/otherwise clearly insulated from it).")
        : "";
    // Genesis-only (see extractStartingTime below): when the deterministic
    // seeding scan found no time cue in the opening text, the initial-setup call
    // is the one place the model is invited to establish the starting clock —
    // anchored to the same hour table everything else uses when the text implies
    // a time-of-day, free choice when the opening is genuinely ambiguous.
    var startingTimeInstruction = input.askStartingTime
        ? "5b. STARTING TIME (initial setup only): The system could not determine this story's starting clock time from the opening text. Include a \"starting_time\" field (\"HH:MM\", 24-hour). If the text states or implies a time of day — even passively (dawn light, midday heat, a moonlit street, characters at breakfast) — use the TIME-OF-DAY ANCHOR HOURS table below to land on the matching hour. If the opening is genuinely ambiguous, choose any plausible time that fits the scene freely — your answer becomes the story's established starting clock. Also set time_advance to {\"type\":\"none\"} for this initial setup: starting_time IS the clock, nothing has elapsed yet.\n"
        : "";
    // Genesis-only, mirror of starting_time above (see extractStartingDate): the
    // deterministic date scan found no calendar cue, so the fallback date is
    // random — the one call allowed to replace it with something that actually
    // fits the story.
    var startingDateInstruction = input.askStartingDate
        ? "5c. STARTING DATE (initial setup only): The system could not determine this story's starting calendar date from the opening text. Include a \"starting_date\" field (\"DD/MM/YYYY\"). If the text states or implies anything usable — a named day or holiday, a season, a stated year, an era or level of technology — pick a date consistent with it (a modern-day setting should get a plausible present-day date, a historical one a fitting historical year). For a fictional world with its own calendar, still return DD/MM/YYYY with whatever year FEELS right for the setting (any year from 100 to 9999 is accepted). If genuinely ambiguous, choose any plausible date freely — your answer becomes the story's established starting date.\n"
        : "";

    // --- Genesis seeds (initial setup only) ---------------------------------
    // The one moment where scene, world, relationships, and the lore digest all
    // share an IDENTICAL evidence base (the opening text + card lore), so
    // establishing them in this single call costs one context payload instead of
    // several. Each section is validated independently by the caller (see
    // Pipeline.applyGenesisSeeds) — a fumbled section just leaves that subsystem
    // to initialize lazily the way it always did, never poisoning the others.
    var worldSeedInstruction = input.askWorldSeed
        ? ("7. WORLD SEED (initial setup only): Establish the wider world's starting state in a \"world_seed\" object:\n" +
           "   - \"summary\": 2-3 grounded, chronicle-like sentences on the state of the wider world implied by the lore/opening — the big picture beyond this one scene (tensions, powers in motion, what the region is living through). No flowery language.\n" +
           "   - \"weather_trend\": ONE short sentence describing the broader REGIONAL weather pattern right now (distinct from the scene's immediate weather above).\n" +
           "   - \"npc_states\": 0-6 entries of {\"name\",\"change\"} for named characters the lore/opening establishes as existing OFFSCREEN — what each is plausibly doing right now. Only people explicitly named in the lore or opening text, never invented ones, and never characters already listed as present in the scene. You MAY add a \"goal\" field for an NPC when the lore explicitly states what they're working toward.\n" +
           "   - \"pending_reveals\": 0-2 secrets the lore/opening explicitly establishes that the protagonists do NOT yet know (a hidden identity, a concealed agenda, an unrevealed danger). Empty array if none are stated — never invent one.\n")
        : "";
    var relationshipSeedInstruction = input.askRelationshipSeed
        ? ("8. RELATIONSHIP SEED (initial setup only): In \"relationship_seed\", record the story's STARTING relationship web:\n" +
           "   - Pairs the lore/opening text EXPLICITLY establishes — stated bonds, family ties, rivalries, allegiances (\"X serves Y\", \"they grew up together\"). This is canon-recording, not inference: no entry for a pair the text says nothing specific about.\n" +
           "   - INCLUDE " + userName + " (the player character) — they are a full participant in this web, not an observer. If the lore defines a relationship to the player, record it. ADDITIONALLY, for each character " + userName + " directly interacts with in the opening messages, record ONE mutual entry for that pair describing the current first-impression dynamic between them (typically 'neutral' with a small strength between -0.2 and +0.2 and a summary like \"Wary curiosity on both sides\") — grounded in what the text shows, never invented shared history. Do NOT leave " + userName + " with zero entries if they interacted with anyone in the opening.\n" +
           "   - An empty list is only correct when nothing is stated in the lore AND nobody interacted in the opening.\n" +
           "   \"type\" must be exactly one of: " + (input.relationshipTypesText || "romance, friendship, family, alliance, rivalry, hostile, mentor, neutral") + ". \"strength\" is a decimal from -1.0 (hostile) to 1.0 (deeply bonded). Keep each \"summary\" under 20 words. ONE entry per pair is the rule — the from/to order doesn't matter for a mutual dynamic. Two directional entries for the same pair are the RARE exception, reserved for a stated, significant asymmetry (unrequited love, a betrayal only one of them knows about); a mild difference in attitude is still ONE mutual entry — put the nuance in the summary instead of splitting the pair. Optionally include \"character_bios\": one plain sentence per named character establishing who they are.\n")
        : "";
    var loreDigestInstruction = input.askLoreDigest
        ? ("9. WORLD RULES DIGEST (initial setup only): Include a \"lore_digest\" array distilling the ESTABLISHED CHARACTER CARD LORE below (plus anything the opening text establishes) into this world's stable ground rules. This digest is stored permanently and shown to the world-simulation system INSTEAD of the full card text from now on, so accuracy matters more than completeness.\n" + LORE_DIGEST_GUIDE)
        : "";
    var loreBlock = (input.characterLoreText && String(input.characterLoreText).trim())
        ? "ESTABLISHED CHARACTER CARD LORE (ground truth — source material for the seed sections above):\n" + input.characterLoreText + "\n\n"
        : "";

    return (
        "[OOC: You are a narrative assistant. Analyze the roleplay chat so far, determine the current scene context, AND decide how much real narrative time has passed.\n\n" +
        "CLOCK AS OF THE LAST UPDATE (your reference point — decide in time_advance below how much time has passed since then, if any):\n" +
        "Time: " + formatTimeForPrompt(input.currentTime) + " | Date: " + input.currentDate + "\n\n" +
        "1. WEATHER & TEMPERATURE: Given the current Location and the time of day once time_advance is applied, deduce the current Temperature (e.g. '18°C' or '64°F') and Weather conditions (e.g. 'Clear', 'Rainy', 'Overcast', 'Snowing', 'Stormy', 'Hot', 'Foggy'). If indoors or weather is unspecified, infer from context or write 'Unknown'." + weatherGroundingLine + "\n" +
        "2. CITY & COUNTRY — MANDATORY, NEVER USE 'Unknown': You MUST always fill both 'city' and 'country' fields with a real or invented name. Rules:\n" +
        "   - Real-world setting -> use the actual city and country (e.g. 'Paris' / 'France').\n" +
        "   - Fantasy / sci-fi / fictional world -> INVENT fitting names based on the story tone, character names, culture, architecture, language style. Be creative and specific (e.g. 'Myrenveld' / 'Sovereign Realms of Drak'hara').\n" +
        "   - Known fictional universe (Westeros, Middle-earth, etc.) -> use canonical place names.\n" +
        "   - Setting is ambiguous or unspecified -> make your BEST GUESS or freely invent. 'Unknown' is NOT an acceptable value under any circumstances.\n" +
        "3. CHARACTER POSITIONS: List every character present in the current scene (including " + userName + " the player). Use the player's actual name as it appears in the chat - NOT the word 'User'. State exactly where they are and what their physical posture/action is right now.\n" +
        "4. RECENT EVENTS: Write a brief, factual 1-2 sentence summary of what just changed or happened in the last few messages. Use the player's actual name, not 'User'.\n" +
        "5. TIME_ADVANCE: Decide which ONE of four cases applies to how much real time passed across the messages you just reviewed, and fill the `time_advance` field accordingly. This replaces the flat per-message clock tick for this span rather than stacking on top of it, so be realistic and use the whole span, not just the last line.\n" +
        startingTimeInstruction +
        startingDateInstruction +
        revealsInstruction +
        worldSeedInstruction +
        relationshipSeedInstruction +
        loreDigestInstruction + "\n" +
        PACING_EXAMPLE_GUIDE + "\n" +
        TIME_ANCHOR_GUIDE + "\n" +
        revealsSection +
        loreBlock +
        "PENDING SCHEDULED EVENTS (things already queued to happen in the future — reference one by its number if the scene is explicitly filling time until it):\n" +
        pendingEventsText + "\n\n" +
        "The four time_advance cases:\n" +
        "a. Real time elapsed across this span (add up what realistically happened — this does not require an explicit \"skip\" phrase, ordinary beats still add up to real minutes; a stated present-moment marker like \"it's now afternoon\" or \"noon has come\" also belongs here — use the TIME-OF-DAY ANCHOR HOURS table below to compute exact minutes to that target):\n" +
        "   {\"type\":\"elapsed\",\"minutes\":14,\"reason\":\"one sentence\"}\n" +
        "a2. The text EXPLICITLY states a skip beyond a single day — a stated number of weeks/months/years, or a clear seasonal/calendar target (\"three weeks later\", \"six months later\", \"next spring\") — report the FULL real minutes for that duration and set explicit_skip:true:\n" +
        "   {\"type\":\"elapsed\",\"minutes\":262800,\"explicit_skip\":true,\"reason\":\"the text states six months passed\"}\n" +
        "b. Someone stated a FUTURE promise/ETA that hasn't happened yet (\"the ship will arrive in three hours\") — nothing has elapsed, this is something to schedule for later:\n" +
        "   {\"type\":\"schedule\",\"minutes\":180,\"description\":\"what happens when it resolves, one sentence\"}\n" +
        "c. The scene is explicitly passing time UNTIL one of the PENDING SCHEDULED EVENTS above (\"they talk until dinner\" and a dinner event is already pending) — reference it by its list number:\n" +
        "   {\"type\":\"advance_to_event\",\"eventIndex\":1,\"reason\":\"one sentence\"}\n" +
        "d. Nothing notable beyond ordinary real-time dialogue/action at normal pace:\n" +
        "   {\"type\":\"none\",\"reason\":\"one sentence\"}\n\n" +
        "TIME_ADVANCE GUARDRAILS:\n" +
        "- A statement about the PAST (\"a few hours ago\", \"already\", \"last night\", something recalled or dreamed) is NEVER \"elapsed\" — it describes time before now. Treat it as \"none\".\n" +
        "- A statement of REMAINING distance/time (\"three hours away\", \"until we arrive\") is NEVER \"elapsed\" — that's a \"schedule\" case.\n" +
        "- Be realistic and conservative with \"minutes\" for ORDINARY pacing (case a) — when genuinely uncertain about an everyday beat, prefer the smaller/more conservative answer. This does NOT apply to an explicit_skip (case a2): if the text plainly states a duration or target beyond a single day, report the full real minutes for it — rounding an explicit skip down to \"stay safe\" is the mistake, not a virtue.\n" +
        "- \"advance_to_event\" only applies when a PENDING SCHEDULED EVENT is listed above AND the text explicitly uses it as a time-filler (\"until\", \"waiting for\"). If nothing is pending, this option is not available.\n" +
        "- Only set explicit_skip:true when the text ITSELF states the duration or a calendar/seasonal target — never for your own inference about how long an unstated gap \"probably\" was.\n" +
        "- RECONCILE AGAINST STATED TIME-OF-DAY: if the reviewed text states or clearly implies the current time-of-day — including PASSIVELY, with no \"it's now X\" phrasing (e.g. \"the morning light spilled across the room\", \"the afternoon sun beat down\", \"night had fully descended\") — and that's inconsistent with where your computed \"minutes\" would land relative to the clock stated above, let the STATED time-of-day win. Recompute \"minutes\" to land at the matching hour in the TIME-OF-DAY ANCHOR HOURS table instead of your original estimate. The prose is the source of truth for what time it visibly is; your minute-math is only a tool for estimating that, never an authority that overrides what the story already said.\n\n" +
        prevStateBlock + "\n\n" +
        "Respond ONLY with valid JSON in the story's language. IMPORTANT: In the characters array, use the player's actual name from the chat - never write 'User'. Do NOT include a \"time\" or \"date\" field anywhere in your response — only the time_advance object above decides elapsed time, and it will be ignored if a raw time/date field is present instead. Use this exact structure (city and country MUST be non-empty strings, never 'Unknown'):\n" +
        "{\"location\":\"Living room\", \"city\":\"Myrenveld\", \"country\":\"Sovereign Realms of Drak'hara\", \"temperature\":\"18°C\", \"weather\":\"Cloudy\", \"characters\":[{\"name\":\"Jepp\", \"state\":\"sitting on floor\"}, {\"name\":\"Char1\", \"state\":\"standing near Jepp\"}], \"recent_events\":\"Char1 entered the living room and spoke to Jepp.\", \"time_advance\":{\"type\":\"elapsed\",\"minutes\":14,\"reason\":\"a short conversation and a walk to the door\"}" +
        (input.askStartingTime ? ", \"starting_time\":\"19:30\"" : "") +
        (input.askStartingDate ? ", \"starting_date\":\"24/12/1899\"" : "") +
        (pendingRevealsText ? ", \"revealed_secrets\":[]" : "") +
        (input.askWorldSeed ? ", \"world_seed\":{\"summary\":\"2-3 sentence world snapshot.\",\"weather_trend\":\"One-sentence regional trend.\",\"npc_states\":[{\"name\":\"Balthor\",\"change\":\"working his forge across town\"}],\"pending_reveals\":[]}" : "") +
        (input.askRelationshipSeed ? ", \"relationship_seed\":{\"relationships\":[{\"from\":\"CharA\",\"to\":\"CharB\",\"type\":\"alliance\",\"strength\":0.5,\"summary\":\"Sworn shield-brothers per the lore\"}],\"character_bios\":[]}" : "") +
        (input.askLoreDigest ? ", \"lore_digest\":[\"One short factual world rule per entry.\"]" : "") +
        "}\n" +
        "]\n\n" +
        "[Player character name: " + userName + ". Always use this exact name in the JSON output, never write 'User'.]\n" +
        "Recent chat:\n" + chatText
    );
}

// =============================================================================
// RESPONSE APPLICATION
// =============================================================================

/**
 * applySceneResponse(data)
 *
 * Validates and extracts the allowed fields from the model's parsed JSON
 * response into a plain patch object for the caller to merge into
 * storyData. `time` and `date` are NEVER read from `data`, even if
 * present — this is the actual enforcement point, not just prompt wording.
 *
 * Returns null if `data` is falsy (caller should treat as a failed call).
 */
/**
 * cleanScalarField(value, maxChars)
 * Scalar scene fields go straight from raw model output into persisted storage
 * and, from there, into rendered HTML — so they must be validated to be plain,
 * bounded strings HERE, not trusted to be sane. Accepts strings (trimmed) and
 * finite numbers (stringified); anything else — objects, arrays, booleans —
 * returns null and the field is simply not patched. Length-capped so a
 * runaway response can't bloat every future prompt injection either.
 */
function cleanScalarField(value, maxChars) {
    if (typeof value === "number" && isFinite(value)) value = String(value);
    if (typeof value !== "string") return null;
    var trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed;
}

export function applySceneResponse(data) {
    if (!data) return null;

    var patch = {};

    // Deliberately absent: patch.time, patch.date. Do not add them here —
    // see file header for why.

    var location = cleanScalarField(data.location, 200);
    if (location) patch.location = location;
    var city = cleanScalarField(data.city, 120);
    if (city && city !== "Unknown") patch.city = city;
    var country = cleanScalarField(data.country, 120);
    if (country && country !== "Unknown") patch.country = country;
    var temperature = cleanScalarField(data.temperature, 60);
    if (temperature) patch.temperature = temperature;
    var weather = cleanScalarField(data.weather, 120);
    if (weather) patch.weather = weather;
    // Characters are validated per-entry, never passed through raw: a malformed
    // array (bare name strings, entries missing `name`) previously went straight
    // into storyData and got SAVED, after which every renderModal/renderHUD call
    // crashed on `c.name.toLowerCase()` until the data was manually cleared.
    if (Array.isArray(data.characters)) {
        var characters = data.characters
            .map(function (c) {
                if (typeof c === "string" && c.trim()) return { name: cleanScalarField(c, 100), state: "present" };
                if (c && typeof c === "object" && typeof c.name === "string" && c.name.trim()) {
                    return {
                        name: cleanScalarField(c.name, 100),
                        state: cleanScalarField(c.state, 300) || "present",
                    };
                }
                return null;
            })
            .filter(function (c) { return c && c.name; });
        if (characters.length > 0) patch.characters = characters;
    }
    var recentEvents = cleanScalarField(data.recent_events, 600);
    if (recentEvents) patch.recent_events = recentEvents;

    return patch;
}

/**
 * extractRevealedSecretIndices(data)
 *
 * Deliberately a SEPARATE extractor rather than a field on applySceneResponse's
 * patch — the patch gets Object.assign'd straight onto storyData, and this is
 * transient per-call data (indices into the exact reveals list the caller just
 * sent), not scene state that should persist.
 *
 * Returns a deduped array of validated 1-based integer indices. Anything
 * non-numeric, non-integer, or < 1 is dropped; upper-bound (list length) is the
 * CALLER's job since only it knows how many reveals it actually listed. Returns
 * [] for a missing/malformed field — same "absent means nothing happened"
 * posture as applySceneTimeAdvance.
 */
export function extractRevealedSecretIndices(data) {
    if (!data || !Array.isArray(data.revealed_secrets)) return [];
    var seen = {};
    var out = [];
    data.revealed_secrets.forEach(function (v) {
        var n = (typeof v === "number") ? v : parseInt(v, 10);
        if (!isFinite(n) || n < 1 || Math.floor(n) !== n) return;
        if (seen[n]) return;
        seen[n] = true;
        out.push(n);
    });
    return out;
}

/**
 * extractStartingTime(data)
 *
 * THE ONE SANCTIONED EXCEPTION to "never read a clock value from the model":
 * at genesis there is no established baseline for time_advance to advance
 * FROM — the alternative isn't a safer source of truth, it's a hardcoded
 * 12:00 placeholder. So when (and only when) the deterministic seeding scan
 * found no cue in the opening text, the caller asks the initial-setup call
 * for a starting_time and reads it through this strict validator. The
 * ongoing-clock invariant is untouched: the caller consults this exactly
 * once, before _initialized is ever set, and applySceneResponse still never
 * reads time/date on any call.
 *
 * Returns a zero-padded "HH:MM" or null for anything missing or malformed
 * (caller keeps the neutral fallback in that case).
 */
export function extractStartingTime(data) {
    if (!data || typeof data.starting_time !== "string") return null;
    var m = data.starting_time.trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    var hh = parseInt(m[1], 10), mm = parseInt(m[2], 10);
    if (isNaN(hh) || isNaN(mm) || hh > 23 || mm > 59) return null;
    return (hh < 10 ? "0" + hh : String(hh)) + ":" + (mm < 10 ? "0" + mm : String(mm));
}

/**
 * extractStartingDate(data)
 *
 * Genesis-only companion to extractStartingTime above — the same narrowly-
 * sanctioned exception, for the calendar date. Only consulted when the
 * deterministic seedInitialDate() scan found no cue in the opening text
 * (the alternative isn't a safer source of truth, it's a RANDOM date), read
 * exactly once, before _initialized is ever set. Validated through the SAME
 * strict parser every other clock value goes through — parseDateTime's
 * round-trip check — so "31/02/2026", a 2-digit year, or any silently-
 * rolling-over nonsense can never seep into storage. Returns a normalized
 * "DD/MM/YYYY" or null for anything missing/malformed (caller keeps the
 * random fallback date in that case).
 */
export function extractStartingDate(data) {
    if (!data || typeof data.starting_date !== "string") return null;
    var raw = data.starting_date.trim();
    if (!/^\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{1,4}$/.test(raw)) return null;
    var d = parseDateTime("00:00", raw);
    if (!d) return null;
    return formatDate(d);
}

/**
 * applySceneTimeAdvance(data)
 *
 * The ONLY point where a time-related value is read from Scene Agent's
 * ONGOING responses — and even here, it's never a raw time/date, only the
 * validated (type, minutes) contract from TimelineEngine.applyTimeResolverResponse().
 * (extractStartingTime above is the single, genesis-only exception — see its doc.)
 * `data.time` / `data.date`, if a model hallucinates them out of habit, are
 * simply never looked at (see applySceneResponse above).
 *
 * Returns the same shape as TimelineEngine.applyTimeResolverResponse():
 *   { type: "elapsed"|"schedule"|"advance_to_event"|"none", minutes, ... }
 * Falls back to { type: "none", minutes: 0 } if time_advance is missing or
 * malformed — an absent/broken decision should never accidentally advance
 * or skip the clock, it should just mean "keep the flat baseline tick".
 */
export function applySceneTimeAdvance(data) {
    return applyTimeResolverResponse(data && data.time_advance);
}

// City/country fallback prompt — unchanged in spirit from the original,
// since it never touched time/date to begin with.
export function buildCityCountryPrompt(location) {
    return (
        "[OOC: Based on the roleplay chat so far, determine the city/settlement and country/realm of the current scene.\n\n" +
        "Current known location: " + (location || "Unknown") + "\n\n" +
        "Rules (STRICTLY FOLLOW):\n" +
        "- If this is a real-world setting: provide the actual city and country.\n" +
        "- If this is a fantasy, sci-fi, or fictional world: INVENT a creative, fitting city name and realm/country name that matches the story's tone, culture, and character names. Be specific - never use generic placeholders.\n" +
        "- If you recognize a known fictional universe (Westeros, Middle-earth, Star Wars, etc.): use canonical place names.\n" +
        "- 'Unknown' is FORBIDDEN. You MUST always output a real or invented name.\n\n" +
        "Respond ONLY with valid JSON: {\"city\": \"CityName\", \"country\": \"CountryOrRealm\"}\n" +
        "]"
    );
}

export function applyCityCountryResponse(data) {
    if (!data) return null;
    var patch = {};
    // Same cleanScalarField validation (and the same 120-char cap) as the main
    // applySceneResponse path — this fallback was the one validator left trusting
    // raw output, so a JSON-valid object/array here persisted into storyData and
    // flowed into the HUD and every future prompt injection.
    var city = cleanScalarField(data.city, 120);
    if (city && city !== "Unknown") patch.city = city;
    var country = cleanScalarField(data.country, 120);
    if (country && country !== "Unknown") patch.country = country;
    return patch;
}
