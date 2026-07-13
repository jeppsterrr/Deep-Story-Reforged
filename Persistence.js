/*
 * Persistence.js
 * ---------------------------------------------------------------------------
 * Everything about GETTING story/world/relationship data into and out of
 * SillyTavern's storage (extension_settings for `settings`, chat_metadata for
 * the three per-chat data blobs). Extracted verbatim from index.js — no
 * behavior changes, just relocated + wired to Store.js instead of bare
 * top-level `var`s. See Store.js's file header for why that's the pattern.
 *
 * Also home to two small pieces of logic that are really "shape the loaded
 * data into what the rest of the app expects" rather than orchestration:
 * genesis time-seeding on first load, and the resolveCanonicalName/
 * dedupeRelationshipNodes shims (the real matching logic now lives as pure
 * functions in RelationshipAgent.js — see its "NAME RESOLUTION" section --
 * these just apply that result back onto relationshipData and save).
 * ---------------------------------------------------------------------------
 */

import * as Store from "./Store.js";

export const MODULE = "story-tracker";
export const DATA_KEY = "story_tracker_data";
export const WORLD_KEY = "story_world_data";
export const RELATIONSHIP_KEY = "story_relationship_data";

function padZero(n) { return n < 10 ? "0" + n : String(n); }

function getRandomDate() {
    // Generate a random date between Jan 1, 2020 and Dec 31, 2026
    var start = new Date(2020, 0, 1).getTime();
    var end = new Date(2026, 11, 31).getTime();
    var randomTime = start + Math.random() * (end - start);
    var d = new Date(randomTime);
    return padZero(d.getDate()) + "/" + padZero(d.getMonth() + 1) + "/" + d.getFullYear();
}

// --- Time and Date Sanitization Helpers (used by the manual "Correct Tracked Time" UI) ---
export function sanitizeTimeStr(timeStr, fallbackTimeStr) {
    if (typeof timeStr !== "string") return fallbackTimeStr || "12:00";
    timeStr = timeStr.trim();
    var m = timeStr.match(/^(\d{1,2})[:.](\d{1,2})$/);
    if (!m) return fallbackTimeStr || "12:00";

    var hh = parseInt(m[1], 10);
    var mm = parseInt(m[2], 10);

    if (isNaN(hh) || hh < 0 || hh > 23) hh = 0;
    if (isNaN(mm) || mm < 0 || mm > 59) {
        if (fallbackTimeStr) {
            var fallbackParts = fallbackTimeStr.split(":");
            if (fallbackParts.length >= 2) {
                var fMin = parseInt(fallbackParts[1], 10);
                mm = (!isNaN(fMin) && fMin >= 0 && fMin <= 59) ? fMin : 0;
            } else {
                mm = 0;
            }
        } else {
            mm = 0;
        }
    }

    return padZero(hh) + ":" + padZero(mm);
}

export function sanitizeDateStr(dateStr, fallbackDateStr) {
    if (typeof dateStr !== "string") return fallbackDateStr || "01/01/2026";
    dateStr = dateStr.trim();
    var parts = dateStr.split(/[/\-.,]/).map(function(s) { return s.trim(); }).filter(Boolean);
    if (parts.length < 3) return fallbackDateStr || "01/01/2026";

    var day = parseInt(parts[0], 10);
    var month = parseInt(parts[1], 10);
    var year = parseInt(parts[2], 10);

    if (isNaN(day) || day < 1 || day > 31) day = 1;
    if (isNaN(month) || month < 1 || month > 12) month = 1;
    if (isNaN(year) || year < 1000) year = 2026;

    // Clamp to a real day of that month — "31/02" would otherwise keep the nonsense
    // string as the display date while every epoch computation silently rolled it
    // over to March, leaving the shown date and the clock math disagreeing forever.
    var maxDay = new Date(year, month, 0).getDate();
    if (day > maxDay) day = maxDay;

    return padZero(day) + "/" + padZero(month) + "/" + year;
}

