# 📖 Deep Story Reforged — SillyTavern Extension

A SillyTavern extension that tracks **time, location, weather, character positions, offscreen world events, NPC schedules, remembered places, and character relationships** — and enforces all of it in code, not just prose. The RP clock is a real JS-owned value that only ever moves forward; scheduled events resolve deterministically the moment their time arrives, whether that's one message later or after a multi-day skip jumps straight past them.

Originally created by [virgilianshailer](https://github.com/virgilianshailer) as Story Tracker. This fork ("Reforged") replaced the original's regex-heuristic time handling with a JS-authoritative Timeline Engine and built a full simulation layer on top of it — a 4-tier World Agent, an Event Queue, NPC daily routines, a persistent Location Codex, and a Relationship Tracker with asymmetric relationships and name resolution.

---

## 📦 Installation

1. In SillyTavern, open **Extensions → Install Extension**.
2. Paste this repository's URL and click **Install**:
```
   https://github.com/jeppsterrr/Deep-Story-Reforged
```
Or install manually — clone or copy the whole folder into `public/scripts/extensions/third-party/`, then reload SillyTavern:

```
SillyTavern/
└── public/
    └── scripts/
        └── extensions/
            └── third-party/
                └── Deep-Story-Reforged/
                    ├── index.js
                    ├── style.css
                    ├── manifest.json
                    ├── Store.js
                    ├── Persistence.js
                    ├── ProfileSession.js
                    ├── Pipeline.js
                    ├── HUD.js
                    ├── LLMResponseParser.js
                    ├── TimelineEngine.js
                    ├── Scheduler.js
                    ├── EventQueue.js
                    ├── SceneAgent.js
                    ├── WorldAgent.js
                    └── RelationshipAgent.js
```

---

## ✨ Features

### 🕒 Timeline Engine — the clock is code, not prose

Every other system in this extension is built on top of one guarantee: **the RP clock is a plain JS value that only ever advances**, never something the model is trusted to state directly.

- **Baseline tick, always on** — every message nudges the clock forward a flat amount (default 1 minute) purely so the HUD never looks frozen. This runs whether or not any LLM-driven time detection is enabled.
- **The LLM proposes, JS decides** — the Scene tracker's own analysis call includes a `time_advance` judgment: *real time elapsed*, *a future promise was stated* ("the ship arrives in 3 hours"), *time is passing until an already-scheduled event*, or *nothing notable*. The model only ever proposes a type + a duration or event reference — it can never write a raw time/date value that reaches storage. JS validates the answer and enforces a hard ceiling (24h for an ordinary estimate, ~10 years for an explicitly-stated large skip like "six months later").
- **Two trigger modes:**
  - **Message Mode** (default) — reviews everything since the last check-in every N messages, same philosophy as the Relationship Tracker's interval.
  - **Smart Time** — event-driven. A cheap, local, zero-LLM-cost check scans for genuine time-skip language ("the next morning", "meanwhile", "three hours later") and fires the Scene analysis immediately when it spots one, instead of waiting out a fixed interval.
- **Custom time-skip phrases** — the built-in skip-language detection is English-only. A chip-editor in settings lets you add your own trigger phrases (typo-tolerant fuzzy matching), which is the only way Smart Time works at all for non-English roleplay. Both your message and the AI's reply are scanned, so a user-authored *"three days pass"* fires the check even if the reply doesn't echo it.
- **Time-of-day anchoring** — "it's now noon", "the next morning", "by dusk" all resolve to the same target hour whether they're the very first line of the story or buried in message 4,000, so the model, the genesis seeding, and the trigger detection never disagree about what time "morning" means.
- **Manual correction** — a "Correct the Clock" tool in the Scene tab lets you fix drift after deleting or heavily editing messages, with an option to resync every tracker's internal checkpoint to the current message so nothing tries to re-read deleted history.

### 🎬 Scene Tracking

- Time, date, day of week, location, weather, temperature, and city/country (the LLM infers real places or invents fitting fantasy/sci-fi names).
- Character position log — who's present and what they're doing right now.
- Outfit & held-item integration with the Inventory extension, folded into both the character cards and the injected prompt context.
- A concise, LLM-written summary of what just happened, kept in a scrollable history log.
- Scene weather is grounded by the World Agent's broader regional trend when one exists, instead of guessing blind on a brand-new chat.

### 🌍 World Progression Agent — four independent tiers

The old single "world tick" is split into four narrower, independently-scheduled tiers, each with its own configurable cadence in RP-minutes:

| Tier | Default cadence | What it does |
|---|---|---|
| **NPC** | 30 min | What tracked NPCs are doing offscreen — continuations of their last known activity, not random new plot beats. |
| **Weather** | 1 day | The broader *regional* trend (distinct from the scene's immediate weather) — incoming fronts, seasonal shifts. |
| **Faction** | 6 hours | Offscreen plot/faction developments and pending secrets, with realistic travel/news pacing. |
| **World** | 1 day | A rolling high-level synthesis of the overall world state — condenses, doesn't just log. |

- **Bounded catch-up** — a big time skip won't fire 36 weather ticks in one go; each tier caps how many ticks fire per cycle (configurable), and nothing is lost — the rest is deferred and catches up gradually, or (for an explicitly huge skip) reasoned about as one true full-gap batch instead.
- **Manual controls** — a "wand" regenerate button per section re-runs just that tier on demand; "Run World Tick" fires all four at once.
- **Cross-tier grounding** — each tier gets a bounded, already-validated slice of what the other tiers have already produced (recent world events, NPC activity), framed as established fact, so the tiers stay consistent with each other instead of contradicting.

#### 📅 Event Queue — scheduled & recurring events

Future promises ("a messenger departs, ETA ~4 hours") become hard guarantees instead of prose sitting in a shrinking context window. Once JS says the time has come, the event **will** resolve — whether that's one message later or after a multi-day skip jumps straight past it.

- Add events manually from the World tab, or let any tier schedule one automatically (an NPC's journey, a faction's delayed plot beat).
- **Recurring events** — mark an event Daily or Weekly and it re-enqueues its next occurrence the moment it resolves. A large time skip rolls a recurring event forward to its next *future* occurrence instead of firing a stack of overdue repeats.
- Pin any world event to protect it from the normal importance-based pruning that keeps the event log from growing forever.

#### 🧭 NPC Daily Routines

Tracked NPCs can be given a simple recurring schedule — "opens the forge at 07:00, breaks for lunch at 13:00, closes up at 19:00." Given the current RP clock, the engine deterministically knows what a routine-carrying NPC is doing *right now*, with zero extra LLM cost, and tells the model so directly: the blacksmith isn't home right now instead of teleporting wherever the scene needs him. Routines and goals are both "set once" — delete either from the World tab if the story outgrows them, and the tracker won't just reinvent one on the next tick.

#### 🗺️ Location Codex

When the scene moves somewhere new, what the *old* place looked like at the moment of departure — who was there, what had just happened, the weather, items left behind — is snapshotted into a persistent per-place memory. Return to that location 5 messages or 40 sessions later, and the stored state is re-injected so the place actually persists instead of relying entirely on the model's shrinking context to remember it. Viewable and individually forgettable from the World tab.

#### 🕵️ Pending Reveals

Secrets and rumors the world is developing that haven't reached the main characters yet. The Scene tracker doubles as the resolution check — since it reads the recent chat every few minutes of RP-time — so a reveal is automatically marked "now known" the moment the story actually delivers it, and becomes a proper world event from that point on.

### 💞 Relationship Tracker

- Types (`romance`, `friendship`, `family`, `alliance`, `rivalry`, `hostile`, `mentor`, `neutral`) and a continuous strength score from -1.0 (hostile) to +1.0 (deeply bonded).
- **Tiered context** — pairs currently relevant to the scene are sent to the model in full detail; everyone else is sent as a compact one-liner, so a long campaign's relationship web doesn't bloat every single call.
- **Asymmetric relationships** — an unrequited crush or one-sided resentment is tracked and rendered as a directional arrow (A → B), distinct from an ordinary mutual bond (A ↔ B), so the model never lets the other party act on a feeling they were never shown to share.
- **Evolution, not replacement** — updates revise the existing summary and log what changed (or confirm "Stable"), with a capped history log and a small strength-over-time sparkline in the edit view.
- **Name resolution** — "Ara Vorn", "Lt. Ara Vorn", and "Lieutenant Vorn" all resolve to the same tracked character instead of forking into duplicates, using title-stripping and conservative fuzzy matching (Unicode-aware, so this also works for non-Latin names).
- **Decay** — relationships involving nobody currently active in the story slowly drift toward neutral; deep bonds and bitter rivalries decay far more slowly than casual ties, so the story's most permanent relationships don't flatten out just because a character's been offscreen for a while.
- **Interactive graph** — pan, zoom, drag characters into position, and an inline edit panel for manual corrections (the LLM's extraction is a guess — this is the human-in-the-loop fix).

### 🖥️ HUD Widget

A small floating overlay for an at-a-glance read on the story state.

- Time, date, day of week, location, weather, and every present character — the list scrolls once it outgrows a few rows, instead of hard-capping at 3 and hiding the rest.
- **Time-of-day ambiance** — the HUD's background carries a subtle tint that follows the RP clock: deep navy at night, violet pre-dawn, warm gold through the day, ember at sunset. Purely cosmetic, but it doubles as a glanceable clock.
- **One signal line** — instead of stacking every possible notice, the HUD shows the single most time-sensitive thing worth knowing right now: an imminent scheduled event, else a world pulse, else the most-shifted relationship.
- Draggable, resizable (50–200%), collapsible to a small pill, and safe-area aware on mobile. Position and scale are remembered across sessions.

---

## ⚙️ Settings

Open **Extensions → Story Tracker** in the SillyTavern sidebar.

### General

| Setting | Description |
|---|---|
| **Enable Extension** | Master toggle for the entire extension. |
| **Show HUD Widget** | Show/hide the floating overlay. |
| **HUD Scale** | Resize the HUD (50–200%). |
| **Time-of-day tint** | Toggle the HUD's ambient clock-tint background. |
| **Accent Highlight Color (RGB)** | Customize the accent color used for titles, icons, and highlights throughout the UI. |

### Scene Tracker

| Setting | Description |
|---|---|
| **Auto-update Scene** | Whether the Scene tracker fires automatically at all (per-chat, defaults from the setting below). |
| **Show City / Country** | Show the city/realm field in the HUD and modal. |
| **Show Icon in Chat Panel** | Show/hide the book-icon button in the message input bar. |
| **Use a separate Connection Profile** | Route Scene analysis through a different Connection Profile, restored automatically afterward. |
| **Post-response delay** | Delay before the extension's pipeline starts after a generation finishes — raise this on slow devices if you see concurrent-request errors. |
| **Smart Time** | Switches from Message Mode (cadence-based) to Smart Time (event-driven skip detection). |
| **Review every N messages** | Message Mode's cadence. |
| **Scene tier interval (RP-minutes)** | Smart Time's fallback cadence, in case skip-language is never detected. |
| **Extra time-skip phrases** | Chip-editor list of custom trigger phrases for Smart Time — typo-tolerant, and the only way non-English skip language is detected. |

### World Agent Settings

| Setting | Description |
|---|---|
| **Enable World Agent** | Toggle the whole 4-tier simulation (also controls context injection — there's no separate toggle). |
| **Use Separate Connection Profile** | Route all World Agent calls through a dedicated profile. |
| **NPC / Weather / Faction / World cadences** | Each tier's update interval, in RP-minutes. |
| **Maximum Tick Catchup (per tier)** | Caps how many intervals' worth of catch-up a single tier processes at once after a big time skip. |
| **Run due tiers in parallel** *(Advanced)* | Runs NPC/Weather/Faction concurrently instead of sequentially when several are due the same message (World still waits for Faction's fresh output). Faster, but sends multiple simultaneous LLM calls — leave off on a tight rate limit. |
| **Seasonal grounding** *(Advanced)* | Feeds the current real-calendar season (from the RP date) into Weather/World prompts as light context. Turn off for a setting with its own fictional calendar. |

### Relationship Tracker

| Setting | Description |
|---|---|
| **Enable Relationship Tracker** | Toggle the relationship analysis system. |
| **Auto-analyze on interval** | Whether relationship analysis fires automatically. |
| **Analyze every N messages** | How often (default: 5). |
| **Use Separate Connection Profile** | Route relationship analysis through a dedicated profile. |

---

## 🖥️ Interface

### Modal Window
Open via the book-icon button in the chat input bar, or from the settings panel.

- **Scene tab** — time/date/location/weather, who's here, recent developments, and (if applicable) a preview of the current World summary. Includes the manual "Correct the Clock" tool.
- **History tab** — a scrollable log of past scene updates with timestamps and summaries.
- **World tab** — world summary, a compact season/weather-trend status strip, and four collapsible sections: **NPC Changes** (with goals and daily routines), **Pending Discoveries**, **World Events** (pinnable), and the **Location Codex**. Plus **Scheduled Events**, with an "Add Event" popout supporting one-time or recurring (daily/weekly) entries.
- **Relations tab** — the interactive relationship graph, with an inline edit panel for manual corrections.
- **Update now** button — forces an immediate Scene analysis; the World tab has its own Run Tick / Refresh / Clear controls, and Relations has Analyze / Reset Layout / Clear.

### HUD Widget
A compact floating panel showing time, date, location, weather, present characters, and one glanceable "signal" line. Click the header to collapse/expand, click the body to open the full modal, and drag freely to reposition — position and scale persist across sessions.

---

## 🔄 Using Separate Connection Profiles

Each of the three trackers (Scene, World, Relationship) can be routed through its own Connection Profile — e.g. a fast/cheap model for frequent Scene and Relationship calls, a stronger model for World simulation.

**How it works:**
1. Install/enable SillyTavern's built-in **Connection Profiles** extension.
2. Create the profiles you want, then enable the relevant option for each tracker in settings.
3. All trackers that fire on the same message share **one** profile-switch session — if Scene and two World tiers all fire on the same message, the active profile is switched once and restored once, not bounced back and forth per tracker.
4. If a page reload interrupts a mid-switch, the extension detects this on the next load and quietly restores your original profile.

---

## 🔗 Compatibility

| Extension | Integration |
|---|---|
| **Character Tracker** | Time, date, and location are pushed automatically on each scene update. |
| **Inventory** | Equipped outfits and held items are pulled into character lines and the injected prompt context. |
| **Connection Profiles** | Optional — only needed for per-tracker profile routing. |

---

## 📋 Requirements

- SillyTavern (a recent version with extension support)
- Any LLM backend connected to SillyTavern
- *(Optional)* The built-in **Connection Profiles** extension — only needed for separate profile routing.

---

## 📜 Version History

### 2.1.0
- **NEW** NPC Daily Routines — tracked NPCs can be given a simple recurring schedule; the engine deterministically knows what a routine-carrying NPC is doing at the current RP clock and tells the model so, with a code-enforced allow-list and a UI opt-out so a deleted routine doesn't just get reinvented.
- **NEW** Location Codex — persistent per-place memory. Leaving a location snapshots its state (who was there, what happened, weather); returning re-injects it so places actually persist instead of relying on shrinking context.
- **NEW** Recurring Event Queue entries — scheduled events can repeat (daily/weekly), re-enqueuing their next occurrence on resolve and rolling forward past missed occurrences after a big time skip instead of firing a backlog.
- **NEW** Time-of-day HUD ambiance — the HUD's background tints subtly with the RP clock (night/dawn/day/dusk).
- **IMPROVED** HUD character list no longer caps at 3 — every present character renders, in a scrollable list.
- **NEW** Custom time-skip trigger phrases, editable as chips in settings — the only way Smart Time detection works for non-English roleplay, since the built-in detection is English-only. Both the user's message and the AI's reply are scanned.
- **FIXED** A wide pass of long-roleplay durability issues: NPC name drift across phrasing variants no longer forks one character into duplicates; reworded pending reveals and duplicate scheduled events are now similarity-deduped instead of stacking; Location Codex keys are rename-tolerant; several state-corruption and crash bugs in the Timeline Engine's edge cases were fixed.

### 2.0.0
- **Forked from [virgilianshailer](https://github.com/virgilianshailer)'s original Story Tracker.**
- **NEW** Rewrote time-handling around a JS-authoritative **Timeline Engine** — the clock is a plain value that only ever advances; the model proposes a time-advance judgment (elapsed / scheduled / advance-to-event / none), JS validates and applies it with a hard ceiling. Includes both a cadence-based Message Mode and an event-driven Smart Time mode.
- **NEW** Added the **World Progression Agent** as four independently-scheduled tiers (NPC, Weather, Faction, World) instead of one monolithic tick, each with its own RP-minute cadence and bounded catch-up handling for large time skips.
- **NEW** Added an **Event Queue** — scheduled future actions that resolve deterministically once RP-time reaches them, surviving arbitrarily large time skips.
- **NEW** Added the **Relationship Tracker** — type + strength-scored relationships with evolution tracking, asymmetric (one-sided) relationship support, name resolution/dedup, and an interactive visual graph.
- All three trackers support dedicated Connection Profile routing, context injection, and manual triggering.

### 1.1.0
- **NEW:** Added support for using a separate **Connection Profile** for scene analysis, with automatic restore afterward.
- **NEW:** Added an Analysis Profile dropdown in settings, with a refresh button.
- Added a safety net: an interrupted mid-switch is detected and corrected on the next load.

### 1.0.0
- Initial release by [virgilianshailer](https://github.com/virgilianshailer).
- Scene context tracking (time, date, day of week, location).
- Temperature and weather tracking with HUD icons.
- Optional City & Country / Realm field (LLM infers or invents).
- Character position log.
- Outfit & held items integration via the Inventory extension.
- Recent events summary.
- HUD widget and modal interface (adjustable size and position).
- Author's Note context injection.
- History log (up to 20 snapshots).
- Character Tracker extension sync.

---

## 📄 License

MIT — free to use, modify, and distribute.
