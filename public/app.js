/* ═══════════════════════════════════════════════════════════
   MyAI v2 — Main App JS
   Chat, sidebar, tabs, settings, file management
   Pure vanilla ES6+
   ═══════════════════════════════════════════════════════════ */

// ── State ────────────────────────────────────────────────────
let currentChatId = null;
let chatHistory = [];  // { role, content, images?, files? }
let attachedFiles = []; // { name, base64?, path?, type }
let models = [];
let isStreaming = false;
let ragModeEnabled = false;
let userLocation = '';

// ── DOM refs ─────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const chatMessages = $('#chat-messages');
const emptyState = $('#empty-state');
const chatForm = $('#chat-form');
const chatInput = $('#chat-input');
const chatSendBtn = $('#chat-send-btn');
const modelSelect = $('#model-select');
const statusBar = $('#status-bar');
const attachedFilesEl = $('#attached-files');
const chatFileInput = $('#chat-file-input');
const chatAttachBtn = $('#chat-attach-btn');
const chatList = $('#chat-list');
const newChatBtn = $('#new-chat-btn');

// ── Init ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Configure marked + KaTeX once at startup (must be before any rendering)
  if (typeof marked !== 'undefined') {
    marked.setOptions({
      highlight: function(code, lang) {
        if (typeof hljs !== 'undefined' && hljs.getLanguage(lang)) {
          return hljs.highlight(code, { language: lang }).value;
        }
        return code;
      },
      breaks: false // Critical: prevents line breaks from destroying math alignment
    });
    if (typeof markedKatex !== 'undefined') {
      marked.use(markedKatex({ throwOnError: false }));
    }
  }

  initTabs();
  initModelPicker();
  loadChatList();
  expPreload();
  initSettings();
  initChatInput();
  initVoice();
  initRAGMode();
  initFileAttach();
  initEditor();
  initTaskbar();
  initThemeToggle();
  speechSynthesis.getVoices();
});

// ── Theme toggle ─────────────────────────────────────────────
function initThemeToggle() {
  const btn = $('#theme-toggle');
  // Restore saved preference
  if (localStorage.getItem('myai-theme') === 'light') {
    document.documentElement.classList.add('light');
    btn.textContent = '\u{1F319}'; // moon
  }
  btn.addEventListener('click', () => {
    const isLight = document.documentElement.classList.toggle('light');
    btn.textContent = isLight ? '\u{1F319}' : '\u2606'; // moon or sun
    localStorage.setItem('myai-theme', isLight ? 'light' : 'dark');
  });
}

// ── Tab switching ────────────────────────────────────────────
function initTabs() {
  $$('#top-tabs .tab').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('#top-tabs .tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      $$('.tab-panel').forEach(p => p.classList.remove('active'));
      $(`#tab-${btn.dataset.tab}`).classList.add('active');
    });
  });
}

// ── Model picker ─────────────────────────────────────────────
async function initModelPicker() {
  try {
    const res = await fetch('/api/tags');
    const data = await res.json();
    models = data.models || [];
    populateModelSelect(modelSelect, models);
    updateInstalledModels(models);
  } catch (err) {
    console.error('Failed to load models:', err);
  }
  modelSelect.addEventListener('change', () => {
    localStorage.setItem('lastModel', modelSelect.value);
  });
}

function populateModelSelect(select, models) {
  const saved = localStorage.getItem('lastModel');
  select.innerHTML = '';
  models.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m.name;
    opt.textContent = m.name;
    select.appendChild(opt);
  });
  if (saved && models.some(m => m.name === saved)) select.value = saved;
}

// ── Chat input ───────────────────────────────────────────────
function initChatInput() {
  // Auto-resize textarea
  chatInput.addEventListener('input', () => {
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(chatInput.scrollHeight, 140) + 'px';
    chatSendBtn.disabled = !chatInput.value.trim() && attachedFiles.length === 0;
  });

  // Ctrl+Enter or Enter to send
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!chatSendBtn.disabled && !isStreaming) chatForm.requestSubmit();
    }
  });

  // Form submit
  chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    sendMessage();
  });

  // New chat
  newChatBtn.addEventListener('click', () => startNewChat());

  // Paste images
  chatInput.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        readFileAsAttachment(file);
      }
    }
  });

  // Text selection → "Ask more" floating button
  initSelectionPrompt();

  // Quote reference close button
  document.getElementById('quote-reference-close').addEventListener('click', () => {
    const refEl = document.getElementById('quote-reference');
    refEl.style.display = 'none';
    refEl._quoteText = null;
    refEl._quoteFullContext = null;
  });
}

// ══════════════════════════════════════════════════════════════
//  VOICE CONVERSATION MODE (phone-call style)
// ══════════════════════════════════════════════════════════════
let vcActive = false;        // voice call is active
let vcRecognition = null;
let vcAudioQueue = [];       // queued audio blobs to play
let vcPlaying = false;       // currently playing audio
let vcCurrentAudio = null;
let kokoroAvailable = null;

// Pick the fastest (smallest) installed model for voice mode
function getVoiceModel() {
  // Prefer small/fast models in order of speed
  const fastModels = [
    'qwen2.5:0.5b', 'qwen2.5:1.5b', 'gemma2:2b', 'phi3:mini',
    'phi3:latest', 'gemma2:latest', 'llama3.2:1b', 'llama3.2:3b',
    'llama3.2:latest', 'mistral:latest', 'qwen2.5:latest',
    'gemma3:1b', 'gemma3:4b', 'gemma3:latest'
  ];
  const installed = models.map(m => m.name);
  for (const fm of fastModels) {
    if (installed.includes(fm)) return fm;
  }
  // If none of the preferred fast models found, pick the smallest by size
  if (models.length > 0) {
    const sorted = [...models].sort((a, b) => (a.size || Infinity) - (b.size || Infinity));
    return sorted[0].name;
  }
  return modelSelect.value; // fallback to whatever's selected
}

function textForSpeech(text) {
  return text
    .replace(/\$\$[\s\S]*?\$\$/g, ' (equation) ')
    .replace(/\$[^$]+\$/g, ' (expression) ')
    .replace(/```[\s\S]*?```/g, ' (code block) ')
    .replace(/`[^`]+`/g, (m) => m.slice(1, -1))
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[#*_~>]/g, '')
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function initVoice() {
  const micBtn = $('#voice-mic-btn');
  // Mic button starts/stops voice call
  micBtn.addEventListener('click', () => {
    if (vcActive) vcEndCall(); else vcStartCall();
  });
}

// ── Voice Call Overlay ───────────────────────────────────────
function vcCreateOverlay() {
  const ov = document.createElement('div');
  ov.id = 'vc-overlay';
  ov.innerHTML = `
    <div class="vc-card">
      <div class="vc-orb" id="vc-orb"></div>
      <div class="vc-status" id="vc-status">Connecting...</div>
      <div class="vc-transcript" id="vc-transcript"></div>
      <div class="vc-controls">
        <button class="vc-end-btn" id="vc-end-btn" title="End call">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.68 13.31a16 16 0 003.41 2.6l1.27-1.27a2 2 0 012.11-.45 12.84 12.84 0 004.33.74 2 2 0 012 2v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6A19.79 19.79 0 014 4.18 2 2 0 016 2h3a2 2 0 012 1.72c.06.5.18 1 .34 1.48a2 2 0 01-.45 2.11z"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(ov);
  $('#vc-end-btn').addEventListener('click', vcEndCall);
  return ov;
}

function vcStartCall() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) { statusBar.textContent = 'Voice not supported in this browser'; return; }

  vcActive = true;
  vcAudioQueue = [];
  vcPlaying = false;
  $('#voice-mic-btn').classList.add('recording');

  // Create overlay
  vcCreateOverlay();
  const orbEl = $('#vc-orb');
  const statusEl = $('#vc-status');
  const transcriptEl = $('#vc-transcript');

  // Start listening
  vcRecognition = new SpeechRecognition();
  vcRecognition.continuous = true;
  vcRecognition.interimResults = true;
  vcRecognition.lang = 'en-US';

  let finalTranscript = '';
  let silenceTimer = null;

  vcRecognition.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      if (event.results[i].isFinal) {
        finalTranscript += event.results[i][0].transcript + ' ';
      } else {
        interim += event.results[i][0].transcript;
      }
    }
    transcriptEl.textContent = finalTranscript + interim;
    orbEl.className = 'vc-orb vc-user-speaking';
    statusEl.textContent = 'Listening...';

    // Reset silence timer — send after 1.5s of no new results
    clearTimeout(silenceTimer);
    if (finalTranscript.trim()) {
      silenceTimer = setTimeout(() => {
        const text = finalTranscript.trim();
        if (text && vcActive) {
          finalTranscript = '';
          vcSendAndRespond(text, orbEl, statusEl, transcriptEl);
        }
      }, 1500);
    }
  };

  vcRecognition.onend = () => {
    // Auto-restart if call is still active and we're not playing audio
    if (vcActive && !vcPlaying) {
      try { vcRecognition.start(); } catch {}
    }
  };

  vcRecognition.onerror = (e) => {
    if (e.error === 'no-speech' || e.error === 'aborted') return;
    statusEl.textContent = 'Mic error: ' + e.error;
  };

  const voiceModel = getVoiceModel();
  statusEl.textContent = `Listening... (${voiceModel})`;
  orbEl.className = 'vc-orb vc-listening';
  try { vcRecognition.start(); } catch {}
}

async function vcSendAndRespond(userText, orbEl, statusEl, transcriptEl) {
  if (!vcActive) return;

  // Stop listening while AI responds
  try { vcRecognition.stop(); } catch {}
  orbEl.className = 'vc-orb vc-thinking';
  statusEl.textContent = 'Thinking...';
  transcriptEl.textContent = '';

  // Add to chat history (silently, no UI render during call)
  chatHistory.push({ role: 'user', content: userText });

  // Also render in chat behind the overlay
  emptyState.style.display = 'none';
  renderMessage({ role: 'user', content: userText });
  const botDiv = createMessageDiv('bot');
  const botBody = botDiv.querySelector('.msg-body');
  chatMessages.appendChild(botDiv);

  try {
    const model = getVoiceModel();
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: chatHistory, model, stream: true, voice: true })
    });

    orbEl.className = 'vc-orb vc-speaking';
    statusEl.textContent = `Speaking (${model})...`;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let fullResponse = '';
    let buffer = '';
    let sentenceBuffer = '';  // accumulate text until we hit a sentence boundary

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!vcActive) { reader.cancel(); break; }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.message?.content) {
            fullResponse += parsed.message.content;
            botBody.innerHTML = renderMarkdown(fullResponse);
            sentenceBuffer += parsed.message.content;

            // Check for sentence boundaries — speak as we go
            const sentenceMatch = sentenceBuffer.match(/^([\s\S]*?[.!?]\s)/);
            if (sentenceMatch) {
              const sentence = sentenceMatch[1];
              sentenceBuffer = sentenceBuffer.slice(sentence.length);
              const clean = textForSpeech(sentence);
              if (clean) vcQueueSpeak(clean);
            }
          }
        } catch {}
      }
    }

    // Speak any remaining text
    if (sentenceBuffer.trim()) {
      const clean = textForSpeech(sentenceBuffer);
      if (clean) vcQueueSpeak(clean);
    }

    chatHistory.push({ role: 'assistant', content: fullResponse });
    setupInteractiveButtons(botDiv.querySelector('.msg-body'));
    autoSaveChat();

    // Show transcript of AI response
    transcriptEl.textContent = fullResponse.substring(0, 200) + (fullResponse.length > 200 ? '...' : '');

    // Wait for all audio to finish, then resume listening
    vcWaitForAudioDone(() => {
      if (vcActive) {
        orbEl.className = 'vc-orb vc-listening';
        statusEl.textContent = 'Listening...';
        transcriptEl.textContent = '';
        try { vcRecognition.start(); } catch {}
      }
    });

  } catch (err) {
    statusEl.textContent = 'Error: ' + err.message;
    if (vcActive) {
      setTimeout(() => {
        orbEl.className = 'vc-orb vc-listening';
        statusEl.textContent = 'Listening...';
        try { vcRecognition.start(); } catch {}
      }, 2000);
    }
  }
}

// ── TTS Queue (sentence-by-sentence playback) ────────────────
function vcQueueSpeak(text) {
  vcAudioQueue.push(text);
  if (!vcPlaying) vcPlayNext();
}

async function vcPlayNext() {
  if (vcAudioQueue.length === 0 || !vcActive) {
    vcPlaying = false;
    return;
  }
  vcPlaying = true;
  const text = vcAudioQueue.shift();

  try {
    // Try Kokoro
    if (kokoroAvailable !== false) {
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
      });
      if (res.ok) {
        kokoroAvailable = true;
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        vcCurrentAudio = new Audio(url);
        vcCurrentAudio.onended = () => { URL.revokeObjectURL(url); vcCurrentAudio = null; vcPlayNext(); };
        vcCurrentAudio.onerror = () => { vcCurrentAudio = null; vcPlayNext(); };
        vcCurrentAudio.play();
        return;
      }
      kokoroAvailable = false;
    }

    // Fallback: browser TTS
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = 1.05;
    const voices = speechSynthesis.getVoices();
    const voice = voices.find(v => v.lang.startsWith('en') && v.name.includes('Natural'))
               || voices.find(v => v.lang.startsWith('en'))
               || null;
    if (voice) utter.voice = voice;
    utter.onend = () => vcPlayNext();
    utter.onerror = () => vcPlayNext();
    speechSynthesis.speak(utter);
  } catch {
    vcPlayNext();
  }
}

function vcWaitForAudioDone(callback) {
  if (!vcPlaying && vcAudioQueue.length === 0) { callback(); return; }
  const check = setInterval(() => {
    if (!vcPlaying && vcAudioQueue.length === 0) {
      clearInterval(check);
      callback();
    }
  }, 200);
}

function vcEndCall() {
  vcActive = false;
  try { vcRecognition.stop(); } catch {}
  vcRecognition = null;
  vcAudioQueue = [];
  if (vcCurrentAudio) { vcCurrentAudio.pause(); vcCurrentAudio = null; }
  speechSynthesis.cancel();
  vcPlaying = false;

  $('#voice-mic-btn').classList.remove('recording');
  const ov = $('#vc-overlay');
  if (ov) ov.remove();
}

// Legacy wrappers (for the speakText call after streaming in text mode)
let voiceEnabled = false;
function speakText() {} // no-op in text mode, voice only in call mode
function stopSpeaking() {
  if (vcCurrentAudio) { vcCurrentAudio.pause(); vcCurrentAudio = null; }
  speechSynthesis.cancel();
}

// ── File attachment ──────────────────────────────────────────
function initFileAttach() {
  chatAttachBtn.addEventListener('click', () => {
    requestAnimationFrame(() => chatFileInput.click());
  });
  chatFileInput.addEventListener('change', () => {
    for (const file of chatFileInput.files) readFileAsAttachment(file);
    chatFileInput.value = '';
  });

  // ── Drag-and-drop from file explorer ──
  const chatPanel = document.getElementById('tab-chat');
  const overlay = document.createElement('div');
  overlay.id = 'drop-overlay';
  overlay.innerHTML = '<div class="drop-overlay-inner"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg><span>Drop files to attach</span></div>';
  chatPanel.appendChild(overlay);

  let dragDepth = 0;

  chatPanel.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    dragDepth++;
    overlay.classList.add('active');
  });

  chatPanel.addEventListener('dragleave', () => {
    dragDepth--;
    if (dragDepth === 0) overlay.classList.remove('active');
  });

  chatPanel.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });

  chatPanel.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    overlay.classList.remove('active');
    const files = Array.from(e.dataTransfer.files);
    if (files.length) files.forEach(readFileAsAttachment);
  });
}

async function readFileAsAttachment(file) {
  statusBar.textContent = `Uploading ${file.name}...`;
  try {
    // Upload to server for permanent storage
    const form = new FormData();
    form.append('file', file);
    const res = await fetch('/api/documents/upload', { method: 'POST', body: form });
    const doc = await res.json();
    if (!res.ok) throw new Error(doc.error || 'Upload failed');

    const isImage = file.type.startsWith('image/');
    const attachment = {
      name: doc.originalName,
      type: file.type,
      documentId: doc.id,
      base64: null,
      dataUrl: null,
      textContent: null,
    };

    if (isImage) {
      // Read image as base64 for vision model
      const imgRes = await fetch(`/api/documents/${doc.id}/raw`);
      const blob = await imgRes.blob();
      const dataUrl = await new Promise(resolve => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.readAsDataURL(blob);
      });
      attachment.base64 = dataUrl.split(',')[1];
      attachment.dataUrl = dataUrl;
    } else if (doc.hasText) {
      // Fetch extracted text for LLM context
      const textRes = await fetch(`/api/documents/${doc.id}/text`);
      const textData = await textRes.json();
      attachment.textContent = textData.content;
    } else {
      // Read as text client-side as fallback
      const text = await file.text();
      attachment.textContent = text;
    }

    attachedFiles.push(attachment);
    renderAttachedFiles();
    chatSendBtn.disabled = false;
    statusBar.textContent = `Uploaded: ${doc.originalName}`;
    expRefresh(); // Refresh explorer if open
  } catch (err) {
    statusBar.textContent = 'Upload failed: ' + err.message;
  }
}

function renderAttachedFiles() {
  attachedFilesEl.innerHTML = '';
  attachedFiles.forEach((f, i) => {
    const chip = document.createElement('span');
    chip.className = 'attached-chip';
    chip.innerHTML = `${escHtml(f.name)} <button class="remove-chip" data-idx="${i}">&times;</button>`;
    attachedFilesEl.appendChild(chip);
  });
  attachedFilesEl.querySelectorAll('.remove-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      attachedFiles.splice(parseInt(btn.dataset.idx), 1);
      renderAttachedFiles();
      chatSendBtn.disabled = !chatInput.value.trim() && attachedFiles.length === 0;
    });
  });
}

