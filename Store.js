/*
 * Store.js
 * ---------------------------------------------------------------------------
 * Shared mutable state for the extension, split out of index.js so the other
 * modules (Persistence, ProfileSession, Pipeline, HUD, and index.js itself)
 * can all see the SAME live data instead of index.js being the only place
 * that's allowed to touch it.
 *
 * WHY THIS EXISTS: index.js is loaded by SillyTavern as a classic (non-module)
 * script — see its own file header — while every file below is a real ES
 * module loaded via dynamic `import()`, same as TimelineEngine/Scheduler/
 * EventQueue/SceneAgent/WorldAgent/RelationshipAgent already were before this
 * split. ES modules don't share a classic script's global `var` scope, so the
 * old approach of "every function just closes over a top-level var" stops
 * working the moment logic moves into a separate module file.
 *
 * ES modules DO support "live bindings" though: if this file does
 * `export let storyData = null`, any other module that does
 * `import { storyData } from "./Store.js"` always sees the CURRENT value,
 * automatically, no re-import needed — as long as every WRITE goes through
 * one of the setter functions below rather than trying to assign the
 * imported name directly (that's illegal — imported bindings are read-only
 * views from the importer's side). That's the one rule every other module
 * in this split follows: read `Store.xxx` (or a destructured `{ xxx }`)
 * freely, but always write through `Store.setXxx(...)`.
 *
 * This module holds ONLY the state itself — no business logic. Persistence.js
 * decides how storyData/worldData/relationshipData get loaded and saved,
 * Pipeline.js decides when busy/worldBusy/relsBusy flip, etc. Store.js just
 * gives them all one shared place to do it.
 * ---------------------------------------------------------------------------
 */

// --- ST/module handles, set once during bootstrap (see index.js) ---
export let extSettings = null;
export let saveFn = null;
export let saveMetaFn = null;
export let scriptModule = null;
export let genRaw = null;
export let runSlash = null;

export function setBootstrap(vals) {
    if ("extSettings" in vals) extSettings = vals.extSettings;
    if ("saveFn" in vals) saveFn = vals.saveFn;
    if ("saveMetaFn" in vals) saveMetaFn = vals.saveMetaFn;
    if ("scriptModule" in vals) scriptModule = vals.scriptModule;
    if ("genRaw" in vals) genRaw = vals.genRaw;
    if ("runSlash" in vals) runSlash = vals.runSlash;
}

/** True if a real chat (solo or group) is actually open right now. Every tracker
 * entry point checks this before touching storage or firing an LLM call. */
export function isChatOpen() {
    try {
        var context = (typeof SillyTavern !== "undefined" && typeof SillyTavern.getContext === "function")
            ? SillyTavern.getContext()
            : null;
        var chat = (context && context.chat) ? context.chat : (scriptModule ? scriptModule.chat : null);
        var chatId = (context && context.chatId) ? context.chatId : (scriptModule ? scriptModule.chatId : null);
        var charId = (context && context.characterId !== undefined) ? context.characterId : (scriptModule ? scriptModule.this_chid : null);
        var groupId = (context && context.groupId !== undefined) ? context.groupId : (scriptModule ? scriptModule.groupId : null);

        if (!chat || chat.length === 0 || !chatId) return false;
        if (charId === null && groupId === null) return false;
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * Identifies WHICH chat is currently open (chat file name for solo chats, group
 * chat id for groups) — the guard every async tracker path checks after each
 * `await` boundary. Store.storyData/worldData and ST's chat_metadata are all
 * LIVE bindings that CHAT_CHANGED swaps mid-flight, so an in-flight LLM call
 * that resumes after a chat switch would otherwise write the previous chat's
 * analysis into the newly opened chat. isChatOpen() alone can't catch that —
 * it only says A chat is open, not the SAME one.
 */
export function getCurrentChatId() {
    try {
        var context = (typeof SillyTavern !== "undefined" && typeof SillyTavern.getContext === "function")
            ? SillyTavern.getContext()
            : null;
        if (context && context.chatId !== undefined && context.chatId !== null) return context.chatId;
        return scriptModule ? (scriptModule.chatId !== undefined ? scriptModule.chatId : null) : null;
    } catch (e) {
        return null;
    }
}

/** Resolves the live chat array the same resilient way isChatOpen() does. */
export function getLiveChat() {
    try {
        var context = (typeof SillyTavern !== "undefined" && typeof SillyTavern.getContext === "function")
            ? SillyTavern.getContext()
            : null;
        return (context && context.chat) ? context.chat : (scriptModule ? scriptModule.chat : null);
    } catch (e) {
        return null;
    }
}

// --- Dynamically-loaded pure/agent modules (see index.js's init) ---
export let TimelineEngine = null;
export let Scheduler = null;
export let EventQueue = null;
export let SceneAgent = null;
export let WorldAgent = null;
export let RelationshipAgent = null;

export function setAgentModules(vals) {
    TimelineEngine = vals.TimelineEngine;
    Scheduler = vals.Scheduler;
    EventQueue = vals.EventQueue;
    SceneAgent = vals.SceneAgent;
    WorldAgent = vals.WorldAgent;
    RelationshipAgent = vals.RelationshipAgent;
}

// --- Settings (persisted via extSettings[MODULE], see Persistence.js) ---
export let settings = null;
export function setSettings(v) { settings = v; }

// --- Per-chat data (persisted via chat_metadata, see Persistence.js) ---
export let storyData = null;
export let worldData = null;
export let relationshipData = null;
export function setStoryData(v) { storyData = v; }
export function setWorldData(v) { worldData = v; }
export function setRelationshipData(v) { relationshipData = v; }

// --- Relationship-graph UI selection state (survives re-render) ---
export let relEditingNode = null;
export let relSelectedNode = null;
export function setRelEditingNode(v) { relEditingNode = v; }
export function setRelSelectedNode(v) { relSelectedNode = v; }

// --- Message-counting / dedupe state ---
// (msgCounter and lastTimelineMsgId used to live here too — both were write-only
// leftovers of the pre-rewrite pipeline, fully replaced by storyData's
// _timeModeMsgCounter and _lastCountedMsgId, so they were removed rather than
// kept as dead state that still got persisted into every chat's save blob.)
export let lastCountedMsgId = -1;
export let relMsgCounter = 0;
export function setLastCountedMsgId(v) { lastCountedMsgId = v; }
export function setRelMsgCounter(v) { relMsgCounter = v; }

// --- Concurrency locks ---
export let busy = false;       // scene tracker lock
export let worldBusy = false;  // world agent lock (covers all 4 tiers)
export let relsBusy = false;   // relationship tracker lock
export function setBusy(v) { busy = v; }
export function setWorldBusy(v) { worldBusy = v; }
export function setRelsBusy(v) { relsBusy = v; }
export function anyBusy() { return busy || worldBusy || relsBusy; }

// --- Cross-tracker connection-profile session (see ProfileSession.js) ---
export let trackerProfileSession = null; // { original, current } while a session is open; null otherwise
export function setTrackerProfileSession(v) { trackerProfileSession = v; }
