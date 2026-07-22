/*
 * Story Tracker — SillyTavern Extension
 * Keeps track of Time, Date, Location, Character Positions, and Recent Events.
 * Reduces amnesia by injecting scene context into LLM prompts.
 * Includes World Progression Agent subsystem.
 *
 * FILE STRUCTURE (as of the module split): this file is a classic (non-module)
 * script — SillyTavern loads it directly, not as `type="module"` — so it can't
 * use static `import`. Everything that used to live here as one 5300-line file
 * now lives in real ES modules loaded via dynamic `import()` inside the
 * bootstrap below, same technique already used for TimelineEngine/Scheduler/
 * EventQueue/SceneAgent/WorldAgent/RelationshipAgent:
 *
 *   Store.js       — shared mutable state (settings, storyData, worldData,
 *                     relationshipData, busy flags, the agent module handles).
 *                     Every other module reads/writes through this instead of
 *                     bare top-level `var`s, since ES modules don't share this
 *                     file's classic-script global scope.
 *   Persistence.js — load/save for settings and per-chat data.
 *   ProfileSession.js — connection-profile switching for the 3 trackers.
 *   Pipeline.js    — the actual message-handling brain: Scheduler/EventQueue
 *                     dispatch, and the Scene/World/Relationship tracker calls.
 *   HUD.js         — the floating snapshot widget (redesigned; see its header).
 *   LLMResponseParser.js — robust JSON extraction from model responses.
 *
 * What's LEFT in this file: settings defaults, the bootstrap that wires
 * everything together, and the UI that was always specific to this file
 * anyway — the main modal (journal/world/relationships/settings tabs), the
 * relationship graph, and the settings panel. These reach the modules above
 * through the `Store`/`Persistence`/`ProfileSession`/`Pipeline`/`HUD` handles
 * set up in the bootstrap, exactly like the pre-split code already reached
 * TimelineEngine/WorldAgent/etc. through module handles of the same shape.
 * A few small UI-only helpers (getInventoryOutfit, renderModal, syncToCharTracker,
 * etc.) stay here and are reached FROM those modules via `window.<fn>()`, since
 * a classic script can't be an `import` target the other direction.
 */

// --- Expose UI-only helpers on window ---------------------------------------
// index.js's header comment above assumes this file runs as a classic
// (non-module) <script>, where a top-level `function foo(){}` becomes
// `window.foo` for free. In practice SillyTavern loads extension entry
// points via dynamic `import()`, which always evaluates the file as a real
// ES module — and inside a module, top-level function declarations are
// module-scoped only; they never leak onto `window`. HUD.js and Pipeline.js
// are separate ES modules that reach these UI-only helpers via
// `window.renderModal()` / `window.getInventoryOutfit()` / etc. (since a
// classic script can't be an `import` target the other direction — see the
// header comment), so without this explicit attachment those calls throw
// "window.<fn> is not a function" the moment the calling module fires.
// getDayOfWeek was the one exception that didn't outright crash — HUD.js
// guards it with `window.getDayOfWeek ? window.getDayOfWeek(...) : null` —
// but that meant the HUD's day-of-week display silently never rendered;
// it's included here too so it actually works instead of quietly no-op'ing.
// Safe to do up here despite the definitions appearing later in the file:
// function declarations are hoisted to the top of their enclosing scope
// (module top-level, in this case), so all four already exist by the time
// this line runs.
window.renderModal = renderModal;
window.getInventoryOutfit = getInventoryOutfit;
window.syncToCharTracker = syncToCharTracker;
window.updateSettingsUI = updateSettingsUI;
window.renderAutoInfo = renderAutoInfo;
window.renderRelationshipGraph = renderRelationshipGraph;
window.getDayOfWeek = getDayOfWeek;

var DEFAULT_SETTINGS = {
    enabled: true,
    showHUD: true,
    hudScale: 100,
    hudTimeTint: true,        // subtle HUD background tint that follows the RP clock (see HUD.js)
    showChatButton: true,
    autoUpdate: true,
    showCityCountry: false,
    useConnectionProfile: false, 
    connectionProfile: "",       
    _restoreProfile: "",
    _restoreWorldProfile: "",
    // Single marker for the unified cross-tracker profile session (see runTrackerProfileSession)
    // that replaced the three separate switch-then-immediately-restore wrappers below. Same
    // crash-recovery purpose as the three _restore* fields above (interrupted page reload
    // mid-switch), just one field instead of three since there's now only ever one "original
    // profile to go back to" per pipeline run, however many trackers/targets it touches.
    _restoreTrackerProfile: "",
    hudLeft: null,            // Saved HUD position — raw CSS pixels (null = use stylesheet default)
    hudTop:  null,

    // Custom Color Settings (Warm gold/amber default matching the image mockup)
    accentR: 216,
    accentG: 160,
    accentB: 64,

    // World Agent Settings
    // "enabled" now covers BOTH running the agent AND injecting its context — the old separate
    // injectWorldContext checkbox is gone. If any of these are off, that tracker neither runs
    // nor injects, same as before but with one fewer setting to misconfigure.
    worldEnabled: false,
    useWorldProfile: false,
    worldConnectionProfile: "",
    // NOTE: the world-seed lorebook is intentionally NOT here — it's PER-CHAT
    // (stored in worldData, chosen from the World tab), since different cards/chats
    // use different books. See Pipeline.getSeedLorebookText / makeDefaultWorldData.
    maxWorldTicks: 3, // per-tier catchup cap, passed to Scheduler.evaluate() as maxCatchupTicks

    // When multiple world tiers are due on the same message (common after a big time
    // skip), OFF (default) runs them one at a time, same behavior as before — safest
    // for accounts on tight per-minute rate limits. ON runs npc/weather/faction
    // concurrently (they don't depend on each other's fresh output this tick) and only
    // runs world afterward, since world's prompt wants faction's just-produced events.
    // Opt-in because concurrent calls mean concurrent rate-limit consumption.
    parallelWorldTiers: false,

    // Seasonal grounding — a light, optional line of context ("current season: winter")
    // fed into the Weather and World tier prompts, computed from the real RP calendar
    // date. "none" disables it entirely (e.g. for settings with no real-season mapping).
    seasonHemisphere: "northern", // "northern" | "southern" | "none"

    // Scheduler tier intervals, in RP-MINUTES. Internal to the "World" category in the settings
    // panel (per the 3-category decision: Scene/World/Relationship) — these are the advanced
    // knobs behind the single "World" toggle, not separate top-level enable switches.
    sceneTierMinutes: 5,
    npcTierMinutes: 30,
    weatherTierMinutes: 1440,
    factionTierMinutes: 360,
    worldTierMinutes: 1440,

    // Relationship Tracker Settings — stays on its own message-count cadence, decoupled from
    // the RP-clock Scheduler tiers (explicit decision: message count is best for relationships).
    relationsEnabled: false,
    relationsAutoUpdate: true,
    relAutoInterval: 5,
    startupDelay: 2000,
    useRelProfile: false,
    relConnectionProfile: "",
    _restoreRelProfile: "",

    // Time Mode — how the LLM decides real elapsed time. The clock ALWAYS advances a flat
    // 1 minute per message on its own regardless of mode (advanceBaseline) — that's purely
    // cosmetic continuity so the HUD never looks frozen. Which of the two modes below is
    // active decides what, if anything, OVERRIDES that flat tick with a real LLM-reasoned
    // duration:
    //
    //  "message" (default) — cadence-based, same philosophy as the Relationship tracker's
    //  message-interval mode. Every messageModeInterval messages, ONE LLM call reviews the
    //  whole batch since the last check-in and decides its total real elapsed time (using
    //  TimelineEngine's pacing-example guide to stay grounded), replacing the flat ticks
    //  that accumulated during that batch.
    //
    //  "smart" — event-driven. A cheap local trigger (TimelineEngine.detectTimeSkipTrigger)
    //  scans every message for genuine time-skip language and, only when it fires, calls
    //  the LLM immediately to resolve that one message on the spot.
    //
    // Both modes share the same resolver contract (elapsed / schedule / advance_to_event /
    // none) and the same sanity ceiling — the LLM only ever proposes a duration, JS still
    // does the actual date math and enforces the cap either way.
    timeMode: "message",
    messageModeInterval: 5,
    // Extra Smart Time trigger phrases, one per line (settings textarea). Fuzzy-matched
    // alongside the built-in lexicon by TimelineEngine.detectTimeSkipTrigger — and the
    // only way the trigger can fire for non-English RP, since the built-ins are
    // English-only. Stored as the raw textarea string; parsed on use.
    customSkipPhrases: ""
};
// Module handles populated by the bootstrap below — declared at top level (classic-script
// global scope) so every retained function in this file, hoisted above or below this line,
// can see them. Same mechanism the original file already relied on for TimelineEngine/
// WorldAgent/etc. being set inside the init closure but read by functions declared outside it.
var Store, Persistence, ProfileSession, Pipeline, HUD, LLMResponseParser;

// --- Init ---
jQuery(async function () {
    try {
        Store = await import("./Store.js");
        Persistence = await import("./Persistence.js");
        ProfileSession = await import("./ProfileSession.js");
        Pipeline = await import("./Pipeline.js");
        HUD = await import("./HUD.js");
        LLMResponseParser = await import("./LLMResponseParser.js");

        var m = await import("../../../extensions.js");
        var extSettings = m.extension_settings;
        var saveFn = m.saveSettingsDebounced;
        var saveMetaFn = m.saveMetadataDebounced;

        var scriptModule = await import("../../../../script.js");
        var genRaw = (typeof scriptModule.generateRaw === "function") ? scriptModule.generateRaw : null;

        var runSlash = null;
        try {
            var sc = await import("../../../slash-commands.js");
            if (typeof sc.executeSlashCommandsWithOptions === "function") runSlash = sc.executeSlashCommandsWithOptions;
        } catch (e) { console.warn("[Story Tracker] slash-commands.js not available, connection profile switching disabled.", e); }

        Store.setBootstrap({
            extSettings: extSettings, saveFn: saveFn, saveMetaFn: saveMetaFn,
            scriptModule: scriptModule, genRaw: genRaw, runSlash: runSlash,
        });

        // --- Timeline Engine rewrite: pure JS simulation-authority modules ---
        // Loaded as sibling ES modules via relative dynamic import — no manifest
        // change needed, SillyTavern serves the whole extension folder statically.
        var TimelineEngine = await import("./TimelineEngine.js");
        var Scheduler = await import("./Scheduler.js");
        var EventQueue = await import("./EventQueue.js");
        var SceneAgent = await import("./SceneAgent.js");
        var WorldAgent = await import("./WorldAgent.js");
        var RelationshipAgent = await import("./RelationshipAgent.js");
        Store.setAgentModules({
            TimelineEngine: TimelineEngine, Scheduler: Scheduler, EventQueue: EventQueue,
            SceneAgent: SceneAgent, WorldAgent: WorldAgent, RelationshipAgent: RelationshipAgent,
        });

        Persistence.loadSettings(DEFAULT_SETTINGS);
        applyCustomAccentColor();

        buildModal();
        HUD.buildHUD();
        buildSettingsPanel();
        buildChatButton();
        Pipeline.bindEvents();
        registerStoryMacros();

        // Load per-chat data for whatever chat is ALREADY open at init time —
        // bindEvents only reacts to future CHAT_CHANGED events, so without this,
        // a chat opened before the extension finished loading stayed untracked
        // (null storyData) until the user switched chats or opened the modal.
        if (Store.isChatOpen()) {
            Persistence.loadStoryData();
            HUD.renderHUD();
        }

        setTimeout(function () { ProfileSession.recoverProfileIfNeeded(); }, 1500);

        // Clamping check on browser screen changes or rotations
        $(window).on("resize", function() {
            HUD.applyHudStyle();
        });

        console.log("[Story Tracker] Loaded!");
    } catch (e) { console.error("[Story Tracker] Init error:", e); }
});

function applyCustomAccentColor() {
    var r = (Store.settings && Store.settings.accentR !== undefined) ? Store.settings.accentR : 216;
    var g = (Store.settings && Store.settings.accentG !== undefined) ? Store.settings.accentG : 160;
    var b = (Store.settings && Store.settings.accentB !== undefined) ? Store.settings.accentB : 64;
    
    document.documentElement.style.setProperty('--st-custom-accent', `rgb(${r}, ${g}, ${b})`);
    document.documentElement.style.setProperty('--st-custom-accent-alpha', `rgba(${r}, ${g}, ${b}, 0.12)`);
    document.documentElement.style.setProperty('--st-custom-accent-alpha-high', `rgba(${r}, ${g}, ${b}, 0.25)`);

    // Compute a contrast-safe text color (pure black or pure white) based on accent luminance.
    // This keeps pill button text crisp/readable regardless of which accent color is picked,
    // instead of a hardcoded dark gray that goes muddy on darker or saturated accents.
    var luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    var contrastText = luminance > 0.6 ? "#1c1c1a" : "#ffffff";
    document.documentElement.style.setProperty('--st-custom-accent-text', contrastText);
    
    $("#st-rgb-preview").css("background-color", `rgb(${r}, ${g}, ${b})`);
}