// ── Send message ─────────────────────────────────────────────
async function sendMessage() {
  const text = chatInput.value.trim();
  if (!text && attachedFiles.length === 0) return;
  if (isStreaming) return;

  // Check for quote reference context
  const refEl = document.getElementById('quote-reference');
  const quoteText = refEl._quoteText || null;
  const quoteFullContext = refEl._quoteFullContext || null;
  // Clear the quote card
  refEl.style.display = 'none';
  refEl._quoteText = null;
  refEl._quoteFullContext = null;

  // Hide empty state
  emptyState.style.display = 'none';

  // Gather images and file text
  const images = attachedFiles.filter(f => f.base64).map(f => f.base64);
  const fileTexts = attachedFiles.filter(f => f.textContent).map(f => `[File: ${f.name}]\n${f.textContent}`);

  // Build the full content sent to the model
  // If quote context exists, include FULL bot response for LLM + highlight the specific selection
  let fullContent = fileTexts.length > 0 ? text + '\n\n' + fileTexts.join('\n\n') : text;
  if (quoteText) {
    const selectedQuoted = quoteText.split('\n').map(l => `> ${l}`).join('\n');
    fullContent = `[Context from your previous response:\n${quoteFullContext || quoteText}\n]\n\nThe user is specifically asking about this part:\n${selectedQuoted}\n\nUser's question: ${text}`;
  }

  // Add user message to UI — only show the selected snippet, not the full context
  const displayText = quoteText ? `> ${quoteText.split('\n')[0]}${quoteText.includes('\n') ? '...' : ''}\n\n${text}` : text;
  const userMsg = { role: 'user', content: displayText, images: attachedFiles.filter(f => f.dataUrl).map(f => f.dataUrl), files: attachedFiles.map(f => f.name) };
  renderMessage(userMsg);
  chatHistory.push({ role: 'user', content: fullContent });

  // Clear input
  chatInput.value = '';
  chatInput.style.height = 'auto';
  attachedFiles = [];
  renderAttachedFiles();
  chatSendBtn.disabled = true;

  // ── RAG mode: retrieve relevant context from indexed documents ──
  let ragContext = null;
  if (ragModeEnabled && !images.length && text) {
    statusBar.textContent = 'Searching knowledge base...';
    try {
      const ragRes = await fetch(`/api/rag/context?q=${encodeURIComponent(text)}&top_k=3`);
      if (ragRes.ok) {
        ragContext = await ragRes.json();
      }
    } catch (err) {
      console.error('RAG context fetch failed:', err);
    }

    // Render sources card if we got results
    if (ragContext && ragContext.sources && ragContext.sources.length > 0) {
      const card = renderRAGSourcesCard(ragContext.sources);
      chatMessages.appendChild(card);
    }
  }

  // ── Context Director: resolve implicit references via small model (3s timeout) ──
  let contextAnalysis = null;
  if (!images.length && text) {
    try {
      const cdAbort = new AbortController();
      const cdTimer = setTimeout(() => cdAbort.abort(), 3000);
      const cdRes = await fetch('/api/context/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: chatHistory.slice(-6), query: text, userLocation: userLocation || '' }),
        signal: cdAbort.signal
      });
      clearTimeout(cdTimer);
      if (cdRes.ok) contextAnalysis = await cdRes.json();
    } catch (err) {
      console.warn('Context director skipped:', err.message);
    }
  }

  // ── Places pre-fetch: use context director's expanded query if available ──
  let placesData = null;
  if (userLocation && !images.length) {
    const shouldSearchPlaces = contextAnalysis
      ? contextAnalysis.needsLocationSearch
      : (() => {
          const lowerText = text.toLowerCase();
          const placeKeywords = ['restaurant', 'cafe', 'coffee', 'bar', 'pub', 'store', 'shop', 'hotel',
            'park', 'gym', 'museum', 'theater', 'theatre', 'cinema', 'library', 'hospital', 'pharmacy',
            'gas station', 'grocery', 'bakery', 'pizza', 'sushi', 'burger', 'food', 'eat', 'drink',
            'near me', 'nearby', 'around here', 'close to', 'in the area', 'recommend', 'best places',
            'where can i', 'where to', 'find me', 'show me', 'what are some', 'places to'];
          return placeKeywords.some(kw => lowerText.includes(kw));
        })();

    if (shouldSearchPlaces) {
      statusBar.textContent = 'Finding places...';
      const placesQuery = (contextAnalysis && contextAnalysis.locationSearchQuery)
        ? contextAnalysis.locationSearchQuery
        : text;
      try {
        const pRes = await fetch(`/api/web/search-places?q=${encodeURIComponent(placesQuery)}&near=${encodeURIComponent(userLocation)}&max=5`);
        const pData = await pRes.json();
        if (pData.places && pData.places.length > 0) placesData = pData.places;
      } catch (err) {
        console.error('Places search failed:', err);
      }
    }
  }

  // Create bot message placeholder
  const botDiv = createMessageDiv('bot');
  const botBody = botDiv.querySelector('.msg-body');
  chatMessages.appendChild(botDiv);

  // Smooth scroll to the response once, then stop (no auto-scroll during streaming)
  chatMessages.scrollTo({ top: chatMessages.scrollHeight, behavior: 'smooth' });

  isStreaming = true;
  statusBar.textContent = 'Thinking...';
  document.querySelector('.input-box').classList.add('is-generating');

  try {
    const model = modelSelect.value;
    const isVision = images.length > 0;
    const endpoint = isVision ? '/api/chat/vision' : '/api/chat';

    // Build messages — inject location, RAG, and web context as system messages
    let messagesForLLM = [...chatHistory];
    if (userLocation) {
      messagesForLLM = [{
        role: 'system',
        content: `The user's location is: ${userLocation}. Use this for directions, weather, nearby places, etc.

You can embed an interactive map card for PHYSICAL locations using this format:

\`\`\`map
{"q": "exact place name and city", "label": "Short display name"}
\`\`\`

CRITICAL RULES for map blocks:
- ONLY use map blocks for REAL PHYSICAL PLACES that exist on a map (restaurants, stores, parks, landmarks, buildings, addresses)
- NEVER use map blocks for: websites, online stores, brands, products, concepts, or anything without a physical address
- "q" MUST be a real searchable place with city/region (e.g. "Blue Bottle Coffee, San Francisco" or "Central Park, New York, NY")
- "label" is the short display name (e.g. "Blue Bottle Coffee")
- If the user asks about online-only things (websites, apps, e-commerce), do NOT include any map blocks
- When recommending physical places near the user, include the city in "q" for accurate geocoding`
      }, ...messagesForLLM];
    }
    if (ragContext && ragContext.context) {
      const ragSystemMsg = {
        role: 'system',
        content: `Use the following context retrieved from the user's knowledge base to inform your response. Reference the source documents when relevant.\n\n${ragContext.context}`
      };
      messagesForLLM = [ragSystemMsg, ...messagesForLLM];
    }
    const body = isVision
      ? { messages: messagesForLLM, images, model, stream: true }
      : { messages: messagesForLLM, model, stream: true };

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let fullResponse = '';
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.message?.content) {
            fullResponse += parsed.message.content;
            botBody.innerHTML = renderMarkdown(fullResponse);
          }
        } catch {}
      }
    }

    chatHistory.push({ role: 'assistant', content: fullResponse });
    statusBar.textContent = '';
    setupInteractiveButtons(botDiv.querySelector('.msg-body'));
    initMapsInElement(botDiv);
    autoSaveChat();
    speakText(fullResponse);
    scanAndRenderEmbeds(fullResponse, botDiv);

  } catch (err) {
    botBody.textContent = 'Error: ' + err.message;
    statusBar.textContent = 'Error';
  }

  isStreaming = false;
  document.querySelector('.input-box').classList.remove('is-generating');
}

// ══════════════════════════════════════════════════════════════
//  EDITOR TAB
// ══════════════════════════════════════════════════════════════

let editorDocs = [];       // { id, name, text }
let editorActiveIdx = -1;

