/*
 * Pipeline.js
 * ---------------------------------------------------------------------------
 * The extension's actual "brain" — everything that decides WHEN a tracker
 * fires and WHAT it does with the response. Extracted from index.js, which
 * used to hold this logic inline inside its ST event-binding callback
 * alongside thousands of lines of unrelated settings/UI code.
 *
 * Scope: the per-message pipeline (bindEvents' handleMsg — timeline advance,
 * Scheduler evaluation, EventQueue resolution, dispatching due tiers), the
 * Scene/World/Relationship tracker calls themselves, and prompt-context
 * injection. Nothing here builds UI. Nothing here decides how to load/save
 * data (see Persistence.js) or which connection profile to use (see
 * ProfileSession.js) — this module calls into both.
 *
 * STATE: reads/writes go through Store.js (see its file header for why).
 * Bridges to index.js: a few genuinely UI-side helpers this pipeline still
 * needs to call — getInventoryOutfit(), renderModal(), syncToCharTracker() —
 * stay defined in index.js (a classic, non-module script) and are reached
 * here via `window.<fn>()`, since index.js can't be an ES `import` target.
 * ---------------------------------------------------------------------------
 */

import * as Store from "./Store.js";
import * as HUD from "./HUD.js";
import { cleanAndParseJSON } from "./LLMResponseParser.js";
import {
    resolveCanonicalName, dedupeRelationshipNodes,
    saveStoryData, saveWorldData, saveRelationshipData,
    loadStoryData, loadWorldData, loadRelationshipData,
    parseRpDateTime,
} from "./Persistence.js";
import {
    withConnectionProfile, withWorldConnectionProfile, withRelConnectionProfile,
    runTrackerProfileSession, getCurrentProfileName,
} from "./ProfileSession.js";

// Internal-only tuning constants (not user-configurable — no UI for these).
// Previously read as settings.bigJumpCooldownMessages / settings.weatherChangeCooldownMessages,
// but neither key was ever declared in the settings defaults or exposed in the panel, so both
// always silently fell back to 3 anyway. Named here for clarity instead of a bare fallback.
var BIG_JUMP_COOLDOWN_MESSAGES = 3;
var WEATHER_CHANGE_COOLDOWN_MESSAGES = 3;

// Surfaces whatever extra detail is attached to a failed genRaw() call. A bare
// "Bad Request" Error doesn't say WHY the backend rejected the request, so this
// digs into the common places that detail actually lives, plus which connection
// profile was active at the time (useful when a profile-specific misconfig is
// the actual cause).
function logGenRawFailure(context, e) {
    var detail = {
        message: e && e.message,
        status: e && (e.status || e.statusCode),
        response: e && e.response,
        cause: e && e.cause,
        body: e && e.body,
        activeProfile: getCurrentProfileName(),
    };
    console.warn("[Story Tracker] genRaw object-form call failed (" + context + "), falling back to legacy call signature:", e, detail);
}

export function injectContextToChat() {
    if (!Store.isChatOpen()) return;
    if (!Store.settings.enabled) {
        // Master toggle is off — clear anything previously injected instead of just
        // skipping this call and leaving the last-set prompt content in place forever.
        try {
            if (Store.scriptModule.setExtensionPrompt) {
                Store.scriptModule.setExtensionPrompt("STORY_TRACKER_CONTEXT", "", 1, 0, false, 0);
            }
        } catch (e) { /* no-op */ }
        return;
    }

    let sceneInj = "";
    if (Store.settings.enabled && Store.storyData && Store.storyData._initialized) {
        let loc = Store.storyData.location;
        let ev = Store.storyData.recent_events;
        
        let charsText = "";
        if (Store.storyData.characters && Store.storyData.characters.length > 0) {
            charsText = Store.storyData.characters.map(c => `${c.name}: ${c.state}`).join(" | ");
        }

        let cityCountryStr = "";
        if (Store.settings.showCityCountry) {
            let city = Store.storyData.city || "";
            let country = Store.storyData.country || "";
            if (city && city !== "Unknown" || country && country !== "Unknown") {
                cityCountryStr = "\nCity: " + (city || "Unknown") + " | Country/Realm: " + (country || "Unknown");
            }
        }

        sceneInj = `<scene_context>\n` +
                   `Tracked, authoritative state of the current scene. Use it for continuity — do NOT recite these fields back as a status report or narrate them as a list.\n` +
                   `  - Time/Date/Weather/Temperature: let these inform incidental details (lighting, ambient sound, character comfort, clothing choices) only where it's natural — not a checklist to mention every turn.\n` +
                   `  - Positions: where each character currently is and what they're doing. Maintain spatial continuity from this — don't have someone act as if they're elsewhere, and don't silently relocate a character without narrating the move.\n` +
                   `  - Outfit/Held items (if listed below): characters should act consistent with what they're actually wearing or holding right now — don't have someone draw a weapon they're not carrying, or shrug off weather their clothing doesn't suit.\n` +
                   `  - Recent: a compressed memory of what just happened. Stay consistent with it — don't contradict or forget it — but don't restate it verbatim in narration.\n` +
                   `[Scene Context: Time: ${Store.storyData.time}, Date: ${Store.storyData.date}\nLocation: ${loc}${cityCountryStr}\nTemperature: ${Store.storyData.temperature || "Unknown"} | Weather: ${Store.storyData.weather || "Unknown"}\nPositions: ${charsText}\nRecent: ${ev}`;

        var outfit = window.getInventoryOutfit();
        if (outfit && outfit.userEquipped.length > 0) {
            var outfitStr = outfit.userEquipped.map(function(it) { return it.label + ": " + it.name; }).join(", ");
            sceneInj += `\nUser's Outfit: ${outfitStr}`;
        }
        if (outfit && outfit.charItems.length > 0) {
            var charHeldStr = outfit.charItems.map(function(ci) { return ci.name + " (held by " + ci.heldBy + ")"; }).join(", ");
            sceneInj += `\nCharacter holds: ${charHeldStr}`;
        }
        sceneInj += `]\n</scene_context>`;

        // Location memory: the party is currently somewhere the Location Codex
        // remembers leaving before — re-ground the model in that place's stored
        // departure state instead of letting it regenerate the place from scratch.
        var codexEntry = (Store.worldData && Store.WorldAgent)
            ? Store.WorldAgent.getLocationCodexEntry(Store.worldData.locationCodex, Store.storyData.location)
            : null;
        if (codexEntry) {
            sceneInj += "\n<location_memory>\n" + Store.WorldAgent.formatLocationMemoryForPrompt(codexEntry) + "\n</location_memory>";
        }
    }

    let worldInj = "";
    if (Store.settings.worldEnabled && Store.worldData && Store.worldData._initialized) {
        // Retrieve the last 3 important events (importance >= 4, falling back to any if none)
        let imp = Store.worldData.worldEvents.filter(e => e.importance >= 4).slice(0, 3);
        if (imp.length === 0) imp = Store.worldData.worldEvents.slice(0, 3);
        let eventsStr = imp.map(e => e.event).join("\n");
        let sum = Store.worldData.worldSummary || "";
        let weatherTrendStr = Store.worldData.weatherTrend || "";

        // Surface still-PENDING scheduled events (calendar entries + agent-scheduled
        // delayed actions) so the model can build toward them ("the messenger is due
        // soon") instead of only learning about them the instant they resolve.
        let scheduledStr = "";
        if (Store.EventQueue && Store.worldData._eventQueue) {
            var nowObj = parseRpDateTime(Store.storyData.time, Store.storyData.date);
            var upcoming = Store.EventQueue.getPending(Store.worldData._eventQueue)
                .map(function(ev) {
                    var dueObj = parseRpDateTime(ev.executeTime, ev.executeDate);
                    var minsUntil = (nowObj && dueObj) ? Math.round((dueObj.getTime() - nowObj.getTime()) / 60000) : null;
                    return { ev: ev, minsUntil: minsUntil };
                })
                .sort(function(a, b) { return (a.minsUntil || 0) - (b.minsUntil || 0); })
                .slice(0, 5);
            if (upcoming.length > 0) {
                scheduledStr = upcoming.map(function(u) {
                    var etaStr = (u.minsUntil == null) ? "unknown ETA" : (u.minsUntil <= 0 ? "imminent" : "in ~" + u.minsUntil + " min");
                    return "- " + u.ev.action + " (" + etaStr + ", at " + u.ev.executeTime + " " + u.ev.executeDate + ")";
                }).join("\n");
            }
        }

        // NPC whereabouts from daily routines — a deterministic, zero-LLM lookup of
        // what each routine-carrying tracked NPC is doing at the current RP clock
        // (see WorldAgent.getRoutineActivityAt). Onscreen characters are excluded:
        // the scene itself is the authority on anyone actually present.
        let whereaboutsStr = "";
        if (Store.WorldAgent && Store.storyData) {
            var onscreenSet = new Set((Store.storyData.characters || []).map(function(c) { return c.name; }));
            var routineLines = (Store.worldData.npcStates || [])
                .filter(function(n) { return n && n.name && Array.isArray(n.routine) && n.routine.length > 0 && !onscreenSet.has(n.name); })
                .slice(0, 8)
                .map(function(n) {
                    var cur = Store.WorldAgent.getRoutineActivityAt(n.routine, Store.storyData.time);
                    return cur ? ("- " + n.name + ": " + cur.activity + " (since " + cur.time + ", per their daily routine)") : null;
                })
                .filter(Boolean);
            if (routineLines.length > 0) whereaboutsStr = routineLines.join("\n");
        }

        worldInj = `<world_progression>\n` +
                   `The active context contains recent "World Progression" reports detailing background, off-screen macro events.\n\n` +
                   `  - Environmental Bleed-in: You are ENCOURAGED to reflect these macro shifts passively through the scenery, weather, atmospheric tension, or ambient background details if they logically affect the current district or theme.\n` +
                   `  - Hostile Initiative & Ambushed Scenes: If a report explicitly details a rival, faction, or antagonist plotting, executing a strike, or tracking {{user}}, you have full permission to be AGGRESSIVE. Do not wait for investigation. Let that hostile action violently collide with the current scene as an immediate consequence (e.g., an ambush, a sudden lockdown, an interception, or a direct threat manifesting).\n` +
                   `  - Organic Intersection: If a report event mentions a passive entity or location matching {{user}}'s immediate surroundings or active inventory, let that event alter the local environment (e.g., increased patrol density, systemic panic, visible structural changes).\n` +
                   `  - Asymmetric Knowledge Guardrail: Unless a hostile interception occurs, do NOT grant characters or {{user}} omniscient knowledge of these events. NPCs must not spontaneously discuss details they have no realistic way of knowing. Use the data strictly to dictate systemic consequences, hidden NPC positioning, and evolving motivations.\n` +
                   `  - Scheduled/Upcoming Events: these have NOT happened yet — they are future certainties on the RP clock, not current facts. Build toward them (rising tension, foreshadowing, NPCs acting as if time is running out) without revealing specifics {{user}} couldn't know. They will resolve automatically once their time arrives.\n` +
                   (whereaboutsStr ? `  - NPC Whereabouts: NPCs listed below with a current routine activity are THERE, doing THAT, right now. Do not have one of them appear in the scene, answer a knock, or be found elsewhere without narrating why they broke from their routine — "the forge is dark, Balthor has already gone home" is exactly the kind of consequence this data exists to create.\n` : "") +
                   `\n[World State Reports]\n` +
                   `Summary: ${sum}\n` +
                   (weatherTrendStr ? `Regional Weather Trend: ${weatherTrendStr}\n` : "") +
                   `Recent Developments:\n${eventsStr || "None."}\n` +
                   (scheduledStr ? `Scheduled/Upcoming Events (not yet happened):\n${scheduledStr}\n` : "") +
                   (whereaboutsStr ? `Offscreen NPC whereabouts right now (from daily routines):\n${whereaboutsStr}\n` : "") +
                   `</world_progression>`;
    }

    let finalInj = "";
    if (sceneInj) finalInj += sceneInj;
    if (worldInj) finalInj += (finalInj ? "\n" : "") + worldInj;

    // Relationship context injection — only edges involving characters currently in scene
    if (Store.settings.relationsEnabled && Store.relationshipData && Store.relationshipData._initialized && 
        Store.relationshipData.edges && Store.relationshipData.edges.length > 0) {
        var sceneNames = new Set((Store.storyData && Store.storyData.characters || []).map(function(c) { return c.name; }));
        var relevantEdges = Store.relationshipData.edges.filter(function(e) {
            return sceneNames.has(e.from) || sceneNames.has(e.to);
        });
        if (relevantEdges.length > 0) {
            var relLines = relevantEdges.map(function(e) {
                var sign = e.strength >= 0 ? "+" : "";
                // RelationshipAgent creates ONE edge per pair for a mutual dynamic, but
                // TWO edges (from->to AND to->from, each describing only that person's
                // side) for an asymmetric one — see RelationshipAgent.js rule 4b. This
                // was previously always rendered with the mutual arrow (\u2194) even for
                // the asymmetric case, which told the main model an unrequited crush (or
                // one-sided resentment, etc.) was a shared feeling. Check for a reciprocal
                // edge to tell the two cases apart and render accordingly.
                var oneSided = Store.RelationshipAgent && Store.RelationshipAgent.hasReciprocalEdge(Store.relationshipData.edges, e.from, e.to);
                var arrowText = oneSided ? (e.from + " \u2192 " + e.to) : (e.from + " \u2194 " + e.to);
                var line = arrowText + ": " + e.type + " (" + sign + (e.strength || 0).toFixed(1) + ") \u2014 " + e.summary;
                if (oneSided) line += "  [one-sided: " + e.to + " has not been shown to feel this]";
                return line;
            }).join("\n");
            var relInj = "<relationship_dynamics>\n" +
                         "Tracked emotional dynamics between characters currently in the scene. Use these to color body language, dialogue tone, and instinctive reactions \u2014 don't state the number or recite this block to the player.\n\n" +
                         "STRENGTH runs -1.0 (hostile/broken) to +1.0 (deeply bonded); the band matters more than the exact decimal:\n" +
                         "  -1.0 to -0.6  actively hostile \u2014 open conflict, sabotage, hatred.\n" +
                         "  -0.6 to -0.2  cold/distrustful \u2014 guarded or resentful, not yet openly hostile.\n" +
                         "  -0.2 to +0.2  neutral/indifferent \u2014 treat as strangers or acquaintances unless TYPE says otherwise.\n" +
                         "  +0.2 to +0.6  warm \u2014 real but still-developing trust, affection, or camaraderie.\n" +
                         "  +0.6 to +1.0  deeply bonded \u2014 strong loyalty or love; would take real risks for each other.\n" +
                         "TYPE flavors HOW that strength expresses \u2014 a rivalry at +0.4 reads as competitive-but-respectful, not affectionate; a romance at +0.2 reads as early/uncertain feelings, not a settled relationship.\n" +
                         "A \u2194 arrow means the dynamic is MUTUAL. A \u2192 arrow means it's ONE-SIDED \u2014 only the \"from\" character feels this way. Do not let the \"to\" character act as if they know about or share that feeling unless the story has actually revealed it \u2014 same asymmetric-knowledge principle as world events above.\n\n" +
                         relLines + "\n</relationship_dynamics>";
            finalInj += (finalInj ? "\n" : "") + relInj;
        }
    }

    if (!finalInj) {
        // Nothing to inject this turn - clear any previous injection so stale
        // context doesn't linger in the prompt after tracking is disabled.
        try {
            if (Store.scriptModule.setExtensionPrompt) {
                Store.scriptModule.setExtensionPrompt("STORY_TRACKER_CONTEXT", "", 1, 0, false, 0);
            }
        } catch (e) { /* no-op */ }
        return;
    }

    try {
        // setExtensionPrompt is the official mechanism extensions use to inject
        // content into the actual generation prompt (the same API SillyTavern's
        // own Memory/Summarize and World Info systems use internally). Writing
        // directly to chat_metadata.authorsNote is NOT read by SillyTavern's
        // prompt builder (the real Author's Note key is note_prompt), so that
        // approach silently did nothing - this fixes it.
        //
        // Position 1 = IN_CHAT (in_prompt=0, in_chat=1, before_prompt=2)
        // Depth 0 = inserted right after the most recent message
        // Role 0 = SYSTEM
        var posTypes = Store.scriptModule.extension_prompt_types || { IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 };
        var roleTypes = Store.scriptModule.extension_prompt_roles || { SYSTEM: 0, USER: 1, ASSISTANT: 2 };
        Store.scriptModule.setExtensionPrompt(
            "STORY_TRACKER_CONTEXT",
            finalInj,
            posTypes.IN_CHAT,
            0,
            false,
            roleTypes.SYSTEM
        );

        // Clean up the old (non-functional) injection key so it doesn't linger
        // in chat_metadata for users upgrading from a previous version.
        if (Store.scriptModule.chat_metadata && Store.scriptModule.chat_metadata.authorsNote) {
            delete Store.scriptModule.chat_metadata.authorsNote;
        }
    } catch (e) { console.error("[Story Tracker] Inject error:", e); }
}

// --- Event Handling ---
// Shared by both Time Modes: turns a validated TimelineEngine resolver result into
// a clock outcome — applying elapsed/advance_to_event against `anchorState` (the clock
// value the resolver's minutes should be measured FROM — the checkpoint anchor in
// Message Mode, or this message's pre-resolve time in Smart Time Mode), or creating/
// replacing a "schedule" EventQueue entry. Returns null for "none" or an invalid
// response — caller should keep whatever baseline tlResult it already had.
async function applyTimeResolverOutcome(resolverResult, anchorState, pendingForPrompt, originTag) {
    if (resolverResult.type === "elapsed") {
        var tlResult = Store.TimelineEngine.applyResolverResult(anchorState, resolverResult);
        console.log("[Story Tracker] Time resolver (" + originTag + "): elapsed +" + tlResult.elapsedMinutes.toFixed(0) + "min (" + resolverResult.reason + ")");
        return tlResult;

    } else if (resolverResult.type === "advance_to_event") {
        var targetEvent = (pendingForPrompt || [])[resolverResult.eventIndex - 1];
        if (!targetEvent) {
            console.warn("[Story Tracker] Time resolver referenced eventIndex " + resolverResult.eventIndex + " but no such pending event exists — keeping baseline.");
            return null;
        }
        var targetDate = Store.TimelineEngine.parseDateTime(targetEvent.executeTime, targetEvent.executeDate);
        var fromDate = Store.TimelineEngine.parseDateTime(anchorState.currentTime, anchorState.currentDate);
        var minutesUntil = (targetDate && fromDate) ? Math.max(0, Math.round((targetDate.getTime() - fromDate.getTime()) / 60000)) : 0;
        var result = Store.TimelineEngine.applyResolverResult(anchorState, { type: "advance_to_event", minutes: minutesUntil });
        console.log("[Story Tracker] Time resolver (" + originTag + "): advancing to pending event \"" + targetEvent.action + "\" (+" + minutesUntil.toFixed(0) + "min)");
        return result;

    } else if (resolverResult.type === "schedule" && !(resolverResult.minutes > 0)) {
        // A "schedule" with no positive duration would resolve on the very next message
        // and land in worldEvents as something that already happened — a phantom event.
        console.warn("[Story Tracker] Time resolver (" + originTag + "): 'schedule' answer had no positive minutes value — ignoring it.");
        return null;

    } else if (resolverResult.type === "schedule" && Store.worldData && Store.EventQueue) {
        // A stated future ETA ("the ship arrives in 3 hours") — nothing has elapsed yet, so
        // the clock stays at the flat baseline; this just gets queued the same way the
        // Scheduled Events calendar feature works. Re-stating a similar ETA later replaces
        // the old auto-tracked one rather than stacking duplicates — but only THAT one:
        // matching purely on meta.origin === "llm-schedule" (with no check against the
        // actual description) used to cancel every other in-flight llm-schedule event too,
        // even ones for completely unrelated things. Require actual text similarity
        // (same threshold WorldAgent.isDuplicateEvent uses for the same "is this the same
        // event" judgment elsewhere) before treating it as a replacement.
        Store.worldData._eventQueue = Store.EventQueue.cancelPendingMatching(Store.worldData._eventQueue || [], function(e) {
            return e.meta && e.meta.origin === "llm-schedule" &&
                   Store.WorldAgent && Store.WorldAgent.getEventSimilarity(e.action, resolverResult.description) > 0.5;
        });
        try {
            Store.worldData._eventQueue = Store.EventQueue.enqueue(Store.worldData._eventQueue, {
                actor: null,
                action: resolverResult.description,
                startTime: Store.storyData.time, startDate: Store.storyData.date,
                durationMinutes: resolverResult.minutes,
                meta: { origin: "llm-schedule", autoDetected: true },
            });
            saveWorldData();
            console.log("[Story Tracker] Time resolver (" + originTag + "): scheduled \"" + resolverResult.description + "\" (+" + resolverResult.minutes.toFixed(0) + "min).");
        } catch (e) {
            console.warn("[Story Tracker] Failed to schedule LLM-detected event:", e);
        }
        return null;
    }
    return null; // "none", or an invalid/failed response
}

