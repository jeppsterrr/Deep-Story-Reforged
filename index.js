/*
 * Story Tracker — SillyTavern Extension
 * Keeps track of Time, Date, Location, Character Positions, and Recent Events.
 * Reduces amnesia by injecting scene context into LLM prompts.
 */

var MODULE = "story-tracker";
var DATA_KEY = "story_tracker_data";

// --- Prompts ---
var UPDATE_PROMPT = 
    "[OOC: You are a narrative assistant. Analyze the roleplay chat so far and determine the current scene context.\n\n" +
    "1. TIMELINE & LOCATION: Deduce the current Time (HH:MM), Date (DD/MM/YYYY or similar format), specific Location, current Temperature (e.g. '18°C' or '64°F'), and Weather conditions (e.g. 'Clear', 'Rainy', 'Overcast', 'Snowing', 'Stormy', 'Hot', 'Foggy'). If indoors or weather is unspecified, infer from context or write 'Unknown'. Time MUST progress logically based on recent actions.\n" +
    "2. CITY & COUNTRY — MANDATORY, NEVER USE 'Unknown': You MUST always fill both 'city' and 'country' fields with a real or invented name. Rules:\n" +
    "   - Real-world setting → use the actual city and country (e.g. 'Paris' / 'France').\n" +
    "   - Fantasy / sci-fi / fictional world → INVENT fitting names based on the story tone, character names, culture, architecture, language style. Be creative and specific (e.g. 'Myrenveld' / 'Sovereign Realms of Drak'hara').\n" +
    "   - Known fictional universe (Westeros, Middle-earth, etc.) → use canonical place names.\n" +
    "   - Setting is ambiguous or unspecified → make your BEST GUESS or freely invent. 'Unknown' is NOT an acceptable value under any circumstances.\n" +
    "3. CHARACTER POSITIONS: List every character present in the current scene (including {{user}} / the user). State exactly where they are and what their physical posture/action is right now (e.g., 'sitting on the bed', 'standing near the window', 'holding a knife').\n" +
    "4. RECENT EVENTS: Write a brief, factual 1-2 sentence summary of what *just* changed or happened in the last few messages (e.g., 'User picked up a fork. Character 1 moved to the corridor.').\n\n" +
    "{{PREVIOUS_STATE}}\n\n" +
    "Respond ONLY with valid JSON in the story's language. Use this exact structure (city and country MUST be non-empty strings, never 'Unknown'):\n" +
    "{\"time\":\"14:30\", \"date\":\"15/06/2024\", \"location\":\"Living room\", \"city\":\"Myrenveld\", \"country\":\"Sovereign Realms of Drak'hara\", \"temperature\":\"18°C\", \"weather\":\"Cloudy\", \"characters\":[{\"name\":\"User\", \"state\":\"sitting on floor\"}, {\"name\":\"Char1\", \"state\":\"standing near User\"}], \"recent_events\":\"Char1 entered the living room and spoke to User.\"}\n" +
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

// --- State Variables ---
var settings = {
    enabled: true,
    showHUD: true,
    hudScale: 100,            
    hudPosition: "bottom-right",
	showChatButton: true,
    autoUpdate: true,
    autoUpdateInterval: 3,
    injectToContext: true,
    showHistory: true,
    showCityCountry: false,
    // --- Connection profile support ---
    useConnectionProfile: false, // master toggle: route Story Tracker analysis through a separate profile
    connectionProfile: "",       // name of the profile to use (empty = current/main profile)
    _restoreProfile: ""          // internal: profile to restore if an analysis was interrupted by a reload
};
var extSettings = null, saveFn = null, scriptModule = null, genQuiet = null, translateFn = null;
var runSlash = null; // executeSlashCommandsWithOptions — used to switch connection profiles
var storyData = null; 
var msgCounter = 0;
var busy = false;

// --- Init ---
jQuery(async function () {
    try {
        var m = await import("../../../extensions.js");
        extSettings = m.extension_settings; saveFn = m.saveSettingsDebounced;
        scriptModule = await import("../../../../script.js");
        if (typeof scriptModule.generateQuietPrompt === "function") genQuiet = scriptModule.generateQuietPrompt;

        // Optional: slash-command runner, needed to switch connection profiles.
        // Wrapped in its own try so a path change in ST never breaks the whole extension.
        try {
            var sc = await import("../../../slash-commands.js");
            if (typeof sc.executeSlashCommandsWithOptions === "function") runSlash = sc.executeSlashCommandsWithOptions;
        } catch (e) { console.warn("[Story Tracker] slash-commands.js not available, connection profile switching disabled.", e); }
        
        await initTranslation();
        loadSettings();
        
        buildModal();
        buildHUD();
        buildSettingsPanel();
        buildChatButton();
        bindEvents();

        // Safety net: restore the main profile if a previous analysis was interrupted
        // by a page reload. Runs after a short delay so Connection Manager finishes loading.
        setTimeout(function () { recoverProfileIfNeeded(); }, 1500);

        console.log("[Story Tracker] Loaded!");
    } catch (e) { console.error("[Story Tracker] Init error:", e); }
});