function initEditor() {
  const panel      = document.getElementById('tab-editor');
  const fileList   = document.getElementById('editor-file-list');
  const openBtn    = document.getElementById('editor-open-btn');
  const fileInput  = document.getElementById('editor-file-input');
  const empty      = document.getElementById('editor-empty');
  const contentWrap= document.getElementById('editor-content-wrap');
  const docName    = document.getElementById('editor-doc-name');
  const textarea   = document.getElementById('editor-textarea');
  const copyBtn    = document.getElementById('editor-copy-btn');
  const downloadBtn= document.getElementById('editor-download-btn');
  const runBtn     = document.getElementById('editor-run-btn');
  const translateBtn=document.getElementById('editor-translate-btn');
  const customPrompt=document.getElementById('editor-custom-prompt');
  const resultWrap = document.getElementById('editor-result-wrap');
  const resultEl   = document.getElementById('editor-result');
  const resultClose= document.getElementById('editor-result-close');
  const resultCopy = document.getElementById('editor-result-copy');
  const resultReplace=document.getElementById('editor-result-replace');
  const editLiveBtn  = document.getElementById('editor-edit-live-btn');
  const pdfEditContainer = document.getElementById('editor-pdf-edit-container');
  let pdfEditMode = false;

  // ── Open file button ──
  openBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    Array.from(fileInput.files).forEach(editorLoadFile);
    fileInput.value = '';
  });

  // ── Drag-and-drop onto editor panel ──
  const overlay = document.getElementById('editor-drop-overlay');
  let depth = 0;
  panel.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault(); depth++;
    overlay.classList.add('active');
  });
  panel.addEventListener('dragleave', () => {
    if (--depth === 0) overlay.classList.remove('active');
  });
  panel.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
  });
  panel.addEventListener('drop', (e) => {
    e.preventDefault(); depth = 0; overlay.classList.remove('active');
    Array.from(e.dataTransfer.files).forEach(editorLoadFile);
  });

  // ── Toolbar buttons ──
  copyBtn.addEventListener('click', () => {
    const doc = editorActiveIdx >= 0 ? editorDocs[editorActiveIdx] : null;
    const content = (doc && doc.viewMode !== 'text') ? (doc.text || '') : textarea.value;
    navigator.clipboard.writeText(content).then(() => {
      copyBtn.textContent = 'Copied!';
      setTimeout(() => copyBtn.textContent = 'Copy', 1500);
    });
  });
  downloadBtn.addEventListener('click', () => {
    const doc = editorActiveIdx >= 0 ? editorDocs[editorActiveIdx] : null;
    const content = (doc && doc.viewMode !== 'text') ? (doc.text || '') : textarea.value;
    const name = (doc?.name || 'document').replace(/\.[^.]+$/, '') + '.txt';
    const blob = new Blob([content], { type: 'text/plain' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
    a.click(); URL.revokeObjectURL(a.href);
  });

  // ── Edit Live (PDF only) ──
  editLiveBtn.addEventListener('click', async () => {
    const doc = editorDocs[editorActiveIdx];
    if (!doc || doc.viewMode !== 'pdf') return;
    if (!pdfEditMode) await startPdfEditMode(doc);
    else await savePdfEdits(doc);
  });

  // ── AI quick actions ──
  document.querySelectorAll('.editor-ai-btn').forEach(btn => {
    btn.addEventListener('click', () => editorRunAI(btn.dataset.action));
  });

  // ── Translate ──
  translateBtn.addEventListener('click', () => {
    const lang = document.getElementById('editor-lang').value;
    editorRunAI(`Translate the following text to ${lang}. Return only the translated text, no explanations.`);
  });

  // ── Custom run ──
  runBtn.addEventListener('click', () => {
    const p = customPrompt.value.trim();
    if (p) editorRunAI(p);
  });

  // ── Result panel ──
  resultClose.addEventListener('click', () => resultWrap.style.display = 'none');
  resultCopy.addEventListener('click', () => {
    navigator.clipboard.writeText(resultEl.textContent).then(() => {
      resultCopy.textContent = 'Copied!';
      setTimeout(() => resultCopy.textContent = 'Copy', 1500);
    });
  });
  resultReplace.addEventListener('click', () => {
    textarea.value = resultEl.textContent;
    resultWrap.style.display = 'none';
    if (editorActiveIdx >= 0) editorDocs[editorActiveIdx].text = textarea.value;
  });

  // ── Keep doc text in sync on edit ──
  textarea.addEventListener('input', () => {
    if (editorActiveIdx >= 0) editorDocs[editorActiveIdx].text = textarea.value;
  });

  const viewFrame = document.getElementById('editor-view-frame');
  const viewImg   = document.getElementById('editor-view-img');

  function editorShowDoc(idx) {
    editorActiveIdx = idx;
    const doc = editorDocs[idx];
    docName.textContent = doc.name;
    empty.style.display = 'none';
    contentWrap.style.display = 'flex';
    resultWrap.style.display = 'none';

    // Exit PDF edit mode if active
    if (pdfEditMode) {
      pdfEditMode = false;
      editLiveBtn.textContent = '✏️ Edit Live';
      editLiveBtn.classList.remove('primary');
      pdfEditContainer.innerHTML = '';
    }

    // Hide all viewers, then show the right one
    textarea.style.display        = 'none';
    viewFrame.style.display       = 'none';
    viewImg.style.display         = 'none';
    pdfEditContainer.style.display = 'none';

    if (doc.viewMode === 'pdf') {
      viewFrame.src = doc.blobUrl;
      viewFrame.style.display = '';
    } else if (doc.viewMode === 'image') {
      viewImg.src = doc.blobUrl;
      viewImg.style.display = '';
    } else if (doc.viewMode === 'docx') {
      // Render DOCX html into sandboxed iframe
      const htmlDoc = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
        body{font-family:Georgia,serif;font-size:14px;line-height:1.75;padding:40px 56px;max-width:820px;margin:0 auto;color:#1a1a1a;background:#fff}
        h1,h2,h3,h4,h5{font-family:inherit;margin:1.2em 0 0.4em}
        p{margin:0.5em 0}
        table{border-collapse:collapse;width:100%;margin:1em 0}
        td,th{border:1px solid #ccc;padding:6px 12px;text-align:left}
        th{background:#f0f0f0}
        img{max-width:100%}
        ul,ol{padding-left:1.5em}
      </style></head><body>${doc.htmlContent || escHtml(doc.text)}</body></html>`;
      if (doc._htmlBlobUrl) URL.revokeObjectURL(doc._htmlBlobUrl);
      const blob = new Blob([htmlDoc], { type: 'text/html' });
      doc._htmlBlobUrl = URL.createObjectURL(blob);
      viewFrame.src = doc._htmlBlobUrl;
      viewFrame.style.display = '';
    } else {
      // Plain text / code
      textarea.value = doc.text;
      textarea.style.display = '';
    }

    // Show Edit Live button only for PDFs
    editLiveBtn.style.display = doc.viewMode === 'pdf' ? '' : 'none';

    document.querySelectorAll('.editor-file-item').forEach((el, i) => {
      el.classList.toggle('active', i === idx);
    });
  }

  // ── PDF Live Edit ─────────────────────────────────────────────
  async function startPdfEditMode(doc) {
    if (typeof pdfjsLib === 'undefined') {
      statusBar.textContent = 'PDF.js still loading — try again in a moment';
      setTimeout(() => statusBar.textContent = '', 3000);
      return;
    }
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

    statusBar.textContent = 'Opening PDF editor...';
    pdfEditContainer.innerHTML = '';
    viewFrame.style.display = 'none';
    pdfEditContainer.style.display = '';

    try {
      const arrayBuf = await doc.file.arrayBuffer();
      const pdfJsDoc = await pdfjsLib.getDocument({ data: new Uint8Array(arrayBuf) }).promise;
      doc._pdfJsDoc = pdfJsDoc;

      for (let pageNum = 1; pageNum <= pdfJsDoc.numPages; pageNum++) {
        const page = await pdfJsDoc.getPage(pageNum);
        const viewport = page.getViewport({ scale: 1.5 });

        const pageDiv = document.createElement('div');
        pageDiv.className = 'pdf-edit-page';
        pageDiv.style.width  = viewport.width  + 'px';
        pageDiv.style.height = viewport.height + 'px';

        // Render the page visually
        const canvas = document.createElement('canvas');
        canvas.width  = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        pageDiv.appendChild(canvas);

        // Build the editable text layer
        const textLayerDiv = document.createElement('div');
        textLayerDiv.className = 'pdf-text-layer';
        const textContent = await page.getTextContent();

        for (const item of textContent.items) {
          if (!item.str) continue;
          const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
          const fontHeight = Math.sqrt(tx[0] * tx[0] + tx[1] * tx[1]);
          if (fontHeight < 2) continue;

          const span = document.createElement('span');
          span.className = 'pdf-text-item';
          span.contentEditable = 'true';
          span.spellcheck = false;
          span.textContent = item.str;
          span.dataset.original   = item.str;
          span.dataset.pageNum    = pageNum;
          span.dataset.pdfX       = item.transform[4];
          span.dataset.pdfY       = item.transform[5];
          span.dataset.pdfFs      = Math.abs(item.transform[0]); // font size in pts
          span.dataset.pdfWidth   = item.width  || 0;
          span.dataset.pdfHeight  = Math.abs(item.transform[3] || item.transform[0]);

          span.style.cssText = `
            position:absolute;
            left:${tx[4]}px;
            top:${tx[5] - fontHeight}px;
            font-size:${fontHeight}px;
            line-height:1;
            white-space:pre;
            min-width:${Math.max((item.width || 0) * 1.5, fontHeight * 0.3)}px;
          `;

          span.addEventListener('input', () => {
            span.dataset.changed = span.textContent !== span.dataset.original ? 'true' : '';
          });
          textLayerDiv.appendChild(span);
        }

        pageDiv.appendChild(textLayerDiv);
        pdfEditContainer.appendChild(pageDiv);
      }

      pdfEditMode = true;
      editLiveBtn.textContent = '💾 Save PDF';
      editLiveBtn.classList.add('primary');
      statusBar.textContent = 'Click any text to edit it. Click Save PDF when done.';
      setTimeout(() => statusBar.textContent = '', 5000);

    } catch (err) {
      console.error('[PDF edit]', err);
      statusBar.textContent = 'PDF edit failed: ' + err.message;
      setTimeout(() => statusBar.textContent = '', 4000);
      pdfEditContainer.style.display = 'none';
      viewFrame.style.display = '';
      pdfEditMode = false;
    }
  }

  async function savePdfEdits(doc) {
    if (typeof PDFLib === 'undefined') {
      statusBar.textContent = 'pdf-lib still loading — try again';
      setTimeout(() => statusBar.textContent = '', 3000);
      return;
    }

    const changedSpans = [...pdfEditContainer.querySelectorAll('.pdf-text-item[data-changed="true"]')];
    if (!changedSpans.length) {
      exitPdfEditMode(doc);
      return;
    }

    statusBar.textContent = 'Applying edits...';
    try {
      const { PDFDocument, rgb, StandardFonts } = PDFLib;
      const arrayBuf = await doc.file.arrayBuffer();
      const pdfDoc = await PDFDocument.load(arrayBuf, { ignoreEncryption: true });
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

      for (const span of changedSpans) {
        const pageIndex = parseInt(span.dataset.pageNum) - 1;
        const page = pdfDoc.getPage(pageIndex);

        const x  = parseFloat(span.dataset.pdfX);
        const y  = parseFloat(span.dataset.pdfY);
        const fs = Math.max(parseFloat(span.dataset.pdfFs) || 10, 6);
        const w  = parseFloat(span.dataset.pdfWidth)  || fs * (span.dataset.original.length * 0.55);
        const h  = parseFloat(span.dataset.pdfHeight) || fs * 1.2;
        const newText = span.textContent;

        // White out the original text
        page.drawRectangle({
          x: x - 1, y: y - h * 0.15,
          width: w + 2, height: h * 1.3,
          color: rgb(1, 1, 1), borderWidth: 0,
        });

        // Draw the new text
        if (newText.trim()) {
          page.drawText(newText, { x, y, size: fs, font, color: rgb(0, 0, 0) });
        }
      }

      const bytes = await pdfDoc.save();
      const blob = new Blob([bytes], { type: 'application/pdf' });
      const newUrl = URL.createObjectURL(blob);

      // Download the modified PDF
      const a = Object.assign(document.createElement('a'), {
        href: newUrl,
        download: doc.name.replace(/\.pdf$/i, '_edited.pdf')
      });
      a.click();

      // Update the doc so re-editing works on the new version
      if (doc.blobUrl) URL.revokeObjectURL(doc.blobUrl);
      doc.blobUrl = newUrl;
      doc.file = new File([bytes], doc.name, { type: 'application/pdf' });

      statusBar.textContent = 'PDF saved ✓';
      setTimeout(() => statusBar.textContent = '', 3000);
      exitPdfEditMode(doc);

    } catch (err) {
      console.error('[PDF save]', err);
      statusBar.textContent = 'Save failed: ' + err.message;
      setTimeout(() => statusBar.textContent = '', 4000);
    }
  }

  function exitPdfEditMode(doc) {
    pdfEditMode = false;
    editLiveBtn.textContent = '✏️ Edit Live';
    editLiveBtn.classList.remove('primary');
    pdfEditContainer.innerHTML = '';
    pdfEditContainer.style.display = 'none';
    if (doc) {
      viewFrame.src = doc.blobUrl;
      viewFrame.style.display = '';
    }
  }
  // ─────────────────────────────────────────────────────────────

  function editorRenderFileList() {
    fileList.innerHTML = '';
    if (editorDocs.length === 0) {
      fileList.innerHTML = '<div class="editor-drop-hint"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg><span>Drop files here</span></div>';
      return;
    }
    editorDocs.forEach((doc, i) => {
      const item = document.createElement('div');
      item.className = 'editor-file-item' + (i === editorActiveIdx ? ' active' : '');
      item.innerHTML = `<span class="editor-file-icon">${editorFileIcon(doc.name)}</span><span class="editor-file-name">${escHtml(doc.name)}</span><button class="editor-file-remove" data-i="${i}" title="Remove">×</button>`;
      item.addEventListener('click', (e) => {
        if (e.target.classList.contains('editor-file-remove')) {
          editorDocs.splice(+e.target.dataset.i, 1);
          if (editorActiveIdx >= editorDocs.length) editorActiveIdx = editorDocs.length - 1;
          editorRenderFileList();
          if (editorDocs.length === 0) { empty.style.display = ''; contentWrap.style.display = 'none'; }
          else editorShowDoc(editorActiveIdx);
        } else {
          editorShowDoc(i);
          editorRenderFileList();
        }
      });
      fileList.appendChild(item);
    });
  }

  async function editorLoadFile(file) {
    const name = file.name;
    const ext  = name.split('.').pop().toLowerCase();
    statusBar.textContent = `Loading ${name}...`;

    const PDF_EXTS   = ['pdf'];
    const IMG_EXTS   = ['png','jpg','jpeg','gif','webp','svg','bmp','avif'];
    const DOCX_EXTS  = ['docx','doc'];
    const TEXT_EXTS  = ['txt','md','csv','json','js','ts','py','html','css','xml','yaml','yml','log','sh','bat','c','cpp','java','rb','go','rs'];

    let viewMode = 'text';
    let text = '';
    let blobUrl = null;
    let htmlContent = null;

    try {
      if (PDF_EXTS.includes(ext)) {
        // ── PDF: render natively, also extract text for AI tools ──
        viewMode = 'pdf';
        blobUrl  = URL.createObjectURL(file);
        // Background text extraction for AI (non-blocking)
        (async () => {
          try {
            const form = new FormData(); form.append('file', file);
            const res = await fetch('/api/documents/upload', { method: 'POST', body: form });
            if (!res.ok) return;
            const d = await res.json();
            if (d.hasText) {
              const tr = await fetch(`/api/documents/${d.id}/text`);
              if (tr.ok) { const td = await tr.json(); editorDocs.find(x => x.blobUrl === blobUrl).text = td.content || ''; }
            }
          } catch {}
        })();

      } else if (IMG_EXTS.includes(ext)) {
        // ── Image: display directly ──
        viewMode = 'image';
        blobUrl  = URL.createObjectURL(file);

      } else if (DOCX_EXTS.includes(ext)) {
        // ── DOCX: convert to HTML with mammoth ──
        if (window.mammoth) {
          viewMode = 'docx';
          const ab = await file.arrayBuffer();
          const result = await mammoth.convertToHtml({ arrayBuffer: ab });
          htmlContent = result.value;
          // Plain text for AI (strip tags)
          text = htmlContent.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        } else {
          // mammoth not loaded yet — fallback to server extraction
          viewMode = 'text';
          const form = new FormData(); form.append('file', file);
          const res = await fetch('/api/documents/upload', { method: 'POST', body: form });
          if (res.ok) {
            const d = await res.json();
            if (d.hasText) { const tr = await fetch(`/api/documents/${d.id}/text`); if (tr.ok) { const td = await tr.json(); text = td.content || ''; } }
          }
        }

      } else if (TEXT_EXTS.includes(ext) || file.type.startsWith('text/')) {
        // ── Plain text / code ──
        viewMode = 'text';
        try {
          const form = new FormData(); form.append('file', file);
          const res = await fetch('/api/documents/upload', { method: 'POST', body: form });
          if (res.ok) {
            const d = await res.json();
            if (d.hasText) { const tr = await fetch(`/api/documents/${d.id}/text`); if (tr.ok) { const td = await tr.json(); text = td.content || ''; } }
          }
        } catch {}
        if (!text) text = await file.text().catch(() => '');

      } else {
        // ── Unknown: try text extraction, then raw read ──
        viewMode = 'text';
        try {
          const form = new FormData(); form.append('file', file);
          const res = await fetch('/api/documents/upload', { method: 'POST', body: form });
          if (res.ok) {
            const d = await res.json();
            if (d.hasText) { const tr = await fetch(`/api/documents/${d.id}/text`); if (tr.ok) { const td = await tr.json(); text = td.content || ''; } }
          }
        } catch {}
        if (!text) text = await file.text().catch(() => `[Cannot display "${name}" — unsupported format]`);
      }

      editorDocs.push({ name, text, viewMode, blobUrl, htmlContent, file });
      editorRenderFileList();
      editorShowDoc(editorDocs.length - 1);
    } catch (err) {
      console.error('editorLoadFile:', err);
      statusBar.textContent = `Failed to load ${name}`;
      setTimeout(() => statusBar.textContent = '', 2000);
    }
    statusBar.textContent = '';
  }

  async function editorRunAI(prompt) {
    const doc = editorActiveIdx >= 0 ? editorDocs[editorActiveIdx] : null;
    const text = (() => {
      // For rendered views (PDF/image/docx), use the stored text; for text mode use textarea selection
      if (doc && doc.viewMode !== 'text') return doc.text || '';
      const sel = textarea.value.substring(textarea.selectionStart, textarea.selectionEnd).trim();
      return sel || textarea.value.trim();
    })();
    if (!text) {
      if (doc && doc.viewMode === 'image') { alert('Images have no text to analyze.'); return; }
      if (doc && doc.viewMode === 'pdf') { alert('PDF text is still loading — try again in a moment.'); return; }
      alert('Open a document first.');
      return;
    }

    resultWrap.style.display = 'flex';
    resultEl.textContent = '';
    resultReplace.disabled = true;
    resultCopy.disabled = true;

    const usingSelection = textarea.selectionEnd > textarea.selectionStart;
    const label = usingSelection ? '(selected text)' : '(full document)';
    resultEl.textContent = `Running on ${label}...\n\n`;

    const messages = [{ role: 'user', content: `${prompt}\n\n---\n\n${text}` }];
    const model = modelSelect.value;

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages, model, stream: true })
      });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = ''; let out = '';
      resultEl.textContent = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n'); buf = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try { const p = JSON.parse(line); if (p.message?.content) { out += p.message.content; resultEl.textContent = out; } } catch {}
        }
      }
    } catch (err) {
      resultEl.textContent = 'Error: ' + err.message;
    }
    resultReplace.disabled = false;
    resultCopy.disabled = false;
    resultEl.scrollTop = 0;
  }
}

function editorFileIcon(name) {
  const ext = name.split('.').pop().toLowerCase();
  if (['pdf'].includes(ext)) return '📄';
  if (['doc','docx'].includes(ext)) return '📝';
  if (['xls','xlsx','csv'].includes(ext)) return '📊';
  if (['png','jpg','jpeg','gif','webp'].includes(ext)) return '🖼';
  if (['md','txt'].includes(ext)) return '📃';
  if (['json','js','py','html','css'].includes(ext)) return '💻';
  return '📁';
}

// ── Post-stream URL embed cards ──────────────────────────────
async function scanAndRenderEmbeds(text, containerDiv) {
  const urlRegex = /https?:\/\/[^\s\)\]"'<>]+/g;
  const urls = [...new Set((text.match(urlRegex) || []).map(u => u.replace(/[.,;!?]+$/, '')))];
  if (urls.length === 0) return;
  const targets = urls.slice(0, 4);
  for (const url of targets) {
    try {
      const res = await fetch('/api/web/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (!data.title && !data.description) continue;
      containerDiv.appendChild(renderEmbedCard({ ...data, url }));
    } catch { /* silently skip */ }
  }
}

function renderEmbedCard(data) {
  let domain = '';
  try { domain = new URL(data.url).hostname.replace('www.', ''); } catch {}
  const favicon = `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
  const imageHtml = data.images && data.images.length > 0
    ? `<img class="embed-card-image" src="${escHtml(data.images[0].src || data.images[0])}" alt="" onerror="this.remove()" loading="lazy">`
    : '';
  const desc = data.description
    ? `<div class="embed-card-desc">${escHtml(data.description.substring(0, 140))}</div>` : '';
  const card = document.createElement('a');
  card.className = 'embed-card';
  card.href = escHtml(data.url);
  card.target = '_blank';
  card.rel = 'noopener noreferrer';
  card.innerHTML = `
    <div class="embed-card-left">
      <div class="embed-card-top">
        <img class="embed-card-favicon" src="${favicon}" alt="" onerror="this.style.display='none'">
        <span class="embed-card-domain">${escHtml(domain)}</span>
      </div>
      <div class="embed-card-title">${escHtml(data.title || domain)}</div>
      ${desc}
    </div>${imageHtml}`;
  return card;
}

// ── Render helpers ───────────────────────────────────────────
function createMessageDiv(role) {
  const div = document.createElement('div');
  div.className = 'msg';
  const isUser = role === 'user';
  div.innerHTML = `
    <div class="msg-avatar ${isUser ? 'user' : 'bot'}">${isUser ? 'U' : 'AI'}</div>
    <div class="msg-body">
      <span class="msg-role ${isUser ? 'user-role' : 'bot-role'}">${isUser ? 'You' : 'MyAI'}</span>
    </div>
  `;
  return div;
}

function renderMessage(msg) {
  const div = createMessageDiv(msg.role === 'user' ? 'user' : 'bot');
  const body = div.querySelector('.msg-body');

  // Show images if user message
  if (msg.images && msg.images.length) {
    const imgDiv = document.createElement('div');
    imgDiv.className = 'msg-images';
    msg.images.forEach(src => {
      const img = document.createElement('img');
      img.src = src;
      imgDiv.appendChild(img);
    });
    body.appendChild(imgDiv);
  }

  // Show file chips
  if (msg.files && msg.files.length) {
    const filesDiv = document.createElement('div');
    filesDiv.className = 'msg-files';
    msg.files.forEach(name => {
      const chip = document.createElement('span');
      chip.className = 'msg-file-chip';
      chip.textContent = name;
      filesDiv.appendChild(chip);
    });
    body.appendChild(filesDiv);
  }

  // Content
  const contentDiv = document.createElement('div');
  contentDiv.className = 'msg-content';
  if (msg.role === 'user') {
    contentDiv.textContent = msg.content;
  } else {
    contentDiv.innerHTML = renderMarkdown(msg.content);
    highlightCode(contentDiv);
  }
  body.appendChild(contentDiv);

  chatMessages.appendChild(div);

  // Add interactive buttons for bot messages (derive, ask)
  if (msg.role !== 'user') {
    setupInteractiveButtons(body);
    initMapsInElement(div);
  }
}

function renderMarkdown(text) {
  if (typeof marked === 'undefined') return escHtml(text).replace(/\n/g, '<br>');
  // Normalize LaTeX delimiters: \[...\] → $$...$$ and \(...\) → $...$
  let normalized = text
    .replace(/\\\[/g, '$$').replace(/\\\]/g, '$$')
    .replace(/\\\(/g, '$').replace(/\\\)/g, '$');
  try { return marked.parse(normalized); }
  catch { return escHtml(text).replace(/\n/g, '<br>'); }
}

function highlightCode(el) {
  if (typeof hljs === 'undefined') return;
  el.querySelectorAll('pre code').forEach(block => {
    hljs.highlightElement(block);
  });
}

function scrollToBottom() {
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ── Interactive buttons on bot messages ──────────────────────
// "Derive equation" on block math, "Ask" on content blocks
function setupInteractiveButtons(msgBody) {
  // No longer adding bars below formulas — derivation is now on the floating selection buttons
}

// ══════════════════════════════════════════════════════════════
//  MATH MODE — Inline JSXGraph visualizations in chat
// ══════════════════════════════════════════════════════════════
let mmCounter = 0; // unique IDs for multiple graphs

function mmOpen(latex) {
  const preset = mmFindPreset(latex);
  if (preset) {
    mmInjectAfterFormula(null, preset);
  } else {
    mmInjectAfterFormula(latex, null);
  }
}

function mmFindPreset(latex) {
  if (typeof MATH_PRESETS === 'undefined') return null;
  const clean = latex.toLowerCase().replace(/\s+/g, '').replace(/\\[a-z]+/g, m => m);
  for (const p of MATH_PRESETS) {
    const pclean = p.latex.toLowerCase().replace(/\s+/g, '');
    if (pclean === clean) return p;
    for (const tag of p.tags) {
      if (clean.includes(tag.replace(/\s/g, ''))) return p;
    }
  }
  return null;
}

// Search full text for any matching preset (used for auto-detect)
function mmFindPresetInText(text) {
  if (typeof MATH_PRESETS === 'undefined') return [];
  const lower = text.toLowerCase();
  const found = [];
  const seen = new Set();
  for (const p of MATH_PRESETS) {
    if (seen.has(p.id)) continue;
    // Check if the response text contains keywords from this preset
    let score = 0;
    for (const tag of p.tags) {
      if (lower.includes(tag)) score++;
    }
    // Also check if the latex appears in the text
    const latexClean = p.latex.replace(/\\\\/g, '\\').toLowerCase();
    if (lower.includes(latexClean) || lower.includes(p.name.toLowerCase())) score += 3;
    if (score >= 2) { found.push(p); seen.add(p.id); }
  }
  return found.slice(0, 2); // max 2 auto-detected
}

// Auto-detect: scan AI response for matching presets, offer Math Mode
function mmAutoDetect(msgBody, fullText) {
  if (typeof MATH_PRESETS === 'undefined') return;
  const presets = mmFindPresetInText(fullText);
  if (presets.length === 0) return;

  const contentRoot = msgBody.querySelector('.msg-content') || msgBody;
  const existing = contentRoot.querySelector('.mm-auto-offer');
  if (existing) return; // already offered

  const offer = document.createElement('div');
  offer.className = 'mm-auto-offer';
  offer.innerHTML = `<span class="mm-auto-label">Interactive visualizations available:</span>`;

  presets.forEach(p => {
    const btn = document.createElement('button');
    btn.className = 'mm-preset-btn';
    btn.textContent = p.name;
    btn.addEventListener('click', () => {
      btn.disabled = true;
      btn.textContent = 'Loading...';
      mmInjectAfterFormula(null, p, contentRoot);
    });
    offer.appendChild(btn);
  });

  contentRoot.appendChild(offer);
}

// Core: inject a Math Mode panel into the chat
function mmInjectAfterFormula(latex, preset, insertParent) {
  const name = preset ? preset.name : '';
  const formulaLatex = preset ? preset.latex : latex;
  const code = preset ? preset.code : null;
  const renderType = preset ? (preset.type || 'jsx') : 'jsx';

  // Find where to insert
  if (!insertParent) {
    const allMsgs = chatMessages.querySelectorAll('.msg');
    const lastMsg = allMsgs[allMsgs.length - 1];
    if (!lastMsg) return;
    insertParent = lastMsg.querySelector('.msg-content') || lastMsg.querySelector('.msg-body') || lastMsg;
  }

  const gid = 'mm-graph-' + (++mmCounter);

  // Render formula in KaTeX
  let katexHtml = '';
  try {
    if (typeof katex !== 'undefined') {
      katexHtml = katex.renderToString(formulaLatex, { displayMode: true, throwOnError: false });
    }
  } catch { katexHtml = '$$' + escHtml(formulaLatex) + '$$'; }

  const container = document.createElement('div');
  container.className = 'mm-inline';
  container.innerHTML = `
    <div class="mm-inline-header">
      <span class="mm-inline-title">Math Mode</span>
      <span class="mm-inline-label">${name ? escHtml(name) : ''}</span>
      <button class="mm-inline-close" title="Close">&times;</button>
    </div>
    <div class="mm-inline-formula">${katexHtml}</div>
    <div class="mm-inline-graph" id="${gid}"></div>
    <div class="mm-inline-status" id="${gid}-status">${code ? '' : 'Generating visualization...'}</div>
    <div class="mm-inline-chat">
      <input type="text" placeholder="Adjust graph... (e.g. change range, add derivative)" id="${gid}-input">
      <button type="button" title="Send">&rarr;</button>
    </div>
  `;

  insertParent.appendChild(container);
  container.scrollIntoView({ behavior: 'smooth', block: 'center' });

  // Close
  container.querySelector('.mm-inline-close').addEventListener('click', () => {
    const graphEl = document.getElementById(gid);
    if (graphEl && graphEl._jsxboard) { try { JXG.JSXGraph.freeBoard(graphEl._jsxboard); } catch {} }
    container.remove();
  });

  // Inline chat
  const ci = container.querySelector(`#${gid}-input`);
  const cb = container.querySelector('.mm-inline-chat button');
  cb.addEventListener('click', () => mmInlineChat(gid, formulaLatex, ci));
  ci.addEventListener('keydown', (e) => { if (e.key === 'Enter') mmInlineChat(gid, formulaLatex, ci); });

  // Render
  if (code) {
    const statusEl = document.getElementById(`${gid}-status`);
    if (statusEl) statusEl.style.display = 'none';
    setTimeout(() => mmRenderInline(gid, code, renderType), 50);
  } else {
    mmGenerateInline(gid, formulaLatex);
  }
}

function mmRenderInline(gid, code, type) {
  const el = document.getElementById(gid);
  if (!el) return;
  const statusEl = document.getElementById(`${gid}-status`);

  try {
    // Free old board if JSXGraph
    if (el._jsxboard) { try { JXG.JSXGraph.freeBoard(el._jsxboard); } catch {} el._jsxboard = null; }
    el.innerHTML = '';

    if (type === 'plotly' && typeof Plotly !== 'undefined') {
      // Plotly render (3D surfaces, contour plots)
      new Function('container', 'Plotly', code)(el, Plotly);
    } else {
      // JSXGraph render (2D interactive)
      const board = JXG.JSXGraph.initBoard(gid, {
        boundingbox: [-10, 10, 10, -10],
        axis: true, grid: true,
        showNavigation: true, showCopyright: false,
        pan: { enabled: true }, zoom: { enabled: true, wheel: true },
      });
      el._jsxboard = board;
      new Function('board', 'JXG', code)(board, JXG);
    }
    if (statusEl) statusEl.style.display = 'none';
  } catch (err) {
    console.error('[MathMode] Render error:', err);
    if (statusEl) { statusEl.textContent = 'Render error — try adjusting via chat below'; statusEl.style.display = 'block'; }
  }
}

async function mmGenerateInline(gid, latex) {
  const statusEl = document.getElementById(`${gid}-status`);
  const prompt = `You are a math visualization expert. Generate ONLY valid JavaScript code that uses JSXGraph to visualize this mathematical expression. The board variable is already created for you as "board".

RULES:
- Do NOT call JXG.JSXGraph.initBoard — "board" is already initialized
- Use board.create() to add elements
- Add sliders for coefficients/parameters the user can adjust
- Use colors: '#7B8CDE' primary, '#5BB98C' secondary, '#E06C6C' tertiary
- Return ONLY JavaScript code — no markdown, no backticks, no explanation

Formula: $$${latex}$$`;

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: prompt }], model: modelSelect.value, stream: false })
    });
    const data = await res.json();
    const code = (data.message?.content || '')
      .replace(/^```(?:javascript|js)?\s*/i, '').replace(/```\s*$/, '').trim();
    mmRenderInline(gid, code);
  } catch (err) {
    if (statusEl) statusEl.textContent = 'Failed: ' + err.message;
  }
}