function buildPendingEventsPromptText() {
    var pendingForPrompt = (Store.worldData && Store.EventQueue) ? Store.EventQueue.getPending(Store.worldData._eventQueue || []) : [];
    var pendingEventsText = pendingForPrompt.length > 0
        ? pendingForPrompt.map(function(e, i) { return (i + 1) + ". " + e.action + " (due " + e.executeTime + ", " + e.executeDate + ")"; }).join("\n")
        : "";
    return { pendingForPrompt: pendingForPrompt, pendingEventsText: pendingEventsText };
}

export function bindEvents() {
    var es = Store.scriptModule.eventSource, et = Store.scriptModule.event_types;
    if (!es) return;
    
    es.on(et.CHAT_CHANGED, function() {
        loadStoryData();
        window.renderModal(); HUD.renderHUD();
        window.updateSettingsUI();
    });
    
    $(document).on("ST_FORCE_RENDER", function() {
        loadStoryData();
        window.renderModal(); 
        HUD.renderHUD();
        window.updateSettingsUI();
    });

    $(document).on("INV_EQUIPMENT_CHANGED", function() {
        window.renderModal();
        HUD.renderHUD();
        if (Store.settings.enabled) injectContextToChat();
    });

    let handleMsg = async function(type) {
        // GENERATION_ENDED doesn't pass a message ID - we derive it from the chat array
        var liveChat = Store.getLiveChat();
        if (!liveChat || liveChat.length === 0) return;

        // Only process AI (character) messages, not user messages
        var lastMsg = liveChat[liveChat.length - 1];
        if (!lastMsg || lastMsg.is_user) return;

        var id = liveChat.length - 1;
        if (id === Store.lastCountedMsgId) return; // same slot fired again (swipe/regen/stream) — not a new message
        if (id < Store.lastCountedMsgId) {
            // Chat is now shorter than our last high-water mark — messages were deleted
            // or a branch/checkpoint was switched. Leaving the old (now-stale) mark in
            // place would permanently block genuinely new messages: id would stay <=
            // lastCountedMsgId forever until enough new messages happened to push back
            // past the old mark. Resume tracking from the current last message instead.
            console.log("[Story Tracker] Chat is shorter than the last tracked message (deletion or branch switch) — resuming tracking from the current last message.");
        }

        var msgObj = lastMsg;
        if (!msgObj || typeof msgObj.mes !== "string" || !msgObj.mes.trim()) return;

        // Init race guard: if a generation finishes before any CHAT_CHANGED has fired
        // this session (extension loaded after the chat did), storyData was never
        // loaded — pull it in now rather than dereferencing null below.
        if (!Store.storyData) loadStoryData();
        if (!Store.storyData) return;

        // Which chat this whole pipeline run belongs to. Every resumption point
        // after an `await` (startup delay, LLM calls, inter-tracker delays)
        // re-checks this: Store.storyData/worldData and ST's chat_metadata are
        // live bindings that CHAT_CHANGED swaps mid-flight, so continuing after
        // a chat switch would write this chat's analysis into the new chat.
        var pipelineChatId = Store.getCurrentChatId();
        function pipelineChatChanged() {
            return Store.getCurrentChatId() !== pipelineChatId;
        }

        Store.setLastCountedMsgId(id);
        saveStoryData();

        if (!Store.settings.enabled) return;

        // Small startup delay so ST's full pipeline (streaming, post-processors) finishes
        // before we start our own chain. Especially important on slow devices like Termux.
        await new Promise(function(r) { setTimeout(r, Store.settings.startupDelay || 2000); });

        if (!Store.isChatOpen()) {
            console.warn("[Story Tracker] Event ignored: No active chat is open.");
            return;
        }
        if (pipelineChatChanged()) {
            console.warn("[Story Tracker] Chat switched during the startup delay — abandoning this message's tracker run.");
            return;
        }

        if (!Store.TimelineEngine || !Store.Scheduler || !Store.EventQueue) {
            console.warn("[Story Tracker] Timeline Engine modules not loaded yet, skipping this cycle.");
            return;
        }

        Store.setRelMsgCounter(Store.relMsgCounter + 1);
        saveStoryData();

        // Every tracker call below (Scene, World tiers, Relationship) shares ONE connection
        // profile session for this message — see runTrackerProfileSession/withTrackerProfile.
        // Previously each tracker independently switched to its own profile and switched
        // straight back afterward, so a message where e.g. both Scene and a World tier fired
        // meant bouncing the ST-wide active profile back and forth for no reason (worse still
        // if they're configured to the SAME profile). Wrapping the whole pipeline in one
        // session means the real "switch back to what the user had active" only happens once,
        // after everything below has had its turn.
        await runTrackerProfileSession(async function () {

        // =====================================================================================
        // TIMELINE ENGINE PIPELINE — runs once per message, before anything else.
        // JS is the sole authority over elapsed time; nothing below asks an LLM what time it is.
        // =====================================================================================
        var timeBeforeMsg = { time: Store.storyData.time, date: Store.storyData.date };
        var orderedDueTiers = [];

        var sceneAlreadyFiredThisMessage = false;
        // Declared out here — NOT inside the `_initialized` block below — because both
        // are read unconditionally further down (the weather early-fire path and the
        // big-skip check). On a genesis message the `_initialized` block is skipped
        // entirely, and when these lived inside it that meant `tlResult.explicitSkip` /
        // `rollbackTotals.weather` threw on every new chat's first response.
        var tlResult = null;
        var rollbackTotals = {};
        // "Auto-update Scene" toggle (per-chat value, falling back to the global
        // setting) — gates every AUTOMATIC Scene Agent call below, including the
        // genesis init. Previously this was display-only: the footer said
        // "Auto-update: OFF" while updates kept firing anyway.
        var sceneAutoUpdate = (Store.storyData.autoUpdate !== undefined) ? Store.storyData.autoUpdate : Store.settings.autoUpdate;

        if (Store.storyData._initialized) {
            var preResolveTime = Store.storyData.time, preResolveDate = Store.storyData.date, preResolveEpoch = Store.storyData._timeEpoch;
            var preResolveState = { currentTime: preResolveTime, currentDate: preResolveDate, currentEpoch: preResolveEpoch };

            // The flat baseline ALWAYS runs — purely cosmetic continuity (the HUD's time/date
            // never looks frozen between real updates), not an estimate of anything. Scene
            // Agent's own time_advance answer (folded into its single call — see doLLMUpdate)
            // is what replaces this with a real LLM-reasoned duration when Scene fires below;
            // if Scene doesn't fire this message, this flat tick is what stands.
            tlResult = Store.TimelineEngine.advanceBaseline(preResolveState);

            // --- Decide whether Scene Agent should fire THIS message ---
            // Scene Agent is now the ONE AND ONLY place time_advance gets decided (no more
            // separate Time Resolver call), so that decision — and the clock correction it
            // may produce — has to happen BEFORE Scheduler.evaluate()/EventQueue.processTime()
            // below, so those still get credited with the real elapsed amount for a message
            // where a genuine time skip occurred, same as the old dedicated resolver call
            // used to provide.
            // sceneTierMinutes is a Smart Time-only concern now: a time-based fallback cadence
            // for when skip-language detection doesn't fire for a while. In Message Mode the
            // messageModeInterval cadence below is already the sole driver of when Scene fires,
            // so an RP-minutes interval on top of it would just be a redundant second trigger —
            // gated out entirely rather than left to race the message-count cadence.
            var sceneAccumPeek = (Store.worldData && Store.worldData._schedulerAccumulated && Store.worldData._schedulerAccumulated.scene) || 0;
            var sceneDueByInterval = Store.settings.timeMode === "smart" &&
                                      (sceneAccumPeek + tlResult.elapsedMinutes) >= Store.settings.sceneTierMinutes;

            // Message Mode vs Smart Time is now purely about WHEN Scene Agent itself fires,
            // not which call fires:
            //  "message" — cadence-based, every messageModeInterval messages one Scene call
            //  reviews the whole batch since its last checkpoint (existing scene-checkpoint
            //  logic in doLLMUpdate already does this), same philosophy as the Relationship
            //  tracker's message-interval mode.
            //  "smart" — event-driven: a cheap local check (no LLM call) for genuine forward
            //  time-skip language in THIS message fires Scene Agent right away, backed by the
            //  sceneDueByInterval fallback above in case skip-language never shows up.
            Store.storyData._timeModeMsgCounter = (Store.storyData._timeModeMsgCounter || 0) + 1;
            var messageModeDue = Store.settings.timeMode === "message" &&
                                  Store.storyData._timeModeMsgCounter >= (Store.settings.messageModeInterval || 5);

            if (Store.storyData._bigJumpCooldown > 0) Store.storyData._bigJumpCooldown--;
            // User-editable extra trigger phrases (one per line in settings) — the only
            // way the skip trigger can fire at all for non-English RP, since the
            // built-in regex/lexicon are English-only. Parsed fresh each message; it's
            // a cheap string split and picks up settings edits immediately.
            var customSkipPhrases = Store.TimelineEngine.parseCustomSkipPhrases(Store.settings.customSkipPhrases);
            // Scan the USER's message too, not just the character's reply: this
            // pipeline runs on GENERATION_ENDED, so a user-authored "*three days
            // pass*" was previously only caught if the reply happened to echo it.
            // Only the IMMEDIATE predecessor is scanned (and only if it's a user
            // message), so consecutive AI replies in a group chat don't keep
            // re-triggering off the same old user text. The two texts are checked
            // SEPARATELY, not concatenated — PAST_TENSE_GUARD_RE vetoes per-text,
            // and an "ago" in one message shouldn't silence a genuine skip in the other.
            var prevUserMsg = (id > 0 && liveChat[id - 1] && liveChat[id - 1].is_user) ? liveChat[id - 1] : null;
            var skipLanguageTrigger = Store.settings.timeMode === "smart" &&
                                       !(Store.storyData._bigJumpCooldown > 0) &&
                                       ((!!(msgObj && msgObj.mes) && Store.TimelineEngine.detectTimeSkipTrigger(msgObj.mes, customSkipPhrases)) ||
                                        (!!(prevUserMsg && typeof prevUserMsg.mes === "string" && prevUserMsg.mes.trim()) &&
                                         Store.TimelineEngine.detectTimeSkipTrigger(prevUserMsg.mes, customSkipPhrases)));

            var sceneDue = sceneAutoUpdate && (sceneDueByInterval || messageModeDue || skipLanguageTrigger);

            if (sceneDue && !Store.busy && Store.genRaw) {
                Store.setBusy(true);
                sceneAlreadyFiredThisMessage = true;
                if (skipLanguageTrigger) Store.storyData._bigJumpCooldown = BIG_JUMP_COOLDOWN_MESSAGES;
                saveStoryData();
                HUD.setHudStatus("Scene...");
                if (typeof toastr !== "undefined") {
                    var sceneReason = (skipLanguageTrigger && !sceneDueByInterval && !messageModeDue)
                        ? "Story Tracker: Time-skip language detected — updating scene early..."
                        : "Story Tracker: Analyzing scene...";
                    toastr.info(sceneReason, "", { timeOut: 0, extendedTimeOut: 0 });
                }
                var sceneUpdateFailed = false;
                try {
                    // The span anchor: the clock AS OF THE LAST SCENE UPDATE, not the clock
                    // just before this message. Scene reviews the whole span since its last
                    // checkpoint and reports elapsed time for ALL of it — measuring that
                    // from the pre-this-message clock double-counted every interim message's
                    // flat baseline tick (4 interim ticks + a 10-minute span answer produced
                    // +14, not +10, contradicting the documented "replaces the flat ticks").
                    var sceneSpanAnchor = (typeof Store.storyData._sceneAnchorEpoch === "number" && isFinite(Store.storyData._sceneAnchorEpoch))
                        ? { currentTime: Store.storyData._sceneAnchorTime, currentDate: Store.storyData._sceneAnchorDate, currentEpoch: Store.storyData._sceneAnchorEpoch }
                        : preResolveState; // old saves without the anchor fields — previous behavior
                    var sceneTl = await doLLMUpdate(sceneSpanAnchor);
                    if (sceneTl) {
                        // sceneTl's clock is already forward-clamped by doLLMUpdate (a span
                        // answer smaller than the interim ticks can't wind the visible clock
                        // backward). The Scheduler, though, must only be credited with what's
                        // NEW this message — the interim baseline ticks were already credited
                        // on their own messages, so crediting the whole span again would
                        // drift every world tier ahead by (interval-1) minutes per cycle.
                        var newlyElapsed = (typeof preResolveEpoch === "number" && isFinite(preResolveEpoch))
                            ? Math.max(0, (sceneTl.currentEpoch - preResolveEpoch) / 60000)
                            : sceneTl.elapsedMinutes;
                        tlResult = Object.assign({}, sceneTl, { elapsedMinutes: newlyElapsed });
                    }
                    // Cadence counters only reset on a SUCCESSFUL update — resetting them
                    // unconditionally (the old behavior) meant a failed call silently ate a
                    // full Message Mode cadence / Smart Time interval, identical to the
                    // world-tier bug fixed alongside this (see rollbackTotals below).
                    Store.storyData._timeModeMsgCounter = 0;
                } catch (e) {
                    console.error("[Story Tracker] Scene update failed, keeping flat baseline:", e);
                    sceneUpdateFailed = true;
                }
                saveStoryData();
                Store.setBusy(false);
                HUD.clearHudStatus();
                if (typeof toastr !== "undefined") toastr.clear();
            } else if (sceneDue) {
                console.log("[Story Tracker] Scene tier due but a previous analysis is still running (or no generator available) — will retry next message.");
            }

            if (pipelineChatChanged()) {
                console.warn("[Story Tracker] Chat switched during the scene analysis — abandoning this message's tracker run before writing anything.");
                return;
            }

            Store.storyData.time = tlResult.currentTime;
            Store.storyData.date = tlResult.currentDate;
            Store.storyData._timeEpoch = tlResult.currentEpoch;
            // Refresh the span anchor to the final applied clock whenever scene ran
            // this message — the NEXT span's elapsed answer measures from here.
            // (doLLMUpdate sets these too, but this message's own tick/clamp is only
            // known after tlResult is applied, so last-write-wins here.)
            if (sceneAlreadyFiredThisMessage && !sceneUpdateFailed) {
                Store.storyData._sceneAnchorTime = tlResult.currentTime;
                Store.storyData._sceneAnchorDate = tlResult.currentDate;
                Store.storyData._sceneAnchorEpoch = tlResult.currentEpoch;
            }
            saveStoryData();
            console.log("[Story Tracker] Timeline advanced " + tlResult.elapsedMinutes.toFixed(1) + "min (" + tlResult.source + ") -> " + Store.storyData.time + " " + Store.storyData.date);

            // The clock (and only the clock) is JS-driven and moves every message, independent
            // of whether any tracker tier is actually due this turn — refresh the HUD's time/date
            // row immediately so it never looks frozen while waiting for the next Scene update.
            HUD.renderHUD();

            // --- EventQueue: resolve any scheduled future actions whose time has come ---
            if (Store.worldData) {
                var eqResult = Store.EventQueue.processTime(Store.worldData._eventQueue || [], Store.storyData.time, Store.storyData.date);
                Store.worldData._eventQueue = eqResult.queue;
                if (eqResult.resolved.length > 0) {
                    var resolvedAsEvents = eqResult.resolved.map(function(e) {
                        return { event: (e.actor ? e.actor + ": " : "") + e.action, importance: 5, time: e.executeTime, date: e.executeDate };
                    });
                    Store.worldData.worldEvents = Store.WorldAgent.mergeWorldEvents(Store.worldData.worldEvents, resolvedAsEvents, 15);
                    console.log("[Story Tracker] EventQueue resolved " + eqResult.resolved.length + " event(s).");
                }
                // Keep the resolved/cancelled history bounded — pending (still-active)
                // events are never touched by this, only settled history gets capped.
                Store.worldData._eventQueue = Store.EventQueue.pruneQueue(Store.worldData._eventQueue, 30);
                saveWorldData();
            }

            // --- Scheduler: decide which tiers are due ---
            // rollbackTotals (declared at the top of this handler): if a due tier's LLM
            // call later fails (network error, malformed JSON, etc.), runDueWorldTiers()
            // restores that tier's accumulator to the value captured here instead of
            // leaving it at the optimistic post-evaluate reset — see the per-tier
            // try/catch in runDueWorldTiers below.
            if (Store.worldData) {
                var preEvalAccumulated = Object.assign({}, Store.worldData._schedulerAccumulated || {});
                var schedResult = Store.Scheduler.evaluate({
                    elapsedMinutes: tlResult.elapsedMinutes,
                    accumulated: Store.worldData._schedulerAccumulated || {},
                    config: {
                        intervals: {
                            scene: Store.settings.sceneTierMinutes, npc: Store.settings.npcTierMinutes,
                            weather: Store.settings.weatherTierMinutes, faction: Store.settings.factionTierMinutes, world: Store.settings.worldTierMinutes,
                        },
                        maxCatchupTicks: Store.settings.maxWorldTicks,
                        // Only 'faction' actually does anything with a large ticksDue count — it
                        // tags each generated event to a specific interval_index across a batched
                        // timestamp list (see runFactionTier), so DEFERRING extra ticks (the
                        // Scheduler default) makes sense there: catching up gradually over a few
                        // messages spreads the work out without losing anything.
                        //
                        // scene/npc/weather/world fire exactly ONE LLM call per due-tier no matter
                        // how large ticksDue is (scene via doLLMUpdate, the rest via
                        // runDueWorldTiers — all of them only ever look at the isBatch boolean,
                        // never the tick count). For those, deferring bought nothing but left a
                        // large stranded remainder that kept re-triggering 'due' long after the one
                        // real update already fired (the stuck-at-0 HUD bug). So they discard any
                        // excess beyond maxCatchupTicks instead: still bounded to a sane batch size
                        // (protects against one bad elapsed-time estimate forcing a huge fictional
                        // gap through in a single call), fires once, and the accumulator resets
                        // cleanly — no stranded debt either way.
                        discardExcessTicksPerTier: { scene: true, npc: true, weather: true, world: true },
                    },
                });
                Store.worldData._schedulerAccumulated = schedResult.accumulated;
                // Undiscounted totals a due tier held BEFORE this evaluate() consumed/reset
                // it — the value runDueWorldTiers() rolls a tier back to if its call fails,
                // so a transient failure retries next message instead of silently waiting
                // out a whole fresh interval.
                Object.keys(schedResult.due).forEach(function (tier) {
                    rollbackTotals[tier] = (preEvalAccumulated[tier] || 0) + tlResult.elapsedMinutes;
                });
                // Scene is never dispatched by the world-tiers block below (it was already
                // handled — or deliberately skipped — above), so always strip it back out of
                // what evaluate() just computed. What its accumulator resets to depends on
                // what actually happened this message:
                //   - scene ran and succeeded  -> 0 (interval genuinely consumed)
                //   - scene ran and failed     -> rollback (retry next message)
                //   - scene DIDN'T run (busy, auto-update off, Message Mode cadence not due)
                //     -> rollback too. Previously this case silently zeroed the accumulator
                //     via discardExcessTicksPerTier, which meant the "due but busy — will
                //     retry next message" log was a lie: the due interval was eaten and the
                //     retry never came.
                if (schedResult.due.scene) {
                    delete schedResult.due.scene;
                    var sceneConsumed = sceneAlreadyFiredThisMessage && !sceneUpdateFailed;
                    Store.worldData._schedulerAccumulated.scene = sceneConsumed
                        ? 0
                        : (rollbackTotals.scene != null ? rollbackTotals.scene : Store.worldData._schedulerAccumulated.scene);
                }
                saveWorldData();
                orderedDueTiers = Store.Scheduler.orderDueTiers(schedResult.due);
            }
        }

        // Genesis case: the timeline pipeline above only runs once storyData is already
        // initialized, so the very first message needs its own trigger to get Scene Agent's
        // initial setup call running (this is the ONLY case where Scene fires without an
        // established previousState time to measure time_advance from — SceneAgent.js's
        // "This is the INITIAL setup" framing already covers that).
        if (!Store.storyData._initialized && sceneAutoUpdate && !Store.busy && Store.genRaw && !sceneAlreadyFiredThisMessage) {
            Store.setBusy(true);
            sceneAlreadyFiredThisMessage = true;
            HUD.setHudStatus("Scene...");
            if (typeof toastr !== "undefined") toastr.info("Story Tracker: Analyzing scene...", "", { timeOut: 0, extendedTimeOut: 0 });
            try {
                await doLLMUpdate({ currentTime: Store.storyData.time, currentDate: Store.storyData.date, currentEpoch: Store.storyData._timeEpoch });
            } catch (e) { console.error(e); }
            // The genesis call just seeded the regional weather trend (world_seed), and
            // opening prose is full of phrases the weather-mention scanner matches
            // ("the first snow", "fog rolls in") — without this, the scan further down
            // would immediately spend a second LLM call re-deriving the trend genesis
            // established seconds ago. Reuses the standard mention-cooldown; the
            // interval-based weather cadence is unaffected.
            if (Store.storyData && Store.storyData._initialized) {
                Store.storyData._weatherChangeCooldown = WEATHER_CHANGE_COOLDOWN_MESSAGES;
                saveStoryData();
            }
            Store.setBusy(false);
            HUD.clearHudStatus();
            if (typeof toastr !== "undefined") toastr.clear();
        }

        // ">= interval", NOT "% interval === 0": the counter only resets when an
        // analysis actually completes (see consumeRelationshipCadence in
        // doRelationshipUpdate). With the old modulo check, a due tick that got
        // skipped (relsBusy) or failed (unparseable response) let the counter roll
        // PAST the exact multiple, and the next chance was a full interval later
        // (miss at 5 -> next fire at 10). The world tiers already got rollback
        // machinery for exactly this failure mode; this is the relationship
        // tracker's equivalent — a missed/failed tick stays due and retries on the
        // very next message instead of silently waiting out a fresh interval.
        var needsRelUpdate = Store.settings.relationsEnabled && Store.settings.relationsAutoUpdate &&
                              Store.relMsgCounter >= (Store.settings.relAutoInterval || 5);

        // Scene's own due-ness (interval / message-mode cadence / smart-time skip-language
        // early trigger) was already decided and, if due, already run ABOVE — before
        // Scheduler.evaluate() — since Scene Agent is now the one place time_advance gets
        // decided and that correction needs to land before Scheduler/EventQueue see this
        // message's elapsed time. orderedDueTiers is already scene-free by this point (see
        // the "sceneAlreadyFiredThisMessage" handling above), so nothing further to do for
        // scene here — just world tiers.
        var worldTiersDue = orderedDueTiers;

        if (!sceneAlreadyFiredThisMessage) window.renderAutoInfo();
        else { window.renderModal(); HUD.renderHUD(); }

        // Weather now defaults to a ~daily interval (see Scheduler.js) since regional
        // weather realistically doesn't change every couple hours — but an explicit,
        // visible weather change in the actual narration shouldn't have to wait out that
        // whole interval. WorldAgent.detectWeatherChangeMention is the same "cheap, local,
        // deliberately dumb" philosophy as the time-skip trigger: it doesn't decide
        // anything about the weather itself, just whether it's worth an early tick. Same
        // message-based cooldown pattern as Scene's own skip-language early fire, so a
        // stretch of several consecutive weather-mentioning messages doesn't force a fresh
        // tick every single time.
        if (Store.storyData._weatherChangeCooldown > 0) Store.storyData._weatherChangeCooldown--;
        var weatherDueByInterval = worldTiersDue.some(function(d) { return d.tier === "weather"; });
        var weatherChangeDetected = !weatherDueByInterval && Store.WorldAgent.detectWeatherChangeMention(msgObj.mes) && !(Store.storyData._weatherChangeCooldown > 0);
        if (weatherChangeDetected) {
            worldTiersDue = worldTiersDue.concat([{ tier: "weather", ticksDue: 1, ticksDeferred: 0, intervalMinutes: Store.settings.weatherTierMinutes }]);
            if (Store.worldData && Store.worldData._schedulerAccumulated) {
                rollbackTotals.weather = Store.worldData._schedulerAccumulated.weather || 0;
                Store.worldData._schedulerAccumulated.weather = 0;
                saveWorldData();
            }
            Store.storyData._weatherChangeCooldown = WEATHER_CHANGE_COOLDOWN_MESSAGES;
            saveStoryData();
            console.log("[Story Tracker] Weather change mentioned in-scene — running weather tier early.");
        }

        // A large EXPLICIT skip (Scene Agent set explicit_skip:true on an "elapsed" answer
        // bigger than a single world-tier interval) needs the world tiers to reason about the
        // TRUE gap, not the Scheduler-capped one — see runDueWorldTiers' bigSkipInfo handling.
        var isBigExplicitSkip = !!(tlResult && tlResult.explicitSkip) && tlResult.elapsedMinutes > (Store.settings.worldTierMinutes || 1440);
        var bigSkipInfo = isBigExplicitSkip
            ? { isBigSkip: true, totalElapsedMinutes: tlResult.elapsedMinutes }
            : null;
        if (isBigExplicitSkip) {
            console.log("[Story Tracker] Large explicit time skip detected (" + tlResult.elapsedMinutes.toFixed(0) + " min) — world tiers will reason about the full gap.");
        }

        // Run agents sequentially to avoid concurrent API requests on rate-limited backends.
        if (Store.settings.enabled && Store.settings.worldEnabled && worldTiersDue.length > 0) {
            if (!Store.worldBusy) {
                await new Promise(function(r) { setTimeout(r, 1500); });
                if (pipelineChatChanged()) {
                    console.warn("[Story Tracker] Chat switched before the world tiers could run — abandoning them for this message.");
                    return;
                }
                // runDueWorldTiers() owns its own HUD/toast feedback internally, and only shows
                // it when tiers are genuinely about to run — not on every message check.
                await runDueWorldTiers(worldTiersDue, timeBeforeMsg, rollbackTotals, bigSkipInfo);
            } else if (Store.worldData && Store.worldData._schedulerAccumulated) {
                // Tiers were due, but a call was already in flight (manual "Run World Tick"
                // racing the auto-trigger, or a slow prior call still resolving). Scheduler.
                // evaluate() above already optimistically consumed each due tier's accumulator
                // on the assumption the tick was about to run; since it never did, roll that
                // back the same way a failed LLM call already does (see rollbackTotals above)
                // instead of silently losing it — it re-surfaces as due again next message.
                Object.keys(rollbackTotals).forEach(function (t) {
                    Store.worldData._schedulerAccumulated[t] = rollbackTotals[t];
                });
                saveWorldData();
                console.log("[Story Tracker] World tiers were due but busy elsewhere — deferred to next message instead of being dropped.");
            }
        }

        if (needsRelUpdate && !Store.relsBusy) {
            // Take the relsBusy lock for the auto path too — previously only the manual
            // Analyze button set it, so clicking Analyze mid-auto-update ran two
            // doRelationshipUpdate() calls concurrently against the same edges.
            Store.setRelsBusy(true);
            try {
                await new Promise(function(r) { setTimeout(r, 1500); });
                if (pipelineChatChanged()) {
                    console.warn("[Story Tracker] Chat switched before the relationship update could run — abandoning it for this message.");
                    return;
                }
                HUD.setHudStatus("Relations...");
                if (typeof toastr !== "undefined") toastr.info("Story Tracker: Analyzing relationships...", "", { timeOut: 0, extendedTimeOut: 0 });
                await doRelationshipUpdate();
                if ($("#st-tab-relations").is(":visible")) window.renderRelationshipGraph();
                HUD.clearHudStatus();
                if (typeof toastr !== "undefined") { toastr.clear(); toastr.info("Relationships updated."); }
            } catch(e) {
                HUD.clearHudStatus();
                if (typeof toastr !== "undefined") toastr.clear();
                console.error("[Story Tracker] Auto relationship update failed:", e);
            } finally {
                Store.setRelsBusy(false);
            }
        }
        }); // end runTrackerProfileSession
    };

    es.on(et.GENERATION_ENDED, handleMsg);
    es.on(et.GENERATION_STARTED, function() { if (Store.settings.enabled) injectContextToChat(); });
}