// Quotes are escaped as well as &<> because this helper's output is also used
// inside HTML attribute values (title="...", data-name="...") — an unescaped
// quote in LLM-authored text (character names, event text) breaks out of the
// attribute, and a crafted one could inject live handlers.
function esc(t) { var d = document.createElement("div"); d.textContent = t == null ? "" : t; return d.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;"); }
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
                            return (Store.storyData && Store.storyData[m.key]) ? Store.storyData[m.key] : "Unknown";
                        },
                        category: "Story Tracker",
                        description: "Tracked narrative value for " + m.key
                    });
                } catch(e) {
                    try {
                        context.macros.register(m.name, function() {
                            return (Store.storyData && Store.storyData[m.key]) ? Store.storyData[m.key] : "Unknown";
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

/** "HH:MM" → 0..100 percent through the 24h day, for the NPC routine timeline
 * strips (Direction B). Returns null for anything unparseable. */
function clockToPct(timeStr) {
    var m = String(timeStr || "").match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    var mins = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    if (isNaN(mins) || mins < 0 || mins > 1439) return null;
    return (mins / 1440) * 100;
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

// Purely a rendering aid — keeps the World tab from turning into an ever-growing wall of
// always-expanded boxes as NPCs/events/reveals accumulate over a long story. The three
// "grows without bound" list sections (NPC/Reveals/Events) collapse by default; the
// Summary and Scheduled Events stay open since they're the primary/actionable content.
// Collapse state is UI-only, kept in memory for this modal session — not worth a settings
// field for something this cosmetic, and it re-defaults sensibly on next open.
var worldCollapseState = { npc: true, reveals: true, events: true, codex: true, rules: true }; // true = collapsed
// Which NPCs' routine strips are expanded to the full inline schedule (tap-to-
// toggle — hover tooltips are useless on touch). In-memory, per modal session,
// same philosophy as worldCollapseState.
var routineExpandState = {};
// Relations-board inline editors (per modal session, file-scope so they survive
// full graph re-renders): which bond's ✎ editor is open ("from␟to"), and
// whether the filtered character's bio editor / add-bond form is open.
var relCardEditKey = null;
var relBioEditOpen = false;
var relAddOpen = false;
// View/Edit mode for the whole modal (default: VIEW — read-only). Toggled by
// the header pencil (see setModalEditMode in buildModal): in view mode every
// mutating control — the tiny goal/routine ×'s, trashes, wands, pins,
// add-forms, strength sliders — is hidden or inert via the
// #st-modal:not(.st-edit-mode) rules in style.css, so one deliberate tap
// always stands between browsing and an accidental deletion (the fat-finger
// risk is worst on touch). Session-scoped; every page load starts in view.
var modalEditMode = false;
function worldCollapseSectionHtml(key, title, icon, tier, contentId, emptyText) {
    var collapsed = worldCollapseState[key] !== false;
    // tier is optional — sections not backed by a regenerable World Agent tier
    // (e.g. the Location Codex, which the Scene tick maintains) get no wand button.
    var wandHtml = tier
        ? '<button class="st-wand-regen" data-tier="' + tier + '" title="Regenerate ' + esc(title) + '"><i class="fa-solid fa-wand-magic-sparkles"></i></button>'
        : '';
    // st-wsec-<key> carries the section's category hue (left border, see style.css) —
    // a collapsed section stays identifiable by color before its title is read.
    return '<div class="st-journal-section st-collapse-section st-wsec-' + key + '">' +
        '<div class="st-sec-title-row st-collapse-toggle" data-collapse-key="' + key + '">' +
            '<div class="st-journal-sec-title"><i class="fa-solid ' + icon + '" style="margin-right:6px;opacity:0.75;"></i>' + esc(title) + ' <span class="st-collapse-count" id="' + contentId + '-count"></span></div>' +
            '<div style="display:flex;align-items:center;gap:8px;">' +
                wandHtml +
                '<i class="fa-solid fa-chevron-down st-collapse-chevron' + (collapsed ? '' : ' st-collapse-chevron-open') + '"></i>' +
            '</div>' +
        '</div>' +
        '<div class="st-world-list st-collapse-body" id="' + contentId + '" style="' + (collapsed ? 'display:none;' : '') + '"><i>' + esc(emptyText) + '</i></div>' +
    '</div>';
}

/** Updates a collapsible World-tab section's little count chip (e.g. "12") next to its title; hides the chip entirely at 0 so an empty section doesn't look falsely active. */
function setWorldCollapseCount(contentId, count) {
    var $chip = $("#" + contentId + "-count");
    if (!$chip.length) return;
    if (count > 0) $chip.text(count).show(); else $chip.hide();
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
    h += '<div class="st-header-actions">';
    h += '<span class="st-editmode-chip" id="st-editmode-chip" style="display:none;">Editing</span>';
    h += '<button class="st-hdr-btn menu_button" id="st-h-editmode" title="Edit mode — reveal editing tools (deletes, regenerates, sliders)"><i class="fa-solid fa-pen"></i></button>';
    h += '<button class="st-hdr-btn menu_button" id="st-h-close" title="Close"><i class="fa-solid fa-xmark"></i></button>';
    h += '</div>';
    h += '</div>';
    
    // Segmented Pill Tab Controls
    // Tabs carry state (Direction C): Relations shows its tracked-edge count,
    // World gets a dot when any tier is due to fire — both kept in sync by
    // renderModal, so the chrome says where something is happening before you click.
    h += '<div class="st-tabs">' +
         '<div class="st-tab st-tab-active" data-target="st-tab-current">Scene</div>' +
         '<div class="st-tab" data-target="st-tab-history">History</div>' +
         '<div class="st-tab" data-target="st-tab-world">World<span class="st-tab-due" id="st-world-tab-due" style="display:none;"></span></div>' +
         '<div class="st-tab" data-target="st-tab-relations"><i class="fa-solid fa-share-nodes" style="margin-right:4px;font-size:10px;"></i>Relations<span class="st-tab-badge" id="st-rel-tab-badge" style="display:none;"></span></div>' +
         '</div>';
    
    h += '<div class="st-body">';
    
    // Current Scene Panel
    h += '<div id="st-tab-current">';
    h += '<div class="st-no-data" id="st-no-data" style="display:none"><i class="fa-solid fa-hourglass-start"></i><div>Waiting for first update...</div></div>';
    h += '<div id="st-content-area">';
    
    // Structured Sentence Meta Blocks
    h += '<div class="st-journal-meta" style="position:relative;">';
    h += '  <div class="st-meta-line"><i class="fa-regular fa-clock"></i> <span id="st-val-dow"></span>, <span id="st-val-date"></span> &bull; <span id="st-val-time"></span> <button class="st-wand-regen" id="st-time-correct-btn" title="Correct the tracked clock"><i class="fa-solid fa-pen"></i></button></div>';
    h += '  <div class="st-meta-line"><i class="fa-solid fa-location-dot"></i> <span id="st-val-loc"></span><span id="st-city-country-row">, <span id="st-val-city-country"></span></span></div>';
    h += '  <div class="st-meta-line" id="st-weather-row"><i class="fa-solid fa-cloud-sun" id="st-weather-icon-dynamic"></i> <span id="st-val-temp"></span> &bull; <span id="st-val-weather"></span></div>';
    h += '  <div id="st-time-correct-popout" class="st-add-event-popout" style="display:none;">' +
         '    <div class="st-add-event-popout-head"><span><i class="fa-solid fa-clock-rotate-left"></i> Correct Tracked Time</span><button id="st-time-correct-close" class="st-hdr-btn" title="Close" style="min-width:28px;min-height:28px;font-size:14px;"><i class="fa-solid fa-xmark"></i></button></div>' +
         '    <div class="st-add-event-popout-body">' +
         '      <div class="st-add-event-row"><label>Time (HH:MM)</label><input type="text" id="st-time-correct-time" placeholder="14:30" /></div>' +
         '      <div class="st-add-event-row"><label>Date (DD/MM/YYYY)</label><input type="text" id="st-time-correct-date" placeholder="09/07/2026" /></div>' +
         '      <div class="st-add-event-row"><label class="checkbox_label" style="display:flex;align-items:flex-start;gap:6px;"><input type="checkbox" id="st-time-correct-resync" checked style="margin-top:3px;" /><span style="font-size:11px;line-height:1.4;">Also resync scene/world/relationship checkpoints to the current message (recommended after deleting or rewriting messages)</span></label></div>' +
         '      <div class="st-add-event-popout-note">This resets the clock and checkpoints going forward only — it does not remove any world events, NPC changes, or relationship history already generated. Edit or remove those individually if needed.</div>' +
         '      <div class="st-add-event-actions"><button class="menu_button st-pill-btn" id="st-time-correct-save"><i class="fa-solid fa-check"></i> Apply</button></div>' +
         '    </div>' +
         '  </div>';
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

    // World Lorebooks panel (per chat) — lifted to the very top of the World tab.
    // Body filled by renderWorldLorebooksPanel() (view summary / edit controls); the
    // entry-picker popout is a static sibling so it survives body re-renders.
    h += '  <div class="st-journal-section st-worldbooks-panel" style="position:relative;">' +
         '    <div class="st-sec-title-row"><div class="st-journal-sec-title"><i class="fa-solid fa-book"></i> World Lorebooks <span style="opacity:.55;font-weight:normal;font-size:.8em;">— this chat</span></div></div>' +
         '    <div id="st-worldbooks-body"></div>' +
         '    <div id="st-worldbooks-entry-popout" class="st-add-event-popout" style="display:none;">' +
         '      <div class="st-worldbooks-entry-stickytop" style="position:sticky;top:0;z-index:1;background:var(--st-journal-bg);border-radius:16px 16px 0 0;">' +
         '        <div class="st-add-event-popout-head" style="border-radius:16px 16px 0 0;"><span><i class="fa-solid fa-list-check"></i> Live entries — <span id="st-worldbooks-entry-popout-book"></span></span><button id="st-worldbooks-entry-close" class="st-hdr-btn" title="Close" style="min-width:28px;min-height:28px;font-size:14px;"><i class="fa-solid fa-xmark"></i></button></div>' +
         '        <div style="padding:8px 10px;">' +
         '          <input type="text" id="st-worldbooks-entry-search" class="text_pole" placeholder="Search entries…" style="width:100%;box-sizing:border-box;" autocomplete="off">' +
         '        </div>' +
         '      </div>' +
         '      <div class="st-add-event-popout-body" id="st-worldbooks-entry-list"></div>' +
         '    </div>' +
         '  </div>';

    // Briefing card (Direction B): summary, season chip, weather trend, and an
    // "as of" clock stamp merged into ONE card — the old separate status strip +
    // summary box read as two disconnected surfaces. Existing element IDs are
    // preserved so renderModal's update logic is unchanged.
    h += '  <div class="st-world-brief">' +
         '    <div class="st-world-brief-top">' +
         '      <span class="st-world-brief-title"><i class="fa-solid fa-earth-americas"></i> World Briefing</span>' +
         '      <span class="st-world-status-chip" id="st-world-chip-season" style="display:none;"><i class="fa-solid fa-leaf"></i><span id="st-world-chip-season-text"></span></span>' +
         '      <button class="st-wand-regen" data-tier="world" title="Regenerate World Summary"><i class="fa-solid fa-wand-magic-sparkles"></i></button>' +
         '    </div>' +
         '    <div class="st-world-brief-summary" id="st-world-val-summary">No summary available yet.</div>' +
         '    <div class="st-world-brief-trend" id="st-world-chip-weather"><i class="fa-solid fa-cloud-sun"></i><span id="st-world-chip-weather-text">No weather trend yet.</span>' +
         '      <button class="st-wand-regen" data-tier="weather" title="Regenerate Weather Trend"><i class="fa-solid fa-wand-magic-sparkles"></i></button></div>' +
         '    <div class="st-world-brief-asof" id="st-world-brief-asof"></div>' +
         '  </div>';
    h += worldCollapseSectionHtml('npc', 'NPC Changes', 'fa-users', 'npc', 'st-world-val-npcs', 'No NPC changes.');
    h += worldCollapseSectionHtml('reveals', 'Pending Discoveries', 'fa-eye-slash', 'faction', 'st-world-val-reveals', 'No pending discoveries.');
    h += worldCollapseSectionHtml('events', 'World Events', 'fa-scroll', 'faction', 'st-world-val-events', 'No events.');
    // Location Codex — maintained by the Scene tick on location changes (see
    // Pipeline.doLLMUpdate), not by a World Agent tier, hence no regen wand.
    h += worldCollapseSectionHtml('codex', 'Location Codex', 'fa-map-location-dot', null, 'st-world-val-codex', 'No locations remembered yet — entries appear when the scene moves somewhere else.');
    // World Rules — the genesis-distilled lore digest (see WorldAgent's WORLD RULES
    // DIGEST section). Deliberately fully editable: this list is the verification
    // surface for what the world simulation treats as ground truth, so rules can be
    // deleted or added by hand, and the wand re-distills from the raw card on
    // demand (the one post-genesis action that ever sends card text again).
    h += worldCollapseSectionHtml('rules', 'World Rules', 'fa-scale-balanced', 'rules', 'st-world-val-rules', 'No world rules yet — distilled automatically when a new chat begins.');
    h += '  <div class="st-journal-section" style="position:relative;"><div class="st-sec-title-row"><div class="st-journal-sec-title">Scheduled Events</div><button class="menu_button st-pill-btn" id="st-world-btn-add-event" title="Add a scheduled event"><i class="fa-solid fa-calendar-plus"></i> Add Event</button></div>';
    h += '    <div id="st-world-add-event-popout" class="st-add-event-popout" style="display:none;">' +
         '      <div class="st-add-event-popout-head"><span><i class="fa-solid fa-calendar-plus"></i> Schedule an Event</span><button id="st-evt-close-popout" class="st-hdr-btn" title="Close" style="min-width:28px;min-height:28px;font-size:14px;"><i class="fa-solid fa-xmark"></i></button></div>' +
         '      <div class="st-add-event-popout-body">' +
         '        <div class="st-add-event-row"><label>What happens</label><input type="text" id="st-evt-desc" placeholder="A messenger arrives with news from the capital" /></div>' +
         '        <div class="st-add-event-row"><label>When</label>' +
         '          <div class="st-add-event-when-row">' +
         '            <span>In</span>' +
         '            <input type="number" id="st-evt-amount" min="1" step="1" value="1" />' +
         '            <select id="st-evt-unit">' +
         '              <option value="1">minutes</option>' +
         '              <option value="60" selected>hours</option>' +
         '              <option value="1440">days</option>' +
         '            </select>' +
         '          </div>' +
         '          <div class="st-add-event-preview" id="st-evt-preview">Resolves around --:--, --/--/----</div>' +
         '        </div>' +
         '        <div class="st-add-event-row"><label>Repeats</label>' +
         '          <select id="st-evt-repeat">' +
         '            <option value="0" selected>Never (one-time)</option>' +
         '            <option value="1440">Daily</option>' +
         '            <option value="10080">Weekly</option>' +
         '          </select>' +
         '        </div>' +
         '        <div class="st-add-event-actions"><button class="menu_button st-pill-btn" id="st-evt-save"><i class="fa-solid fa-check"></i> Schedule</button></div>' +
         '      </div>' +
         '    </div>';
    h += '    <div class="st-world-list" id="st-world-val-pending"><i>No scheduled events.</i></div></div>';
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
         '    <button class="menu_button st-pill-btn" id="st-rel-btn-reset-layout" title="Reset node positions and pan/zoom"><i class="fa-solid fa-arrows-to-circle"></i> Reset Layout</button>' +
         '    <button class="menu_button st-pill-btn" id="st-rel-btn-clear" style="color:#ff453a !important;"><i class="fa-solid fa-trash-can"></i> Clear</button>' +
         '  </div>';
    h += '  <div class="st-auto-wrap"><div class="st-auto-bar" id="st-auto-bar" style="display:none;"><span id="st-auto-bar-fill"></span></div><div class="st-auto-info" id="st-auto-info"></div></div>';
    h += '</div></div></div>';
    document.body.insertAdjacentHTML("beforeend", h);

    // Reparent the popouts up to #st-modal (out of .st-dialog, which has a transform +
    // overflow:hidden that would trap AND clip a centered position:fixed child). At the
    // #st-modal level (fixed, inset:0, no transform) they center on the viewport instead
    // of dropping to the bottom of the scrollable dialog. All their handlers are
    // id-delegated, so moving the DOM location changes nothing else.
    (function reparentPopoutsToModal() {
        var modalEl = document.getElementById("st-modal");
        if (!modalEl) return;
        ["st-world-add-event-popout", "st-worldbooks-entry-popout"].forEach(function(id) {
            var el = document.getElementById(id);
            if (el) modalEl.appendChild(el);
        });
    })();

    $(document).on("click", ".st-overlay, #st-h-close", function() {
        // Don't leave a centered popout floating over the next open of the modal.
        $("#st-world-add-event-popout, #st-worldbooks-entry-popout").hide();
        $("#st-modal").fadeOut(150);
    });

    // --- View/Edit mode toggle (see the modalEditMode declaration for why) ---
    // Leaving edit mode also closes any open inline editors/popouts, so view
    // mode can never show a stranded form whose buttons are hidden.
    function setModalEditMode(on) {
        modalEditMode = !!on;
        $("#st-modal").toggleClass("st-edit-mode", modalEditMode);
        $("#st-h-editmode").toggleClass("st-hdr-btn-active", modalEditMode);
        $("#st-editmode-chip").toggle(modalEditMode);
        if (!modalEditMode) {
            relCardEditKey = null; relBioEditOpen = false; relAddOpen = false;
            $("#st-world-add-event-popout").hide();
            $("#st-time-correct-popout").hide();
            $("#st-worldbooks-entry-popout").hide();
        }
        renderModal();
        if ($("#st-tab-relations").is(":visible")) renderRelationshipGraph();
    }
    $(document).on("click", "#st-h-editmode", function() { setModalEditMode(!modalEditMode); });
    $(document).on("click", "#st-f-update", Pipeline.doManualUpdate);
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

        // Refresh the footer countdown text to match whichever tab is now active
        renderAutoInfo();
    });

    // World control routing
    $(document).on("click", "#st-world-btn-tick", async function() {
        await Pipeline.runManualWorldTick();
    });
    $(document).on("click", "#st-world-btn-clear", function() {
        if (confirm("Are you sure you want to clear world progression history?")) {
            Store.setWorldData(Persistence.makeDefaultWorldData());
            Persistence.saveWorldData();
            renderModal(); HUD.renderHUD();
            if (typeof toastr !== "undefined") toastr.info("World state cleared.");
        }
    });
    // Custom drag-to-resize handle for textareas — native CSS `resize: vertical` simply
    // doesn't render a usable grip on most mobile browsers, so on mobile a resizable
    // textarea is effectively stuck at its starting height. Pointer Events unify mouse
    // and touch, so this one handler works on both. Delegated + registered once here
    // (delegated once here, never re-bound by panel re-renders) so
    // repeatedly opening/closing the panel never stacks up duplicate listeners.
    $(document).on("pointerdown", ".st-resize-handle", function(e) {
        var $handle = $(this);
        var $textarea = $handle.siblings("textarea");
        if ($textarea.length === 0) return;
        e.preventDefault();
        var startY = e.clientY;
        var startHeight = $textarea.outerHeight();
        $handle.addClass("st-resize-active");
        var move = function(ev) {
            var dy = ev.clientY - startY;
            var newHeight = Math.max(40, startHeight + dy);
            $textarea.css("height", newHeight + "px");
        };
        var up = function() {
            $handle.removeClass("st-resize-active");
            $(document).off("pointermove", move).off("pointerup", up);
        };
        $(document).on("pointermove", move).on("pointerup", up);
    });

    $(document).on("click", "#st-world-btn-refresh", function() {
        Persistence.loadWorldData();
        renderModal(); HUD.renderHUD();
        if (typeof toastr !== "undefined") toastr.info("World data refreshed.");
    });

    // Per-section "regenerate" (wand) buttons — re-run just that one World Agent
    // tier on demand, instead of waiting for its scheduled interval or running
    // all four tiers via "Run Tick". See regenerateWorldSection() for details.
    $(document).on("click", ".st-wand-regen", async function(e) {
        e.stopPropagation();
        var tier = $(this).data("tier");
        await Pipeline.regenerateWorldSection(tier, $(this));
    });

    // Collapsible World-tab sections (NPC Changes / Pending Discoveries / World Events) —
    // toggles both the visible body and the in-memory state so it stays collapsed/expanded
    // across a renderModal() re-render within the same session (e.g. after a tick completes).
    $(document).on("click", ".st-collapse-toggle", function() {
        var key = $(this).data("collapse-key");
        var $body = $(this).closest(".st-collapse-section").find(".st-collapse-body");
        var $chevron = $(this).find(".st-collapse-chevron");
        var nowCollapsed = $body.is(":visible");
        $body.slideToggle(150);
        $chevron.toggleClass("st-collapse-chevron-open", !nowCollapsed);
        worldCollapseState[key] = nowCollapsed;
    });

    // --- Manual "calendar" event scheduling ---
    function updateEventPreview() {
        if (!Store.TimelineEngine || !Store.storyData || !Store.storyData.time || !Store.storyData.date) return;
        var amount = Number($("#st-evt-amount").val());
        var unitMinutes = Number($("#st-evt-unit").val());
        if (!(amount > 0) || !unitMinutes) { $("#st-evt-preview").text("Resolves around --:--, --/--/----"); return; }
        var base = Store.TimelineEngine.parseDateTime(Store.storyData.time, Store.storyData.date);
        if (!base) return;
        var resolved = Store.TimelineEngine.addMinutesToDate(base, amount * unitMinutes);
        $("#st-evt-preview").text("Resolves around " + Store.TimelineEngine.formatTime(resolved) + ", " + Store.TimelineEngine.formatDate(resolved) + " (RP time)");
    }
    $(document).on("click", "#st-world-btn-add-event", function() {
        var $popout = $("#st-world-add-event-popout");
        if ($popout.is(":visible")) { $popout.hide(); return; }
        $("#st-evt-desc").val("");
        $("#st-evt-amount").val(1);
        $("#st-evt-unit").val("60");
        $("#st-evt-repeat").val("0");
        updateEventPreview();
        $popout.show();
    });
    $(document).on("click", "#st-evt-close-popout", function() {
        $("#st-world-add-event-popout").hide();
    });
    // Click-outside-to-close, same pattern as any lightweight popover.
    $(document).on("click", function(e) {
        var $popout = $("#st-world-add-event-popout");
        if (!$popout.is(":visible")) return;
        if ($(e.target).closest("#st-world-add-event-popout, #st-world-btn-add-event").length === 0) {
            $popout.hide();
        }
    });
    $(document).on("input change", "#st-evt-amount, #st-evt-unit", updateEventPreview);
    $(document).on("click", "#st-evt-save", function() {
        if (!Store.EventQueue) { if (typeof toastr !== "undefined") toastr.error("Event Queue module not loaded yet."); return; }
        if (!Store.isChatOpen() || !Store.storyData) { if (typeof toastr !== "undefined") toastr.warning("No active chat is open."); return; }

        var amount = Number($("#st-evt-amount").val());
        var unitMinutes = Number($("#st-evt-unit").val());
        var desc = ($("#st-evt-desc").val() || "").trim();
        var repeatMinutes = Number($("#st-evt-repeat").val()) || 0;

        if (!desc) { if (typeof toastr !== "undefined") toastr.warning("Please describe what happens."); return; }
        if (!(amount > 0)) { if (typeof toastr !== "undefined") toastr.warning("Please enter how long until this happens."); return; }
        var duration = Math.round(amount * unitMinutes);

        Persistence.loadWorldData();
        try {
            Store.worldData._eventQueue = Store.EventQueue.enqueue(Store.worldData._eventQueue || [], {
                actor: null,
                action: desc,
                startTime: Store.storyData.time,
                startDate: Store.storyData.date,
                durationMinutes: duration,
                recurringMinutes: repeatMinutes > 0 ? repeatMinutes : null,
                meta: { origin: "manual" },
            });
            Persistence.saveWorldData();
            $("#st-world-add-event-popout").hide();
            renderModal(); HUD.renderHUD();
            if (typeof toastr !== "undefined") toastr.success("Event scheduled.");
        } catch (e) {
            if (typeof toastr !== "undefined") toastr.error("Could not schedule event: " + e.message);
        }
    });
    // Cancel a pending scheduled event (manual or agent-scheduled) directly from the list.
    $(document).on("click", ".st-cancel-pending-evt", function() {
        var id = $(this).data("id");
        if (!Store.EventQueue || !Store.worldData || !id) return;
        Store.worldData._eventQueue = Store.EventQueue.cancelEvent(Store.worldData._eventQueue || [], id);
        Persistence.saveWorldData();
        renderModal(); HUD.renderHUD();
        if (typeof toastr !== "undefined") toastr.info("Scheduled event cancelled.");
    });

    // Pin/unpin a world event — a pinned event is exempt from trimWorldEvents' importance-based
    // pruning (see WorldAgent.js), so a plot-critical development can't get quietly trimmed out
    // of the log during a long campaign just because newer events outrank its importance score.
    $(document).on("click", ".st-pin-event-btn", function() {
        var idx = parseInt($(this).data("index"), 10);
        if (!Store.WorldAgent || !Store.worldData || isNaN(idx)) return;
        Store.worldData.worldEvents = Store.WorldAgent.togglePinned(Store.worldData.worldEvents || [], idx);
        Persistence.saveWorldData();
        renderModal();
        if (typeof toastr !== "undefined") {
            var nowPinned = !!(Store.worldData.worldEvents[idx] && Store.worldData.worldEvents[idx].pinned);
            toastr.info(nowPinned ? "Event pinned — protected from automatic trimming." : "Event unpinned.");
        }
    });

    // --- Manual "correct the clock" control ---
    // The tracked clock and its scene/world/relationship checkpoints only ever move forward
    // (see EventQueue/RelationshipAgent's append/merge-only philosophy) — they never rewind
    // on their own when messages are deleted or heavily rewritten, and an explicit narrative
    // skip larger than the resolver's cap could historically only ever be corrected by editing
    // save data directly. This is the manual escape hatch for both: set the clock to wherever
    // the story actually is, and optionally re-anchor the tracker checkpoints to the current
    // last message so the next scene/world/relationship call reads forward from here rather
    // than replaying anything that got deleted or rewritten.
    $(document).on("click", "#st-time-correct-btn", function() {
        var $popout = $("#st-time-correct-popout");
        if ($popout.is(":visible")) { $popout.hide(); return; }
        if (!Store.isChatOpen() || !Store.storyData) { if (typeof toastr !== "undefined") toastr.warning("No active chat is open."); return; }
        $("#st-time-correct-time").val(Store.storyData.time || "");
        $("#st-time-correct-date").val(Store.storyData.date || "");
        $popout.show();
    });
    $(document).on("click", "#st-time-correct-close", function() {
        $("#st-time-correct-popout").hide();
    });
    // Click-outside-to-close, same pattern as the add-event popout.
    $(document).on("click", function(e) {
        var $popout = $("#st-time-correct-popout");
        if (!$popout.is(":visible")) return;
        if ($(e.target).closest("#st-time-correct-popout, #st-time-correct-btn").length === 0) {
            $popout.hide();
        }
    });
    $(document).on("click", "#st-time-correct-save", function() {
        if (!Store.isChatOpen() || !Store.storyData || !Store.TimelineEngine) { if (typeof toastr !== "undefined") toastr.warning("No active chat is open."); return; }

        var rawTime = ($("#st-time-correct-time").val() || "").trim();
        var rawDate = ($("#st-time-correct-date").val() || "").trim();
        if (!/^\d{1,2}[:.]\d{1,2}$/.test(rawTime)) { if (typeof toastr !== "undefined") toastr.warning("Enter time as HH:MM."); return; }
        if (!/^\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{3,4}$/.test(rawDate)) { if (typeof toastr !== "undefined") toastr.warning("Enter date as DD/MM/YYYY."); return; }

        var newTime = Persistence.sanitizeTimeStr(rawTime, Store.storyData.time);
        var newDate = Persistence.sanitizeDateStr(rawDate, Store.storyData.date);
        var parsed = Store.TimelineEngine.parseDateTime(newTime, newDate);
        if (!parsed) { if (typeof toastr !== "undefined") toastr.error("Could not parse that time/date."); return; }

        Store.storyData.time = newTime;
        Store.storyData.date = newDate;
        Store.storyData._timeEpoch = parsed.getTime();
        // A manual correction re-establishes the clock — the scene tracker's span
        // time-anchor must follow, or the next scene call would measure its
        // elapsed answer from the PRE-correction clock and undo the fix.
        Store.storyData._sceneAnchorTime = newTime;
        Store.storyData._sceneAnchorDate = newDate;
        Store.storyData._sceneAnchorEpoch = parsed.getTime();

        var resync = $("#st-time-correct-resync").is(":checked");
        if (resync) {
            var liveChat = Store.getLiveChat() || [];
            var lastIdx = liveChat.length - 1;
            var lastMsg = liveChat[lastIdx];
            var anchor = (lastMsg && lastMsg.mes) ? String(lastMsg.mes).slice(0, 40) : "";

            Store.storyData._sceneCheckpointIdx = lastIdx;
            Store.storyData._sceneCheckpointAnchor = anchor;

            Persistence.loadWorldData();
            if (Store.worldData) {
                Store.worldData._worldCheckpointIdx = lastIdx;
                Store.worldData._worldCheckpointAnchor = anchor;
                if (Store.worldData._schedulerAccumulated) {
                    Object.keys(Store.worldData._schedulerAccumulated).forEach(function (t) {
                        Store.worldData._schedulerAccumulated[t] = 0;
                    });
                }
                Persistence.saveWorldData();
            }

            Persistence.loadRelationshipData();
            if (Store.relationshipData) {
                Store.relationshipData._checkpointMsgIdx = lastIdx;
                Store.relationshipData._checkpointAnchor = anchor;
                Persistence.saveRelationshipData();
            }
        }

        Persistence.saveStoryData();
        $("#st-time-correct-popout").hide();
        renderModal(); HUD.renderHUD();
        if (typeof toastr !== "undefined") toastr.success("Tracked clock corrected" + (resync ? " and checkpoints resynced." : "."));
    });

    // Relations control routing
    $(document).on("click", "#st-rel-btn-analyze", async function() {
        await Pipeline.runManualRelationshipAnalysis();
    });
    $(document).on("click", "#st-rel-btn-reset-layout", function() {
        if (!Store.relationshipData) return;
        if (!confirm("Reset the graph layout? This clears saved node positions and pan/zoom, and re-arranges everything automatically.")) return;
        (Store.relationshipData.nodes || []).forEach(function(n) { delete n.x; delete n.y; });
        Store.relationshipData._view = null;
        Store.setRelEditingNode(null);
        Persistence.saveRelationshipData();
        renderRelationshipGraph();
        if (typeof toastr !== "undefined") toastr.info("Graph layout reset.");
    });
    $(document).on("click", "#st-rel-btn-clear", function() {
        if (!confirm("Clear all relationship tracking data?")) return;

        Store.setRelationshipData(Persistence.makeDefaultRelationshipData());
        Store.setRelEditingNode(null);
        Store.setRelSelectedNode(null);

        // make sure graph immediately enters empty state
        Store.relationshipData._initialized = false;

        Persistence.saveRelationshipData();

        // refresh everything that consumes relationship state
        renderRelationshipGraph();
        HUD.renderHUD();
        renderModal();

        // refresh injected prompt context too
        if (Store.settings.enabled) Pipeline.injectContextToChat();

        $(document).trigger("ST_FORCE_RENDER");

        if (typeof toastr !== "undefined") {
            toastr.info("Relationship data cleared.");
        }
    });

    // Stop tracking an NPC entirely — removes their state entry (goal and routine
    // with it) and cancels any still-pending scheduled action of theirs, so an
    // orphaned "arrives at the outpost" can't resolve later and resurrect them
    // as a world event. They can be re-tracked from scratch by a future NPC tick
    // if they stay active in the story (which also clears any _noGoal/_noRoutine
    // opt-outs, since the fresh entry starts clean).
    $(document).on("click", ".st-del-npc", function() {
        var name = $(this).attr("data-name");
        if (!Store.worldData || !name) return;
        if (!confirm('Stop tracking "' + name + '"? Their offscreen state, goal, and routine are removed. (They may be re-tracked automatically if they stay active in the story.)')) return;
        Store.worldData.npcStates = (Store.worldData.npcStates || []).filter(function(n) { return n && n.name !== name; });
        if (Store.EventQueue) {
            Store.worldData._eventQueue = Store.EventQueue.cancelPendingMatching(Store.worldData._eventQueue || [], function(ev) {
                return ev.meta && ev.meta.origin === "npc" && ev.meta.npcName === name;
            });
        }
        Persistence.saveWorldData();
        renderModal(); HUD.renderHUD();
        if (typeof toastr !== "undefined") toastr.info('No longer tracking "' + name + '".');
    });

    // Remove just an NPC's goal/routine. Sets the matching opt-out flag so the
    // agent doesn't simply re-invent one next tick — see WorldAgent's
    // formatNpcsNeedingGoalForPrompt/_noGoal comments for why deletion has to
    // be an opt-out, not a vacancy.
    function removeNpcField(name, field, optOutFlag, label) {
        if (!Store.worldData || !name) return;
        var npc = (Store.worldData.npcStates || []).find(function(n) { return n && n.name === name; });
        if (!npc) return;
        npc[field] = null;
        npc[optOutFlag] = true;
        Persistence.saveWorldData();
        renderModal();
        if (typeof toastr !== "undefined") toastr.info(label + ' removed for "' + name + '" — the tracker won\'t generate a new one for them.');
    }
    $(document).on("click", ".st-del-npc-goal", function() {
        removeNpcField($(this).attr("data-name"), "goal", "_noGoal", "Goal");
    });
    $(document).on("click", ".st-del-npc-routine", function() {
        removeNpcField($(this).attr("data-name"), "routine", "_noRoutine", "Routine");
    });

    // Tap a routine strip to expand/collapse the full schedule inline — the
    // mobile-friendly replacement for dot hover-tooltips. The × delete inside
    // the row keeps its own behavior.
    $(document).on("click", ".st-routine-toggle", function(e) {
        if ($(e.target).closest(".st-del-npc-routine").length) return;
        var name = $(this).attr("data-name");
        if (!name) return;
        routineExpandState[name] = !routineExpandState[name];
        renderModal();
    });

    // Forget a remembered location from the codex
    $(document).on("click", ".st-del-codex", function() {
        var key = $(this).attr("data-key");
        if (!Store.worldData || !Store.worldData.locationCodex || !key) return;
        if (!confirm("Forget this location's remembered state?")) return;
        delete Store.worldData.locationCodex[key];
        Persistence.saveWorldData();
        renderModal();
        if (typeof toastr !== "undefined") toastr.info("Location memory removed.");
    });

    // --- World Rules editing --- the digest is meant to be VERIFIED, and hand
    // edits are the verification mechanism: delete a wrong rule, type a missing
    // one. No confirm on single-rule delete (small, easily re-added); the wand's
    // full-replace regen is the destructive one and confirms in Pipeline.
    $(document).on("click", ".st-del-rule", function() {
        var idx = parseInt($(this).attr("data-index"), 10);
        if (!Store.worldData || !Array.isArray(Store.worldData.loreDigest) || isNaN(idx)) return;
        if (idx < 0 || idx >= Store.worldData.loreDigest.length) return;
        Store.worldData.loreDigest.splice(idx, 1);
        Persistence.saveWorldData();
        renderModal();
    });
    function addWorldRuleFromInput() {
        if (!Store.worldData) { if (typeof toastr !== "undefined") toastr.warning("No active chat is open."); return; }
        var $input = $("#st-world-rule-input");
        var rule = String($input.val() || "").trim().slice(0, 200);
        if (!rule) return;
        if (!Array.isArray(Store.worldData.loreDigest)) Store.worldData.loreDigest = [];
        if (Store.worldData.loreDigest.length >= 20) {
            if (typeof toastr !== "undefined") toastr.warning("Rule list is full (20 max) — remove one first.");
            return;
        }
        var lower = rule.toLowerCase();
        if (Store.worldData.loreDigest.some(function(r) { return String(r).toLowerCase() === lower; })) {
            if (typeof toastr !== "undefined") toastr.info("That rule is already in the list.");
            $input.val("");
            return;
        }
        Store.worldData.loreDigest.push(rule);
        Persistence.saveWorldData();
        renderModal();
        // renderModal rebuilt the input — refocus the fresh one for quick multi-add.
        $("#st-world-rule-input").focus();
    }
    $(document).on("click", "#st-world-rule-add", addWorldRuleFromInput);

    // --- World Lorebooks panel (top of the World tab, per-chat) --------------
    // seedLorebooks[]  = books distilled (whole) into the World Rules at genesis + wand.
    // contextEntries[] = specific {book,uid,comment} entries fed LIVE to every World
    // Agent run. Both live in worldData; the controls render only in edit mode.

    // Live-filter the lorebook list (edit mode) by book name as the user types.
    $(document).on("input", "#st-worldbooks-book-search", function() {
        var q = String(this.value || "").trim().toLowerCase();
        var $rows = $(".st-worldbook-row");
        if (!q) { $rows.show(); $("#st-worldbooks-book-noresults").hide(); return; }
        var visible = 0;
        $rows.each(function() {
            var hit = ($(this).attr("data-search") || "").indexOf(q) !== -1;
            $(this).toggle(hit);
            if (hit) visible++;
        });
        $("#st-worldbooks-book-noresults").toggle(visible === 0);
    });

    // Toggle a book as a SEED book (whole book → World Rules distillation).
    $(document).on("change", ".st-worldbook-seed", function() {
        if (!Store.worldData) { if (typeof toastr !== "undefined") toastr.warning("No active chat is open."); return; }
        if (!Array.isArray(Store.worldData.seedLorebooks)) Store.worldData.seedLorebooks = [];
        var book = String($(this).data("book"));
        var arr = Store.worldData.seedLorebooks;
        var i = arr.indexOf(book);
        if (this.checked) { if (i === -1) arr.push(book); }
        else if (i !== -1) arr.splice(i, 1);
        Persistence.saveWorldData();
        renderModal();
    });

    // Open the live-entry picker popout for one book (loads its entries on demand).
    $(document).on("click", ".st-worldbook-entries", async function() {
        var book = String($(this).data("book") || "");
        if (!book) return;
        var $pop = $("#st-worldbooks-entry-popout");
        var $list = $("#st-worldbooks-entry-list");
        var $search = $("#st-worldbooks-entry-search");
        $("#st-worldbooks-entry-popout-book").text(book);
        $list.html('<div style="opacity:.6;padding:10px;">Loading entries…</div>');
        $search.val(""); // fresh book, fresh search
        $pop.show();
        var context = (typeof SillyTavern !== "undefined" && typeof SillyTavern.getContext === "function") ? SillyTavern.getContext() : null;
        var data = null;
        try { if (context && typeof context.loadWorldInfo === "function") data = await context.loadWorldInfo(book); } catch (e) { data = null; }
        // The user may have opened another book, or closed the popout, while this awaited.
        if ($("#st-worldbooks-entry-popout-book").text() !== book || $pop.is(":hidden")) return;
        var entries = (data && data.entries && typeof data.entries === "object") ? Object.keys(data.entries).map(function(k){ return data.entries[k]; }) : [];
        if (entries.length === 0) { $list.html('<div style="opacity:.6;padding:10px;">This lorebook has no entries.</div>'); return; }
        entries.sort(function(a,b){ var ao=(typeof a.order==="number")?a.order:100, bo=(typeof b.order==="number")?b.order:100; return ao!==bo?ao-bo:((a.uid||0)-(b.uid||0)); });
        var picks = (Store.worldData && Array.isArray(Store.worldData.contextEntries)) ? Store.worldData.contextEntries : [];
        var pickedUid = {}; picks.forEach(function(p){ if (p && String(p.book) === book) pickedUid[String(p.uid)] = true; });
        var html = '';
        entries.forEach(function(e, idx){
            if (!e || e.uid == null) return;
            var keysArr = Array.isArray(e.key) ? e.key.filter(Boolean) : [];
            var title = (e.comment && String(e.comment).trim()) || (keysArr.length ? keysArr.join(", ") : ("Entry " + (idx + 1)));
            var preview = String(e.content || "").replace(/\s+/g, " ").trim().slice(0, 160);
            var off = e.disable ? ' <span style="opacity:.5;">(off — won\'t inject while disabled)</span>' : '';
            var checked = pickedUid[String(e.uid)] ? ' checked' : '';
            // Search haystack: title + keywords + FULL content (not just the truncated
            // preview) so a match deep in a long entry still surfaces it. Lowercased and
            // placed in a data attribute so filtering (see the search-input handler) is a
            // cheap indexOf per keystroke instead of re-walking the DOM text each time.
            var searchText = (title + " " + keysArr.join(" ") + " " + String(e.content || "")).toLowerCase();
            html += '<label class="st-worldbook-entry-item" data-search="' + esc(searchText) + '" style="display:flex;gap:8px;padding:6px 2px;align-items:flex-start;border-top:1px solid rgba(128,128,128,.14);">' +
                '<input type="checkbox" class="st-worldbook-entry-chk" data-book="' + esc(book) + '" data-uid="' + esc(String(e.uid)) + '"' + checked + '>' +
                '<span style="flex:1;min-width:0;"><b>' + esc(title) + '</b>' + off + (preview ? '<br><span style="opacity:.65;font-size:.82em;">' + esc(preview) + (preview.length >= 160 ? '…' : '') + '</span>' : '') + '</span>' +
            '</label>';
        });
        html += '<div id="st-worldbooks-entry-noresults" style="display:none;opacity:.6;padding:10px;">No entries match your search.</div>';
        $list.html(html);
    });

    // Live-filter the open book's entries as the user types. Matches against each
    // entry's data-search text (title + keywords + full content, not just the
    // truncated preview shown on screen).
    $(document).on("input", "#st-worldbooks-entry-search", function() {
        var q = String(this.value || "").trim().toLowerCase();
        var $items = $("#st-worldbooks-entry-list .st-worldbook-entry-item");
        if (!q) { $items.show(); $("#st-worldbooks-entry-noresults").hide(); return; }
        var visible = 0;
        $items.each(function() {
            var hit = ($(this).attr("data-search") || "").indexOf(q) !== -1;
            $(this).toggle(hit);
            if (hit) visible++;
        });
        $("#st-worldbooks-entry-noresults").toggle(visible === 0);
    });

    // Toggle one entry's live-context membership. No full re-render mid-picking; the
    // per-book "(N)" count and summary refresh when the popout closes.
    $(document).on("change", ".st-worldbook-entry-chk", function() {
        if (!Store.worldData) return;
        if (!Array.isArray(Store.worldData.contextEntries)) Store.worldData.contextEntries = [];
        var book = String($(this).data("book"));
        var uidRaw = $(this).data("uid");
        var uid = (typeof uidRaw === "number") ? uidRaw : (/^\d+$/.test(String(uidRaw)) ? parseInt(uidRaw, 10) : uidRaw);
        var arr = Store.worldData.contextEntries;
        var idx = -1;
        for (var i = 0; i < arr.length; i++) { if (arr[i] && String(arr[i].book) === book && String(arr[i].uid) === String(uid)) { idx = i; break; } }
        if (this.checked) {
            if (idx === -1) {
                var comment = $(this).closest(".st-worldbook-entry-item").find("b").first().text() || "";
                arr.push({ book: book, uid: uid, comment: comment });
            }
        } else if (idx !== -1) {
            arr.splice(idx, 1);
        }
        Persistence.saveWorldData();
    });

    $(document).on("click", "#st-worldbooks-entry-close", function() {
        $("#st-worldbooks-entry-popout").hide();
        renderModal(); // refresh per-book entry counts / the view-mode summary
    });
    // Tap outside to dismiss (mirrors the Add Event popout). Excludes the "entries"
    // buttons so a click that opens one doesn't immediately close it.
    $(document).on("click", function(e) {
        var $pop = $("#st-worldbooks-entry-popout");
        if (!$pop.is(":visible")) return;
        if ($(e.target).closest("#st-worldbooks-entry-popout, .st-worldbook-entries").length === 0) {
            $pop.hide();
            renderModal();
        }
    });
    $(document).on("keydown", "#st-world-rule-input", function(e) {
        if (e.key === "Enter") { e.preventDefault(); addWorldRuleFromInput(); }
    });

    // Delete past summary from history
    $(document).on("click", ".st-del-hist", function() {
        var index = parseInt($(this).data("index"), 10);
        if (Store.storyData && Store.storyData.history && !isNaN(index)) {
            Store.storyData.history.splice(index, 1);
            Persistence.saveStoryData();
            renderModal();
        }
    });
}

function renderModal() {
    if (!Store.isChatOpen() || !Store.storyData) {
        $("#st-no-data").show(); $("#st-content-area").hide();
        $("#st-history-list").html("<div class='st-no-data'>No active chat.</div>");
        $("#st-world-val-summary").text("No active chat.");
        $("#st-world-chip-weather-text").text("No active chat.");
        $("#st-world-chip-season").hide();
        $("#st-world-brief-asof").text("");
        $("#st-world-val-events").html("<i>No active chat.</i>");
        $("#st-world-val-npcs").html("<i>No active chat.</i>");
        $("#st-world-val-reveals").html("<i>No active chat.</i>");
        $("#st-world-val-pending").html("<i>No active chat.</i>");
        $("#st-world-val-codex").html("<i>No active chat.</i>");
        $("#st-world-val-rules").html("<i>No active chat.</i>");
        // These count badges/chips are stateful DOM (jQuery .show()/.hide()), so on
        // returning to a "no chat" state they must be explicitly reset — otherwise
        // they keep showing whatever the previously-open chat last left them at.
        setWorldCollapseCount("st-world-val-events", 0);
        setWorldCollapseCount("st-world-val-npcs", 0);
        setWorldCollapseCount("st-world-val-reveals", 0);
        setWorldCollapseCount("st-world-val-codex", 0);
        setWorldCollapseCount("st-world-val-rules", 0);
        $("#st-rel-tab-badge").hide();
        $("#st-world-tab-due").hide();
        return;
    }
    if (!Store.storyData._initialized) {
        $("#st-no-data").show(); $("#st-content-area").hide();
    } else {
        $("#st-no-data").hide(); $("#st-content-area").show();
        
        // Update header subtitle
        $("#st-modal-subtitle").text(getChatSubtitle());
        
        // Populate standard nodes
        $("#st-val-time").text(Store.storyData.time);
        $("#st-val-date").text(Store.storyData.date);
        var dow = getDayOfWeek(Store.storyData.date);
        $("#st-val-dow").text(dow || "Unknown");
        $("#st-val-loc").text(Store.storyData.location);
        
        if (Store.settings.showCityCountry) {
            let city = Store.storyData.city || "Unknown";
            let country = Store.storyData.country || "Unknown";
            let ccText = (city !== "Unknown" || country !== "Unknown")
                ? [city, country].filter(v => v && v !== "Unknown").join(", ") || "Unknown"
                : "Unknown";
            $("#st-val-city-country").text(ccText);
            $("#st-city-country-row").show();
        } else {
            $("#st-city-country-row").hide();
        }

        $("#st-val-temp").text(Store.storyData.temperature || "Unknown");
        // Scene Agent's weather grounding (see SceneAgent.buildScenePrompt's
        // regionalWeatherTrend) means this should rarely land on "Unknown" once the World
        // Agent's weather tier has ticked at least once — but for a brand-new chat, before
        // that first tick, there's genuinely nothing to go on yet. In that specific gap,
        // fall back to showing the broader regional trend (clearly marked as such) rather
        // than a bare, unhelpful "Unknown".
        var sceneWeatherKnown = Store.storyData.weather && Store.storyData.weather !== "Unknown";
        var trendFallback = (!sceneWeatherKnown && Store.worldData && Store.worldData.weatherTrend) ? Store.worldData.weatherTrend : null;
        $("#st-val-weather").toggleClass("st-val-weather-fallback", !!trendFallback)
            .attr("title", trendFallback ? "Scene-specific weather not yet known — showing the current regional trend instead." : "")
            .text(trendFallback || Store.storyData.weather || "Unknown");
        $("#st-val-events").text(Store.storyData.recent_events);
        
        // Dynamically compute weather icon classes
        var wIcon = "fa-cloud-sun";
        var w = (trendFallback || Store.storyData.weather || "").toLowerCase();
        if (w.includes("rain") || w.includes("дожд")) wIcon = "fa-cloud-rain";
        else if (w.includes("snow") || w.includes("снег")) wIcon = "fa-snowflake";
        else if (w.includes("storm") || w.includes("гроз")) wIcon = "fa-bolt";
        else if (w.includes("fog") || w.includes("туман")) wIcon = "fa-smog";
        else if (w.includes("clear") || w.includes("ясн") || w.includes("солн")) wIcon = "fa-sun";
        else if (w.includes("cloud") || w.includes("облач")) wIcon = "fa-cloud";
        $("#st-weather-icon-dynamic").attr("class", "fa-solid " + wIcon);
        
        var outfit = getInventoryOutfit();
        var userName = (Store.scriptModule && Store.scriptModule.name1) ? Store.scriptModule.name1 : null;

        let cHtml = "";
        if (Store.storyData.characters) {
            Store.storyData.characters.forEach(c => {
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
        if (Store.worldData && Store.worldData.worldSummary && Store.worldData.worldSummary.trim() !== "") {
            $("#st-val-world-summary-preview").text(Store.worldData.worldSummary);
            $("#st-world-preview-section").show();
        } else {
            $("#st-world-preview-section").hide();
        }
    }   
    
    let hHtml = "";
    if (Store.storyData.history && Store.storyData.history.length > 0) {
        Store.storyData.history.forEach((h, i) => {
            // EVERY interpolated field is escaped — h.temperature used to be the one
            // exception here, which made it a stored-XSS sink: applySceneResponse
            // persisted it from raw model output, and this template fed it to .html().
            let weatherInfo = (h.temperature || h.weather) ? ` | ${h.temperature ? esc(h.temperature) : ""}${h.weather ? " " + esc(h.weather) : ""}` : "";
            hHtml += `<div class="st-history-item" style="position: relative;">
                <div class="st-history-meta" style="display: flex; justify-content: space-between; align-items: center;">
                    <span>Update at Msg #${esc(h.msg)}</span>
                    <span style="display: flex; align-items: center; gap: 8px;">
                        ${esc(h.time)} | ${esc(h.loc)}${weatherInfo}
                        <button class="st-del-hist st-hdr-btn menu_button" data-index="${i}" title="Delete Summary" style="padding: 2px 6px !important; font-size: 10px; color: #ff453a; border-color: rgba(255,255,255,0.1); background: transparent;"><i class="fa-solid fa-trash-can"></i></button>
                    </span>
                </div>
                <div class="st-history-sum" style="margin-top: 4px;">${esc(h.events)}</div>
            </div>`;
        });
    } else { hHtml = "<div class='st-no-data'>No history yet.</div>"; }
    $("#st-history-list").html(hHtml);

    // Populate Secondary Tab States
    if (Store.worldData && Store.worldData._initialized) {
        $("#st-world-val-summary").text(Store.worldData.worldSummary || "No summary available yet.");
        $("#st-world-chip-weather-text").text(Store.worldData.weatherTrend || "No weather trend yet.");
        // Briefing "as of" stamp — when the world tier last synthesized (RP clock).
        $("#st-world-brief-asof").text(
            (Store.worldData.lastTickTime && Store.worldData.lastTickDate)
                ? "as of " + Store.worldData.lastTickTime + " · " + Store.worldData.lastTickDate
                : ""
        );

        // Season chip — same computation used to ground the Weather/World prompts,
        // surfaced here so it's not a purely invisible behind-the-scenes input.
        if (Store.TimelineEngine && Store.settings.seasonHemisphere && Store.settings.seasonHemisphere !== "none" && Store.storyData && Store.storyData.date) {
            var seasonNow = Store.TimelineEngine.formatSeasonForPrompt(Store.storyData.date, Store.settings.seasonHemisphere);
            if (seasonNow) {
                $("#st-world-chip-season-text").text(seasonNow.charAt(0).toUpperCase() + seasonNow.slice(1));
                $("#st-world-chip-season").show();
            } else {
                $("#st-world-chip-season").hide();
            }
        } else {
            $("#st-world-chip-season").hide();
        }

        let eventsHtml = "";
        if (Store.worldData.worldEvents && Store.worldData.worldEvents.length > 0) {
            Store.worldData.worldEvents.forEach(function(e, idx) {
                var pinned = !!e.pinned;
                eventsHtml += `<div class="st-world-event-item${pinned ? " st-world-event-pinned" : ""}">
                    <div class="st-world-event-meta">
                        <span>${e.time} ${e.date}</span>
                        <span>Importance: ${e.importance}/10</span>
                        <button class="st-pin-event-btn menu_button${pinned ? " st-pin-event-active" : ""}" data-index="${idx}" title="${pinned ? "Unpin — allow this to be trimmed over time" : "Pin — protect this event from automatic trimming"}"><i class="fa-solid fa-thumbtack"></i></button>
                    </div>
                    <div class="st-world-event-text">${esc(e.event)}</div>
                </div>`;
            });
        } else {
            eventsHtml = "<i>No events recorded.</i>";
        }
        $("#st-world-val-events").html(eventsHtml);
        setWorldCollapseCount("st-world-val-events", (Store.worldData.worldEvents || []).length);

        let npcsHtml = "";
        if (Store.worldData.npcStates && Store.worldData.npcStates.length > 0) {
            Store.worldData.npcStates.forEach(function(n) {
                var goalLine = n.goal
                    ? `<div class="st-world-npc-goal"><i class="fa-solid fa-compass"></i>${esc(n.goal)}<button class="st-npc-line-del st-del-npc-goal" data-name="${esc(n.name)}" title="Remove this goal — the tracker won't invent a new one for this NPC (remove the whole NPC entry to reset that)">&times;</button></div>`
                    : "";
                var routineLine = "";
                if (Store.WorldAgent && Array.isArray(n.routine) && n.routine.length > 0) {
                    var routineText = Store.WorldAgent.formatRoutineForPrompt(n.routine);
                    var nowEntry = (Store.storyData && Store.storyData.time)
                        ? Store.WorldAgent.getRoutineActivityAt(n.routine, Store.storyData.time)
                        : null;
                    // Routine as a 24h timeline strip (Direction B): a dot per routine
                    // entry positioned by hour, a gold marker at the current RP clock —
                    // one 12px line instead of a full text row, so many routine-carrying
                    // NPCs stay compact. The full text lives in the tooltip.
                    var routineDots = "";
                    n.routine.forEach(function(r) {
                        var pct = clockToPct(r.time);
                        if (pct != null) routineDots += `<span class="st-routine-dot" style="left:${pct.toFixed(1)}%" title="${esc(r.time + " " + r.activity)}"></span>`;
                    });
                    var nowPct = (Store.storyData && Store.storyData.time) ? clockToPct(Store.storyData.time) : null;
                    var nowMark = (nowPct != null) ? `<span class="st-routine-now" style="left:${nowPct.toFixed(1)}%"></span>` : "";
                    var routineOpen = !!routineExpandState[n.name];
                    routineLine = `<div class="st-world-npc-routine st-routine-toggle${routineOpen ? " st-routine-open" : ""}" data-name="${esc(n.name)}" title="${routineOpen ? "" : esc(routineText + (nowEntry ? " — now: " + nowEntry.activity : ""))}">` +
                        `<i class="fa-solid fa-clock"></i>` +
                        `<div class="st-routine-strip">${routineDots}${nowMark}</div>` +
                        (!routineOpen && nowEntry ? `<span class="st-routine-now-text">${esc(nowEntry.activity)}</span>` : "") +
                        `<i class="fa-solid fa-chevron-${routineOpen ? "up" : "down"} st-routine-caret"></i>` +
                        `<button class="st-npc-line-del st-del-npc-routine" data-name="${esc(n.name)}" title="Remove this routine — the tracker won't invent a new one for this NPC (remove the whole NPC entry to reset that)">&times;</button></div>`;
                    // Expanded: the full schedule as readable rows (nothing truncated,
                    // no hover needed), the currently-active entry tagged "now".
                    if (routineOpen) {
                        routineLine += '<div class="st-routine-detail">' + n.routine.map(function(r) {
                            var active = !!(nowEntry && r === nowEntry);
                            return `<div class="st-routine-detail-row${active ? " st-routine-detail-active" : ""}">` +
                                `<span class="st-routine-detail-time">${esc(r.time)}</span>` +
                                `<span class="st-routine-detail-act">${esc(r.activity)}</span>` +
                                (active ? '<span class="st-routine-detail-nowtag">now</span>' : "") +
                                `</div>`;
                        }).join("") + '</div>';
                    }
                }
                var currentAction = Store.EventQueue
                    ? Store.EventQueue.getPendingMatching(Store.worldData._eventQueue || [], function(ev) {
                        return ev.meta && ev.meta.origin === "npc" && ev.meta.npcName === n.name;
                    })[0]
                    : null;
                var currentLine = currentAction
                    ? `<div class="st-world-npc-current"><i class="fa-solid fa-hourglass-half"></i>${esc(currentAction.action)} <span class="st-world-npc-current-eta">(due ${esc(currentAction.executeTime)} ${esc(currentAction.executeDate)})</span></div>`
                    : "";
                npcsHtml += `<div class="st-world-npc-item">
                    <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:6px;">
                        <div style="min-width:0;"><span class="st-world-npc-name">${esc(n.name)}:</span> <span>${esc(n.change)}</span></div>
                        <button class="st-del-npc st-hdr-btn menu_button" data-name="${esc(n.name)}" title="Stop tracking this NPC (removes their state, goal, and routine)" style="padding: 2px 6px !important; font-size: 10px; color: #ff453a; border-color: rgba(255,255,255,0.1); background: transparent; min-width: unset !important; min-height: unset !important;"><i class="fa-solid fa-trash-can"></i></button>
                    </div>
                    ${goalLine}
                    ${routineLine}
                    ${currentLine}
                </div>`;
            });
        } else {
            npcsHtml = "<i>No NPC changes recorded.</i>";
        }
        $("#st-world-val-npcs").html(npcsHtml);
        setWorldCollapseCount("st-world-val-npcs", (Store.worldData.npcStates || []).length);

        let revealsHtml = "";
        if (Store.worldData.pendingReveals && Store.worldData.pendingReveals.length > 0) {
            Store.worldData.pendingReveals.forEach(function(r) {
                revealsHtml += `<div class="st-world-reveal-item">
                    <i class="fa-solid fa-circle-question st-world-reveal-icon"></i>
                    <span>${esc(r)}</span>
                </div>`;
            });
        } else {
            revealsHtml = "<i>No pending discoveries.</i>";
        }
        $("#st-world-val-reveals").html(revealsHtml);
        setWorldCollapseCount("st-world-val-reveals", (Store.worldData.pendingReveals || []).length);
    } else {
        $("#st-world-val-summary").text("Waiting for first World Tick to run...");
        $("#st-world-chip-weather-text").text("Waiting for first tick...");
        $("#st-world-chip-season").hide();
        $("#st-world-brief-asof").text("");
        $("#st-world-val-events").html("<i>Waiting for simulation...</i>");
        $("#st-world-val-npcs").html("<i>Waiting for simulation...</i>");
        $("#st-world-val-reveals").html("<i>Waiting for simulation...</i>");
        setWorldCollapseCount("st-world-val-events", 0);
        setWorldCollapseCount("st-world-val-npcs", 0);
        setWorldCollapseCount("st-world-val-reveals", 0);
    }

    // Scheduled Events is independent of the World Agent — a manually-added calendar
    // entry (or an agent-scheduled delayed action) should show up here whether or not
    // World Agent ticks have ever run, so this is NOT gated behind worldData._initialized.
    let pendingHtml = "";
    var pendingEvents = (Store.EventQueue && Store.worldData) ? Store.EventQueue.getPending(Store.worldData._eventQueue || []) : [];
    if (pendingEvents.length > 0) {
        pendingEvents
            .slice()
            .sort(function(a, b) {
                var da = Store.TimelineEngine.parseDateTime(a.executeTime, a.executeDate);
                var db = Store.TimelineEngine.parseDateTime(b.executeTime, b.executeDate);
                return (da ? da.getTime() : 0) - (db ? db.getTime() : 0);
            })
            .forEach(function(ev) {
                var originLabel = (ev.meta && ev.meta.origin === "manual") ? " &bull; manual" : "";
                var repeatLabel = "";
                if (ev.recurringMinutes > 0) {
                    repeatLabel = ev.recurringMinutes === 1440 ? " &bull; repeats daily"
                        : ev.recurringMinutes === 10080 ? " &bull; repeats weekly"
                        : " &bull; repeats every " + ev.recurringMinutes + " min";
                }
                // Countdown pill (Direction B): "in ~2h" leads, the absolute resolve
                // time becomes secondary metadata — same ETA language the HUD's signal
                // line already speaks.
                var pendingNow = Persistence.parseRpDateTime(Store.storyData.time, Store.storyData.date);
                var dueObj = Persistence.parseRpDateTime(ev.executeTime, ev.executeDate);
                var minsUntil = (pendingNow && dueObj) ? Math.round((dueObj.getTime() - pendingNow.getTime()) / 60000) : null;
                var etaPill = "";
                if (minsUntil != null) {
                    var etaStr = minsUntil <= 0 ? "imminent"
                        : minsUntil < 60 ? "in ~" + minsUntil + "min"
                        : minsUntil < 1440 ? "in ~" + (minsUntil / 60).toFixed(minsUntil % 60 === 0 ? 0 : 1) + "h"
                        : "in ~" + (minsUntil / 1440).toFixed(1) + "d";
                    etaPill = `<span class="st-eta-pill">${etaStr}</span>`;
                }
                pendingHtml += `<div class="st-world-event-item">
                    <div class="st-world-event-meta">
                        ${etaPill}<span>${ev.executeTime} ${ev.executeDate}${originLabel}${repeatLabel}</span>
                        <button class="st-cancel-pending-evt st-hdr-btn menu_button" data-id="${esc(ev.id)}" title="Cancel this scheduled event" style="padding: 2px 6px !important; font-size: 10px; color: #ff453a; border-color: rgba(255,255,255,0.1); background: transparent;"><i class="fa-solid fa-trash-can"></i></button>
                    </div>
                    <div class="st-world-event-text">${esc(ev.action)}</div>
                </div>`;
            });
    } else {
        pendingHtml = "<i>No scheduled events.</i>";
    }
    $("#st-world-val-pending").html(pendingHtml);

    // Location Codex — like Scheduled Events, this is maintained by the Scene tick,
    // not the World Agent tiers, so it renders whether or not a world tick has ever
    // run (deliberately NOT gated behind worldData._initialized).
    let codexHtml = "";
    var codexMap = (Store.worldData && Store.worldData.locationCodex) ? Store.worldData.locationCodex : {};
    var codexEntries = Object.keys(codexMap)
        .map(function(k) { return { key: k, entry: codexMap[k] }; })
        .filter(function(c) { return c.entry && c.entry.name; })
        .sort(function(a, b) { return (b.entry.epoch || 0) - (a.entry.epoch || 0); }); // most recently left first
    if (codexEntries.length > 0) {
        codexEntries.forEach(function(c) {
            var e = c.entry;
            var whoThen = (e.characters || []).map(function(ch) { return ch && ch.name ? ch.name : ""; }).filter(Boolean).join(", ");
            codexHtml += `<div class="st-world-event-item">
                <div class="st-world-event-meta">
                    <span><i class="fa-solid fa-map-pin" style="margin-right:4px;opacity:0.7;"></i>${esc(e.name)} &bull; last left ${esc(e.time)} ${esc(e.date)}${e.visits > 1 ? " &bull; " + e.visits + " visits" : ""}</span>
                    <button class="st-del-codex st-hdr-btn menu_button" data-key="${esc(c.key)}" title="Forget this location" style="padding: 2px 6px !important; font-size: 10px; color: #ff453a; border-color: rgba(255,255,255,0.1); background: transparent;"><i class="fa-solid fa-trash-can"></i></button>
                </div>
                <div class="st-world-event-text">${esc(e.recentEvents || "No details recorded.")}</div>
                ${whoThen ? `<div class="st-world-npc-goal"><i class="fa-solid fa-users"></i>Present then: ${esc(whoThen)}</div>` : ""}
            </div>`;
        });
    } else {
        codexHtml = "<i>No locations remembered yet — entries appear when the scene moves somewhere else.</i>";
    }
    $("#st-world-val-codex").html(codexHtml);
    setWorldCollapseCount("st-world-val-codex", codexEntries.length);

    // World Rules — like the codex, maintained outside the World Agent's tick
    // cycle (established at genesis, edited by hand), so it renders whether or
    // not a world tick has ever run. Each rule row reuses the NPC-goal line
    // pattern (same CSS, same inline × delete); the add-row at the bottom lets
    // the user append rules the digest missed.
    let rulesHtml = "";
    var rulesList = (Store.worldData && Array.isArray(Store.worldData.loreDigest)) ? Store.worldData.loreDigest : [];
    if (rulesList.length > 0) {
        rulesList.forEach(function(r, idx) {
            rulesHtml += `<div class="st-world-npc-goal"><i class="fa-solid fa-scale-balanced"></i>${esc(r)}<button class="st-npc-line-del st-del-rule" data-index="${idx}" title="Remove this world rule">&times;</button></div>`;
        });
    } else {
        rulesHtml = "<i>No world rules yet — distilled automatically when a new chat begins.</i>";
    }
    rulesHtml += '<div class="st-world-rule-addrow" style="display:flex;gap:5px;margin-top:8px;">' +
        '<input type="text" id="st-world-rule-input" class="text_pole" placeholder="Add a rule the world must respect…" style="flex:1;min-width:0;">' +
        '<button class="menu_button" id="st-world-rule-add" title="Add rule" style="flex:0 0 auto;"><i class="fa-solid fa-plus"></i></button></div>';
    // (Lorebook seeding for these rules is chosen in the "World Lorebooks" panel at
    // the top of this tab — see renderWorldLorebooksPanel.)
    $("#st-world-val-rules").html(rulesHtml);
    setWorldCollapseCount("st-world-val-rules", rulesList.length);

    // World Lorebooks panel (top of the World tab) — view summary or edit controls.
    $("#st-worldbooks-body").html(renderWorldLorebooksPanel());

    // Tab-state chips (Direction C): edge count on Relations, due-dot on World.
    var relEdgeCount = (Store.settings.relationsEnabled && Store.relationshipData && Store.relationshipData.edges)
        ? Store.relationshipData.edges.length : 0;
    $("#st-rel-tab-badge").text(relEdgeCount).toggle(relEdgeCount > 0);
    var worldTierDue = false;
    if (Store.settings.worldEnabled && Store.worldData && Store.worldData._schedulerAccumulated) {
        var accW = Store.worldData._schedulerAccumulated;
        worldTierDue = (accW.npc || 0) >= Store.settings.npcTierMinutes ||
                       (accW.weather || 0) >= Store.settings.weatherTierMinutes ||
                       (accW.faction || 0) >= Store.settings.factionTierMinutes ||
                       (accW.world || 0) >= Store.settings.worldTierMinutes;
    }
    $("#st-world-tab-due").toggle(worldTierDue);

    renderAutoInfo();
    // Refresh graph if relations tab is currently visible
    if ($("#st-tab-relations").is(":visible")) {
        renderRelationshipGraph();
    }
}

function updateSettingsUI() {
    let hasData = Store.isChatOpen() && Store.storyData;
    let autoUpdate = (hasData && Store.storyData.autoUpdate !== undefined) ? Store.storyData.autoUpdate : Store.settings.autoUpdate;

    $("#st-s-auto").prop("checked", autoUpdate);

    // Value sync only — the "input" handler is bound ONCE in buildSettingsPanel.
    // Binding it here used to stack a duplicate handler on every updateSettingsUI
    // call (chat switches, force-renders, opening the modal...).
    $("#st-s-startup-delay").val(Store.settings.startupDelay || 2000);
    $("#st-s-delay-val").text(Store.settings.startupDelay || 2000);

    $("#st-s-hud-tint").prop("checked", Store.settings.hudTimeTint !== false);

    $("#st-s-smart-time").prop("checked", Store.settings.timeMode === "smart");
    $("#st-message-mode-row").toggle(Store.settings.timeMode !== "smart");
    $("#st-smart-time-sub-row").toggle(Store.settings.timeMode === "smart");
    $("#st-s-msg-interval").val(Store.settings.messageModeInterval || 5);
    $("#st-s-msg-interval-val").text(Store.settings.messageModeInterval || 5);
    renderCustomSkipChips();

    $("#st-s-interval").val(Store.settings.sceneTierMinutes);
    $("#st-interval-val").text(Store.settings.sceneTierMinutes);

    $("#st-s-world-on").prop("checked", Store.settings.worldEnabled);
    $("#st-s-world-useprofile").prop("checked", Store.settings.useWorldProfile);
    $("#st-world-profile-row").toggle(Store.settings.useWorldProfile);
    $("#st-s-npc-tier-minutes").val(Store.settings.npcTierMinutes);
    $("#st-s-weather-tier-minutes").val(Store.settings.weatherTierMinutes);
    $("#st-s-faction-tier-minutes").val(Store.settings.factionTierMinutes);
    $("#st-s-world-tier-minutes").val(Store.settings.worldTierMinutes);
    $("#st-s-max-ticks").val(Store.settings.maxWorldTicks);
    $("#st-max-ticks-val").text(Store.settings.maxWorldTicks);
    $("#st-s-world-parallel").prop("checked", Store.settings.parallelWorldTiers);
    $("#st-s-season-hemisphere").val(Store.settings.seasonHemisphere || "northern");

    // Sync Relationship Tracker settings
    $("#st-s-rel-on").prop("checked", Store.settings.relationsEnabled);
    $("#st-s-rel-auto").prop("checked", Store.settings.relationsAutoUpdate);
    $("#st-rel-interval-row").toggle(Store.settings.relationsAutoUpdate);
    $("#st-s-rel-interval").val(Store.settings.relAutoInterval || 5);
    $("#st-rel-interval-val").text(Store.settings.relAutoInterval || 5);
    $("#st-s-rel-useprofile").prop("checked", Store.settings.useRelProfile);
    $("#st-rel-profile-row").toggle(Store.settings.useRelProfile);

    // Sync RGB Highlights
    $("#st-s-rgb-r").val(Store.settings.accentR || 216);
    $("#st-rgb-r-val").text(Store.settings.accentR || 216);
    $("#st-s-rgb-g").val(Store.settings.accentG || 160);
    $("#st-rgb-g-val").text(Store.settings.accentG || 160);
    $("#st-s-rgb-b").val(Store.settings.accentB || 64);
    $("#st-rgb-b-val").text(Store.settings.accentB || 64);
    applyCustomAccentColor();

    renderAutoInfo();
}

/** Footer countdown progress strip (Direction C): fills toward the next
 * automatic check. Pass null to hide (off/manual/world's multi-cadence view). */
function setAutoBar(frac) {
    var $bar = $("#st-auto-bar");
    if (!$bar.length) return;
    if (frac == null) { $bar.hide(); return; }
    $bar.show();
    $("#st-auto-bar-fill").css("width", Math.round(Math.max(0, Math.min(1, frac)) * 100) + "%");
}

function renderAutoInfo() {
    var hasData = Store.isChatOpen() && Store.storyData;
    if (!hasData) { $("#st-auto-info").text("No active chat"); setAutoBar(null); return; }

    // Show the countdown relevant to whichever tab is currently active, since each
    // agent (scene/world/relations) has its own independent interval and settings.
    var activeTarget = $(".st-tab.st-tab-active").data("target") || "st-tab-current";

    if (activeTarget === "st-tab-world") {
        renderWorldAutoInfo();
        return;
    }
    if (activeTarget === "st-tab-relations") {
        renderRelAutoInfo();
        return;
    }

    // Default: Scene tracker countdown (Current / History tabs).
    var autoUpdate = (Store.storyData.autoUpdate !== undefined) ? Store.storyData.autoUpdate : Store.settings.autoUpdate;
    if (!autoUpdate) { $("#st-auto-info").text("Auto-update: OFF"); setAutoBar(null); return; }

    if (Store.settings.timeMode === "message") {
        // Message Mode: cadence is purely message-count driven (see _timeModeMsgCounter
        // in the message handler) — sceneTierMinutes/RP-time never factors in here, so
        // showing an RP-time countdown would be actively misleading in this mode.
        var msgInterval = Store.settings.messageModeInterval || 5;
        var timeModeMsgCounter = Store.storyData._timeModeMsgCounter || 0;
        var msgRem = Math.max(0, msgInterval - timeModeMsgCounter);
        $("#st-auto-info").text(`Scene update in ${msgRem} message(s)`);
        setAutoBar(timeModeMsgCounter / msgInterval);
        return;
    }

    // Smart Time mode: Scene is a time-based Scheduler tier, not a message-count interval —
    // this is also just the fallback cadence (skip-language detection can fire it sooner).
    var sceneAccum = (Store.worldData && Store.worldData._schedulerAccumulated) ? (Store.worldData._schedulerAccumulated.scene || 0) : 0;
    var sceneRemMin = Math.max(0, Store.settings.sceneTierMinutes - sceneAccum);
    $("#st-auto-info").text(`Scene update in ~${sceneRemMin.toFixed(1)}min (RP time, or sooner if a skip is detected)`);
    setAutoBar(Store.settings.sceneTierMinutes > 0 ? sceneAccum / Store.settings.sceneTierMinutes : null);
}

function renderWorldAutoInfo() {
    // Four independent cadences don't honestly reduce to one progress bar — the
    // world tab keeps the text-only readout (the tab's due-dot covers "something
    // is ready" at a glance instead).
    setAutoBar(null);
    if (!Store.settings.enabled || !Store.settings.worldEnabled) { $("#st-auto-info").text("World Agent: OFF"); return; }
    if (!Store.worldData || !Store.worldData._schedulerAccumulated) { $("#st-auto-info").text("World Agent: waiting for first tick"); return; }

    var accum = Store.worldData._schedulerAccumulated;
    var parts = [
        "npc in ~" + Math.max(0, Store.settings.npcTierMinutes - (accum.npc || 0)).toFixed(0) + "min",
        "weather in ~" + Math.max(0, Store.settings.weatherTierMinutes - (accum.weather || 0)).toFixed(0) + "min",
        "faction in ~" + Math.max(0, Store.settings.factionTierMinutes - (accum.faction || 0)).toFixed(0) + "min",
        "world in ~" + Math.max(0, Store.settings.worldTierMinutes - (accum.world || 0)).toFixed(0) + "min",
    ];
    $("#st-auto-info").text(parts.join(" | "));
}

function renderRelAutoInfo() {
    if (!Store.settings.enabled || !Store.settings.relationsEnabled) { $("#st-auto-info").text("Relationship Tracker: OFF"); setAutoBar(null); return; }
    if (!Store.settings.relationsAutoUpdate) { $("#st-auto-info").text("Relationship Tracker: Manual only"); setAutoBar(null); return; }

    var relInterval = Store.settings.relAutoInterval || 5;
    // Mirrors the actual trigger check in handleMsg (relMsgCounter >= interval → due).
    // The counter only resets when an analysis actually completes, so a skipped or
    // failed tick correctly keeps reading "due now" here instead of silently
    // showing (and waiting out) a fresh full interval.
    var isDue = Store.relMsgCounter >= relInterval;
    var rem = Math.max(0, relInterval - Store.relMsgCounter);
    $("#st-auto-info").text(isDue ? "Relations update due now" : `Relations update in ${rem} msg(s)`);
    setAutoBar(Store.relMsgCounter / relInterval);
}
function renderRelationshipGraph() {
    var $container = $("#st-rel-graph-container");
    if (!$container.length) return;

    try {
        if (!Store.isChatOpen() || !Store.relationshipData || !Store.relationshipData._initialized ||
            !Store.relationshipData.edges || Store.relationshipData.edges.length === 0) {
            Store.setRelEditingNode(null);
            $container.html(
                '<div class="st-no-data" style="padding:30px 0;">' +
                '<i class="fa-solid fa-share-nodes"></i>' +
                '<div>No relationship data yet.</div>' +
                '<div style="font-size:11px;margin-top:6px;opacity:0.6;">Click Analyze to begin tracking.</div>' +
                '</div>'
            );
            return;
        }

        var edges = Store.relationshipData.edges || [];
        var nodes = Store.relationshipData.nodes || [];
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
        var typeKeys = (Store.RelationshipAgent && Store.RelationshipAgent.VALID_TYPES) || Object.keys(typeColors);

        var nodeMap = {};
        nodes.forEach(function(n) { if (n && n.name) nodeMap[n.name] = n; else if (n && n.id) nodeMap[n.id] = n; });
        edges.forEach(function(e) {
            if (!e) return;
            if (e.from && !nodeMap[e.from]) { var n1 = { id: e.from, name: e.from }; nodes.push(n1); nodeMap[e.from] = n1; }
            if (e.to && !nodeMap[e.to]) { var n2 = { id: e.to, name: e.to }; nodes.push(n2); nodeMap[e.to] = n2; }
        });

        var width = $container.width();
        if (!width || width < 100) width = 400; // Safeguard if tab is hidden during render
        var height = 300;
        var cx = width / 2;
        var cy = height / 2;

        var simNodes = nodes.map(function(n, idx) {
            var hasSavedPos = typeof n.x === "number" && typeof n.y === "number";
            return {
                idx: idx,
                id: n.id || n.name,
                name: n.name || n.id || "?",
                x: hasSavedPos ? n.x : cx + (Math.random() - 0.5) * 80,
                y: hasSavedPos ? n.y : cy + (Math.random() - 0.5) * 80,
                vx: 0, vy: 0,
                fixed: hasSavedPos
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

        // Only simulate if there's at least one un-anchored (new) node — once
        // everything has a saved position, skip the sim entirely (instant re-render,
        // and nothing drifts out from under the user between renders).
        var needsSim = simNodes.some(function(sn) { return !sn.fixed; });
        if (needsSim) {
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
                        if (!simNodes[a].fixed) { simNodes[a].vx += fx; simNodes[a].vy += fy; }
                        if (!simNodes[b].fixed) { simNodes[b].vx -= fx; simNodes[b].vy -= fy; }
                    }
                    if (!simNodes[a].fixed) {
                        simNodes[a].vx += (cx - simNodes[a].x) * 0.02;
                        simNodes[a].vy += (cy - simNodes[a].y) * 0.02;
                    }
                }

                for (var j = 0; j < simEdges.length; j++) {
                    var edgeObj = simEdges[j];
                    var sdx = edgeObj.target.x - edgeObj.source.x;
                    var sdy = edgeObj.target.y - edgeObj.source.y;
                    var sdist = Math.sqrt(sdx * sdx + sdy * sdy) || 1;
                    var sforce = (sdist - 100) * 0.04;
                    var sfx = (sdx / sdist) * sforce;
                    var sfy = (sdy / sdist) * sforce;
                    if (!edgeObj.source.fixed) { edgeObj.source.vx += sfx; edgeObj.source.vy += sfy; }
                    if (!edgeObj.target.fixed) { edgeObj.target.vx -= sfx; edgeObj.target.vy -= sfy; }
                }

                for (var n = 0; n < simNodes.length; n++) {
                    var sn = simNodes[n];
                    if (sn.fixed) continue;
                    sn.vx = Math.max(-20, Math.min(20, sn.vx));
                    sn.vy = Math.max(-20, Math.min(20, sn.vy));
                    sn.x += sn.vx;
                    sn.y += sn.vy;
                    sn.vx *= 0.6;
                    sn.vy *= 0.6;
                    sn.x = Math.max(20, Math.min(width - 20, sn.x));
                    sn.y = Math.max(20, Math.min(height - 20, sn.y));
                }
            }

            // Freeze newly-simulated nodes into the persisted data so they're
            // anchored too on the next render (and survive a reload).
            var gainedPositions = false;
            simNodes.forEach(function(sn) {
                if (sn.fixed) return;
                var nodeObj = nodeMap[sn.name] || nodeMap[sn.id];
                if (nodeObj) { nodeObj.x = sn.x; nodeObj.y = sn.y; gainedPositions = true; }
            });
            if (gainedPositions) Persistence.saveRelationshipData();
        }

        var view = (Store.relationshipData._view && typeof Store.relationshipData._view.scale === "number")
            ? Store.relationshipData._view
            : { tx: 0, ty: 0, scale: 1 };

        var html = '';

        html += '<div class="st-rel-legend">';
        typeKeys.forEach(function(type) {
            html += '<div class="st-rel-legend-item"><span class="st-rel-legend-dot" style="background:'+(typeColors[type]||'#888')+'"></span>' + esc(type) + '</div>';
        });
        html += '</div>';

        html += '<div class="st-rel-zoom-controls">';
        html += '  <button type="button" class="st-rel-zoom-btn" id="st-rel-zoom-out" title="Zoom out"><i class="fa-solid fa-minus"></i></button>';
        html += '  <button type="button" class="st-rel-zoom-btn" id="st-rel-zoom-reset" title="Reset view"><i class="fa-solid fa-compress"></i></button>';
        html += '  <button type="button" class="st-rel-zoom-btn" id="st-rel-zoom-in" title="Zoom in"><i class="fa-solid fa-plus"></i></button>';
        html += '</div>';

        html += '<svg width="100%" height="'+height+'" viewBox="0 0 '+width+' '+height+'" class="st-rel-svg" style="user-select:none; touch-action:none;">';

        html += '<g id="st-rel-viewport" transform="translate('+view.tx+','+view.ty+') scale('+view.scale+')">';

        html += '<g id="st-rel-edges">';
        simEdges.forEach(function(eObj, idx) {
            var eData = eObj.data || {};
            var color = typeColors[eData.type] || "#888";
            var thickness = 1.5 + (Math.abs(eData.strength || 0) * 3.5);
            html += '<line class="st-rel-edge" data-idx="' + idx + '" ' +
                    'x1="'+eObj.source.x+'" y1="'+eObj.source.y+'" ' +
                    'x2="'+eObj.target.x+'" y2="'+eObj.target.y+'" ' +
                    'stroke="'+color+'" stroke-width="'+thickness+'" stroke-linecap="round" /> ';
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

            html += '<g class="st-rel-node" data-nidx="'+sn.idx+'" data-name="'+esc(sn.name)+'" transform="translate('+sn.x+','+sn.y+')">';
            html += '<circle class="st-rel-node-circle" r="16" fill="#242421" stroke="var(--st-custom-accent)" stroke-width="2" />';
            html += '<text y="4" text-anchor="middle" fill="#fff" font-size="11px" font-weight="bold" font-family="sans-serif" style="pointer-events:none;">'+esc(initials)+'</text>';
            html += '<text y="28" text-anchor="middle" fill="var(--st-journal-text)" font-size="11px" font-family="sans-serif" font-weight="600" style="pointer-events:none;">'+esc(sn.name)+'</text>';
            html += '</g>';
        });
        html += '</g></g></svg>';

        // Relations board (Direction C): the graph stays pinned above as the map;
        // every relationship lives below as a compact card in its own SCROLLING
        // list, so a large cast never stretches the tab. Selecting a character in
        // the graph filters the list; each card's strength slider edits in place.
        html += '<div class="st-rel-board">' +
                '<div class="st-rel-board-head" id="st-rel-board-head"></div>' +
                '<div class="st-rel-board-list" id="st-rel-board-list"></div>' +
                '</div>';

        $container.html(html);

        var svgEl = $container.find(".st-rel-svg")[0];
        var viewportEl = $container.find("#st-rel-viewport")[0];
        var currentView = { tx: view.tx, ty: view.ty, scale: view.scale };

        function relClampScale(s) { return Math.max(0.35, Math.min(2.5, s)); }

        function applyViewTransform() {
            viewportEl.setAttribute('transform', 'translate('+currentView.tx+','+currentView.ty+') scale('+currentView.scale+')');
        }

        function persistView() {
            if (!Store.relationshipData) return;
            Store.relationshipData._view = { tx: currentView.tx, ty: currentView.ty, scale: currentView.scale };
            Persistence.saveRelationshipData();
        }

        function zoomAt(mx, my, factor) {
            var newScale = relClampScale(currentView.scale * factor);
            var worldX = (mx - currentView.tx) / currentView.scale;
            var worldY = (my - currentView.ty) / currentView.scale;
            currentView.tx = mx - worldX * newScale;
            currentView.ty = my - worldY * newScale;
            currentView.scale = newScale;
            applyViewTransform();
            persistView();
        }

        // --- Selection / highlight (tap a node or edge) ---
        function clearSelection() {
            Store.setRelSelectedNode(null);
            $container.find('.st-rel-node, .st-rel-edge').removeClass('st-rel-dim st-rel-selected');
            relCardEditKey = null; relBioEditOpen = false; relAddOpen = false;
            renderRelBoard(null);
        }

        // Same band thresholds the context injection explains to the model —
        // players and model share one vocabulary for what a strength value MEANS.
        function bandForStrength(s) {
            if (s <= -0.6) return "hostile";
            if (s <= -0.2) return "cold";
            if (s < 0.2) return "neutral";
            if (s < 0.6) return "warm";
            return "bonded";
        }

        /**
         * The scrollable relationship board under the graph (Direction C). The
         * graph stays pinned above as the map; every relationship lives down here
         * as a compact card in a list with its own scrollbar, so a large cast
         * never stretches the tab. filterName limits the list to one character's
         * bonds (set by tapping their node); null shows everything, strongest
         * feelings first. Each card's slider EDITS strength in place: labels
         * update live while dragging, the value persists on release, and the
         * graph line's thickness refreshes directly — deliberately no full
         * re-render mid-interaction, which would rebuild this list and lose the
         * scroll position.
         */
        function renderRelBoard(filterName) {
            var $head = $container.find("#st-rel-board-head");
            var $list = $container.find("#st-rel-board-list");
            if (!$head.length) return;
            var allEdges = Store.relationshipData.edges || [];
            var shown = filterName
                ? allEdges.filter(function(e) { return e && (e.from === filterName || e.to === filterName); })
                : allEdges.slice();
            shown.sort(function(a, b) { return Math.abs(b.strength || 0) - Math.abs(a.strength || 0); });

            // --- header: when filtered, this doubles as the character's toolbar
            // (add bond / remove character / back to all) ---
            if (filterName) {
                $head.html(
                    '<span class="st-rel-board-filter"><i class="fa-solid fa-user"></i>' + esc(filterName) + ' · ' + shown.length + ' bond' + (shown.length === 1 ? '' : 's') + '</span>' +
                    '<button type="button" class="st-rel-hbtn st-rel-add-bond' + (relAddOpen ? ' st-rel-hbtn-on' : '') + '" title="Add a relationship for ' + esc(filterName) + '"><i class="fa-solid fa-plus"></i></button>' +
                    '<button type="button" class="st-rel-hbtn st-rel-del-node" title="Remove ' + esc(filterName) + ' and all their relationships"><i class="fa-solid fa-trash-can"></i></button>' +
                    '<button type="button" class="st-rel-board-clear" title="Show all relationships">&times;</button>'
                );
                $head.find(".st-rel-board-clear").on("click", function(e) { e.stopPropagation(); clearSelection(); });
                $head.find(".st-rel-add-bond").on("click", function(e) {
                    e.stopPropagation();
                    relAddOpen = !relAddOpen;
                    renderRelBoard(filterName);
                });
                $head.find(".st-rel-del-node").on("click", function(e) {
                    e.stopPropagation();
                    if (!confirm('Remove "' + filterName + '" and all their relationships? This cannot be undone.')) return;
                    var result = Store.RelationshipAgent.removeNodeAndEdges(Store.relationshipData.nodes, Store.relationshipData.edges, filterName);
                    Store.relationshipData.nodes = result.nodes;
                    Store.relationshipData.edges = result.edges;
                    Store.setRelSelectedNode(null);
                    relCardEditKey = null; relBioEditOpen = false; relAddOpen = false;
                    Persistence.saveRelationshipData();
                    renderRelationshipGraph();
                    HUD.renderHUD();
                });
            } else {
                var boardHint = modalEditMode
                    ? 'tap a character to filter · slider = strength · ✎ = edit'
                    : 'tap a character to filter · ✎ in the header to edit';
                $head.html('<span class="st-rel-board-filter">All bonds · ' + shown.length + '</span>' +
                    '<span class="st-rel-board-hint">' + boardHint + '</span>');
            }

            // --- card builders ---
            function editKeyOf(e) { return e.from + "␟" + e.to; }
            function meterRowHtml(e) {
                var s = (typeof e.strength === "number") ? e.strength : 0;
                return '<div class="st-rel-card-meter" data-from="' + esc(e.from) + '" data-to="' + esc(e.to) + '">' +
                    '<input type="range" class="st-rel-card-strength" min="-1" max="1" step="0.05" value="' + s + '" title="Drag to edit strength">' +
                    '<span class="st-rel-card-band">' + bandForStrength(s) + '</span>' +
                    '<span class="st-rel-card-val">' + (s >= 0 ? '+' : '') + s.toFixed(2) + '</span>' +
                    buildRelStrengthSparkline(e) +
                    '</div>';
            }
            function editBtnHtml(e) {
                var on = relCardEditKey === editKeyOf(e);
                return '<button type="button" class="st-rel-editbtn' + (on ? ' st-rel-editbtn-on' : '') + '" data-from="' + esc(e.from) + '" data-to="' + esc(e.to) + '" title="Edit type / summary · delete bond">✎</button>';
            }
            // Inline editor for one bond: type + summary + history + actions.
            // Strength is deliberately NOT here — the card's slider already edits
            // it live, so the editor only covers what the slider can't.
            function editBlockHtml(e) {
                var typeOpts = typeKeys.map(function(t) {
                    return '<option value="' + esc(t) + '"' + (t === e.type ? ' selected' : '') + '>' + esc(t) + '</option>';
                }).join('');
                var hist = e.history || [];
                var histHtml = hist.length > 0
                    ? '<div class="st-rel-edit-histlabel">History (' + hist.length + ')</div><div class="st-rel-edit-hist">' + hist.map(function(h) {
                        var when = h.date ? ((h.time || "") + " " + h.date).trim() : ("msg #" + (h.msg || 0));
                        var hsign = (h.strength >= 0) ? "+" : "";
                        return '<div class="st-rel-edit-histrow"><span class="st-rel-edit-histwhen">' + esc(when) + '</span><span class="st-rel-edit-histsum">' + esc(h.summary || "") + '</span><span class="st-rel-edit-histval">' + hsign + (h.strength || 0).toFixed(2) + '</span></div>';
                    }).join('') + '</div>'
                    : '';
                return '<div class="st-rel-edit-block" data-from="' + esc(e.from) + '" data-to="' + esc(e.to) + '">' +
                    '<div class="st-rel-edit-row"><label>Type</label><select class="st-rel-edit-type">' + typeOpts + '</select></div>' +
                    '<div class="st-rel-edit-row"><label>Summary</label><textarea class="st-rel-edit-summary" rows="2">' + esc(e.summary || "") + '</textarea></div>' +
                    histHtml +
                    '<div class="st-rel-edit-actions">' +
                    '<button type="button" class="st-rel-mini-btn st-rel-mini-save">Save</button>' +
                    '<button type="button" class="st-rel-mini-btn st-rel-mini-cancel">Cancel</button>' +
                    '<button type="button" class="st-rel-mini-btn st-rel-mini-delete">Delete bond</button>' +
                    '</div></div>';
            }
            function dualSideHtml(e) {
                var sideColor = typeColors[e.type] || "#888";
                var editing = relCardEditKey === editKeyOf(e);
                return '<div class="st-rel-card-side">' +
                    '<div class="st-rel-card-sidehead">' +
                    '<span class="st-rel-card-dir" title="' + esc(e.from) + '’s feelings toward ' + esc(e.to) + '">' + esc(e.from) + ' →</span>' +
                    '<span class="st-rel-card-type" style="color:' + sideColor + ';">●&nbsp;' + esc(e.type || 'neutral') + '</span>' +
                    editBtnHtml(e) +
                    '</div>' +
                    meterRowHtml(e) +
                    (editing ? editBlockHtml(e) : (e.summary ? '<div class="st-rel-card-summary">' + esc(e.summary) + '</div>' : '')) +
                    '</div>';
            }

            var lHtml = "";

            // --- filtered-only extras above the cards: bio + add-bond form ---
            if (filterName) {
                var nodeData = nodeMap[filterName];
                if (relBioEditOpen) {
                    lHtml += '<div class="st-rel-bio-row">' +
                        '<textarea class="st-rel-bio-input" rows="2" placeholder="One sentence establishing who ' + esc(filterName) + ' is…">' + esc((nodeData && nodeData.bio) || "") + '</textarea>' +
                        '<div class="st-rel-edit-actions">' +
                        '<button type="button" class="st-rel-mini-btn st-rel-mini-biosave">Save bio</button>' +
                        '<button type="button" class="st-rel-mini-btn st-rel-mini-biocancel">Cancel</button>' +
                        '</div></div>';
                } else {
                    lHtml += '<div class="st-rel-bio-row st-rel-bio-line">' +
                        '<span class="st-rel-board-bio">' + esc((nodeData && nodeData.bio) || "No bio yet.") + '</span>' +
                        '<button type="button" class="st-rel-editbtn st-rel-bio-editbtn" title="Edit bio">✎</button></div>';
                }
                if (relAddOpen) {
                    var otherNames = (Store.relationshipData.nodes || [])
                        .map(function(nn) { return nn && nn.name; })
                        .filter(function(nn) { return nn && nn !== filterName; });
                    lHtml += '<div class="st-rel-card st-rel-add-card">' +
                        '<div class="st-rel-card-top"><span class="st-rel-card-pair">New bond · ' + esc(filterName) + ' ↔ …</span></div>' +
                        '<input type="text" class="st-rel-add-name" list="st-rel-add-names" placeholder="Character name">' +
                        '<datalist id="st-rel-add-names">' + otherNames.map(function(nn) { return '<option value="' + esc(nn) + '">'; }).join('') + '</datalist>' +
                        '<div class="st-rel-card-meter">' +
                        '<select class="st-rel-add-type">' + typeKeys.map(function(t) { return '<option value="' + esc(t) + '"' + (t === "neutral" ? " selected" : "") + '>' + esc(t) + '</option>'; }).join('') + '</select>' +
                        '<input type="range" class="st-rel-add-strength" min="-1" max="1" step="0.05" value="0">' +
                        '<span class="st-rel-card-val st-rel-add-val">+0.00</span></div>' +
                        '<div class="st-rel-edit-actions">' +
                        '<button type="button" class="st-rel-mini-btn st-rel-mini-addsave">Add</button>' +
                        '<button type="button" class="st-rel-mini-btn st-rel-mini-addcancel">Cancel</button>' +
                        '</div></div>';
                }
            }

            // An asymmetric pair (A→B AND B→A both stored) merges into ONE card
            // with a row per side; a single stored edge is a mutual relationship
            // (rule 4b: one entry per pair) and stays one card.
            var pairDone = {};
            shown.forEach(function(e) {
                var pairKey = e.from < e.to ? (e.from + "␟" + e.to) : (e.to + "␟" + e.from);
                if (pairDone[pairKey]) return;
                var reverse = null;
                for (var ri = 0; ri < allEdges.length; ri++) {
                    var cand = allEdges[ri];
                    if (cand && cand.from === e.to && cand.to === e.from) { reverse = cand; break; }
                }
                if (reverse) {
                    pairDone[pairKey] = true;
                    var first = Math.abs(e.strength || 0) >= Math.abs(reverse.strength || 0) ? e : reverse;
                    var second = (first === e) ? reverse : e;
                    lHtml += '<div class="st-rel-card st-rel-card-dual">' +
                        '<div class="st-rel-card-top">' +
                        '<span class="st-rel-card-pair">' + esc(first.from) + ' ⇄ ' + esc(first.to) + '</span>' +
                        '<span class="st-rel-card-oneside" title="Each side feels differently — edit them separately below">two sides</span>' +
                        '</div>' +
                        dualSideHtml(first) + dualSideHtml(second) +
                        '</div>';
                } else {
                    var color = typeColors[e.type] || "#888";
                    var editing = relCardEditKey === editKeyOf(e);
                    lHtml += '<div class="st-rel-card">' +
                        '<div class="st-rel-card-top">' +
                        '<span class="st-rel-card-pair">' + esc(e.from) + ' ↔ ' + esc(e.to) + '</span>' +
                        '<span class="st-rel-card-type" style="color:' + color + ';">●&nbsp;' + esc(e.type || 'neutral') + '</span>' +
                        editBtnHtml(e) +
                        '</div>' +
                        meterRowHtml(e) +
                        (editing ? editBlockHtml(e) : (e.summary ? '<div class="st-rel-card-summary">' + esc(e.summary) + '</div>' : '')) +
                        '</div>';
                }
            });
            if (!lHtml) lHtml = '<div class="st-rel-board-empty">No relationships ' + (filterName ? 'for ' + esc(filterName) + ' yet.' : 'yet.') + '</div>';
            $list.html(lHtml);

            // --- handlers (direct-bound per render; children replaced wholesale) ---
            $list.find(".st-rel-card-strength").on("input", function() {
                var $meter = $(this).closest(".st-rel-card-meter");
                var v = parseFloat(this.value);
                $meter.find(".st-rel-card-val").text((v >= 0 ? "+" : "") + v.toFixed(2));
                $meter.find(".st-rel-card-band").text(bandForStrength(v));
            });
            $list.find(".st-rel-card-strength").on("change", function() {
                var $meter = $(this).closest(".st-rel-card-meter");
                var from = $meter.attr("data-from"), to = $meter.attr("data-to");
                var v = parseFloat(this.value);
                Store.relationshipData.edges = Store.RelationshipAgent.updateEdgeFields(Store.relationshipData.edges, from, to, { strength: v });
                Persistence.saveRelationshipData();
                var idx = -1;
                simEdges.forEach(function(eo, i) { if (eo && eo.data && eo.data.from === from && eo.data.to === to) idx = i; });
                if (idx !== -1) $container.find('.st-rel-edge[data-idx="' + idx + '"]').attr("stroke-width", 1.5 + Math.abs(v) * 3.5);
                HUD.renderHUD();
            });
            // Card ✎ — toggles that bond's inline editor.
            $list.find(".st-rel-editbtn").not(".st-rel-bio-editbtn").on("click", function(ev) {
                ev.stopPropagation();
                var key = $(this).attr("data-from") + "␟" + $(this).attr("data-to");
                relCardEditKey = (relCardEditKey === key) ? null : key;
                renderRelBoard(filterName);
            });
            $list.find(".st-rel-mini-save").on("click", function(ev) {
                ev.stopPropagation();
                var $block = $(this).closest(".st-rel-edit-block");
                var from = $block.attr("data-from"), to = $block.attr("data-to");
                Store.relationshipData.edges = Store.RelationshipAgent.updateEdgeFields(Store.relationshipData.edges, from, to, {
                    type: $block.find(".st-rel-edit-type").val(),
                    summary: String($block.find(".st-rel-edit-summary").val() || ""),
                });
                Persistence.saveRelationshipData();
                relCardEditKey = null;
                // Full re-render: a type change recolors the graph line.
                renderRelationshipGraph();
                HUD.renderHUD();
                if (typeof toastr !== "undefined") toastr.success("Bond updated.");
            });
            $list.find(".st-rel-mini-cancel").on("click", function(ev) {
                ev.stopPropagation();
                relCardEditKey = null;
                renderRelBoard(filterName);
            });
            $list.find(".st-rel-mini-delete").on("click", function(ev) {
                ev.stopPropagation();
                var $block = $(this).closest(".st-rel-edit-block");
                var from = $block.attr("data-from"), to = $block.attr("data-to");
                if (!confirm("Delete this bond (" + from + " → " + to + ")?")) return;
                Store.relationshipData.edges = Store.RelationshipAgent.removeEdge(Store.relationshipData.edges, from, to);
                Persistence.saveRelationshipData();
                relCardEditKey = null;
                renderRelationshipGraph();
                HUD.renderHUD();
            });
            // Bio editing (filtered header area).
            $list.find(".st-rel-bio-editbtn").on("click", function(ev) {
                ev.stopPropagation();
                relBioEditOpen = true;
                renderRelBoard(filterName);
            });
            $list.find(".st-rel-mini-biosave").on("click", function(ev) {
                ev.stopPropagation();
                var bio = String($list.find(".st-rel-bio-input").val() || "").trim();
                var node = (Store.relationshipData.nodes || []).find(function(nn) { return nn && nn.name === filterName; });
                if (!node) { node = { id: filterName, name: filterName }; Store.relationshipData.nodes.push(node); }
                node.bio = bio; // manual edit always overrides, unlike the agent's first-write-wins
                Persistence.saveRelationshipData();
                relBioEditOpen = false;
                renderRelBoard(filterName);
                if (typeof toastr !== "undefined") toastr.success("Bio saved.");
            });
            $list.find(".st-rel-mini-biocancel").on("click", function(ev) {
                ev.stopPropagation();
                relBioEditOpen = false;
                renderRelBoard(filterName);
            });
            // Add-bond form.
            $list.find(".st-rel-add-strength").on("input", function() {
                var v = parseFloat(this.value);
                $list.find(".st-rel-add-val").text((v >= 0 ? "+" : "") + v.toFixed(2));
            });
            $list.find(".st-rel-mini-addsave").on("click", function(ev) {
                ev.stopPropagation();
                var otherName = String($list.find(".st-rel-add-name").val() || "").trim();
                if (!otherName) { if (typeof toastr !== "undefined") toastr.warning("Enter a character name first."); return; }
                // Same canonical-name resolution the tracker uses, so "aria" reuses
                // an existing "Aria Stormwind" instead of forking a duplicate.
                otherName = Persistence.resolveCanonicalName(otherName);
                if (otherName === filterName) { if (typeof toastr !== "undefined") toastr.warning("Can't add a relationship to yourself."); return; }
                var before = Store.relationshipData.edges.length;
                Store.relationshipData.edges = Store.RelationshipAgent.addManualEdge(Store.relationshipData.edges, {
                    from: filterName, to: otherName,
                    type: $list.find(".st-rel-add-type").val(),
                    strength: parseFloat($list.find(".st-rel-add-strength").val()),
                });
                if (Store.relationshipData.edges.length === before) {
                    if (typeof toastr !== "undefined") toastr.warning("That bond already exists — edit it on its card instead.");
                    return;
                }
                [filterName, otherName].forEach(function(nm) {
                    if (!Store.relationshipData.nodes.find(function(nn) { return nn.name === nm; })) {
                        Store.relationshipData.nodes.push({ id: nm, name: nm });
                    }
                });
                Persistence.saveRelationshipData();
                relAddOpen = false;
                renderRelationshipGraph();
                HUD.renderHUD();
                if (typeof toastr !== "undefined") toastr.success("Bond added.");
            });
            $list.find(".st-rel-mini-addcancel").on("click", function(ev) {
                ev.stopPropagation();
                relAddOpen = false;
                renderRelBoard(filterName);
            });
            // Tapping a card highlights its pair in the graph — but never when the
            // tap landed on any control (sliders, selects, buttons, text fields).
            $list.find(".st-rel-card").on("click", function(e) {
                if ($(e.target).closest("input, select, textarea, button, datalist").length) return;
                var $meter = $(this).find(".st-rel-card-meter").first();
                var from = $meter.attr("data-from"), to = $meter.attr("data-to");
                var eo = null;
                simEdges.forEach(function(x) { if (x && x.data && x.data.from === from && x.data.to === to) eo = x; });
                if (eo) highlightEdge(eo);
            });
        }

        /** Graph-side emphasis for one edge (dims everything else). */
        function highlightEdge(edgeObj) {
            $container.find('.st-rel-edge').addClass('st-rel-dim');
            $container.find('.st-rel-edge[data-idx="'+simEdges.indexOf(edgeObj)+'"]').removeClass('st-rel-dim');
            $container.find('.st-rel-node').addClass('st-rel-dim').removeClass('st-rel-selected');
            $container.find('.st-rel-node[data-nidx="'+edgeObj.source.idx+'"], .st-rel-node[data-nidx="'+edgeObj.target.idx+'"]').removeClass('st-rel-dim');
        }

        /** Scrolls the tapped edge's card into view with a brief accent flash. */
        function flashCard(eData) {
            function findCard() {
                // Match via meter rows — a dual card carries two directions, either
                // of which should land on the same card.
                return $container.find(".st-rel-card").filter(function() {
                    return $(this).find(".st-rel-card-meter").filter(function() {
                        return $(this).attr("data-from") === eData.from && $(this).attr("data-to") === eData.to;
                    }).length > 0;
                }).first();
            }
            var $card = findCard();
            if (!$card.length) {
                // Card hidden by an active filter — reset to the full list first.
                renderRelBoard(null);
                $card = findCard();
            }
            if (!$card.length) return;
            if ($card[0].scrollIntoView) $card[0].scrollIntoView({ block: "nearest", behavior: "smooth" });
            $card.addClass("st-rel-card-hot");
            setTimeout(function() { $card.removeClass("st-rel-card-hot"); }, 900);
        }

        function selectNode(nodeObj) {
            Store.setRelSelectedNode(nodeObj.name);
            // Selecting (or re-selecting) a character closes any open editors —
            // they're per-character surfaces.
            relCardEditKey = null; relBioEditOpen = false; relAddOpen = false;
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
                $(this).toggleClass('st-rel-dim', !connectedNodeIdxs.has(thisIdx));
                $(this).toggleClass('st-rel-selected', thisIdx === nodeObj.idx);
            });
            $container.find('.st-rel-edge').each(function() {
                var eObj = simEdges[$(this).data('idx')];
                var connected = eObj && (eObj.source.idx === nodeObj.idx || eObj.target.idx === nodeObj.idx);
                $(this).toggleClass('st-rel-dim', !connected);
            });

            // The board below the graph doubles as the detail view: filter it
            // to this character's bonds (bio shown in its header).
            renderRelBoard(nodeObj.name);
        }

        $container.find('.st-rel-edge').on('mouseenter', function(e) {
            e.stopPropagation();
            var idx = $(this).data("idx");
            if (idx === undefined || !simEdges[idx]) return;
            highlightEdge(simEdges[idx]);
        });
        $container.find('.st-rel-edge').on('click', function(e) {
            e.stopPropagation();
            var idx = $(this).data("idx");
            if (idx === undefined || !simEdges[idx]) return;
            highlightEdge(simEdges[idx]);
            flashCard(simEdges[idx].data);
        });

        // --- Node drag (reposition + persist) and tap-to-select ---
        $container.find('.st-rel-node').each(function() {
            var nodeEl = this;
            var nidx = $(nodeEl).data('nidx');
            var sn = simNodes[nidx];
            if (!sn) return;

            var dragPointerId = null, dragging = false;
            var startClientX = 0, startClientY = 0, startWorldX = 0, startWorldY = 0;

            function updateEdgesForNode() {
                simEdges.forEach(function(eObj, idx) {
                    if (eObj.source.idx !== sn.idx && eObj.target.idx !== sn.idx) return;
                    var $line = $container.find('.st-rel-edge[data-idx="'+idx+'"]');
                    if (eObj.source.idx === sn.idx) { $line.attr('x1', sn.x); $line.attr('y1', sn.y); }
                    if (eObj.target.idx === sn.idx) { $line.attr('x2', sn.x); $line.attr('y2', sn.y); }
                });
            }

            nodeEl.addEventListener('pointerdown', function(e) {
                e.stopPropagation();
                dragging = false;
                dragPointerId = e.pointerId;
                startClientX = e.clientX; startClientY = e.clientY;
                startWorldX = sn.x; startWorldY = sn.y;
                try { nodeEl.setPointerCapture(dragPointerId); } catch(err) {}
            });

            nodeEl.addEventListener('pointermove', function(e) {
                if (dragPointerId === null || e.pointerId !== dragPointerId) return;
                var dxScreen = e.clientX - startClientX;
                var dyScreen = e.clientY - startClientY;
                if (!dragging && Math.hypot(dxScreen, dyScreen) > 4) dragging = true;
                if (!dragging) return;
                sn.x = startWorldX + dxScreen / currentView.scale;
                sn.y = startWorldY + dyScreen / currentView.scale;
                nodeEl.setAttribute('transform', 'translate('+sn.x+','+sn.y+')');
                updateEdgesForNode();
            });

            nodeEl.addEventListener('pointerup', function(e) {
                e.stopPropagation();
                if (dragPointerId === null || e.pointerId !== dragPointerId) return;
                try { nodeEl.releasePointerCapture(dragPointerId); } catch(err) {}
                dragPointerId = null;
                if (dragging) {
                    var nodeObj = nodeMap[sn.name] || nodeMap[sn.id];
                    if (nodeObj) { nodeObj.x = sn.x; nodeObj.y = sn.y; }
                    Persistence.saveRelationshipData();
                    dragging = false;
                    return; // a drag never counts as a tap/select
                }
                selectNode(sn);
            });

            nodeEl.addEventListener('pointercancel', function() {
                dragPointerId = null; dragging = false;
            });
        });

        // --- Background pan + pinch/wheel zoom ---
        var activePointers = {};
        var panDragging = false, panBgDragged = false;
        var panStartX = 0, panStartY = 0, panStartTx = 0, panStartTy = 0;
        var pinchStartDist = 1, pinchStartScale = 1, pinchStartView = { tx: 0, ty: 0 };

        svgEl.style.cursor = 'grab';

        svgEl.addEventListener('pointerdown', function(e) {
            activePointers[e.pointerId] = { x: e.clientX, y: e.clientY };
            try { svgEl.setPointerCapture(e.pointerId); } catch(err) {}
            var ids = Object.keys(activePointers);
            if (ids.length === 1) {
                panDragging = true; panBgDragged = false;
                panStartX = e.clientX; panStartY = e.clientY;
                panStartTx = currentView.tx; panStartTy = currentView.ty;
                svgEl.style.cursor = 'grabbing';
            } else if (ids.length === 2) {
                panDragging = false;
                var pts = ids.map(function(id) { return activePointers[id]; });
                pinchStartDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
                pinchStartScale = currentView.scale;
                pinchStartView = { tx: currentView.tx, ty: currentView.ty };
            }
        });

        svgEl.addEventListener('pointermove', function(e) {
            if (!activePointers[e.pointerId]) return;
            activePointers[e.pointerId] = { x: e.clientX, y: e.clientY };
            var ids = Object.keys(activePointers);
            var rect = svgEl.getBoundingClientRect();

            if (ids.length === 2) {
                var pts = ids.map(function(id) { return activePointers[id]; });
                var dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
                var factor = dist / pinchStartDist;
                var midX = (pts[0].x + pts[1].x) / 2, midY = (pts[0].y + pts[1].y) / 2;
                var mx = (midX - rect.left) * (width / rect.width);
                var my = (midY - rect.top) * (height / rect.height);
                var newScale = relClampScale(pinchStartScale * factor);
                var worldX = (mx - pinchStartView.tx) / pinchStartScale;
                var worldY = (my - pinchStartView.ty) / pinchStartScale;
                currentView.scale = newScale;
                currentView.tx = mx - worldX * newScale;
                currentView.ty = my - worldY * newScale;
                applyViewTransform();
            } else if (ids.length === 1 && panDragging) {
                var dx = e.clientX - panStartX, dy = e.clientY - panStartY;
                if (Math.hypot(dx, dy) > 4) panBgDragged = true;
                currentView.tx = panStartTx + dx;
                currentView.ty = panStartTy + dy;
                applyViewTransform();
            }
        });

        function svgPointerEnd(e) {
            delete activePointers[e.pointerId];
            try { svgEl.releasePointerCapture(e.pointerId); } catch(err) {}
            var ids = Object.keys(activePointers);
            if (ids.length === 0) {
                var wasDrag = panBgDragged;
                panDragging = false; panBgDragged = false;
                svgEl.style.cursor = 'grab';
                persistView();
                if (!wasDrag) clearSelection();
            } else if (ids.length === 1) {
                panDragging = true;
                var remaining = activePointers[ids[0]];
                panStartX = remaining.x; panStartY = remaining.y;
                panStartTx = currentView.tx; panStartTy = currentView.ty;
            }
        }
        svgEl.addEventListener('pointerup', svgPointerEnd);
        svgEl.addEventListener('pointercancel', svgPointerEnd);

        svgEl.addEventListener('wheel', function(e) {
            e.preventDefault();
            var rect = svgEl.getBoundingClientRect();
            var mx = (e.clientX - rect.left) * (width / rect.width);
            var my = (e.clientY - rect.top) * (height / rect.height);
            zoomAt(mx, my, e.deltaY < 0 ? 1.12 : 1 / 1.12);
        }, { passive: false });

        $container.find('#st-rel-zoom-in').on('click', function() { zoomAt(width/2, height/2, 1.25); });
        $container.find('#st-rel-zoom-out').on('click', function() { zoomAt(width/2, height/2, 1/1.25); });
        $container.find('#st-rel-zoom-reset').on('click', function() {
            currentView = { tx: 0, ty: 0, scale: 1 };
            applyViewTransform();
            persistView();
        });

        // Board fill — restore a persisted node selection (so a save-triggered
        // full re-render keeps the filter + graph highlight) or show all bonds.
        var persistedSel = (Store.relSelectedNode && nodeMap[Store.relSelectedNode])
            ? simNodes.find(function(sn) { return sn.name === Store.relSelectedNode; })
            : null;
        if (persistedSel) selectNode(persistedSel);
        else renderRelBoard(null);

    } catch (err) {
        console.error("[Story Tracker] Error rendering relationship graph:", err);
        $container.html('<div class="st-no-data">Failed to render graph. Please check the console.</div>');
    }
}
// Feature: small strength-over-time sparkline next to each relationship's strength
// slider. Reads RelationshipAgent.buildStrengthTimeline() — the edge's `history`
// entries the tracker already snapshots on every update, just never visualized
// before. Renders nothing (returns "") when there isn't at least 2 points yet, i.e.
// a brand-new relationship with no history — a single dot isn't a "timeline".
function buildRelStrengthSparkline(edge) {
    if (!Store.RelationshipAgent) return "";
    var points = Store.RelationshipAgent.buildStrengthTimeline(edge, 10);
    if (points.length < 2) return "";

    var w = 62, h = 18, pad = 2;
    var stepX = (w - pad * 2) / (points.length - 1);
    // strength in [-1, 1] -> y in [pad, h-pad], higher strength drawn higher on the chart
    var toY = function(v) { return pad + (1 - (v + 1) / 2) * (h - pad * 2); };
    var coords = points.map(function(v, i) { return (pad + i * stepX).toFixed(1) + "," + toY(v).toFixed(1); }).join(" ");
    var zeroY = toY(0).toFixed(1);
    var trendUp = points[points.length - 1] >= points[0];

    return '<svg class="st-rel-edit-sparkline" viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h + '" title="Strength over time">' +
        '<line x1="' + pad + '" y1="' + zeroY + '" x2="' + (w - pad) + '" y2="' + zeroY + '" class="st-rel-spark-zero"></line>' +
        '<polyline points="' + coords + '" class="st-rel-spark-line' + (trendUp ? " st-rel-spark-up" : " st-rel-spark-down") + '"></polyline>' +
        "</svg>";
}

function buildChatButton() {
    if (!document.getElementById("st-trigger")) {
        var btn = '<div id="st-trigger" class="st-trigger interactable" title="Story Tracker"><i class="fa-solid fa-book-open-reader"></i></div>';
        var $l = $("#leftSendForm"); if ($l.length) $l.append(btn); else $("#send_form").prepend(btn);
        $(document).on("click", "#st-trigger", function() { Persistence.loadStoryData(); renderModal(); $("#st-modal").fadeIn(150); updateSettingsUI(); });
    }
    toggleChatButtonVisibility();
}
// --- Custom time-skip phrase chips (settings UI) ------------------------------
// The setting itself stays a plain newline-joined string (DEFAULT_SETTINGS.
// customSkipPhrases) — exactly what TimelineEngine.parseCustomSkipPhrases already
// reads — so Pipeline/detection code is untouched. These helpers are purely how
// the settings panel renders and edits that string as removable chips.
function getCustomSkipPhraseList() {
    return String((Store.settings && Store.settings.customSkipPhrases) || "")
        .split(/\r?\n/).map(function(s) { return s.trim(); }).filter(Boolean);
}

function setCustomSkipPhraseList(list) {
    Store.settings.customSkipPhrases = list.join("\n");
    Persistence.save();
    renderCustomSkipChips();
}

function renderCustomSkipChips() {
    var $box = $("#st-custom-skip-chips");
    if (!$box.length) return;
    var phrases = getCustomSkipPhraseList();
    if (phrases.length === 0) {
        $box.html('<small class="st-chip-empty">No custom phrases yet.</small>');
        return;
    }
    // Chips are identified by index, not by matching text back out of the DOM —
    // avoids any escaping round-trip issues with quotes/entities in phrases.
    $box.html(phrases.map(function(p, i) {
        return '<span class="st-chip">' + esc(p) +
            '<button type="button" class="st-chip-del" data-idx="' + i + '" title="Remove this phrase">&times;</button></span>';
    }).join(""));
}

function buildSettingsPanel() {
    var $c = $("#extensions_settings2"); if (!$c.length) $c = $("#extensions_settings"); if (!$c.length) return;
    // st-settings-root scopes style.css's nested-drawer styling (Scene/World/Relationship
    // sub-sections below) to Story Tracker's own panel only — see style.css. Without it the
    // selector matched ANY extension's nested inline-drawer inside #extensions_settings.
    var h = '<div class="inline-drawer st-settings-root"><div class="inline-drawer-toggle inline-drawer-header"><b><i class="fa-solid fa-book-open-reader"></i> Story Tracker</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div><div class="inline-drawer-content">';
    h += '<div class="da-srow"><label class="checkbox_label"><input type="checkbox" id="st-s-on"><span>Enable Extension</span></label></div>';
    
    h += '<div class="da-srow"><label class="checkbox_label"><input type="checkbox" id="st-s-hud"><span>Show HUD Widget</span></label></div>';
    h += '<div class="da-srow" id="st-scale-row"><label><small>HUD Scale: <span id="st-scale-val"></span>%</small></label><input type="range" id="st-s-scale" min="50" max="200" step="5"></div>';
    h += '<div class="da-srow" id="st-hud-tint-row"><label class="checkbox_label"><input type="checkbox" id="st-s-hud-tint"><span>Time-of-day tint (HUD color follows the RP clock)</span></label></div>';

    // RGB Highlight Colors
    h += '<hr><div class="da-srow"><b>Accent Highlight Color (RGB)</b></div>';
    h += '<div class="da-srow"><small style="opacity:.7">Adjust sliders to customize key titles, icons, and card highlights to match your theme.</small></div>';
    h += '<div class="da-srow"><label><small>Red: <span id="st-rgb-r-val">' + Store.settings.accentR + '</span></small></label><input type="range" id="st-s-rgb-r" min="0" max="255" step="1" value="' + Store.settings.accentR + '"></div>';
    h += '<div class="da-srow"><label><small>Green: <span id="st-rgb-g-val">' + Store.settings.accentG + '</span></small></label><input type="range" id="st-s-rgb-g" min="0" max="255" step="1" value="' + Store.settings.accentG + '"></div>';
    h += '<div class="da-srow"><label><small>Blue: <span id="st-rgb-b-val">' + Store.settings.accentB + '</span></small></label><input type="range" id="st-s-rgb-b" min="0" max="255" step="1" value="' + Store.settings.accentB + '"></div>';
    h += '<div class="da-srow" style="display:flex; align-items:center; gap:8px;"><small>Preview Color:</small> <span id="st-rgb-preview" style="display:inline-block; width:20px; height:20px; border-radius:50%; border:1px solid rgba(255,255,255,0.2);"></span></div>';

    // Scene Tracker — nested drawer, closed by default. The old separate "General /
    // Advanced" drawer has been folded in here: connection profile and Time Mode only
    // ever affected Scene Agent's own behavior in practice (profile is used exclusively
    // by the Scene Agent + city/country fallback calls; Time Mode decides purely WHEN
    // Scene Agent fires), so they now live directly alongside Scene Tracker's other
    // settings instead of a separate catch-all drawer. Chat-icon visibility and the
    // post-response delay are genuinely extension-wide (not scene-specific), but this
    // is now the only advanced-settings drawer, so they're kept here too rather than
    // having nowhere to live.
    h += '<hr><div class="inline-drawer"><div class="inline-drawer-toggle inline-drawer-header"><b><i class="fa-solid fa-clapperboard"></i> Scene Tracker</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div><div class="inline-drawer-content" style="display:none;">';
    h += '<div class="da-srow"><label class="checkbox_label"><input type="checkbox" id="st-s-auto"><span>Auto-update Scene</span></label></div>';
    h += '<div class="da-srow"><label class="checkbox_label"><input type="checkbox" id="st-s-cityctry"><span>Show City / Country (LLM infers or invents)</span></label></div>';
    h += '<div class="da-srow"><small style="opacity:.7">Enabling also injects scene context into prompts automatically.</small></div>';

    h += '<hr><div class="da-srow"><label class="checkbox_label"><input type="checkbox" id="st-s-chatbtn"><span>Show Icon in Chat Panel</span></label></div>';

    h += '<hr><div class="da-srow"><label class="checkbox_label"><input type="checkbox" id="st-s-useprofile"><span>Use a separate Connection Profile for analysis</span></label></div>';
    h += '<div class="da-srow" id="st-profile-row"><label><small>Analysis Profile:</small></label>';
    h += '<div style="display:flex;gap:5px;align-items:center;"><select id="st-s-profile" class="text_pole" style="flex:1"></select>';
    h += '<button class="menu_button" id="st-s-profile-refresh" title="Refresh profile list" style="flex:0 0 auto;"><i class="fa-solid fa-rotate"></i></button></div></div>';

    // Post-response delay slider
    h += '<hr><div class="da-srow"><b>Timing</b></div>';
    h += '<div class="da-srow"><small style="opacity:.7">Delay before extension starts after a response. Increase on slow devices (e.g. Termux) if you get concurrent request errors.</small></div>';
    h += '<div class="da-srow"><label><small>Post-response delay: <span id="st-s-delay-val"></span>ms</small></label><input type="range" id="st-s-startup-delay" min="500" max="8000" step="500"></div>';

    // Time Mode — a single checkbox switches between the two, both fully LLM-driven.
    // Unchecked = Message Mode (cadence slider shown). Checked = Smart Time (its own
    // big-jump sub-setting shown instead). The clock's flat 1-min/message tick underneath
    // runs regardless — this only decides which trigger overrides it with a real duration.
    h += '<hr><div class="da-srow"><b>Time Mode</b></div>';
    h += '<div class="da-srow"><small style="opacity:.7">The LLM always determines the real elapsed time — this just decides how it gets triggered.</small></div>';
    h += '<div class="da-srow"><label class="checkbox_label"><input type="checkbox" id="st-s-smart-time"><span>Smart Time (event-driven — calls the LLM only when it spots real time-skip language)</span></label></div>';
    h += '<div class="da-srow" id="st-message-mode-row" style="padding-left:20px;">';
    h += '  <small style="opacity:.7">Message Mode: reviews everything since the last check-in every few messages.</small>';
    h += '  <label><small>Review every <span id="st-s-msg-interval-val"></span> messages</small></label><input type="range" id="st-s-msg-interval" min="2" max="20" step="1">';
    h += '</div>';
    h += '<div class="da-srow" id="st-smart-time-sub-row" style="padding-left:14px;border-left:2px solid rgba(255,255,255,0.08); display:none;">';
    h += '  <small style="opacity:.7">Fallback cadence, in case skip-language is never detected.</small>';
    h += '  <label><small><span id="st-scene-interval-label">Scene tier interval (RP-minutes)</span>: <span id="st-interval-val"></span></small></label><input type="number" id="st-s-interval" class="text_pole" min="1" style="width:100%">';
    h += '  <label style="margin-top:8px;"><small>Extra time-skip phrases</small></label>';
    h += '  <div id="st-custom-skip-chips" class="st-chip-list"></div>';
    h += '  <div class="st-chip-input-row">';
    h += '    <input type="text" id="st-s-custom-skip-input" class="text_pole" placeholder="e.g. три дня спустя — press Enter to add" style="flex:1;">';
    h += '    <button type="button" class="menu_button" id="st-s-custom-skip-add" title="Add phrase" style="flex:0 0 auto;"><i class="fa-solid fa-plus"></i></button>';
    h += '  </div>';
    h += '  <small style="opacity:.7">Fires the Smart Time check when a message contains one of these (typo-tolerant). The built-in detection is English-only, so for non-English stories these phrases are the ONLY skip trigger — add your language\'s common time-skip wording here.</small>';
    h += '</div>';
    h += '</div></div>'; // end Scene Tracker nested drawer (now also covers former General/Advanced settings)

    // World Agent Settings — nested drawer, closed by default, so the main panel doesn't
    // dump every tier's cadence slider in the user's face all at once.
    h += '<div class="inline-drawer"><div class="inline-drawer-toggle inline-drawer-header"><b><i class="fa-solid fa-earth-americas"></i> World Agent Settings</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div><div class="inline-drawer-content" style="display:none;">';
    h += '<div class="da-srow"><label class="checkbox_label"><input type="checkbox" id="st-s-world-on"><span>Enable World Agent</span></label></div>';
    h += '<div class="da-srow"><small style="opacity:.7">Enabling also injects its context into prompts — there\'s no separate inject toggle anymore.</small></div>';
    h += '<div class="da-srow"><label class="checkbox_label"><input type="checkbox" id="st-s-world-useprofile"><span>Use Separate Connection Profile</span></label></div>';
    
    h += '<div class="da-srow" id="st-world-profile-row"><label><small>Analysis Profile:</small></label>';
    h += '<div style="display:flex;gap:5px;align-items:center;"><select id="st-s-world-profile" class="text_pole" style="flex:1"></select>';
    h += '<button class="menu_button" id="st-s-world-profile-refresh" title="Refresh profile list" style="flex:0 0 auto;"><i class="fa-solid fa-rotate"></i></button></div></div>';

    // (World-seed lorebook is chosen PER-CHAT from the World tab, not here — see the
    // World Rules section in renderModal. A global setting can't be per-chat.)

    // The old single "World Tick Frequency" dropdown is gone — the World Agent is now 4
    // independent tiers (npc/weather/faction/world), each with its own RP-time cadence, run
    // by the Scheduler. Exposed here as advanced sub-settings under the single World toggle,
    // per the "3 categories, tiers internal" decision.
    h += '<div class="da-srow"><b><small id="st-tier-cadence-label">Tier Update Cadence (RP-minutes)</small></b></div>';
    h += '<div class="da-srow"><label><small>NPC behavior (fast, offscreen activity):</small></label>' +
         '<input type="number" id="st-s-npc-tier-minutes" class="text_pole" min="1" style="width:100%"></div>';
    h += '<div class="da-srow"><label><small>Regional weather trend:</small></label>' +
         '<input type="number" id="st-s-weather-tier-minutes" class="text_pole" min="1" style="width:100%"></div>';
    h += '<div class="da-srow"><label><small>Faction/plot events:</small></label>' +
         '<input type="number" id="st-s-faction-tier-minutes" class="text_pole" min="1" style="width:100%"></div>';
    h += '<div class="da-srow"><label><small>World summary synthesis (slow, daily by default):</small></label>' +
         '<input type="number" id="st-s-world-tier-minutes" class="text_pole" min="1" style="width:100%"></div>';

    h += '<div class="da-srow" id="st-max-ticks-row"><label><small>Maximum Tick Catchup (per tier): <span id="st-max-ticks-val"></span></small></label>' +
         '<input type="range" id="st-s-max-ticks" min="1" max="24" step="1"></div>';

    h += '<div class="inline-drawer" style="margin-top:6px;"><div class="inline-drawer-toggle inline-drawer-header"><b><small>Advanced</small></b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div><div class="inline-drawer-content" style="display:none;">';
    h += '<div class="da-srow"><label class="checkbox_label"><input type="checkbox" id="st-s-world-parallel"><span>Run due tiers in parallel</span></label></div>';
    h += '<div class="da-srow"><small style="opacity:.7">When several tiers are due on the same message, run NPC/Weather/Faction at the same time instead of one after another (World still waits for Faction to finish, since it reads Faction\'s fresh output). Faster, but sends multiple LLM calls at once — leave off if you\'re on a tight per-minute rate limit.</small></div>';
    h += '<div class="da-srow"><label><small>Seasonal grounding:</small></label>' +
         '<select id="st-s-season-hemisphere" class="text_pole" style="width:100%">' +
         '<option value="northern">Northern hemisphere</option>' +
         '<option value="southern">Southern hemisphere</option>' +
         '<option value="none">Off (no real-calendar mapping)</option>' +
         '</select></div>';
    h += '<div class="da-srow"><small style="opacity:.7">Feeds the current real-calendar season (from the RP date) into the Weather and World tier prompts as light grounding context. Turn off for settings with their own fictional calendar.</small></div>';
    h += '</div></div>'; // end Advanced sub-drawer

    h += '</div></div>'; // end World Agent nested drawer

    // Relationship Tracker Settings — nested drawer, closed by default
    h += '<div class="inline-drawer"><div class="inline-drawer-toggle inline-drawer-header"><b><i class="fa-solid fa-people-arrows"></i> Relationship Tracker</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div><div class="inline-drawer-content" style="display:none;">';
    h += '<div class="da-srow"><small style="opacity:.7">Tracks character bonds and how they evolve on its own message interval.</small></div>';
    h += '<div class="da-srow"><label class="checkbox_label"><input type="checkbox" id="st-s-rel-on"><span>Enable Relationship Tracker</span></label></div>';
    h += '<div class="da-srow"><label class="checkbox_label"><input type="checkbox" id="st-s-rel-auto"><span>Auto-analyze on interval</span></label></div>';
    h += '<div class="da-srow" id="st-rel-interval-row"><label><small>Analyze every N messages: <span id="st-rel-interval-val"></span></small></label><input type="range" id="st-s-rel-interval" min="1" max="20" step="1"></div>';
    h += '<div class="da-srow"><label class="checkbox_label"><input type="checkbox" id="st-s-rel-useprofile"><span>Use Separate Connection Profile</span></label></div>';
    h += '<div class="da-srow" id="st-rel-profile-row"><label><small>Relationship Profile:</small></label>';
    h += '<div style="display:flex;gap:5px;align-items:center;"><select id="st-s-rel-profile" class="text_pole" style="flex:1"></select>';
    h += '<button class="menu_button" id="st-s-rel-profile-refresh" title="Refresh profile list" style="flex:0 0 auto;"><i class="fa-solid fa-rotate"></i></button></div></div>';
    h += '<div class="da-srow"><small style="opacity:.7">Enabling above also injects relationship context into prompts automatically.</small></div>';
    h += '</div></div>'; // end Relationship nested drawer

    h += '<hr><div class="da-srow da-srow-btns"><input type="button" class="menu_button" id="st-s-open" value="Open Tracker"></div></div></div>';
    $c.append(h);

    $("#st-s-on").prop("checked", Store.settings.enabled).on("change", function() { 
        Store.settings.enabled = this.checked; Persistence.save(); HUD.renderHUD(); toggleChatButtonVisibility();
        Pipeline.injectContextToChat(); // sync (or clear) the injected prompt immediately, don't wait for the next message
    });
    
    $("#st-s-hud").prop("checked", Store.settings.showHUD).on("change", function() {
        Store.settings.showHUD = this.checked; Persistence.save(); HUD.renderHUD();
        $("#st-scale-row").toggle(this.checked);
        $("#st-hud-tint-row").toggle(this.checked);
    });
    $("#st-scale-row").toggle(Store.settings.showHUD);
    $("#st-hud-tint-row").toggle(Store.settings.showHUD);

    $("#st-s-hud-tint").prop("checked", Store.settings.hudTimeTint !== false).on("change", function() {
        Store.settings.hudTimeTint = this.checked;
        Persistence.save();
        HUD.renderHUD();
    });

    // Bound here, once — updateSettingsUI only syncs the displayed value (see the
    // note there about the duplicate-handler bug this replaces).
    $("#st-s-startup-delay").on("input", function() {
        Store.settings.startupDelay = parseInt(this.value, 10);
        $("#st-s-delay-val").text(this.value);
        Persistence.save();
    });
    
    $("#st-s-scale").val(Store.settings.hudScale).on("input", function() { 
        Store.settings.hudScale = parseInt(this.value, 10); 
        $("#st-scale-val").text(this.value); 
        Persistence.save(); 
        HUD.applyHudStyle(); 
    });
    $("#st-scale-val").text(Store.settings.hudScale);
    
    $("#st-s-chatbtn").prop("checked", Store.settings.showChatButton).on("change", function() {
        Store.settings.showChatButton = this.checked; 
        Persistence.save(); 
        toggleChatButtonVisibility(); 
    });
    
    $("#st-s-auto").on("change", function() { 
        let val = this.checked;
        if (Store.storyData) {
            Store.storyData.autoUpdate = val;
            Persistence.saveStoryData();
        }
        Store.settings.autoUpdate = val; // Also acts as default for future chats
        Persistence.save(); 
        renderModal(); 
    });

    // Scene is now a time-based Scheduler tier (RP-minutes), not a message-count interval.
    // Changing it resets the scene tier's accumulator so the new cadence is honored
    // immediately, same "no save-and-reload needed" behavior established for the old
    // message-count sliders.
    $("#st-s-interval").val(Store.settings.sceneTierMinutes).on("input", function() { 
        let val = Math.max(1, parseInt(this.value, 10) || 1); 
        $("#st-interval-val").text(val); 
        Store.settings.sceneTierMinutes = val;
        if (Store.worldData && Store.worldData._schedulerAccumulated) {
            Store.worldData._schedulerAccumulated.scene = 0;
            Persistence.saveWorldData();
        }
        Persistence.save(); 
        renderModal(); 
        renderAutoInfo();
    });
    $("#st-interval-val").text(Store.settings.sceneTierMinutes);
    
    $("#st-s-cityctry").prop("checked", Store.settings.showCityCountry).on("change", function() { Store.settings.showCityCountry = this.checked; Persistence.save(); renderModal(); HUD.renderHUD(); });

    $("#st-s-smart-time").on("change", function() {
        Store.settings.timeMode = this.checked ? "smart" : "message";
        Persistence.save();
        $("#st-message-mode-row").toggle(!this.checked);
        $("#st-smart-time-sub-row").toggle(this.checked);
        renderAutoInfo();
    });
    $("#st-s-msg-interval").val(Store.settings.messageModeInterval || 5).on("input", function() {
        Store.settings.messageModeInterval = parseInt(this.value, 10);
        $("#st-s-msg-interval-val").text(this.value);
        Persistence.save();
    });
    $("#st-s-msg-interval-val").text(Store.settings.messageModeInterval || 5);

    // Chip-style editor for the custom skip phrases — see the helpers above
    // buildSettingsPanel. Caps mirror parseCustomSkipPhrases (80 chars/phrase,
    // 50 phrases): anything past those would be silently ignored by the parser
    // anyway, so it's clearer to stop it at entry with feedback.
    function addCustomSkipPhraseFromInput() {
        var $input = $("#st-s-custom-skip-input");
        var phrase = String($input.val() || "").trim().slice(0, 80);
        if (!phrase) return;
        var phrases = getCustomSkipPhraseList();
        if (phrases.length >= 50) {
            if (typeof toastr !== "undefined") toastr.warning("Phrase list is full (50 max) — remove one first.");
            return;
        }
        var lower = phrase.toLowerCase();
        if (phrases.some(function(p) { return p.toLowerCase() === lower; })) {
            if (typeof toastr !== "undefined") toastr.info("That phrase is already in the list.");
            $input.val("");
            return;
        }
        phrases.push(phrase);
        setCustomSkipPhraseList(phrases);
        $input.val("").focus();
    }
    $("#st-s-custom-skip-add").on("click", addCustomSkipPhraseFromInput);
    $("#st-s-custom-skip-input").on("keydown", function(e) {
        if (e.key === "Enter") { e.preventDefault(); addCustomSkipPhraseFromInput(); }
    });
    // Delegated from the (static) container — the chips inside are re-rendered
    // on every add/remove, so binding them directly would go stale.
    $("#st-custom-skip-chips").on("click", ".st-chip-del", function() {
        var idx = parseInt($(this).attr("data-idx"), 10);
        var phrases = getCustomSkipPhraseList();
        if (isNaN(idx) || idx < 0 || idx >= phrases.length) return;
        phrases.splice(idx, 1);
        setCustomSkipPhraseList(phrases);
    });
    renderCustomSkipChips();

    // RGB Slider Bindings
    $("#st-s-rgb-r").on("input", function() {
        Store.settings.accentR = parseInt(this.value, 10);
        $("#st-rgb-r-val").text(this.value);
        Persistence.save();
        applyCustomAccentColor();
    });
    $("#st-s-rgb-g").on("input", function() {
        Store.settings.accentG = parseInt(this.value, 10);
        $("#st-rgb-g-val").text(this.value);
        Persistence.save();
        applyCustomAccentColor();
    });
    $("#st-s-rgb-b").on("input", function() {
        Store.settings.accentB = parseInt(this.value, 10);
        $("#st-rgb-b-val").text(this.value);
        Persistence.save();
        applyCustomAccentColor();
    });

    $("#st-s-useprofile").prop("checked", Store.settings.useConnectionProfile).on("change", function() {
        Store.settings.useConnectionProfile = this.checked;
        Persistence.save();
        $("#st-profile-row").toggle(this.checked);
    });
    $("#st-profile-row").toggle(Store.settings.useConnectionProfile);
    // Save the selected scene analysis profile whenever it changes
    $("#st-s-profile").on("change", function() { Store.settings.connectionProfile = this.value; Persistence.save(); });
    $("#st-s-profile-refresh").on("click", function() {
        populateProfileDropdown();
        if (typeof toastr !== "undefined") toastr.info("Connection profile list refreshed.");
    });

    // World Agent Settings Element Bindings
    $("#st-s-world-on").prop("checked", Store.settings.worldEnabled).on("change", function() {
        Store.settings.worldEnabled = this.checked; Persistence.save(); HUD.renderHUD(); renderModal(); renderAutoInfo();
        Pipeline.injectContextToChat(); // sync the injected prompt immediately, don't wait for the next message
    });
    $("#st-s-world-useprofile").prop("checked", Store.settings.useWorldProfile).on("change", function() {
        Store.settings.useWorldProfile = this.checked; Persistence.save();
        $("#st-world-profile-row").toggle(Store.settings.useWorldProfile);
    });
    $("#st-world-profile-row").toggle(Store.settings.useWorldProfile);

    $("#st-s-world-profile").on("change", function() { Store.settings.worldConnectionProfile = this.value; Persistence.save(); });
    $("#st-s-world-profile-refresh").on("click", function() {
        populateProfileDropdown();
        if (typeof toastr !== "undefined") toastr.info("Connection profile list refreshed.");
    });

    // Scheduler tier intervals (npc/weather/faction/world) — internal to the single World
    // toggle. Changing these takes effect immediately, same "no save-and-reload needed"
    // behavior as the scene/relationship interval sliders established earlier.
    function bindTierMinutesInput(selector, settingKey) {
        $(selector).val(Store.settings[settingKey]).on("input", function() {
            var val = Math.max(1, parseInt(this.value, 10) || 1);
            Store.settings[settingKey] = val;
            Persistence.save();
            renderAutoInfo();
        });
    }
    bindTierMinutesInput("#st-s-npc-tier-minutes", "npcTierMinutes");
    bindTierMinutesInput("#st-s-weather-tier-minutes", "weatherTierMinutes");
    bindTierMinutesInput("#st-s-faction-tier-minutes", "factionTierMinutes");
    bindTierMinutesInput("#st-s-world-tier-minutes", "worldTierMinutes");

    $("#st-s-max-ticks").val(Store.settings.maxWorldTicks).on("input", function() {
        Store.settings.maxWorldTicks = parseInt(this.value, 10);
        $("#st-max-ticks-val").text(this.value);
        Persistence.save();
    });
    $("#st-max-ticks-val").text(Store.settings.maxWorldTicks);

    $("#st-s-world-parallel").prop("checked", Store.settings.parallelWorldTiers).on("change", function() {
        Store.settings.parallelWorldTiers = this.checked; Persistence.save();
    });
    $("#st-s-season-hemisphere").val(Store.settings.seasonHemisphere || "northern").on("change", function() {
        Store.settings.seasonHemisphere = this.value; Persistence.save();
    });

    // Relationship Tracker Settings Element Bindings
    $("#st-s-rel-on").prop("checked", Store.settings.relationsEnabled).on("change", function() {
        Store.settings.relationsEnabled = this.checked; Persistence.save(); HUD.renderHUD(); renderModal(); renderAutoInfo();
        Pipeline.injectContextToChat(); // sync the injected prompt immediately, don't wait for the next message
    });
    $("#st-s-rel-auto").prop("checked", Store.settings.relationsAutoUpdate).on("change", function() {
        Store.settings.relationsAutoUpdate = this.checked; Persistence.save();
        $("#st-rel-interval-row").toggle(this.checked);
        renderAutoInfo();
    });
    $("#st-rel-interval-row").toggle(Store.settings.relationsAutoUpdate);
    $("#st-s-rel-interval").val(Store.settings.relAutoInterval || 5).on("input", function() {
        Store.settings.relAutoInterval = parseInt(this.value, 10);
        $("#st-rel-interval-val").text(this.value);
        // Reset the relationship message counter so the new interval is honored from this point
        // forward, instead of waiting for relMsgCounter to naturally re-align to a multiple of it.
        Store.setRelMsgCounter(0);
        if (Store.storyData) {
            Store.storyData._relMsgCount = 0;
            Persistence.saveStoryData();
        }
        Persistence.save();
        renderAutoInfo();
    });
    $("#st-rel-interval-val").text(Store.settings.relAutoInterval || 5);
    $("#st-s-rel-useprofile").prop("checked", Store.settings.useRelProfile).on("change", function() {
        Store.settings.useRelProfile = this.checked; Persistence.save();
        $("#st-rel-profile-row").toggle(this.checked);
    });
    $("#st-rel-profile-row").toggle(Store.settings.useRelProfile);
    $("#st-s-rel-profile").on("change", function() { Store.settings.relConnectionProfile = this.value; Persistence.save(); });
    $("#st-s-rel-profile-refresh").on("click", function() {
        populateProfileDropdown();
        if (typeof toastr !== "undefined") toastr.info("Connection profile list refreshed.");
    });

    populateProfileDropdown();

    $("#st-s-open").on("click", function() { Persistence.loadStoryData(); renderModal(); $("#st-modal").fadeIn(150); });

    updateSettingsUI();
}

function toggleChatButtonVisibility() {
    var $trigger = $("#st-trigger");
    if ($trigger.length) {
        if (Store.settings.enabled && Store.settings.showChatButton) {
            $trigger.show();
        } else {
            $trigger.hide();
        }
    }
}

// Body of the top-of-World-tab "World Lorebooks" panel (per chat). VIEW mode: a
// read-only summary. EDIT mode: a checkbox per available book (seed on/off) + an
// "entries" button that opens the live-entry picker popout. Rebuilt on every
// renderModal (like the rest of the World tab), so it always reflects the live WI
// list and the current worldData selections. Handlers are delegated (see bindEvents).
function renderWorldLorebooksPanel() {
    var wd = Store.worldData;
    var seedBooks = (wd && Array.isArray(wd.seedLorebooks)) ? wd.seedLorebooks : [];
    var picks = (wd && Array.isArray(wd.contextEntries)) ? wd.contextEntries : [];

    if (!modalEditMode) {
        if (seedBooks.length === 0 && picks.length === 0) {
            return '<div style="opacity:.6;font-size:.85em;">No lorebooks selected for this chat. Tap the <i class="fa-solid fa-pen-to-square"></i> edit toggle (top-right) to choose books that seed the world.</div>';
        }
        var s = '<div style="font-size:.86em;line-height:1.5;">';
        s += '<div><b>Seeding World Rules:</b> ' + (seedBooks.length ? seedBooks.map(esc).join(', ') : '<span style="opacity:.6;">none</span>') + '</div>';
        s += '<div><b>Live entries → World Agent:</b> ' + (picks.length ? (esc(String(picks.length)) + ' selected') : '<span style="opacity:.6;">none</span>') + '</div>';
        s += '</div>';
        return s;
    }

    // Edit mode
    var names = [];
    try {
        var context = (typeof SillyTavern !== "undefined" && typeof SillyTavern.getContext === "function") ? SillyTavern.getContext() : null;
        if (context && typeof context.getWorldInfoNames === "function") names = context.getWorldInfoNames() || [];
    } catch (e) { names = []; }

    var h = "";
    if (names.length === 0) {
        h += '<div style="opacity:.7;font-size:.85em;">No lorebooks found. Create one in SillyTavern\'s <b>World Info</b>, then reopen this panel.</div>';
    } else {
        var rows = "";
        names.forEach(function (n) {
            if (!n) return;
            var isSeed = seedBooks.indexOf(n) !== -1;
            var cnt = picks.filter(function (p) { return p && String(p.book) === n; }).length;
            rows += '<div class="st-worldbook-row" data-search="' + esc(n.toLowerCase()) + '" style="display:flex;align-items:center;gap:8px;padding:3px 0;">' +
                '<label class="checkbox_label" style="flex:1;min-width:0;margin:0;">' +
                    '<input type="checkbox" class="st-worldbook-seed" data-book="' + esc(n) + '"' + (isSeed ? ' checked' : '') + '>' +
                    '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(n) + '</span>' +
                '</label>' +
                '<button class="menu_button st-worldbook-entries" data-book="' + esc(n) + '" title="Pick specific entries fed live to the World Agent" style="flex:0 0 auto;">' +
                    '<i class="fa-solid fa-list-check"></i> entries' + (cnt ? ' (' + cnt + ')' : '') + '</button>' +
            '</div>';
        });
        // Search box to filter the list below by book name — most useful once there
        // are enough books that the scroll box (next) actually needs scrolling.
        if (names.length > 4) {
            h += '<input type="text" id="st-worldbooks-book-search" class="text_pole" placeholder="Search lorebooks…" autocomplete="off" style="width:100%;box-sizing:border-box;margin-bottom:6px;">';
        }
        // Cap the height so a large lorebook collection doesn't sprawl down the tab —
        // scroll within this box instead.
        h += '<div class="st-worldbooks-list" style="max-height:168px;overflow-y:auto;-webkit-overflow-scrolling:touch;border:1px solid rgba(128,128,128,.18);border-radius:8px;padding:2px 9px;">' + rows +
            '<div id="st-worldbooks-book-noresults" style="display:none;opacity:.6;padding:6px 2px;">No lorebooks match your search.</div>' +
        '</div>';
    }
    h += '<div style="opacity:.65;font-size:.8em;margin-top:7px;line-height:1.4;">' +
        '<b>Checked</b> books are distilled — in full — into the <b>World Rules</b> below: once at a new chat\'s genesis, and whenever you regenerate the rules. ' +
        '<b>Entries</b> lets you pick specific entries that are then fed to the World Agent on <i>every</i> run — only those, never the whole book — ideal for dynamic memory-book entries. ' +
        'After changing books, regenerate the World Rules (its wand, in edit mode) to re-seed this chat.</div>';
    return h;
}

function populateProfileDropdown() {
    var profiles = ProfileSession.getProfileList();

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
        var saved = Store.settings.connectionProfile || "";
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
        var savedWorld = Store.settings.worldConnectionProfile || "";
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
        var savedRel = Store.settings.relConnectionProfile || "";
        if (savedRel && profiles.some(function (p) { return p.name === savedRel; })) {
            $selRel.val(savedRel);
        } else if (savedRel && profiles.length > 0) {
            $selRel.val("");
        }
    }
}
function syncToCharTracker() {
    try {
        var meta = Store.scriptModule ? Store.scriptModule.chat_metadata : null;
        if (!meta) return;
        var ct = meta["char_tracker"];
        if (!ct) return; 

        var day = 1, month = 1, year = 2024;
        var parts = (Store.storyData.date || "").split(/[\/\-\.]/);
        if (parts.length >= 3) {
            day   = parseInt(parts[0], 10) || 1;
            month = parseInt(parts[1], 10) || 1;
            year  = parseInt(parts[2], 10) || 2024;
        }

        // sharedTime always lives at the top level regardless of group/solo — only
        // location (below) differs per-character in a group chat.
        var container = ct;
        if (!container.sharedTime) container.sharedTime = {};
        container.sharedTime.time  = Store.storyData.time  || "--:--";
        container.sharedTime.day   = day;
        container.sharedTime.month = month;
        container.sharedTime.year  = year;
        container._timeInitialized = true;

        if (ct._isGroup) {
            var activeChar = ct._activeChar;
            if (activeChar && ct.characters && ct.characters[activeChar]) {
                ct.characters[activeChar].location = Store.storyData.location;
            }
        } else {
            ct.location = Store.storyData.location;
        }

        if (typeof Store.saveMetaFn === "function")
            Store.saveMetaFn();
        else if (typeof Store.scriptModule.saveMetadataDebounced === "function")
            Store.scriptModule.saveMetadataDebounced();

        console.log("[Story Tracker] Synced time/location → Character Tracker");
        $(document).trigger("CT_FORCE_RENDER");
    } catch(e) { console.error("[Story Tracker] syncToCharTracker error:", e); }
}
var INV_SLOTS        = ["head","torso","legs","feet","hands","lefthand","righthand","accessory1","accessory2"];
var INV_SLOT_LABELS  = { head:"Head", torso:"Torso", legs:"Legs", feet:"Feet", hands:"Hands", lefthand:"Left Hand", righthand:"Right Hand", accessory1:"Accessory 1", accessory2:"Accessory 2" };
var INV_SLOT_ICONS  = { head:"🎩", torso:"👕", legs:"👖", feet:"👟", hands:"🧤", lefthand:"🤚", righthand:"右手", accessory1:"💍", accessory2:"💍" };

function getInventoryOutfit() {
    try {
        var meta = Store.scriptModule ? Store.scriptModule.chat_metadata : null;
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