async function mmInlineChat(gid, latex, inputEl) {
  const text = inputEl.value.trim();
  if (!text) return;
  inputEl.value = '';

  const statusEl = document.getElementById(`${gid}-status`);
  if (statusEl) { statusEl.textContent = 'Updating...'; statusEl.style.display = 'block'; }

  const prompt = `You are updating a JSXGraph visualization for: $$${latex}$$
The user says: "${text}"
Generate ONLY the complete updated JSXGraph JavaScript code. "board" is already initialized. No JXG.JSXGraph.initBoard. No markdown fences. Use board.create() only. Colors: '#7B8CDE' primary, '#5BB98C' secondary, '#E06C6C' tertiary.`;

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: prompt }], model: modelSelect.value, stream: false })
    });
    const data = await res.json();
    const code = (data.message?.content || '')
      .replace(/^```(?:javascript|js)?\s*/i, '').replace(/```\s*$/, '').trim();

    // Free old board
    const el = document.getElementById(gid);
    if (el && el._jsxboard) { try { JXG.JSXGraph.freeBoard(el._jsxboard); } catch {} }
    mmRenderInline(gid, code);
  } catch (err) {
    if (statusEl) { statusEl.textContent = 'Error: ' + err.message; statusEl.style.display = 'block'; }
  }
}

// ── Text selection → "Ask more" button ───────────────────────
function initSelectionPrompt() {
  let floatingBtn = null;

  function removeBtn() {
    if (floatingBtn) { floatingBtn.remove(); floatingBtn = null; }
  }

  // Extract clean text from selection, preserving KaTeX as LaTeX
  function extractCleanText(sel) {
    const range = sel.getRangeAt(0);
    const fragment = range.cloneContents();

    // Convert KaTeX elements back to raw LaTeX
    fragment.querySelectorAll('.katex').forEach(el => {
      const ann = el.querySelector('annotation[encoding="application/x-tex"]');
      if (ann) {
        const isBlock = el.parentElement && el.parentElement.classList.contains('katex-display');
        const raw = isBlock ? `$$${ann.textContent}$$` : `$${ann.textContent}$`;
        el.replaceWith(document.createTextNode(raw));
      }
    });

    // Walk the fragment to build clean text with structure
    const lines = [];
    function walk(node) {
      if (node.nodeType === 3) {
        lines.push(node.textContent);
        return;
      }
      const tag = node.nodeName;
      if (tag === 'BR') { lines.push('\n'); return; }
      if (['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'LI', 'PRE'].includes(tag)) {
        if (lines.length && lines[lines.length - 1] !== '\n') lines.push('\n');
      }
      if (tag === 'LI') lines.push('- ');
      for (const child of node.childNodes) walk(child);
      if (['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'PRE'].includes(tag)) {
        lines.push('\n');
      }
    }
    walk(fragment);

    return lines.join('')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  chatMessages.addEventListener('mouseup', () => {
    setTimeout(() => {
      removeBtn();
      const sel = window.getSelection();
      const text = sel.toString().trim();
      if (!text) return;

      // Only show if selection is within a bot message
      const anchor = sel.anchorNode;
      if (!anchor) return;
      const msgBody = anchor.nodeType === 1
        ? anchor.closest('.msg-body')
        : anchor.parentElement?.closest('.msg-body');
      if (!msgBody) return;

      // Position to the LEFT of the selection, vertically centered
      const range = sel.getRangeAt(0);
      const rects = range.getClientRects();
      if (!rects.length) return;

      // Find the true top, bottom, and leftmost edge across all line rects
      let minLeft = Infinity, minTop = Infinity, maxBottom = -Infinity;
      for (const r of rects) {
        if (r.width === 0 && r.height === 0) continue;
        if (r.left < minLeft) minLeft = r.left;
        if (r.top < minTop) minTop = r.top;
        if (r.bottom > maxBottom) maxBottom = r.bottom;
      }
      const vertCenter = (minTop + maxBottom) / 2;

      // Check if selection contains or is inside math (KaTeX)
      const selRange = sel.getRangeAt(0);
      const selFragment = selRange.cloneContents();
      const fragmentHasMath = selFragment.querySelector('.katex') || selFragment.querySelector('.katex-display');
      const anchorInMath = anchor.nodeType === 1
        ? (anchor.closest('.katex') || anchor.closest('.katex-display'))
        : (anchor.parentElement?.closest('.katex') || anchor.parentElement?.closest('.katex-display'));
      const hasMath = fragmentHasMath || anchorInMath;

      floatingBtn = document.createElement('div');
      floatingBtn.className = 'selection-prompt-btns';
      floatingBtn.innerHTML = '<button class="sel-btn sel-ask">Ask more</button>' + (hasMath ? '<button class="sel-btn sel-derive">Derivation</button>' : '');
      document.body.appendChild(floatingBtn);

      // Position to the LEFT of the selection
      const btnW = floatingBtn.offsetWidth;
      floatingBtn.style.left = Math.max(4, minLeft - btnW - 10) + 'px';
      floatingBtn.style.top = vertCenter + 'px';
      floatingBtn.style.transform = 'translateY(-50%)';

      floatingBtn.addEventListener('mousedown', (e) => { e.preventDefault(); });

      // "Ask more" button
      floatingBtn.querySelector('.sel-ask').addEventListener('click', () => {
        const cleanText = extractCleanText(sel);
        const fullMsgContent = msgBody.querySelector('.msg-content');
        const fullContext = fullMsgContent ? fullMsgContent.textContent.trim() : cleanText;

        const refEl = document.getElementById('quote-reference');
        const refText = document.getElementById('quote-reference-text');
        refText.textContent = cleanText;
        refEl.style.display = 'flex';
        refEl._quoteText = cleanText;
        refEl._quoteFullContext = fullContext;

        chatInput.focus();
        chatSendBtn.disabled = !chatInput.value.trim();
        sel.removeAllRanges();
        removeBtn();
      });

      // "Derivation" button
      floatingBtn.querySelector('.sel-derive').addEventListener('click', async () => {
        const cleanText = extractCleanText(sel);
        sel.removeAllRanges();
        removeBtn();

        // Send derivation request as a chat message
        emptyState.style.display = 'none';
        const userMsg = { role: 'user', content: `Explain the derivation of: ${cleanText}` };
        renderMessage(userMsg);
        chatHistory.push({ role: 'user', content: `You are a math tutor. Explain step by step how to derive or work through the following. Use $$...$$ for all block math and $...$ for inline math. Show each step on its own line as a block formula.\n\n${cleanText}` });

        const botDiv = createMessageDiv('bot');
        const botBody = botDiv.querySelector('.msg-body');
        chatMessages.appendChild(botDiv);

        isStreaming = true;
        statusBar.textContent = 'Deriving...';
        document.querySelector('.input-box').classList.add('is-generating');

        try {
          const res = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages: chatHistory, stream: true, model: modelSelect.value })
          });
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let fullResponse = '', buffer = '';
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n'); buffer = lines.pop();
            for (const line of lines) {
              if (!line.trim()) continue;
              try { const d = JSON.parse(line); if (d.message?.content) { fullResponse += d.message.content; botBody.innerHTML = '<div class="msg-content">' + renderMarkdown(fullResponse) + '</div>'; } } catch {}
            }
          }
          chatHistory.push({ role: 'assistant', content: fullResponse });
          autoSaveChat();
        } catch (err) { botBody.textContent = 'Error: ' + err.message; }
        isStreaming = false;
        statusBar.textContent = '';
        document.querySelector('.input-box').classList.remove('is-generating');
      });
    }, 10);
  });

  document.addEventListener('mousedown', (e) => {
    if (floatingBtn && !floatingBtn.contains(e.target)) {
      removeBtn();
    }
  });
}

function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// ── Chat history ─────────────────────────────────────────────
async function loadChatList() {
  try {
    const res = await fetch('/api/chats');
    const chats = await res.json();
    chatList.innerHTML = '';
    chats.forEach(c => {
      const li = document.createElement('li');
      li.dataset.id = c.id;
      if (c.id === currentChatId) li.classList.add('active');
      li.innerHTML = `<span class="chat-title">${escHtml(c.title)}</span><button class="del-btn" title="Delete">&times;</button>`;
      li.querySelector('.chat-title').addEventListener('click', () => loadChat(c.id));
      li.querySelector('.del-btn').addEventListener('click', (e) => { e.stopPropagation(); deleteChat(c.id); });
      chatList.appendChild(li);
    });
  } catch {}
}

async function loadChat(id) {
  try {
    const res = await fetch(`/api/chats/${id}`);
    const chat = await res.json();
    currentChatId = id;
    chatHistory = chat.history || [];

    // Re-render messages
    chatMessages.innerHTML = '';
    emptyState.style.display = chatHistory.length === 0 ? 'block' : 'none';
    if (chatHistory.length === 0) chatMessages.appendChild(emptyState);

    chatHistory.forEach(m => renderMessage(m));
    loadChatList();
  } catch {}
}

async function deleteChat(id) {
  await fetch(`/api/chats/${id}`, { method: 'DELETE' });
  if (currentChatId === id) startNewChat();
  loadChatList();
}

function startNewChat() {
  currentChatId = null;
  chatHistory = [];
  chatMessages.innerHTML = '';
  emptyState.style.display = 'block';
  chatMessages.appendChild(emptyState);
  loadChatList();
}

