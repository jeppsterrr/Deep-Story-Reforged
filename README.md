# 📖 Story Tracker — SillyTavern Extension

A SillyTavern extension that automatically tracks **time, date, location, character positions, and recent events** in your roleplay. It uses the LLM to analyze the chat and maintain narrative consistency, reducing character amnesia between messages.

---

## ✨ Features

- **Scene Context Tracking** — Automatically extracts current time, date, and location from the narrative.
- **Character Position Log** — Keeps track of every character in the scene and their current action or posture.
- **Recent Events Summary** — A concise LLM-generated summary of what just happened in the last few messages.
- **Context Injection** — Injects the current scene state into the Author's Note before each generation, reducing AI amnesia.
- **HUD Widget** — A compact floating overlay that displays the current scene at a glance without opening the full panel.
- **History Log** — Stores up to 20 past scene snapshots so you can review how the story evolved.
- **Translation Support** — Integrates with the SillyTavern Translate extension to display data in your target language while keeping original text for LLM prompts.
- **Character Tracker Sync** — Pushes time and location data into the Character Tracker extension if it is active.
- **Auto-Update** — Triggers an LLM scene analysis automatically every N messages (configurable).

---

## 📦 Installation

1. In SillyTavern, open **Extensions → Install Extension**.
2. Paste the URL of this repository and click **Install**.

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

## ⚙️ Settings

Open **Extensions → Story Tracker** in the SillyTavern sidebar to access settings.

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

---

## 🖥️ Interface

### Modal Window
Open by clicking the **📖 book icon** in the chat input bar or via the settings panel.

- **Current Scene tab** — Shows time, date, location, character positions, and a recent events summary.
- **History / Stats tab** — A log of all past scene updates with timestamps and summaries.
- **Update Now** button — Forces an immediate LLM scene analysis.
- **Translate** button — Toggles translation of displayed data (requires the Translate extension).

### HUD Widget
A small floating panel that shows time, date, location, and up to 3 character positions at a glance. Click the header to collapse/expand it. Click the body to open the full modal.

---

## 🔗 Compatibility

| Extension | Integration |
|---|---|
| **Character Tracker** | Time and location data is pushed automatically on each update. |
| **Translate** | Location, events, and character states can be displayed in your target language. |

---

## 📋 Requirements

- SillyTavern (recent version with extension support)
- Any LLM backend connected to SillyTavern

---

## 📄 License

MIT — free to use, modify, and distribute.