// --- UI Rendering ---
// --- Core LLM Scene Update Engine ---
// timeAnchor (optional): { currentTime, currentDate, currentEpoch } — the clock as of the
// LAST SCENE UPDATE (the start of the span this call reviews), i.e. the reference point
// Scene Agent's time_advance answer measures the whole reviewed span from. Defaults to the
// stored span anchor (falling back to storyData's current clock) when not supplied — the
// manual "Update Now" button and the genesis call. The resulting clock is clamped
// forward-only against the CURRENT clock, so a span answer smaller than the interim
// baseline ticks can never wind the visible clock backward. Returns the resulting clock
// info ({ elapsedMinutes, currentTime, currentDate, currentEpoch, source }) if time_advance
// produced a real correction (elapsed/advance_to_event), or null if it didn't
// (schedule/none/invalid) — caller should keep whatever flat-baseline tlResult it already
// had in that case.
export async function doLLMUpdate(timeAnchor) {
    if (!Store.genRaw) throw new Error("Story Tracker: Raw LLM generation not available.");
    if (!Store.isChatOpen()) throw new Error("Story Tracker: No active chat is open.");
    if (!Store.TimelineEngine || !Store.SceneAgent) throw new Error("Story Tracker: Timeline Engine modules not loaded yet.");

    loadStoryData();
    if (!Store.storyData) throw new Error("Story Tracker: No story data available.");

    // Chat identity guard — checked again after every LLM await below, before any
    // result is written. Store.storyData/chat_metadata are live bindings; a chat
    // switch mid-call would otherwise land this chat's analysis in the new chat.
    var chatIdAtEntry = Store.getCurrentChatId();

    var anchorState = timeAnchor || (
        (typeof Store.storyData._sceneAnchorEpoch === "number" && isFinite(Store.storyData._sceneAnchorEpoch))
            ? { currentTime: Store.storyData._sceneAnchorTime, currentDate: Store.storyData._sceneAnchorDate, currentEpoch: Store.storyData._sceneAnchorEpoch }
            : { currentTime: Store.storyData.time, currentDate: Store.storyData.date, currentEpoch: Store.storyData._timeEpoch }
    );

    // Forward-only floor for the resulting clock: whatever the visible clock reads
    // RIGHT NOW. The span anchor above sits in the past (interim messages' baseline
    // ticks have advanced the display since), so a small span answer computes a
    // target before the current clock — clamp rather than ever moving backward.
    var clockFloorEpoch = (typeof Store.storyData._timeEpoch === "number" && isFinite(Store.storyData._timeEpoch))
        ? Store.storyData._timeEpoch
        : (function () {
            var parsed = Store.TimelineEngine.parseDateTime(Store.storyData.time, Store.storyData.date);
            return parsed ? parsed.getTime() : null;
        })();

    // Build recent chat context using checkpoint system.
    // First run: last 20 messages. Subsequent runs: only messages since last scene checkpoint.
    var liveChat = Store.getLiveChat() || [];
    var userName = (Store.scriptModule && Store.scriptModule.name1) ? Store.scriptModule.name1 : "{{user}}";
    var sceneLastCheckpoint = -1;
    if (Store.storyData._sceneCheckpointIdx != null) {
        var scpIdx = Store.storyData._sceneCheckpointIdx;
        var scpAnchor = Store.storyData._sceneCheckpointAnchor || "";
        var scpMsg = liveChat[scpIdx];
        var scpText = (scpMsg && scpMsg.mes) ? String(scpMsg.mes).slice(0, 40) : "";
        if (scpAnchor && scpText === scpAnchor) {
            sceneLastCheckpoint = scpIdx;
        } else {
            console.warn("[Story Tracker] Scene checkpoint anchor mismatch - falling back to last 20 messages.");
        }
    }
    var sceneMsgs = sceneLastCheckpoint >= 0
        ? liveChat.slice(sceneLastCheckpoint + 1)
        : liveChat.slice(-20);
    if (sceneMsgs.length < 3) sceneMsgs = liveChat.slice(-3);
    var chatContext = "";
    var newMessageTexts = [];
    sceneMsgs.forEach(function(msg) {
        var senderName = msg.is_user ? userName : (msg.name || "Character");
        var text = (msg.mes || "").trim();
        if (text) { chatContext += senderName + ": " + text + "\n\n"; newMessageTexts.push(text); }
    });
    chatContext = chatContext.trim() || "No messages yet.";

    // storyData.time/date at this point are the clock AS OF THE LAST message (the message
    // handler calls doLLMUpdate before applying this message's own flat baseline tick) — that's
    // exactly `anchorState`, the reference point Scene Agent's time_advance answer measures
    // the whole reviewed span from. Scene Agent decides time_advance itself now (no separate
    // Time Resolver call) — see the time_advance handling below, after the LLM response comes back.

    var outfit = window.getInventoryOutfit();
    var previousStateInput = {
        initialized: Store.storyData._initialized,
        location: Store.storyData.location, city: Store.storyData.city, country: Store.storyData.country,
        temperature: Store.storyData.temperature, weather: Store.storyData.weather,
        userOutfitText: (outfit && outfit.userEquipped.length > 0) ? outfit.userEquipped.map(function(it) { return it.label + ": " + it.name; }).join(", ") : null,
        charItemsText: (outfit && outfit.charItems.length > 0) ? outfit.charItems.map(function(ci) { return ci.name + " (held by " + ci.heldBy + ")"; }).join(", ") : null,
    };

    var scenePending = buildPendingEventsPromptText();

    // Snapshot the reveals list THIS prompt will number — resolution after the
    // response maps the model's 1-based indices back onto exactly this snapshot
    // (matching by string against the live array), so it stays correct even if
    // something else touches pendingReveals while the LLM call is in flight.
    var revealsSnapshot = (Store.settings.worldEnabled && Store.worldData && Array.isArray(Store.worldData.pendingReveals))
        ? Store.worldData.pendingReveals.slice()
        : [];
    var pendingRevealsText = revealsSnapshot.length > 0
        ? revealsSnapshot.map(function(r, i) { return (i + 1) + ". " + r; }).join("\n")
        : "";

    // Genesis-only: deterministic seeding found no time cue in the opening text, so
    // storyData.time is just the 12:00 placeholder — ask this initial-setup call to
    // establish the real starting clock instead (see SceneAgent.extractStartingTime).
    // `!== "text"` rather than `=== "fallback"`: an uninitialized chat whose
    // storyData predates these fields (created before an extension update, replied
    // to after) has them UNDEFINED — that's still "the scan established nothing",
    // so the model should be asked, not silently left on the placeholder/random
    // values. Asking is genesis-only either way, so it can never over-trigger.
    var askStartingTime = !Store.storyData._initialized && Store.storyData._timeSeededFrom !== "text";
    // Same for the calendar date: the deterministic seedInitialDate() scan found no
    // cue, so storyData.date is still the random fallback — ask this initial-setup
    // call to establish a date that actually fits the story instead (see
    // SceneAgent.extractStartingDate).
    var askStartingDate = !Store.storyData._initialized && Store.storyData._dateSeededFrom !== "text";

    // Genesis Prime: the initial-setup call is the ONE moment where scene, world,
    // relationships, and the World Rules digest all share an identical evidence
    // base (opening text + card lore), so they're all established by this single
    // call instead of separate ones — one context payload, several small output
    // sections, each validated independently (see applyGenesisSeeds below). This
    // is also deliberately the only AUTOMATIC call that ever carries the raw card
    // text: afterwards the world tiers run on the distilled digest instead.
    var isGenesisSetup = !Store.storyData._initialized;
    var genesisLoreText = null;
    if (isGenesisSetup) {
        genesisLoreText = getCharacterLoreText();
        // Fold in the optional world-seed lorebook so genesis distills the World
        // Rules from card lore AND the chosen book. A lorebook-only seed (empty
        // card) is fine — genesisLoreText becomes non-empty, so askLoreDigest below
        // still fires.
        var genesisSeedBook = Store.settings.worldEnabled ? await getSeedLorebookText() : "";
        if (genesisSeedBook) genesisLoreText = genesisLoreText ? (genesisLoreText + "\n\n" + genesisSeedBook) : genesisSeedBook;
    }

    var prompt = Store.SceneAgent.buildScenePrompt({
        currentTime: anchorState.currentTime,
        currentDate: anchorState.currentDate,
        previousState: previousStateInput,
        recentChatText: chatContext,
        userName: userName,
        askStartingTime: askStartingTime,
        askStartingDate: askStartingDate,
        askWorldSeed: isGenesisSetup && !!Store.settings.worldEnabled,
        askRelationshipSeed: isGenesisSetup && !!Store.settings.relationsEnabled,
        askLoreDigest: isGenesisSetup && !!Store.settings.worldEnabled && !!genesisLoreText,
        characterLoreText: genesisLoreText,
        relationshipTypesText: (Store.RelationshipAgent && Store.RelationshipAgent.VALID_TYPES) ? Store.RelationshipAgent.VALID_TYPES.join(", ") : null,
        pendingEventsText: scenePending.pendingEventsText,
        pendingRevealsText: pendingRevealsText,
        // Grounds Scene Agent's per-message weather guess in the World Agent's broader
        // trend, when one exists — see SceneAgent.buildScenePrompt's regionalWeatherTrend
        // doc comment. worldData is loaded lazily elsewhere in this file; guard for the
        // "not loaded yet this session" case rather than forcing a load here, since a
        // missing trend just means Scene Agent falls back to its normal blind-guess
        // behavior, same as before this was added.
        regionalWeatherTrend: (typeof Store.worldData !== "undefined" && Store.worldData && Store.worldData.weatherTrend) ? Store.worldData.weatherTrend : null,
    });

    var raw = await withConnectionProfile(async function() {
        try {
            return await Store.genRaw({ prompt: prompt, quietToLoud: true });
        } catch(e) {
            logGenRawFailure("scene update", e);
            return await Store.genRaw(prompt, null, false, true);
        }
    });

    var data = cleanAndParseJSON(raw);
    if (!data) throw new Error("Story Tracker: Failed to parse LLM scene analysis response.");

    // The chat may have been switched while the LLM call was in flight — everything
    // below MUTATES Store.storyData/worldData, which now belong to the new chat.
    // Discard the stale result instead of contaminating the newly opened chat.
    if (Store.getCurrentChatId() !== chatIdAtEntry) {
        throw new Error("Story Tracker: chat changed during scene analysis — discarded the stale result.");
    }

    // applySceneResponse() never reads a time/date field from the response even if present —
    // see SceneAgent.js. The only time-related value read anywhere is time_advance, handled
    // just below via the same validated (type, minutes) contract the old dedicated Time
    // Resolver used — never a raw time/date string invented by the model.
    // Snapshot of the scene BEFORE this update lands — this is what the Location
    // Codex remembers about a place at the moment the party leaves it.
    var prevScene = {
        initialized: Store.storyData._initialized,
        location: Store.storyData.location,
        characters: (Store.storyData.characters || []).map(function(c) { return { name: c.name, state: c.state }; }),
        recentEvents: Store.storyData.recent_events,
        time: Store.storyData.time, date: Store.storyData.date,
        weather: Store.storyData.weather, temperature: Store.storyData.temperature,
    };

    var patch = Store.SceneAgent.applySceneResponse(data);
    if (patch) Object.assign(Store.storyData, patch);

    // --- Genesis starting time/date: only consulted when this call was explicitly
    // asked for them (un-initialized chat whose deterministic seeding fell back to
    // the 12:00 placeholder and/or the random date). Applied BEFORE the
    // time_advance handling below, with anchorState and the forward-only floor
    // rebuilt from the result — otherwise an "elapsed" answer would be measured
    // from the stale placeholder and overwrite the starting clock it just
    // established (or an earlier pick would be clamped straight back up to it).
    var genesisClockChanged = false;
    if (askStartingTime && typeof Store.SceneAgent.extractStartingTime === "function") {
        var startingTime = Store.SceneAgent.extractStartingTime(data);
        if (startingTime) {
            Store.storyData.time = startingTime;
            Store.storyData._timeSeededFrom = "llm";
            genesisClockChanged = true;
            console.log("[Story Tracker] Genesis starting time established by Scene Agent: " + startingTime);
        } else {
            console.log("[Story Tracker] Scene Agent returned no usable starting_time — keeping the neutral 12:00 fallback.");
        }
    }
    if (askStartingDate && typeof Store.SceneAgent.extractStartingDate === "function") {
        var startingDate = Store.SceneAgent.extractStartingDate(data);
        if (startingDate) {
            Store.storyData.date = startingDate;
            Store.storyData._dateSeededFrom = "llm";
            genesisClockChanged = true;
            console.log("[Story Tracker] Genesis starting date established by Scene Agent: " + startingDate);
        } else {
            console.log("[Story Tracker] Scene Agent returned no usable starting_date — keeping the random fallback date.");
        }
    }
    if (genesisClockChanged) {
        var genesisDateObj = Store.TimelineEngine.parseDateTime(Store.storyData.time, Store.storyData.date);
        if (genesisDateObj) Store.storyData._timeEpoch = genesisDateObj.getTime();
        anchorState = { currentTime: Store.storyData.time, currentDate: Store.storyData.date, currentEpoch: Store.storyData._timeEpoch };
        clockFloorEpoch = Store.storyData._timeEpoch;
    }

    // --- Genesis seeds: world state, relationships, and the World Rules digest
    // this same call established (see the isGenesisSetup comment above). Applied
    // after the starting clock so seeded world state gets stamped with the real
    // genesis time, and before anything else persists.
    if (isGenesisSetup) applyGenesisSeeds(data);

    // --- Location Codex: the scene just moved somewhere else — persist what the
    // OLD place looked like at departure, keyed by normalized location name, so a
    // return visit (however many sessions later) can be re-grounded from storage
    // instead of the model's shrinking context. See WorldAgent's LOCATION CODEX
    // section; injectContextToChat() is where a remembered place gets re-injected.
    try {
        if (prevScene.initialized && patch && patch.location && Store.worldData && Store.WorldAgent &&
            prevScene.location && prevScene.location !== "Unknown" &&
            Store.WorldAgent.normalizeLocationKey(patch.location) !== Store.WorldAgent.normalizeLocationKey(prevScene.location)) {
            var departureDate = Store.TimelineEngine.parseDateTime(prevScene.time, prevScene.date);
            Store.worldData.locationCodex = Store.WorldAgent.upsertLocationCodex(Store.worldData.locationCodex, {
                name: prevScene.location,
                time: prevScene.time,
                date: prevScene.date,
                epoch: departureDate ? departureDate.getTime() : 0,
                characters: prevScene.characters,
                recentEvents: prevScene.recentEvents,
                weather: prevScene.weather,
                temperature: prevScene.temperature,
            }, 30);
            saveWorldData();
            console.log("[Story Tracker] Location Codex: snapshotted \"" + prevScene.location + "\" on departure.");
        }
    } catch (e) {
        console.warn("[Story Tracker] Location Codex snapshot failed:", e);
    }

    // --- Reveal resolution (the scene tick doubles as the "did a tracked secret
    // just surface?" check — see SceneAgent.buildScenePrompt's reveals section).
    // Guarded so a hallucinated/malformed revealed_secrets can never do worse
    // than a no-op: indices are validated by extractRevealedSecretIndices, then
    // bounds-checked against the snapshot, then matched BY STRING against the
    // live array (which may have changed while the LLM call was in flight).
    if (revealsSnapshot.length > 0 && typeof Store.SceneAgent.extractRevealedSecretIndices === "function") {
        var revealedIdx = Store.SceneAgent.extractRevealedSecretIndices(data)
            .filter(function(n) { return n <= revealsSnapshot.length; });
        if (revealedIdx.length > 0 && Store.worldData && Array.isArray(Store.worldData.pendingReveals)) {
            var revealedTexts = revealedIdx.map(function(n) { return revealsSnapshot[n - 1]; });
            var revealedSet = new Set(revealedTexts);
            var beforeCount = Store.worldData.pendingReveals.length;
            Store.worldData.pendingReveals = Store.worldData.pendingReveals.filter(function(r) {
                return !revealedSet.has(r);
            });
            var removed = beforeCount - Store.worldData.pendingReveals.length;
            if (removed > 0) {
                // Don't let the information vanish — a secret becoming known is itself a
                // development the world tier should keep reasoning from (consequences,
                // reactions, "the secret is out now" followups). Convert each into a
                // worldEvent stamped at the current clock, same shape/merge path the
                // world tiers themselves use.
                if (Store.WorldAgent && typeof Store.WorldAgent.mergeWorldEvents === "function") {
                    var nowKnownEvents = revealedTexts.map(function(t) {
                        return {
                            event: "Now known to the protagonists: " + t,
                            importance: 5,
                            time: Store.storyData.time,
                            date: Store.storyData.date,
                        };
                    });
                    Store.worldData.worldEvents = Store.WorldAgent.mergeWorldEvents(Store.worldData.worldEvents, nowKnownEvents, 15);
                }
                saveWorldData();
                console.log("[Story Tracker] Scene Agent resolved " + removed + " pending reveal(s) as now known: " + revealedTexts.join(" | "));
            }
        }
    }

    var timeAdvanceResult = Store.SceneAgent.applySceneTimeAdvance(data);
    var correctedTl = null;
    try {
        correctedTl = await applyTimeResolverOutcome(timeAdvanceResult, anchorState, scenePending.pendingForPrompt, "Scene Agent");
    } catch (e) {
        console.warn("[Story Tracker] Scene Agent time_advance application failed, keeping flat baseline:", e);
    }
    if (correctedTl) {
        // Forward-only clamp: the span answer is measured from the last scene
        // update's clock, which sits BEHIND the currently displayed clock (interim
        // baseline ticks). A small answer must not wind the visible clock backward.
        if (clockFloorEpoch != null && correctedTl.currentEpoch < clockFloorEpoch) {
            var floorDate = new Date(clockFloorEpoch);
            console.log("[Story Tracker] time_advance landed before the current clock (" + correctedTl.currentTime + ") — clamping forward-only to " + Store.TimelineEngine.formatTime(floorDate) + ".");
            correctedTl = Object.assign({}, correctedTl, {
                currentEpoch: clockFloorEpoch,
                currentTime: Store.TimelineEngine.formatTime(floorDate),
                currentDate: Store.TimelineEngine.formatDate(floorDate),
            });
        }
        Store.storyData.time = correctedTl.currentTime;
        Store.storyData.date = correctedTl.currentDate;
        Store.storyData._timeEpoch = correctedTl.currentEpoch;
    }

    // Fallback: if city or country is still unknown, run a targeted prompt to determine them
    var cityMissing    = !Store.storyData.city    || Store.storyData.city    === "Unknown";
    var countryMissing = !Store.storyData.country || Store.storyData.country === "Unknown";
    if (cityMissing || countryMissing) {
        try {
            var ccPrompt = Store.SceneAgent.buildCityCountryPrompt(Store.storyData.location || "Unknown");
            var ccRaw = await withConnectionProfile(async function() {
                try { return await Store.genRaw({ prompt: ccPrompt, quietToLoud: true }); }
                catch(e) { logGenRawFailure("city/country fallback", e); return await Store.genRaw(ccPrompt, null, false, true); }
            });
            var ccData = cleanAndParseJSON(ccRaw);
            // The check AFTER this block only stops the explicit save — but mutating
            // Store.storyData here already persists, because after a chat switch this
            // object IS the new chat's chat_metadata entry (ST saves it on its own
            // cadence). So the chat-identity check must gate the assign itself.
            if (Store.getCurrentChatId() === chatIdAtEntry) {
                var ccPatch = Store.SceneAgent.applyCityCountryResponse(ccData);
                if (ccPatch) Object.assign(Store.storyData, ccPatch);
            }
        } catch(e) {
            console.warn("[Story Tracker] City/country fallback failed:", e);
        }
    }

    // Second chat-identity check: the city/country fallback above was another await
    // the user could have switched chats during. Everything below persists state.
    if (Store.getCurrentChatId() !== chatIdAtEntry) {
        throw new Error("Story Tracker: chat changed during the city/country fallback — discarded the stale result.");
    }

    // Mark initialized and record a history entry (uses fields expected by renderModal)
    Store.storyData._initialized = true;
    if (data.recent_events) {
        if (!Store.storyData.history) Store.storyData.history = [];
        Store.storyData._historyCount = (Store.storyData._historyCount || 0) + 1;
        Store.storyData.history.unshift({
            msg:         Store.storyData._historyCount,
            time:        Store.storyData.time,
            // date was missing here for a long time, which silently disabled the
            // PAST HISTORY TIMELINE grounding in every world/faction prompt:
            // buildWorldTierContext calls parseRpDateTime(h.time, h.date), which
            // returns null without a date, so every entry failed the filter.
            date:        Store.storyData.date,
            loc:         Store.storyData.location,
            events:      data.recent_events,
            temperature: Store.storyData.temperature || "",
            weather:     Store.storyData.weather     || ""
        });
        // Cap history at 50 entries
        if (Store.storyData.history.length > 50) Store.storyData.history = Store.storyData.history.slice(0, 50);
    }

    // Save scene checkpoint
    if (liveChat.length > 0) {
        var lastSceneMsg = liveChat[liveChat.length - 1];
        Store.storyData._sceneCheckpointIdx = liveChat.length - 1;
        Store.storyData._sceneCheckpointAnchor = (lastSceneMsg && lastSceneMsg.mes)
            ? String(lastSceneMsg.mes).slice(0, 40) : "";
    }
    // Span time-anchor for the NEXT scene call: elapsed answers measure from the
    // clock as of THIS update's end. (handleMsg refreshes these again after
    // applying its own tlResult, so the auto path includes this message's
    // baseline/clamp too; this write covers the manual-update and genesis paths.)
    Store.storyData._sceneAnchorTime = Store.storyData.time;
    Store.storyData._sceneAnchorDate = Store.storyData.date;
    Store.storyData._sceneAnchorEpoch = Store.storyData._timeEpoch;
    saveStoryData();
    window.syncToCharTracker();
    if (Store.settings.enabled) injectContextToChat();

    return correctedTl;
}