async function autoSaveChat() {
  if (chatHistory.length === 0) return;
  const title = chatHistory.find(m => m.role === 'user')?.content.substring(0, 40) || 'New Chat';
  const id = currentChatId || `chat_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  await fetch('/api/chats', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, history: chatHistory, title })
  });
  currentChatId = id;
  loadChatList();
}

// ── Input dialog (replaces prompt()) ─────────────────────────
function showInputDialog(title, defaultValue = '') {
  return new Promise((resolve) => {
    const overlay = $('#input-dialog');
    const input = $('#input-dialog-input');
    const titleEl = $('#input-dialog-title');
    const okBtn = $('#input-dialog-ok');
    const cancelBtn = $('#input-dialog-cancel');

    titleEl.textContent = title;
    input.value = defaultValue;
    overlay.style.display = 'flex';
    input.focus();
    input.select();

    function close(value) {
      overlay.style.display = 'none';
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      input.removeEventListener('keydown', onKey);
      overlay.removeEventListener('click', onOverlay);
      resolve(value);
    }
    function onOk() { close(input.value.trim() || null); }
    function onCancel() { close(null); }
    function onKey(e) {
      if (e.key === 'Enter') onOk();
      if (e.key === 'Escape') onCancel();
    }
    function onOverlay(e) { if (e.target === overlay) onCancel(); }

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    input.addEventListener('keydown', onKey);
    overlay.addEventListener('click', onOverlay);
  });
}

// ══════════════════════════════════════════════════════════════
//  WINDOW MANAGER
// ══════════════════════════════════════════════════════════════
let wmWindows = {};
let wmZCounter = 500;

function wmCreateWindow({ id, title, icon, width, height }) {
  if (wmWindows[id]) { wmFocusWindow(id); return wmWindows[id].el.querySelector('.os-window-body'); }

  width = width || Math.min(900, window.innerWidth * 0.7);
  height = height || Math.min(600, window.innerHeight * 0.7);

  const win = document.createElement('div');
  win.className = 'os-window focused';
  win.style.width = width + 'px';
  win.style.height = height + 'px';
  win.style.left = ((window.innerWidth - width) / 2) + 'px';
  win.style.top = ((window.innerHeight - height) / 2) + 'px';
  win.style.zIndex = ++wmZCounter;

  win.innerHTML = `
    <div class="os-window-titlebar">
      <span class="os-titlebar-icon">${icon}</span>
      <span class="os-titlebar-title">${escHtml(title)}</span>
      <div class="os-titlebar-controls">
        <button class="win-minimize" title="Minimize">&minus;</button>
        <button class="win-close" title="Close">&times;</button>
      </div>
    </div>
    <div class="os-window-body"></div>
    <div class="os-resize-grip"></div>
  `;

  const layer = document.getElementById('window-layer');
  layer.appendChild(win);

  const titlebar = win.querySelector('.os-window-titlebar');
  const body = win.querySelector('.os-window-body');

  // Focus on click
  win.addEventListener('mousedown', () => wmFocusWindow(id));

  // Minimize
  win.querySelector('.win-minimize').addEventListener('click', (e) => { e.stopPropagation(); wmMinimizeWindow(id); });

  // Close
  win.querySelector('.win-close').addEventListener('click', (e) => { e.stopPropagation(); wmCloseWindow(id); });

  // Drag
  wmDragSetup(win, titlebar);

  // Resize
  wmResizeSetup(win, win.querySelector('.os-resize-grip'));

  // Unfocus others
  Object.values(wmWindows).forEach(w => w.el.classList.remove('focused'));

  wmWindows[id] = { id, title, icon, el: win, minimized: false };
  updateTaskbarRunning();
  return body;
}

function wmFocusWindow(id) {
  const w = wmWindows[id];
  if (!w) return;
  if (w.minimized) { w.minimized = false; w.el.classList.remove('minimized'); }
  Object.values(wmWindows).forEach(o => o.el.classList.remove('focused'));
  w.el.classList.add('focused');
  w.el.style.zIndex = ++wmZCounter;
  updateTaskbarRunning();
}

function wmMinimizeWindow(id) {
  const w = wmWindows[id];
  if (!w) return;
  // If tiled, untile first so main-panel gets full width back
  if (w.el.classList.contains('tiled')) wmUntileWindow(w.el);
  w.minimized = true;
  w.el.classList.add('minimized');
  w.el.classList.remove('focused');
  updateTaskbarRunning();
}

function wmCloseWindow(id) {
  const w = wmWindows[id];
  if (!w) return;
  // If tiled, untile first
  if (w.el.classList.contains('tiled')) wmUntileWindow(w.el);
  w.el.remove();
  delete wmWindows[id];
  updateTaskbarRunning();
}

// ── Snap / Tiling ────────────────────────────────────────────
const SNAP_EDGE = 12;

let snapPreview = null;
function showSnapPreview(side) {
  if (!snapPreview) {
    snapPreview = document.createElement('div');
    snapPreview.className = 'snap-preview';
    document.body.appendChild(snapPreview);
  }
  const sidebar = document.getElementById('sidebar');
  const sidebarW = sidebar ? sidebar.offsetWidth : 0;
  const workW = window.innerWidth - sidebarW;
  const workH = window.innerHeight - 38; // taskbar
  const halfW = Math.floor(workW / 2);
  if (side === 'right') {
    snapPreview.style.left = (sidebarW + halfW) + 'px';
    snapPreview.style.width = (workW - halfW) + 'px';
  } else {
    snapPreview.style.left = sidebarW + 'px';
    snapPreview.style.width = halfW + 'px';
  }
  snapPreview.style.top = '0';
  snapPreview.style.height = workH + 'px';
  snapPreview.style.display = 'block';
}

function hideSnapPreview() {
  if (snapPreview) snapPreview.style.display = 'none';
}

function wmTileWindow(win, winId) {
  // Save pre-tile geometry
  if (!win._preSnap) {
    win._preSnap = { left: win.style.left, top: win.style.top, width: win.style.width, height: win.style.height };
  }
  // Move from window-layer into workspace (as flex sibling of #main-panel)
  win.classList.add('tiled');
  win.style.width = '50%';
  win.style.height = '';
  const workspace = document.getElementById('workspace');
  workspace.appendChild(win);
}

function wmUntileWindow(win) {
  // Move back to window-layer
  win.classList.remove('tiled');
  const layer = document.getElementById('window-layer');
  layer.appendChild(win);
  if (win._preSnap) {
    win.style.left = win._preSnap.left;
    win.style.top = win._preSnap.top;
    win.style.width = win._preSnap.width;
    win.style.height = win._preSnap.height;
    win._preSnap = null;
  }
}

function wmDragSetup(win, titlebar) {
  let dragging = false, ox = 0, oy = 0;
  let snapSide = null;

  titlebar.addEventListener('mousedown', (e) => {
    if (e.target.closest('.os-titlebar-controls')) return;
    // If tiled, untile first
    if (win.classList.contains('tiled')) {
      const oldW = win.offsetWidth;
      wmUntileWindow(win);
      // Center cursor in restored window
      const newW = win.offsetWidth;
      ox = Math.min(newW / 2, e.clientX);
      oy = 12;
      win.style.left = (e.clientX - ox) + 'px';
      win.style.top = (e.clientY - oy) + 'px';
    } else {
      ox = e.clientX - win.offsetLeft;
      oy = e.clientY - win.offsetTop;
    }
    dragging = true;
    snapSide = null;
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const x = Math.max(0, Math.min(e.clientX - ox, window.innerWidth - 100));
    const y = Math.max(0, Math.min(e.clientY - oy, window.innerHeight - 80));
    win.style.left = x + 'px';
    win.style.top = y + 'px';

    // Detect snap to right edge only (window tiles to right, chat stays left)
    if (e.clientX >= window.innerWidth - SNAP_EDGE) {
      snapSide = 'right';
      showSnapPreview('right');
    } else {
      snapSide = null;
      hideSnapPreview();
    }
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    hideSnapPreview();
    if (snapSide) {
      wmTileWindow(win);
      snapSide = null;
    }
  });

  // Double-click titlebar to tile/untile
  titlebar.addEventListener('dblclick', (e) => {
    if (e.target.closest('.os-titlebar-controls')) return;
    if (win.classList.contains('tiled')) {
      wmUntileWindow(win);
    } else {
      wmTileWindow(win);
    }
  });
}

function wmResizeSetup(win, grip) {
  let resizing = false, startW = 0, startH = 0, startX = 0, startY = 0;
  grip.addEventListener('mousedown', (e) => {
    resizing = true;
    startW = win.offsetWidth; startH = win.offsetHeight;
    startX = e.clientX; startY = e.clientY;
    e.preventDefault(); e.stopPropagation();
  });
  document.addEventListener('mousemove', (e) => {
    if (!resizing) return;
    win.style.width = Math.max(420, startW + e.clientX - startX) + 'px';
    win.style.height = Math.max(300, startH + e.clientY - startY) + 'px';
  });
  document.addEventListener('mouseup', () => { resizing = false; });
}

// ══════════════════════════════════════════════════════════════
//  TASKBAR
// ══════════════════════════════════════════════════════════════

function initTaskbar() {
  $$('.taskbar-btn').forEach(btn => {
    btn.addEventListener('click', () => launchApp(btn.dataset.app));
  });
  updateTaskbarClock();
  setInterval(updateTaskbarClock, 30000);
}

function updateTaskbarClock() {
  const el = document.getElementById('taskbar-clock');
  if (el) el.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function updateTaskbarRunning() {
  const container = document.getElementById('taskbar-running');
  if (!container) return;
  container.innerHTML = '';
  for (const [id, w] of Object.entries(wmWindows)) {
    const btn = document.createElement('button');
    btn.className = 'taskbar-running-item' + (!w.minimized && w.el.classList.contains('focused') ? ' active' : '') + (w.minimized ? ' tb-minimized' : '');
    btn.textContent = `${w.icon} ${w.title}`;
    btn.addEventListener('click', () => {
      if (w.minimized) wmFocusWindow(id);
      else if (w.el.classList.contains('focused')) wmMinimizeWindow(id);
      else wmFocusWindow(id);
    });
    container.appendChild(btn);
  }
}

// ══════════════════════════════════════════════════════════════
//  APP REGISTRY
// ══════════════════════════════════════════════════════════════

const OS_APPS = {
  documents: { title: 'Documents', icon: '\u{1F4C1}', launch: launchDocumentsApp },
  calculator: { title: 'Calculator', icon: '\u{1F9EE}', launch: (body) => { body.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-dim);font-size:15px">\u{1F9EE} Calculator<br><br><span style="opacity:0.5">Coming soon</span></div>'; } },
  notes: { title: 'Notes', icon: '\u{1F4DD}', launch: (body) => { body.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-dim);font-size:15px">\u{1F4DD} Notes<br><br><span style="opacity:0.5">Coming soon</span></div>'; } },
  'image-viewer': { title: 'Image Viewer', icon: '\u{1F5BC}\uFE0F', launch: (body) => { body.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-dim);font-size:15px">\u{1F5BC}\uFE0F Image Viewer<br><br><span style="opacity:0.5">Coming soon</span></div>'; } },
  'knowledge-base': { title: 'Knowledge Base', icon: '\u{1F9E0}', launch: launchKnowledgeBase },
};

function launchApp(appType) {
  const app = OS_APPS[appType];
  if (!app) return;
  if (wmWindows[appType]) { wmFocusWindow(appType); return; }
  const body = wmCreateWindow({ id: appType, title: app.title, icon: app.icon });
  app.launch(body);
}

// ══════════════════════════════════════════════════════════════
//  DOCUMENTS EXPLORER (floating window)
// ══════════════════════════════════════════════════════════════
let expTree = { folders: [], documents: [] };
let expCurrentFolder = null;
let expViewMode = 'folder';
let expSelected = null;

function getFileIcon(category) {
  return { pdfs: '\u{1F4C4}', images: '\u{1F4F8}', spreadsheets: '\u{1F4CA}', other: '\u{1F4C4}' }[category] || '\u{1F4C4}';
}

async function expLoadTree() {
  try {
    const res = await fetch('/api/documents/tree');
    expTree = await res.json();
    if (!expTree.folders) expTree.folders = [];
    if (!expTree.documents) expTree.documents = [];
    console.log('[Explorer] Loaded', expTree.documents.length, 'docs,', expTree.folders.length, 'folders');
  } catch (err) {
    console.error('[Explorer] Load failed:', err);
    expTree = { folders: [], documents: [] };
  }
}

async function expRefresh() {
  await expLoadTree();
  renderSidebarDocs(); // always update sidebar
  if (!$('#exp-file-grid')) return; // explorer window not open
  expRenderNav();
  expRenderContent();
  expUpdateToolbar();
}

function expPreload() {
  expLoadTree().then(() => renderSidebarDocs());

  // Sidebar button opens documents window
  $('#open-explorer-btn').addEventListener('click', () => launchApp('documents'));

  // File input handler (shared)
  $('#doc-file-input').addEventListener('change', () => {
    const fi = $('#doc-file-input');
    const folder = fi._targetFolder || null;
    for (const file of fi.files) expUploadFile(file, folder);
    fi.value = '';
    fi._targetFolder = null;
  });

  // Sidebar collapse/expand
  $('#sidebar-toggle').addEventListener('click', collapseSidebar);
  $('#sidebar-expand').addEventListener('click', expandSidebar);
  $('#rail-new-chat').addEventListener('click', () => { expandSidebar(); startNewChat(); });
  $('#rail-documents').addEventListener('click', () => launchApp('documents'));
}

function collapseSidebar() {
  $('#sidebar').classList.add('collapsed');
  $('#sidebar-rail').style.display = 'flex';
}

function expandSidebar() {
  $('#sidebar').classList.remove('collapsed');
  $('#sidebar-rail').style.display = 'none';
}

function renderSidebarDocs() {
  // Recent files (last 8 by upload date)
  const recentEl = $('#sidebar-recent-files');
  if (!recentEl) return;
  recentEl.innerHTML = '';

  const recent = [...expTree.documents]
    .sort((a, b) => (b.uploadedAt || '').localeCompare(a.uploadedAt || ''))
    .slice(0, 8);

  if (recent.length === 0) {
    recentEl.innerHTML = '<div class="sidebar-file-item" style="opacity:0.4">No files yet</div>';
  } else {
    recent.forEach(doc => {
      const item = document.createElement('div');
      item.className = 'sidebar-file-item';
      const icon = { pdfs: '\u{1F4C4}', images: '\u{1F4F8}', spreadsheets: '\u{1F4CA}', other: '\u{1F4C4}' }[doc.category] || '\u{1F4C4}';
      item.innerHTML = `<span class="sf-icon">${icon}</span><span class="sf-name">${escHtml(doc.originalName)}</span>`;
      item.addEventListener('click', () => attachDocumentToChat(doc));
      recentEl.appendChild(item);
    });
  }

  // Document tree (folders + root files)
  const treeEl = $('#sidebar-doc-tree');
  if (!treeEl) return;
  treeEl.innerHTML = '';

  // Folders
  const folders = expTree.folders.filter(f => !f.parent).sort((a, b) => a.name.localeCompare(b.name));
  folders.forEach(folder => {
    const item = document.createElement('div');
    item.className = 'sidebar-folder-item';
    item.textContent = '\u{1F4C1} ' + folder.name;
    item.addEventListener('click', () => {
      launchApp('documents');
      // Navigate to this folder in explorer
      setTimeout(() => {
        expViewMode = 'folder';
        expCurrentFolder = folder.id;
        expSelected = null;
        if ($('#exp-file-grid')) { expRenderNav(); expRenderContent(); expUpdateToolbar(); }
      }, 300);
    });
    treeEl.appendChild(item);
  });

  // Root files (not in any folder)
  const rootDocs = expTree.documents
    .filter(d => !d.folder)
    .sort((a, b) => a.originalName.localeCompare(b.originalName))
    .slice(0, 10);

  rootDocs.forEach(doc => {
    const item = document.createElement('div');
    item.className = 'sidebar-file-item';
    const icon = { pdfs: '\u{1F4C4}', images: '\u{1F4F8}', spreadsheets: '\u{1F4CA}', other: '\u{1F4C4}' }[doc.category] || '\u{1F4C4}';
    item.innerHTML = `<span class="sf-icon">${icon}</span><span class="sf-name">${escHtml(doc.originalName)}</span>`;
    item.addEventListener('click', () => attachDocumentToChat(doc));
    treeEl.appendChild(item);
  });

  if (folders.length === 0 && rootDocs.length === 0) {
    treeEl.innerHTML = '<div class="sidebar-file-item" style="opacity:0.4">No documents</div>';
  }

}

function renderSidebarMathPresets() {
  const el = $('#sidebar-math-presets');
  if (!el || typeof MATH_COURSES === 'undefined') return;
  el.innerHTML = '';

  for (const [course, presets] of Object.entries(MATH_COURSES)) {
    const courseDiv = document.createElement('div');
    courseDiv.style.marginBottom = '6px';
    const label = document.createElement('div');
    label.className = 'sidebar-file-item';
    label.style.fontWeight = '600';
    label.style.color = 'var(--text)';
    label.textContent = course;
    courseDiv.appendChild(label);

    presets.forEach(p => {
      const btn = document.createElement('div');
      btn.className = 'sidebar-file-item';
      btn.innerHTML = `<span class="sf-icon" style="color:var(--accent)">\u{1F4CA}</span><span class="sf-name">${escHtml(p.name)}</span>`;
      btn.addEventListener('click', () => mmOpenPreset(p));
      courseDiv.appendChild(btn);
    });

    el.appendChild(courseDiv);
  }
}

function mmOpenPreset(preset) {
  emptyState.style.display = 'none';

  // User message
  renderMessage({ role: 'user', content: `Show me: ${preset.name}` });
  chatHistory.push({ role: 'user', content: `Show me the interactive visualization for ${preset.name}: $$${preset.latex}$$` });

  // Bot response with KaTeX formula + embedded graph
  const botDiv = createMessageDiv('bot');
  const botBody = botDiv.querySelector('.msg-body');
  const contentDiv = document.createElement('div');
  contentDiv.className = 'msg-content';
  contentDiv.innerHTML = renderMarkdown(`**${preset.name}** — *${preset.course}*`);
  botBody.appendChild(contentDiv);
  chatMessages.appendChild(botDiv);

  // Inject math mode inline
  mmInjectAfterFormula(null, preset, contentDiv);

  chatHistory.push({ role: 'assistant', content: `Here's the interactive visualization for **${preset.name}**:\n\n$$${preset.latex}$$\n\nDrag the sliders to adjust parameters.` });
  autoSaveChat();
}

async function launchDocumentsApp(body) {
  // Default to showing all documents so user sees their files immediately
  expViewMode = 'all';
  expCurrentFolder = null;
  expSelected = null;

  body.innerHTML = `
    <div class="explorer">
      <div class="explorer-toolbar">
        <button id="exp-new-folder" class="tool-btn" title="New Folder">\u{1F4C1} New Folder</button>
        <button id="exp-upload" class="tool-btn" title="Upload Files">\u2B06 Upload</button>
        <div class="toolbar-sep"></div>
        <button id="exp-rename" class="tool-btn" title="Rename" disabled>Rename</button>
        <button id="exp-delete" class="tool-btn" title="Delete" disabled>Delete</button>
        <button id="exp-attach" class="tool-btn primary" title="Attach to Chat" disabled>\u{1F4CE} Attach to Chat</button>
        <div style="flex:1"></div>
        <div class="explorer-breadcrumb" id="exp-breadcrumb"><span class="crumb crumb-root">Documents</span></div>
      </div>
      <div class="explorer-body">
        <div class="explorer-nav" id="exp-nav">
          <div class="nav-section-label">Quick Access</div>
          <div class="nav-item nav-recent" id="exp-nav-recent">\u{1F557} Recent</div>
          <div class="nav-item nav-all active" id="exp-nav-all">\u{1F4C4} All Documents</div>
          <div class="nav-divider"></div>
          <div class="nav-section-label">Folders</div>
          <div id="exp-nav-tree"></div>
        </div>
        <div class="explorer-content">
          <div class="explorer-drop-zone" id="exp-drop-zone">
            <div id="exp-file-grid" class="exp-grid"></div>
            <div id="exp-empty" class="exp-empty" style="display:none">
              <div class="exp-empty-icon">\u{1F4C1}</div>
              <div>This folder is empty</div>
              <div class="exp-empty-hint">Drop files here or click Upload</div>
            </div>
          </div>
        </div>
      </div>
      <div class="explorer-status" id="exp-status">Loading...</div>
    </div>
  `;
  expBindUI();
  // Load and render — retry once if data is empty (race condition safety)
  await expRefresh();
  if (expTree.documents.length === 0) {
    await new Promise(r => setTimeout(r, 500));
    await expRefresh();
  }
}