// --- Defaults ---
export function makeDefaultData() {
    return {
        time: null,   // seeded by TimelineEngine.seedInitialTime() / genesis fallback on first init
        date: getRandomDate(), // TimelineEngine only ever determines TIME from prose, never a calendar date
        location: "Unknown",
        city: "Unknown", country: "Unknown",
        temperature: "Unknown", weather: "Unknown",
        characters: [], recent_events: "Story just started.",
        history: [], _initialized: false, _msgCount: 0, _relMsgCount: 0, _historyCount: 0,
        _lastCountedMsgId: -1,
        autoUpdate: Store.settings ? Store.settings.autoUpdate : true,
        _passiveAccumMinutes: 0, // legacy field, no longer written to; left for old saves
        _timeEpoch: null
    };
}

export function makeDefaultWorldData() {
    return {
        enabled: false,
        lastTickHour: 0,
        lastTickDay: 0,
        lastTickTime: "",
        lastTickDate: "",
        worldEvents: [],
        regions: [],
        npcStates: [],
        pendingReveals: [],
        worldSummary: "",
        weatherTrend: "",
        locationCodex: {},
        _initialized: false,
        _schedulerAccumulated: { scene: 0, npc: 0, weather: 0, faction: 0, world: 0 },
        _eventQueue: []
    };
}

export function makeDefaultRelationshipData() {
    return {
        nodes: [],
        edges: [],
        _initialized: false,
        _view: null
    };
}

// --- Settings load/save ---
export function loadSettings(defaultSettings) {
    var settings = Object.assign({}, defaultSettings);
    if (Store.extSettings) {
        if (!Store.extSettings[MODULE]) Store.extSettings[MODULE] = {};
        Object.assign(settings, Object.assign({}, settings, Store.extSettings[MODULE]));
        Store.extSettings[MODULE] = settings;
    }
    Store.setSettings(settings);
    return settings;
}

export function save() {
    if (typeof Store.saveFn === "function") return Store.saveFn();
    if (Store.scriptModule && typeof Store.scriptModule.saveSettingsDebounced === "function") {
        return Store.scriptModule.saveSettingsDebounced();
    }
}

// --- Name resolution shims (real logic lives in RelationshipAgent.js) ---

/**
 * resolveCanonicalName(name)
 * Thin, save-aware wrapper around RelationshipAgent.resolveCanonicalName — applies
 * the (possibly-upgraded) nodes array back onto relationshipData. Kept as a same-
 * signature drop-in for the many existing call sites (doRelationshipUpdate, the
 * manual relationship-edit panel) that expect "pass a name, get a canonical name
 * back" without having to thread relationshipData.nodes through themselves.
 */
export function resolveCanonicalName(name) {
    if (!name || !Store.RelationshipAgent || !Store.relationshipData) return name;
    var result = Store.RelationshipAgent.resolveCanonicalName(Store.relationshipData.nodes, name);
    Store.relationshipData.nodes = result.nodes;
    return result.name;
}

/** dedupeRelationshipNodes() — see RelationshipAgent.dedupeNodes for the actual logic. */
export function dedupeRelationshipNodes() {
    if (!Store.relationshipData || !Store.RelationshipAgent) return;
    var before = Store.relationshipData.nodes || [];
    var result = Store.RelationshipAgent.dedupeNodes(before, Store.relationshipData.edges || []);
    if (result.nodes === before) return; // no-op, nothing merged
    Store.relationshipData.nodes = result.nodes;
    Store.relationshipData.edges = result.edges;
    console.log("[Story Tracker] Deduplicated relationship nodes: " + before.length + " -> " + result.nodes.length);
    saveRelationshipDataDirect();
}

// --- Per-chat data load/save ---