/**
 * applyGenesisSeeds(data)
 *
 * Applies the world/relationship/digest sections of the Genesis Prime response
 * (see doLLMUpdate's isGenesisSetup). Each section is validated INDEPENDENTLY
 * inside its own try/catch: a malformed or missing section just leaves that
 * subsystem uninitialized — it then initializes lazily on its normal path
 * (first due world tick, first relationship interval), exactly the pre-genesis
 * behavior — and can never poison the scene update or the other seeds.
 *
 * Genesis INITIALIZES, it never ticks: no Scheduler accumulator, checkpoint,
 * or cadence counter is touched here, so every tier's first EVOLUTION still
 * happens a full interval away on its normal schedule.
 */
function applyGenesisSeeds(data) {
    if (!data) return;

    // --- World seed (summary / weather trend / initial NPC states / reveals) ---
    try {
        if (Store.settings.worldEnabled && Store.worldData && data.world_seed && typeof data.world_seed === "object" && !Array.isArray(data.world_seed)) {
            var seed = data.world_seed;
            var applied = false;
            if (typeof seed.summary === "string" && seed.summary.trim()) {
                Store.worldData.worldSummary = Store.WorldAgent.capWorldSnapshot(seed.summary.trim(), 500);
                applied = true;
            }
            if (typeof seed.weather_trend === "string" && seed.weather_trend.trim()) {
                var seedTrend = seed.weather_trend.trim();
                Store.worldData.weatherTrend = seedTrend.length > 400 ? seedTrend.slice(0, 400) : seedTrend;
                applied = true;
            }
            if (Array.isArray(seed.npc_states)) {
                // Same string-only validation posture as applyNpcTickResponse; goals are
                // allowed here (card-stated ones are high quality, and first-write-wins
                // in upsertNpcState protects them from later agent overwrites). No
                // routines/durations at genesis — too structured for a seed.
                var seedUpdates = seed.npc_states
                    .filter(function (u) { return u && typeof u.name === "string" && u.name.trim() && typeof u.change === "string" && u.change.trim(); })
                    .slice(0, 6)
                    .map(function (u) {
                        return {
                            name: u.name.trim(),
                            change: Store.WorldAgent.capEventText(u.change.trim(), 160),
                            goal: (typeof u.goal === "string" && u.goal.trim()) ? Store.WorldAgent.capNpcGoal(u.goal.trim()) : null,
                        };
                    });
                if (seedUpdates.length > 0) {
                    Store.worldData.npcStates = Store.WorldAgent.upsertManyNpcStates(Store.worldData.npcStates, seedUpdates);
                    applied = true;
                }
            }
            if (Array.isArray(seed.pending_reveals)) {
                var seedReveals = seed.pending_reveals
                    .filter(function (r) { return typeof r === "string" && r.trim(); })
                    .slice(0, 3);
                if (seedReveals.length > 0) {
                    Store.worldData.pendingReveals = Store.WorldAgent.capPendingReveals(Store.worldData.pendingReveals, seedReveals, 15);
                    applied = true;
                }
            }
            if (applied) {
                Store.worldData._initialized = true;
                Store.worldData.lastTickTime = Store.storyData.time;
                Store.worldData.lastTickDate = Store.storyData.date;
                console.log("[Story Tracker] Genesis world seed applied (summary/trend/NPCs/reveals as provided).");
            }
        }
    } catch (e) {
        console.warn("[Story Tracker] Genesis world seed failed — the World Agent will initialize on its first normal tick instead:", e);
    }

    // --- World Rules digest ---
    try {
        if (Store.settings.worldEnabled && Store.worldData && Array.isArray(data.lore_digest)) {
            var digest = Store.WorldAgent.sanitizeLoreDigest(data.lore_digest, 12);
            if (digest) {
                Store.worldData.loreDigest = digest;
                console.log("[Story Tracker] Genesis World Rules digest stored (" + digest.length + " rules) — world tiers will use it instead of raw card text.");
            }
        }
    } catch (e) {
        console.warn("[Story Tracker] Genesis lore digest failed — world tiers keep using raw card text:", e);
    }
    if (Store.worldData) saveWorldData();

    // --- Relationship seed (card-established canon only) ---
    try {
        if (Store.settings.relationsEnabled && Store.RelationshipAgent && data.relationship_seed && typeof data.relationship_seed === "object" && !Array.isArray(data.relationship_seed)) {
            loadRelationshipData();
            if (Store.relationshipData) {
                // Reuses the standard validator (type/strength clamping, summary caps);
                // the merge itself is deliberately simpler than doRelationshipUpdate's —
                // at genesis the graph is empty, so there's no evolution/history/
                // asymmetry-reconciliation to do, just canonical-name-resolved inserts.
                var validated = Store.RelationshipAgent.applyRelationshipResponse(data.relationship_seed);
                var addedEdges = 0;
                validated.relationships.forEach(function (rel) {
                    if (!rel || !rel.from || !rel.to) return;
                    var from = resolveCanonicalName(String(rel.from).trim());
                    var to = resolveCanonicalName(String(rel.to).trim());
                    if (!from || !to || from === to) return;
                    if (Store.RelationshipAgent.findEdgeIndex(Store.relationshipData.edges, from, to) !== -1) return;
                    [from, to].forEach(function (nm) {
                        if (!Store.relationshipData.nodes.find(function (n) { return n.name === nm; })) {
                            Store.relationshipData.nodes.push({ id: nm, name: nm });
                        }
                    });
                    Store.relationshipData.edges.push({
                        from: from,
                        to: to,
                        type: rel.type,
                        strength: rel.strength,
                        summary: rel.summary || "",
                        change: "Established at story start",
                        history: [],
                    });
                    addedEdges++;
                });
                var seedBios = validated.characterBios || [];
                seedBios.forEach(function (b) {
                    var canonical = resolveCanonicalName(String(b.name).trim());
                    if (!canonical) return;
                    var node = Store.relationshipData.nodes.find(function (n) { return n.name === canonical; });
                    if (!node) {
                        node = { id: canonical, name: canonical };
                        Store.relationshipData.nodes.push(node);
                    }
                    if (!node.bio) node.bio = b.bio; // first-write-wins, same as the tracker
                });
                if (addedEdges > 0 || seedBios.length > 0) {
                    Store.relationshipData._initialized = true;
                    saveRelationshipData();
                    console.log("[Story Tracker] Genesis relationship seed applied: " + addedEdges + " edge(s), " + seedBios.length + " bio(s).");
                }
            }
        }
    } catch (e) {
        console.warn("[Story Tracker] Genesis relationship seed failed — the Relationship Tracker will initialize on its first normal analysis instead:", e);
    }
}

export async function doManualUpdate() {
    if (!Store.settings.enabled) {
        if (typeof toastr !== "undefined") toastr.warning("Story Tracker is disabled. Enable it in the extension settings.");
        return;
    }
    if (Store.busy) return;
    
    // Failsafe: abort manual update if no active chat open
    if (!Store.isChatOpen()) {
        console.warn("[Story Tracker] Aborted manual update: No active chat open.");
        if (typeof toastr !== "undefined") {
            toastr.warning("Story Tracker: Manual update aborted. No active chat is open.");
        }
        return;
    }

    Store.setBusy(true);
    var $b = $("#st-f-update").prop("disabled", true).html('<i class="fa-solid fa-spinner fa-spin"></i> Analyzing...');
    HUD.setHudStatus("Scene...");
    if (typeof toastr !== "undefined") toastr.info("Story Tracker: Analyzing scene...", "", { timeOut: 0, extendedTimeOut: 0 });
    try {
        await runTrackerProfileSession(function() { return doLLMUpdate(); });
        // Reset BOTH scene cadences so the next auto-fire is a full interval away from
        // this manual run, not immediately due again: the Scheduler accumulator covers
        // Smart Time mode, and _timeModeMsgCounter covers (the default) Message Mode —
        // previously only the former was reset, so in Message Mode an auto update could
        // still fire on the very next message after a manual one.
        if (Store.storyData) Store.storyData._timeModeMsgCounter = 0;
        if (Store.worldData && Store.worldData._schedulerAccumulated) {
            Store.worldData._schedulerAccumulated.scene = 0;
            saveWorldData();
        }
        saveStoryData();
        
        window.renderModal(); HUD.renderHUD();
        HUD.clearHudStatus();
        if(typeof toastr !== "undefined") { toastr.clear(); toastr.success("Story updated!"); }
    } catch(e) { HUD.clearHudStatus(); if (typeof toastr !== "undefined") { toastr.clear(); toastr.error(e.message); } }
    Store.setBusy(false);
    $b.prop("disabled", false).html('<i class="fa-solid fa-pen"></i> Update now');
}

// --- World Simulation Engine ---

// --- Extract NPCs recently interacted with from chat history ---
function extractRecentNPCsFromChat(chatMessages, numMessages) {
    var n = numMessages || 15;
    var recent = (chatMessages || []).slice(-n);
    var userName = (Store.scriptModule && Store.scriptModule.name1) ? Store.scriptModule.name1.toLowerCase() : "user";
    var seen = new Set();
    var npcs = [];
    recent.forEach(function(msg) {
        if (!msg.is_user && msg.name) {
            var lower = msg.name.toLowerCase();
            // Exclude the user's own name in case it appears as a sender
            if (lower !== userName && !seen.has(lower)) {
                seen.add(lower);
                npcs.push(msg.name);
            }
        }
    });
    return npcs;
}