function expBindUI() {
  $('#exp-new-folder').addEventListener('click', async () => {
    const name = await showInputDialog('New folder name');
    if (!name) return;
    await fetch('/api/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, parent: expCurrentFolder }) });
    expRefresh();
  });

  $('#exp-upload').addEventListener('click', () => {
    const fi = $('#doc-file-input');
    fi._targetFolder = expCurrentFolder;
    requestAnimationFrame(() => fi.click());
  });

  $('#exp-rename').addEventListener('click', () => expRenameSelected());
  $('#exp-delete').addEventListener('click', () => expDeleteSelected());
  $('#exp-attach').addEventListener('click', () => {
    if (expSelected && expSelected.type === 'document') attachDocumentToChat(expSelected.item);
  });

  $('#exp-nav-recent').addEventListener('click', () => { expViewMode = 'recent'; expCurrentFolder = null; expSelected = null; expRenderNav(); expRenderContent(); expUpdateToolbar(); });
  $('#exp-nav-all').addEventListener('click', () => { expViewMode = 'all'; expCurrentFolder = null; expSelected = null; expRenderNav(); expRenderContent(); expUpdateToolbar(); });

  const dz = $('#exp-drop-zone');
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('drag-active'); });
  dz.addEventListener('dragleave', (e) => { if (e.target === dz || !dz.contains(e.relatedTarget)) dz.classList.remove('drag-active'); });
  dz.addEventListener('drop', (e) => {
    e.preventDefault(); dz.classList.remove('drag-active');
    if (e.dataTransfer.files.length) { for (const file of e.dataTransfer.files) expUploadFile(file, expCurrentFolder); return; }
    try {
      const data = JSON.parse(e.dataTransfer.getData('text/plain'));
      if (data.type === 'document') fetch(`/api/documents/${data.id}/move`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder: expCurrentFolder }) }).then(() => expRefresh());
    } catch {}
  });

  dz.addEventListener('contextmenu', (e) => {
    if (e.target === dz || e.target === $('#exp-file-grid') || e.target.closest('.exp-empty')) {
      e.preventDefault();
      showExplorerContextMenu(e, 'background');
    }
  });
}

// ── Nav tree ─────────────────────────────────────────────────
function expRenderNav() {
  // Highlight active nav item
  $('#exp-nav-recent').classList.toggle('active', expViewMode === 'recent');
  $('#exp-nav-all').classList.toggle('active', expViewMode === 'all');

  const tree = $('#exp-nav-tree');
  tree.innerHTML = '';
  expRenderNavFolder(null, tree, 0);
}

function expRenderNavFolder(parentId, container, depth) {
  const folders = expTree.folders
    .filter(f => (f.parent || null) === parentId)
    .sort((a, b) => a.name.localeCompare(b.name));

  folders.forEach(folder => {
    const hasChildren = expTree.folders.some(f => f.parent === folder.id);
    const isActive = expViewMode === 'folder' && expCurrentFolder === folder.id;

    const item = document.createElement('div');
    item.className = 'nav-folder-item' + (isActive ? ' active' : '') + (hasChildren ? '' : '');
    item.style.paddingLeft = (10 + depth * 14) + 'px';
    item.innerHTML = `<span class="nav-arrow">${hasChildren ? '\u25B6' : ''}</span>\u{1F4C1} ${escHtml(folder.name)}`;

    item.addEventListener('click', (e) => {
      expViewMode = 'folder';
      expCurrentFolder = folder.id;
      expSelected = null;
      expRenderNav();
      expRenderContent();
      expUpdateToolbar();
    });

    // Right-click
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showExplorerContextMenu(e, 'folder', folder);
    });

    // Drop on nav folder
    item.addEventListener('dragover', (e) => { e.preventDefault(); item.style.background = 'var(--accent-surface-hover)'; });
    item.addEventListener('dragleave', () => { item.style.background = ''; });
    item.addEventListener('drop', (e) => {
      e.preventDefault(); item.style.background = '';
      try {
        const data = JSON.parse(e.dataTransfer.getData('text/plain'));
        if (data.type === 'document') {
          fetch(`/api/documents/${data.id}/move`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ folder: folder.id })
          }).then(() => expRefresh());
        }
      } catch {}
      if (e.dataTransfer.files.length) {
        for (const file of e.dataTransfer.files) expUploadFile(file, folder.id);
      }
    });

    container.appendChild(item);

    // Children
    if (hasChildren) {
      const children = document.createElement('div');
      children.className = 'nav-folder-children';
      expRenderNavFolder(folder.id, children, depth + 1);
      container.appendChild(children);
    }
  });
}

// ── Content grid ─────────────────────────────────────────────
function expRenderContent() {
  const grid = $('#exp-file-grid');
  const empty = $('#exp-empty');
  const status = $('#exp-status');
  grid.innerHTML = '';

  let folders = [];
  let docs = [];

  if (expViewMode === 'recent') {
    docs = [...expTree.documents].sort((a, b) => (b.uploadedAt || '').localeCompare(a.uploadedAt || '')).slice(0, 30);
  } else if (expViewMode === 'all') {
    docs = [...expTree.documents].sort((a, b) => a.originalName.localeCompare(b.originalName));
  } else {
    folders = expTree.folders.filter(f => (f.parent || null) === expCurrentFolder).sort((a, b) => a.name.localeCompare(b.name));
    docs = expTree.documents.filter(d => (d.folder || null) === expCurrentFolder).sort((a, b) => a.originalName.localeCompare(b.originalName));
  }

  const hasItems = folders.length + docs.length > 0;
  empty.style.display = hasItems ? 'none' : 'flex';

  // Render folders
  folders.forEach(folder => {
    const el = document.createElement('div');
    el.className = 'exp-grid-item exp-folder-item';
    el.innerHTML = `<div class="exp-icon">\u{1F4C1}</div><div class="exp-label">${escHtml(folder.name)}</div>`;
    el.addEventListener('dblclick', () => {
      expViewMode = 'folder'; expCurrentFolder = folder.id; expSelected = null;
      expRenderNav(); expRenderContent(); expUpdateToolbar();
    });
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      expSelected = { type: 'folder', item: folder };
      expHighlightSelected(el);
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      expSelected = { type: 'folder', item: folder };
      expHighlightSelected(el);
      showExplorerContextMenu(e, 'folder', folder);
    });
    // Drop target
    el.addEventListener('dragover', (e) => { e.preventDefault(); el.style.background = 'var(--accent-surface-hover)'; });
    el.addEventListener('dragleave', () => { el.style.background = ''; });
    el.addEventListener('drop', (e) => {
      e.preventDefault(); el.style.background = '';
      try {
        const data = JSON.parse(e.dataTransfer.getData('text/plain'));
        if (data.type === 'document') {
          fetch(`/api/documents/${data.id}/move`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ folder: folder.id })
          }).then(() => expRefresh());
        }
      } catch {}
      if (e.dataTransfer.files.length) {
        for (const file of e.dataTransfer.files) expUploadFile(file, folder.id);
      }
    });
    grid.appendChild(el);
  });

  // Render documents
  docs.forEach(doc => {
    const el = document.createElement('div');
    el.className = 'exp-grid-item';
    el.draggable = true;
    el.innerHTML = `<div class="exp-icon">${getFileIcon(doc.category)}</div><div class="exp-label">${escHtml(doc.originalName)}</div>`;
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      expSelected = { type: 'document', item: doc };
      expHighlightSelected(el);
    });
    el.addEventListener('dblclick', () => attachDocumentToChat(doc));
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      expSelected = { type: 'document', item: doc };
      expHighlightSelected(el);
      showExplorerContextMenu(e, 'document', doc);
    });
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', JSON.stringify({ type: 'document', id: doc.id }));
    });
    grid.appendChild(el);
  });

  // Breadcrumb
  expRenderBreadcrumb();

  // Status
  status.textContent = `${folders.length} folder${folders.length !== 1 ? 's' : ''}, ${docs.length} file${docs.length !== 1 ? 's' : ''}`;
  if (expViewMode === 'recent') status.textContent = `${docs.length} recent file${docs.length !== 1 ? 's' : ''}`;
  if (expViewMode === 'all') status.textContent = `${docs.length} total file${docs.length !== 1 ? 's' : ''}`;

  // Click on empty area deselects
  grid.addEventListener('click', (e) => {
    if (e.target === grid) { expSelected = null; expHighlightSelected(null); }
  });
}

function expHighlightSelected(el) {
  $$('.exp-grid-item.selected').forEach(e => e.classList.remove('selected'));
  if (el) el.classList.add('selected');
  expUpdateToolbar();
}

function expUpdateToolbar() {
  const has = !!expSelected;
  $('#exp-rename').disabled = !has;
  $('#exp-delete').disabled = !has;
  $('#exp-attach').disabled = !(expSelected && expSelected.type === 'document');
}

function expRenderBreadcrumb() {
  const bc = $('#exp-breadcrumb');
  bc.innerHTML = '';

  if (expViewMode === 'recent') {
    bc.innerHTML = '<span class="crumb">Recent</span>';
    return;
  }
  if (expViewMode === 'all') {
    bc.innerHTML = '<span class="crumb">All Documents</span>';
    return;
  }

  // Build path from current folder to root
  const path = [];
  let fid = expCurrentFolder;
  while (fid) {
    const f = expTree.folders.find(x => x.id === fid);
    if (!f) break;
    path.unshift(f);
    fid = f.parent || null;
  }

  const root = document.createElement('span');
  root.className = 'crumb crumb-root';
  root.textContent = 'Documents';
  root.addEventListener('click', () => {
    expCurrentFolder = null; expSelected = null;
    expRenderNav(); expRenderContent(); expUpdateToolbar();
  });
  bc.appendChild(root);

  path.forEach(f => {
    const sep = document.createElement('span');
    sep.className = 'crumb crumb-sep';
    sep.textContent = '\u203A';
    bc.appendChild(sep);

    const crumb = document.createElement('span');
    crumb.className = 'crumb';
    crumb.textContent = f.name;
    crumb.addEventListener('click', () => {
      expCurrentFolder = f.id; expSelected = null;
      expRenderNav(); expRenderContent(); expUpdateToolbar();
    });
    bc.appendChild(crumb);
  });
}

// ── Context menu ─────────────────────────────────────────────
function showExplorerContextMenu(e, type, item) {
  closeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.id = 'doc-ctx-menu';

  if (type === 'background') {
    menu.innerHTML = `
      <div class="ctx-item" data-action="new-folder">New Folder</div>
      <div class="ctx-item" data-action="upload">Upload Files</div>
    `;
  } else if (type === 'folder') {
    menu.innerHTML = `
      <div class="ctx-item" data-action="open">Open</div>
      <div class="ctx-item" data-action="new-subfolder">New Folder Inside</div>
      <div class="ctx-item" data-action="upload-here">Upload Files Here</div>
      <div class="ctx-sep"></div>
      <div class="ctx-item" data-action="rename">Rename</div>
      <div class="ctx-item ctx-danger" data-action="delete">Delete</div>
    `;
  } else {
    menu.innerHTML = `
      <div class="ctx-item" data-action="attach">Attach to Chat</div>
      <div class="ctx-sep"></div>
      <div class="ctx-item" data-action="rename">Rename</div>
      <div class="ctx-item ctx-danger" data-action="delete">Delete</div>
    `;
  }

  document.body.appendChild(menu);
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  menu.style.left = Math.min(e.clientX, window.innerWidth - mw - 8) + 'px';
  menu.style.top = Math.min(e.clientY, window.innerHeight - mh - 8) + 'px';

  menu.addEventListener('click', async (ev) => {
    const action = ev.target.closest('.ctx-item')?.dataset.action;
    if (!action) return;
    closeContextMenu();

    if (action === 'new-folder' || action === 'new-subfolder') {
      const name = await showInputDialog('New folder name');
      if (!name) return;
      const parent = action === 'new-subfolder' ? item.id : expCurrentFolder;
      await fetch('/api/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, parent }) });
      expRefresh();
    }
    if (action === 'upload' || action === 'upload-here') {
      const fi = $('#doc-file-input');
      fi._targetFolder = action === 'upload-here' ? item.id : expCurrentFolder;
      requestAnimationFrame(() => fi.click());
    }
    if (action === 'open') {
      expViewMode = 'folder'; expCurrentFolder = item.id; expSelected = null;
      expRenderNav(); expRenderContent(); expUpdateToolbar();
    }
    if (action === 'rename') {
      const current = type === 'folder' ? item.name : item.originalName;
      const name = await showInputDialog('Rename', current);
      if (!name || name === current) return;
      const ep = type === 'folder' ? `/api/folders/${item.id}` : `/api/documents/${item.id}`;
      await fetch(ep, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
      expRefresh();
    }
    if (action === 'delete') {
      const label = type === 'folder' ? `folder "${item.name}" and all its contents` : `"${item.originalName}"`;
      if (!confirm(`Delete ${label}?`)) return;
      const ep = type === 'folder' ? `/api/folders/${item.id}` : `/api/documents/${item.id}`;
      await fetch(ep, { method: 'DELETE' });
      expSelected = null; expRefresh();
    }
    if (action === 'attach') {
      attachDocumentToChat(item);
    }
  });

  setTimeout(() => document.addEventListener('click', closeContextMenu, { once: true }), 0);
}

function closeContextMenu() {
  const old = document.getElementById('doc-ctx-menu');
  if (old) old.remove();
}

// ── Toolbar actions ──────────────────────────────────────────
async function expRenameSelected() {
  if (!expSelected) return;
  const { type, item } = expSelected;
  const current = type === 'folder' ? item.name : item.originalName;
  const name = await showInputDialog('Rename', current);
  if (!name || name === current) return;
  const ep = type === 'folder' ? `/api/folders/${item.id}` : `/api/documents/${item.id}`;
  await fetch(ep, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
  expRefresh();
}

async function expDeleteSelected() {
  if (!expSelected) return;
  const { type, item } = expSelected;
  const label = type === 'folder' ? `folder "${item.name}" and all its contents` : `"${item.originalName}"`;
  if (!confirm(`Delete ${label}?`)) return;
  const ep = type === 'folder' ? `/api/folders/${item.id}` : `/api/documents/${item.id}`;
  await fetch(ep, { method: 'DELETE' });
  expSelected = null; expRefresh();
}

// ── Upload + Attach ──────────────────────────────────────────
async function expUploadFile(file, folderId) {
  const form = new FormData();
  form.append('file', file);
  const url = folderId ? `/api/documents/upload?folder=${folderId}` : '/api/documents/upload';
  try {
    const res = await fetch(url, { method: 'POST', body: form });
    const doc = await res.json();
    if (!res.ok) throw new Error(doc.error || 'Upload failed');
    $('#exp-status').textContent = `Uploaded: ${doc.originalName}`;
    expRefresh();
  } catch (err) {
    $('#exp-status').textContent = 'Upload failed: ' + err.message;
  }
}

async function attachDocumentToChat(doc) {
  statusBar.textContent = `Loading ${doc.originalName}...`;
  try {
    const isImage = doc.category === 'images';
    const attachment = { name: doc.originalName, type: doc.mimeType, documentId: doc.id, base64: null, dataUrl: null, textContent: null };

    if (isImage) {
      const imgRes = await fetch(`/api/documents/${doc.id}/raw`);
      const blob = await imgRes.blob();
      const dataUrl = await new Promise(resolve => { const r = new FileReader(); r.onload = () => resolve(r.result); r.readAsDataURL(blob); });
      attachment.base64 = dataUrl.split(',')[1];
      attachment.dataUrl = dataUrl;
    } else if (doc.hasText) {
      const textRes = await fetch(`/api/documents/${doc.id}/text`);
      const textData = await textRes.json();
      attachment.textContent = textData.content;
    }

    attachedFiles.push(attachment);
    renderAttachedFiles();
    chatSendBtn.disabled = false;
    statusBar.textContent = `Attached: ${doc.originalName}`;

    // Minimize documents window so user sees chat
    if (wmWindows['documents']) wmMinimizeWindow('documents');
  } catch (err) {
    statusBar.textContent = 'Failed to load document: ' + err.message;
  }
}

// ── Settings ─────────────────────────────────────────────────
function initSettings() {
  // Load current config
  fetch('/api/config').then(r => r.json()).then(cfg => {
    $('#files-dir-input').value = cfg.filesDir || '';
  }).catch(() => {});

  // Load user settings (location + API key)
  fetch('/api/settings').then(r => r.json()).then(settings => {
    if (settings.userLocation) {
      userLocation = settings.userLocation;
      $('#user-location-input').value = userLocation;
    }
    if (settings.googleMapsKey) {
      $('#gmaps-key-input').value = settings.googleMapsKey;
      $('#gmaps-key-status').textContent = 'Key saved';
    }
  }).catch(() => {});

  // Save location
  $('#save-location-btn').addEventListener('click', async () => {
    const loc = $('#user-location-input').value.trim();
    userLocation = loc;
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userLocation: loc })
    });
    const status = $('#location-status');
    status.textContent = loc ? `Location set to "${loc}"` : 'Location cleared';
    setTimeout(() => status.textContent = '', 3000);
  });

  // Save Google Maps API key
  $('#save-gmaps-key-btn').addEventListener('click', async () => {
    const key = $('#gmaps-key-input').value.trim();
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ googleMapsKey: key })
    });
    const status = $('#gmaps-key-status');
    status.textContent = key ? 'Key saved' : 'Key cleared';
    setTimeout(() => status.textContent = '', 3000);
  });

  // Save path
  $('#save-dir-btn').addEventListener('click', async () => {
    const dir = $('#files-dir-input').value.trim();
    if (!dir) return;
    await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filesDir: dir })
    });
    statusBar.textContent = 'Files directory saved';
  });

  // Install model
  $('#install-model-btn').addEventListener('click', async () => {
    const name = $('#install-model-input').value.trim();
    if (!name) return;
    const progress = $('#install-progress');
    const fill = $('#install-fill');
    const status = $('#install-status');
    progress.style.display = 'block';
    fill.style.width = '0%';
    status.textContent = 'Pulling...';

    try {
      const res = await fetch('/api/pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const d = JSON.parse(line);
            if (d.total && d.completed) {
              const pct = Math.round((d.completed / d.total) * 100);
              fill.style.width = pct + '%';
              status.textContent = `${pct}% — ${d.status || ''}`;
            } else if (d.status) {
              status.textContent = d.status;
            }
          } catch {}
        }
      }
      fill.style.width = '100%';
      status.textContent = 'Done!';
      initModelPicker();
    } catch (err) {
      status.textContent = 'Error: ' + err.message;
    }
  });

  // Model catalog
  renderModelCatalog();
  $$('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderModelCatalog(btn.dataset.filter);
    });
  });
}