export function loadStoryData() {
    var settings = Store.settings;
    if (!Store.isChatOpen()) {
        Store.setStoryData(null);
        Store.setWorldData(null);
        return;
    }
    var meta = Store.scriptModule ? Store.scriptModule.chat_metadata : null;
    var stored = (meta && meta[DATA_KEY]) ? meta[DATA_KEY] : null;
    var storyData;
    if (stored) {
        storyData = stored;
        Store.setMsgCounter(storyData._msgCount || 0);
        Store.setRelMsgCounter(storyData._relMsgCount || 0);
        if (!storyData.history) storyData.history = [];
        if (storyData.autoUpdate === undefined) storyData.autoUpdate = settings.autoUpdate;
        if (storyData._passiveAccumMinutes === undefined) storyData._passiveAccumMinutes = 0;
        if (typeof storyData._timeEpoch !== "number" || isNaN(storyData._timeEpoch)) {
            // Old save predating this field — reconstruct from the display strings (can't be
            // more precise than "HH:MM", but every call after this carries fractional
            // progress correctly from here on).
            var backfillDate = Store.TimelineEngine ? Store.TimelineEngine.parseDateTime(storyData.time, storyData.date) : null;
            storyData._timeEpoch = backfillDate ? backfillDate.getTime() : null;
        }

        if (typeof storyData._lastCountedMsgId !== "number") {
            var liveChat = Store.getLiveChat();
            storyData._lastCountedMsgId = (liveChat && liveChat.length) ? liveChat.length - 1 : -1;
        }
        Store.setLastCountedMsgId(storyData._lastCountedMsgId);

        if (typeof storyData._lastTimelineMsgId !== "number") {
            storyData._lastTimelineMsgId = storyData._lastCountedMsgId;
        }
        Store.setLastTimelineMsgId(storyData._lastTimelineMsgId);
    } else {
        storyData = makeDefaultData();
        // --- Genesis seeding --- TimelineEngine can only ADVANCE time from a known baseline,
        // so the very first time is seeded here, once, from whatever the opening text implies.
        if (Store.TimelineEngine) {
            var liveChatForGenesis = Store.getLiveChat() || [];
            var introText = liveChatForGenesis.slice(0, 3).map(function(m) { return m && m.mes ? m.mes : ""; }).join("\n");
            var genesis = Store.TimelineEngine.seedInitialTime(introText);
            storyData.time = genesis ? genesis.time : "12:00";
            if (genesis) console.log("[Story Tracker] Genesis time seeded from opening text: " + genesis.time + " (" + genesis.reason + ")");
            var genesisDate = Store.TimelineEngine.parseDateTime(storyData.time, storyData.date);
            storyData._timeEpoch = genesisDate ? genesisDate.getTime() : null;
        } else {
            storyData.time = "12:00"; // TimelineEngine not loaded yet — safe neutral fallback
        }
        if (meta) meta[DATA_KEY] = storyData;
        Store.setMsgCounter(0);
        Store.setLastCountedMsgId(storyData._lastCountedMsgId);
    }
    Store.setStoryData(storyData);
    loadWorldData();
    loadRelationshipData();
}

export function loadWorldData() {
    if (!Store.isChatOpen()) { Store.setWorldData(null); return; }
    var meta = Store.scriptModule ? Store.scriptModule.chat_metadata : null;
    var stored = (meta && meta[WORLD_KEY]) ? meta[WORLD_KEY] : null;
    var worldData;
    if (stored) {
        worldData = stored;
        if (!worldData.worldEvents) worldData.worldEvents = [];
        if (!worldData.regions) worldData.regions = [];
        if (!worldData.npcStates) worldData.npcStates = [];
        if (!worldData.pendingReveals) worldData.pendingReveals = [];
        if (worldData.weatherTrend === undefined) worldData.weatherTrend = "";
        if (!worldData.locationCodex) worldData.locationCodex = {};
        if (!worldData._schedulerAccumulated) worldData._schedulerAccumulated = { scene: 0, npc: 0, weather: 0, faction: 0, world: 0 };
        if (!worldData._eventQueue) worldData._eventQueue = [];
    } else {
        worldData = makeDefaultWorldData();
        if (meta) meta[WORLD_KEY] = worldData;
    }
    Store.setWorldData(worldData);
}

export function loadRelationshipData() {
    if (!Store.isChatOpen()) { Store.setRelationshipData(null); return; }
    var meta = Store.scriptModule ? Store.scriptModule.chat_metadata : null;
    var stored = (meta && meta[RELATIONSHIP_KEY]) ? meta[RELATIONSHIP_KEY] : null;
    var relationshipData;
    if (stored) {
        relationshipData = stored;
        if (!relationshipData.nodes) relationshipData.nodes = [];
        if (!relationshipData.edges) relationshipData.edges = [];
        Store.setRelationshipData(relationshipData);
        dedupeRelationshipNodes();
    } else {
        relationshipData = makeDefaultRelationshipData();
        if (meta) meta[RELATIONSHIP_KEY] = relationshipData;
        Store.setRelationshipData(relationshipData);
    }
}