// --- World Agent: shared chat/context builder used by all 4 tiers ---
// Ported unchanged from the pre-rewrite context-gathering logic (checkpointed chat slice,
// history timeline, NPC formatting) — none of this was time-determination logic, so it
// didn't need to change. What changed is WHERE the prompt/response logic lives (WorldAgent.js)
// and how time is supplied (fixed, from TimelineEngine/Scheduler — never asked of the LLM).
// Pulls established background from the actual character card(s) in this chat —
// description/personality/scenario — so the tracker agents have real ground truth
// to check invented lore against, instead of only ever seeing rolling chat text.
// Cheap to call every time (plain object reads, no LLM call) so no caching needed;
// it also naturally picks up card edits made mid-chat.
// NOTE: intentionally NOT truncated — full description/personality/scenario are
// passed through as-is. For very long cards (or several members in a group chat)
// this does add meaningfully to prompt size/cost on every npc/faction/world tick;
// if that becomes a problem, reintroducing a per-field cap is the easy fix.
function getCharacterLoreText() {
    try {
        var context = (typeof SillyTavern !== "undefined" && typeof SillyTavern.getContext === "function") ? SillyTavern.getContext() : null;
        if (!context) return "";
        var allChars = context.characters || [];
        var cards = [];

        if (context.groupId != null && Array.isArray(context.groups)) {
            var group = context.groups.find(function(g) { return g.id === context.groupId; });
            var memberFiles = (group && group.members) || [];
            memberFiles.forEach(function(fname) {
                var c = allChars.find(function(ch) { return ch.avatar === fname; });
                if (c) cards.push(c);
            });
        } else if (context.characterId != null && allChars[context.characterId]) {
            cards.push(allChars[context.characterId]);
        }

        if (cards.length === 0) return "";
        // Card text is written for the MAIN model, where ST substitutes {{user}}/
        // {{char}} at prompt time — the tracker prompts bypass that substitution,
        // so without this every consumer of card lore (npc/faction/world tiers,
        // the genesis seeds, the World Rules digest) read a literal "{{user}}"
        // and couldn't connect the player to anything the lore says about them.
        // Done per-card so {{char}} resolves to THAT card's name in group chats
        // (a global substituteParams would use the active character for all).
        var playerName = (Store.scriptModule && Store.scriptModule.name1) ? String(Store.scriptModule.name1) : null;
        function substituteCardMacros(text, charName) {
            // Replacement CALLBACKS, not replacement strings — a name containing
            // `$&`/`$'` would otherwise be expanded by String.replace's special
            // patterns instead of inserted literally.
            var out = String(text);
            if (playerName) {
                out = out.replace(/\{\{user\}\}/gi, function () { return playerName; })
                         .replace(/<USER>/gi, function () { return playerName; });
            }
            if (charName) {
                out = out.replace(/\{\{char\}\}/gi, function () { return charName; })
                         .replace(/<BOT>/gi, function () { return charName; });
            }
            return out;
        }
        return cards.map(function(c) {
            var cardName = c.name || "Character";
            var lines = [];
            if (c.description) lines.push("Description: " + substituteCardMacros(String(c.description).trim(), cardName));
            if (c.personality) lines.push("Personality: " + substituteCardMacros(String(c.personality).trim(), cardName));
            if (c.scenario) lines.push("Scenario: " + substituteCardMacros(String(c.scenario).trim(), cardName));
            if (lines.length === 0) return null;
            return "=== " + cardName + " ===\n" + lines.join("\n");
        }).filter(Boolean).join("\n\n");
    } catch (e) {
        console.warn("[Story Tracker] getCharacterLoreText failed:", e);
        return "";
    }
}

// =============================================================================
// PER-CHAT WORLD LOREBOOKS — two DISTINCT roles, chosen from the World tab and
// stored in this chat's worldData (chat_metadata), so different cards/chats can
// point at different books:
//
//   SEED  (worldData.seedLorebooks[]): the WHOLE of each selected book is
//     distilled into the World Rules ONCE — at genesis and when the manual
//     regenerate wand runs (see getCharacterLoreText's two callers). Never sent
//     per tick: the whole point of the digest is that raw lore is distilled once
//     and the tiers then run on the compact result (WorldAgent's WORLD RULES
//     DIGEST header).
//
//   LIVE  (worldData.contextEntries[]): ONLY these specifically-picked entries
//     are injected into every World Agent tier run, re-read FRESH each run so
//     dynamic "memory-book" entries reflect their current content. The whole
//     book is never injected per-run — that distinction is the entire point:
//     seeding is bulk-once, live context is a curated few-every-time.
//
// All async because loadWorldInfo() fetches (then ST-caches, so repeat reads
// across a run are cheap). Every function returns "" rather than throwing.
// =============================================================================

function _stContext() {
    return (typeof SillyTavern !== "undefined" && typeof SillyTavern.getContext === "function") ? SillyTavern.getContext() : null;
}

// Loads one WI book → { entries: [raw entry objects], subst: macro-substituter }.
// Returns null if unavailable. Caller filters/sorts. loadWorldInfo is ST-cached.
async function _loadBook(name) {
    var context = _stContext();
    if (!name || !context || typeof context.loadWorldInfo !== "function") return null;
    try {
        var book = await context.loadWorldInfo(String(name));
        var entries = (book && book.entries && typeof book.entries === "object")
            ? Object.keys(book.entries).map(function (k) { return book.entries[k]; })
            : [];
        // Card lore runs {{user}}/{{char}} substitution (see getCharacterLoreText);
        // do the same for lorebook text so prompts never carry a literal "{{user}}".
        var subst = (typeof context.substituteParams === "function") ? context.substituteParams : function (t) { return t; };
        return { entries: entries, subst: subst };
    } catch (e) {
        console.warn("[Story Tracker] failed to load lorebook \"" + name + "\":", e);
        return null;
    }
}

function _sortWiEntries(list) {
    return list.slice().sort(function (a, b) {
        var ao = (typeof a.order === "number") ? a.order : 100;
        var bo = (typeof b.order === "number") ? b.order : 100;
        if (ao !== bo) return ao - bo;
        return (a.uid || 0) - (b.uid || 0);
    });
}

function _entryTitle(e, subst, i) {
    var titleRaw = (e.comment && String(e.comment).trim())
        || (Array.isArray(e.key) && e.key.length ? e.key.filter(Boolean).join(", ") : "");
    return titleRaw ? String(subst(titleRaw)).trim() : ("Entry " + (i + 1));
}

// SEED: the whole of every selected book, distilled into the World Rules (genesis
// + wand). Generous-but-bounded cap since it's a one-time payload, not per-tick.
async function getSeedLorebookText() {
    var books = (Store.worldData && Array.isArray(Store.worldData.seedLorebooks)) ? Store.worldData.seedLorebooks : [];
    if (books.length === 0) return "";
    var MAX_SEED_CHARS = 8000;
    var out = [];
    var total = 0;
    var truncated = false;
    for (var b = 0; b < books.length && !truncated; b++) {
        var name = books[b];
        var loaded = await _loadBook(name);
        if (!loaded) continue;
        // Only enabled entries with real content (a disabled entry is one the user
        // switched off in the WI editor — respect that).
        var usable = _sortWiEntries(loaded.entries.filter(function (e) { return e && !e.disable && e.content && String(e.content).trim(); }));
        if (usable.length === 0) continue;
        var parts = [];
        for (var i = 0; i < usable.length; i++) {
            var e = usable[i];
            var block = "### " + _entryTitle(e, loaded.subst, i) + "\n" + String(loaded.subst(String(e.content))).trim();
            if (total + block.length > MAX_SEED_CHARS) { truncated = true; break; }
            parts.push(block);
            total += block.length + 2;
        }
        if (parts.length > 0) out.push("=== World Lorebook: " + name + " ===\n" + parts.join("\n\n"));
    }
    if (truncated) out.push("[...additional lorebook entries omitted to keep the world seed concise...]");
    return out.join("\n\n");
}

// LIVE: ONLY the specifically-picked entries, read fresh each run. Tighter cap
// than SEED because this rides EVERY World Agent tier call, not a one-off.
async function getLiveContextEntriesText() {
    var picks = (Store.worldData && Array.isArray(Store.worldData.contextEntries)) ? Store.worldData.contextEntries : [];
    if (picks.length === 0) return "";
    // Group by book so each book loads once, preserving the user's pick order.
    var order = [];
    var byBook = {};
    picks.forEach(function (p) {
        if (!p || !p.book || p.uid == null) return;
        var key = String(p.book);
        if (!byBook[key]) { byBook[key] = []; order.push(key); }
        byBook[key].push(p);
    });
    var MAX_LIVE_CHARS = 4000;
    var out = [];
    var total = 0;
    var truncated = false;
    for (var b = 0; b < order.length && !truncated; b++) {
        var name = order[b];
        var loaded = await _loadBook(name);
        if (!loaded) continue;
        var byUid = {};
        loaded.entries.forEach(function (e) { if (e && e.uid != null) byUid[String(e.uid)] = e; });
        var lines = [];
        var group = byBook[name];
        for (var i = 0; i < group.length; i++) {
            var e = byUid[String(group[i].uid)];
            // Entry deleted or switched off since it was picked — skip silently.
            if (!e || e.disable || !e.content || !String(e.content).trim()) continue;
            var block = "### " + _entryTitle(e, loaded.subst, i) + "\n" + String(loaded.subst(String(e.content))).trim();
            if (total + block.length > MAX_LIVE_CHARS) { truncated = true; break; }
            lines.push(block);
            total += block.length + 2;
        }
        if (lines.length > 0) out.push("=== " + name + " ===\n" + lines.join("\n\n"));
    }
    if (out.length === 0) return "";
    var body = out.join("\n\n");
    if (truncated) body += "\n\n[...additional selected entries omitted to stay within the live-context budget...]";
    return body;
}

// buildWorldTierContext() is synchronous but the live text needs an async fetch,
// so it's resolved once per World Agent run into this chat-keyed cache and read
// back synchronously while the tiers build their prompts. Refreshed (not just
// read) each run so dynamic entries are always current; the chatId guard stops a
// value resolved for one chat from leaking into another after a mid-flight switch.
var _liveContextCache = { chatId: null, text: "" };
async function refreshLiveContextCache() {
    var chatId = Store.getCurrentChatId();
    var text = "";
    try { text = await getLiveContextEntriesText(); } catch (e) { text = ""; }
    if (Store.getCurrentChatId() === chatId) _liveContextCache = { chatId: chatId, text: text || "" };
    return _liveContextCache.text;
}
function getCachedLiveContextText() {
    return (_liveContextCache && _liveContextCache.chatId === Store.getCurrentChatId()) ? (_liveContextCache.text || "") : "";
}
// Appends the live-context block (if any) to a tier's lore text. Kept distinct
// from the distilled World Rules so the model treats it as current, possibly-
// changing reference rather than baked-in ground truth.
function appendLiveContextToLore(baseLoreText) {
    var live = getCachedLiveContextText();
    if (!live) return baseLoreText;
    var block = "CURRENT LOREBOOK ENTRIES (hand-picked by the user for live reference — established, up-to-date facts that may change over time; prefer these over any older detail):\n" + live;
    return baseLoreText ? (baseLoreText + "\n\n" + block) : block;
}

function buildWorldTierContext() {
    var originalChat = (Store.scriptModule && Store.scriptModule.chat) ? Store.scriptModule.chat : [];
    var worldLastCheckpoint = -1;
    if (Store.worldData._worldCheckpointIdx != null) {
        var wcpIdx = Store.worldData._worldCheckpointIdx;
        var wcpAnchor = Store.worldData._worldCheckpointAnchor || "";
        var wcpMsg = originalChat[wcpIdx];
        var wcpText = (wcpMsg && wcpMsg.mes) ? String(wcpMsg.mes).slice(0, 40) : "";
        if (wcpAnchor && wcpText === wcpAnchor) {
            worldLastCheckpoint = wcpIdx;
        } else {
            console.warn("[Story Tracker] World checkpoint anchor mismatch - falling back to last 15 messages.");
        }
    }
    var worldMsgs = worldLastCheckpoint >= 0
        ? originalChat.slice(worldLastCheckpoint + 1)
        : originalChat.slice(-15);
    if (worldMsgs.length < 3) worldMsgs = originalChat.slice(-3);
    var chatHistoryText = "";
    worldMsgs.forEach(function(msg) {
        var senderName = msg.is_user ? (Store.scriptModule && Store.scriptModule.name1 ? Store.scriptModule.name1 : "{{user}}") : (msg.name || "Char");
        var msgText = (msg.mes || "").trim();
        chatHistoryText += senderName + ": " + msgText + "\n";
    });
    if (!chatHistoryText.trim()) chatHistoryText = "No recent messages.";

    var curDateObj = parseRpDateTime(Store.storyData.time, Store.storyData.date);
    var historyTimelineText = "";
    if (Store.storyData && Store.storyData.history && Store.storyData.history.length > 0) {
        // history is stored NEWEST-first. Walk it in that order collecting up to
        // the cap, THEN reverse the collected lines for chronological output —
        // reversing the whole array before capping (the old order of operations)
        // selected the OLDEST 12 entries once more than 12 existed, handing the
        // world prompts ancient history and omitting exactly the recent entries
        // they most need.
        var HISTORY_INJECT_CAP = 12;
        var timelineLines = [];
        for (var hi = 0; hi < Store.storyData.history.length && timelineLines.length < HISTORY_INJECT_CAP; hi++) {
            var h = Store.storyData.history[hi];
            if (!h) continue;
            // Entries saved before history carried a `date` field can't be
            // compared against the current clock — include them anyway (they were
            // all genuinely recorded in the past) rather than silently dropping
            // them, which used to leave this whole timeline permanently empty.
            if (!h.date) {
                timelineLines.push(`- Time: ${h.time} (Event: ${h.events})\n`);
                continue;
            }
            var entryDateObj = parseRpDateTime(h.time, h.date);
            if (entryDateObj && curDateObj && entryDateObj.getTime() <= curDateObj.getTime()) {
                timelineLines.push(`- Time: ${h.time} | Date: ${h.date} (Event: ${h.events})\n`);
            }
        }
        historyTimelineText = timelineLines.length > 0
            ? timelineLines.reverse().join("")
            : "No past history recorded before this tick.";
    } else {
        historyTimelineText = "No past history recorded yet.";
    }

    var onscreenNames = new Set((Store.storyData && Store.storyData.characters || []).map(function(c) { return c.name; }));
    var onscreenNpcsText = onscreenNames.size > 0
        ? Array.from(onscreenNames).map(function(n) { return "- " + n; }).join("\n")
        : "None identified.";

    var recentNPCs = extractRecentNPCsFromChat(originalChat, 15).filter(function(n) { return !onscreenNames.has(n); });
    var interactedNPCsText = recentNPCs.length > 0
        ? recentNPCs.map(function(n) { return "- " + n; }).join("\n")
        : "None identified — generate general world updates.";

    // currentTime lets the formatter annotate each routine-carrying NPC with what
    // their schedule says they're doing RIGHT NOW — see WorldAgent.getRoutineActivityAt.
    var npcStatesText = Store.WorldAgent.formatNpcStatesForPrompt(
        Store.worldData.npcStates, extractRecentNPCsFromChat(originalChat, 30), 20,
        Store.storyData ? Store.storyData.time : null
    );

    // Tracked NPCs whose name shows up in the recent chat text (mentioned in
    // dialogue/narration) but who are neither onscreen nor already counted as
    // "recently interacted" (didn't speak themselves) — these are candidates
    // for a brief, logical, time-of-day-consistent inferred state rather than
    // being skipped entirely just because nobody spoke to them this tick.
    var interactedSet = new Set(recentNPCs);
    var mentionedNPCs = (Store.worldData.npcStates || [])
        .map(function(n) { return n && n.name; })
        .filter(function(name) {
            return name && !onscreenNames.has(name) && !interactedSet.has(name) &&
                Store.RelationshipAgent.nameMentionedInText(name, chatHistoryText);
        });
    var mentionedNpcsText = mentionedNPCs.length > 0
        ? mentionedNPCs.map(function(n) { return "- " + n; }).join("\n")
        : "None.";

    // Candidates for a fresh NPC "goal" this tick — onscreen + recently-interacted names,
    // same population the tier already treats as "worth a real update" (mentioned-only NPCs
    // are deliberately excluded — not enough evidence to ground a goal, same reasoning rule
    // 8 already applies to their 'change' text). The PLAYER is filtered out: they sit in
    // onscreenNames via storyData.characters, but a goal/daily routine is NPC bookkeeping —
    // the player's day is whatever the player does, and offering their name here invited
    // the model to schedule the protagonist's life for them.
    var playerNameLower = (Store.scriptModule && Store.scriptModule.name1) ? String(Store.scriptModule.name1).toLowerCase() : null;
    // TRACKED npcStates names lead the candidate list — they're the NPCs the tier
    // actually writes updates for every tick (genesis-seeded offscreen NPCs
    // included). Previously candidates were only onscreen + recent chat speakers,
    // which locked seeded offscreen NPCs out of goal/routine slots entirely: in a
    // solo scenario-card chat the "speaker" is the card itself, and onscreen
    // characters are discouraged from offscreen updates — so effectively NOBODY
    // eligible remained and the tier could never propose a routine. Order
    // matters: the formatters cap the offered list at 8, so best targets first.
    var seenCandidate = {};
    var goalRoutineCandidates = (Store.worldData.npcStates || [])
        .map(function(n) { return n && n.name; })
        .concat(Array.from(onscreenNames))
        .concat(recentNPCs)
        .filter(function(n) {
            if (!n || (playerNameLower && String(n).toLowerCase() === playerNameLower)) return false;
            var key = String(n).toLowerCase();
            if (seenCandidate[key]) return false;
            seenCandidate[key] = true;
            return true;
        });
    var npcsNeedingGoalText = (Store.WorldAgent && Store.worldData)
        ? Store.WorldAgent.formatNpcsNeedingGoalForPrompt(Store.worldData.npcStates, goalRoutineCandidates, 8)
        : null;

    // Same population and same allow-list pattern for daily routines — see
    // WorldAgent.formatNpcsNeedingRoutineForPrompt / sanitizeRoutine.
    var npcsNeedingRoutineText = (Store.WorldAgent && Store.worldData)
        ? Store.WorldAgent.formatNpcsNeedingRoutineForPrompt(Store.worldData.npcStates, goalRoutineCandidates, 8)
        : null;

    var season = (Store.TimelineEngine && Store.settings.seasonHemisphere && Store.settings.seasonHemisphere !== "none" && Store.storyData)
        ? Store.TimelineEngine.formatSeasonForPrompt(Store.storyData.date, Store.settings.seasonHemisphere)
        : null;

    // Cross-tier grounding from the RELATIONSHIP system: how the people currently
    // in play feel about each other, as already-established facts (see
    // RelationshipAgent.formatRelationshipsForWorldPrompt). Fed to the npc and
    // faction tiers so offscreen behavior stays emotionally consistent with the
    // tracked story — a rival doesn't run friendly errands. Gated on the
    // relationship tracker being enabled AND initialized, so a disabled/stale
    // graph never grounds anything; null just means the tiers omit the block,
    // same as every other optional context input here.
    var relationshipsText = null;
    if (Store.settings.relationsEnabled && Store.relationshipData && Store.relationshipData._initialized &&
        Store.RelationshipAgent && typeof Store.RelationshipAgent.formatRelationshipsForWorldPrompt === "function") {
        var relRelevantNames = Array.from(onscreenNames)
            .concat(recentNPCs)
            .concat((Store.worldData.npcStates || []).map(function(n) { return n && n.name; }).filter(Boolean));
        relationshipsText = Store.RelationshipAgent.formatRelationshipsForWorldPrompt(
            Store.relationshipData.edges, relRelevantNames, 8);
    }

    return {
        originalChat: originalChat,
        chatHistoryText: chatHistoryText,
        historyTimelineText: historyTimelineText,
        onscreenNpcsText: onscreenNpcsText,
        onscreenNamesArr: Array.from(onscreenNames),
        interactedNPCsText: interactedNPCsText,
        mentionedNpcsText: mentionedNpcsText,
        npcStatesText: npcStatesText,
        npcsNeedingGoalText: npcsNeedingGoalText,
        npcsNeedingRoutineText: npcsNeedingRoutineText,
        relationshipsText: relationshipsText,
        season: season,
        // Once a genesis World Rules digest exists, it REPLACES the raw card text
        // in every tier prompt — same ground truth, a fraction of the tokens, and
        // user-verifiable/editable from the World tab. Raw cards are only sent
        // when no digest exists (pre-digest chats, world agent enabled after
        // genesis, digest section failed) — i.e. the previous behavior, unchanged.
        // ...then the user's hand-picked live lorebook entries (if any) are appended,
        // re-read fresh each run via the cache refreshed at the dispatch sites below —
        // this is the ONLY place the per-entry live selection reaches the tiers.
        characterLoreText: appendLiveContextToLore(
            (Store.WorldAgent && Store.worldData && Store.WorldAgent.formatLoreDigestForPrompt(Store.worldData.loreDigest))
            || getCharacterLoreText()
        ),
        currentLoc: (Store.storyData && Store.storyData.location) ? Store.storyData.location : "Unknown",
        recentEv: (Store.storyData && Store.storyData.recent_events) ? Store.storyData.recent_events : "None.",
    };
}

