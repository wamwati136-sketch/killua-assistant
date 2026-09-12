/**
 * server.js — KILLUA backend
 *
 * Endpoints:
 *   POST /api/chat          { messages }                 -> run one conversational turn
 *   POST /api/confirm-tool  { messages, decisions }       -> resolve Level 3 tool calls, continue
 *   POST /api/tts           { text }                      -> Fish Audio speech synthesis proxy
 *   GET  /api/status                                      -> health / config check
 *
 * All secrets (GROQ_API_KEY, FISH_AUDIO_API_KEY) stay server-side only.
 * The client never sees them and never talks to Groq / Fish Audio directly.
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const fetch = require('node-fetch');
const Groq = require('groq-sdk');

const { getToolDefinitions, getToolMeta, executeTool } = require('./tools');

const PORT = process.env.PORT || 3000;
const MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const MAX_ITERATIONS = 6;
const MAX_CONTEXT_CHARS = 24000; // rough char budget used for context trimming

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------
// Persona
// ---------------------------------------------------------------------

const SYSTEM_MESSAGE = {
  role: 'system',
  content: [
    'You are KILLUA — a personal AI assistant in the spirit of JARVIS, running inside a cyberpunk HUD interface.',
    '',
    'Personality: calm, precise, highly capable, and subtly witty. You are never obsequious, never over-apologize, and you do not pad answers with filler. Be concise and direct for simple requests; be structured and analytical for complex, multi-part ones.',
    '',
    'Tool honesty is absolute: never claim an action succeeded, a file was saved, a command ran, or data was fetched unless you actually called the corresponding tool and it returned a successful result. If a tool call fails, is denied by the user, or has not been executed yet, say so plainly instead of guessing.',
    '',
    'You have tools across three trust levels:',
    '  Level 1 (safe, read-only): calculator, weather, web search, note_read, note_list — run automatically.',
    '  Level 2 (modifies user data): note_write, note_delete — run automatically, but the user is shown a notice that data changed.',
    '  Level 3 (high impact / irreversible): delete_file, run_shell_command — these ALWAYS require the user to explicitly authorize them through a confirmation prompt before they execute. Call the tool normally; the system handles asking the user. If the user denies authorization, respect that and do not try to route around it.',
    '',
    'Prefer calling a tool over guessing at live facts, current weather, unverified math, or anything time-sensitive.',
    '',
    'Your replies are often read aloud by a text-to-speech voice, so write in natural spoken sentences. Avoid heavy markdown, bullet-point spam, or code blocks unless the user is specifically asking for code or a structured list.',
  ].join('\n'),
};

// ---------------------------------------------------------------------
// Context management
// ---------------------------------------------------------------------

/** Group a flat message list into "turns": a user message plus everything until the next user message. */
function groupIntoTurns(messages) {
  const turns = [];
  let current = [];
  for (const m of messages) {
    if (m.role === 'user') {
      if (current.length) turns.push(current);
      current = [m];
    } else {
      current.push(m);
    }
  }
  if (current.length) turns.push(current);
  return turns;
}

/**
 * Trim conversation history to fit a rough character budget while always
 * keeping whole turns intact (never splitting an assistant tool_calls
 * message from its tool result messages, which the API would reject).
 */
function trimMessages(messages) {
  const nonSystem = messages.filter((m) => m.role !== 'system');
  const turns = groupIntoTurns(nonSystem);

  const kept = [];
  let size = JSON.stringify(SYSTEM_MESSAGE).length;

  for (let i = turns.length - 1; i >= 0; i--) {
    const turnSize = JSON.stringify(turns[i]).length;
    if (size + turnSize > MAX_CONTEXT_CHARS && kept.length > 0) break;
    kept.unshift(turns[i]);
    size += turnSize;
  }

  return [SYSTEM_MESSAGE, ...kept.flat()];
}

