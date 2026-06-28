/*
 * Story Tracker — SillyTavern Extension
 * Keeps track of Time, Date, Location, Character Positions, and Recent Events.
 * Reduces amnesia by injecting scene context into LLM prompts.
 * Includes World Progression Agent subsystem.
 */

var MODULE = "story-tracker";
var DATA_KEY = "story_tracker_data";
var WORLD_KEY = "story_world_data";
var RELATIONSHIP_KEY = "story_relationship_data";

// Helper to reliably sanitize and extract JSON from model responses containing thought or formatting tags
function cleanAndParseJSON(rawStr) {
    if (!rawStr || typeof rawStr !== "string") return null;
    let str = rawStr.trim();
    
    // Remove custom CoT structures (e.g. <|channel>thought ... <channel|>)
    str = str.replace(/<\|channel>thought[\s\S]*?<channel\|>/gi, "");
    str = str.replace(/<channel[\s\S]*?channel>/gi, "");
    str = str.replace(/<[^>]+thought[\s\S]*?>[\s\S]*?<\/[^>]+>/gi, "");
    
    // Strip standard markdown blocks
    str = str.replace(/```json\s*([\s\S]*?)\s*```/gi, "$1");
    str = str.replace(/```\s*([\s\S]*?)\s*```/gi, "$1");
    
    try {
        return JSON.parse(str.trim());
    } catch (e) {
        var m = str.match(/\{[\s\S]*\}/);
        if (m) {
            try {
                return JSON.parse(m[0]);
            } catch (ex) {
                return null;
            }
        }
    }
    return null;
}

// --- Prompts ---
var UPDATE_PROMPT = 
    "[OOC: You are a narrative assistant. Analyze the roleplay chat so far and determine the current scene context.\n\n" +
    "1. TIMELINE & LOCATION: Deduce the current Time (HH:MM), Date (DD/MM/YYYY or similar format), specific Location, current Temperature (e.g. '18°C' or '64°F'), and Weather conditions (e.g. 'Clear', 'Rainy', 'Overcast', 'Snowing', 'Stormy', 'Hot', 'Foggy'). If indoors or weather is unspecified, infer from context or write 'Unknown'. Time MUST progress logically based on recent actions.\n" +
    "2. CITY & COUNTRY — MANDATORY, NEVER USE 'Unknown': You MUST always fill both 'city' and 'country' fields with a real or invented name. Rules:\n" +
    "   - Real-world setting → use the actual city and country (e.g. 'Paris' / 'France').\n" +
    "   - Fantasy / sci-fi / fictional world → INVENT fitting names based on the story tone, character names, culture, architecture, language style. Be creative and specific (e.g. 'Myrenveld' / 'Sovereign Realms of Drak'hara').\n" +
    "   - Known fictional universe (Westeros, Middle-earth, etc.) → use canonical place names.\n" +
    "   - Setting is ambiguous or unspecified → make your BEST GUESS or freely invent. 'Unknown' is NOT an acceptable value under any circumstances.\n" +
    "3. CHARACTER POSITIONS: List every character present in the current scene (including {{user}} the player). Use the player's actual name as it appears in the chat - NOT the word 'User'. State exactly where they are and what their physical posture/action is right now.\n" +
    "4. RECENT EVENTS: Write a brief, factual 1-2 sentence summary of what just changed or happened in the last few messages. Use the player's actual name, not 'User'.\n\n" +
    "{{PREVIOUS_STATE}}\n\n" +
    "Respond ONLY with valid JSON in the story's language. IMPORTANT: In the characters array, use the player's actual name from the chat - never write 'User'. Use this exact structure (city and country MUST be non-empty strings, never 'Unknown'):\n" +
    "{\"time\":\"14:30\", \"date\":\"15/06/2024\", \"location\":\"Living room\", \"city\":\"Myrenveld\", \"country\":\"Sovereign Realms of Drak'hara\", \"temperature\":\"18°C\", \"weather\":\"Cloudy\", \"characters\":[{\"name\":\"Jepp\", \"state\":\"sitting on floor\"}, {\"name\":\"Char1\", \"state\":\"standing near Jepp\"}], \"recent_events\":\"Char1 entered the living room and spoke to Jepp.\"}\n" +
    "]";

// Fallback prompt — used when city/country is still unknown after main update
var CITY_COUNTRY_PROMPT =
    "[OOC: Based on the roleplay chat so far, determine the city/settlement and country/realm of the current scene.\n\n" +
    "Current known location: {{LOCATION}}\n\n" +
    "Rules (STRICTLY FOLLOW):\n" +
    "- If this is a real-world setting: provide the actual city and country.\n" +
    "- If this is a fantasy, sci-fi, or fictional world: INVENT a creative, fitting city name and realm/country name that matches the story's tone, culture, and character names. Be specific — never use generic placeholders.\n" +
    "- If you recognize a known fictional universe (Westeros, Middle-earth, Star Wars, etc.): use canonical place names.\n" +
    "- 'Unknown' is FORBIDDEN. You MUST always output a real or invented name.\n\n" +
    "Respond ONLY with valid JSON: {\"city\": \"CityName\", \"country\": \"CountryOrRealm\"}\n" +
    "]";

// World Progression simulation prompt
var WORLD_PROMPT = 
    "[OOC: You are the World Progression Agent simulation engine. Analyze the current story context and simulate what has happened offscreen during this time period.\n\n" +
    "CURRENT SCENE DETAILS:\n" +
    "- Current Time: {{CURRENT_TIME}}\n" +
    "- Current Date: {{CURRENT_DATE}}\n" +
    "- Current Location: {{CURRENT_LOCATION}}\n" +
    "- Recent Events: {{RECENT_EVENTS}}\n\n" +
    "RECENTLY INTERACTED NPCs (characters the user has directly encountered in recent scenes — PRIORITIZE these in your npc_updates):\n" +
    "{{INTERACTED_NPCS}}\n\n" +
    "PAST HISTORY TIMELINE (Recorded chronology of the story's progression):\n" +
    "{{PAST_HISTORY_TIMELINE}}\n\n" +
    "RECENT CHAT HISTORY (LAST 10 MESSAGES — use this to understand the RP's current narrative thread):\n" +
    "{{RECENT_CHAT_HISTORY}}\n\n" +
    "WORLD SUMMARY BEFORE THIS TICK:\n" +
    "{{WORLD_SUMMARY}}\n\n" +
    "NPC STATES BEFORE THIS TICK:\n" +
    "{{NPC_STATES}}\n\n" +
    "PENDING REVEALS BEFORE THIS TICK:\n" +
    "{{PENDING_REVEALS}}\n\n" +
    "Simulate what happens in the wider world outside the active scene during this period. Follow these STRICT guidelines:\n" +
    "1. DO NOT narrate the ongoing scene, write dialogue, or speak as {{user}} or current active characters.\n" +
    "2. Focus entirely on offscreen events, faction movements, weather developments, offscreen NPC actions, or logical background consequences of the main story.\n" +
    "3. FOLLOW THE RP NARRATIVE: Your world updates must feel organically connected to the actual story thread shown in the Recent Chat History. If the characters are in a tavern talking to a merchant, the world tick should reflect that context (e.g., what is that merchant's guild doing, what rumors are circulating, what other patrons overheard). Do not generate random unrelated global events.\n" +
    "4. PRIORITIZE INTERACTED NPCs: For every NPC listed in the 'RECENTLY INTERACTED NPCs' section, you MUST include an npc_update entry describing what they are doing offscreen after their last interaction. These updates should feel like natural continuations of the conversation or event that occurred.\n" +
    "5. PRIORITIZE the existing World Summary, offscreen NPC States, and Pending Reveals as the primary baseline. Advance these background states logically based on the passage of time and the events/consequences of the Recent Chat History.\n" +
    "6. Check the provided PAST HISTORY TIMELINE to align your simulated offscreen events with those exact timestamps. For each event in the 'events' array, you must provide a 'time' and 'date' field matching one of the timestamps from the history timeline or logically fitting within it.\n" +
    "7. PROSE STYLE GUIDELINE: Write in a grounded, chronicle-like historical voice. Avoid flowery adjectives. Keep statements physically observable and logically consistent. Focus on strategy, logistics, movements, and faction developments.\n" +
    "8. REALISTIC PACING & TRAVEL TIME: Do not rush or compress time. If a character leaves a scene or moves between locations offscreen, enforce realistic physical transit times. News and messengers travel at realistic speed.\n" +
    "9. NO CHRONOLOGICAL COMPRESSION: Multiple events in the 'events' array must represent parallel offscreen developments in different areas, NOT sequential steps of a single action chain.\n" +
    "10. STRICT TIME VALIDATION: In the 'events' array, the 'time' field MUST be a valid 24-hour time format (HH:MM). Minutes (MM) MUST strictly be between '00' and '59'. If unsure, use the tick's current time ({{CURRENT_TIME}}) directly.\n" +
    "11. Provide the result strictly as a valid JSON object matching the requested schema.\n\n" +
    "Respond ONLY with valid JSON using this format:\n" +
    "{\n" +
    "  \"summary\": \"A short, updated synthesis of the overall world state outside the immediate scene. Reference specific story elements from the recent chat.\",\n" +
    "  \"events\": [\n" +
    "    { \"event\": \"Describe offscreen event details\", \"importance\": 5, \"time\": \"HH:MM\", \"date\": \"DD/MM/YYYY\" }\n" +
    "  ],\n" +
    "  \"npc_updates\": [\n" +
    "    { \"name\": \"NPC name\", \"change\": \"What this NPC is doing offscreen after their last interaction — must feel like a natural continuation\" }\n" +
    "  ],\n" +
    "  \"pending_reveals\": [\"A secret or rumor connected to recent story events that is developing but not yet known to the main characters\"]\n" +
    "}\n" +
    "]";

// Relationship Dynamics Tracker prompt — runs after world tick (or manually)
var RELATIONSHIP_PROMPT =
    "[OOC: You are a Relationship Dynamics Tracker for a roleplay narrative. Analyze the recent chat and extract character relationship data.\n\n" +
    "CHARACTERS CURRENTLY IN SCENE:\n{{SCENE_CHARACTERS}}\n\n" +
    "EXISTING TRACKED RELATIONSHIPS (evolve these — do NOT replace stable ones without evidence):\n{{EXISTING_RELATIONSHIPS}}\n\n" +
    "RECENT CHAT HISTORY (LAST 15 MESSAGES — identify relationship interactions here):\n{{RECENT_CHAT}}\n\n" +
    "Instructions:\n" +
    "1. Identify all meaningful relationships between named characters evidenced in the recent chat.\n" +
    "2. For each pair that interacts or is referenced, determine the relationship type and current emotional strength.\n" +
    "3. If a relationship already exists in the baseline, UPDATE its strength and summary based on new evidence — show evolution.\n" +
    "4. Only include pairs with meaningful narrative evidence. Do NOT invent connections not shown in the text.\n" +
    "5. 'strength' is a decimal from -1.0 (completely hostile/broken) to 1.0 (deeply bonded/loving). 0.0 = neutral.\n" +
    "6. 'type' must be exactly one of: romance, friendship, family, alliance, rivalry, hostile, mentor, neutral.\n" +
    "7. 'change' should be a single concise sentence describing what CHANGED, or 'Stable' if unchanged.\n" +
    "8. Always use the exact character names as they appear in the chat (case-sensitive).\n\n" +
    "Respond ONLY with valid JSON (no markdown, no preamble):\n" +
    "{\n" +
    "  \"relationships\": [\n" +
    "    { \"from\": \"CharA\", \"to\": \"CharB\", \"type\": \"friendship\", \"strength\": 0.6, \"summary\": \"Brief description of their current dynamic\", \"change\": \"What changed or Stable\" }\n" +
    "  ]\n" +
    "}\n" +
    "]";

// --- State Variables ---
var settings = {
    enabled: true,
    showHUD: true,
    hudScale: 100,            
    showChatButton: true,
    autoUpdate: true,
    autoUpdateInterval: 3,
    injectToContext: true,
    showHistory: true,
    showCityCountry: false,
    useConnectionProfile: false, 
    connectionProfile: "",       
    _restoreProfile: "",
    _restoreWorldProfile: "",
    hudLeft: null,            // Saved HUD position — raw CSS pixels (null = use stylesheet default)
    hudTop:  null,

    // Custom Color Settings (Warm gold/amber default matching the image mockup)
    accentR: 216,
    accentG: 160,
    accentB: 64,

    // World Agent Settings
    worldEnabled: false,
    useWorldProfile: false,
    worldConnectionProfile: "",
    worldTickFrequency: "1h", // "1h", "3h", "1d", "manual"
    maxWorldTicks: 6,
    injectWorldContext: false,

    // Relationship Tracker Settings
    relationsEnabled: false,
    relationsAutoUpdate: true,
    relAutoInterval: 5,
    startupDelay: 2000,
    useRelProfile: false,
    relConnectionProfile: "",
    _restoreRelProfile: "",
    injectRelationsContext: false
};
var extSettings = null, saveFn = null, saveMetaFn = null, scriptModule = null, genRaw = null;
var runSlash = null; 
var storyData = null; 
var worldData = null;
var relationshipData = null;
var msgCounter = 0;
var lastCountedMsgId = -1; // highest chat message ID counted so far (drives the "no swipes/regens/dupes" filter)
var busy = false;       // scene tracker lock
var worldBusy = false;  // world agent lock
var relsBusy = false;   // relationship tracker lock
var relMsgCounter = 0;  // counts messages since last relationship checkpoint

// Global lock - returns true if ANY agent is currently generating.
// Prevents concurrent API requests when multiple agents fire at once.
function anyBusy() { return busy || worldBusy || relsBusy; }

// --- Init ---
jQuery(async function () {
    try {
        var m = await import("../../../extensions.js");
        extSettings = m.extension_settings; 
        saveFn = m.saveSettingsDebounced;
        saveMetaFn = m.saveMetadataDebounced;
        
        scriptModule = await import("../../../../script.js");
        if (typeof scriptModule.generateRaw === "function") genRaw = scriptModule.generateRaw;

        try {
            var sc = await import("../../../slash-commands.js");
            if (typeof sc.executeSlashCommandsWithOptions === "function") runSlash = sc.executeSlashCommandsWithOptions;
        } catch (e) { console.warn("[Story Tracker] slash-commands.js not available, connection profile switching disabled.", e); }
        
        loadSettings();
        applyCustomAccentColor();
        
        buildModal();
        buildHUD();
        buildSettingsPanel();
        buildChatButton();
        bindEvents();
        registerStoryMacros();

        setTimeout(function () { recoverProfileIfNeeded(); }, 1500);

        // Clamping check on browser screen changes or rotations
        $(window).on("resize", function() {
            applyHudStyle();
        });

        console.log("[Story Tracker] Loaded!");
    } catch (e) { console.error("[Story Tracker] Init error:", e); }
});

// --- Active Chat Failsafe Check ---
function isChatOpen() {
    try {
        var context = (typeof SillyTavern !== "undefined" && typeof SillyTavern.getContext === "function") 
            ? SillyTavern.getContext() 
            : null;
        var chat = (context && context.chat) ? context.chat : (scriptModule ? scriptModule.chat : null);
        var chatId = (context && context.chatId) ? context.chatId : (scriptModule ? scriptModule.chatId : null);
        var charId = (context && context.characterId !== undefined) ? context.characterId : (scriptModule ? scriptModule.this_chid : null);
        var groupId = (context && context.groupId !== undefined) ? context.groupId : (scriptModule ? scriptModule.groupId : null);

        if (!chat || chat.length === 0 || !chatId) {
            return false;
        }
        if (charId === null && groupId === null) {
            return false;
        }
        return true;
    } catch (e) {
        return false;
    }
}

// Resolves the live chat array the same resilient way isChatOpen() does
function getLiveChat() {
    try {
        var context = (typeof SillyTavern !== "undefined" && typeof SillyTavern.getContext === "function")
            ? SillyTavern.getContext()
            : null;
        return (context && context.chat) ? context.chat : (scriptModule ? scriptModule.chat : null);
    } catch (e) {
        return null;
    }
}

// --- Data Management ---
function loadSettings() {
    if(extSettings) {
        if(!extSettings[MODULE]) extSettings[MODULE] = {};
        Object.assign(settings, Object.assign({}, settings, extSettings[MODULE]));
        extSettings[MODULE] = settings;
    }
}

function save() {
    // saveFn comes from extensions.js — if that module doesn't export saveSettingsDebounced
    // (it's normally on script.js), fall back to scriptModule which we always import.
    if (typeof saveFn === "function") return saveFn();
    if (scriptModule && typeof scriptModule.saveSettingsDebounced === "function") {
        return scriptModule.saveSettingsDebounced();
    }
}

function applyCustomAccentColor() {
    var r = (settings && settings.accentR !== undefined) ? settings.accentR : 216;
    var g = (settings && settings.accentG !== undefined) ? settings.accentG : 160;
    var b = (settings && settings.accentB !== undefined) ? settings.accentB : 64;
    
    document.documentElement.style.setProperty('--st-custom-accent', `rgb(${r}, ${g}, ${b})`);
    document.documentElement.style.setProperty('--st-custom-accent-alpha', `rgba(${r}, ${g}, ${b}, 0.12)`);
    document.documentElement.style.setProperty('--st-custom-accent-alpha-high', `rgba(${r}, ${g}, ${b}, 0.25)`);
    
    $("#st-rgb-preview").css("background-color", `rgb(${r}, ${g}, ${b})`);
}