function saveWorldCheckpoint(originalChat) {
    if (originalChat.length > 0) {
        var lastWorldMsg = originalChat[originalChat.length - 1];
        Store.worldData._worldCheckpointIdx = originalChat.length - 1;
        Store.worldData._worldCheckpointAnchor = (lastWorldMsg && lastWorldMsg.mes)
            ? String(lastWorldMsg.mes).slice(0, 40) : "";
    }
}

async function callWorldAgentPrompt(prompt) {
    return await withWorldConnectionProfile(async function () {
        try {
            return await Store.genRaw({ prompt: prompt, quietToLoud: true });
        } catch (e) {
            logGenRawFailure("world agent", e);
            return await Store.genRaw(prompt, null, false, true);
        }
    });
}

// canonicalizeNpcName(npcStates, name)
// Resolves a model-returned NPC name against the already-tracked npcStates the
// same way relationship nodes are deduped (RelationshipAgent.namesLikelyMatch —
// title-stripping + conservative token overlap, Unicode-aware). Returns the
// EXISTING tracked entry's name on a match (stability wins over verbosity here:
// the entry's goal/routine/opt-out flags live under that name), or the input
// unchanged when nothing matches.
function canonicalizeNpcName(npcStates, name) {
    if (!name || !Store.RelationshipAgent) return name;
    var norm = Store.RelationshipAgent.normalizeNameKey(name);
    if (!norm) return name;
    for (var i = 0; i < (npcStates || []).length; i++) {
        var existing = npcStates[i];
        if (!existing || !existing.name) continue;
        if (existing.name === name) return name; // exact match — nothing to resolve
        if (Store.RelationshipAgent.namesLikelyMatch(norm, Store.RelationshipAgent.normalizeNameKey(existing.name))) {
            return existing.name;
        }
    }
    return name;
}

// --- NPC tier ---
// sharedCtx: optional pre-built buildWorldTierContext() result. All 4 tiers read the
// SAME "last processed message" checkpoint (see saveWorldCheckpoint below) — when several
// tiers run as one batch (runDueWorldTiers / runManualWorldTick), the batch orchestrator
// builds this ONCE and hands it to every tier, and saves the checkpoint ONCE after the
// whole batch finishes. That's what keeps every tier in a batch looking at the same
// "since last checkpoint" chat window, instead of a tier that runs later in the batch
// seeing a shrunk window because an earlier tier already advanced the checkpoint out from
// under it. Falls back to building its own (and the caller must save its own checkpoint —
// see regenerateWorldSection) when called standalone with no sharedCtx.
async function runNpcTier(isBatch, elapsedMinutes, sharedCtx) {
    var tierChatId = Store.getCurrentChatId();
    var ctx = sharedCtx || buildWorldTierContext();
    // Cross-tier grounding: already-generated, already-stored faction/plot events, shown
    // as established background awareness only — see WorldAgent's CROSS-TIER GROUNDING
    // section for why this is safe (nothing here is freshly synthesized for the purpose).
    var recentWorldEventsText = Store.WorldAgent.formatWorldEventsForPrompt(Store.worldData.worldEvents, 5);
    var prompt = Store.WorldAgent.buildNpcTickPrompt({
        currentTime: Store.storyData.time, currentDate: Store.storyData.date, isBatch: isBatch,
        onscreenNpcsText: ctx.onscreenNpcsText, interactedNpcsText: ctx.interactedNPCsText,
        mentionedNpcsText: ctx.mentionedNpcsText, npcStatesText: ctx.npcStatesText,
        characterLoreText: ctx.characterLoreText, recentChatText: ctx.chatHistoryText,
        pendingEventsText: buildPendingEventsPromptText().pendingEventsText,
        recentWorldEventsText: recentWorldEventsText,
        npcsNeedingGoalText: ctx.npcsNeedingGoalText,
        npcsNeedingRoutineText: ctx.npcsNeedingRoutineText,
        relationshipsText: ctx.relationshipsText,
        elapsedMinutesSinceLastTick: elapsedMinutes,
    });
    var data = cleanAndParseJSON(await callWorldAgentPrompt(prompt));
    // Chat switched mid-call: everything below writes into Store.worldData, which now
    // belongs to the newly opened chat — discard rather than contaminate it.
    if (Store.getCurrentChatId() !== tierChatId) throw new Error("chat changed during the npc tier's LLM call — discarded its stale result");
    // A null parse is a FAILED call (garbage/truncated response), not a valid empty
    // update — throwing lets the caller's rollback machinery retry next message.
    // (A parseable {"npc_updates":[]} is still a legitimate "nothing happened".)
    if (!data) throw new Error("failed to parse the npc tier's LLM response");
    // allowedGoalNames / allowedRoutineNames: the exact allow-lists offered in the prompt
    // above — hard-enforced here too, not just by prompt wording (see applyNpcTickResponse).
    var allowedGoalNames = ctx.npcsNeedingGoalText ? ctx.npcsNeedingGoalText.split(",").map(function(s) { return s.trim(); }) : null;
    var allowedRoutineNames = ctx.npcsNeedingRoutineText ? ctx.npcsNeedingRoutineText.split(",").map(function(s) { return s.trim(); }) : null;
    var patch = Store.WorldAgent.applyNpcTickResponse(data, allowedGoalNames, allowedRoutineNames);
    // Canonicalize names BEFORE the upsert: upsertNpcState matches by exact name,
    // so without this, the model drifting between phrasings of the same person
    // ("Captain Reyes" / "Reyes" / "Capt. Reyes") over a long RP splits them into
    // separate tracked NPCs with divergent states, goals, and routines. Reuses the
    // same conservative matcher that already dedupes relationship nodes; the
    // EXISTING entry's name always wins so goals/routines/opt-outs stay attached.
    patch.npc_updates.forEach(function(u) {
        u.name = canonicalizeNpcName(Store.worldData.npcStates, u.name);
    });
    Store.worldData.npcStates = Store.WorldAgent.upsertManyNpcStates(Store.worldData.npcStates, patch.npc_updates);
    // Bound the underlying array — see pruneNpcStates' doc comment. Always keeps anyone
    // the player has recently interacted with; only prunes stale one-off background NPCs.
    Store.worldData.npcStates = Store.WorldAgent.pruneNpcStates(Store.worldData.npcStates, extractRecentNPCsFromChat(ctx.originalChat, 30), 40);

    // --- EventQueue: schedule any delayed NPC actions flagged with duration_minutes (a
    // journey, a stakeout, waiting on a reply) the same way the faction tier does. Their
    // outcome ('resolution') resolves deterministically once enough RP-time passes and is
    // folded into worldEvents by the message handler's EventQueue.processTime() call.
    // Instant NPC updates (no duration_minutes) are untouched — already recorded above.
    if (Store.EventQueue && patch.npc_updates && patch.npc_updates.length > 0) {
        // Unlike the faction tier (which tags each event with an interval_index mapped to
        // an exact precomputed timestamp), the NPC tier has no per-event timing within a
        // batched catch-up gap. Anchoring a scheduled action to storyData.time/date (the
        // END of the gap) would mean an NPC action the model describes as already under
        // way ("still traveling") gets timestamped as starting NOW, pushing its resolution
        // further into the future than intended. Anchoring to the START of the covered gap
        // instead is a closer approximation — still not exact, but consistent with the
        // "this action has been happening across the gap" framing the batch prompt asks for.
        var eqStartTime = Store.storyData.time, eqStartDate = Store.storyData.date;
        if (isBatch && elapsedMinutes > 0 && Store.TimelineEngine) {
            var tickEndDate = Store.TimelineEngine.parseDateTime(Store.storyData.time, Store.storyData.date);
            if (tickEndDate) {
                var gapStartDate = Store.TimelineEngine.addMinutesToDate(tickEndDate, -elapsedMinutes);
                eqStartTime = Store.TimelineEngine.formatTime(gapStartDate);
                eqStartDate = Store.TimelineEngine.formatDate(gapStartDate);
            }
        }

        var nextQueue = Store.worldData._eventQueue || [];
        patch.npc_updates.forEach(function(u) {
            if (!u.durationMinutes || u.durationMinutes <= 0) return;
            // Supersede any earlier still-pending scheduled action for this SAME NPC —
            // without this, an NPC flagged with duration_minutes on consecutive ticks
            // (e.g. "still traveling") could stack multiple overlapping pending events
            // instead of the freshest one replacing the last.
            nextQueue = Store.EventQueue.cancelPendingMatching(nextQueue, function(e) {
                return e.meta && e.meta.origin === "npc" && e.meta.npcName === u.name;
            });
            try {
                nextQueue = Store.EventQueue.enqueue(nextQueue, {
                    actor: null,
                    action: u.resolution || (u.name + ": " + u.change),
                    startTime: eqStartTime,
                    startDate: eqStartDate,
                    durationMinutes: u.durationMinutes,
                    meta: { origin: "npc", npcName: u.name, originChange: u.change },
                });
            } catch (err) {
                console.warn("[Story Tracker] Failed to schedule NPC action into EventQueue:", err);
            }
        });
        Store.worldData._eventQueue = nextQueue;
    }

    Store.worldData._initialized = true;
    if (!sharedCtx) saveWorldCheckpoint(ctx.originalChat);
    saveWorldData();
}

// --- Weather tier ---
async function runWeatherTier(isBatch, elapsedMinutes, sharedCtx) {
    var tierChatId = Store.getCurrentChatId();
    var ctx = sharedCtx || buildWorldTierContext();
    var prompt = Store.WorldAgent.buildWeatherTickPrompt({
        currentTime: Store.storyData.time, currentDate: Store.storyData.date, isBatch: isBatch,
        currentLocation: ctx.currentLoc, previousWeatherTrend: Store.worldData.weatherTrend, recentChatText: ctx.chatHistoryText,
        season: ctx.season,
        elapsedMinutesSinceLastTick: elapsedMinutes,
    });
    var data = cleanAndParseJSON(await callWorldAgentPrompt(prompt));
    if (Store.getCurrentChatId() !== tierChatId) throw new Error("chat changed during the weather tier's LLM call — discarded its stale result");
    if (!data) throw new Error("failed to parse the weather tier's LLM response"); // null parse = failed call, not a valid empty tick — throw so it retries
    var patch = Store.WorldAgent.applyWeatherTickResponse(data);
    if (patch) Store.worldData.weatherTrend = patch.weatherTrend;
    Store.worldData._initialized = true;
    if (!sharedCtx) saveWorldCheckpoint(ctx.originalChat);
    saveWorldData();
}

// --- Faction tier — the one tier with genuine per-event timestamps ---
async function runFactionTier(isBatch, intervalList, elapsedMinutes, sharedCtx) {
    var tierChatId = Store.getCurrentChatId();
    var ctx = sharedCtx || buildWorldTierContext();
    // Cross-tier grounding: already-persisted NPC activity, established-facts framing —
    // see WorldAgent's CROSS-TIER GROUNDING section.
    var recentNpcActivityText = Store.WorldAgent.formatNpcStatesForPrompt(Store.worldData.npcStates, ctx.onscreenNamesArr, 8, Store.storyData ? Store.storyData.time : null);
    // Relevance-weighted reveals: surface the ones connected to what's currently onscreen
    // first, instead of a flat chronological list — pure keyword/name overlap, see
    // WorldAgent.rankRevealsByRelevance. Falls back to the plain list if there are none.
    var rankedReveals = Store.WorldAgent.rankRevealsByRelevance(Store.worldData.pendingReveals, {
        onscreenNames: ctx.onscreenNamesArr, currentLocation: ctx.currentLoc,
    });
    var prompt = Store.WorldAgent.buildFactionTickPrompt({
        currentTime: Store.storyData.time, currentDate: Store.storyData.date, intervalList: isBatch ? intervalList : null,
        currentLocation: ctx.currentLoc, recentEventsText: ctx.recentEv,
        worldSummary: Store.WorldAgent.capWorldSummary(Store.worldData.worldSummary) || "No world summary yet.",
        pendingRevealsText: rankedReveals.join("\n") || "None.",
        pendingEventsText: buildPendingEventsPromptText().pendingEventsText,
        recentNpcActivityText: (recentNpcActivityText === "No tracked NPCs yet.") ? null : recentNpcActivityText,
        characterLoreText: ctx.characterLoreText,
        relationshipsText: ctx.relationshipsText,
        historyTimelineText: ctx.historyTimelineText, recentChatText: ctx.chatHistoryText,
        elapsedMinutesSinceLastTick: isBatch ? null : elapsedMinutes,
    });
    var data = cleanAndParseJSON(await callWorldAgentPrompt(prompt));
    if (Store.getCurrentChatId() !== tierChatId) throw new Error("chat changed during the faction tier's LLM call — discarded its stale result");
    if (!data) throw new Error("failed to parse the faction tier's LLM response"); // null parse = failed call, not a valid empty tick — throw so it retries
    var patch = Store.WorldAgent.applyFactionTickResponse(data, isBatch ? intervalList : null, Store.storyData.time, Store.storyData.date);

    Store.worldData.worldEvents = Store.WorldAgent.mergeWorldEvents(Store.worldData.worldEvents, patch.events, 15);
    Store.worldData.pendingReveals = Store.WorldAgent.capPendingReveals(Store.worldData.pendingReveals, patch.pending_reveals, 15);

    // --- EventQueue: schedule any delayed offscreen actions the faction tier flagged with
    // duration_minutes (e.g. "a messenger departs, ETA 4h"). Their outcome ('resolution')
    // resolves deterministically once enough RP-time passes — see EventQueue.js and the
    // message handler's EventQueue.processTime() call. Immediate/instant events (no
    // duration_minutes) are unaffected — they've already been recorded above as normal
    // world events and are not touched here.
    if (Store.EventQueue && patch.events && patch.events.length > 0) {
        var nextQueue = Store.worldData._eventQueue || [];
        patch.events.forEach(function(e) {
            if (!e.durationMinutes || e.durationMinutes <= 0) return;
            // Code-side half of prompt rule 9b ("don't invent a duplicate of a
            // pending event"): a model that ignores the rule could re-schedule the
            // same messenger/ship/investigation every faction tick, and each copy
            // would later resolve as a separate world event. Same similarity
            // threshold isDuplicateEvent uses for worldEvents.
            var actionText = e.resolution || e.event;
            var alreadyPending = Store.EventQueue.getPending(nextQueue).some(function(p) {
                return Store.WorldAgent.getEventSimilarity(p.action, actionText) > 0.7;
            });
            if (alreadyPending) {
                console.log("[Story Tracker] Skipped scheduling a faction event too similar to one already pending: " + actionText);
                return;
            }
            try {
                nextQueue = Store.EventQueue.enqueue(nextQueue, {
                    actor: null,
                    action: e.resolution || e.event,
                    startTime: e.time,
                    startDate: e.date,
                    durationMinutes: e.durationMinutes,
                    meta: { origin: "faction", originEvent: e.event, importance: e.importance },
                });
            } catch (err) {
                console.warn("[Story Tracker] Failed to schedule faction event into EventQueue:", err);
            }
        });
        Store.worldData._eventQueue = nextQueue;
    }

    Store.worldData._initialized = true;
    if (!sharedCtx) saveWorldCheckpoint(ctx.originalChat);
    saveWorldData();
}

// --- World tier (daily macro synthesis) ---
async function runWorldTier(isBatch, elapsedMinutes, sharedCtx) {
    var tierChatId = Store.getCurrentChatId();
    var ctx = sharedCtx || buildWorldTierContext();
    var recentFactionText = (Store.worldData.worldEvents || []).slice(0, 8).map(function(e) { return "- " + e.event; }).join("\n") || "None yet.";
    var prompt = Store.WorldAgent.buildWorldTickPrompt({
        currentTime: Store.storyData.time, currentDate: Store.storyData.date, isBatch: isBatch,
        worldSummaryBefore: Store.WorldAgent.capWorldSummary(Store.worldData.worldSummary) || "No world summary yet.",
        recentFactionEventsText: recentFactionText, characterLoreText: ctx.characterLoreText,
        historyTimelineText: ctx.historyTimelineText, recentChatText: ctx.chatHistoryText,
        season: ctx.season,
        elapsedMinutesSinceLastTick: elapsedMinutes,
    });
    var data = cleanAndParseJSON(await callWorldAgentPrompt(prompt));
    if (Store.getCurrentChatId() !== tierChatId) throw new Error("chat changed during the world tier's LLM call — discarded its stale result");
    if (!data) throw new Error("failed to parse the world tier's LLM response"); // null parse = failed call, not a valid empty tick — throw so it retries
    var patch = Store.WorldAgent.applyWorldTickResponse(data, 500);
    if (patch) Store.worldData.worldSummary = patch.summary;
    Store.worldData.lastTickTime = Store.storyData.time;
    Store.worldData.lastTickDate = Store.storyData.date;
    Store.worldData._initialized = true;
    if (!sharedCtx) saveWorldCheckpoint(ctx.originalChat);
    saveWorldData();
}

// --- World Rules (lore digest) manual refresh — NOT a Scheduler tier: it never
// fires on any automatic cadence, and "rules" never appears in Scheduler config,
// so the only route here is the World tab's wand via regenerateWorldSection().
// This is deliberately the single post-genesis path that ever sends raw card
// text again — and only because the user explicitly asked for a fresh
// distillation (e.g. after reworking a card, since there's no automatic
// card-change detection by design).
async function runLoreDigestRefresh(isBatch, elapsedMinutes, sharedCtx) {
    var tierChatId = Store.getCurrentChatId();
    var loreText = getCharacterLoreText();
    // Fold in the optional world-seed lorebook (same source the genesis digest uses).
    // With a book set, this can distill even when the card itself has no lore text.
    var wandSeedBook = await getSeedLorebookText();
    if (wandSeedBook) loreText = loreText ? (loreText + "\n\n" + wandSeedBook) : wandSeedBook;
    if (!loreText) throw new Error("no character card lore or seed lorebook available to distill");
    var ctx = sharedCtx || buildWorldTierContext();
    var prompt = Store.WorldAgent.buildLoreDigestPrompt({
        characterLoreText: loreText,
        currentDigestText: Store.WorldAgent.formatLoreDigestForPrompt(Store.worldData.loreDigest),
        recentChatText: ctx.chatHistoryText,
    });
    var data = cleanAndParseJSON(await callWorldAgentPrompt(prompt));
    if (Store.getCurrentChatId() !== tierChatId) throw new Error("chat changed during the World Rules refresh — discarded its stale result");
    if (!data) throw new Error("failed to parse the World Rules refresh response");
    var digest = Store.WorldAgent.sanitizeLoreDigest(data.lore_digest, 12);
    if (!digest) throw new Error("no usable lore_digest in the response");
    Store.worldData.loreDigest = digest;
    saveWorldData();
}

var WORLD_TIER_RUNNERS = { npc: runNpcTier, weather: runWeatherTier, faction: runFactionTier, world: runWorldTier, rules: runLoreDigestRefresh };