function updateInstalledModels(models) {
  const list = $('#installed-models');
  if (!models.length) { list.textContent = 'No models installed'; return; }
  list.innerHTML = '';
  models.forEach(m => {
    const div = document.createElement('div');
    div.className = 'model-item';
    const size = m.size ? (m.size / 1e9).toFixed(1) + ' GB' : '';
    div.innerHTML = `<span class="model-name">${escHtml(m.name)}</span><span class="model-size">${size}</span>`;
    list.appendChild(div);
  });
}

const MODEL_CATALOG = [
  // ── General ──
  { name: 'gemma3', desc: 'Google Gemma 3 — versatile, great at math & reasoning', tags: ['general'],
    sizes: ['1b', '4b', '12b', '27b'] },
  { name: 'llama3.2', desc: 'Meta Llama 3.2 — strong general purpose', tags: ['general'],
    sizes: ['1b', '3b'] },
  { name: 'llama3.1', desc: 'Meta Llama 3.1 — excellent all-rounder', tags: ['general'],
    sizes: ['8b', '70b', '405b'] },
  { name: 'llama3.3', desc: 'Meta Llama 3.3 — latest Llama', tags: ['general'],
    sizes: ['70b'] },
  { name: 'mistral', desc: 'Mistral — efficient and capable', tags: ['general'],
    sizes: ['7b'] },
  { name: 'mixtral', desc: 'Mixtral MoE — mixture of experts, very capable', tags: ['general'],
    sizes: ['8x7b', '8x22b'] },
  { name: 'phi3', desc: 'Microsoft Phi-3 — compact powerhouse', tags: ['general'],
    sizes: ['mini', 'medium', '14b'] },
  { name: 'phi4', desc: 'Microsoft Phi-4 — latest, strong reasoning', tags: ['general'],
    sizes: ['14b'] },
  { name: 'qwen2.5', desc: 'Alibaba Qwen 2.5 — multilingual, excellent', tags: ['general'],
    sizes: ['0.5b', '1.5b', '3b', '7b', '14b', '32b', '72b'] },
  { name: 'gemma2', desc: 'Google Gemma 2 — proven performer', tags: ['general'],
    sizes: ['2b', '9b', '27b'] },
  { name: 'command-r', desc: 'Cohere Command R — RAG & tool use', tags: ['general'],
    sizes: ['35b'] },
  { name: 'command-r-plus', desc: 'Cohere Command R+ — largest, best quality', tags: ['general'],
    sizes: ['104b'] },
  { name: 'deepseek-r1', desc: 'DeepSeek R1 — reasoning chain-of-thought', tags: ['general'],
    sizes: ['1.5b', '7b', '8b', '14b', '32b', '70b', '671b'] },

  // ── Code ──
  { name: 'qwen2.5-coder', desc: 'Qwen 2.5 Coder — top coding model', tags: ['code'],
    sizes: ['0.5b', '1.5b', '3b', '7b', '14b', '32b'] },
  { name: 'deepseek-coder-v2', desc: 'DeepSeek Coder V2 — code generation', tags: ['code'],
    sizes: ['16b', '236b'] },
  { name: 'codellama', desc: 'Meta Code Llama — code specialist', tags: ['code'],
    sizes: ['7b', '13b', '34b', '70b'] },
  { name: 'starcoder2', desc: 'StarCoder 2 — code completion', tags: ['code'],
    sizes: ['3b', '7b', '15b'] },
  { name: 'codegemma', desc: 'Google CodeGemma — code-tuned Gemma', tags: ['code'],
    sizes: ['2b', '7b'] },

  // ── Vision ──
  { name: 'llama3.2-vision', desc: 'Llama 3.2 Vision — image understanding', tags: ['vision'],
    sizes: ['11b', '90b'] },
  { name: 'llava', desc: 'LLaVA — vision + language', tags: ['vision'],
    sizes: ['7b', '13b', '34b'] },
  { name: 'moondream', desc: 'Moondream — tiny but capable vision', tags: ['vision'],
    sizes: ['1.8b'] },
  { name: 'llava-phi3', desc: 'LLaVA-Phi3 — lightweight vision', tags: ['vision'],
    sizes: ['3.8b'] },

  // ── Embedding ──
  { name: 'nomic-embed-text', desc: 'Nomic Embed — text embeddings', tags: ['embedding'],
    sizes: ['v1.5'] },
  { name: 'mxbai-embed-large', desc: 'MixedBread — high quality embeddings', tags: ['embedding'],
    sizes: ['335m'] },
  { name: 'snowflake-arctic-embed', desc: 'Snowflake Arctic — retrieval embeddings', tags: ['embedding'],
    sizes: ['22m', '33m', '110m', '137m', '335m'] },
];

function renderModelCatalog(filter = 'all') {
  const cat = $('#model-catalog');
  cat.innerHTML = '';
  const installedNames = models.map(m => m.name);
  const filtered = filter === 'all' ? MODEL_CATALOG : MODEL_CATALOG.filter(m => m.tags.includes(filter));

  filtered.forEach(m => {
    const card = document.createElement('div');
    card.className = 'catalog-card';

    // Check which sizes are installed
    const sizeStatuses = m.sizes.map(s => {
      const fullName = `${m.name}:${s}`;
      const isInstalled = installedNames.some(n => n === fullName || n === `${m.name}:latest` && s === m.sizes[0]);
      return { size: s, fullName, installed: isInstalled };
    });
    const anyInstalled = sizeStatuses.some(s => s.installed);

    // Build size options
    const sizeOptions = sizeStatuses.map(s =>
      `<option value="${s.fullName}" ${s.installed ? 'disabled' : ''}>${s.size}${s.installed ? ' [installed]' : ''}</option>`
    ).join('');

    card.innerHTML = `
      <h4>${escHtml(m.name)} ${anyInstalled ? '<span class="installed-badge">[installed]</span>' : ''}</h4>
      <p>${escHtml(m.desc)}</p>
      <div class="catalog-bottom">
        <span class="catalog-tag">${m.tags.join(', ')}</span>
        <div class="catalog-size-row">
          <select class="catalog-size-select">${sizeOptions}</select>
          <button class="tool-btn primary catalog-install-btn">Install</button>
        </div>
      </div>
    `;

    card.querySelector('.catalog-install-btn').addEventListener('click', () => {
      const sel = card.querySelector('.catalog-size-select');
      const modelName = sel.value;
      $('#install-model-input').value = modelName;
      $('#install-model-btn').click();
    });

    cat.appendChild(card);
  });
}

// ═══════════════════════════════════════════════════════════
//  PLACE BLOCKS — map + images + reviews + directions
// ═══════════════════════════════════════════════════════════

let _mapCounter = 0;

function _placeStars(rating) {
  if (!rating) return '';
  const full = Math.floor(rating);
  const half = rating - full >= 0.3 ? 1 : 0;
  const empty = 5 - full - half;
  return '<span class="place-stars">' +
    '&#9733;'.repeat(full) +
    (half ? '&#189;' : '') +
    '<span class="place-stars-empty">' + '&#9733;'.repeat(empty) + '</span>' +
    '</span>';
}

function _placeMarkerIcon() {
  return L.divIcon({
    className: 'place-marker',
    html: '<div class="place-marker-pin"></div>',
    iconSize: [24, 34], iconAnchor: [12, 34]
  });
}

function initMapsInElement(container) {
  if (typeof L === 'undefined') return;

  container.querySelectorAll('pre code').forEach(codeEl => {
    const text = codeEl.textContent.trim();
    const isMapClass = codeEl.className.includes('language-map');
    let mapData = null;

    if (isMapClass || (text.startsWith('{') && text.includes('"q"'))) {
      try { mapData = JSON.parse(text); } catch {
        const m = text.match(/\{[\s\S]*\}/);
        if (m) try { mapData = JSON.parse(m[0]); } catch {}
      }
    }
    if (!mapData || !mapData.q) return;

    const preEl = codeEl.closest('pre');
    if (!preEl) return;

    const mapId = 'lmap-' + (++_mapCounter);
    const query = mapData.q;
    const label = mapData.label || query;
    const directionsUrl = userLocation
      ? `https://www.google.com/maps/dir/${encodeURIComponent(userLocation)}/${encodeURIComponent(query)}`
      : `https://www.google.com/maps/dir//${encodeURIComponent(query)}`;

    const block = document.createElement('div');
    block.className = 'place-block';
    block.innerHTML = `
      <div class="place-block-left">
        <div class="place-block-map" id="${mapId}"></div>
      </div>
      <div class="place-block-right">
        <div class="place-block-header">
          <div class="place-block-name">${escHtml(label)}</div>
          <div class="place-block-meta" id="${mapId}-meta"></div>
        </div>
        <div class="place-block-address" id="${mapId}-addr">Locating...</div>
        <div class="place-block-photos" id="${mapId}-photos">
          <div class="place-photos-loading">Loading photos...</div>
        </div>
        <div class="place-block-reviews" id="${mapId}-reviews"></div>
        <div class="place-block-actions">
          <a class="place-btn place-btn-directions" href="${directionsUrl}" target="_blank" rel="noopener">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="3 11 22 2 13 21 11 13 3 11"/></svg>
            Get Directions
          </a>
          <a class="place-btn place-btn-open" href="https://www.google.com/maps/search/${encodeURIComponent(query)}" target="_blank" rel="noopener">
            Google Maps
          </a>
        </div>
      </div>
    `;

    preEl.replaceWith(block);

    // ── Init Leaflet map (hidden until geocoded) ──
    let map = null;
    let mapLocated = false;

    function initMap() {
      if (map) return map;
      map = L.map(mapId, {
        scrollWheelZoom: false,
        zoomControl: false,
        dragging: true,
        attributionControl: false
      }).setView([0, 0], 2);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
      return map;
    }

    function placePin(lat, lng, zoom) {
      const m = initMap();
      m.setView([lat, lng], zoom || 16);
      L.marker([lat, lng], { icon: _placeMarkerIcon() }).addTo(m);
      mapLocated = true;
      setTimeout(() => m.invalidateSize(), 200);
    }

    function nominatimFallback() {
      return fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1`, {
        headers: { 'Accept': 'application/json' }
      }).then(r => r.json()).then(results => {
        if (results && results.length > 0) {
          placePin(parseFloat(results[0].lat), parseFloat(results[0].lon), mapData.zoom || 15);
          const addrEl = document.getElementById(mapId + '-addr');
          if (addrEl) addrEl.textContent = results[0].display_name;
          return true;
        }
        return false;
      }).catch(() => false);
    }

    function fillCard(data) {
      const addrEl = document.getElementById(mapId + '-addr');
      const metaEl = document.getElementById(mapId + '-meta');
      const photosEl = document.getElementById(mapId + '-photos');
      const reviewsEl = document.getElementById(mapId + '-reviews');

      // Name
      if (data.name) {
        const nameEl = block.querySelector('.place-block-name');
        if (nameEl) nameEl.textContent = data.name;
      }

      // Rating meta
      if (metaEl) {
        let h = '';
        if (data.rating) {
          h += `${_placeStars(data.rating)} <span class="place-rating-num">${data.rating}</span>`;
          if (data.totalRatings) h += ` <span class="place-rating-count">(${data.totalRatings.toLocaleString()})</span>`;
        }
        if (data.priceLevel != null) h += ` <span class="place-price">${'$'.repeat(data.priceLevel + 1)}</span>`;
        if (data.openNow === true) h += ' <span class="place-open">Open</span>';
        else if (data.openNow === false) h += ' <span class="place-closed">Closed</span>';
        metaEl.innerHTML = h;
      }

      // Photos
      if (photosEl) {
        if (data.images && data.images.length > 0) {
          photosEl.innerHTML = '';
          data.images.forEach(img => {
            const el = document.createElement('img');
            el.src = img.src.startsWith('/api/') ? img.src : `/api/web/image-proxy?url=${encodeURIComponent(img.src)}`;
            el.alt = img.alt || label;
            el.loading = 'lazy';
            el.addEventListener('click', () => openLightbox(el.src));
            el.addEventListener('error', () => el.remove());
            photosEl.appendChild(el);
          });
        } else {
          photosEl.innerHTML = '';
        }
      }

      // Reviews
      if (reviewsEl && data.reviews && data.reviews.length > 0) {
        reviewsEl.innerHTML = data.reviews.map(rv => {
          const stars = rv.rating ? _placeStars(rv.rating) : '';
          const author = rv.author ? `<span class="place-review-author">${escHtml(rv.author)}</span>` : '';
          const time = rv.time ? `<span class="place-review-time">${escHtml(rv.time)}</span>` : '';
          const source = rv.source ? `<span class="place-review-source">${escHtml(rv.source)}</span>` : '';
          return `<div class="place-review">
            <div class="place-review-header">${author}${stars}${time}</div>
            <div class="place-review-text">"${escHtml(rv.text)}"</div>
            ${source}
          </div>`;
        }).join('');
      }
    }

    // ── Fetch place details ──
    fetch(`/api/web/place-details?q=${encodeURIComponent(query)}`)
      .then(r => r.json())
      .then(async (data) => {
        // Geocode: Google coords first, then Nominatim
        if (data.lat && data.lng) {
          placePin(parseFloat(data.lat), parseFloat(data.lng), mapData.zoom);
          const addrEl = document.getElementById(mapId + '-addr');
          if (addrEl) addrEl.textContent = data.address || query;
        } else {
          const found = await nominatimFallback();
          if (!found) {
            // Can't locate this place — collapse the block to a simple link
            block.classList.add('place-block-nogeo');
            const addrEl = document.getElementById(mapId + '-addr');
            if (addrEl) addrEl.textContent = query;
          }
        }

        fillCard(data);
      })
      .catch(async () => {
        const found = await nominatimFallback();
        if (!found) block.classList.add('place-block-nogeo');
        const photosEl = document.getElementById(mapId + '-photos');
        if (photosEl) photosEl.innerHTML = '';
      });

    // Init map lazily (in case details come back fast with coords)
    initMap();
    setTimeout(() => { if (map) map.invalidateSize(); }, 400);
  });
}

// ═══════════════════════════════════════════════════════════
//  WEB MODE — streaming agent with site block cards
// ═══════════════════════════════════════════════════════════


// ══════════════════════════════════════════════════════════════
//  RAG MODE — toggle, context injection, sources card
// ══════════════════════════════════════════════════════════════

function initRAGMode() {
  const toggle = document.getElementById('rag-mode-toggle');
  if (!toggle) return;
  toggle.addEventListener('click', () => {
    ragModeEnabled = !ragModeEnabled;
    toggle.classList.toggle('active', ragModeEnabled);
    toggle.title = ragModeEnabled ? 'RAG mode ON — queries your knowledge base' : 'RAG mode OFF';
  });
}

function renderRAGSourcesCard(sources) {
  const card = document.createElement('div');
  card.className = 'web-results-card rag-sources-card';

  const header = document.createElement('div');
  header.className = 'web-results-header';
  header.innerHTML = `<span>\u{1F4DA} Knowledge Base (${sources.length} sources)</span><span class="toggle-icon">&#9660;</span>`;
  header.addEventListener('click', () => card.classList.toggle('collapsed'));
  card.appendChild(header);

  const body = document.createElement('div');
  body.className = 'web-results-body';
  sources.forEach(s => {
    const item = document.createElement('div');
    item.className = 'web-source-item';
    const pct = (s.score * 100).toFixed(0);
    item.innerHTML = `
      <span class="rag-source-icon">\u{1F4C4}</span>
      <div class="web-source-info">
        <div class="web-source-title">${escHtml(s.documentName)}</div>
        <div class="web-source-domain">Relevance: ${pct}%</div>
      </div>
    `;
    body.appendChild(item);
  });
  card.appendChild(body);
  return card;
}

// ══════════════════════════════════════════════════════════════
//  KNOWLEDGE BASE APP (floating window)
// ══════════════════════════════════════════════════════════════
let kbIndexedDocs = [];
let kbDocTree = { folders: [], documents: [] };
let kbViewMode = 'indexed';   // 'indexed' | 'search' | 'browse'
let kbSelected = null;
let kbCurrentFolder = null;

async function launchKnowledgeBase(body) {
  kbViewMode = 'indexed';
  kbSelected = null;
  kbCurrentFolder = null;

  body.innerHTML = `
    <div class="explorer kb-panel">
      <div class="explorer-toolbar">
        <div class="kb-search-bar">
          <input type="text" id="kb-search-input" class="kb-search-input" placeholder="Semantic search your documents...">
          <button id="kb-search-btn" class="tool-btn primary">Search</button>
        </div>
        <div class="toolbar-sep"></div>
        <button id="kb-index-sel" class="tool-btn" title="Index selected" disabled>\u2B06 Index</button>
        <button id="kb-remove-sel" class="tool-btn" title="Remove from index" disabled>\u2716 Remove</button>
        <button id="kb-index-all" class="tool-btn" title="Index all documents">\u{1F504} Index All</button>
      </div>
      <div class="explorer-body">
        <div class="explorer-nav" id="kb-nav">
          <div class="nav-section-label">Views</div>
          <div class="nav-item active" id="kb-nav-indexed">\u{1F9E0} Indexed Documents</div>
          <div class="nav-item" id="kb-nav-browse">\u{1F4C1} Browse &amp; Index</div>
          <div class="nav-divider"></div>
          <div class="nav-section-label">Folders</div>
          <div id="kb-nav-tree"></div>
          <div class="nav-divider"></div>
          <div id="kb-stats" class="kb-stats"></div>
        </div>
        <div class="explorer-content">
          <div id="kb-content" class="kb-content-area">
            <div id="kb-grid" class="exp-grid"></div>
            <div id="kb-search-results" class="kb-search-results" style="display:none"></div>
            <div id="kb-empty" class="exp-empty" style="display:none">
              <div class="exp-empty-icon">\u{1F9E0}</div>
              <div>No indexed documents yet</div>
              <div class="exp-empty-hint">Switch to "Browse & Index" to add documents, or click "Index All"</div>
            </div>
            <div id="kb-detail" class="kb-detail-panel" style="display:none"></div>
          </div>
        </div>
      </div>
      <div class="explorer-status" id="kb-status">Loading...</div>
    </div>
  `;

  kbBindUI();
  await kbRefresh();
}

function kbBindUI() {
  // Search
  $('#kb-search-btn').addEventListener('click', () => kbDoSearch());
  $('#kb-search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') kbDoSearch();
  });

  // Nav
  $('#kb-nav-indexed').addEventListener('click', () => {
    kbViewMode = 'indexed'; kbSelected = null;
    kbRenderNav(); kbRenderContent();
  });
  $('#kb-nav-browse').addEventListener('click', () => {
    kbViewMode = 'browse'; kbCurrentFolder = null; kbSelected = null;
    kbRenderNav(); kbRenderContent();
  });

  // Toolbar
  $('#kb-index-sel').addEventListener('click', () => kbIndexSelected());
  $('#kb-remove-sel').addEventListener('click', () => kbRemoveSelected());
  $('#kb-index-all').addEventListener('click', () => kbIndexAll());
}

async function kbRefresh() {
  try {
    const [indexRes, treeRes] = await Promise.all([
      fetch('/api/rag/index'),
      fetch('/api/documents/tree'),
    ]);
    const indexData = await indexRes.json();
    const treeData = await treeRes.json();
    kbIndexedDocs = indexData.documents || [];
    kbDocTree = treeData;
  } catch (err) {
    console.error('[KB] Refresh failed:', err);
  }
  kbRenderNav();
  kbRenderContent();
  kbRenderStats();
}

function kbRenderNav() {
  const navIndexed = $('#kb-nav-indexed');
  const navBrowse = $('#kb-nav-browse');
  if (!navIndexed) return;
  navIndexed.classList.toggle('active', kbViewMode === 'indexed');
  navBrowse.classList.toggle('active', kbViewMode === 'browse');

  const tree = $('#kb-nav-tree');
  if (!tree) return;
  tree.innerHTML = '';
  if (kbViewMode === 'browse') {
    kbRenderNavFolder(null, tree, 0);
  }
}

function kbRenderNavFolder(parentId, container, depth) {
  const folders = kbDocTree.folders
    .filter(f => (f.parent || null) === parentId)
    .sort((a, b) => a.name.localeCompare(b.name));

  folders.forEach(folder => {
    const hasChildren = kbDocTree.folders.some(f => f.parent === folder.id);
    const isActive = kbViewMode === 'browse' && kbCurrentFolder === folder.id;

    // Count docs in this folder that are indexed
    const docsInFolder = kbDocTree.documents.filter(d => d.folder === folder.id);
    const indexedCount = docsInFolder.filter(d => kbIndexedDocs.some(i => i.docId === d.id)).length;

    const item = document.createElement('div');
    item.className = 'nav-folder-item' + (isActive ? ' active' : '');
    item.style.paddingLeft = (10 + depth * 14) + 'px';
    item.innerHTML = `<span class="nav-arrow">${hasChildren ? '\u25B6' : ''}</span>\u{1F4C1} ${escHtml(folder.name)} ${indexedCount ? '<span class="kb-folder-badge">' + indexedCount + '</span>' : ''}`;

    item.addEventListener('click', () => {
      kbViewMode = 'browse'; kbCurrentFolder = folder.id; kbSelected = null;
      kbRenderNav(); kbRenderContent();
    });

    // Right-click: index entire folder
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      kbShowFolderMenu(e, folder);
    });

    container.appendChild(item);
    if (hasChildren) {
      const children = document.createElement('div');
      children.className = 'nav-folder-children';
      kbRenderNavFolder(folder.id, children, depth + 1);
      container.appendChild(children);
    }
  });
}

