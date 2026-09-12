/**
 * public/app.js — KILLUA client
 *
 * No API keys live here. Every AI / TTS call goes through this app's
 * own backend (/api/chat, /api/confirm-tool, /api/tts, /api/status).
 */

(() => {
  'use strict';

  // ---------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------

  const STATES = ['idle', 'listening', 'thinking', 'speaking', 'error'];
  const CONTEXT_CHAR_BUDGET = 24000; // mirrors server.js MAX_CONTEXT_CHARS, for the Power/Core Load gauge
  const STATUS_POLL_MS = 15000;

  // ---------------------------------------------------------------
  // DOM refs
  // ---------------------------------------------------------------

  const $ = (id) => document.getElementById(id);

  const el = {
    body: document.body,
    orbButton: $('orbButton'),
    orbStateLabel: $('orbStateLabel'),
    liveCaption: $('liveCaption'),
    responseText: $('responseText'),
    micButton: $('micButton'),
    textInput: $('textInput'),
    sendButton: $('sendButton'),
    chatToggle: $('chatToggle'),
    chatDrawer: $('chatDrawer'),
    closeChat: $('closeChat'),
    chatMessages: $('chatMessages'),
    confirmModal: $('confirmModal'),
    modalToolList: $('modalToolList'),
    modalApprove: $('modalApprove'),
    modalDeny: $('modalDeny'),
    toast: $('toast'),
    connDot: $('connDot'),
    connLabel: $('connLabel'),
    execBadge: $('execBadge'),
    powerValue: $('powerValue'),
    powerBarFill: $('powerBarFill'),
    speedValue: $('speedValue'),
    tokenRateNote: $('tokenRateNote'),
    dotGroq: $('dotGroq'),
    dotFish: $('dotFish'),
    dotExec: $('dotExec'),
    statusNote: $('statusNote'),
    visualizerCanvas: $('visualizer'),
  };

  // ---------------------------------------------------------------
  // State engine
  // ---------------------------------------------------------------

  const app = {
    state: 'idle',
    conversation: [],       // full message history (mirrors server's `messages`)
    isListening: false,
    recognition: null,
    micAnalyser: null,
    micStream: null,
    ttsAnalyser: null,
    ttsAudio: null,
    audioCtx: null,
    fishAudioConfigured: false,
  };

  function setState(next) {
    if (!STATES.includes(next)) return;
    app.state = next;
    STATES.forEach((s) => el.body.classList.toggle(`state-${s}`, s === next));
    el.orbStateLabel.textContent = next.toUpperCase();
  }

  // ---------------------------------------------------------------
  // Toast
  // ---------------------------------------------------------------

  let toastTimer = null;
  function showToast(message, variant = 'info') {
    el.toast.textContent = message;
    el.toast.className = `toast${variant === 'warn' ? ' warn' : ''}`;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, 3800);
  }

  // ---------------------------------------------------------------
  // Chat drawer rendering
  // ---------------------------------------------------------------

  function addBubble(role, text, opts = {}) {
    const bubble = document.createElement('div');
    bubble.className = `chat-bubble ${role}${opts.denied ? ' denied' : ''}`;
    bubble.textContent = text;
    el.chatMessages.appendChild(bubble);
    el.chatMessages.scrollTop = el.chatMessages.scrollHeight;
  }

  function renderToolLog(toolLog) {
    for (const entry of toolLog || []) {
      const statusWord = entry.ok ? 'ok' : (entry.approved === false ? 'denied' : 'failed');
      addBubble('tool', `[L${entry.level ?? '?'}] ${entry.name} → ${statusWord}`, { denied: statusWord !== 'ok' });
      if (entry.softConfirm && entry.ok) {
        showToast(`Data updated by ${entry.name}`);
      }
    }
  }

  function openDrawer() {
    el.chatDrawer.classList.add('open');
    el.chatDrawer.setAttribute('aria-hidden', 'false');
  }
  function closeDrawer() {
    el.chatDrawer.classList.remove('open');
    el.chatDrawer.setAttribute('aria-hidden', 'true');
  }

  // ---------------------------------------------------------------
  // HUD stat cards
  // ---------------------------------------------------------------

  function updatePowerCard() {
    const size = JSON.stringify(app.conversation).length;
    const pct = Math.min(100, Math.round((size / CONTEXT_CHAR_BUDGET) * 100));
    el.powerValue.textContent = pct;
    el.powerBarFill.style.width = `${pct}%`;
  }

  function updateSpeedCard(usage) {
    if (!usage) return;
    el.speedValue.textContent = usage.latencyMs ?? '—';
    if (usage.completion_tokens && usage.latencyMs) {
      const tps = (usage.completion_tokens / (usage.latencyMs / 1000)).toFixed(1);
      el.tokenRateNote.textContent = `${tps} tok/s · ${usage.completion_tokens} tokens generated`;
    } else {
      el.tokenRateNote.textContent = 'Awaiting token metrics';
    }
  }

  async function refreshStatus() {
    try {
      const res = await fetch('/api/status');
      const data = await res.json();

      el.connDot.className = `conn-dot ${data.groqConfigured ? 'ok' : 'bad'}`;
      el.connLabel.textContent = data.groqConfigured ? 'ONLINE' : 'AI CORE OFFLINE';

      el.dotGroq.className = `dot ${data.groqConfigured ? 'ok' : 'bad'}`;
      el.dotFish.className = `dot ${data.fishAudioConfigured ? 'ok' : 'bad'}`;
      el.dotExec.className = `dot ${data.systemExecEnabled ? 'warn' : 'ok'}`;

      app.fishAudioConfigured = data.fishAudioConfigured;
      el.execBadge.hidden = !data.systemExecEnabled;

      el.statusNote.textContent = data.systemExecEnabled
        ? 'System execution is armed on this server.'
        : data.fishAudioConfigured
          ? 'All systems nominal.'
          : 'Voice output not configured — text-only mode.';
    } catch (err) {
      el.connDot.className = 'conn-dot bad';
      el.connLabel.textContent = 'UNREACHABLE';
      el.statusNote.textContent = 'Could not reach the KILLUA backend.';
    }
  }

  // ---------------------------------------------------------------
  // Canvas visualizer
  // ---------------------------------------------------------------

  const canvas = el.visualizerCanvas;
  const ctx = canvas.getContext('2d');
  let dpr = window.devicePixelRatio || 1;

  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
  }
  window.addEventListener('resize', resizeCanvas);

  function currentAnalyserData() {
    const analyser = app.state === 'listening' ? app.micAnalyser
      : app.state === 'speaking' ? app.ttsAnalyser
      : null;
    if (!analyser) return null;
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);
    return data;
  }

  function drawVisualizer(t) {
    requestAnimationFrame(drawVisualizer);
    if (!canvas.width || !canvas.height) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const baseRadius = Math.min(canvas.width, canvas.height) * 0.22;
    const bars = 64;

    const color = app.state === 'listening' || app.state === 'error' ? '#ff2a75' : '#d946ef';
    const data = currentAnalyserData();

    ctx.save();
    ctx.translate(cx, cy);

    for (let i = 0; i < bars; i++) {
      const angle = (i / bars) * Math.PI * 2;
      let amp;

      if (data) {
        amp = data[Math.floor((i / bars) * data.length)] / 255;
      } else if (app.state === 'thinking') {
        amp = 0.25 + 0.2 * Math.sin(t / 220 + i * 0.6) + 0.15 * Math.sin(t / 90 - i);
      } else {
        amp = 0.12 + 0.05 * Math.sin(t / 900 + i);
      }
      amp = Math.max(0.05, Math.min(1, amp));

      const len = baseRadius * 0.35 * amp * dpr * 1.4;
      const r1 = baseRadius * dpr;
      const r2 = r1 + len;

      const x1 = Math.cos(angle) * r1;
      const y1 = Math.sin(angle) * r1;
      const x2 = Math.cos(angle) * r2;
      const y2 = Math.sin(angle) * r2;

      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.35 + amp * 0.5;
      ctx.lineWidth = 2 * dpr;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }

    ctx.restore();
  }

  // ---------------------------------------------------------------
  // Speech recognition (STT) — Web Speech API
  // ---------------------------------------------------------------

  const SpeechRecognitionImpl = window.SpeechRecognition || window.webkitSpeechRecognition;

  function setupRecognition() {
    if (!SpeechRecognitionImpl) return null;
    const recognition = new SpeechRecognitionImpl();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onresult = (event) => {
      let interim = '';
      let final = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) final += transcript;
        else interim += transcript;
      }
      el.liveCaption.textContent = final || interim;
      if (final.trim()) {
        stopListening();
        handleUserInput(final.trim());
      }
    };

    recognition.onerror = (event) => {
      if (event.error === 'no-speech' || event.error === 'aborted') {
        stopListening();
        return;
      }
      showToast(`Mic error: ${event.error}`, 'warn');
      stopListening();
      setState('error');
      setTimeout(() => setState('idle'), 1400);
    };

    recognition.onend = () => {
      if (app.isListening) stopListening();
    };

    return recognition;
  }

  async function startListening() {
    if (app.state !== 'idle') return;
    if (!SpeechRecognitionImpl) {
      showToast('Speech recognition is not supported in this browser — try typing instead.', 'warn');
      return;
    }

    app.isListening = true;
    setState('listening');
    el.micButton.classList.add('active');
    el.liveCaption.textContent = 'Listening…';

    // Best-effort mic amplitude analyser purely for the visualizer.
    try {
      app.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      ensureAudioContext();
      const source = app.audioCtx.createMediaStreamSource(app.micStream);
      app.micAnalyser = app.audioCtx.createAnalyser();
      app.micAnalyser.fftSize = 128;
      source.connect(app.micAnalyser);
    } catch {
      app.micAnalyser = null; // visualizer falls back to a generic pulse
    }

    app.recognition = app.recognition || setupRecognition();
    try {
      app.recognition.start();
    } catch {
      /* already started — ignore */
    }
  }

  function stopListening() {
    app.isListening = false;
    el.micButton.classList.remove('active');
    el.liveCaption.textContent = '';
    if (app.recognition) {
      try { app.recognition.stop(); } catch { /* noop */ }
    }
    if (app.micStream) {
      app.micStream.getTracks().forEach((t) => t.stop());
      app.micStream = null;
    }
    app.micAnalyser = null;
    if (app.state === 'listening') setState('idle');
  }

  // ---------------------------------------------------------------
  // Text-to-speech playback (Fish Audio via /api/tts)
  // ---------------------------------------------------------------

  function ensureAudioContext() {
    if (!app.audioCtx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      app.audioCtx = new AudioCtx();
    }
    if (app.audioCtx.state === 'suspended') app.audioCtx.resume();
  }

  async function speak(text) {
    if (!app.fishAudioConfigured || !text) {
      setState('idle');
      return;
    }

    setState('speaking');
    try {
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error(`TTS failed (${res.status})`);

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      app.ttsAudio = audio;

      ensureAudioContext();
      const source = app.audioCtx.createMediaElementSource(audio);
      app.ttsAnalyser = app.audioCtx.createAnalyser();
      app.ttsAnalyser.fftSize = 128;
      source.connect(app.ttsAnalyser);
      app.ttsAnalyser.connect(app.audioCtx.destination);

      await new Promise((resolve) => {
        audio.onended = resolve;
        audio.onerror = resolve;
        audio.play().catch(resolve);
      });

      URL.revokeObjectURL(url);
    } catch (err) {
      showToast('Voice output unavailable — showing text only.', 'warn');
    } finally {
      app.ttsAnalyser = null;
      setState('idle');
    }
  }

  // ---------------------------------------------------------------
  // Confirmation modal (Level 3 tools)
  // ---------------------------------------------------------------

  function describeArgs(args) {
    try {
      return JSON.stringify(args, null, 2);
    } catch {
      return String(args);
    }
  }

  function openConfirmModal(pendingToolCalls) {
    el.modalToolList.innerHTML = '';
    for (const call of pendingToolCalls) {
      const item = document.createElement('div');
      item.className = 'modal-tool-item';
      item.innerHTML = `<span class="tool-name">${call.name}</span><pre>${describeArgs(call.arguments)}</pre>`;
      el.modalToolList.appendChild(item);
    }
    el.confirmModal.hidden = false;
  }
  function closeConfirmModal() {
    el.confirmModal.hidden = true;
  }

  function waitForConfirmDecision() {
    return new Promise((resolve) => {
      const onApprove = () => { cleanup(); resolve(true); };
      const onDeny = () => { cleanup(); resolve(false); };
      function cleanup() {
        el.modalApprove.removeEventListener('click', onApprove);
        el.modalDeny.removeEventListener('click', onDeny);
        closeConfirmModal();
      }
      el.modalApprove.addEventListener('click', onApprove);
      el.modalDeny.addEventListener('click', onDeny);
    });
  }

  // ---------------------------------------------------------------
  // API calls
  // ---------------------------------------------------------------

  async function postJSON(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request to ${url} failed (${res.status})`);
    return data;
  }

  // ---------------------------------------------------------------
  // Main pipeline
  // ---------------------------------------------------------------

  async function handleUserInput(text) {
    if (!text) return;

    app.conversation.push({ role: 'user', content: text });
    addBubble('user', text);
    updatePowerCard();
    setState('thinking');

    try {
      const outcome = await postJSON('/api/chat', { messages: app.conversation });
      await handleOutcome(outcome);
    } catch (err) {
      console.error(err);
      showToast(err.message, 'warn');
      el.responseText.textContent = `Error: ${err.message}`;
      setState('error');
      setTimeout(() => setState('idle'), 1500);
    }
  }

  async function handleOutcome(outcome) {
    app.conversation = outcome.messages || app.conversation;
    updatePowerCard();
    updateSpeedCard(outcome.usage);
    renderToolLog(outcome.toolLog);

    if (outcome.status === 'confirmation_required') {
      openConfirmModal(outcome.pendingToolCalls);
      const approved = await waitForConfirmDecision();

      const decisions = {};
      for (const call of outcome.pendingToolCalls) decisions[call.id] = approved;

      setState('thinking');
      try {
        const followUp = await postJSON('/api/confirm-tool', {
          messages: app.conversation,
          decisions,
        });
        await handleOutcome(followUp);
      } catch (err) {
        console.error(err);
        showToast(err.message, 'warn');
        setState('error');
        setTimeout(() => setState('idle'), 1500);
      }
      return;
    }

    // status === 'complete'
    el.responseText.textContent = outcome.reply || '(no response text)';
    addBubble('assistant', outcome.reply || '(no response text)');
    await speak(outcome.reply || '');
  }

  // ---------------------------------------------------------------
  // Event wiring
  // ---------------------------------------------------------------

  el.orbButton.addEventListener('click', () => {
    if (app.isListening) stopListening();
    else if (app.state === 'idle') startListening();
  });

  el.micButton.addEventListener('click', () => {
    if (app.isListening) stopListening();
    else if (app.state === 'idle') startListening();
  });

  el.sendButton.addEventListener('click', () => {
    const text = el.textInput.value.trim();
    if (!text) return;
    el.textInput.value = '';
    if (app.state === 'idle') handleUserInput(text);
  });

  el.textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') el.sendButton.click();
  });

  el.chatToggle.addEventListener('click', openDrawer);
  el.closeChat.addEventListener('click', closeDrawer);

  // ---------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------

  function boot() {
    resizeCanvas();
    requestAnimationFrame(drawVisualizer);
    refreshStatus();
    setInterval(refreshStatus, STATUS_POLL_MS);
    setState('idle');

    if (!SpeechRecognitionImpl) {
      showToast('Voice input not supported in this browser — text chat still works.', 'warn');
    }
  }

  boot();
})();