// --- Manual "regenerate this section" (wand icon): re-runs ONE tier immediately,
// independent of its scheduled interval, instead of "Run Tick"'s all-four-at-once.
// NOTE on semantics: this is a fresh tick, not a destructive "redo the last output".
// It merges into existing state the same way a normal scheduled tick would
// (WorldAgent.upsertManyNpcStates merges NPCs by name; mergeWorldEvents appends new
// events, capped at 15) — it does not delete or replace whatever was already there.
// If a specific bad line needs to go, remove it first (e.g. via the trash/cancel
// controls) then regenerate, or use "Clear" for a full reset.
export async function regenerateWorldSection(tier, $btn) {
    if (!Store.settings.enabled || !Store.settings.worldEnabled) {
        if (typeof toastr !== "undefined") toastr.warning("World Agent is disabled. Enable it in settings first.");
        return;
    }
    if (Store.worldBusy) {
        if (typeof toastr !== "undefined") toastr.info("World Agent is already busy — please wait.");
        return;
    }
    if (!Store.isChatOpen()) {
        if (typeof toastr !== "undefined") toastr.warning("No active chat is open.");
        return;
    }
    var runner = WORLD_TIER_RUNNERS[tier];
    if (!runner) return;
    // Unlike the real tiers (which MERGE into existing state), a World Rules
    // refresh REPLACES the whole list — including any hand-verified edits, which
    // are exactly the corrections the editable list exists for. Never silently.
    if (tier === "rules") {
        var seedBooks = (Store.worldData && Array.isArray(Store.worldData.seedLorebooks)) ? Store.worldData.seedLorebooks : [];
        var srcDesc = seedBooks.length
            ? ("the character card and " + seedBooks.length + " selected lorebook" + (seedBooks.length > 1 ? "s" : ""))
            : "the character card";
        if (!confirm("Regenerate World Rules from " + srcDesc + "? This REPLACES the current list, including any manual edits.")) return;
    }

    loadWorldData();
    Store.setWorldBusy(true);
    var $icon = $btn ? $btn.prop("disabled", true).find("i") : null;
    if ($icon) $icon.removeClass("fa-wand-magic-sparkles").addClass("fa-spinner fa-spin");
    HUD.setHudStatus("World...");
    if (typeof toastr !== "undefined") toastr.info("Regenerating " + tier + "...", "", { timeOut: 0, extendedTimeOut: 0 });
    try {
        // Same reasoning as runManualWorldTick — snapshot the actual elapsed RP-minutes
        // for THIS tier before zeroing it, so a regenerate fired well short of the tier's
        // normal interval reads as a light, correctly-scoped touch-up, not a full interval.
        var elapsedForRegenTier = (Store.worldData._schedulerAccumulated && Store.worldData._schedulerAccumulated[tier]) || 0;
        // A single-tier regen also injects the live lorebook entries (harmless for the
        // 'rules' tier, which builds its own seed text and ignores ctx.characterLoreText).
        await refreshLiveContextCache();
        await runTrackerProfileSession(async function () {
            if (tier === "faction") {
                await runFactionTier(false, null, elapsedForRegenTier);
            } else {
                await runner(false, elapsedForRegenTier);
            }
        });
        if (Store.worldData._schedulerAccumulated) {
            Store.worldData._schedulerAccumulated[tier] = 0;
            saveWorldData();
        }
        window.renderModal(); HUD.renderHUD();
        HUD.clearHudStatus();
        if (typeof toastr !== "undefined") { toastr.clear(); toastr.success(tier.charAt(0).toUpperCase() + tier.slice(1) + " regenerated."); }
    } catch (e) {
        HUD.clearHudStatus();
        if (typeof toastr !== "undefined") { toastr.clear(); toastr.error("Regenerate failed: " + e.message); }
    } finally {
        Store.setWorldBusy(false);
        if ($icon) $icon.removeClass("fa-spinner fa-spin").addClass("fa-wand-magic-sparkles");
        if ($btn) $btn.prop("disabled", false);
    }
}

// --- Dispatcher: called from the message handler with whatever tiers Scheduler.evaluate()
// determined are due this turn. Owns its own HUD/toast feedback, same principle established
// earlier: feedback only appears when a tier is genuinely about to run, not on every message. ---
// rollbackTotals: { [tier]: number } — the accumulated RP-minutes each due tier held BEFORE
// evaluate() optimistically reset/consumed it this message (see the message handler). Each
// tier's LLM call gets its OWN try/catch below: a failure in one tier (bad JSON, a network
// blip, a rate limit) no longer aborts the rest of the batch, and that tier's accumulator is
// restored to its rollback value so the failed update retries next message instead of the
// tier silently sitting idle for a full fresh interval as if it had already ticked.
// bigSkipInfo: { isBigSkip: true, totalElapsedMinutes } — set when Scene Agent flagged
// explicit_skip on a large "elapsed" answer (a stated multi-day/week/month/year skip; see
// TimelineEngine's maxExplicitSkipMinutes). A skip that big blows straight past every
// tier's normal maxCatchupTicks cap, and without this, each tier would only ever reason
// about a few days' worth of "catch up" (the capped/discarded remainder) instead of the
// real gap — the clock jumps six months but the World/NPC/Weather/Faction tiers would
// never actually see more than ~3 days of it. When set, every tier below reasons about
// the TRUE full elapsed span instead of the Scheduler-capped one.
export async function runDueWorldTiers(orderedDueTiers, timeBeforeMsg, rollbackTotals, bigSkipInfo) {
    if (!Store.settings.enabled || !Store.settings.worldEnabled || !Store.genRaw || orderedDueTiers.length === 0) return;

    rollbackTotals = rollbackTotals || {};
    bigSkipInfo = (bigSkipInfo && bigSkipInfo.isBigSkip && bigSkipInfo.totalElapsedMinutes > 0) ? bigSkipInfo : null;
    // Which chat this batch belongs to — a switch mid-batch means the accumulators/
    // checkpoint now live in the NEW chat's worldData, so neither the failure
    // rollback nor the post-batch bookkeeping below may touch them anymore.
    var batchChatId = Store.getCurrentChatId();
    Store.setWorldBusy(true);
    HUD.setHudStatus("World...");
    if (typeof toastr !== "undefined") toastr.info("Story Tracker: Running world tiers...", "", { timeOut: 0, extendedTimeOut: 0 });
    var succeeded = [];
    var failed = [];

    // Built ONCE for the whole batch and handed to every tier below — this is the fix for
    // the shared-checkpoint bug: previously each tier called buildWorldTierContext() (which
    // reads worldData._worldCheckpointIdx) AND saveWorldCheckpoint() (which advances that
    // same checkpoint) independently. In sequential mode the first tier's save would already
    // be in effect by the time the second tier built its context, so later tiers in the batch
    // saw a much shorter "since checkpoint" chat window than the first one did. Building the
    // context once up front and saving the checkpoint once at the end (below) means every
    // tier in this batch — sequential or parallel — sees the identical window.
    // Resolve this chat's hand-picked live lorebook entries once for the whole batch
    // (re-read fresh so dynamic entries are current); the tiers read it via the cache.
    await refreshLiveContextCache();
    var sharedCtx = buildWorldTierContext();

    // One tier's full run+error-handling, factored out so both the sequential and
    // parallel paths below share identical success/failure/rollback behavior.
    async function runOneTier(due) {
        var runner = WORLD_TIER_RUNNERS[due.tier];
        if (!runner) return; // 'scene' tier is handled separately by doLLMUpdate, not here

        var isBatch = due.ticksDue > 1;
        var intervalList = null;
        // How much RP-time this tick actually covers — ticksDue * interval, e.g. one
        // World tick at the normal 1440min interval covers ~1 day, matching what the
        // tier's prompt should assume. See WorldAgent.elapsedDurationBlock.
        var elapsedForTier = due.ticksDue * due.intervalMinutes;

        if (bigSkipInfo) {
            // Ignore the Scheduler-capped numbers entirely for this tick — a single explicit
            // skip this large is a one-off event, not the gradual "many small messages piled
            // up" case maxCatchupTicks is meant to guard. Always treat it as a batch covering
            // the FULL real gap.
            isBatch = true;
            elapsedForTier = bigSkipInfo.totalElapsedMinutes;
            if (due.tier === "faction") {
                // Faction still wants discrete timestamps to tag events to, but asking for one
                // per due.intervalMinutes across a multi-month gap could mean hundreds of
                // points. Spread a small, fixed number of checkpoints evenly across the WHOLE
                // gap instead — reuses maxWorldTicks as "how many discrete beats are reasonable
                // to ask for in one batch", same meaning it already has elsewhere.
                var factionPoints = Math.max(1, Store.settings.maxWorldTicks || 3);
                var factionStepMinutes = bigSkipInfo.totalElapsedMinutes / factionPoints;
                intervalList = Store.Scheduler.computeTickTimestamps(timeBeforeMsg.time, timeBeforeMsg.date, factionStepMinutes, factionPoints);
            }
        } else if (due.tier === "faction" && isBatch) {
            intervalList = Store.Scheduler.computeTickTimestamps(timeBeforeMsg.time, timeBeforeMsg.date, due.intervalMinutes, due.ticksDue);
        }

        console.log("[Story Tracker] Running World tier '" + due.tier + "' (ticksDue=" + due.ticksDue + ", deferred=" + due.ticksDeferred + ")");
        try {
            if (due.tier === "faction") {
                await runFactionTier(isBatch, intervalList, elapsedForTier, sharedCtx);
            } else {
                await runner(isBatch, elapsedForTier, sharedCtx);
            }
            succeeded.push(due.tier);
        } catch (tierErr) {
            failed.push(due.tier);
            if (Store.getCurrentChatId() !== batchChatId) {
                // The failure IS the chat switch (the tier's own guard threw) — the
                // accumulators now belong to the newly opened chat, so restoring the
                // OLD chat's rollback totals into them would corrupt the new chat.
                console.warn("[Story Tracker] World tier '" + due.tier + "' abandoned — chat switched mid-batch; skipping rollback (the accumulators belong to the new chat now).");
            } else {
                console.warn("[Story Tracker] World tier '" + due.tier + "' failed — rolling back its scheduler accumulator so it retries next message instead of waiting a full fresh interval:", tierErr);
                if (Store.worldData && Store.worldData._schedulerAccumulated && rollbackTotals.hasOwnProperty(due.tier)) {
                    Store.worldData._schedulerAccumulated[due.tier] = rollbackTotals[due.tier];
                    saveWorldData();
                }
            }
        }
    }

    try {
        // Wrapping the WHOLE batch in one withWorldConnectionProfile call — instead of
        // letting each tier's own callWorldAgentPrompt() switch independently — means the
        // profile is switched exactly once and restored exactly once per batch, even when
        // parallelWorldTiers fires several tiers' genRaw() calls concurrently below. See
        // withWorldConnectionProfile's reentrancy guard: nested per-tier calls just run
        // directly once this outer call already holds the switch.
        await withWorldConnectionProfile(async function () {
            if (Store.settings.parallelWorldTiers) {
                // Two phases: everything except 'world' can run concurrently (none of npc/
                // weather/faction depend on each other's OUTPUT from this same tick — cross-
                // tier context they read, like faction's recentNpcActivityText, comes from
                // state already persisted BEFORE this batch started). 'world' runs after,
                // alone, since its prompt explicitly wants faction's freshly-produced events
                // from THIS tick (see runWorldTier's recentFactionText).
                var phase1 = orderedDueTiers.filter(function(d) { return d.tier !== "world"; });
                var phase2 = orderedDueTiers.filter(function(d) { return d.tier === "world"; });
                if (phase1.length > 0) {
                    console.log("[Story Tracker] Running world tiers in parallel: " + phase1.map(function(d){return d.tier;}).join(", "));
                    await Promise.all(phase1.map(runOneTier));
                }
                for (var p = 0; p < phase2.length; p++) await runOneTier(phase2[p]);
            } else {
                for (var i = 0; i < orderedDueTiers.length; i++) {
                    await runOneTier(orderedDueTiers[i]);
                    if (i < orderedDueTiers.length - 1) await new Promise(function(r) { setTimeout(r, 1000); });
                }
            }
        });
        // Advance the shared checkpoint exactly once for the whole batch, and only if at
        // least one tier actually consumed this window — mirrors the old per-tier behavior
        // (which only ever saved on that tier's success path) without letting a later tier
        // in the batch see an already-advanced checkpoint from an earlier one. Skipped
        // entirely if the chat switched mid-batch: worldData now belongs to the new chat,
        // and this checkpoint/accumulator bookkeeping describes the OLD one.
        if (succeeded.length > 0 && Store.getCurrentChatId() === batchChatId) {
            saveWorldCheckpoint(sharedCtx.originalChat);
            if (bigSkipInfo && Store.worldData && Store.worldData._schedulerAccumulated) {
                // The whole gap was just accounted for above regardless of what the normal
                // per-tier tick math says, so every tier (not just the ones that happened to
                // be "due") starts its next cadence fresh from here — EXCEPT tiers that
                // failed this batch: their rollback was just restored a few lines up, and
                // zeroing it here would erase their retry, silently losing the skipped
                // interval for exactly the tiers that never got to process it.
                ["npc", "weather", "faction", "world"].forEach(function (t) {
                    if (failed.indexOf(t) === -1) Store.worldData._schedulerAccumulated[t] = 0;
                });
            }
            saveWorldData();
        }
        window.renderModal(); HUD.renderHUD();
        HUD.clearHudStatus();
        if (typeof toastr !== "undefined") {
            toastr.clear();
            if (succeeded.length > 0) toastr.info("World tiers updated: " + succeeded.join(", "));
            if (failed.length > 0) toastr.warning("Failed (will retry next message): " + failed.join(", "));
        }
    } catch (e) {
        // Anything unexpected outside the per-tier loop itself (e.g. a rendering error) —
        // the per-tier try/catch above already handles individual LLM-call failures.
        console.error("[Story Tracker] World tier run failed:", e);
        HUD.clearHudStatus();
        if (typeof toastr !== "undefined") { toastr.clear(); toastr.error("World tick failed: " + e.message); }
    } finally {
        Store.setWorldBusy(false);
    }
}

// --- Manual "Run World Tick" button: runs all 4 tiers once immediately, single-tick each ---
export async function runManualWorldTick() {
    if (!Store.settings.enabled) {
        if (typeof toastr !== "undefined") toastr.warning("Story Tracker is disabled. Enable it in the extension settings.");
        return;
    }
    if (Store.worldBusy) return;
    if (!Store.settings.worldEnabled) {
        if (typeof toastr !== "undefined") toastr.warning("World Agent is disabled. Enable it in settings first.");
        return;
    }
    if (!Store.isChatOpen()) {
        if (typeof toastr !== "undefined") toastr.warning("No active chat is open.");
        return;
    }

    loadWorldData();

    Store.setWorldBusy(true);
    var $btn = $("#st-world-btn-tick").prop("disabled", true).html('<i class="fa-solid fa-spinner fa-spin"></i> Ticking...');
    HUD.setHudStatus("World...");
    if (typeof toastr !== "undefined") toastr.info("Story Tracker: Running world tick...", "", { timeOut: 0, extendedTimeOut: 0 });
    try {
        // Snapshot each tier's ACTUAL elapsed RP-minutes since its last tick, before the
        // reset below zeroes them out — this is what makes an early manual run (e.g. 20
        // messages in, well short of any tier's normal interval) correctly scoped to "just
        // what's happened so far" instead of reading as a full interval's worth of change.
        // See WorldAgent.elapsedDurationBlock / formatElapsedDurationForPrompt.
        var accum = Store.worldData._schedulerAccumulated || {};
        var elapsedNpc = accum.npc || 0;
        var elapsedWeather = accum.weather || 0;
        var elapsedFaction = accum.faction || 0;
        var elapsedWorld = accum.world || 0;

        // Same fix as runDueWorldTiers: build the checkpoint-derived context ONCE for all
        // 4 tiers in this manual tick, rather than each of the 4 sequential calls below
        // reading a checkpoint the previous call already advanced — see the comment on
        // sharedCtx in runDueWorldTiers for the full explanation.
        await refreshLiveContextCache(); // pull in the live lorebook entries for this manual tick
        var sharedCtx = buildWorldTierContext();
        await runTrackerProfileSession(async function () {
            await runNpcTier(false, elapsedNpc, sharedCtx);
            await runWeatherTier(false, elapsedWeather, sharedCtx);
            await runFactionTier(false, null, elapsedFaction, sharedCtx);
            await runWorldTier(false, elapsedWorld, sharedCtx);
        });
        saveWorldCheckpoint(sharedCtx.originalChat);
        if (Store.worldData._schedulerAccumulated) {
            Store.worldData._schedulerAccumulated.npc = 0;
            Store.worldData._schedulerAccumulated.weather = 0;
            Store.worldData._schedulerAccumulated.faction = 0;
            Store.worldData._schedulerAccumulated.world = 0;
            saveWorldData();
        }
        window.renderModal(); HUD.renderHUD();
        HUD.clearHudStatus();
        if (typeof toastr !== "undefined") { toastr.clear(); toastr.success("World tick generated!"); }
    } catch(e) {
        HUD.clearHudStatus();
        if (typeof toastr !== "undefined") { toastr.clear(); toastr.error("World tick failed: " + e.message); }
    } finally {
        Store.setWorldBusy(false);
        $btn.prop("disabled", false).html('<i class="fa-solid fa-play"></i> Run World Tick');
    }
}


// --- Relationship Tracker Engine ---