function getRandomTime() {
    var h = Math.floor(Math.random() * 24);
    var m = Math.floor(Math.random() * 60);
    return padZero(h) + ":" + padZero(m);
}

// --- Time and Date Sanitization Helpers ---
function sanitizeTimeStr(timeStr, fallbackTimeStr) {
    if (typeof timeStr !== "string") return fallbackTimeStr || "12:00";
    timeStr = timeStr.trim();
    var m = timeStr.match(/^(\d{1,2})[:\.](\d{1,2})$/);
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

function sanitizeDateStr(dateStr, fallbackDateStr) {
    if (typeof dateStr !== "string") return fallbackDateStr || "01/01/2026";
    dateStr = dateStr.trim();
    var parts = dateStr.split(/[\/\-\.,]/).map(s => s.trim()).filter(Boolean);
    if (parts.length < 3) return fallbackDateStr || "01/01/2026";
    
    var day = parseInt(parts[0], 10);
    var month = parseInt(parts[1], 10);
    var year = parseInt(parts[2], 10);
    
    if (isNaN(day) || day < 1 || day > 31) day = 1;
    if (isNaN(month) || month < 1 || month > 12) month = 1;
    if (isNaN(year) || year < 1000) year = 2026;
    
    return padZero(day) + "/" + padZero(month) + "/" + year;
}

function getRandomDate() {
    // Generate a random date between Jan 1, 2020 and Dec 31, 2026
    var start = new Date(2020, 0, 1).getTime();
    var end = new Date(2026, 11, 31).getTime();
    var randomTime = start + Math.random() * (end - start);
    var d = new Date(randomTime);
    return padZero(d.getDate()) + "/" + padZero(d.getMonth() + 1) + "/" + d.getFullYear();
}

function makeDefaultData() {
    return {
        time: getRandomTime(), 
        date: getRandomDate(), 
        location: "Unknown",
        city: "Unknown", country: "Unknown",
        temperature: "Unknown", weather: "Unknown",
        characters: [], recent_events: "Story just started.",
        history: [], _initialized: false, _msgCount: 0, _relMsgCount: 0, _historyCount: 0,
        _lastCountedMsgId: -1, // no chat messages counted yet
        autoUpdate: settings.autoUpdate,
        autoUpdateInterval: settings.autoUpdateInterval
    };
}

function makeDefaultWorldData() {
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
        _initialized: false
    };
}

function makeDefaultRelationshipData() {
    return {
        nodes: [],   // { id, name }
        edges: [],   // { from, to, type, strength, summary, change, history: [{msg, summary, strength}] }
        _initialized: false
    };
}

function loadStoryData() {
    if (!isChatOpen()) {
        storyData = null;
        worldData = null;
        return;
    }
    var meta = scriptModule ? scriptModule.chat_metadata : null;
    var stored = (meta && meta[DATA_KEY]) ? meta[DATA_KEY] : null;
    if (stored) {
        storyData = stored;
        msgCounter = storyData._msgCount || 0;
        relMsgCounter = storyData._relMsgCount || 0;
        if (!storyData.history) storyData.history = [];
        if (storyData.autoUpdate === undefined) storyData.autoUpdate = settings.autoUpdate;
        if (storyData.autoUpdateInterval === undefined) storyData.autoUpdateInterval = settings.autoUpdateInterval;

        if (typeof storyData._lastCountedMsgId !== "number") {
            var liveChat = getLiveChat();
            storyData._lastCountedMsgId = (liveChat && liveChat.length) ? liveChat.length - 1 : -1;
        }
        lastCountedMsgId = storyData._lastCountedMsgId;
    } else {
        storyData = makeDefaultData();
        if (meta) meta[DATA_KEY] = storyData;
        msgCounter = 0;
        lastCountedMsgId = storyData._lastCountedMsgId;
    }
    loadWorldData();
    loadRelationshipData();
}

function loadWorldData() {
    if (!isChatOpen()) {
        worldData = null;
        return;
    }
    var meta = scriptModule ? scriptModule.chat_metadata : null;
    var stored = (meta && meta[WORLD_KEY]) ? meta[WORLD_KEY] : null;
    if (stored) {
        worldData = stored;
        if (!worldData.worldEvents) worldData.worldEvents = [];
        if (!worldData.regions) worldData.regions = [];
        if (!worldData.npcStates) worldData.npcStates = [];
        if (!worldData.pendingReveals) worldData.pendingReveals = [];
    } else {
        worldData = makeDefaultWorldData();
        if (meta) meta[WORLD_KEY] = worldData;
    }
}

function loadRelationshipData() {
    if (!isChatOpen()) { relationshipData = null; return; }
    var meta = scriptModule ? scriptModule.chat_metadata : null;
    var stored = (meta && meta[RELATIONSHIP_KEY]) ? meta[RELATIONSHIP_KEY] : null;
    if (stored) {
        relationshipData = stored;
        if (!relationshipData.nodes) relationshipData.nodes = [];
        if (!relationshipData.edges) relationshipData.edges = [];
    } else {
        relationshipData = makeDefaultRelationshipData();
        if (meta) meta[RELATIONSHIP_KEY] = relationshipData;
    }
}

function saveRelationshipData() {
    if (!isChatOpen() || !scriptModule || !scriptModule.chat_metadata) return;
    scriptModule.chat_metadata[RELATIONSHIP_KEY] = relationshipData;
    if (typeof saveMetaFn === "function") {
        saveMetaFn();
    } else if (typeof scriptModule.saveMetadataDebounced === "function") {
        scriptModule.saveMetadataDebounced();
    }
}

// --- Dynamic Viewport Border Calculations ---

// Measure safe-area-inset values by injecting a throwaway element
// (CSS custom properties don't resolve to numeric px in getComputedStyle on all engines)
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
            top:    rect.top,
            left:   rect.left,
            right:  parseFloat(getComputedStyle(el).width)  || 0,
            bottom: parseFloat(getComputedStyle(el).height) || 0
        };
        document.body.removeChild(el);
        return s;
    } catch(e) {
        return { top: 0, bottom: 0, left: 0, right: 0 };
    }
}

function clampHudPosition(x, y) {
    var $h = $("#st-hud");
    if (!$h.length) return { x: x, y: y };

    var hudWidth  = $h.outerWidth()  || 260;
    var hudHeight = $h.outerHeight() || 200;
    var safe      = getSafeAreaInsets();

    var margin = 10;
    var minX = Math.max(margin, safe.left   + margin);
    var minY = Math.max(margin, safe.top    + margin);
    var maxX = window.innerWidth  - hudWidth  - Math.max(margin, safe.right  + margin);
    var maxY = window.innerHeight - hudHeight - Math.max(margin, safe.bottom + margin);

    return {
        x: Math.max(minX, Math.min(x, maxX)),
        y: Math.max(minY, Math.min(y, maxY))
    };
}

function saveStoryData() {
    if (!isChatOpen() || !scriptModule || !scriptModule.chat_metadata) return;
    storyData._msgCount = msgCounter;
    storyData._relMsgCount = relMsgCounter;
    storyData._lastCountedMsgId = lastCountedMsgId;
    scriptModule.chat_metadata[DATA_KEY] = storyData;
    if (typeof saveMetaFn === "function") {
        saveMetaFn();
    } else if (typeof scriptModule.saveMetadataDebounced === "function") {
        scriptModule.saveMetadataDebounced();
    }
}

// Helper to logically parse dates using strict European formatting standard (DD/MM/YYYY) first
function parseRpDateTime(timeStr, dateStr) {
    if (!timeStr || !dateStr || timeStr === "--:--" || dateStr === "Unknown") return null;
    
    // Structured parsing fallbacks (strictly treat as DD/MM/YYYY first to prevent US format locale bias)
    var tParts = timeStr.split(":");
    if (tParts.length < 2) return null;
    var hour = parseInt(tParts[0], 10);
    var min = parseInt(tParts[1], 10);
    if (isNaN(hour) || isNaN(min)) return null;

    var dParts = dateStr.split(/[\/\-\.,]/).map(s => s.trim()).filter(Boolean);
    if (dParts.length >= 3) {
        var day = parseInt(dParts[0], 10);
        var month = parseInt(dParts[1], 10);
        var year = parseInt(dParts[2], 10);

        if (!isNaN(day) && !isNaN(month) && !isNaN(year)) {
            var d = new Date(year, month - 1, day, hour, min, 0, 0);
            if (!isNaN(d.getTime())) return d;
        }
    }
    
    // Try browser-native parser as a last resort
    var nativeParsed = new Date(dateStr + " " + timeStr);
    if (!isNaN(nativeParsed.getTime())) return nativeParsed;

    return null;
}

function saveWorldData() {
    if (!isChatOpen() || !scriptModule || !scriptModule.chat_metadata) return;
    scriptModule.chat_metadata[WORLD_KEY] = worldData;
    if (typeof saveMetaFn === "function") {
        saveMetaFn();
    } else if (typeof scriptModule.saveMetadataDebounced === "function") {
        scriptModule.saveMetadataDebounced();
    }
}

function populateProfileDropdown() {
    var profiles = getProfileList();

    // Context Analysis Profile
    var $sel = $("#st-s-profile");
    if ($sel.length) {
        var html = '<option value="">— Use current / main profile —</option>';
        if (profiles.length === 0) {
            html += '<option value="" disabled>(No profiles found — install/enable Connection Profiles)</option>';
        } else {
            profiles.forEach(function (p) {
                var name = p && p.name ? p.name : "";
                if (!name) return;
                html += '<option value="' + esc(name) + '">' + esc(name) + '</option>';
            });
        }
        $sel.html(html);
        var saved = settings.connectionProfile || "";
        if (saved && profiles.some(function (p) { return p.name === saved; })) {
            $sel.val(saved);
        } else if (saved && profiles.length > 0) {
            $sel.val("");
        }
    }

    // World Agent Profile
    var $selWorld = $("#st-s-world-profile");
    if ($selWorld.length) {
        var htmlWorld = '<option value="">— Use current / main profile —</option>';
        if (profiles.length === 0) {
            htmlWorld += '<option value="" disabled>(No profiles found)</option>';
        } else {
            profiles.forEach(function (p) {
                var name = p && p.name ? p.name : "";
                if (!name) return;
                htmlWorld += '<option value="' + esc(name) + '">' + esc(name) + '</option>';
            });
        }
        $selWorld.html(htmlWorld);
        var savedWorld = settings.worldConnectionProfile || "";
        if (savedWorld && profiles.some(function (p) { return p.name === savedWorld; })) {
            $selWorld.val(savedWorld);
        } else if (savedWorld && profiles.length > 0) {
            $selWorld.val("");
        }
    }

    // Relationship Tracker Profile
    var $selRel = $("#st-s-rel-profile");
    if ($selRel.length) {
        var htmlRel = '<option value="">- Use current / main profile -</option>';
        if (profiles.length === 0) {
            htmlRel += '<option value="" disabled>(No profiles found)</option>';
        } else {
            profiles.forEach(function (p) {
                var name = p && p.name ? p.name : "";
                if (!name) return;
                htmlRel += '<option value="' + esc(name) + '">' + esc(name) + '</option>';
            });
        }
        $selRel.html(htmlRel);
        var savedRel = settings.relConnectionProfile || "";
        if (savedRel && profiles.some(function (p) { return p.name === savedRel; })) {
            $selRel.val(savedRel);
        } else if (savedRel && profiles.length > 0) {
            $selRel.val("");
        }
    }
}

// --- Connection Profile Support ---
function getProfileList() {
    try {
        var cm = extSettings && extSettings.connectionManager;
        if (!cm || !Array.isArray(cm.profiles)) return [];
        return cm.profiles;
    } catch (e) { return []; }
}

function getCurrentProfileName() {
    try {
        var cm = extSettings && extSettings.connectionManager;
        if (!cm) return "";
        var sel = cm.selectedProfile;
        if (!sel) return "";
        var found = (cm.profiles || []).find(function (p) { return p.id === sel; });
        return found ? (found.name || "") : "";
    } catch (e) { return ""; }
}

function shouldSwitchProfile() {
    if (!settings.useConnectionProfile) return false;
    if (!runSlash) return false;                       
    var target = (settings.connectionProfile || "").trim();
    if (!target) return false;                         
    if (getProfileList().length === 0) return false;   
    var current = getCurrentProfileName();
    if (current && current === target) return false;   
    return true;
}

