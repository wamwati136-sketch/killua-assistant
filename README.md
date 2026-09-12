# KILLUA

A JARVIS-inspired personal AI assistant with a cyberpunk HUD interface, built on Groq's `llama-3.3-70b-versatile` with native tool calling, and Fish Audio for voice output.

```
┌─────────────────────────────────────────────────────────────┐
│  Browser (public/)                                           │
│   index.html + styles.css   → HUD: orb, stat cards, drawer   │
│   app.js                    → state machine, mic (Web Speech │
│                                API), canvas visualizer,       │
│                                TTS playback, modal handling   │
└───────────────┬───────────────────────────────────────────────┘
                │  fetch()  /api/chat  /api/confirm-tool  /api/tts  /api/status
┌───────────────▼───────────────────────────────────────────────┐
│  Node / Express (server.js)                                   │
│   - Owns GROQ_API_KEY and FISH_AUDIO_API_KEY (never sent       │
│     to the browser)                                            │
│   - Runs the tool-calling loop against Groq                    │
│   - Gates Level 3 tools behind explicit confirmation            │
│   - Proxies Fish Audio TTS                                      │
└───────────────┬───────────────────────────────────────────────┘
                │
┌───────────────▼───────────────────────────────────────────────┐
│  tools/  (modular, level-tagged)                               │
│   calculator.js   Level 1 — safe expression evaluator           │
│   weather.js      Level 1 — Open-Meteo (no key needed)          │
│   webSearch.js    Level 1 — DuckDuckGo Instant Answer            │
│   system.js       Level 2 — note_read/list/write/delete          │
│                   Level 3 — delete_file, run_shell_command       │
└─────────────────────────────────────────────────────────────┘
```

## 1. Requirements