export async function doRelationshipUpdate() {
    if (!Store.genRaw) throw new Error("Raw LLM generation not available.");
    if (!Store.isChatOpen()) throw new Error("No active chat is open.");
    if (!Store.storyData) throw new Error("No story data available.");

    loadRelationshipData();
    if (!Store.relationshipData) return;

    // Build character list from current scene
    var sceneChars = (Store.storyData.characters || []).map(function(c) { return c.name; }).join(", ") || "None identified.";
    var sceneCharSet = new Set((Store.storyData.characters || []).map(function(c) { return c.name; }));

    // Build recent chat context using checkpoint system
    // On first run (no checkpoint) grab the last 20 messages.
    // On subsequent runs grab only messages since the last checkpoint message index.
    var liveChat = Store.getLiveChat() || [];
    var userName = (Store.scriptModule && Store.scriptModule.name1) ? Store.scriptModule.name1 : "{{user}}";
    // Validate checkpoint anchor to detect index drift from deletions/swipes
    var lastCheckpoint = -1;
    if (Store.relationshipData && Store.relationshipData._checkpointMsgIdx != null) {
        var cpIdx = Store.relationshipData._checkpointMsgIdx;
        var cpAnchor = Store.relationshipData._checkpointAnchor || "";
        var cpMsg = liveChat[cpIdx];
        var cpMsgText = (cpMsg && cpMsg.mes) ? String(cpMsg.mes).slice(0, 40) : "";
        // Trust the checkpoint only if the message at that index still matches the anchor
        if (cpAnchor && cpMsgText === cpAnchor) {
            lastCheckpoint = cpIdx;
        } else {
            console.warn("[Story Tracker] Relationship checkpoint anchor mismatch - falling back to last 20 messages.");
        }
    }
    var relevantMsgs = lastCheckpoint >= 0
        ? liveChat.slice(lastCheckpoint + 1)
        : liveChat.slice(-20);
    // Always include at least 3 messages for context even if interval fires early
    if (relevantMsgs.length < 3) relevantMsgs = liveChat.slice(-3);
    var chatText = "";
    relevantMsgs.forEach(function(msg) {
        var sender = msg.is_user ? userName : (msg.name || "Character");
        var text = (msg.mes || "").trim();
        if (text) chatText += sender + ": " + text + "\n\n";
    });
    chatText = chatText.trim() || "No recent messages.";

    // --- Tiered relationship context ---------------------------------------
    // Sending the FULL edge set (summary + prose) every tick doesn't scale as
    // relationships accumulate over a long chat — it bloats every single call
    // whether or not those pairs are even relevant right now. But naively
    // dropping distant pairs risks the model "forgetting" them and inventing a
    // contradictory relationship if that pair resurfaces later.
    //
    // Middle ground: pairs touching someone currently onscreen (or mentioned in
    // the recent chat window) get sent in FULL — summary, type, strength, and
    // their last couple of history entries — since those are the only ones the
    // model should actually be updating this tick anyway. Everyone else is
    // "background": a compact one-liner (names/type/strength, no prose) purely
    // so the model knows the pair already has an established relationship and
    // won't re-derive a conflicting one from scratch — the full detail stays
    // safe in storage untouched, it's just not re-sent verbosely every call.
    var highlighted = [];
    var background = [];
    (Store.relationshipData.edges || []).forEach(function(e) {
        var relevant = sceneCharSet.has(e.from) || sceneCharSet.has(e.to)
            || Store.RelationshipAgent.nameMentionedInText(e.from, chatText) || Store.RelationshipAgent.nameMentionedInText(e.to, chatText);
        (relevant ? highlighted : background).push(e);
    });

    var highlightedRelationshipsText = highlighted.length > 0
        ? highlighted.map(function(e) {
            var sign = e.strength >= 0 ? "+" : "";
            var reciprocal = Store.RelationshipAgent.hasReciprocalEdge(Store.relationshipData.edges, e.from, e.to);
            var line = "- " + e.from + " \u2192 " + e.to + (reciprocal ? " (one-sided — a separate " + e.to + " \u2192 " + e.from + " entry also exists)" : "") +
                       ": " + e.type + " (strength: " + sign + (e.strength || 0).toFixed(1) + ") \u2014 " + e.summary;
            var recentHist = (e.history || []).slice(0, 2);
            if (recentHist.length > 0) {
                line += "\n    Recent history: " + recentHist.map(function(h) {
                    var when = h.date ? (h.time || "") + " " + h.date : ("msg #" + (h.msg || 0));
                    return "[" + when.trim() + "] " + (h.summary || "");
                }).join(" | ");
            }
            return line;
        }).join("\n")
        : "None yet — identify all meaningful relationships from scratch.";

    var backgroundRelationshipsText = background.length > 0
        ? background.map(function(e) {
            var sign = e.strength >= 0 ? "+" : "";
            var reciprocal = Store.RelationshipAgent.hasReciprocalEdge(Store.relationshipData.edges, e.from, e.to);
            return "- " + e.from + " \u2192 " + e.to + (reciprocal ? " (one-sided pair)" : "") + ": " + e.type + " (strength: " + sign + (e.strength || 0).toFixed(1) + ")";
        }).join("\n")
        : "None.";

    // Ask for at most a handful of new bios per tick — keeps any one response
    // bounded even if a session has introduced a lot of unbio'd characters at once.
    var nodesNeedingBio = (Store.relationshipData.nodes || []).filter(function(n) { return n && n.name && !n.bio; }).slice(0, 10);
    var charactersNeedingBioText = nodesNeedingBio.length > 0
        ? nodesNeedingBio.map(function(n) { return "- " + n.name; }).join("\n")
        : "";

    // Orphan-nudge: nodes with ZERO edges anywhere. RelationshipAgent.js rule 4a
    // expects every real participant to end up with at least one tracked
    // relationship, but that depends on the checkpoint-windowed chat scan actually
    // catching an interaction on some pass — if it's missed once and the pair
    // doesn't interact again, nothing else would ever re-surface them. This closes
    // that gap by explicitly calling out anyone currently orphaned so the model
    // specifically checks the recent chat for ANY interaction involving them,
    // rather than relying on the general "identify all pairs" instruction to
    // happen to catch it. Same 10-item cap as the bio-nudge list above, same
    // reasoning (bound the response even if a session has a lot of untracked
    // characters at once).
    var edgeTouchedNames = new Set();
    (Store.relationshipData.edges || []).forEach(function(e) {
        edgeTouchedNames.add(e.from);
        edgeTouchedNames.add(e.to);
    });
    var orphanNodes = (Store.relationshipData.nodes || []).filter(function(n) {
        return n && n.name && !edgeTouchedNames.has(n.name);
    }).slice(0, 10);
    var orphanCharactersText = orphanNodes.length > 0
        ? orphanNodes.map(function(n) { return "- " + n.name; }).join("\n")
        : "";

    var prompt = Store.RelationshipAgent.buildRelationshipPrompt({
        sceneCharactersText: sceneChars,
        highlightedRelationshipsText: highlightedRelationshipsText,
        backgroundRelationshipsText: backgroundRelationshipsText,
        charactersNeedingBioText: charactersNeedingBioText,
        orphanCharactersText: orphanCharactersText,
        recentChatText: chatText,
    });

    console.log("[Story Tracker] Running relationship analysis...");
    var relChatId = Store.getCurrentChatId();
    var raw = await withRelConnectionProfile(async function() {
        try { return await Store.genRaw({ prompt: prompt, quietToLoud: true }); }
        catch(e) { logGenRawFailure("relationship tracker", e); return await Store.genRaw(prompt, null, false, true); }
    });

    // Chat switched while the LLM call was in flight — the merge below would write
    // this chat's relationships into the newly opened chat's data. Discard.
    if (Store.getCurrentChatId() !== relChatId) {
        console.warn("[Story Tracker] Chat changed during relationship analysis — discarded the stale result.");
        return;
    }

    // Marks this analysis pass as CONSUMED: advances the checkpoint to the last
    // message and resets the message-count cadence. Called for every successfully
    // PARSED response — including a legitimate "nothing new this round" — but
    // deliberately NOT for a parse failure, so handleMsg's ">= interval" cadence
    // check keeps a genuinely failed call due and retries it on the next message
    // instead of waiting out a whole fresh interval (same philosophy as the world
    // tiers' accumulator rollback).
    function consumeRelationshipCadence() {
        if (liveChat.length > 0) {
            var lastProcessed = liveChat[liveChat.length - 1];
            // The anchor (first 40 chars of the last message) lets the next run detect
            // index drift from message deletions/swipes and fall back to last-20.
            Store.relationshipData._checkpointMsgIdx = liveChat.length - 1;
            Store.relationshipData._checkpointAnchor = (lastProcessed && lastProcessed.mes)
                ? String(lastProcessed.mes).slice(0, 40)
                : "";
        }
        Store.setRelMsgCounter(0); // reset the per-interval counter
        if (Store.storyData) Store.storyData._relMsgCount = 0;
    }

    var rawData = cleanAndParseJSON(raw);
    var validated = Store.RelationshipAgent.applyRelationshipResponse(rawData);
    var data = { relationships: validated.relationships, characterBios: validated.characterBios };
    if (!rawData) {
        console.warn("[Story Tracker] Relationship response invalid or empty.");
        return;
    }
    if (data.relationships.length === 0 && data.characterBios.length === 0) {
        console.log("[Story Tracker] Relationship tick returned nothing new this round.");
        // A parseable empty response is a COMPLETED analysis ("nothing changed"),
        // not a failure — consume the cadence so the next auto-tick is a full
        // interval away, and advance the checkpoint so the same already-reviewed
        // messages aren't re-analyzed next time. (Previously neither happened,
        // which quietly stretched the effective interval after every quiet tick.)
        consumeRelationshipCadence();
        saveRelationshipData();
        return;
    }

    // Merge relationships into existing data
    //
    // Resolve names to their canonical form up front, for every entry in this response,
    // so the asymmetric-pair detection below (which groups by resolved name) sees the
    // same names the merge loop will actually use.
    data.relationships.forEach(function(rel) {
        if (rel && rel.from && rel.to) {
            rel.from = resolveCanonicalName(rel.from);
            rel.to = resolveCanonicalName(rel.to);
        }
    });

    // RelationshipAgent.js rule 4b: almost all relationships are MUTUAL, where the model
    // may output either name as 'from' vs 'to' on any given tick — those should always
    // collapse onto the SAME stored edge regardless of order. A minority are genuinely
    // ASYMMETRIC, where the model deliberately outputs TWO entries for the same pair
    // (A→B and B→A) to describe each side separately — those must stay as two distinct
    // edges. The two cases need different merge behavior, so detect which one applies to
    // each pair by checking how many distinct directions this response gave it: exactly
    // one entry = mutual (direction is arbitrary, reuse whichever edge already exists in
    // either direction); two entries = asymmetric (match/create by EXACT direction only,
    // never merging one side into the other's edge).
    var directionsByPairKey = {};
    data.relationships.forEach(function(r) {
        if (!r || !r.from || !r.to || r.from === r.to) return;
        var pk = r.from < r.to ? (r.from + "\u241F" + r.to) : (r.to + "\u241F" + r.from);
        if (!directionsByPairKey[pk]) directionsByPairKey[pk] = new Set();
        directionsByPairKey[pk].add(r.from + "\u2192" + r.to);
    });

    data.relationships.forEach(function(rel) {
        if (!rel.from || !rel.to || rel.from === rel.to) return;

        var strength = parseFloat(rel.strength);
        if (isNaN(strength)) strength = 0;
        strength = Math.max(-1, Math.min(1, strength));

        var pairKey = rel.from < rel.to ? (rel.from + "\u241F" + rel.to) : (rel.to + "\u241F" + rel.from);
        var responseAsymmetric = directionsByPairKey[pairKey] && directionsByPairKey[pairKey].size > 1;
        // STORED state counts too, not just this response's directions: if both A\u2192B
        // and B\u2192A already exist as separate edges, the pair is established as
        // asymmetric \u2014 a response that happens to mention only one side this tick
        // must update exactly that side. Inferring mutuality from the response
        // alone let a single-direction update land on whichever stored direction
        // sorted first, overwriting the OTHER character's side of the pair.
        var storedAsymmetric = Store.RelationshipAgent.findEdgeIndex(Store.relationshipData.edges, rel.from, rel.to) !== -1 &&
                               Store.RelationshipAgent.findEdgeIndex(Store.relationshipData.edges, rel.to, rel.from) !== -1;
        var isAsymmetricPair = responseAsymmetric || storedAsymmetric;

        // Ensure both character nodes exist (already-resolved names match
        // existing nodes exactly, so this only adds genuinely new characters)
        [rel.from, rel.to].forEach(function(name) {
            if (!Store.relationshipData.nodes.find(function(n) { return n.name === name; })) {
                Store.relationshipData.nodes.push({ id: name, name: name });
            }
        });

        var existing = isAsymmetricPair
            // Asymmetric: this exact direction is its own edge — never match/overwrite
            // the reverse direction's edge, even though it describes the same pair.
            ? Store.relationshipData.edges.find(function(e) { return e.from === rel.from && e.to === rel.to; })
            // Mutual: reuse whichever direction is already stored for this pair, if any
            // — the model swapping from/to order between ticks shouldn't spawn a
            // duplicate edge for what's still the same shared relationship.
            : Store.relationshipData.edges.find(function(e) {
                return (e.from === rel.from && e.to === rel.to) || (e.from === rel.to && e.to === rel.from);
            });

        if (existing) {
            // Record history entry before overwriting — this snapshots the LAST
            // GENERATED state (the summary/strength/type that were actually live
            // until now), not a re-derived description of "what changed". That
            // snapshot is what makes History an honest timeline of prior states
            // rather than a log of the model's own change-notes relabeled as
            // history each tick (which also silently broke the HUD's "most-shifted
            // bond" delta below, since it compared current strength against a
            // history entry that already held the SAME new strength).
            if (!existing.history) existing.history = [];
            // Skip the snapshot entirely when nothing genuinely changed — trusting the
            // model's own 'Stable' signal (that's exactly what it's for), but also
            // double-checking the numbers actually agree before treating it as a no-op,
            // in case 'Stable' was mislabeled despite a real strength/type shift. Without
            // this, a long-idle relationship pads History with a new near-identical entry
            // every single tick it happens to get re-evaluated, even though nothing about
            // it actually moved.
            var relUnchanged = String(rel.change || "").trim().toLowerCase() === "stable" &&
                Math.abs((existing.strength || 0) - strength) < 0.01 &&
                (rel.type || existing.type) === existing.type;
            if (existing.summary && !relUnchanged) {
                existing.history.unshift({
                    msg: Store.storyData._historyCount || 0,
                    time: Store.storyData.time || "",
                    date: Store.storyData.date || "",
                    summary: existing.summary,
                    strength: existing.strength,
                    type: existing.type,
                    change: rel.change || "Updated"
                });
                if (existing.history.length > 20) existing.history = existing.history.slice(0, 20);
            }
            existing.type = rel.type || existing.type;
            existing.strength = strength;
            existing.summary = Store.RelationshipAgent.capRelationshipSummary(rel.summary || existing.summary);
            existing.change = rel.change || "Stable";
        } else {
            Store.relationshipData.edges.push({
                from: rel.from,
                to: rel.to,
                type: rel.type || "neutral",
                strength: strength,
                summary: rel.summary || "",
                change: rel.change || "",
                history: []
            });
        }
    });

    // Ensure all current scene characters have a node entry
    if (Store.storyData.characters) {
        Store.storyData.characters.forEach(function(c) {
            if (!c || !c.name) return;
            var canonical = resolveCanonicalName(c.name);
            if (!Store.relationshipData.nodes.find(function(n) { return n.name === canonical; })) {
                Store.relationshipData.nodes.push({ id: canonical, name: canonical });
            }
        });
    }

    // Write character bios — first-write-wins. This is meant to be a stable, one-time
    // "who this character is" blurb, not something that gets silently rewritten every
    // tick the way edge summaries do, so an existing bio (whether agent-written or
    // manually edited by the user) is never touched here.
    (data.characterBios || []).forEach(function(b) {
        var canonical = resolveCanonicalName(b.name);
        var node = Store.relationshipData.nodes.find(function(n) { return n.name === canonical; });
        if (!node) {
            node = { id: canonical, name: canonical };
            Store.relationshipData.nodes.push(node);
        }
        if (!node.bio) node.bio = b.bio;
    });

    // Save checkpoint + reset the cadence — see consumeRelationshipCadence above.
    consumeRelationshipCadence();
    Store.relationshipData._initialized = true;
    trimRelationshipData();
    applyRelationshipDecay();
    // Catches the case resolveCanonicalName() can't fully handle on its own: when it
    // "upgrades" a node's display name mid-merge (e.g. "Aria" -> "Aria Stormwind"),
    // any edge already stored under the OLD name doesn't get re-keyed to match, since
    // resolveCanonicalName only affects the relationship currently being processed.
    // Left alone, that stale edge/node lingers as a visible duplicate until the chat
    // is closed and reopened (dedupeRelationshipNodes normally only runs on load).
    // Running it here too means a same-session duplicate gets folded back in immediately.
    dedupeRelationshipNodes();
    saveRelationshipData();
    console.log("[Story Tracker] Relationship data saved. Edges:", Store.relationshipData.edges.length);
}

function trimRelationshipData() {
    if (!Store.relationshipData || !Store.relationshipData.edges) return;
    var MAX_EDGES = 100;
    var edges = Store.relationshipData.edges;
    if (edges.length <= MAX_EDGES) return;

    // Which edges are a character's ONLY tracked connection — losing one of these
    // isn't just "trimming the weakest link," it silently orphans that character,
    // undoing RelationshipAgent.js rule 4a's expectation that every real
    // participant ends up with at least one relationship somewhere. Count endpoint
    // occurrences so those edges can be shielded from the weakest-first cut below.
    // (Asymmetric A->B / B->A pairs count as two separate touches here — either
    // one alone is still "a" relationship for that character, so neither needs
    // individual protection.)
    var touchCount = {};
    edges.forEach(function(e) {
        touchCount[e.from] = (touchCount[e.from] || 0) + 1;
        touchCount[e.to] = (touchCount[e.to] || 0) + 1;
    });
    var isSoleConnection = function(e) { return touchCount[e.from] === 1 || touchCount[e.to] === 1; };

    var protectedEdges = edges.filter(isSoleConnection);
    var prunable = edges.filter(function(e) { return !isSoleConnection(e); });
    var overBy = edges.length - MAX_EDGES;

    if (prunable.length >= overBy) {
        // Normal case: enough non-essential edges exist to hit the cap without
        // touching anyone's only connection. Weakest-first within that pool only.
        prunable.sort(function(a, b) { return Math.abs(a.strength || 0) - Math.abs(b.strength || 0); });
        Store.relationshipData.edges = protectedEdges.concat(prunable.slice(overBy));
    } else {
        // Pathological case: the graph is so sparse that protected edges ALONE
        // exceed the cap (almost every character has exactly one connection).
        // Nothing can be cut without orphaning someone — fall back to the old
        // weakest-first behavior across everything rather than refusing to ever
        // shrink the queue.
        var all = edges.slice().sort(function(a, b) { return Math.abs(a.strength || 0) - Math.abs(b.strength || 0); });
        Store.relationshipData.edges = all.slice(all.length - MAX_EDGES);
    }

    // Nodes are deliberately left untouched here. A zero-edge node isn't cleanup
    // debris anymore — rule 4a now expects some characters to legitimately sit at
    // zero edges (a real participant who just hasn't had a tracked interaction
    // YET), and doRelationshipUpdate's orphan-nudge list (see below) depends on
    // those nodes surviving so it can keep prompting the model to find their
    // first connection. The previous "drop any node an edge doesn't reference"
    // step would have erased that character's bio/position the moment the edge
    // count happened to cross MAX_EDGES, for reasons that had nothing to do with
    // them personally.
    console.log("[Story Tracker] Relationship data trimmed to " + Store.relationshipData.edges.length + " edges.");
}

// Nudge edges toward neutral when neither character has appeared in recent chat.
// Keeps the graph reflecting current story focus rather than freezing old bonds.
function applyRelationshipDecay() {
    if (!Store.relationshipData || !Store.relationshipData.edges || !Store.relationshipData.edges.length) return;

    var liveChat = Store.getLiveChat() || [];
    var recentMsgs = liveChat.slice(-25);
    var recentNames = new Set();
    var userName = (Store.scriptModule && Store.scriptModule.name1) ? Store.scriptModule.name1 : "User";
    recentMsgs.forEach(function(msg) {
        var name = msg.is_user ? userName : (msg.name || "");
        if (name) recentNames.add(name);
    });

    // Decay rate SCALES with |strength| rather than being flat: a casual/lukewarm tie (close
    // to 0) fades at roughly the original rate, but a deep bond or bitter rivalry (close to
    // ±1) fades far more slowly. A flat rate meant every relationship — a fixed, dramatic
    // betrayal (-0.9) as much as a passing acquaintance (0.15) — eroded to near-neutral in
    // the same ~100-150 messages of a character being offscreen, which flattens exactly the
    // relationships that are supposed to be the story's most permanent ones.
    var DECAY_RATE_WEAK = 0.04;  // rate at strength 0 — unchanged from before
    var DECAY_RATE_STRONG = 0.004; // rate at strength ±1.0 — 10x slower
    var FLOOR = 0.05;             // don't decay below this absolute value (avoids zero-crossing oscillation)

    Store.relationshipData.edges.forEach(function(edge) {
        // Only decay edges where both characters are absent from recent messages
        if (recentNames.has(edge.from) || recentNames.has(edge.to)) return;

        var s = edge.strength || 0;
        if (Math.abs(s) <= FLOOR) return;

        var t = Math.min(1, Math.abs(s));
        var decayRate = DECAY_RATE_WEAK - (DECAY_RATE_WEAK - DECAY_RATE_STRONG) * t;

        var direction = s > 0 ? -1 : 1;
        var newStrength = s + direction * decayRate;

        // Clamp: don't let decay push past zero
        if (s > 0 && newStrength < FLOOR) newStrength = FLOOR;
        if (s < 0 && newStrength > -FLOOR) newStrength = -FLOOR;

        edge.strength = parseFloat(newStrength.toFixed(2));
    });
}

export async function runManualRelationshipAnalysis() {
    if (!Store.settings.enabled) {
        if (typeof toastr !== "undefined") toastr.warning("Story Tracker is disabled. Enable it in the extension settings.");
        return;
    }
    if (Store.relsBusy) return;
    if (Store.anyBusy() && !Store.relsBusy) {
        if (typeof toastr !== "undefined") toastr.warning("Another agent is running. Please wait.");
        return;
    }
    if (!Store.settings.relationsEnabled) {
        if (typeof toastr !== "undefined") toastr.warning("Relationship Tracker is disabled. Enable it in settings first.");
        return;
    }
    if (!Store.isChatOpen()) {
        if (typeof toastr !== "undefined") toastr.warning("Story Tracker: No active chat is open.");
        return;
    }

    loadRelationshipData();
    Store.setRelsBusy(true);
    var $btn = $("#st-rel-btn-analyze").prop("disabled", true).html('<i class="fa-solid fa-spinner fa-spin"></i> Analyzing...');
    HUD.setHudStatus("Relations...");
    if (typeof toastr !== "undefined") toastr.info("Story Tracker: Analyzing relationships...", "", { timeOut: 0, extendedTimeOut: 0 });
    try {
        await runTrackerProfileSession(function() { return doRelationshipUpdate(); });
        window.renderRelationshipGraph();
        HUD.renderHUD();
        HUD.clearHudStatus();
        if (typeof toastr !== "undefined") { toastr.clear(); toastr.success("Relationships analyzed!"); }
    } catch(e) {
        HUD.clearHudStatus();
        if (typeof toastr !== "undefined") { toastr.clear(); toastr.error("Relationship analysis failed: " + e.message); }
        console.error("[Story Tracker] Manual relationship analysis error:", e);
    } finally {
        Store.setRelsBusy(false);
        $btn.prop("disabled", false).html('<i class="fa-solid fa-magnifying-glass-chart"></i> Analyze');
    }
}