async function switchProfile(name) {
    if (!runSlash || !name) return false;
    try {
        await runSlash('/profile "' + String(name).replace(/"/g, '\\"') + '"');
        await new Promise(function (r) { setTimeout(r, 150); });
        return true;
    } catch (e) {
        console.warn("[Story Tracker] Failed to switch to profile '" + name + "':", e);
        return false;
    }
}

async function withConnectionProfile(task) {
    if (!shouldSwitchProfile()) {
        return await task();
    }
    var original = getCurrentProfileName();
    var target = (settings.connectionProfile || "").trim();
    var switched = false;
    try {
        switched = await switchProfile(target);
        if (!switched) console.warn("[Story Tracker] Profile switch failed; running analysis on current profile.");
        if (switched && original && original !== target) {
            settings._restoreProfile = original;
            save();
        }
        return await task();
    } finally {
        if (switched && original && original !== target) {
            await switchProfile(original);
        }
        if (settings._restoreProfile) { settings._restoreProfile = ""; save(); }
    }
}

async function withWorldConnectionProfile(task) {
    if (!settings.useWorldProfile || !runSlash) {
        return await task();
    }
    var original = getCurrentProfileName();
    var target = (settings.worldConnectionProfile || "").trim();
    var switched = false;
    try {
        switched = await switchProfile(target);
        if (!switched) console.warn("[Story Tracker] World Connection Profile switch failed; running simulation on current profile.");
        if (switched && original && original !== target) {
            settings._restoreWorldProfile = original;
            save();
        }
        return await task();
    } finally {
        if (switched && original && original !== target) {
            await switchProfile(original);
        }
        if (settings._restoreWorldProfile) { settings._restoreWorldProfile = ""; save(); }
    }
}

async function withRelConnectionProfile(task) {
    if (!settings.useRelProfile || !runSlash) {
        return await task();
    }
    var original = getCurrentProfileName();
    var target = (settings.relConnectionProfile || "").trim();
    var switched = false;
    try {
        switched = await switchProfile(target);
        if (!switched) console.warn("[Story Tracker] Relationship Connection Profile switch failed; running on current profile.");
        if (switched && original && original !== target) {
            settings._restoreRelProfile = original;
            save();
        }
        return await task();
    } finally {
        if (switched && original && original !== target) {
            await switchProfile(original);
        }
        if (settings._restoreRelProfile) { settings._restoreRelProfile = ""; save(); }
    }
}

async function recoverProfileIfNeeded() {
    var pending = settings._restoreProfile;
    if (pending && runSlash) {
        try {
            var current = getCurrentProfileName();
            if (current !== pending && getProfileList().some(function (p) { return p.name === pending; })) {
                console.log("[Story Tracker] Recovering interrupted profile switch → restoring '" + pending + "'.");
                await switchProfile(pending);
            }
        } catch (e) {
            console.warn("[Story Tracker] Profile recovery failed:", e);
        } finally {
            settings._restoreProfile = ""; save();
        }
    }

    var pendingRel = settings._restoreRelProfile;
    if (pendingRel && runSlash) {
        try {
            await switchProfile(pendingRel);
        } catch(e) { console.warn("[Story Tracker] Relationship profile recovery failed:", e); }
        settings._restoreRelProfile = ""; save();
    }

    var pendingWorld = settings._restoreWorldProfile;
    if (pendingWorld && runSlash) {
        try {
            var currentWorld = getCurrentProfileName();
            if (currentWorld !== pendingWorld && getProfileList().some(function (p) { return p.name === pendingWorld; })) {
                console.log("[Story Tracker] Recovering interrupted world profile switch → restoring '" + pendingWorld + "'.");
                await switchProfile(pendingWorld);
            }
        } catch (e) {
            console.warn("[Story Tracker] World profile recovery failed:", e);
        } finally {
            settings._restoreWorldProfile = ""; save();
        }
    }
}

// --- Prompts Context helpers ---
function buildPrevStateText() {
    if (!storyData) return "";
    let s = "";
    if (!storyData._initialized) {
        s = "This is the INITIAL setup. Use this suggested starting timeline as your baseline unless the intro message/context explicitly dictates otherwise:\n" +
            "Time: " + storyData.time + " | Date: " + storyData.date + "\n\n";
    } else {
        s = "PREVIOUS STATE:\nTime: " + storyData.time + " | Date: " + storyData.date + " | Location: " + storyData.location + "\n";
        s += "City: " + (storyData.city || "Unknown") + " | Country/Realm: " + (storyData.country || "Unknown") + "\n";
        s += "Temperature: " + (storyData.temperature || "Unknown") + " | Weather: " + (storyData.weather || "Unknown") + "\n";
        var outfit = getInventoryOutfit();
        if (outfit && outfit.userEquipped.length > 0) {
            var outfitStr = outfit.userEquipped.map(function(it) { return it.label + ": " + it.name; }).join(", ");
            s += "User's current outfit: " + outfitStr + "\n";
        }
        if (outfit && outfit.charItems.length > 0) {
            var charHeld = outfit.charItems.map(function(ci) { return ci.name + " (held by " + ci.heldBy + ")"; }).join(", ");
            s += "Items held by character: " + charHeld + "\n";
        }
    }

    return s + "(Update the time, check if location/weather changed, update character positions based on what they just did).";
}

// --- Sync to Character Tracker ---
function syncToCharTracker() {
    try {
        var meta = scriptModule ? scriptModule.chat_metadata : null;
        if (!meta) return;
        var ct = meta["char_tracker"];
        if (!ct) return; 

        var day = 1, month = 1, year = 2024;
        var parts = (storyData.date || "").split(/[\/\-\.]/);
        if (parts.length >= 3) {
            day   = parseInt(parts[0], 10) || 1;
            month = parseInt(parts[1], 10) || 1;
            year  = parseInt(parts[2], 10) || 2024;
        }

        var container = ct._isGroup ? ct : ct;
        if (!container.sharedTime) container.sharedTime = {};
        container.sharedTime.time  = storyData.time  || "--:--";
        container.sharedTime.day   = day;
        container.sharedTime.month = month;
        container.sharedTime.year  = year;
        container._timeInitialized = true;

        if (ct._isGroup) {
            var activeChar = ct._activeChar;
            if (activeChar && ct.characters && ct.characters[activeChar]) {
                ct.characters[activeChar].location = storyData.location;
            }
        } else {
            ct.location = storyData.location;
        }

        if (typeof saveMetaFn === "function")
            saveMetaFn();
        else if (typeof scriptModule.saveMetadataDebounced === "function")
            scriptModule.saveMetadataDebounced();

        console.log("[Story Tracker] Synced time/location → Character Tracker");
        $(document).trigger("CT_FORCE_RENDER");
    } catch(e) { console.error("[Story Tracker] syncToCharTracker error:", e); }
}

// --- Inventory Integration ---
var INV_SLOTS        = ["head","torso","legs","feet","hands","lefthand","righthand","accessory1","accessory2"];
var INV_SLOT_LABELS  = { head:"Head", torso:"Torso", legs:"Legs", feet:"Feet", hands:"Hands", lefthand:"Left Hand", righthand:"Right Hand", accessory1:"Accessory 1", accessory2:"Accessory 2" };
var INV_SLOT_ICONS  = { head:"🎩", torso:"👕", legs:"👖", feet:"👟", hands:"🧤", lefthand:"🤚", righthand:"右手", accessory1:"💍", accessory2:"💍" };

function getInventoryOutfit() {
    try {
        var meta = scriptModule ? scriptModule.chat_metadata : null;
        if (!meta) return null;
        var inv = meta["inv_data"];
        if (!inv || !inv.equipped) return null;

        var eq = inv.equipped;

        var userEquipped = [];
        for (var i = 0; i < INV_SLOTS.length; i++) {
            var sl = INV_SLOTS[i];
            var it = eq[sl];
            if (it && !it._mirror) {
                userEquipped.push({
                    slot:  sl,
                    label: INV_SLOT_LABELS[sl],
                    icon:  INV_SLOT_ICONS[sl],
                    name:  it.name || "?",
                    description: it.description || ""
                });
            }
        }

        var charItems = (inv.charItems || []).map(function(ci) {
            return { name: ci.name, heldBy: ci.heldBy || "Character" };
        });

        return { userEquipped: userEquipped, charItems: charItems };
    } catch (e) {
        console.error("[Story Tracker] getInventoryOutfit error:", e);
        return null;
    }
}

// --- Context Injection ---
function injectContextToChat() {
    if (!isChatOpen()) return;
    if (!settings.enabled) return;
    
    let sceneInj = "";
    if (settings.injectToContext && storyData && storyData._initialized) {
        let loc = storyData.location;
        let ev = storyData.recent_events;
        
        let charsText = "";
        if (storyData.characters && storyData.characters.length > 0) {
            charsText = storyData.characters.map(c => `${c.name}: ${c.state}`).join(" | ");
        }

        let cityCountryStr = "";
        if (settings.showCityCountry) {
            let city = storyData.city || "";
            let country = storyData.country || "";
            if (city && city !== "Unknown" || country && country !== "Unknown") {
                cityCountryStr = "\nCity: " + (city || "Unknown") + " | Country/Realm: " + (country || "Unknown");
            }
        }

        sceneInj = `[Scene Context: Time: ${storyData.time}, Date: ${storyData.date}\nLocation: ${loc}${cityCountryStr}\nTemperature: ${storyData.temperature || "Unknown"} | Weather: ${storyData.weather || "Unknown"}\nPositions: ${charsText}\nRecent: ${ev}`;

        var outfit = getInventoryOutfit();
        if (outfit && outfit.userEquipped.length > 0) {
            var outfitStr = outfit.userEquipped.map(function(it) { return it.label + ": " + it.name; }).join(", ");
            sceneInj += `\nUser's Outfit: ${outfitStr}`;
        }
        if (outfit && outfit.charItems.length > 0) {
            var charHeldStr = outfit.charItems.map(function(ci) { return ci.name + " (held by " + ci.heldBy + ")"; }).join(", ");
            sceneInj += `\nCharacter holds: ${charHeldStr}`;
        }
        sceneInj += `]`;
    }

    let worldInj = "";
    if (settings.injectWorldContext && worldData && worldData._initialized) {
        // Retrieve the last 3 important events (importance >= 4, falling back to any if none)
        let imp = worldData.worldEvents.filter(e => e.importance >= 4).slice(0, 3);
        if (imp.length === 0) imp = worldData.worldEvents.slice(0, 3);
        let eventsStr = imp.map(e => e.event).join("\n");
        let sum = worldData.worldSummary || "";
        
        worldInj = `<world_progression>\n` +
                   `The active context contains recent "World Progression" reports detailing background, off-screen macro events.\n\n` +
                   `  - Environmental Bleed-in: You are ENCOURAGED to reflect these macro shifts passively through the scenery, weather, atmospheric tension, or ambient background details if they logically affect the current district or theme.\n` +
                   `  - Hostile Initiative & Ambushed Scenes: If a report explicitly details a rival, faction, or antagonist plotting, executing a strike, or tracking {{user}}, you have full permission to be AGGRESSIVE. Do not wait for investigation. Let that hostile action violently collide with the current scene as an immediate consequence (e.g., an ambush, a sudden lockdown, an interception, or a direct threat manifesting).\n` +
                   `  - Organic Intersection: If a report event mentions a passive entity or location matching {{user}}'s immediate surroundings or active inventory, let that event alter the local environment (e.g., increased patrol density, systemic panic, visible structural changes).\n` +
                   `  - Asymmetric Knowledge Guardrail: Unless a hostile interception occurs, do NOT grant characters or {{user}} omniscient knowledge of these events. NPCs must not spontaneously discuss details they have no realistic way of knowing. Use the data strictly to dictate systemic consequences, hidden NPC positioning, and evolving motivations.\n\n` +
                   `[World State Reports]\n` +
                   `Summary: ${sum}\n` +
                   `Recent Developments:\n${eventsStr || "None."}\n` +
                   `</world_progression>`;
    }

    let finalInj = "";
    if (sceneInj) finalInj += sceneInj;
    if (worldInj) finalInj += (finalInj ? "\n" : "") + worldInj;

    // Relationship context injection — only edges involving characters currently in scene
    if (settings.injectRelationsContext && relationshipData && relationshipData._initialized && 
        relationshipData.edges && relationshipData.edges.length > 0) {
        var sceneNames = new Set((storyData && storyData.characters || []).map(function(c) { return c.name; }));
        var relevantEdges = relationshipData.edges.filter(function(e) {
            return sceneNames.has(e.from) || sceneNames.has(e.to);
        });
        if (relevantEdges.length > 0) {
            var relLines = relevantEdges.map(function(e) {
                var sign = e.strength >= 0 ? "+" : "";
                return e.from + " \u2194 " + e.to + ": " + e.type + " (" + sign + (e.strength || 0).toFixed(1) + ") \u2014 " + e.summary;
            }).join("\n");
            var relInj = "<relationship_dynamics>\n" + relLines + "\n</relationship_dynamics>";
            finalInj += (finalInj ? "\n" : "") + relInj;
        }
    }

    if (!finalInj) return;
    
    try {
        var ex = scriptModule.chat_metadata.authorsNote || "";
        var mk = "<!-- ST_INJECT -->", emk = "<!-- /ST_INJECT -->";
        var cl = ex.replace(new RegExp(mk + "[\\s\\S]*?" + emk, "g"), "").trim();
        scriptModule.chat_metadata.authorsNote = cl + (cl ? "\n" : "") + mk + "\n" + finalInj + "\n" + emk;
    } catch(e) { console.error("[Story Tracker] Inject error:", e); }
}

// --- Event Handling ---
function bindEvents() {
    var es = scriptModule.eventSource, et = scriptModule.event_types;
    if (!es) return;
    
    es.on(et.CHAT_CHANGED, function() {
        loadStoryData();
        renderModal(); renderHUD();
        updateSettingsUI();
    });
    
    $(document).on("ST_FORCE_RENDER", function() {
        loadStoryData();
        renderModal(); 
        renderHUD();
        updateSettingsUI();
    });

    $(document).on("INV_EQUIPMENT_CHANGED", function() {
        renderModal();
        renderHUD();
        if (settings.enabled && settings.injectToContext) injectContextToChat();
    });

    let handleMsg = async function(type) {
        // GENERATION_ENDED doesn't pass a message ID - we derive it from the chat array
        var liveChat = getLiveChat();
        if (!liveChat || liveChat.length === 0) return;

        // Only process AI (character) messages, not user messages
        var lastMsg = liveChat[liveChat.length - 1];
        if (!lastMsg || lastMsg.is_user) return;

        var id = liveChat.length - 1;
        if (id <= lastCountedMsgId) return;

        var msgObj = lastMsg;
        if (!msgObj || typeof msgObj.mes !== "string" || !msgObj.mes.trim()) return;

        lastCountedMsgId = id;
        saveStoryData();

        if (!settings.enabled) return;

        // Small startup delay so ST's full pipeline (streaming, post-processors) finishes
        // before we start our own chain. Especially important on slow devices like Termux.
        await new Promise(function(r) { setTimeout(r, settings.startupDelay || 2000); });

        if (busy) return;

        if (!isChatOpen()) {
            console.warn("[Story Tracker] Event ignored: No active chat is open.");
            return;
        }

        let autoUpdate = (storyData && storyData.autoUpdate !== undefined) ? storyData.autoUpdate : settings.autoUpdate;
        let autoUpdateInterval = (storyData && storyData.autoUpdateInterval !== undefined) ? storyData.autoUpdateInterval : settings.autoUpdateInterval;

        msgCounter++;
        relMsgCounter++;
        saveStoryData();
        
        // Run agents sequentially to avoid concurrent API requests on rate-limited backends.
        // Each agent awaits the previous one and waits an extra 1.5s gap before firing.
        var needsSceneUpdate = autoUpdate && msgCounter > 0 && msgCounter % autoUpdateInterval === 0;
        var needsWorldTick   = settings.enabled && settings.worldEnabled;
        var needsRelUpdate   = settings.relationsEnabled && settings.relationsAutoUpdate && !relsBusy &&
                               relMsgCounter > 0 && relMsgCounter % (settings.relAutoInterval || 5) === 0;

        if (needsSceneUpdate) {
            busy = true;
            setHudStatus("Scene...");
            if (typeof toastr !== "undefined") toastr.info("Story Tracker: Analyzing scene...", "", { timeOut: 0, extendedTimeOut: 0 });
            try {
                await doLLMUpdate();
                renderModal(); renderHUD();
            } catch(e) { console.error(e); }
            busy = false;
            clearHudStatus();
            if (typeof toastr !== "undefined") toastr.clear();
        } else {
            renderAutoInfo();
        }

        if (needsWorldTick) {
            await new Promise(function(r) { setTimeout(r, 1500); });
            setHudStatus("World...");
            if (typeof toastr !== "undefined") toastr.info("Story Tracker: Running world tick...", "", { timeOut: 0, extendedTimeOut: 0 });
            await checkAndRunWorldTicks();
            clearHudStatus();
            if (typeof toastr !== "undefined") toastr.clear();
        }

        if (needsRelUpdate) {
            await new Promise(function(r) { setTimeout(r, 1500); });
            setHudStatus("Relations...");
            if (typeof toastr !== "undefined") toastr.info("Story Tracker: Analyzing relationships...", "", { timeOut: 0, extendedTimeOut: 0 });
            try {
                await doRelationshipUpdate();
                if ($("#st-tab-relations").is(":visible")) renderRelationshipGraph();
                clearHudStatus();
                if (typeof toastr !== "undefined") { toastr.clear(); toastr.info("Relationships updated."); }
            } catch(e) {
                clearHudStatus();
                if (typeof toastr !== "undefined") toastr.clear();
                console.error("[Story Tracker] Auto relationship update failed:", e);
            }
        }
    };

    es.on(et.GENERATION_ENDED, handleMsg);
    es.on(et.GENERATION_STARTED, function() { if (settings.enabled) injectContextToChat(); });
}

// --- UI Rendering ---
function esc(t) { var d = document.createElement("div"); d.textContent = t; return d.innerHTML; }

// --- Custom Macro Registration ---
function registerStoryMacros() {
    try {
        var context = (typeof SillyTavern !== "undefined" && typeof SillyTavern.getContext === "function") 
            ? SillyTavern.getContext() 
            : null;

        if (context && context.macros && typeof context.macros.register === "function") {
            var macroDefs = [
                { name: 'story_time', key: 'time' },
                { name: 'story_date', key: 'date' },
                { name: 'story_location', key: 'location' },
                { name: 'story_weather', key: 'weather' },
                { name: 'story_temp', key: 'temperature' },
                { name: 'story_city', key: 'city' },
                { name: 'story_country', key: 'country' },
                { name: 'story_events', key: 'recent_events' }
            ];

            macroDefs.forEach(function(m) {
                try {
                    context.macros.register(m.name, {
                        handler: function() {
                            return (storyData && storyData[m.key]) ? storyData[m.key] : "Unknown";
                        },
                        category: "Story Tracker",
                        description: "Tracked narrative value for " + m.key
                    });
                } catch(e) {
                    try {
                        context.macros.register(m.name, function() {
                            return (storyData && storyData[m.key]) ? storyData[m.key] : "Unknown";
                        });
                    } catch(ex) {
                        console.warn("[Story Tracker] Legacy macro fallback registration failed for " + m.name, ex);
                    }
                }
            });
            console.log("[Story Tracker] Custom global macros registered successfully!");
        }
    } catch (e) {
        console.warn("[Story Tracker] Error initializing custom macros registry:", e);
    }
}

function getDayOfWeek(dateStr) {
    if (!dateStr || dateStr === "Unknown") return "";
    var parts = dateStr.split(/[\/\-\.]/);
    if (parts.length < 3) return "";
    var day = parseInt(parts[0], 10), month = parseInt(parts[1], 10), year = parseInt(parts[2], 10);
    if (isNaN(day) || isNaN(month) || isNaN(year)) return "";
    var days = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
    var d = new Date(year, month - 1, day);
    if (isNaN(d.getTime())) return "";
    return days[d.getDay()];
}

// Safe utility to grab character names or group titles for journal subtitles
function getChatSubtitle() {
    try {
        var context = (typeof SillyTavern !== "undefined" && typeof SillyTavern.getContext === "function") 
            ? SillyTavern.getContext() 
            : null;
        if (context) {
            if (context.groupId) {
                var group = context.groups.find(function(g) { return g.id === context.groupId; });
                if (group) return group.name;
            } else if (context.characterId !== undefined) {
                var char = context.characters[context.characterId];
                if (char) return char.name;
            }
        }
    } catch(e) {}
    return "Field Notes";
}

function buildModal() {
    if (document.getElementById("st-modal")) return;
    var h = '<div id="st-modal" style="display:none"><div class="st-overlay"></div><div class="st-dialog">';
    
    // Header Panel
    h += '<div class="st-header">';
    h += '<div class="st-title-wrapper">';
    h += '<div class="st-title"><i class="fa-solid fa-pen-fancy"></i> Story tracker</div>';
    h += '<div class="st-subtitle" id="st-modal-subtitle">Field Notes</div>';
    h += '</div>';
    h += '<button class="st-hdr-btn menu_button" id="st-h-close" title="Close"><i class="fa-solid fa-xmark"></i></button>';
    h += '</div>';
    
    // Segmented Pill Tab Controls
    h += '<div class="st-tabs">' +
         '<div class="st-tab st-tab-active" data-target="st-tab-current">Scene</div>' +
         '<div class="st-tab" data-target="st-tab-history">History</div>' +
         '<div class="st-tab" data-target="st-tab-world">World</div>' +
         '<div class="st-tab" data-target="st-tab-relations"><i class="fa-solid fa-share-nodes" style="margin-right:4px;font-size:10px;"></i>Relations</div>' +
         '</div>';
    
    h += '<div class="st-body">';
    
    // Current Scene Panel
    h += '<div id="st-tab-current">';
    h += '<div class="st-no-data" id="st-no-data" style="display:none"><i class="fa-solid fa-hourglass-start"></i><div>Waiting for first update...</div></div>';
    h += '<div id="st-content-area">';
    
    // Structured Sentence Meta Blocks
    h += '<div class="st-journal-meta">';
    h += '  <div class="st-meta-line"><i class="fa-regular fa-clock"></i> <span id="st-val-dow"></span>, <span id="st-val-date"></span> &bull; <span id="st-val-time"></span></div>';
    h += '  <div class="st-meta-line"><i class="fa-solid fa-location-dot"></i> <span id="st-val-loc"></span><span id="st-city-country-row">, <span id="st-val-city-country"></span></span></div>';
    h += '  <div class="st-meta-line" id="st-weather-row"><i class="fa-solid fa-cloud-sun" id="st-weather-icon-dynamic"></i> <span id="st-val-temp"></span> &bull; <span id="st-val-weather"></span></div>';
    h += '</div>';
    
    // Who's Here Section
    h += '<div class="st-journal-section">';
    h += '  <div class="st-journal-sec-title">Who\'s here</div>';
    h += '  <div class="st-char-list" id="st-val-chars"></div>';
    h += '</div>';

    // Recent Developments (Recent Scene Events)
    h += '<div class="st-journal-section" id="st-events-section">';
    h += '  <div class="st-journal-sec-title">Recent developments</div>';
    h += '  <div class="st-summary-box" id="st-val-events"></div>';
    h += '</div>';
    
    // World Progression Blockquote Preview on the Scene Tab
    h += '<div class="st-journal-section" id="st-world-preview-section" style="display:none;">';
    h += '  <div class="st-journal-sec-title">World progression</div>';
    h += '  <div class="st-world-preview-box" id="st-val-world-summary-preview"></div>';
    h += '</div>';
    
    h += '</div></div>'; // end scene tab
    
    // History Tab
    h += '<div id="st-tab-history" style="display:none;"><div id="st-history-list"></div></div>';
    
    // World Tab
    h += '<div id="st-tab-world" style="display:none;">';
    h += '  <div class="st-journal-section"><div class="st-journal-sec-title">World State Summary</div><div class="st-world-preview-box" id="st-world-val-summary">No summary available yet.</div></div>';
    h += '  <div class="st-journal-section"><div class="st-journal-sec-title">NPC Changes</div><div class="st-world-list" id="st-world-val-npcs"><i>No NPC changes.</i></div></div>';
    h += '  <div class="st-journal-section"><div class="st-journal-sec-title">Pending Discoveries</div><div class="st-world-list" id="st-world-val-reveals"><i>No pending discoveries.</i></div></div>';
    h += '  <div class="st-journal-section"><div class="st-journal-sec-title">World Events Chronology</div><div class="st-world-list" id="st-world-val-events"><i>No events.</i></div></div>';
    h += '</div>'; // end world tab
    
    // Relations Tab
    h += '<div id="st-tab-relations" style="display:none;">';
    h += '<div id="st-rel-graph-container" class="st-rel-graph-container"><div class="st-no-data" style="padding:30px 0;"><i class="fa-solid fa-share-nodes"></i><div>No relationship data yet.</div><div style="font-size:11px;margin-top:6px;opacity:0.6;">Click Analyze to begin tracking.</div></div></div>';
    h += '</div>'; // end relations tab
    
    h += '</div>'; // end body
    
    // Footer Control Panel
    h += '<div class="st-footer">';
    h += '  <button class="menu_button st-pill-btn" id="st-f-update" style="display: inline-flex !important;"><i class="fa-solid fa-pen"></i> Update now</button>';
    h += '  <div class="st-world-controls st-hidden" style="display: none !important; gap: 5px;">' +
         '    <button class="menu_button st-pill-btn" id="st-world-btn-tick"><i class="fa-solid fa-play"></i> Run Tick</button>' +
         '    <button class="menu_button st-pill-btn" id="st-world-btn-clear" style="color:#ff453a !important;"><i class="fa-solid fa-trash-can"></i> Clear</button>' +
         '    <button class="menu_button st-pill-btn" id="st-world-btn-refresh"><i class="fa-solid fa-rotate"></i> Refresh</button>' +
         '  </div>';
    h += '  <div class="st-relations-controls st-hidden" style="display: none !important; gap: 5px;">' +
         '    <button class="menu_button st-pill-btn" id="st-rel-btn-analyze"><i class="fa-solid fa-magnifying-glass-chart"></i> Analyze</button>' +
         '    <button class="menu_button st-pill-btn" id="st-rel-btn-clear" style="color:#ff453a !important;"><i class="fa-solid fa-trash-can"></i> Clear</button>' +
         '  </div>';
    h += '  <div class="st-auto-info" id="st-auto-info"></div>';
    h += '</div></div></div>';
    document.body.insertAdjacentHTML("beforeend", h);

    $(document).on("click", ".st-overlay, #st-h-close", function() { $("#st-modal").fadeOut(150); });
    $(document).on("click", "#st-f-update", doManualUpdate);
    $(document).on("click", ".st-tab", function() {
        $(".st-tab").removeClass("st-tab-active"); $(this).addClass("st-tab-active");
        $("#st-tab-current, #st-tab-history, #st-tab-world, #st-tab-relations").hide();
        var target = $(this).data("target");
        $("#" + target).show();

        // Dynamically toggle buttons in footer depending on active tab using inline style settings to prevent overrides
        var updateBtn = $("#st-f-update")[0];
        var worldControls = $(".st-world-controls")[0];
        var relControls = $(".st-relations-controls")[0];
        if (target === "st-tab-world") {
            if (updateBtn) updateBtn.style.setProperty('display', 'none', 'important');
            if (worldControls) worldControls.style.setProperty('display', 'inline-flex', 'important');
            if (relControls) relControls.style.setProperty('display', 'none', 'important');
        } else if (target === "st-tab-relations") {
            if (updateBtn) updateBtn.style.setProperty('display', 'none', 'important');
            if (worldControls) worldControls.style.setProperty('display', 'none', 'important');
            if (relControls) relControls.style.setProperty('display', 'inline-flex', 'important');
            renderRelationshipGraph();
        } else {
            if (updateBtn) updateBtn.style.setProperty('display', 'inline-flex', 'important');
            if (worldControls) worldControls.style.setProperty('display', 'none', 'important');
            if (relControls) relControls.style.setProperty('display', 'none', 'important');
        }
    });

    // World control routing
    $(document).on("click", "#st-world-btn-tick", async function() {
        await runManualWorldTick();
    });
    $(document).on("click", "#st-world-btn-clear", function() {
        if (confirm("Are you sure you want to clear world progression history?")) {
            worldData = makeDefaultWorldData();
            saveWorldData();
            renderModal(); renderHUD();
            if (typeof toastr !== "undefined") toastr.info("World state cleared.");
        }
    });
    $(document).on("click", "#st-world-btn-refresh", function() {
        loadWorldData();
        renderModal(); renderHUD();
        if (typeof toastr !== "undefined") toastr.info("World data refreshed.");
    });

    // Relations control routing
    $(document).on("click", "#st-rel-btn-analyze", async function() {
        await runManualRelationshipAnalysis();
    });
    $(document).on("click", "#st-rel-btn-clear", function() {
        if (!confirm("Clear all relationship tracking data?")) return;

        relationshipData = makeDefaultRelationshipData();

        // make sure graph immediately enters empty state
        relationshipData._initialized = false;

        saveRelationshipData();

        // refresh everything that consumes relationship state
        renderRelationshipGraph();
        renderHUD();
        renderModal();

        // refresh injected prompt context too
        if (settings.enabled && settings.injectToContext) injectContextToChat();

        $(document).trigger("ST_FORCE_RENDER");

        if (typeof toastr !== "undefined") {
            toastr.info("Relationship data cleared.");
        }
    });

    // Delete past summary from history
    $(document).on("click", ".st-del-hist", function() {
        var index = parseInt($(this).data("index"), 10);
        if (storyData && storyData.history && !isNaN(index)) {
            storyData.history.splice(index, 1);
            saveStoryData();
            renderModal();
        }
    });
}

function renderModal() {
    if (!isChatOpen() || !storyData) {
        $("#st-no-data").show(); $("#st-content-area").hide();
        $("#st-history-list").html("<div class='st-no-data'>No active chat.</div>");
        $("#st-world-val-summary").text("No active chat.");
        $("#st-world-val-events").html("<i>No active chat.</i>");
        $("#st-world-val-npcs").html("<i>No active chat.</i>");
        $("#st-world-val-reveals").html("<i>No active chat.</i>");
        return;
    }
    if (!storyData._initialized) {
        $("#st-no-data").show(); $("#st-content-area").hide();
    } else {
        $("#st-no-data").hide(); $("#st-content-area").show();
        
        // Update header subtitle
        $("#st-modal-subtitle").text(getChatSubtitle());
        
        // Populate standard nodes
        $("#st-val-time").text(storyData.time);
        $("#st-val-date").text(storyData.date);
        var dow = getDayOfWeek(storyData.date);
        $("#st-val-dow").text(dow || "Unknown");
        $("#st-val-loc").text(storyData.location);
        
        if (settings.showCityCountry) {
            let city = storyData.city || "Unknown";
            let country = storyData.country || "Unknown";
            let ccText = (city !== "Unknown" || country !== "Unknown")
                ? [city, country].filter(v => v && v !== "Unknown").join(", ") || "Unknown"
                : "Unknown";
            $("#st-val-city-country").text(ccText);
            $("#st-city-country-row").show();
        } else {
            $("#st-city-country-row").hide();
        }

        $("#st-val-temp").text(storyData.temperature || "Unknown");
        $("#st-val-weather").text(storyData.weather || "Unknown");
        $("#st-val-events").text(storyData.recent_events);
        
        // Dynamically compute weather icon classes
        var wIcon = "fa-cloud-sun";
        var w = (storyData.weather || "").toLowerCase();
        if (w.includes("rain") || w.includes("дожд")) wIcon = "fa-cloud-rain";
        else if (w.includes("snow") || w.includes("снег")) wIcon = "fa-snowflake";
        else if (w.includes("storm") || w.includes("гроз")) wIcon = "fa-bolt";
        else if (w.includes("fog") || w.includes("туман")) wIcon = "fa-smog";
        else if (w.includes("clear") || w.includes("ясн") || w.includes("солн")) wIcon = "fa-sun";
        else if (w.includes("cloud") || w.includes("облач")) wIcon = "fa-cloud";
        $("#st-weather-icon-dynamic").attr("class", "fa-solid " + wIcon);
        
        var outfit = getInventoryOutfit();
        var userName = (scriptModule && scriptModule.name1) ? scriptModule.name1 : null;

        let cHtml = "";
        if (storyData.characters) {
            storyData.characters.forEach(c => {
                var stateText = c.state;
                var isUser = (userName && c.name.toLowerCase() === userName.toLowerCase()) ||
                             c.name.toLowerCase() === "вы" ||
                             c.name === "{{user}}";

                if (outfit && outfit.userEquipped.length > 0) {
                    if (isUser) {
                        var wearNames = outfit.userEquipped.map(function(it) { return it.name; }).join(", ");
                        stateText += ", wearing " + wearNames;
                    }
                }

                if (outfit && outfit.charItems.length > 0) {
                    var held = outfit.charItems.filter(ci => ci.heldBy && ci.heldBy.toLowerCase() === c.name.toLowerCase());
                    if (held.length > 0) {
                        var heldNames = held.map(function(ci) { return ci.name; }).join(", ");
                        stateText += ", holding " + heldNames;
                    }
                }

                // Monogram extraction (supports numeric indicators like +3)
                var initials = "?";
                if (c.name) {
                    var trimmed = c.name.trim();
                    var matches = trimmed.match(/^(\+\d+|\d+)/);
                    if (matches) {
                        initials = matches[1];
                    } else {
                        initials = trimmed.charAt(0).toUpperCase();
                    }
                }

                var userLabel = isUser ? ' <span class="st-char-user">&bull; you</span>' : '';

                cHtml += '<div class="st-char-card">' +
                         '  <div class="st-char-avatar">' + esc(initials) + '</div>' +
                         '  <div class="st-char-details">' +
                         '    <div class="st-char-name">' + esc(c.name) + userLabel + '</div>' +
                         '    <div class="st-char-state">' + esc(stateText) + '</div>' +
                         '  </div>' +
                         '</div>';
            });
        }
        $("#st-val-chars").html(cHtml || "<i>No characters detected.</i>");

        // Populate World Progression preview if summary exists
        if (worldData && worldData.worldSummary && worldData.worldSummary.trim() !== "") {
            $("#st-val-world-summary-preview").text(worldData.worldSummary);
            $("#st-world-preview-section").show();
        } else {
            $("#st-world-preview-section").hide();
        }
    }   
    
    let hHtml = "";
    if (storyData.history && storyData.history.length > 0) {
        storyData.history.forEach((h, i) => {
            let weatherInfo = (h.temperature || h.weather) ? ` | ${h.temperature || ""}${h.weather ? " " + esc(h.weather) : ""}` : "";
            hHtml += `<div class="st-history-item" style="position: relative;">
                <div class="st-history-meta" style="display: flex; justify-content: space-between; align-items: center;">
                    <span>Update at Msg #${h.msg}</span>
                    <span style="display: flex; align-items: center; gap: 8px;">
                        ${h.time} | ${esc(h.loc)}${weatherInfo}
                        <button class="st-del-hist st-hdr-btn menu_button" data-index="${i}" title="Delete Summary" style="padding: 2px 6px !important; font-size: 10px; color: #ff453a; border-color: rgba(255,255,255,0.1); background: transparent;"><i class="fa-solid fa-trash-can"></i></button>
                    </span>
                </div>
                <div class="st-history-sum" style="margin-top: 4px;">${esc(h.events)}</div>
            </div>`;
        });
    } else { hHtml = "<div class='st-no-data'>No history yet.</div>"; }
    $("#st-history-list").html(hHtml);

    // Populate Secondary Tab States
    if (worldData && worldData._initialized) {
        $("#st-world-val-summary").text(worldData.worldSummary || "No summary available yet.");

        let eventsHtml = "";
        if (worldData.worldEvents && worldData.worldEvents.length > 0) {
            worldData.worldEvents.forEach(function(e) {
                eventsHtml += `<div class="st-world-event-item">
                    <div class="st-world-event-meta">
                        <span>${e.time} ${e.date}</span>
                        <span>Importance: ${e.importance}/10</span>
                    </div>
                    <div class="st-world-event-text">${esc(e.event)}</div>
                </div>`;
            });
        } else {
            eventsHtml = "<i>No events recorded.</i>";
        }
        $("#st-world-val-events").html(eventsHtml);

        let npcsHtml = "";
        if (worldData.npcStates && worldData.npcStates.length > 0) {
            worldData.npcStates.forEach(function(n) {
                npcsHtml += `<div class="st-world-npc-item">
                    <span class="st-world-npc-name">${esc(n.name)}:</span> <span>${esc(n.change)}</span>
                </div>`;
            });
        } else {
            npcsHtml = "<i>No NPC changes recorded.</i>";
        }
        $("#st-world-val-npcs").html(npcsHtml);

        let revealsHtml = "";
        if (worldData.pendingReveals && worldData.pendingReveals.length > 0) {
            worldData.pendingReveals.forEach(function(r) {
                revealsHtml += `<div class="st-world-reveal-item">
                    <i class="fa-solid fa-circle-question st-world-reveal-icon"></i>
                    <span>${esc(r)}</span>
                </div>`;
            });
        } else {
            revealsHtml = "<i>No pending discoveries.</i>";
        }
        $("#st-world-val-reveals").html(revealsHtml);
    } else {
        $("#st-world-val-summary").text("Waiting for first World Tick to run...");
        $("#st-world-val-events").html("<i>Waiting for simulation...</i>");
        $("#st-world-val-npcs").html("<i>Waiting for simulation...</i>");
        $("#st-world-val-reveals").html("<i>Waiting for simulation...</i>");
    }

    renderAutoInfo();
    // Refresh graph if relations tab is currently visible
    if ($("#st-tab-relations").is(":visible")) {
        renderRelationshipGraph();
    }
}

function updateSettingsUI() {
    let hasData = isChatOpen() && storyData;
    let autoUpdate = (hasData && storyData.autoUpdate !== undefined) ? storyData.autoUpdate : settings.autoUpdate;
    let autoUpdateInterval = (hasData && storyData.autoUpdateInterval !== undefined) ? storyData.autoUpdateInterval : settings.autoUpdateInterval;

    $("#st-s-auto").prop("checked", autoUpdate);
    $("#st-s-interval").val(autoUpdateInterval);
    $("#st-interval-val").text(autoUpdateInterval);

    // Sync World Agent settings
    $("#st-s-startup-delay").val(settings.startupDelay || 2000).on("input", function() {
        settings.startupDelay = parseInt(this.value, 10);
        $("#st-s-delay-val").text(this.value);
        save();
    });
    $("#st-s-delay-val").text(settings.startupDelay || 2000);

    $("#st-s-world-on").prop("checked", settings.worldEnabled);
    $("#st-s-world-inject").prop("checked", settings.injectWorldContext);
    $("#st-s-world-useprofile").prop("checked", settings.useWorldProfile);
    $("#st-world-profile-row").toggle(settings.useWorldProfile);
    $("#st-s-world-freq").val(settings.worldTickFrequency);
    $("#st-s-max-ticks").val(settings.maxWorldTicks);
    $("#st-max-ticks-val").text(settings.maxWorldTicks);

    // Sync Relationship Tracker settings
    $("#st-s-rel-on").prop("checked", settings.relationsEnabled);
    $("#st-s-rel-auto").prop("checked", settings.relationsAutoUpdate);
    $("#st-rel-interval-row").toggle(settings.relationsAutoUpdate);
    $("#st-s-rel-interval").val(settings.relAutoInterval || 5);
    $("#st-rel-interval-val").text(settings.relAutoInterval || 5);
    $("#st-s-rel-useprofile").prop("checked", settings.useRelProfile);
    $("#st-rel-profile-row").toggle(settings.useRelProfile);
    $("#st-s-rel-inject").prop("checked", settings.injectRelationsContext);

    // Sync RGB Highlights
    $("#st-s-rgb-r").val(settings.accentR || 216);
    $("#st-rgb-r-val").text(settings.accentR || 216);
    $("#st-s-rgb-g").val(settings.accentG || 160);
    $("#st-rgb-g-val").text(settings.accentG || 160);
    $("#st-s-rgb-b").val(settings.accentB || 64);
    $("#st-rgb-b-val").text(settings.accentB || 64);
    applyCustomAccentColor();

    renderAutoInfo();
}

function renderAutoInfo() {
    let hasData = isChatOpen() && storyData;
    let autoUpdate = (hasData && storyData.autoUpdate !== undefined) ? storyData.autoUpdate : settings.autoUpdate;
    let autoUpdateInterval = (hasData && storyData.autoUpdateInterval !== undefined) ? storyData.autoUpdateInterval : settings.autoUpdateInterval;

    if(!autoUpdate) { $("#st-auto-info").text("Auto-update: OFF"); return; }
    if(!hasData) { $("#st-auto-info").text("No active chat"); return; }
    let rem = autoUpdateInterval - (msgCounter % autoUpdateInterval);
    $("#st-auto-info").text(`Auto-update in ${rem} msg(s)`);
}

// --- Core LLM Scene Update Engine ---
async function doLLMUpdate() {
    if (!genRaw) throw new Error("Story Tracker: Raw LLM generation not available.");
    if (!isChatOpen()) throw new Error("Story Tracker: No active chat is open.");

    loadStoryData();
    if (!storyData) throw new Error("Story Tracker: No story data available.");

    // Build recent chat context using checkpoint system.
    // First run: last 20 messages. Subsequent runs: only messages since last scene checkpoint.
    // Each message is truncated to 500 chars to prevent long AI responses from bloating the prompt.
    var liveChat = getLiveChat() || [];
    var userName = (scriptModule && scriptModule.name1) ? scriptModule.name1 : "{{user}}";
    var sceneLastCheckpoint = -1;
    if (storyData._sceneCheckpointIdx != null) {
        var scpIdx = storyData._sceneCheckpointIdx;
        var scpAnchor = storyData._sceneCheckpointAnchor || "";
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
    sceneMsgs.forEach(function(msg) {
        var senderName = msg.is_user ? userName : (msg.name || "Character");
        var text = (msg.mes || "").trim();
        if (text) chatContext += senderName + ": " + text + "\n\n";
    });
    chatContext = chatContext.trim() || "No messages yet.";

    var prevState = buildPrevStateText();
    var prompt = UPDATE_PROMPT.replace("{{PREVIOUS_STATE}}", prevState) +
                 "\n\n[Player character name: {{user}}. Always use this exact name in the JSON output, never write 'User'.]\n" +
                 "Recent chat:\n" + chatContext;

    var raw = await withConnectionProfile(async function() {
        try {
            return await genRaw({ prompt: prompt, quietToLoud: true });
        } catch(e) {
            return await genRaw(prompt, null, false, true);
        }
    });

    var data = cleanAndParseJSON(raw);
    if (!data) throw new Error("Story Tracker: Failed to parse LLM scene analysis response.");

    // Apply validated updates to storyData
    if (data.time) storyData.time = sanitizeTimeStr(data.time, storyData.time);
    if (data.date) storyData.date = sanitizeDateStr(data.date, storyData.date);
    if (data.location) storyData.location = data.location;
    if (data.city  && data.city  !== "Unknown") storyData.city    = data.city;
    if (data.country && data.country !== "Unknown") storyData.country = data.country;
    if (data.temperature) storyData.temperature = data.temperature;
    if (data.weather)     storyData.weather     = data.weather;
    if (Array.isArray(data.characters) && data.characters.length > 0) storyData.characters = data.characters;
    if (data.recent_events) storyData.recent_events = data.recent_events;

    // Fallback: if city or country is still unknown, run a targeted prompt to determine them
    var cityMissing    = !storyData.city    || storyData.city    === "Unknown";
    var countryMissing = !storyData.country || storyData.country === "Unknown";
    if (cityMissing || countryMissing) {
        try {
            var ccPrompt = CITY_COUNTRY_PROMPT.replace("{{LOCATION}}", storyData.location || "Unknown");
            var ccRaw = await withConnectionProfile(async function() {
                try { return await genRaw({ prompt: ccPrompt, quietToLoud: true }); }
                catch(e) { return await genRaw(ccPrompt, null, false, true); }
            });
            var ccData = cleanAndParseJSON(ccRaw);
            if (ccData) {
                if (ccData.city    && ccData.city    !== "Unknown") storyData.city    = ccData.city;
                if (ccData.country && ccData.country !== "Unknown") storyData.country = ccData.country;
            }
        } catch(e) {
            console.warn("[Story Tracker] City/country fallback failed:", e);
        }
    }

    // Mark initialized and record a history entry (uses fields expected by renderModal)
    storyData._initialized = true;
    if (data.recent_events) {
        if (!storyData.history) storyData.history = [];
        storyData._historyCount = (storyData._historyCount || 0) + 1;
        storyData.history.unshift({
            msg:         storyData._historyCount,
            time:        storyData.time,
            loc:         storyData.location,
            events:      data.recent_events,
            temperature: storyData.temperature || "",
            weather:     storyData.weather     || ""
        });
        // Cap history at 50 entries
        if (storyData.history.length > 50) storyData.history = storyData.history.slice(0, 50);
    }

    // Save scene checkpoint
    if (liveChat.length > 0) {
        var lastSceneMsg = liveChat[liveChat.length - 1];
        storyData._sceneCheckpointIdx = liveChat.length - 1;
        storyData._sceneCheckpointAnchor = (lastSceneMsg && lastSceneMsg.mes)
            ? String(lastSceneMsg.mes).slice(0, 40) : "";
    }
    saveStoryData();
    syncToCharTracker();
    if (settings.enabled && settings.injectToContext) injectContextToChat();
}

async function doManualUpdate() {
    if (!settings.enabled) {
        if (typeof toastr !== "undefined") toastr.warning("Story Tracker is disabled. Enable it in the extension settings.");
        return;
    }
    if (busy) return;
    
    // Failsafe: abort manual update if no active chat open
    if (!isChatOpen()) {
        console.warn("[Story Tracker] Aborted manual update: No active chat open.");
        if (typeof toastr !== "undefined") {
            toastr.warning("Story Tracker: Manual update aborted. No active chat is open.");
        }
        return;
    }

    busy = true;
    var $b = $("#st-f-update").prop("disabled", true).html('<i class="fa-solid fa-spinner fa-spin"></i> Analyzing...');
    setHudStatus("Scene...");
    if (typeof toastr !== "undefined") toastr.info("Story Tracker: Analyzing scene...", "", { timeOut: 0, extendedTimeOut: 0 });
    try {
        await doLLMUpdate();
        
        // Reset the message counter for auto-updates and save
        msgCounter = 0;
        saveStoryData();
        
        renderModal(); renderHUD();
        clearHudStatus();
        if(typeof toastr !== "undefined") { toastr.clear(); toastr.success("Story updated!"); }
    } catch(e) { clearHudStatus(); if (typeof toastr !== "undefined") { toastr.clear(); toastr.error(e.message); } }
    busy = false;
    $b.prop("disabled", false).html('<i class="fa-solid fa-pen"></i> Update now');
}

// --- World Simulation Engine ---
function padZero(n) { return n < 10 ? "0" + n : n; }

// --- Extract NPCs recently interacted with from chat history ---
function extractRecentNPCsFromChat(chatMessages, numMessages) {
    var n = numMessages || 15;
    var recent = (chatMessages || []).slice(-n);
    var userName = (scriptModule && scriptModule.name1) ? scriptModule.name1.toLowerCase() : "user";
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

// --- Helpers for event similarity and deduplication ---
function getEventSimilarity(str1, str2) {
    if (!str1 || !str2) return 0;
    var tokenize = function(str) {
        return str.toLowerCase().split(/[\s,.:;!?()"\'-]+/).filter(function(w) { return w.length > 1; });
    };
    var tokens1 = tokenize(str1);
    var tokens2 = tokenize(str2);
    var set1 = new Set(tokens1);
    var set2 = new Set(tokens2);
    if (set1.size === 0 || set2.size === 0) return 0;
    var intersection = new Set([...set1].filter(function(x) { return set2.has(x); }));
    var union = new Set([...set1, ...set2]);
    return intersection.size / union.size;
}

function isDuplicateEvent(newEventText) {
    if (!worldData || !worldData.worldEvents) return false;
    for (var i = 0; i < worldData.worldEvents.length; i++) {
        var sim = getEventSimilarity(newEventText, worldData.worldEvents[i].event);
        if (sim > 0.7) {
            return true;
        }
    }
    return false;
}

async function runSingleWorldTick(timeStr, dateStr) {
    if (!genRaw) throw new Error("Raw LLM generation not available.");

    var tickDateObj = parseRpDateTime(timeStr, dateStr);

    var sumBefore = worldData.worldSummary || "No world summary yet.";
    var revealsBefore = (worldData.pendingReveals || []).join("\n") || "None.";

    // Track active NPC States for context injection
    // Cap to 20 most recently active NPCs to avoid prompt overflow on NPC-heavy RPs.
    var npcStatesText = "";
    if (worldData.npcStates && worldData.npcStates.length > 0) {
        var recentNPCNames = new Set(extractRecentNPCsFromChat(originalChat, 30));
        var sortedNPCs = worldData.npcStates.slice().sort(function(a, b) {
            var aRecent = recentNPCNames.has(a.name) ? 1 : 0;
            var bRecent = recentNPCNames.has(b.name) ? 1 : 0;
            return bRecent - aRecent;
        });
        var cappedNPCs = sortedNPCs.slice(0, 20);
        npcStatesText = cappedNPCs.map(function(n) { return "- " + n.name + ": " + n.change; }).join("\n");
        if (worldData.npcStates.length > 20) {
            npcStatesText += "\n(" + (worldData.npcStates.length - 20) + " additional NPCs omitted - showing most recently active)";
        }
    } else {
        npcStatesText = "No tracked NPCs yet.";
    }

    // Build chat context for world agent using checkpoint system.
    // First tick: last 15 messages. Subsequent ticks: only messages since last world checkpoint.
    // Each message is truncated to 500 chars to prevent long responses from bloating the prompt.
    var originalChat = (scriptModule && scriptModule.chat) ? scriptModule.chat : [];
    var worldLastCheckpoint = -1;
    if (worldData._worldCheckpointIdx != null) {
        var wcpIdx = worldData._worldCheckpointIdx;
        var wcpAnchor = worldData._worldCheckpointAnchor || "";
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
        var senderName = msg.is_user ? (scriptModule && scriptModule.name1 ? scriptModule.name1 : "{{user}}") : (msg.name || "Char");
        var msgText = (msg.mes || "").trim();
        chatHistoryText += senderName + ": " + msgText + "\n";
    });
    if (!chatHistoryText.trim()) chatHistoryText = "No recent messages.";

    // Retrieve past history timeline as structured context to pass to the model, filtered to <= current tick
    // Capped at 12 most recent entries to avoid prompt overflow on long RPs.
    var historyTimelineText = "";
    if (storyData && storyData.history && storyData.history.length > 0) {
        var reversedHist = [...storyData.history].reverse();
        var addedCount = 0;
        var HISTORY_INJECT_CAP = 12;
        reversedHist.forEach(function(h) {
            if (addedCount >= HISTORY_INJECT_CAP) return;
            var entryDateObj = parseRpDateTime(h.time, h.date);
            if (entryDateObj && tickDateObj && entryDateObj.getTime() <= tickDateObj.getTime()) {
                historyTimelineText += `- Time: ${h.time} | Date: ${h.date} (Event: ${h.events})\n`;
                addedCount++;
            }
        });
        if (addedCount === 0) {
            historyTimelineText = "No past history recorded before this tick.";
        }
    } else {
        historyTimelineText = "No past history recorded yet.";
    }

    // Ensure non-translated values are fed to prompt context
    var currentLoc = (storyData && storyData.location) ? storyData.location : "Unknown";
    var recentEv = (storyData && storyData.recent_events) ? storyData.recent_events : "None.";

    // Extract NPCs that were recently interacted with in chat so the world agent can prioritize them
    var recentNPCs = extractRecentNPCsFromChat(originalChat, 15);
    var interactedNPCsText = recentNPCs.length > 0
        ? recentNPCs.map(function(n) { return "- " + n; }).join("\n")
        : "None identified — generate general world updates.";

    var prompt = WORLD_PROMPT
        .replace("{{CURRENT_TIME}}", timeStr)
        .replace("{{CURRENT_DATE}}", dateStr)
        .replace("{{CURRENT_LOCATION}}", currentLoc)
        .replace("{{RECENT_EVENTS}}", recentEv)
        .replace("{{INTERACTED_NPCS}}", interactedNPCsText)
        .replace("{{PAST_HISTORY_TIMELINE}}", historyTimelineText)
        .replace("{{RECENT_CHAT_HISTORY}}", chatHistoryText)
        .replace("{{WORLD_SUMMARY}}", sumBefore)
        .replace("{{NPC_STATES}}", npcStatesText)
        .replace("{{PENDING_REVEALS}}", revealsBefore);

    console.log("[Story Tracker] Executing World Agent simulation step...");
    var raw = await withWorldConnectionProfile(async function () {
        try {
            return await genRaw({
                prompt: prompt,
                quietToLoud: true
            });
        } catch (e) {
            return await genRaw(prompt, null, false, true);
        }
    });

    var data = cleanAndParseJSON(raw);

    if (!data || !data.summary) {
        throw new Error("Invalid World Agent response object.");
    }

    // Save outputs and update state baseline parameters
    worldData.worldSummary = data.summary;
    worldData.lastTickTime = timeStr;
    worldData.lastTickDate = dateStr;
    worldData._initialized = true; // Mark initialized to update the UI on modal render

    if (Array.isArray(data.events)) {
        data.events.forEach(function(e) {
            if (e && e.event) {
                if (isDuplicateEvent(e.event)) {
                    console.log("[Story Tracker] Duplicate world event skipped:", e.event);
                    return;
                }
                var eventTime = sanitizeTimeStr(e.time, timeStr);
                var eventDate = sanitizeDateStr(e.date, dateStr);

                // Clamp future events to the current tick time
                var eventDateObj = parseRpDateTime(eventTime, eventDate);
                if (eventDateObj && tickDateObj && eventDateObj.getTime() > tickDateObj.getTime()) {
                    eventTime = timeStr;
                    eventDate = dateStr;
                }

                worldData.worldEvents.unshift({
                    time: eventTime,
                    date: eventDate,
                    event: e.event,
                    importance: parseInt(e.importance, 10) || 5
                });
            }
        });
    }

    if (Array.isArray(data.npc_updates)) {
        data.npc_updates.forEach(function(npc) {
            if (npc && npc.name && npc.change) {
                var existing = worldData.npcStates.find(n => n.name.toLowerCase() === npc.name.toLowerCase());
                if (existing) {
                    existing.change = npc.change;
                } else {
                    worldData.npcStates.push({ name: npc.name, change: npc.change });
                }
            }
        });
    }

    if (Array.isArray(data.pending_reveals)) {
        data.pending_reveals.forEach(function(rev) {
            if (rev && !worldData.pendingReveals.includes(rev)) {
                worldData.pendingReveals.push(rev);
            }
        });
        // Cap pendingReveals — keep only the 15 most recent
        if (worldData.pendingReveals.length > 15) {
            worldData.pendingReveals = worldData.pendingReveals.slice(-15);
        }
    }

    // Save world checkpoint
    if (originalChat.length > 0) {
        var lastWorldMsg = originalChat[originalChat.length - 1];
        worldData._worldCheckpointIdx = originalChat.length - 1;
        worldData._worldCheckpointAnchor = (lastWorldMsg && lastWorldMsg.mes)
            ? String(lastWorldMsg.mes).slice(0, 40) : "";
    }
    trimWorldEvents();
    saveWorldData();
}

function trimWorldEvents() {
    if (!worldData || !worldData.worldEvents || worldData.worldEvents.length <= 15) return;

    // Priority trim: remove lowest importance events first, then oldest
    while (worldData.worldEvents.length > 15) {
        var removed = false;

        // Pass 1 — remove oldest minor events (importance <= 3)
        for (var i = worldData.worldEvents.length - 1; i >= 0; i--) {
            if (worldData.worldEvents[i].importance <= 3) {
                worldData.worldEvents.splice(i, 1);
                removed = true;
                break;
            }
        }
        if (removed) continue;

        // Pass 2 — remove oldest moderate events (importance < 7)
        for (var i = worldData.worldEvents.length - 1; i >= 0; i--) {
            if (worldData.worldEvents[i].importance < 7) {
                worldData.worldEvents.splice(i, 1);
                removed = true;
                break;
            }
        }
        if (removed) continue;

        // Hard fallback — remove oldest regardless of importance
        worldData.worldEvents.pop();
    }
}

async function runManualWorldTick() {
    if (!settings.enabled) {
        if (typeof toastr !== "undefined") toastr.warning("Story Tracker is disabled. Enable it in the extension settings.");
        return;
    }
    if (worldBusy) return;
    if (!settings.worldEnabled) {
        if (typeof toastr !== "undefined") toastr.warning("World Agent is disabled. Enable it in settings first.");
        return;
    }
    if (!isChatOpen()) {
        if (typeof toastr !== "undefined") toastr.warning("No active chat is open.");
        return;
    }

    loadWorldData();

    var tickTimeStr = "Manual";
    var tickDateStr = "Tick";
    if (storyData && storyData._initialized) {
        tickTimeStr = storyData.time;
        tickDateStr = storyData.date;
    }

    worldBusy = true;
    var $btn = $("#st-world-btn-tick").prop("disabled", true).html('<i class="fa-solid fa-spinner fa-spin"></i> Ticking...');
    setHudStatus("World...");
    if (typeof toastr !== "undefined") toastr.info("Story Tracker: Running world tick...", "", { timeOut: 0, extendedTimeOut: 0 });
    try {
        await runSingleWorldTick(tickTimeStr, tickDateStr);
        renderModal(); renderHUD();
        clearHudStatus();
        if (typeof toastr !== "undefined") { toastr.clear(); toastr.success("World tick generated!"); }

    } catch(e) {
        clearHudStatus();
        if (typeof toastr !== "undefined") { toastr.clear(); toastr.error("World tick failed: " + e.message); }
    } finally {
        worldBusy = false;
        $btn.prop("disabled", false).html('<i class="fa-solid fa-play"></i> Run World Tick');
    }
}

// --- Relationship Tracker Engine ---

async function doRelationshipUpdate() {
    if (!genRaw) throw new Error("Raw LLM generation not available.");
    if (!isChatOpen()) throw new Error("No active chat is open.");
    if (!storyData) throw new Error("No story data available.");

    loadRelationshipData();
    if (!relationshipData) return;

    // Build character list from current scene
    var sceneChars = (storyData.characters || []).map(function(c) { return c.name; }).join(", ") || "None identified.";

    // Build existing relationships summary for the prompt
    var existingRels = "";
    if (relationshipData.edges && relationshipData.edges.length > 0) {
        existingRels = relationshipData.edges.map(function(e) {
            var sign = e.strength >= 0 ? "+" : "";
            return "- " + e.from + " \u2194 " + e.to + ": " + e.type +
                   " (strength: " + sign + (e.strength || 0).toFixed(1) + ") \u2014 " + e.summary;
        }).join("\n");
    } else {
        existingRels = "None yet — identify all meaningful relationships from scratch.";
    }

    // Build recent chat context using checkpoint system
    // On first run (no checkpoint) grab the last 20 messages.
    // On subsequent runs grab only messages since the last checkpoint message index.
    var liveChat = getLiveChat() || [];
    var userName = (scriptModule && scriptModule.name1) ? scriptModule.name1 : "{{user}}";
    // Validate checkpoint anchor to detect index drift from deletions/swipes
    var lastCheckpoint = -1;
    if (relationshipData && relationshipData._checkpointMsgIdx != null) {
        var cpIdx = relationshipData._checkpointMsgIdx;
        var cpAnchor = relationshipData._checkpointAnchor || "";
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

    var prompt = RELATIONSHIP_PROMPT
        .replace("{{SCENE_CHARACTERS}}", sceneChars)
        .replace("{{EXISTING_RELATIONSHIPS}}", existingRels)
        .replace("{{RECENT_CHAT}}", chatText);

    console.log("[Story Tracker] Running relationship analysis...");
    var raw = await withRelConnectionProfile(async function() {
        try { return await genRaw({ prompt: prompt, quietToLoud: true }); }
        catch(e) { return await genRaw(prompt, null, false, true); }
    });

    var data = cleanAndParseJSON(raw);
    if (!data || !Array.isArray(data.relationships)) {
        console.warn("[Story Tracker] Relationship response invalid or empty.");
        return;
    }

    // Merge relationships into existing data
    data.relationships.forEach(function(rel) {
        if (!rel.from || !rel.to || rel.from === rel.to) return;

        var strength = parseFloat(rel.strength);
        if (isNaN(strength)) strength = 0;
        strength = Math.max(-1, Math.min(1, strength));

        // Normalize edge key alphabetically to deduplicate A↔B vs B↔A
        var keyA = rel.from < rel.to ? rel.from : rel.to;
        var keyB = rel.from < rel.to ? rel.to : rel.from;

        // Ensure both character nodes exist
        [rel.from, rel.to].forEach(function(name) {
            if (!relationshipData.nodes.find(function(n) { return n.name === name; })) {
                relationshipData.nodes.push({ id: name, name: name });
            }
        });

        var existing = relationshipData.edges.find(function(e) {
            return e.from === keyA && e.to === keyB;
        });

        if (existing) {
            // Record history entry before overwriting
            if (!existing.history) existing.history = [];
            if (existing.summary) {
                existing.history.unshift({
                    msg: storyData._historyCount || 0,
                    summary: rel.change || "Updated",
                    strength: strength
                });
                if (existing.history.length > 20) existing.history = existing.history.slice(0, 20);
            }
            existing.type = rel.type || existing.type;
            existing.strength = strength;
            existing.summary = rel.summary || existing.summary;
            existing.change = rel.change || "Stable";
        } else {
            relationshipData.edges.push({
                from: keyA,
                to: keyB,
                type: rel.type || "neutral",
                strength: strength,
                summary: rel.summary || "",
                change: rel.change || "",
                history: []
            });
        }
    });

    // Ensure all current scene characters have a node entry
    if (storyData.characters) {
        storyData.characters.forEach(function(c) {
            if (!relationshipData.nodes.find(function(n) { return n.name === c.name; })) {
                relationshipData.nodes.push({ id: c.name, name: c.name });
            }
        });
    }

    // Save checkpoint: record the index and a content anchor of the last processed message.
    // The anchor (first 40 chars of the last message) lets us detect index drift
    // caused by message deletions or swipes, so we fall back to last-20 when stale.
    if (liveChat.length > 0) {
        var lastMsg = liveChat[liveChat.length - 1];
        relationshipData._checkpointMsgIdx = liveChat.length - 1;
        relationshipData._checkpointAnchor = (lastMsg && lastMsg.mes)
            ? String(lastMsg.mes).slice(0, 40)
            : "";
        relMsgCounter = 0; // reset the per-interval counter
        if (storyData) storyData._relMsgCount = 0;
    }
    relationshipData._initialized = true;
    trimRelationshipData();
    applyRelationshipDecay();
    saveRelationshipData();
    console.log("[Story Tracker] Relationship data saved. Edges:", relationshipData.edges.length);
}

// Trim relationship edges when they exceed the cap (100 max).
// Removes weakest edges first (by absolute strength), then oldest.
function trimRelationshipData() {
    if (!relationshipData || !relationshipData.edges) return;
    var MAX_EDGES = 100;
    if (relationshipData.edges.length <= MAX_EDGES) return;

    // Sort ascending by absolute strength so weakest get removed first
    relationshipData.edges.sort(function(a, b) {
        return Math.abs(a.strength || 0) - Math.abs(b.strength || 0);
    });
    relationshipData.edges = relationshipData.edges.slice(relationshipData.edges.length - MAX_EDGES);

    // Rebuild nodes to only include those still referenced by remaining edges
    var referencedNames = new Set();
    relationshipData.edges.forEach(function(e) {
        referencedNames.add(e.from);
        referencedNames.add(e.to);
    });
    relationshipData.nodes = (relationshipData.nodes || []).filter(function(n) {
        return referencedNames.has(n.name);
    });
    console.log("[Story Tracker] Relationship data trimmed to " + relationshipData.edges.length + " edges.");
}

// Nudge edges toward neutral when neither character has appeared in recent chat.
// Keeps the graph reflecting current story focus rather than freezing old bonds.
function applyRelationshipDecay() {
    if (!relationshipData || !relationshipData.edges || !relationshipData.edges.length) return;

    var liveChat = getLiveChat() || [];
    var recentMsgs = liveChat.slice(-25);
    var recentNames = new Set();
    var userName = (scriptModule && scriptModule.name1) ? scriptModule.name1 : "User";
    recentMsgs.forEach(function(msg) {
        var name = msg.is_user ? userName : (msg.name || "");
        if (name) recentNames.add(name);
    });

    var DECAY_RATE = 0.04;   // strength nudged this much per analysis pass
    var FLOOR = 0.05;         // don't decay below this absolute value (avoids zero-crossing oscillation)

    relationshipData.edges.forEach(function(edge) {
        // Only decay edges where both characters are absent from recent messages
        if (recentNames.has(edge.from) || recentNames.has(edge.to)) return;

        var s = edge.strength || 0;
        if (Math.abs(s) <= FLOOR) return;

        var direction = s > 0 ? -1 : 1;
        var newStrength = s + direction * DECAY_RATE;

        // Clamp: don't let decay push past zero
        if (s > 0 && newStrength < FLOOR) newStrength = FLOOR;
        if (s < 0 && newStrength > -FLOOR) newStrength = -FLOOR;

        edge.strength = parseFloat(newStrength.toFixed(2));
    });
}

async function runManualRelationshipAnalysis() {
    if (!settings.enabled) {
        if (typeof toastr !== "undefined") toastr.warning("Story Tracker is disabled. Enable it in the extension settings.");
        return;
    }
    if (relsBusy) return;
    if (anyBusy() && !relsBusy) {
        if (typeof toastr !== "undefined") toastr.warning("Another agent is running. Please wait.");
        return;
    }
    if (!settings.relationsEnabled) {
        if (typeof toastr !== "undefined") toastr.warning("Relationship Tracker is disabled. Enable it in settings first.");
        return;
    }
    if (!isChatOpen()) {
        if (typeof toastr !== "undefined") toastr.warning("Story Tracker: No active chat is open.");
        return;
    }

    loadRelationshipData();
    relsBusy = true;
    var $btn = $("#st-rel-btn-analyze").prop("disabled", true).html('<i class="fa-solid fa-spinner fa-spin"></i> Analyzing...');
    setHudStatus("Relations...");
    if (typeof toastr !== "undefined") toastr.info("Story Tracker: Analyzing relationships...", "", { timeOut: 0, extendedTimeOut: 0 });
    try {
        await doRelationshipUpdate();
        renderRelationshipGraph();
        renderHUD();
        clearHudStatus();
        if (typeof toastr !== "undefined") { toastr.clear(); toastr.success("Relationships analyzed!"); }
    } catch(e) {
        clearHudStatus();
        if (typeof toastr !== "undefined") { toastr.clear(); toastr.error("Relationship analysis failed: " + e.message); }
        console.error("[Story Tracker] Manual relationship analysis error:", e);
    } finally {
        relsBusy = false;
        $btn.prop("disabled", false).html('<i class="fa-solid fa-magnifying-glass-chart"></i> Analyze');
    }
}

// Compute force-directed node positions for the relationship graph.
function renderRelationshipGraph() {
    var $container = $("#st-rel-graph-container");
    if (!$container.length) return;

    try {
        if (!isChatOpen() || !relationshipData || !relationshipData._initialized ||
            !relationshipData.edges || relationshipData.edges.length === 0) {
            $container.html(
                '<div class="st-no-data" style="padding:30px 0;">' +
                '<i class="fa-solid fa-share-nodes"></i>' +
                '<div>No relationship data yet.</div>' +
                '<div style="font-size:11px;margin-top:6px;opacity:0.6;">Click Analyze to begin tracking.</div>' +
                '</div>'
            );
            return;
        }

        var edges = relationshipData.edges || [];
        var nodes = relationshipData.nodes || [];
        var typeColors = {
            romance:    "#ff69b4",
            friendship: "#4a9eff",
            family:     "#7dd67d",
            alliance:   "#b39ddb",
            rivalry:    "#ff8c00",
            hostile:    "#ff453a",
            mentor:     "#80deea",
            neutral:    "#888888"
        };

        var nodeMap = {};
        nodes.forEach(function(n) { if (n && n.name) nodeMap[n.name] = n; else if (n && n.id) nodeMap[n.id] = n; });
        edges.forEach(function(e) {
            if (!e) return;
            if (e.from && !nodeMap[e.from]) { var n1 = { id: e.from, name: e.from }; nodes.push(n1); nodeMap[e.from] = n1; }
            if (e.to && !nodeMap[e.to]) { var n2 = { id: e.to, name: e.to }; nodes.push(n2); nodeMap[e.to] = n2; }
        });

        var width = $container.width();
        if (!width || width < 100) width = 400; // Safeguard if tab is hidden during render
        var height = 260; 
        var cx = width / 2;
        var cy = height / 2;

        var simNodes = nodes.map(function(n, idx) {
            return {
                idx: idx,
                id: n.id || n.name,
                name: n.name || n.id || "?",
                x: cx + (Math.random() - 0.5) * 80,
                y: cy + (Math.random() - 0.5) * 80,
                vx: 0, vy: 0
            };
        });

        var simEdges = edges.map(function(e) {
            if (!e) return null;
            return {
                source: simNodes.find(function(sn) { return sn.id === e.from || sn.name === e.from; }),
                target: simNodes.find(function(sn) { return sn.id === e.to || sn.name === e.to; }),
                data: e
            };
        }).filter(function(e) { return e && e.source && e.target; });

        var iterations = 300;
        for (var i = 0; i < iterations; i++) {
            for (var a = 0; a < simNodes.length; a++) {
                for (var b = a + 1; b < simNodes.length; b++) {
                    var dx = simNodes[a].x - simNodes[b].x;
                    var dy = simNodes[a].y - simNodes[b].y;
                    var dist2 = dx * dx + dy * dy;
                    if (dist2 === 0) { dx = Math.random(); dy = Math.random(); dist2 = dx*dx + dy*dy; }
                    var dist = Math.sqrt(dist2);
                    var force = 3000 / (dist2 + 100); 
                    var fx = (dx / dist) * force;
                    var fy = (dy / dist) * force;
                    simNodes[a].vx += fx; simNodes[a].vy += fy;
                    simNodes[b].vx -= fx; simNodes[b].vy -= fy;
                }
                simNodes[a].vx += (cx - simNodes[a].x) * 0.02;
                simNodes[a].vy += (cy - simNodes[a].y) * 0.02;
            }

            for (var j = 0; j < simEdges.length; j++) {
                var edgeObj = simEdges[j];
                var sdx = edgeObj.target.x - edgeObj.source.x;
                var sdy = edgeObj.target.y - edgeObj.source.y;
                var sdist = Math.sqrt(sdx * sdx + sdy * sdy) || 1;
                var sforce = (sdist - 100) * 0.04;
                var sfx = (sdx / sdist) * sforce;
                var sfy = (sdy / sdist) * sforce;
                edgeObj.source.vx += sfx; edgeObj.source.vy += sfy;
                edgeObj.target.vx -= sfx; edgeObj.target.vy -= sfy;
            }

            for (var n = 0; n < simNodes.length; n++) {
                var sn = simNodes[n];
                sn.vx = Math.max(-20, Math.min(20, sn.vx));
                sn.vy = Math.max(-20, Math.min(20, sn.vy));
                sn.x += sn.vx;
                sn.y += sn.vy;
                sn.vx *= 0.6; 
                sn.vy *= 0.6;
                sn.x = Math.max(30, Math.min(width - 30, sn.x));
                sn.y = Math.max(30, Math.min(height - 40, sn.y));
            }
        }

        var html = '';
        var defaultDetail = '<i style="opacity: 0.6;">Hover or tap a character/connection to see details...</i>';
        
        html += '<div class="st-rel-legend">';
        Object.keys(typeColors).forEach(function(type) {
            html += '<div class="st-rel-legend-item"><span class="st-rel-legend-dot" style="background:'+typeColors[type]+'"></span>' + type + '</div>';
        });
        html += '</div>';

        html += '<svg width="100%" height="'+height+'" viewBox="0 0 '+width+' '+height+'" style="overflow:visible; user-select:none;">';
        
        html += '<g id="st-rel-edges">';
        simEdges.forEach(function(eObj, idx) {
            var eData = eObj.data || {};
            var color = typeColors[eData.type] || "#888";
            var thickness = 1.5 + (Math.abs(eData.strength || 0) * 3.5);
            html += '<line class="st-rel-edge" data-idx="' + idx + '" ' +
                    'x1="'+eObj.source.x+'" y1="'+eObj.source.y+'" ' +
                    'x2="'+eObj.target.x+'" y2="'+eObj.target.y+'" ' +
                    'stroke="'+color+'" stroke-width="'+thickness+'" stroke-linecap="round" ' +
                    'style="cursor:pointer; transition: opacity 0.2s, stroke-width 0.2s;" /> ';
        });
        html += '</g>';

        html += '<g id="st-rel-nodes">';
        simNodes.forEach(function(sn) {
            var initials = "?";
            if (sn.name) {
                var nStr = String(sn.name).trim();
                var parts = nStr.split(/\s+/);
                if (parts.length >= 2) initials = (parts[0].charAt(0) + parts[1].charAt(0)).toUpperCase();
                else if (nStr.length > 0) initials = nStr.substring(0, 2).toUpperCase();
            }

            html += '<g class="st-rel-node" data-nidx="'+sn.idx+'" style="cursor:pointer; transition: opacity 0.2s; transform: translate('+sn.x+'px, '+sn.y+'px);">';
            html += '<circle r="16" fill="#242421" stroke="var(--st-custom-accent)" stroke-width="2" />';
            html += '<text y="4" text-anchor="middle" fill="#fff" font-size="11px" font-weight="bold" font-family="sans-serif">'+esc(initials)+'</text>';
            html += '<text y="28" text-anchor="middle" fill="var(--st-journal-text)" font-size="11px" font-family="sans-serif" font-weight="600" style="pointer-events:none;">'+esc(sn.name)+'</text>';
            html += '</g>';
        });
        html += '</g></svg>';

        html += '<div class="st-rel-detail" id="st-rel-detail-panel" style="min-height:55px; margin-top:10px;">';
        html += defaultDetail;
        html += '</div>';

        $container.html(html);

        var $detail = $container.find("#st-rel-detail-panel");

        $container.find('.st-rel-edge').on('mouseenter click', function(e) {
            e.stopPropagation();
            var idx = $(this).data("idx");
            if (idx === undefined || !simEdges[idx]) return;
            var edgeObj = simEdges[idx];
            var eData = edgeObj.data;
            
            $container.find('.st-rel-edge').css('opacity', '0.15');
            $(this).css('opacity', '1');
            $container.find('.st-rel-node').css('opacity', '0.15');
            $container.find('.st-rel-node[data-nidx="'+edgeObj.source.idx+'"]').css('opacity', '1');
            $container.find('.st-rel-node[data-nidx="'+edgeObj.target.idx+'"]').css('opacity', '1');

            var sign = (eData.strength || 0) >= 0 ? "+" : "";
            var strengthVal = (eData.strength || 0).toFixed(2);
            var dHtml = '<div style="margin-bottom:6px;"><strong style="color:var(--st-custom-accent)">' + esc(eData.from) + ' ↔ ' + esc(eData.to) + '</strong></div>';
            dHtml += '<div style="margin-bottom:4px; font-size:11px;"><span style="color:'+(typeColors[eData.type]||'#888')+'">● ' + esc(eData.type||'neutral') + '</span> (Strength: ' + sign + strengthVal + ')</div>';
            if (eData.summary) dHtml += '<div style="opacity:0.9; margin-bottom:4px; font-size:11px; line-height: 1.4;">' + esc(eData.summary) + '</div>';
            if (eData.change && eData.change !== "Stable") dHtml += '<div style="opacity:0.75; font-style:italic; font-size:11px;">↗ ' + esc(eData.change) + '</div>';

            $detail.html(dHtml);
        });

        $container.find('.st-rel-node').on('mouseenter click', function(e) {
            e.stopPropagation();
            var nidx = $(this).data("nidx");
            if (nidx === undefined || !simNodes[nidx]) return;
            var nodeObj = simNodes[nidx];
            
            var connectedEdges = simEdges.filter(function(eObj) { 
                return eObj.source.idx === nodeObj.idx || eObj.target.idx === nodeObj.idx; 
            });
            var connectedNodeIdxs = new Set([nodeObj.idx]);
            connectedEdges.forEach(function(eObj) { 
                connectedNodeIdxs.add(eObj.source.idx); 
                connectedNodeIdxs.add(eObj.target.idx); 
            });

            $container.find('.st-rel-node').each(function() {
                var thisIdx = $(this).data('nidx');
                if (!connectedNodeIdxs.has(thisIdx)) $(this).css('opacity', '0.15');
                else $(this).css('opacity', '1');
            });
            $container.find('.st-rel-edge').each(function() {
                var thisIdx = $(this).data('idx');
                var eObj = simEdges[thisIdx];
                if (eObj && eObj.source.idx !== nodeObj.idx && eObj.target.idx !== nodeObj.idx) {
                    $(this).css('opacity', '0.15');
                } else {
                    $(this).css('opacity', '1');
                }
            });

            var dHtml = '<div style="margin-bottom:6px;"><strong style="color:var(--st-custom-accent)">' + esc(nodeObj.name) + '\'s Connections</strong></div>';
            if (connectedEdges.length === 0) {
                dHtml += '<div style="opacity:0.8; font-size:11px;">No known connections.</div>';
            } else {
                dHtml += '<div style="display:flex; flex-direction:column; gap:6px; max-height:100px; overflow-y:auto; padding-right:5px;">';
                connectedEdges.sort(function(a, b) { return Math.abs(b.data.strength||0) - Math.abs(a.data.strength||0); });
                connectedEdges.forEach(function(eObj) {
                    var e = eObj.data;
                    var otherName = (eObj.source.idx === nodeObj.idx) ? eObj.target.name : eObj.source.name;
                    var sign = (e.strength || 0) >= 0 ? "+" : "";
                    var color = typeColors[e.type] || "#888";
                    dHtml += '<div style="font-size:11px; line-height: 1.3;">';
                    dHtml += '<strong style="color:#fff;">' + esc(otherName) + ':</strong> ';
                    dHtml += '<span style="color:'+color+'">' + esc(e.type) + '</span> ';
                    dHtml += '(' + sign + (e.strength||0).toFixed(1) + ')<br>';
                    if (e.summary) dHtml += '<span style="opacity:0.8;">' + esc(e.summary) + '</span>';
                    dHtml += '</div>';
                });
                dHtml += '</div>';
            }
            $detail.html(dHtml);
        });

        // Click outside elements to restore layout
        $container.on('mouseleave click', function() {
            $container.find('.st-rel-edge').css('opacity', '1');
            $container.find('.st-rel-node').css('opacity', '1');
            $detail.html(defaultDetail);
        });

    } catch (err) {
        console.error("[Story Tracker] Error rendering relationship graph:", err);
        $container.html('<div class="st-no-data">Failed to render graph. Please check the console.</div>');
    }
}

// --- HUD ---
function setHudStatus(label) {
    // Swap book icon for spinner; hide text label (looks clean in both collapsed and expanded states)
    $("#st-hud .fa-book-open-reader").removeClass("fa-book-open-reader").addClass("fa-spinner fa-spin st-hud-was-book");
    $("#st-hud-status").hide(); // text label hidden always - spinner icon is enough
    $("#st-hud").addClass("st-hud-busy");
}

function clearHudStatus() {
    $("#st-hud .fa-spinner.st-hud-was-book").removeClass("fa-spinner fa-spin st-hud-was-book").addClass("fa-book-open-reader");
    $("#st-hud-status").hide().html("");
    $("#st-hud").removeClass("st-hud-busy");
}

function buildHUD() {
    if (document.getElementById("st-hud")) return;
    let h = `<div id="st-hud" class="st-hud st-hud-collapsed">
        <div class="st-hud-head">
            <i class="fa-solid fa-book-open-reader"></i>
            <span class="st-hud-head-text" style="margin-left: 6px;">Tracker</span>
            <span id="st-hud-status" style="margin-left:6px;font-size:9px;opacity:.75;display:none;"></span>
            <i style="margin-left:auto" class="fa-solid fa-chevron-up"></i>
        </div>
        <div class="st-hud-body" id="st-hud-body"></div>
    </div>`;
    document.body.insertAdjacentHTML("beforeend", h);
    
    $(document).on("click", ".st-hud-head", function() { 
        if ($("#st-hud").attr("data-dragging") === "true") return;
        $("#st-hud").toggleClass("st-hud-collapsed"); 
    });
    $(document).on("click", "#st-hud-body", function() { 
        if ($("#st-hud").attr("data-dragging") === "true") return;
        loadStoryData(); renderModal(); $("#st-modal").fadeIn(150); 
    });

    var hudEl = document.getElementById("st-hud");
    makeHudDraggable(hudEl);

    renderHUD();
}

function applyHudStyle() {
    var $h = $("#st-hud");
    if (!$h.length) return;

    var scale  = (settings.hudScale || 100) / 100;
    var origin = "top right";

    if (settings.hudLeft !== null && settings.hudTop !== null) {
        // Restore from raw CSS pixel coords — no percentage math, no scale distortion
        var clamped = clampHudPosition(settings.hudLeft, settings.hudTop);

        $h.css({
            "left":   clamped.x + "px",
            "top":    clamped.y + "px",
            "right":  "auto",
            "bottom": "auto"
        });

        // Adjust transform-origin so the scale grows toward the nearest corner
        var oX = (clamped.x + ($h.outerWidth()  || 0) / 2) > window.innerWidth  / 2 ? "right" : "left";
        var oY = (clamped.y + ($h.outerHeight() || 0) / 2) > window.innerHeight / 2 ? "bottom" : "top";
        origin = oY + " " + oX;
    } else {
        // No saved position — let the stylesheet decide (bottom-right corner etc.)
        $h.css({ "left": "", "top": "", "right": "", "bottom": "" });
    }

    $h.css({ "transform": "scale(" + scale + ")", "transform-origin": origin });
}

// --- Draggable Handler ---
function makeHudDraggable(el) {
    let isDragging = false;
    let startX, startY, initialX, initialY;

    const onDown = (e) => {
        if (e.target.closest && e.target.closest('button, input, select, textarea, a, .st-hud-body')) return;

        const clientX = e.clientX !== undefined ? e.clientX : (e.touches && e.touches[0] ? e.touches[0].clientX : undefined);
        const clientY = e.clientY !== undefined ? e.clientY : (e.touches && e.touches[0] ? e.touches[0].clientY : undefined);
        if (clientX === undefined) return;

        isDragging = false;
        el.removeAttribute('data-dragging');
        startX = clientX;
        startY = clientY;

        const rect = el.getBoundingClientRect();
        initialX = rect.left;
        initialY = rect.top;

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        document.addEventListener('touchmove', onMove, { passive: false });
        document.addEventListener('touchend', onUp);
    };

    const onMove = (e) => {
        const clientX = e.clientX !== undefined ? e.clientX : (e.touches && e.touches[0] ? e.touches[0].clientX : undefined);
        const clientY = e.clientY !== undefined ? e.clientY : (e.touches && e.touches[0] ? e.touches[0].clientY : undefined);
        if (clientX === undefined) return;

        const dx = clientX - startX;
        const dy = clientY - startY;

        if (!isDragging && Math.sqrt(dx * dx + dy * dy) > 5) {
            isDragging = true;
            el.setAttribute('data-dragging', 'true');
        }

        if (isDragging) {
            e.preventDefault();
            var clamped = clampHudPosition(initialX + dx, initialY + dy);
            el.style.left   = clamped.x + 'px';
            el.style.top    = clamped.y + 'px';
            el.style.right  = 'auto';
            el.style.bottom = 'auto';
        }
    };

    const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.removeEventListener('touchmove', onMove);
        document.removeEventListener('touchend', onUp);

        if (isDragging) {
            settings.hudLeft = parseFloat(el.style.left) || 0;
            settings.hudTop  = parseFloat(el.style.top)  || 0;
            save();
            applyHudStyle();
        }

        setTimeout(function() {
            isDragging = false;
            el.removeAttribute('data-dragging');
        }, 50);
    };

    el.addEventListener('mousedown', onDown);
    el.addEventListener('touchstart', onDown, { passive: true });

    // Re-clamp the saved position on window resize
    window.addEventListener('resize', function() {
        if (settings.hudLeft === null || settings.hudTop === null) return;
        var clamped = clampHudPosition(settings.hudLeft, settings.hudTop);
        if (clamped.x !== settings.hudLeft || clamped.y !== settings.hudTop) {
            settings.hudLeft = clamped.x;
            settings.hudTop  = clamped.y;
            el.style.left = clamped.x + 'px';
            el.style.top  = clamped.y + 'px';
            save();
        }
    });
}

function renderHUD() {
    $("#st-hud").toggle(settings.showHUD);
    applyHudStyle();

    if (!isChatOpen() || !storyData || !storyData._initialized) {
        $("#st-hud-body").html("<div style='text-align:center;opacity:.5;font-size:10px;'>Waiting...</div>"); return;
    }
    let dow = getDayOfWeek(storyData.date);
    let dowStr = dow ? ` &nbsp;<i class="fa-solid fa-calendar-day"></i> ${dow}` : "";
    let h = `<div class="st-hud-row"><i class="fa-solid fa-clock"></i> <strong>${storyData.time}</strong> &nbsp; <i class="fa-solid fa-calendar"></i> ${storyData.date}${dowStr}</div>`;
    h += `<div class="st-hud-row"><i class="fa-solid fa-location-dot"></i> ${esc(storyData.location)}</div>`;
    if (settings.showCityCountry) {
        let city = storyData.city || "";
        let country = storyData.country || "";
        let ccText = [city, country].filter(v => v && v !== "Unknown").join(", ");
        if (ccText) h += `<div class="st-hud-row"><i class="fa-solid fa-earth-europe"></i> ${esc(ccText)}</div>`;
    }
    if (storyData.temperature || storyData.weather) {
        let wIcon = "fa-cloud-sun";
        let w = (storyData.weather || "").toLowerCase();
        if (w.includes("rain") || w.includes("дожд")) wIcon = "fa-cloud-rain";
        else if (w.includes("snow") || w.includes("снег")) wIcon = "fa-snowflake";
        else if (w.includes("storm") || w.includes("гроз")) wIcon = "fa-bolt";
        else if (w.includes("fog") || w.includes("туман")) wIcon = "fa-smog";
        else if (w.includes("clear") || w.includes("ясн") || w.includes("солн")) wIcon = "fa-sun";
        else if (w.includes("cloud") || w.includes("облач")) wIcon = "fa-cloud";
        let tempStr = storyData.temperature && storyData.temperature !== "Unknown" ? `<strong>${esc(storyData.temperature)}</strong>` : "";
        let weatherStr = storyData.weather && storyData.weather !== "Unknown" ? esc(storyData.weather) : "";
        let sep = tempStr && weatherStr ? " &nbsp; " : "";
        h += `<div class="st-hud-row"><i class="fa-solid ${wIcon}"></i> ${tempStr}${sep}${weatherStr}</div>`;
    }
    h += `<hr style="border-color:rgba(255,255,255,0.05);margin:5px 0;">`;
    
    var hudOutfit = getInventoryOutfit();
    var hudUserName = (scriptModule && scriptModule.name1) ? scriptModule.name1 : null;

    if (storyData.characters) {
        storyData.characters.slice(0, 3).forEach(c => {
            var hudStateText = c.state;

            if (hudOutfit && hudOutfit.userEquipped.length > 0) {
                var isUser = (hudUserName && c.name.toLowerCase() === hudUserName.toLowerCase()) ||
                             c.name.toLowerCase() === "вы" ||
                             c.name === "{{user}}";
                if (isUser) {
                    var wearNames = hudOutfit.userEquipped.map(function(it) { return it.name; }).join(", ");
                    hudStateText += ", wearing " + wearNames;
                }
            }

            if (hudOutfit && hudOutfit.charItems.length > 0) {
                var hudHeld = hudOutfit.charItems.filter(ci => ci.heldBy && ci.heldBy.toLowerCase() === c.name.toLowerCase());
                if (hudHeld.length > 0) {
                    var heldNames = hudHeld.map(function(ci) { return ci.name; }).join(", ");
                    hudStateText += ", holding " + heldNames;
                }
            }

            h += '<div class="st-hud-char"><span class="st-hud-char-name">' + esc(c.name) + ':</span> ' + esc(hudStateText) + '</div>';
        });
        if (storyData.characters.length > 3) h += '<div style="font-size:9px;opacity:0.5;text-align:center;margin-top:2px;">+ ' + (storyData.characters.length - 3) + ' more</div>';
    }

    // --- World Summary Section (Only show the summary, no events) ---
    if (settings.worldEnabled && worldData && worldData.worldSummary && worldData.worldSummary.trim() !== "") {
        h += `<hr style="border-color:rgba(255,255,255,0.05);margin:5px 0;">`;
        h += `<div style="font-size:9.5px;font-weight:bold;opacity:0.8;margin-bottom:3px;"><i class="fa-solid fa-earth-americas"></i> World Progression:</div>`;
        h += `<div class="st-hud-char" style="font-size:9px;line-height:1.2;margin-bottom:3px;white-space:normal;opacity:0.9;font-style:italic;">${esc(worldData.worldSummary)}</div>`;
    }

    // --- Relationship signal: single most-shifted bond since last analysis ---
    if (settings.relationsEnabled && relationshipData && relationshipData._initialized &&
        relationshipData.edges && relationshipData.edges.length > 0) {
        var relTypeColors = { romance:"#ff69b4", friendship:"#4a9eff", family:"#7dd67d", alliance:"#b39ddb", rivalry:"#ff8c00", hostile:"#ff453a", mentor:"#80deea", neutral:"#888" };
        var mostChanged = null, biggestDelta = 0;
        relationshipData.edges.forEach(function(edge) {
            if (edge.history && edge.history.length > 0) {
                var delta = Math.abs((edge.strength || 0) - (edge.history[0].strength || 0));
                if (delta > biggestDelta) { biggestDelta = delta; mostChanged = edge; }
            }
        });
        // Fall back to highest absolute strength edge if no history exists yet
        if (!mostChanged) {
            relationshipData.edges.forEach(function(edge) {
                var s = Math.abs(edge.strength || 0);
                if (s > biggestDelta) { biggestDelta = s; mostChanged = edge; }
            });
        }
        if (mostChanged) {
            var relColor = relTypeColors[mostChanged.type] || "#888";
            var arrow = mostChanged.history && mostChanged.history.length > 0
                ? ((mostChanged.strength || 0) > (mostChanged.history[0].strength || 0) ? "\u2197" : "\u2198")
                : "";
            h += '<hr style="border-color:rgba(255,255,255,0.05);margin:5px 0;">';
            h += '<div class="st-hud-char" style="font-size:9px;border-left-color:' + relColor + ';white-space:normal;">' +
                 '<i class="fa-solid fa-share-nodes" style="color:' + relColor + ';margin-right:3px;"></i>' +
                 '<span style="color:' + relColor + ';font-weight:600;">' + esc(mostChanged.from) + ' \u2194 ' + esc(mostChanged.to) + '</span>' +
                 (arrow ? ' <span style="opacity:0.75;">' + arrow + ' ' + esc(mostChanged.type) + '</span>' : ' <span style="opacity:0.75;">' + esc(mostChanged.type) + '</span>') +
                 '</div>';
        }
    }

    $("#st-hud-body").html(h);
}

// --- Chat Button ---
function buildChatButton() {
    if (!document.getElementById("st-trigger")) {
        var btn = '<div id="st-trigger" class="st-trigger interactable" title="Story Tracker"><i class="fa-solid fa-book-open-reader"></i></div>';
        var $l = $("#leftSendForm"); if ($l.length) $l.append(btn); else $("#send_form").prepend(btn);
        $(document).on("click", "#st-trigger", function() { loadStoryData(); renderModal(); $("#st-modal").fadeIn(150); updateSettingsUI(); });
    }
    toggleChatButtonVisibility();
}

// --- Settings UI ---
function buildSettingsPanel() {
    var $c = $("#extensions_settings2"); if (!$c.length) $c = $("#extensions_settings"); if (!$c.length) return;
    var h = '<div class="inline-drawer"><div class="inline-drawer-toggle inline-drawer-header"><b><i class="fa-solid fa-book-open-reader"></i> Story Tracker</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div><div class="inline-drawer-content">';
    h += '<div class="da-srow"><label class="checkbox_label"><input type="checkbox" id="st-s-on"><span>Enable Extension</span></label></div>';
    
    h += '<div class="da-srow"><label class="checkbox_label"><input type="checkbox" id="st-s-hud"><span>Show HUD Widget</span></label></div>';
    h += '<div class="da-srow" id="st-scale-row"><label><small>HUD Scale: <span id="st-scale-val"></span>%</small></label><input type="range" id="st-s-scale" min="50" max="200" step="5"></div>';
    
    h += '<hr><div class="da-srow"><label class="checkbox_label"><input type="checkbox" id="st-s-chatbtn"><span>Show Icon in Chat Panel</span></label></div>';
    
    h += '<hr><div class="da-srow"><label class="checkbox_label"><input type="checkbox" id="st-s-auto"><span>Auto-update LLM Scene</span></label></div>';
    h += '<div class="da-srow"><label><small>Update every N msgs: <span id="st-interval-val"></span></small></label><input type="range" id="st-s-interval" min="1" max="20" step="1"></div>';
    h += '<hr><div class="da-srow"><label class="checkbox_label"><input type="checkbox" id="st-s-inject"><span>Inject Context into Prompt (Reduces Amnesia)</span></label></div>';
    h += '<div class="da-srow"><label class="checkbox_label"><input type="checkbox" id="st-s-cityctry"><span>Show City / Country (LLM infers or invents)</span></label></div>';

    // RGB Highlight Colors
    h += '<hr><div class="da-srow"><b>Accent Highlight Color (RGB)</b></div>';
    h += '<div class="da-srow"><small style="opacity:.7">Adjust sliders to customize key titles, icons, and card highlights to match your theme.</small></div>';
    h += '<div class="da-srow"><label><small>Red: <span id="st-rgb-r-val">' + settings.accentR + '</span></small></label><input type="range" id="st-s-rgb-r" min="0" max="255" step="1" value="' + settings.accentR + '"></div>';
    h += '<div class="da-srow"><label><small>Green: <span id="st-rgb-g-val">' + settings.accentG + '</span></small></label><input type="range" id="st-s-rgb-g" min="0" max="255" step="1" value="' + settings.accentG + '"></div>';
    h += '<div class="da-srow"><label><small>Blue: <span id="st-rgb-b-val">' + settings.accentB + '</span></small></label><input type="range" id="st-s-rgb-b" min="0" max="255" step="1" value="' + settings.accentB + '"></div>';
    h += '<div class="da-srow" style="display:flex; align-items:center; gap:8px;"><small>Preview Color:</small> <span id="st-rgb-preview" style="display:inline-block; width:20px; height:20px; border-radius:50%; border:1px solid rgba(255,255,255,0.2);"></span></div>';

    h += '<hr><div class="da-srow"><label class="checkbox_label"><input type="checkbox" id="st-s-useprofile"><span>Use a separate Connection Profile for analysis</span></label></div>';
    h += '<div class="da-srow" id="st-profile-row"><label><small>Analysis Profile:</small></label>';
    h += '<div style="display:flex;gap:5px;align-items:center;"><select id="st-s-profile" class="text_pole" style="flex:1"></select>';
    h += '<button class="menu_button" id="st-s-profile-refresh" title="Refresh profile list" style="flex:0 0 auto;"><i class="fa-solid fa-rotate"></i></button></div></div>';

    // Post-response delay slider
    h += '<hr><div class="da-srow"><b>Timing</b></div>';
    h += '<div class="da-srow"><small style="opacity:.7">Delay before extension starts after a response. Increase on slow devices (e.g. Termux) if you get concurrent request errors.</small></div>';
    h += '<div class="da-srow"><label><small>Post-response delay: <span id="st-s-delay-val"></span>ms</small></label><input type="range" id="st-s-startup-delay" min="500" max="8000" step="500"></div>';

    // World Agent Settings Element Bindings
    h += '<hr><div class="da-srow"><b>World Progression Settings</b></div>';
    h += '<div class="da-srow"><label class="checkbox_label"><input type="checkbox" id="st-s-world-on"><span>Enable World Agent</span></label></div>';
    h += '<div class="da-srow"><label class="checkbox_label"><input type="checkbox" id="st-s-world-inject"><span>Inject World Context</span></label></div>';
    h += '<div class="da-srow"><label class="checkbox_label"><input type="checkbox" id="st-s-world-useprofile"><span>Use Separate Connection Profile</span></label></div>';
    
    h += '<div class="da-srow" id="st-world-profile-row"><label><small>Analysis Profile:</small></label>';
    h += '<div style="display:flex;gap:5px;align-items:center;"><select id="st-s-world-profile" class="text_pole" style="flex:1"></select>';
    h += '<button class="menu_button" id="st-s-world-profile-refresh" title="Refresh profile list" style="flex:0 0 auto;"><i class="fa-solid fa-rotate"></i></button></div></div>';

    h += '<div class="da-srow"><label><small>World Tick Frequency:</small></label>';
    h += '<select id="st-s-world-freq" class="text_pole" style="width:100%">' +
         '<option value="1h">Every RP Hour</option>' +
         '<option value="3h">Every 3 RP Hours</option>' +
         '<option value="1d">Every RP Day</option>' +
         '<option value="manual">Manual Only</option>' +
         '</select></div>';

    h += '<div class="da-srow" id="st-max-ticks-row"><label><small>Maximum Tick Catchup: <span id="st-max-ticks-val"></span></small></label>' +
         '<input type="range" id="st-s-max-ticks" min="1" max="24" step="1"></div>';

    // Relationship Tracker Settings
    h += '<hr><div class="da-srow"><b>Relationship Tracker</b></div>';
    h += '<div class="da-srow"><small style="opacity:.7">Tracks character bonds and how they evolve. Runs on its own message interval using checkpoints \u2014 only new messages since the last analysis are sent each time.</small></div>';
    h += '<div class="da-srow"><label class="checkbox_label"><input type="checkbox" id="st-s-rel-on"><span>Enable Relationship Tracker</span></label></div>';
    h += '<div class="da-srow"><label class="checkbox_label"><input type="checkbox" id="st-s-rel-auto"><span>Auto-analyze on interval</span></label></div>';
    h += '<div class="da-srow" id="st-rel-interval-row"><label><small>Analyze every N messages: <span id="st-rel-interval-val"></span></small></label><input type="range" id="st-s-rel-interval" min="1" max="20" step="1"></div>';
    h += '<div class="da-srow"><label class="checkbox_label"><input type="checkbox" id="st-s-rel-useprofile"><span>Use Separate Connection Profile</span></label></div>';
    h += '<div class="da-srow" id="st-rel-profile-row"><label><small>Relationship Profile:</small></label>';
    h += '<div style="display:flex;gap:5px;align-items:center;"><select id="st-s-rel-profile" class="text_pole" style="flex:1"></select>';
    h += '<button class="menu_button" id="st-s-rel-profile-refresh" title="Refresh profile list" style="flex:0 0 auto;"><i class="fa-solid fa-rotate"></i></button></div></div>';
    h += '<div class="da-srow"><label class="checkbox_label"><input type="checkbox" id="st-s-rel-inject"><span>Inject Relationship Context into Prompts</span></label></div>';

    h += '<hr><div class="da-srow da-srow-btns"><input type="button" class="menu_button" id="st-s-open" value="Open Tracker"></div></div></div>';
    $c.append(h);

    $("#st-s-on").prop("checked", settings.enabled).on("change", function() { 
        settings.enabled = this.checked; save(); renderHUD(); toggleChatButtonVisibility();
    });
    
    $("#st-s-hud").prop("checked", settings.showHUD).on("change", function() { 
        settings.showHUD = this.checked; save(); renderHUD(); 
        $("#st-scale-row").toggle(this.checked);
    });
    $("#st-scale-row").toggle(settings.showHUD);
    
    $("#st-s-scale").val(settings.hudScale).on("input", function() { 
        settings.hudScale = parseInt(this.value, 10); 
        $("#st-scale-val").text(this.value); 
        save(); 
        applyHudStyle(); 
    });
    $("#st-scale-val").text(settings.hudScale);
    
    $("#st-s-chatbtn").prop("checked", settings.showChatButton).on("change", function() {
        settings.showChatButton = this.checked; 
        save(); 
        toggleChatButtonVisibility(); 
    });
    
    $("#st-s-auto").on("change", function() { 
        let val = this.checked;
        if (storyData) {
            storyData.autoUpdate = val;
            saveStoryData();
        }
        settings.autoUpdate = val; // Also acts as default for future chats
        save(); 
        renderModal(); 
    });

    // Initialize the slider's default value and label value from settings, then bind the input event
    $("#st-s-interval").val(settings.autoUpdateInterval).on("input", function() { 
        let val = parseInt(this.value, 10); 
        $("#st-interval-val").text(val); 
        if (storyData) {
            storyData.autoUpdateInterval = val;
            saveStoryData();
        }
        settings.autoUpdateInterval = val; // Also acts as default for future chats
        save(); 
        renderModal(); 
    });
    $("#st-interval-val").text(settings.autoUpdateInterval);
    
    $("#st-s-inject").prop("checked", settings.injectToContext).on("change", function() { settings.injectToContext = this.checked; save(); });
    $("#st-s-cityctry").prop("checked", settings.showCityCountry).on("change", function() { settings.showCityCountry = this.checked; save(); renderModal(); renderHUD(); });

    // RGB Slider Bindings
    $("#st-s-rgb-r").on("input", function() {
        settings.accentR = parseInt(this.value, 10);
        $("#st-rgb-r-val").text(this.value);
        save();
        applyCustomAccentColor();
    });
    $("#st-s-rgb-g").on("input", function() {
        settings.accentG = parseInt(this.value, 10);
        $("#st-rgb-g-val").text(this.value);
        save();
        applyCustomAccentColor();
    });
    $("#st-s-rgb-b").on("input", function() {
        settings.accentB = parseInt(this.value, 10);
        $("#st-rgb-b-val").text(this.value);
        save();
        applyCustomAccentColor();
    });

    $("#st-s-useprofile").prop("checked", settings.useConnectionProfile).on("change", function() {
        settings.useConnectionProfile = this.checked;
        save();
        $("#st-profile-row").toggle(this.checked);
    });
    $("#st-profile-row").toggle(settings.useConnectionProfile);
    // Save the selected scene analysis profile whenever it changes
    $("#st-s-profile").on("change", function() { settings.connectionProfile = this.value; save(); });
    $("#st-s-profile-refresh").on("click", function() {
        populateProfileDropdown();
        if (typeof toastr !== "undefined") toastr.info("Connection profile list refreshed.");
    });

    // World Agent Settings Element Bindings
    $("#st-s-world-on").prop("checked", settings.worldEnabled).on("change", function() {
        settings.worldEnabled = this.checked; save(); renderHUD(); renderModal();
    });
    $("#st-s-world-inject").prop("checked", settings.injectWorldContext).on("change", function() {
        settings.injectWorldContext = this.checked; save();
    });
    $("#st-s-world-useprofile").prop("checked", settings.useWorldProfile).on("change", function() {
        settings.useWorldProfile = this.checked; save();
        $("#st-world-profile-row").toggle(settings.useWorldProfile);
    });
    $("#st-world-profile-row").toggle(settings.useWorldProfile);

    $("#st-s-world-profile").on("change", function() { settings.worldConnectionProfile = this.value; save(); });
    $("#st-s-world-profile-refresh").on("click", function() {
        populateProfileDropdown();
        if (typeof toastr !== "undefined") toastr.info("Connection profile list refreshed.");
    });

    $("#st-s-world-freq").val(settings.worldTickFrequency).on("change", function() {
        settings.worldTickFrequency = this.value; save();
    });

    $("#st-s-max-ticks").val(settings.maxWorldTicks).on("input", function() {
        settings.maxWorldTicks = parseInt(this.value, 10);
        $("#st-max-ticks-val").text(this.value);
        save();
    });
    $("#st-max-ticks-val").text(settings.maxWorldTicks);

    // Relationship Tracker Settings Element Bindings
    $("#st-s-rel-on").prop("checked", settings.relationsEnabled).on("change", function() {
        settings.relationsEnabled = this.checked; save(); renderHUD(); renderModal();
    });
    $("#st-s-rel-auto").prop("checked", settings.relationsAutoUpdate).on("change", function() {
        settings.relationsAutoUpdate = this.checked; save();
        $("#st-rel-interval-row").toggle(this.checked);
    });
    $("#st-rel-interval-row").toggle(settings.relationsAutoUpdate);
    $("#st-s-rel-interval").val(settings.relAutoInterval || 5).on("input", function() {
        settings.relAutoInterval = parseInt(this.value, 10);
        $("#st-rel-interval-val").text(this.value);
        save();
    });
    $("#st-rel-interval-val").text(settings.relAutoInterval || 5);
    $("#st-s-rel-useprofile").prop("checked", settings.useRelProfile).on("change", function() {
        settings.useRelProfile = this.checked; save();
        $("#st-rel-profile-row").toggle(this.checked);
    });
    $("#st-rel-profile-row").toggle(settings.useRelProfile);
    $("#st-s-rel-profile").on("change", function() { settings.relConnectionProfile = this.value; save(); });
    $("#st-s-rel-profile-refresh").on("click", function() {
        populateProfileDropdown();
        if (typeof toastr !== "undefined") toastr.info("Connection profile list refreshed.");
    });
    $("#st-s-rel-inject").prop("checked", settings.injectRelationsContext).on("change", function() {
        settings.injectRelationsContext = this.checked; save();
        if (settings.enabled && settings.injectToContext) injectContextToChat();
    });

    populateProfileDropdown();

    $("#st-s-open").on("click", function() { loadStoryData(); renderModal(); $("#st-modal").fadeIn(150); });

    updateSettingsUI();
}

function toggleChatButtonVisibility() {
    var $trigger = $("#st-trigger");
    if ($trigger.length) {
        if (settings.enabled && settings.showChatButton) {
            $trigger.show();
        } else {
            $trigger.hide();
        }
    }
}

// --- Check and Run World Ticks ---
function checkAndRunWorldTicks() {
    if (!settings.worldEnabled || anyBusy() || !worldData || !storyData || !storyData._initialized) return;

    var curTime = storyData.time;
    var curDate = storyData.date;

    var curDateObj = parseRpDateTime(curTime, curDate);
    if (!curDateObj) return;

    var lastTime = worldData.lastTickTime;
    var lastDate = worldData.lastTickDate;

    if (!lastTime || !lastDate) {
        // First tick baseline setup
        worldData.lastTickTime = curTime;
        worldData.lastTickDate = curDate;
        saveWorldData();
        return;
    }

    var lastDateObj = parseRpDateTime(lastTime, lastDate);
    if (!lastDateObj) return;

    var diffMs = curDateObj.getTime() - lastDateObj.getTime();
    if (diffMs <= 0) return;

    var diffHours = diffMs / (1000 * 60 * 60);

    var thresholdHours = 1;
    if (settings.worldTickFrequency === "3h") thresholdHours = 3;
    else if (settings.worldTickFrequency === "1d") thresholdHours = 24;
    else if (settings.worldTickFrequency === "manual") return; 

    if (diffHours >= thresholdHours) {
        var ticksToRun = Math.floor(diffHours / thresholdHours);
        if (ticksToRun > settings.maxWorldTicks) {
            ticksToRun = settings.maxWorldTicks; 
        }

        console.log(`[Story Tracker] Time progression detected (${diffHours.toFixed(2)}h). Running ${ticksToRun} World Agent tick(s).`);

        (async function() {
            worldBusy = true;
            try {
                for (var i = 0; i < ticksToRun; i++) {
                    // Back-calculate tick timestamps to step chronologically
                    var tickTimeOffsetMs = (i + 1) * thresholdHours * 60 * 60 * 1000;
                    var tickDateObj = new Date(lastDateObj.getTime() + tickTimeOffsetMs);
                    
                    var tickTimeStr = padZero(tickDateObj.getHours()) + ":" + padZero(tickDateObj.getMinutes());
                    var tickDateStr = padZero(tickDateObj.getDate()) + "/" + padZero(tickDateObj.getMonth() + 1) + "/" + tickDateObj.getFullYear();

                    await runSingleWorldTick(tickTimeStr, tickDateStr);
                }
                renderModal(); renderHUD();
                if (typeof toastr !== "undefined") toastr.info(`World simulated: ${ticksToRun} tick(s) processed.`);

            } catch(e) {
                console.error("[Story Tracker] World tick evaluation crashed:", e);
            } finally {
                worldBusy = false;
            }
        })();
    }
}