function safeParseJSON(str) {
  try {
    return JSON.parse(str || '{}');
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------
// Conversation engine
// ---------------------------------------------------------------------

/**
 * Runs the tool-calling loop against Groq until the model produces a
 * final answer, hits a Level 3 tool that needs confirmation, or hits
 * MAX_ITERATIONS. Always returns the full updated `messages` array so
 * the caller (client) can persist it and send it back on the next turn.
 */
async function runConversation(initialMessages) {
  let messages = trimMessages(initialMessages);
  const toolLog = [];
  let lastUsage = null;

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const startedAt = Date.now();

    const completion = await groq.chat.completions.create({
      model: MODEL,
      messages,
      tools: getToolDefinitions(),
      tool_choice: 'auto',
      temperature: 0.5,
      max_tokens: 1024,
    });

    const latencyMs = Date.now() - startedAt;
    lastUsage = { ...completion.usage, latencyMs };

    const choice = completion.choices[0];
    const assistantMessage = choice.message;
    messages = messages.concat([assistantMessage]);

    const toolCalls = assistantMessage.tool_calls;
    if (!toolCalls || toolCalls.length === 0) {
      return {
        status: 'complete',
        reply: assistantMessage.content || '',
        messages,
        toolLog,
        usage: lastUsage,
      };
    }

    const pending = [];
    const autoCalls = [];
    for (const call of toolCalls) {
      const meta = getToolMeta(call.function.name);
      if (meta && meta.hardConfirm) {
        pending.push(call);
      } else {
        autoCalls.push(call);
      }
    }

    // Execute Level 1 / Level 2 calls immediately.
    for (const call of autoCalls) {
      const args = safeParseJSON(call.function.arguments);
      const result = await executeTool(call.function.name, args);
      const meta = getToolMeta(call.function.name);
      toolLog.push({
        id: call.id,
        name: call.function.name,
        args,
        level: meta?.level ?? null,
        softConfirm: Boolean(meta?.softConfirm),
        ok: result.ok !== false,
      });
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
    }

    // If any Level 3 calls are waiting, stop here and hand control to the client.
    if (pending.length > 0) {
      return {
        status: 'confirmation_required',
        pendingToolCalls: pending.map((c) => ({
          id: c.id,
          name: c.function.name,
          arguments: safeParseJSON(c.function.arguments),
        })),
        messages,
        toolLog,
        usage: lastUsage,
      };
    }

    // Otherwise loop again so the model can react to the tool results.
  }

  return {
    status: 'complete',
    reply:
      "I've hit my reasoning-loop limit for this turn without reaching a final answer — could you simplify or split up the request?",
    messages,
    toolLog,
    usage: lastUsage,
  };
}

// ---------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------

app.post('/api/chat', async (req, res) => {
  const { messages } = req.body || {};

  if (!Array.isArray(messages)) {
    return res.status(400).json({ error: 'Request body must include a "messages" array.' });
  }
  if (!process.env.GROQ_API_KEY) {
    return res.status(503).json({ error: 'GROQ_API_KEY is not configured on the server.' });
  }

  try {
    const outcome = await runConversation(messages);
    res.json(outcome);
  } catch (err) {
    console.error('[api/chat]', err);
    res.status(500).json({ error: err.message || 'Internal error while contacting the AI core.' });
  }
});

app.post('/api/confirm-tool', async (req, res) => {
  const { messages, decisions } = req.body || {};

  if (!Array.isArray(messages)) {
    return res.status(400).json({ error: 'Request body must include a "messages" array.' });
  }

  const lastAssistantWithCalls = [...messages].reverse().find((m) => m.role === 'assistant' && m.tool_calls?.length);
  if (!lastAssistantWithCalls) {
    return res.status(400).json({ error: 'No pending tool calls were found in the supplied message history.' });
  }

  const resolvedIds = new Set(messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id));
  const unresolved = lastAssistantWithCalls.tool_calls.filter((c) => !resolvedIds.has(c.id));

  if (unresolved.length === 0) {
    return res.status(400).json({ error: 'All tool calls in this turn are already resolved.' });
  }

  const updated = [...messages];
  const toolLog = [];

  for (const call of unresolved) {
    const approved = Boolean(decisions?.[call.id]);
    const meta = getToolMeta(call.function.name);
    let result;

    if (approved) {
      const args = safeParseJSON(call.function.arguments);
      result = await executeTool(call.function.name, args);
    } else {
      result = { ok: false, denied: true, error: 'User denied authorization for this action.' };
    }

    toolLog.push({
      id: call.id,
      name: call.function.name,
      level: meta?.level ?? null,
      approved,
      ok: result.ok !== false,
    });

    updated.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
  }

  try {
    const outcome = await runConversation(updated);
    outcome.toolLog = [...toolLog, ...(outcome.toolLog || [])];
    res.json(outcome);
  } catch (err) {
    console.error('[api/confirm-tool]', err);
    res.status(500).json({ error: err.message || 'Internal error while contacting the AI core.' });
  }
});

app.post('/api/tts', async (req, res) => {
  const { text } = req.body || {};

  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'Request body must include non-empty "text".' });
  }
  if (!process.env.FISH_AUDIO_API_KEY || !process.env.FISH_AUDIO_VOICE_ID) {
    return res.status(503).json({ error: 'Fish Audio is not configured on the server.' });
  }

  try {
    const fishResponse = await fetch('https://api.fish.audio/v1/tts', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.FISH_AUDIO_API_KEY}`,
        'Content-Type': 'application/json',
        model: process.env.FISH_AUDIO_MODEL || 's2.1-pro',
      },
      body: JSON.stringify({
        text: text.slice(0, 2000),
        reference_id: process.env.FISH_AUDIO_VOICE_ID,
        format: 'mp3',
      }),
    });

    if (!fishResponse.ok) {
      const errText = await fishResponse.text();
      return res.status(fishResponse.status).json({ error: `Fish Audio error: ${errText.slice(0, 300)}` });
    }

    const buffer = Buffer.from(await fishResponse.arrayBuffer());
    res.set('Content-Type', 'audio/mpeg');
    res.send(buffer);
  } catch (err) {
    console.error('[api/tts]', err);
    res.status(500).json({ error: err.message || 'Internal error while contacting Fish Audio.' });
  }
});

app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    assistant: 'KILLUA',
    model: MODEL,
    groqConfigured: Boolean(process.env.GROQ_API_KEY),
    fishAudioConfigured: Boolean(process.env.FISH_AUDIO_API_KEY && process.env.FISH_AUDIO_VOICE_ID),
    systemExecEnabled: process.env.ALLOW_SYSTEM_EXEC === 'true',
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

app.use((err, req, res, next) => {
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'Unexpected server error.' });
});

app.listen(PORT, () => {
  console.log(`\n  KILLUA online — http://localhost:${PORT}\n`);
  if (!process.env.GROQ_API_KEY) {
    console.warn('  WARNING: GROQ_API_KEY is not set. /api/chat will fail until it is.');
  }
  if (!process.env.FISH_AUDIO_API_KEY || !process.env.FISH_AUDIO_VOICE_ID) {
    console.warn('  WARNING: Fish Audio is not fully configured. /api/tts will fail until it is.');
  }
});