export function saveStoryData() {
    var storyData = Store.storyData;
    // storyData can legitimately be null here if a generation finishes before any
    // CHAT_CHANGED/loadStoryData has run this session (init race) — bail instead
    // of throwing on `storyData._msgCount = ...` below.
    if (!storyData || !Store.isChatOpen() || !Store.scriptModule || !Store.scriptModule.chat_metadata) return;
    storyData._msgCount = Store.msgCounter;
    storyData._relMsgCount = Store.relMsgCounter;
    storyData._lastCountedMsgId = Store.lastCountedMsgId;
    storyData._lastTimelineMsgId = Store.lastTimelineMsgId;
    Store.scriptModule.chat_metadata[DATA_KEY] = storyData;
    if (typeof Store.saveMetaFn === "function") {
        Store.saveMetaFn();
    } else if (typeof Store.scriptModule.saveMetadataDebounced === "function") {
        Store.scriptModule.saveMetadataDebounced();
    }
}

export function saveWorldData() {
    if (!Store.isChatOpen() || !Store.scriptModule || !Store.scriptModule.chat_metadata) return;
    Store.scriptModule.chat_metadata[WORLD_KEY] = Store.worldData;
    if (typeof Store.saveMetaFn === "function") {
        Store.saveMetaFn();
    } else if (typeof Store.scriptModule.saveMetadataDebounced === "function") {
        Store.scriptModule.saveMetadataDebounced();
    }
}

export function saveRelationshipData() {
    if (!Store.isChatOpen() || !Store.scriptModule || !Store.scriptModule.chat_metadata) return;
    Store.scriptModule.chat_metadata[RELATIONSHIP_KEY] = Store.relationshipData;
    if (typeof Store.saveMetaFn === "function") {
        Store.saveMetaFn();
    } else if (typeof Store.scriptModule.saveMetadataDebounced === "function") {
        Store.scriptModule.saveMetadataDebounced();
    }
}

/** Internal: same write as saveRelationshipData, but for the two shims above which run
 * mid-pipeline (a chat is already guaranteed open by the time they're called) and don't
 * have an isChatOpen check handy. */
function saveRelationshipDataDirect() {
    if (!Store.scriptModule || !Store.scriptModule.chat_metadata) return;
    Store.scriptModule.chat_metadata[RELATIONSHIP_KEY] = Store.relationshipData;
    if (typeof Store.saveMetaFn === "function") {
        Store.saveMetaFn();
    } else if (typeof Store.scriptModule.saveMetadataDebounced === "function") {
        Store.scriptModule.saveMetadataDebounced();
    }
}

/**
 * parseRpDateTime(timeStr, dateStr)
 * Delegates to TimelineEngine.parseDateTime — the SAME parser EventQueue/Scheduler use
 * to decide when scheduled events resolve — so HUD previews, ETA countdowns, and
 * world-tier context text can never silently disagree with the real clock logic.
 */
export function parseRpDateTime(timeStr, dateStr) {
    if (Store.TimelineEngine && typeof Store.TimelineEngine.parseDateTime === "function") {
        return Store.TimelineEngine.parseDateTime(timeStr, dateStr);
    }
    if (!timeStr || !dateStr || timeStr === "--:--" || dateStr === "Unknown") return null;
    var tParts = timeStr.split(":");
    if (tParts.length < 2) return null;
    var hour = parseInt(tParts[0], 10);
    var min = parseInt(tParts[1], 10);
    if (isNaN(hour) || isNaN(min)) return null;
    var dParts = dateStr.split(/[/\-.,]/).map(function(s) { return s.trim(); }).filter(Boolean);
    if (dParts.length < 3) return null;
    var day = parseInt(dParts[0], 10);
    var month = parseInt(dParts[1], 10);
    var year = parseInt(dParts[2], 10);
    if (isNaN(day) || isNaN(month) || isNaN(year)) return null;
    var d = new Date(year, month - 1, day, hour, min, 0, 0);
    return isNaN(d.getTime()) ? null : d;
}
