# 📖 Story Tracker — SillyTavern Extension

A SillyTavern extension that automatically tracks **time, date, location, weather, character positions, outfits, and recent events** in your roleplay. It uses the LLM to analyze the chat and maintain narrative consistency, reducing character amnesia between messages.

Originally created by [virgilianshailer](https://github.com/virgilianshailer). This fork continues that work with expanded agent systems and new features built on top of the original foundation.

---

## 📦 Installation

1. In SillyTavern, open **Extensions → Install Extension**.
2. Paste the URL of this repository and click **Install**.
3. https://github.com/jeppsterrr/Deep-Story-Reforged

Or install manually:

```
SillyTavern/
└── public/
    └── extensions/
        └── story-tracker/
            ├── index.js
            ├── style.css
            └── manifest.json
```

Clone or copy the files into a folder named `story-tracker` inside `public/extensions/`, then reload SillyTavern.

---

## ✨ Features

### Core Scene Tracking *(Original)*
- **Scene Context Tracking** — Automatically extracts current time, date, and specific location from the narrative.
- **Day of Week** — Calculated automatically from the in-story date.
- **Temperature & Weather** — Tracks current temperature (°C / °F) and weather conditions (clear, rainy, cloudy, snowing, stormy, foggy, etc.), with matching weather icons in the HUD.
- **City & Country / Realm (optional)** — The LLM determines or invents a fitting city and country/realm based on the setting. For fantasy or sci-fi worlds it creates original names; for real-world settings it uses actual place names; for known fictional universes (Westeros, Middle-earth, etc.) it uses canonical names.
- **Character Position Log** — Keeps track of every character present in the scene and their current action or posture.
- **Outfit & Held Items Integration** — When the Inventory extension is installed, the user's equipped clothing and any items held by the AI character are appended to character lines and injected into the LLM prompt so outfits are never forgotten.
- **Recent Events Summary** — A concise LLM-generated summary of what just happened in the last few messages.
- **Context Injection** — Injects the current scene state into the Author's Note before each generation, reducing AI amnesia.
- **HUD Widget** — A compact floating overlay showing time, date, day of week, location, optional city/country, weather with icon, and up to 3 character positions with outfits.
- **Adjustable HUD** — Resize from 50% to 200% and freely drag to any screen position. Position is saved across sessions.
- **History Log** — Stores up to 20 past scene snapshots so you can review how the story evolved.
- **Character Tracker Sync** — Pushes time, date, and location data into the Character Tracker extension if active.
- **Auto-Update** — Triggers an LLM scene analysis automatically every N messages (configurable).
- **Separate Connection Profile for Analysis** — Optionally route scene analysis through a different (e.g. cheaper / faster) Connection Profile, then automatically switch back when done.

---

### 🌍 World Progression Agent *(New in 2.0.0)*

A background simulation engine that tracks what's happening *outside* the active scene. As in-story time advances, the World Agent automatically fires "ticks" to simulate offscreen events — faction movements, NPC activities, rumours, and consequences of the story's main thread.

- **Automatic Tick Scheduling** — Ticks fire automatically when enough in-story time has passed (configurable: every 1 hour, 3 hours, 1 day, or manually).
- **Max Ticks per Update** — Caps how many ticks can fire in a single update cycle to prevent overload.
- **Narrative-Aware Simulation** — The agent reads recent chat history and the past history timeline to produce offscreen events that feel organically connected to the actual story, not random global noise.
- **NPC Offscreen Tracking** — Prioritizes recently interacted NPCs and generates plausible continuations of what they do after leaving the scene.
- **Pending Reveals** — Tracks developing secrets, rumours, and foreshadowing that haven't reached the main characters yet.
- **World Summary** — Maintains a running synthesis of the overall world state outside the immediate scene, updated each tick.
- **Realistic Pacing** — Enforces realistic travel time and news propagation; the agent does not compress or rush time.
- **World Context Injection** — Optionally injects the current world state into the LLM prompt so the AI is always aware of the wider narrative.
- **Dedicated Connection Profile** — The World Agent can use a separate Connection Profile (e.g. a cheap local model) independently from the scene tracker and your main chat profile.
- **World Tab in Modal** — A dedicated tab in the Story Tracker modal shows the current world summary, recent offscreen events (with timestamps and importance ratings), active NPC states, and pending reveals. Supports manual tick triggering.

---

### 💞 Relationship Tracker *(New in 2.0.0)*

A dynamic character relationship system that analyzes the chat and maps how characters relate to one another, evolving over time as the story progresses.

- **Automatic Relationship Extraction** — After each World Agent tick (or on a configurable message interval), the tracker analyzes the last 15 messages and updates relationship data.
- **Relationship Types** — Supports: `romance`, `friendship`, `family`, `alliance`, `rivalry`, `hostile`, `mentor`, `neutral`.
- **Strength Score** — Each relationship carries a decimal strength value from -1.0 (completely hostile) to 1.0 (deeply bonded), with 0.0 being neutral.
- **Evolution Tracking** — Existing relationships are evolved rather than replaced; each update records what changed (or confirms "Stable") so you can see how dynamics shift over time.
- **Visual Relationship Graph** — An interactive graph view in the modal renders all tracked characters as nodes with color-coded, weighted edges representing their relationships. Node distance and edge thickness reflect relationship strength.
- **Relationship Context Injection** — Optionally injects the current relationship map into the LLM prompt so the AI always knows how characters feel about each other.
- **Dedicated Connection Profile** — The Relationship Tracker can use its own separate Connection Profile, independent from the scene tracker and World Agent.
- **Auto-Update Interval** — Configurable: runs every N messages (default: 5).

---

## ⚙️ Settings

Open **Extensions → Story Tracker** in the SillyTavern sidebar to access settings.

### Scene Tracker

| Setting | Description |
|---|---|
| **Enable Extension** | Master toggle for the entire extension. |
| **Show HUD Widget** | Show/hide the floating scene overlay. |
| **HUD Position** | Corner where the HUD appears (Bottom Right / Left, Top Right / Left). |
| **HUD Scale** | Resize the HUD widget (50–200%). |
| **Show Icon in Chat Panel** | Show/hide the 📖 button in the message input bar. |
| **Auto-update LLM Scene** | Automatically re-analyze the scene every N messages. |
| **Update Every N Messages** | How often the auto-update fires (1–20 messages). |
| **Inject Context into Prompt** | Inserts current scene info into the Author's Note before generation. |
| **Show City / Country** | Show city and country/realm fields (LLM infers or invents based on story setting). |
| **Use a Separate Connection Profile** | Run scene analysis on a different profile, then restore the main profile automatically. |
| **Analysis Profile** | The Connection Profile used for scene analysis. |

### World Progression Agent

| Setting | Description |
|---|---|
| **Enable World Agent** | Toggle the World Progression simulation system. |
| **Tick Frequency** | How often the World Agent fires: every 1 hour, 3 hours, 1 day of in-story time, or manually only. |
| **Max Ticks per Cycle** | Maximum number of ticks to process in a single update (prevents overload on large time jumps). |
| **Inject World Context** | Inserts the current world state into the LLM prompt. |
| **Use a Separate Connection Profile** | Run world ticks on a dedicated profile (e.g. a cheaper model). |
| **World Agent Profile** | The Connection Profile used for World Agent ticks. |

### Relationship Tracker

| Setting | Description |
|---|---|
| **Enable Relationship Tracker** | Toggle the relationship analysis system. |
| **Auto-Update** | Automatically update relationships every N messages. |
| **Update Every N Messages** | How often the relationship analysis fires (default: 5). |
| **Inject Relationship Context** | Inserts the current relationship map into the LLM prompt. |
| **Use a Separate Connection Profile** | Run relationship analysis on a dedicated profile. |
| **Relationship Profile** | The Connection Profile used for relationship analysis. |

---

## 🖥️ Interface

### Modal Window
Open by clicking the **📖 book icon** in the chat input bar or via the settings panel.

- **Current Scene tab** — Shows time, date, location, character positions, and recent events summary.
- **World Agent tab** — Shows the world summary, offscreen event log (with timestamps and importance ratings), active NPC states, and pending reveals. Includes a **Run Tick Now** button.
- **Relationships tab** — Interactive graph of all tracked character relationships with color-coded edges by type and weighted thickness by strength.
- **History / Stats tab** — A log of all past scene updates with timestamps and summaries.
- **Update Now** button — Forces an immediate LLM scene analysis.

### HUD Widget
A small floating panel that shows time, date, location, and up to 3 character positions at a glance. Click the header to collapse/expand. Click the body to open the full modal. Drag freely to reposition — the position is remembered across sessions.

---

## 🔄 Using Separate Connection Profiles

Story Tracker supports up to three independent Connection Profile assignments — one each for the Scene Tracker, World Agent, and Relationship Tracker. This lets you route each subsystem to the best model for that task.

**How it works:**
1. Install/enable the built-in **Connection Profiles** extension in SillyTavern.
2. Create profiles for each purpose (e.g. a fast cheap model for scene/relationship analysis, a stronger model for world simulation).
3. Enable the relevant profile option in the Story Tracker settings panel for each subsystem.
4. When that subsystem runs, it temporarily switches to its assigned profile, performs the LLM call, then restores your main profile automatically.

If a page reload interrupts a mid-switch, Story Tracker detects this on the next load and quietly restores your main profile, so you'll never be stuck on the wrong model.

---

## 🔗 Compatibility

| Extension | Integration |
|---|---|
| **Character Tracker** | Time, date, and location data is pushed automatically on each scene update. |
| **Inventory** | Equipped outfits and held items are pulled into character lines and injected into the LLM prompt. |
| **Translate** | Location, events, and character states can be displayed in your target language. |
| **Connection Profiles** | Optional — required only if you want to use separate profiles for scene analysis, world ticks, or relationship updates. |

---

## 📋 Requirements

- SillyTavern (recent version with extension support)
- Any LLM backend connected to SillyTavern
- *(Optional)* The built-in **Connection Profiles** extension — only needed for separate profile routing.

---

## 📜 Version History

### 2.0.0
- **Forked from [virgilianshailer](https://github.com/virgilianshailer)'s original Story Tracker** — all original features preserved.
- **NEW** Added **World Progression Agent** — a background simulation engine that tracks offscreen events, NPC movements, faction activity, and developing secrets as in-story time advances. Includes configurable tick frequency, max ticks per cycle, past history timeline integration, and a dedicated World tab in the modal.
- **NEW** Added **Relationship Tracker** — dynamic character relationship analysis with type classification, strength scoring (-1.0 to 1.0), evolution tracking across messages, and an interactive visual relationship graph. Runs automatically after world ticks or on a configurable message interval.
- Both new systems support dedicated Connection Profile assignment, context injection, and manual triggering.

### 1.1.0
- **NEW:** Added support for using a separate **Connection Profile** for scene analysis. Story Tracker can now switch to a configured profile before each analysis and automatically restore the main profile afterwards.
- **NEW:** Added an Analysis Profile dropdown in settings, with a refresh button to reload the list of available profiles.
- Added a safety net: if a page reload interrupts an analysis while a profile switch was active, the original profile is restored on the next load.

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
- Translate extension support. (No longer supported.)
- Character Tracker extension sync.

---

## 📄 License

MIT — free to use, modify, and distribute.