// --- Data Management ---
function loadSettings() {
    if(extSettings) {
        if(!extSettings[MODULE]) extSettings[MODULE] = {};
        Object.assign(settings, Object.assign({}, settings, extSettings[MODULE]));
        extSettings[MODULE] = settings;
    }
}

function save() { if(saveFn) saveFn(); }

function makeDefaultData() {
    return {
        time: "--:--", date: "Unknown", location: "Unknown",
        city: "Unknown", country: "Unknown",
        temperature: "Unknown", weather: "Unknown",
        characters: [], recent_events: "Story just started.",
        history: [], _initialized: false, _msgCount: 0
    };
}

function loadStoryData() {
    var meta = scriptModule ? scriptModule.chat_metadata : null;
    var stored = (meta && meta[DATA_KEY]) ? meta[DATA_KEY] : null;
    if (stored) {
        storyData = stored;
        msgCounter = storyData._msgCount || 0;
        if (!storyData.history) storyData.history = [];
    } else {
        storyData = makeDefaultData();
        if (meta) meta[DATA_KEY] = storyData;
        msgCounter = 0;
    }
}

function saveStoryData() {
    if (!scriptModule || !scriptModule.chat_metadata) return;
    storyData._msgCount = msgCounter;
    scriptModule.chat_metadata[DATA_KEY] = storyData;
    if (typeof scriptModule.saveMetadataDebounced === "function") scriptModule.saveMetadataDebounced();
}

// Fills the settings dropdown with available connection profiles.
function populateProfileDropdown() {
    var $sel = $("#st-s-profile");
    if (!$sel.length) return;
    var profiles = getProfileList();
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
    // Restore the saved selection if it still exists.
    var saved = settings.connectionProfile || "";
    if (saved && profiles.some(function (p) { return p.name === saved; })) {
        $sel.val(saved);
    } else if (saved && profiles.length > 0) {
        // Saved profile no longer exists — keep the value so the user notices, but fall back visually.
        $sel.val("");
    }
}


// --- LLM Logic ---
function buildPrevStateText() {
    if (!storyData || !storyData._initialized) return "This is the INITIAL setup. Deduce starting parameters from the intro message.";
    let s = "PREVIOUS STATE:\nTime: " + storyData.time + " | Date: " + storyData.date + " | Location: " + (storyData._origLocation || storyData.location) + "\n";
    s += "City: " + (storyData._origCity || storyData.city || "Unknown") + " | Country/Realm: " + (storyData._origCountry || storyData.country || "Unknown") + "\n";
    s += "Temperature: " + (storyData._origTemperature || storyData.temperature || "Unknown") + " | Weather: " + (storyData._origWeather || storyData.weather || "Unknown") + "\n";
    // Include current outfit from Inventory so the LLM never forgets what is worn
    var outfit = getInventoryOutfit();
    if (outfit && outfit.userEquipped.length > 0) {
        var outfitStr = outfit.userEquipped.map(function(it) { return it.label + ": " + it.name; }).join(", ");
        s += "User's current outfit: " + outfitStr + "\n";
    }
    if (outfit && outfit.charItems.length > 0) {
        var charHeld = outfit.charItems.map(function(ci) { return ci.name + " (held by " + ci.heldBy + ")"; }).join(", ");
        s += "Items held by character: " + charHeld + "\n";
    }

    return s + "(Update the time, check if location/weather changed, update character positions based on what they just did).";
}

// --- Connection Profile Support ---
// Returns the array of saved connection profiles, or [] if Connection Manager isn't active.
function getProfileList() {
    try {
        var cm = extSettings && extSettings.connectionManager;
        if (!cm || !Array.isArray(cm.profiles)) return [];
        return cm.profiles;
    } catch (e) { return []; }
}

// Returns the name of the currently selected connection profile, or "" if none/unavailable.
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

// True only if we actually can and should route analysis through a different profile.
function shouldSwitchProfile() {
    if (!settings.useConnectionProfile) return false;
    if (!runSlash) return false;                       // slash runner not available
    var target = (settings.connectionProfile || "").trim();
    if (!target) return false;                         // no target chosen -> use main profile
    if (getProfileList().length === 0) return false;   // Connection Manager not installed/enabled
    var current = getCurrentProfileName();
    if (current && current === target) return false;   // already on the target -> nothing to do
    return true;
}

// Switch to a named profile via the official slash command and wait for it to settle.
async function switchProfile(name) {
    if (!runSlash || !name) return false;
    try {
        // Quote the name so profiles with spaces work correctly.
        await runSlash('/profile "' + String(name).replace(/"/g, '\\"') + '"');
        // Small settle delay: switching a profile updates API/model/preset asynchronously.
        await new Promise(function (r) { setTimeout(r, 150); });
        return true;
    } catch (e) {
        console.warn("[Story Tracker] Failed to switch to profile '" + name + "':", e);
        return false;
    }
}

// Run an async LLM task on the configured profile, then always restore the original profile.
// If switching isn't needed/possible, the task simply runs on the current (main) profile.
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
        // Persist which profile we must return to, in case the page reloads mid-analysis
        // (the finally block below would not run in that scenario).
        if (switched && original && original !== target) {
            settings._restoreProfile = original;
            save();
        }
        return await task();
    } finally {
        // Always restore the user's main profile so the chat generation is never affected.
        if (switched && original && original !== target) {
            await switchProfile(original);
        }
        // Clear the recovery marker — restoration (or the attempt) is done.
        if (settings._restoreProfile) { settings._restoreProfile = ""; save(); }
    }
}