function kbShowFolderMenu(e, folder) {
  closeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.id = 'doc-ctx-menu';
  menu.innerHTML = `
    <div class="ctx-item" data-action="index-folder">\u2B06 Index Entire Folder</div>
    <div class="ctx-item" data-action="open-folder">Open</div>
  `;
  document.body.appendChild(menu);
  menu.style.left = Math.min(e.clientX, window.innerWidth - menu.offsetWidth - 8) + 'px';
  menu.style.top = Math.min(e.clientY, window.innerHeight - menu.offsetHeight - 8) + 'px';

  menu.addEventListener('click', async (ev) => {
    const action = ev.target.closest('.ctx-item')?.dataset.action;
    if (!action) return;
    closeContextMenu();
    if (action === 'index-folder') {
      await kbIndexFolder(folder.id, folder.name);
    }
    if (action === 'open-folder') {
      kbViewMode = 'browse'; kbCurrentFolder = folder.id; kbSelected = null;
      kbRenderNav(); kbRenderContent();
    }
  });
  setTimeout(() => document.addEventListener('click', closeContextMenu, { once: true }), 0);
}

function kbRenderContent() {
  const grid = $('#kb-grid');
  const empty = $('#kb-empty');
  const searchResults = $('#kb-search-results');
  const detail = $('#kb-detail');
  const status = $('#kb-status');
  if (!grid) return;

  grid.innerHTML = '';
  grid.style.display = '';
  searchResults.style.display = 'none';
  detail.style.display = 'none';

  if (kbViewMode === 'search') {
    grid.style.display = 'none';
    searchResults.style.display = '';
    empty.style.display = 'none';
    return;
  }

  if (kbViewMode === 'indexed') {
    if (kbIndexedDocs.length === 0) {
      empty.style.display = 'flex';
      status.textContent = 'No documents indexed';
      kbUpdateToolbar();
      return;
    }
    empty.style.display = 'none';

    kbIndexedDocs.forEach(idoc => {
      const manifest = kbDocTree.documents.find(d => d.id === idoc.docId);
      const name = manifest?.originalName || idoc.docId;
      const meta = idoc.metadata || {};

      const el = document.createElement('div');
      el.className = 'exp-grid-item kb-indexed-item';
      el.innerHTML = `
        <div class="exp-icon">\u{1F9E0}</div>
        <div class="exp-label">${escHtml(name)}</div>
        <div class="kb-item-meta">${meta.document_type || ''} \u00B7 ${idoc.chunks} chunks</div>
      `;
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        kbSelected = { type: 'indexed', docId: idoc.docId, name };
        kbHighlightSelected(el);
      });
      el.addEventListener('dblclick', () => kbShowDetail(idoc, name));
      grid.appendChild(el);
    });

    status.textContent = `${kbIndexedDocs.length} document${kbIndexedDocs.length !== 1 ? 's' : ''} indexed`;
  }

  if (kbViewMode === 'browse') {
    const folders = kbDocTree.folders
      .filter(f => (f.parent || null) === kbCurrentFolder)
      .sort((a, b) => a.name.localeCompare(b.name));
    const docs = kbDocTree.documents
      .filter(d => (d.folder || null) === kbCurrentFolder)
      .sort((a, b) => a.originalName.localeCompare(b.originalName));

    if (folders.length + docs.length === 0) {
      empty.style.display = 'flex';
      empty.querySelector('.exp-empty-hint').textContent = 'Upload documents via the Documents app first';
    } else {
      empty.style.display = 'none';
    }

    folders.forEach(folder => {
      const docsIn = kbDocTree.documents.filter(d => d.folder === folder.id);
      const indexed = docsIn.filter(d => kbIndexedDocs.some(i => i.docId === d.id)).length;

      const el = document.createElement('div');
      el.className = 'exp-grid-item exp-folder-item';
      el.innerHTML = `
        <div class="exp-icon">\u{1F4C1}</div>
        <div class="exp-label">${escHtml(folder.name)}</div>
        <div class="kb-item-meta">${indexed}/${docsIn.length} indexed</div>
      `;
      el.addEventListener('dblclick', () => {
        kbCurrentFolder = folder.id; kbSelected = null;
        kbRenderNav(); kbRenderContent();
      });
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        kbSelected = { type: 'folder', item: folder };
        kbHighlightSelected(el);
      });
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        kbShowFolderMenu(e, folder);
      });
      grid.appendChild(el);
    });

    docs.forEach(doc => {
      const isIndexed = kbIndexedDocs.some(i => i.docId === doc.id);
      const el = document.createElement('div');
      el.className = 'exp-grid-item' + (isIndexed ? ' kb-is-indexed' : '');
      el.innerHTML = `
        <div class="exp-icon">${getFileIcon(doc.category)}</div>
        <div class="exp-label">${escHtml(doc.originalName)}</div>
        <div class="kb-item-meta">${isIndexed ? '\u2705 Indexed' : '\u2B55 Not indexed'}${doc.hasText ? '' : ' \u00B7 No text'}</div>
      `;
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        kbSelected = { type: 'document', item: doc, isIndexed };
        kbHighlightSelected(el);
      });
      grid.appendChild(el);
    });

    status.textContent = `${folders.length} folder${folders.length !== 1 ? 's' : ''}, ${docs.length} file${docs.length !== 1 ? 's' : ''}`;
  }

  grid.addEventListener('click', (e) => {
    if (e.target === grid) { kbSelected = null; kbHighlightSelected(null); }
  });

  kbUpdateToolbar();
}

function kbHighlightSelected(el) {
  $$('.kb-panel .exp-grid-item.selected').forEach(e => e.classList.remove('selected'));
  if (el) el.classList.add('selected');
  kbUpdateToolbar();
}

function kbUpdateToolbar() {
  const indexBtn = $('#kb-index-sel');
  const removeBtn = $('#kb-remove-sel');
  if (!indexBtn) return;

  if (kbSelected?.type === 'document' && kbSelected.item.hasText && !kbSelected.isIndexed) {
    indexBtn.disabled = false;
  } else if (kbSelected?.type === 'folder') {
    indexBtn.disabled = false;
  } else {
    indexBtn.disabled = true;
  }

  removeBtn.disabled = !(kbSelected?.type === 'indexed');
}

function kbRenderStats() {
  const el = $('#kb-stats');
  if (!el) return;
  const totalChunks = kbIndexedDocs.reduce((sum, d) => sum + (d.chunks || 0), 0);
  const totalDocs = kbDocTree.documents.length;
  el.innerHTML = `
    <div class="kb-stat">\u{1F4CA} ${kbIndexedDocs.length} / ${totalDocs} indexed</div>
    <div class="kb-stat">\u{1F9E9} ${totalChunks} chunks</div>
  `;
}

// ── Actions ──

async function kbDoSearch() {
  const q = $('#kb-search-input').value.trim();
  if (!q) return;

  kbViewMode = 'search';
  kbRenderNav();
  kbRenderContent();

  const results = $('#kb-search-results');
  const status = $('#kb-status');
  results.innerHTML = '<div class="kb-searching">Searching<span class="dots"></span></div>';
  status.textContent = 'Searching...';

  try {
    const res = await fetch(`/api/rag/search?q=${encodeURIComponent(q)}&top_k=10`);
    const data = await res.json();

    if (!data.results || data.results.length === 0) {
      results.innerHTML = '<div class="kb-no-results">No results found. Try indexing more documents.</div>';
      status.textContent = '0 results';
      return;
    }

    results.innerHTML = '';
    data.results.forEach((r, i) => {
      const pct = (r.weightedScore * 100).toFixed(1);
      const sim = (r.similarity * 100).toFixed(1);
      const item = document.createElement('div');
      item.className = 'kb-result-item';
      item.innerHTML = `
        <div class="kb-result-header">
          <span class="kb-result-rank">#${i + 1}</span>
          <span class="kb-result-name">${escHtml(r.documentName)}</span>
          <span class="kb-result-score">${pct}% weighted \u00B7 ${sim}% similarity</span>
        </div>
        <div class="kb-result-meta">
          ${r.metadata?.document_type ? `<span class="kb-tag">${r.metadata.document_type}</span>` : ''}
          ${r.metadata?.primary_topic ? `<span class="kb-tag">${r.metadata.primary_topic}</span>` : ''}
          ${(r.metadata?.context_tags || []).map(t => `<span class="kb-tag">${escHtml(t)}</span>`).join('')}
        </div>
        <div class="kb-result-text">${escHtml(r.chunkText || '')}</div>
      `;
      results.appendChild(item);
    });

    status.textContent = `${data.results.length} result${data.results.length !== 1 ? 's' : ''} for "${q}"`;
  } catch (err) {
    results.innerHTML = `<div class="kb-no-results">Search failed: ${escHtml(err.message)}</div>`;
    status.textContent = 'Search error';
  }
}

async function kbIndexSelected() {
  if (!kbSelected) return;
  const status = $('#kb-status');

  if (kbSelected.type === 'folder') {
    await kbIndexFolder(kbSelected.item.id, kbSelected.item.name);
    return;
  }

  if (kbSelected.type === 'document') {
    const doc = kbSelected.item;
    status.textContent = `Indexing ${doc.originalName}...`;
    try {
      const model = modelSelect.value;
      const res = await fetch(`/api/rag/index/${doc.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Index failed');
      status.textContent = `Indexed ${doc.originalName} (${data.chunksIndexed} chunks)`;
      await kbRefresh();
    } catch (err) {
      status.textContent = `Index failed: ${err.message}`;
    }
  }
}

async function kbIndexFolder(folderId, folderName) {
  const status = $('#kb-status');
  status.textContent = `Indexing folder "${folderName}"...`;
  try {
    const model = modelSelect.value;
    const res = await fetch(`/api/rag/index-folder/${folderId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Index failed');
    status.textContent = `Indexed folder "${folderName}": ${data.indexed} docs, ${data.errors} errors`;
    await kbRefresh();
  } catch (err) {
    status.textContent = `Folder index failed: ${err.message}`;
  }
}

async function kbRemoveSelected() {
  if (!kbSelected || kbSelected.type !== 'indexed') return;
  const status = $('#kb-status');
  status.textContent = `Removing ${kbSelected.name}...`;
  try {
    await fetch(`/api/rag/index/${kbSelected.docId}`, { method: 'DELETE' });
    status.textContent = `Removed ${kbSelected.name} from index`;
    kbSelected = null;
    await kbRefresh();
  } catch (err) {
    status.textContent = `Remove failed: ${err.message}`;
  }
}

async function kbIndexAll() {
  const status = $('#kb-status');
  status.textContent = 'Indexing all documents... this may take a while';
  try {
    const model = modelSelect.value;
    const res = await fetch('/api/rag/index-all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Index failed');
    status.textContent = `Done! Indexed ${data.indexed} documents, ${data.errors} errors`;
    await kbRefresh();
  } catch (err) {
    status.textContent = `Index all failed: ${err.message}`;
  }
}

function kbShowDetail(idoc, name) {
  const detail = $('#kb-detail');
  const grid = $('#kb-grid');
  if (!detail) return;

  grid.style.display = 'none';
  detail.style.display = '';

  const meta = idoc.metadata || {};
  const tags = (meta.context_tags || []).map(t => `<span class="kb-tag">${escHtml(t)}</span>`).join(' ');
  const entities = (meta.key_entities || []).map(e => `<span class="kb-tag kb-entity-tag">${escHtml(e)}</span>`).join(' ');

  detail.innerHTML = `
    <div class="kb-detail-header">
      <button class="tool-btn kb-back-btn">\u2190 Back</button>
      <h3>${escHtml(name)}</h3>
    </div>
    <div class="kb-detail-body">
      <div class="kb-detail-row"><label>Topic</label><span>${escHtml(meta.primary_topic || 'N/A')}</span></div>
      <div class="kb-detail-row"><label>Type</label><span>${escHtml(meta.document_type || 'N/A')}</span></div>
      <div class="kb-detail-row"><label>Technical Depth</label><span>${depthBar(meta.technical_depth || 0)}</span></div>
      <div class="kb-detail-row"><label>Priority</label><span>${priorityBadge(meta.priority_weight || 5)}</span></div>
      <div class="kb-detail-row"><label>Complexity</label><span>${escHtml(meta.language_complexity || 'N/A')}</span></div>
      <div class="kb-detail-row"><label>Chunks</label><span>${idoc.chunks} (${meta.suggested_chunk_size || 512} tokens each)</span></div>
      <div class="kb-detail-row"><label>Summary</label><span>${escHtml(meta.summary || 'N/A')}</span></div>
      <div class="kb-detail-row"><label>Tags</label><span>${tags || 'None'}</span></div>
      <div class="kb-detail-row"><label>Entities</label><span>${entities || 'None'}</span></div>
      <div class="kb-detail-row"><label>Indexed</label><span>${idoc.indexedAt ? new Date(idoc.indexedAt).toLocaleString() : 'Unknown'}</span></div>
    </div>
  `;

  detail.querySelector('.kb-back-btn').addEventListener('click', () => {
    detail.style.display = 'none';
    grid.style.display = '';
  });
}

function depthBar(val) {
  const pct = Math.round(val * 100);
  const labels = ['General', 'Familiar', 'Practitioner', 'Deep', 'Expert'];
  const idx = Math.min(4, Math.floor(val * 5));
  return `<div class="kb-depth-bar"><div class="kb-depth-fill" style="width:${pct}%"></div></div><span class="kb-depth-label">${labels[idx]} (${pct}%)</span>`;
}

function priorityBadge(val) {
  const colors = ['', '', 'var(--text-dim)', 'var(--text-dim)', 'var(--yellow)', 'var(--yellow)', 'var(--text)', 'var(--green)', 'var(--green)', 'var(--accent)', 'var(--accent)'];
  return `<span class="kb-priority-badge" style="color:${colors[val] || 'var(--text)'}">${val}/10</span>`;
}