- Node.js 18 or newer (native `fetch` + modern JS; `node-fetch` is used explicitly per the project spec, but Node 18+ isn't strictly required for that reason alone).
- A [Groq API key](https://console.groq.com/keys) — free tier is enough to run this.
- Optionally, a [Fish Audio](https://fish.audio) API key + a reference voice ID, if you want spoken responses. Without it, KILLUA works fine in text-only mode.
- A Chromium-based browser (Chrome, Edge, Brave) for microphone input — the Web Speech API's `SpeechRecognition` isn't implemented in Firefox or Safari. Typing still works everywhere.

## 2. Install

```bash
git clone <this-repo>   # or unzip the delivered archive
cd killua-assistant
npm install
cp .env.example .env
```

Now edit `.env`:

```
PORT=3000
GROQ_API_KEY=gsk_your_real_key
GROQ_MODEL=llama-3.3-70b-versatile

FISH_AUDIO_API_KEY=your_fish_audio_key       # optional
FISH_AUDIO_VOICE_ID=your_reference_voice_id  # optional
FISH_AUDIO_MODEL=s2.1-pro                    # optional, defaults shown

ALLOW_SYSTEM_EXEC=false                      # see "Level 3 tools" below
WORKSPACE_DIR=./workspace
```

## 3. Run

```bash
npm start          # production
npm run dev        # auto-restart on file changes (node --watch)
```

Then open **http://localhost:3000**.

Click the central core to talk, or type into the dock at the bottom. Click **LOG** to open the conversation drawer and see every message and tool call KILLUA has made.

## 4. Tool trust levels

| Level | Examples | Behavior |
|---|---|---|
| **1 — Safe** | `calculate`, `get_weather`, `web_search`, `note_read`, `note_list` | Executed immediately, no confirmation. |
| **2 — User data** | `note_write`, `note_delete` | Executed immediately, but the UI shows a non-blocking toast ("Data updated by note_write") so you always know when your notes changed. |
| **3 — Important / irreversible** | `delete_file`, `run_shell_command` | **Never** executed automatically. The backend pauses the conversation and returns a `confirmation_required` response; the frontend shows a modal listing the exact tool name and arguments; the tool only runs if you click **Authorize**. If you click **Deny**, KILLUA is told the action was refused and continues without pretending it happened. |

`run_shell_command` is additionally hard-disabled unless you set `ALLOW_SYSTEM_EXEC=true` in `.env` — leave it `false` unless you specifically want KILLUA to be able to run commands on this machine. `delete_file` (and all of the note tools) are sandboxed to the `WORKSPACE_DIR` folder; path traversal outside of it (e.g. `../../etc/passwd`) is rejected in code regardless of what the model asks for.

## 5. How the tool-calling loop works

1. Client sends the full conversation (`messages`) to `POST /api/chat`.
2. The server calls Groq with the tool schemas from `tools/index.js` and `tool_choice: "auto"`.
3. If the model requests tools:
   - Level 1/2 calls are executed immediately; their results are appended as `role: "tool"` messages and the loop calls Groq again so it can react to them.
   - Any Level 3 call stops the loop and the response comes back as `{ status: "confirmation_required", pendingToolCalls, messages }`.
4. The client shows the modal. Your decision is posted to `POST /api/confirm-tool` along with the same `messages` array; the server executes (or records the denial for) each pending call and resumes the loop.
5. Once the model returns a plain answer with no further tool calls, the server responds `{ status: "complete", reply, messages, usage }`. The client renders the text, speaks it via `/api/tts` if Fish Audio is configured, and stores `messages` as the new conversation state for the next turn.

This keeps the server itself stateless — all history lives in the browser and is round-tripped on every request — while still being able to pause mid-turn for authorization.

## 6. Context management

`server.js` groups the conversation into "turns" (a user message plus everything up to the next user message) and keeps whole turns, most-recent-first, until a ~24,000-character budget is hit. It never splits an assistant's `tool_calls` message from its `tool` result messages, which the Groq/OpenAI-style API would otherwise reject. The **Core Load** card in the HUD mirrors this same budget so you can see your context usage in real time.

## 7. State engine

`app.js` drives a small state machine — `idle → listening → thinking → speaking`, with `error` as an interrupt state — that:
- Switches CSS classes on `<body>` to recolor/re-animate the orb and rings.
- Feeds the canvas visualizer: real microphone amplitude while listening, real TTS playback amplitude while speaking (both via `AnalyserNode`), and a synthetic idle/thinking animation otherwise.
- Updates the orb's text label and the live caption line.

## 8. Extending

- **Better web search**: `tools/webSearch.js` uses DuckDuckGo's free Instant Answer API, which is limited. Swap the `fetch` call for Tavily, Serper, or Bing Search — keep the same `definition` and return shape (`{ ok, query, summary, results }`) and nothing else needs to change.
- **New tools**: add a file under `tools/`, export `{ level, definition, execute, softConfirm?, hardConfirm? }` (or an array of such objects, as `system.js` does), then register it in `tools/index.js`.
- **Wake word / always-listening**: the current mic flow is push-to-talk via the orb/mic button. `SpeechRecognition` can be set to `continuous = true` with a keyword-spotting check in `onresult` if you want hands-free activation — this was left out deliberately to avoid the browser mic staying hot by default.

## 9. Security notes

- All API keys live only in `.env` on the server; `server.js` is the only thing that ever calls Groq or Fish Audio.
- `tools/calculator.js` never uses `eval`/`new Function` — it's a hand-written tokenizer + recursive-descent parser restricted to arithmetic and an allow-list of math functions.
- File tools are confined to `WORKSPACE_DIR`; traversal outside it is rejected in code.
- `run_shell_command` is opt-in (`ALLOW_SYSTEM_EXEC`) and still requires per-call user authorization even when enabled. Only enable it on a machine (or disposable VM/container) where you're comfortable with an LLM having command-line access.
- KILLUA's system prompt explicitly instructs it never to claim an action succeeded unless the corresponding tool actually returned success — denied or failed Level 3 calls are reported back to the model as failures, not silently ignored.

## 10. File map

```
killua-assistant/
├── .env.example
├── .gitignore
├── package.json
├── server.js
├── README.md
├── tools/
│   ├── index.js         # registry: definitions, level lookup, executor
│   ├── calculator.js     # Level 1
│   ├── weather.js        # Level 1
│   ├── webSearch.js       # Level 1
│   └── system.js          # Level 2 (notes) + Level 3 (delete/exec)
├── public/
│   ├── index.html
│   ├── styles.css
│   └── app.js
└── workspace/
    └── notes/            # sandbox root for note + file tools
```