// Safety net: if a previous analysis was interrupted (e.g. page reload) while on the
// tracker's profile, the marker survives in settings. On load, quietly switch back.
async function recoverProfileIfNeeded() {
    var pending = settings._restoreProfile;
    if (!pending || !runSlash) return;
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


async function doLLMUpdate() {
    if (!genQuiet) throw new Error("LLM generation not available.");

    // Untranslate before sending to LLM for context accuracy
    let wasTr = storyData._translated;
    if (wasTr) untranslateData();

    var prompt = UPDATE_PROMPT.replace("{{PREVIOUS_STATE}}", buildPrevStateText());

    console.log("[Story Tracker] Analyzing scene...");
    // Route the scene analysis through the configured connection profile (if any),
    // then automatically restore the user's main profile when done.
    var raw = await withConnectionProfile(function () { return genQuiet(prompt); });

    // Parse JSON safely
    var data = null;
    try { data = JSON.parse(raw); } 
    catch(e) {
        var m = raw.match(/\{[\s\S]*\}/);
        if (m) { try { data = JSON.parse(m[0]); } catch(ex){} }
    }
    
    if (!data || !data.time) throw new Error("Failed to parse LLM response.");

    // Apply data
    storyData.time = data.time || storyData.time;
    storyData.date = data.date || storyData.date;
    storyData.location = data.location || storyData.location;

    // City / country: treat "Unknown" (case-insensitive) as missing — will trigger fallback below
    let isBlank = v => !v || v.trim().toLowerCase() === "unknown" || v.trim() === "";
    storyData.city    = !isBlank(data.city)    ? data.city    : (isBlank(storyData.city)    ? null : storyData.city);
    storyData.country = !isBlank(data.country) ? data.country : (isBlank(storyData.country) ? null : storyData.country);

    storyData.temperature = data.temperature || storyData.temperature;
    storyData.weather = data.weather || storyData.weather;
    storyData.characters = Array.isArray(data.characters) ? data.characters : [];
    storyData.recent_events = data.recent_events || "";
    storyData._initialized = true;

    // Fallback: if city or country still missing, ask LLM specifically for them
    if (settings.showCityCountry && (isBlank(storyData.city) || isBlank(storyData.country))) {
        try {
            console.log("[Story Tracker] City/country missing — running fallback inference...");
            var ccPrompt = CITY_COUNTRY_PROMPT.replace("{{LOCATION}}", storyData._origLocation || storyData.location || "Unknown");
            var ccRaw = await withConnectionProfile(function () { return genQuiet(ccPrompt); });
            var ccData = null;
            try { ccData = JSON.parse(ccRaw); }
            catch(e) { var cm = ccRaw.match(/\{[\s\S]*?\}/); if (cm) { try { ccData = JSON.parse(cm[0]); } catch(ex){} } }
            if (ccData) {
                if (!isBlank(ccData.city))    storyData.city    = ccData.city;
                if (!isBlank(ccData.country)) storyData.country = ccData.country;
            }
        } catch(fe) { console.warn("[Story Tracker] City/country fallback failed:", fe); }
    }

    // Ensure display-safe values
    if (isBlank(storyData.city))    storyData.city    = "Unknown";
    if (isBlank(storyData.country)) storyData.country = "Unknown";

    // Save to history (keep last 20)
    storyData.history.unshift({
        msg: msgCounter,
        time: storyData.time,
        loc: storyData.location,
        temperature: storyData.temperature,
        weather: storyData.weather,
        events: storyData.recent_events,
        chars: JSON.parse(JSON.stringify(storyData.characters))
    });
    if (storyData.history.length > 20) storyData.history.pop();

    saveStoryData();
    syncToCharTracker(); // Sync data with Character Tracker

    if (wasTr) await translateData();
}

// --- Sync to Character Tracker ---
function syncToCharTracker() {
    try {
        var meta = scriptModule ? scriptModule.chat_metadata : null;
        if (!meta) return;
        var ct = meta["char_tracker"];
        if (!ct) return; // Character Tracker not yet initialized

        // Parse date from "DD/MM/YYYY" format
        var day = 1, month = 1, year = 2024;
        var parts = (storyData.date || "").split(/[\/\-\.]/);
        if (parts.length >= 3) {
            day   = parseInt(parts[0], 10) || 1;
            month = parseInt(parts[1], 10) || 1;
            year  = parseInt(parts[2], 10) || 2024;
        }

        // Update sharedTime
        var container = ct._isGroup ? ct : ct;
        if (!container.sharedTime) container.sharedTime = {};
        container.sharedTime.time  = storyData.time  || "--:--";
        container.sharedTime.day   = day;
        container.sharedTime.month = month;
        container.sharedTime.year  = year;
        container._timeInitialized = true;

        // Update location
        if (ct._isGroup) {
            var activeChar = ct._activeChar;
            if (activeChar && ct.characters && ct.characters[activeChar]) {
                ct.characters[activeChar].location = storyData.location;
            }
        } else {
            ct.location = storyData.location;
        }

        if (typeof scriptModule.saveMetadataDebounced === "function")
            scriptModule.saveMetadataDebounced();

        console.log("[Story Tracker] Synced time/location → Character Tracker");
		$(document).trigger("CT_FORCE_RENDER");
    } catch(e) { console.error("[Story Tracker] syncToCharTracker error:", e); }
}

// --- Inventory Integration ---
var INV_SLOTS        = ["head","torso","legs","feet","hands","lefthand","righthand","accessory1","accessory2"];
var INV_SLOT_LABELS  = { head:"Head", torso:"Torso", legs:"Legs", feet:"Feet", hands:"Hands", lefthand:"Left Hand", righthand:"Right Hand", accessory1:"Accessory 1", accessory2:"Accessory 2" };
var INV_SLOT_ICONS   = { head:"🎩", torso:"👕", legs:"👖", feet:"👟", hands:"🧤", lefthand:"🤚", righthand:"✋", accessory1:"💍", accessory2:"💍" };

function getInventoryOutfit() {
    try {
        var meta = scriptModule ? scriptModule.chat_metadata : null;
        if (!meta) return null;
        var inv = meta["inv_data"];
        if (!inv || !inv.equipped) return null;

        // Use original (untranslated) names when available for LLM injection
        var eq = (inv._translated && inv._orig) ? inv._orig.equipped : inv.equipped;

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

        // Items currently held by the AI character
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
    if (!settings.enabled || !settings.injectToContext || !storyData || !storyData._initialized) return;
    
    // Always inject original (untranslated) data to LLM
    let loc = storyData._origLocation || storyData.location;
    let ev = storyData._origEvents || storyData.recent_events;
    
    let charsText = "";
    if (storyData.characters && storyData.characters.length > 0) {
        let origChars = storyData._origCharacters || storyData.characters;
        charsText = origChars.map(c => `${c.name}: ${c.state}`).join(" | ");
    }

    let cityCountryStr = "";
    if (settings.showCityCountry) {
        let city = storyData._origCity || storyData.city || "";
        let country = storyData._origCountry || storyData.country || "";
        if (city && city !== "Unknown" || country && country !== "Unknown") {
            cityCountryStr = "\nCity: " + (city || "Unknown") + " | Country/Realm: " + (country || "Unknown");
        }
    }

    let inj = `[Scene Context: Time: ${storyData.time}, Date: ${storyData.date}\nLocation: ${loc}${cityCountryStr}\nTemperature: ${storyData._origTemperature || storyData.temperature || "Unknown"} | Weather: ${storyData._origWeather || storyData.weather || "Unknown"}\nPositions: ${charsText}\nRecent: ${ev}`;

    // Append outfit from Inventory if available
    var outfit = getInventoryOutfit();
    if (outfit && outfit.userEquipped.length > 0) {
        var outfitStr = outfit.userEquipped.map(function(it) { return it.label + ": " + it.name; }).join(", ");
        inj += `\nUser's Outfit: ${outfitStr}`;
    }
    if (outfit && outfit.charItems.length > 0) {
        var charHeldStr = outfit.charItems.map(function(ci) { return ci.name + " (held by " + ci.heldBy + ")"; }).join(", ");
        inj += `\nCharacter holds: ${charHeldStr}`;
    }
    inj += `]`;
    
    try {
        var ex = scriptModule.chat_metadata.authorsNote || "";
        var mk = "<!-- ST_INJECT -->", emk = "<!-- /ST_INJECT -->";
        var cl = ex.replace(new RegExp(mk + "[\\s\\S]*?" + emk, "g"), "").trim();
        scriptModule.chat_metadata.authorsNote = cl + (cl ? "\n" : "") + mk + "\n" + inj + "\n" + emk;
    } catch(e) { console.error("[Story Tracker] Inject error:", e); }
}

// --- Event Handling ---
function bindEvents() {
    var es = scriptModule.eventSource, et = scriptModule.event_types;
    if (!es) return;
    
    es.on(et.CHAT_CHANGED, function() {
        loadStoryData();
        renderModal(); renderHUD();
    });
    
	$(document).on("ST_FORCE_RENDER", function() {
        loadStoryData();
        renderModal(); 
        renderHUD();
    });

    // Re-render instantly when Inventory equipment changes (equip / unequip / drop)
    $(document).on("INV_EQUIPMENT_CHANGED", function() {
        renderModal();
        renderHUD();
        if (settings.enabled && settings.injectToContext) injectContextToChat();
    });

    let handleMsg = async function() {
        if (!settings.enabled || busy) return;
        msgCounter++;
        saveStoryData();
        
        // Initial setup on 1st message, or auto-update
        let isFirstMsg = scriptModule.chat.length <= 2 && !storyData._initialized;
        
        if (isFirstMsg || (settings.autoUpdate && msgCounter % settings.autoUpdateInterval === 0)) {
            busy = true;
            try {
                await doLLMUpdate();
                renderModal(); renderHUD();
            } catch(e) { console.error(e); }
            busy = false;
        } else {
            renderAutoInfo();
        }
    };

    es.on(et.CHARACTER_MESSAGE_RENDERED, handleMsg);
    es.on(et.MESSAGE_RECEIVED, handleMsg);
    es.on(et.GENERATION_STARTED, function() { injectContextToChat(); });
}

// --- UI Rendering ---
function esc(t) { var d = document.createElement("div"); d.textContent = t; return d.innerHTML; }

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

function buildModal() {
    if (document.getElementById("st-modal")) return;
    var h = '<div id="st-modal" style="display:none"><div class="st-overlay"></div><div class="st-dialog">';
    h += '<div class="st-header"><div class="st-title"><i class="fa-solid fa-book-open-reader"></i> Story Tracker</div>';
    h += '<div class="st-header-right">';
    h += '<button class="st-hdr-btn menu_button" id="st-h-translate" title="Translate"><i class="fa-solid fa-language"></i></button>';
    h += '<button class="st-hdr-btn menu_button" id="st-h-refresh" title="Force Update"><i class="fa-solid fa-rotate"></i></button>';
    h += '<button class="st-hdr-btn menu_button" id="st-h-close" title="Close"><i class="fa-solid fa-xmark"></i></button>';
    h += '</div></div>';
    
    h += '<div class="st-tabs"><div class="st-tab st-tab-active" data-target="st-tab-current">Current Scene</div><div class="st-tab" data-target="st-tab-history">History / Stats</div></div>';
    
    h += '<div class="st-body">';
    h += '<div id="st-tab-current">';
    h += '<div class="st-no-data" id="st-no-data" style="display:none"><i class="fa-solid fa-hourglass-start"></i><div>Waiting for first update...</div></div>';
    h += '<div id="st-content-area">';
    h += '<div class="st-section"><div class="st-sec-title"><i class="fa-solid fa-map-location-dot"></i> Time & Place</div>';
    h += '<div class="st-grid"><div class="st-item"><div class="st-item-label">Time</div><div class="st-item-val" id="st-val-time"></div></div>';
    h += '<div class="st-item"><div class="st-item-label">Date</div><div class="st-item-val" id="st-val-date"></div></div>';
    h += '<div class="st-item" style="grid-column:1/-1"><div class="st-item-label">Day of Week</div><div class="st-item-val" id="st-val-dow"></div></div>';
    h += '<div class="st-item" style="grid-column:1/-1"><div class="st-item-label">Location</div><div class="st-item-val" id="st-val-loc"></div></div>';
    h += '<div class="st-item" style="grid-column:1/-1" id="st-city-country-row"><div class="st-item-label">City / Country</div><div class="st-item-val" id="st-val-city-country"></div></div>';
    h += '<div class="st-item"><div class="st-item-label">Temperature</div><div class="st-item-val" id="st-val-temp"></div></div>';
    h += '<div class="st-item"><div class="st-item-label">Weather</div><div class="st-item-val" id="st-val-weather"></div></div>';
    h += '</div></div>';
    
    h += '<div class="st-section"><div class="st-sec-title"><i class="fa-solid fa-users"></i> Character Positions</div><div class="st-char-list" id="st-val-chars"></div></div>';
    h += '<div class="st-section"><div class="st-sec-title"><i class="fa-solid fa-scroll"></i> Recent Events (Summary)</div><div class="st-summary-box" id="st-val-events"></div></div>';
    h += '</div></div>'; // end tab 1
    
    h += '<div id="st-tab-history" style="display:none;"><div id="st-history-list"></div></div>';
    
    h += '</div>'; // end body
    h += '<div class="st-footer"><button class="menu_button" id="st-f-update"><i class="fa-solid fa-bolt"></i> Update Now</button><div class="st-auto-info" id="st-auto-info"></div></div>';
    h += '</div></div>';
    document.body.insertAdjacentHTML("beforeend", h);

    $(document).on("click", ".st-overlay, #st-h-close", function() { $("#st-modal").fadeOut(150); });
    $(document).on("click", "#st-h-refresh, #st-f-update", doManualUpdate);
    $(document).on("click", "#st-h-translate", doTranslateToggle);
    $(document).on("click", ".st-tab", function() {
        $(".st-tab").removeClass("st-tab-active"); $(this).addClass("st-tab-active");
        $("#st-tab-current, #st-tab-history").hide();
        $("#" + $(this).data("target")).show();
    });
}

function renderModal() {
    if (!storyData) return;
    if (!storyData._initialized) {
        $("#st-no-data").show(); $("#st-content-area").hide();
    } else {
        $("#st-no-data").hide(); $("#st-content-area").show();
        $("#st-val-time").text(storyData.time);
        $("#st-val-date").text(storyData.date);
        var dow = getDayOfWeek(storyData.date);
        $("#st-val-dow").text(dow || "Unknown");
        $("#st-val-loc").text(storyData.location);
        
        // City / Country row — shown only when setting is enabled
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
        
        var outfit = getInventoryOutfit();
        var userName = (scriptModule && scriptModule.name1) ? scriptModule.name1 : null;

        let cHtml = "";
        if (storyData.characters) {
            storyData.characters.forEach(c => {
                var stateText = c.state;

                // Append user outfit as plain text
                if (outfit && outfit.userEquipped.length > 0) {
                    var isUser = (userName && c.name.toLowerCase() === userName.toLowerCase()) ||
                                 c.name.toLowerCase() === "user" ||
                                 c.name.toLowerCase() === "вы" ||
                                 c.name === "{{user}}";
                    if (isUser) {
                        var wearNames = outfit.userEquipped.map(function(it) { return it.name; }).join(", ");
                        stateText += ", wearing " + wearNames;
                    }
                }

                // Append held items for AI characters as plain text
                if (outfit && outfit.charItems.length > 0) {
                    var held = outfit.charItems.filter(ci => ci.heldBy && ci.heldBy.toLowerCase() === c.name.toLowerCase());
                    if (held.length > 0) {
                        var heldNames = held.map(function(ci) { return ci.name; }).join(", ");
                        stateText += ", holding " + heldNames;
                    }
                }

                cHtml += '<div class="st-char-card"><div class="st-char-name">' + esc(c.name) + '</div><div class="st-char-state">' + esc(stateText) + '</div></div>';
            });
        }
        $("#st-val-chars").html(cHtml || "<i>No characters detected.</i>");
    }   // end storyData._initialized else block
    
    // History render
    let hHtml = "";
    if (storyData.history && storyData.history.length > 0) {
        storyData.history.forEach((h, i) => {
            let weatherInfo = (h.temperature || h.weather) ? ` | ${h.temperature || ""}${h.weather ? " " + esc(h.weather) : ""}` : "";
            hHtml += `<div class="st-history-item">
                <div class="st-history-meta"><span>Update at Msg #${h.msg}</span><span>${h.time} | ${esc(h.loc)}${weatherInfo}</span></div>
                <div class="st-history-sum">${esc(h.events)}</div>
            </div>`;
        });
    } else { hHtml = "<div class='st-no-data'>No history yet.</div>"; }
    $("#st-history-list").html(hHtml);

    renderAutoInfo();
    syncTranslateBtn();
}

function renderAutoInfo() {
    if(!settings.autoUpdate) { $("#st-auto-info").text("Auto-update: OFF"); return; }
    let rem = settings.autoUpdateInterval - (msgCounter % settings.autoUpdateInterval);
    $("#st-auto-info").text(`Auto-update in ${rem} msg(s)`);
}

async function doManualUpdate() {
    if (busy) return;
    busy = true;
    var $b = $("#st-f-update").prop("disabled", true).html('<i class="fa-solid fa-spinner fa-spin"></i> Analyzing...');
    try {
        await doLLMUpdate();
        renderModal(); renderHUD();
        if(typeof toastr !== "undefined") toastr.success("Story updated!");
    } catch(e) { if(typeof toastr !== "undefined") toastr.error(e.message); }
    busy = false;
    $b.prop("disabled", false).html('<i class="fa-solid fa-bolt"></i> Update Now');
}

// --- HUD ---
function buildHUD() {
    if (document.getElementById("st-hud")) return;
    let h = `<div id="st-hud" class="st-hud st-hud-pos-${settings.hudPosition}"><div class="st-hud-head"><i class="fa-solid fa-book"></i> Tracker <i style="margin-left:auto" class="fa-solid fa-chevron-up"></i></div><div class="st-hud-body" id="st-hud-body"></div></div>`;
    document.body.insertAdjacentHTML("beforeend", h);
    $(document).on("click", ".st-hud-head", function() { $("#st-hud").toggleClass("st-hud-collapsed"); });
    $(document).on("click", "#st-hud-body", function() { loadStoryData(); renderModal(); $("#st-modal").fadeIn(150); });
    renderHUD();
}

function applyHudStyle() {
    var $h = $("#st-hud");
    $h.removeClass("st-hud-pos-bottom-right st-hud-pos-bottom-left st-hud-pos-top-right st-hud-pos-top-left").addClass(`st-hud-pos-${settings.hudPosition}`);
    
    var scale = (settings.hudScale || 100) / 100;
    var origin = "bottom right";
    if (settings.hudPosition === "bottom-left") origin = "bottom left";
    if (settings.hudPosition === "top-right") origin = "top right";
    if (settings.hudPosition === "top-left") origin = "top left";

    $h.css({
        "transform": `scale(${scale})`,
        "transform-origin": origin
    });
}

function renderHUD() {
    $("#st-hud").toggle(settings.showHUD);
    applyHudStyle();

    if (!storyData || !storyData._initialized) {
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

            // Append user outfit as plain text
            if (hudOutfit && hudOutfit.userEquipped.length > 0) {
                var isUser = (hudUserName && c.name.toLowerCase() === hudUserName.toLowerCase()) ||
                             c.name.toLowerCase() === "user" ||
                             c.name.toLowerCase() === "вы" ||
                             c.name === "{{user}}";
                if (isUser) {
                    var wearNames = hudOutfit.userEquipped.map(function(it) { return it.name; }).join(", ");
                    hudStateText += ", wearing " + wearNames;
                }
            }

            // Append held items for AI characters as plain text
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

    $("#st-hud-body").html(h);
}

// --- Chat Button ---
function buildChatButton() {
    if (!document.getElementById("st-trigger")) {
        var btn = '<div id="st-trigger" class="st-trigger interactable" title="Story Tracker"><i class="fa-solid fa-book-open-reader"></i></div>';
        var $l = $("#leftSendForm"); if ($l.length) $l.append(btn); else $("#send_form").prepend(btn);
        $(document).on("click", "#st-trigger", function() { loadStoryData(); renderModal(); $("#st-modal").fadeIn(150); });
    }
    toggleChatButtonVisibility();
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

// --- Settings UI ---
function buildSettingsPanel() {
    var $c = $("#extensions_settings2"); if (!$c.length) $c = $("#extensions_settings"); if (!$c.length) return;
    var h = '<div class="inline-drawer"><div class="inline-drawer-toggle inline-drawer-header"><b><i class="fa-solid fa-book-open-reader"></i> Story Tracker</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div><div class="inline-drawer-content">';
    h += '<div class="da-srow"><label class="checkbox_label"><input type="checkbox" id="st-s-on"><span>Enable Extension</span></label></div>';
    
    h += '<div class="da-srow"><label class="checkbox_label"><input type="checkbox" id="st-s-hud"><span>Show HUD Widget</span></label></div>';
    h += '<div class="da-srow" id="st-pos-row"><label><small>HUD Position:</small></label><select id="st-s-pos" class="text_pole"><option value="bottom-right">Bottom Right</option><option value="bottom-left">Bottom Left</option><option value="top-right">Top Right</option><option value="top-left">Top Left</option></select></div>';
    h += '<div class="da-srow" id="st-scale-row"><label><small>HUD Scale: <span id="st-scale-val"></span>%</small></label><input type="range" id="st-s-scale" min="50" max="200" step="5"></div>';
    
    h += '<hr><div class="da-srow"><label class="checkbox_label"><input type="checkbox" id="st-s-chatbtn"><span>Show Icon in Chat Panel</span></label></div>';
    
    h += '<hr><div class="da-srow"><label class="checkbox_label"><input type="checkbox" id="st-s-auto"><span>Auto-update LLM Scene</span></label></div>';
    h += '<div class="da-srow"><label><small>Update every N msgs: <span id="st-interval-val"></span></small></label><input type="range" id="st-s-interval" min="1" max="20" step="1"></div>';
    h += '<hr><div class="da-srow"><label class="checkbox_label"><input type="checkbox" id="st-s-inject"><span>Inject Context into Prompt (Reduces Amnesia)</span></label></div>';
    h += '<div class="da-srow"><label class="checkbox_label"><input type="checkbox" id="st-s-cityctry"><span>Show City / Country (LLM infers or invents)</span></label></div>';

    // --- Connection Profile section ---
    h += '<hr><div class="da-srow"><label class="checkbox_label"><input type="checkbox" id="st-s-useprofile"><span>Use a separate Connection Profile for analysis</span></label></div>';
    h += '<div class="da-srow"><small style="opacity:.7">Run Story Tracker\'s scene analysis on a cheaper model, then switch back to your main profile automatically. Requires the built-in <b>Connection Profiles</b> extension.</small></div>';
    h += '<div class="da-srow" id="st-profile-row"><label><small>Analysis Profile:</small></label>';
    h += '<div style="display:flex;gap:5px;align-items:center;"><select id="st-s-profile" class="text_pole" style="flex:1"></select>';
    h += '<button class="menu_button" id="st-s-profile-refresh" title="Refresh profile list" style="flex:0 0 auto;"><i class="fa-solid fa-rotate"></i></button></div></div>';

    h += '<div class="da-srow da-srow-btns"><input type="button" class="menu_button" id="st-s-open" value="Open Tracker"></div></div></div>';
    $c.append(h);

    $("#st-s-on").prop("checked", settings.enabled).on("change", function() { 
        settings.enabled = this.checked; save(); renderHUD(); toggleChatButtonVisibility();
    });
    
    $("#st-s-hud").prop("checked", settings.showHUD).on("change", function() { 
        settings.showHUD = this.checked; save(); renderHUD(); 
        $("#st-pos-row, #st-scale-row").toggle(this.checked);
    });
    $("#st-pos-row, #st-scale-row").toggle(settings.showHUD);
    
    $("#st-s-pos").val(settings.hudPosition).on("change", function() { settings.hudPosition = this.value; save(); applyHudStyle(); });
    
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
    
    $("#st-s-auto").prop("checked", settings.autoUpdate).on("change", function() { settings.autoUpdate = this.checked; save(); renderModal(); });
    $("#st-s-interval").val(settings.autoUpdateInterval).on("input", function() { settings.autoUpdateInterval = parseInt(this.value, 10); $("#st-interval-val").text(this.value); save(); renderModal(); });
    $("#st-interval-val").text(settings.autoUpdateInterval);
    
    $("#st-s-inject").prop("checked", settings.injectToContext).on("change", function() { settings.injectToContext = this.checked; save(); });
    $("#st-s-cityctry").prop("checked", settings.showCityCountry).on("change", function() { settings.showCityCountry = this.checked; save(); renderModal(); renderHUD(); });

    // --- Connection Profile controls ---
    $("#st-s-useprofile").prop("checked", settings.useConnectionProfile).on("change", function() {
        settings.useConnectionProfile = this.checked;
        save();
        $("#st-profile-row").toggle(this.checked);
    });
    $("#st-profile-row").toggle(settings.useConnectionProfile);

    populateProfileDropdown();
    $("#st-s-profile").on("change", function() { settings.connectionProfile = this.value; save(); });
    $("#st-s-profile-refresh").on("click", function() {
        populateProfileDropdown();
        if (typeof toastr !== "undefined") toastr.info("Connection profile list refreshed.");
    });

    $("#st-s-open").on("click", function() { loadStoryData(); renderModal(); $("#st-modal").fadeIn(150); });
}

// --- Translation ---
async function initTranslation() {
    try {
        var tMod = await import("../../translate/index.js");
        if (typeof tMod.translate === "function") translateFn = tMod.translate;
    } catch (e) {}
}

async function tr(text) {
    if (!translateFn || !text || !text.trim()) return text;
    let target = (extSettings && extSettings.translate && extSettings.translate.target_language) ? extSettings.translate.target_language : "ru";
    return await translateFn(text, target);
}

async function translateData() {
    if (!translateFn || !storyData || storyData._translated) return;
    
    storyData._origLocation = storyData.location;
    storyData._origEvents = storyData.recent_events;
    storyData._origWeather = storyData.weather;
    storyData._origTemperature = storyData.temperature;
    storyData._origCity = storyData.city;
    storyData._origCountry = storyData.country;
    storyData._origCharacters = JSON.parse(JSON.stringify(storyData.characters));
    storyData._origHistory = JSON.parse(JSON.stringify(storyData.history));
    
    if (storyData.location) storyData.location = await tr(storyData.location);
    if (storyData.recent_events) storyData.recent_events = await tr(storyData.recent_events);
    if (storyData.weather && storyData.weather !== "Unknown") storyData.weather = await tr(storyData.weather);
    if (storyData.city && storyData.city !== "Unknown") storyData.city = await tr(storyData.city);
    if (storyData.country && storyData.country !== "Unknown") storyData.country = await tr(storyData.country);
    
    if (storyData.characters) {
        for (let c of storyData.characters) {
            c.name = await tr(c.name);
            c.state = await tr(c.state);
        }
    }

    if (storyData.history) {
        for (let h of storyData.history) {
            if (h.loc) h.loc = await tr(h.loc);
            if (h.events) h.events = await tr(h.events);
        }
    }
    
    storyData._translated = true;
    saveStoryData();
}

function untranslateData() {
    if (!storyData || !storyData._translated) return;
    
    if (storyData._origLocation) storyData.location = storyData._origLocation;
    if (storyData._origEvents) storyData.recent_events = storyData._origEvents;
    if (storyData._origWeather) storyData.weather = storyData._origWeather;
    if (storyData._origTemperature) storyData.temperature = storyData._origTemperature;
    if (storyData._origCity) storyData.city = storyData._origCity;
    if (storyData._origCountry) storyData.country = storyData._origCountry;
    if (storyData._origCharacters) storyData.characters = JSON.parse(JSON.stringify(storyData._origCharacters));
    if (storyData._origHistory) storyData.history = JSON.parse(JSON.stringify(storyData._origHistory));
    
    delete storyData._translated; 
    delete storyData._origLocation; 
    delete storyData._origEvents; 
    delete storyData._origWeather;
    delete storyData._origTemperature;
    delete storyData._origCity;
    delete storyData._origCountry;
    delete storyData._origCharacters;
    delete storyData._origHistory;
    
    saveStoryData();
}

async function doTranslateToggle() {
    if (busy) return;
    if (!translateFn) { if(typeof toastr !== "undefined") toastr.warning("Translator module not loaded."); return; }
    
    busy = true;
    let $b = $("#st-h-translate").prop("disabled", true).html('<i class="fa-solid fa-spinner fa-spin"></i>');
    
    try {
        if (storyData._translated) { untranslateData(); } 
        else { await translateData(); }
        renderModal(); renderHUD();
    } catch(e) { console.error(e); }
    
    busy = false; $b.prop("disabled", false);
    syncTranslateBtn();
}

function syncTranslateBtn() {
    let $b = $("#st-h-translate");
    if (storyData && storyData._translated) $b.addClass("st-btn-tr-active").attr("title", "Show Original").html('<i class="fa-solid fa-rotate-left"></i>');
    else $b.removeClass("st-btn-tr-active").attr("title", "Translate").html('<i class="fa-solid fa-language"></i>');
}
