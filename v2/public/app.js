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
let webModeEnabled = false;
let userLocation = localStorage.getItem('userLocation') || '';

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
  loadFileTree();
  initSettings();
  initChatInput();
  initFileAttach();
  initUploadZone();
  initWebMode();
});

// ── Tab switching ────────────────────────────────────────────
function initTabs() {
  $$('#top-tabs .tab').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('#top-tabs .tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      $$('.tab-panel').forEach(p => p.classList.remove('active'));
      $(`#tab-${btn.dataset.tab}`).classList.add('active');
      // Lazy-init browser tab
      if (btn.dataset.tab === 'browser' && typeof initBrowser === 'function') initBrowser();
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
}

function populateModelSelect(select, models) {
  const current = select.value;
  select.innerHTML = '';
  models.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m.name;
    opt.textContent = m.name;
    select.appendChild(opt);
  });
  if (models.some(m => m.name === current)) select.value = current;
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

// ── File attachment ──────────────────────────────────────────
function initFileAttach() {
  chatAttachBtn.addEventListener('click', () => {
    requestAnimationFrame(() => chatFileInput.click());
  });
  chatFileInput.addEventListener('change', () => {
    for (const file of chatFileInput.files) readFileAsAttachment(file);
    chatFileInput.value = '';
  });
}

function readFileAsAttachment(file) {
  const reader = new FileReader();
  reader.onload = () => {
    const isImage = file.type.startsWith('image/');
    attachedFiles.push({
      name: file.name,
      type: file.type,
      base64: isImage ? reader.result.split(',')[1] : null,
      dataUrl: isImage ? reader.result : null,
      textContent: !isImage ? reader.result : null,
    });
    renderAttachedFiles();
    chatSendBtn.disabled = false;
  };
  if (file.type.startsWith('image/')) reader.readAsDataURL(file);
  else reader.readAsText(file);
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

  // ── Web mode: tiny model query → parallel scrape → 3 large AI cards ──
  let webContext = null;
  if (webModeEnabled && !images.length) {

    // Status card
    const searchCard = document.createElement('div');
    searchCard.className = 'wsearch-card';
    searchCard.innerHTML = `
      <div class="wsearch-bar">
        <svg class="wsearch-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <span class="wsearch-query">${escHtml(text.slice(0, 80))}</span>
      </div>
      <div class="wsearch-footer">
        <div class="wsearch-spinner"></div>
        <span class="wsearch-status">Starting…</span>
      </div>`;
    chatMessages.appendChild(searchCard);
    const statusEl = searchCard.querySelector('.wsearch-status');
    scrollToBottom();

    // Step 1 — smollm2:135m generates a tight search query
    const searchQuery = await getSearchQuery(text, statusEl);
    statusEl.textContent = `Searching: "${searchQuery}"…`;

    // Step 2 — DDG + 3 parallel page scrapes
    let pages = [];
    if (typeof browserSearchFast === 'function') {
      pages = await browserSearchFast(searchQuery, 3);
    }

    // Collapse status card
    searchCard.classList.add('done');
    searchCard.innerHTML = `
      <div class="wsearch-done-bar">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        Web search · ${escHtml(searchQuery.slice(0, 60))} · ${pages.length} source${pages.length !== 1 ? 's' : ''}
      </div>`;

    if (pages.length > 0) {
      // Step 3 — render 3 large cards immediately (webviews load live sites)
      const cardsList = document.createElement('div');
      cardsList.className = 'wresults-list';
      pages.forEach(page => cardsList.appendChild(buildLargeWebCard(page)));
      chatMessages.appendChild(cardsList);
      scrollToBottom();

      // Step 4 — fire 3 independent parallel AI overviews, each streaming into its card
      pages.forEach((page, i) => runCardAI(page, cardsList.children[i], modelSelect.value));

      // Context for the main chat response
      webContext = {
        contextForLLM: pages.map((p, i) =>
          `Source ${i+1}: ${p.title} (${p.url})\n${p.text.slice(0, 900)}`
        ).join('\n\n---\n\n')
      };
    }
  }

  // ── Places pre-fetch for location queries ──
  let placesData = null;
  if (webModeEnabled && userLocation) {
    const placeKW = ['restaurant','cafe','coffee','hotel','bar','museum','park','store','shop',
      'pharmacy','hospital','gym','pizza','sushi','burger','food','eat','drink','brunch',
      'dinner','lunch','bakery','thai','chinese','japanese','italian','mexican','near me','nearby'];
    const lowerText = text.toLowerCase();
    if (placeKW.some(kw => lowerText.includes(kw))) {
      try {
        const pRes = await fetch(`/api/web/search-places?q=${encodeURIComponent(text)}&near=${encodeURIComponent(userLocation)}&max=4`);
        const pData = await pRes.json();
        if (pData.places && pData.places.length > 0) {
          placesData = pData.places;
          const grid = document.createElement('div');
          grid.className = 'places-grid';
          placesData.forEach(place => grid.appendChild(renderPlaceCard(place)));
          chatMessages.appendChild(grid);
          scrollToBottom();
        }
      } catch (err) {
        console.error('Places search failed:', err);
      }
    }
  }

  // Create bot message placeholder
  const botDiv = createMessageDiv('bot');
  const botBody = botDiv.querySelector('.msg-body');
  chatMessages.appendChild(botDiv);

  isStreaming = true;
  statusBar.textContent = 'Thinking...';
  document.querySelector('.input-box').classList.add('is-generating');

  try {
    const model = modelSelect.value;
    const isVision = images.length > 0;
    const endpoint = isVision ? '/api/chat/vision' : '/api/chat';

    // Build messages — inject web context and places as system messages if available
    let messagesForLLM = [...chatHistory];
    const systemParts = [];

    if (webContext && webContext.contextForLLM) {
      systemParts.push(`Use the following web search results to inform your response. Cite sources with URLs when referencing specific information. If the results include relevant images, embed them using markdown: ![description](url)\n\n${webContext.contextForLLM}`);
    }

    if (placesData && placesData.length > 0) {
      const placeList = placesData.map(p =>
        `- ${p.name}${p.address ? ` | ${p.address}` : ''}${p.rating ? ` | Rating: ${p.rating}` : ''}${p.phone ? ` | ${p.phone}` : ''}`
      ).join('\n');
      systemParts.push(`REAL PLACES FOUND (verified web data near ${userLocation}):\n${placeList}\n\nUse ONLY these real place names in your response. DO NOT invent place names or addresses.`);
    }

    if (systemParts.length > 0) {
      messagesForLLM = [{ role: 'system', content: systemParts.join('\n\n---\n\n') }, ...messagesForLLM];
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
            scrollToBottom();
          }
        } catch {}
      }
    }

    // Store web results metadata on the assistant message for replay
    const assistantMsg = { role: 'assistant', content: fullResponse };
    if (webContext && webContext.webResults && webContext.webResults.length > 0) {
      assistantMsg.webResults = webContext.webResults;
    }
    chatHistory.push(assistantMsg);
    statusBar.textContent = '';
    setupInteractiveButtons(botDiv.querySelector('.msg-body'));
    autoSaveChat();

  } catch (err) {
    botBody.textContent = 'Error: ' + err.message;
    statusBar.textContent = 'Error';
  }

  isStreaming = false;
  document.querySelector('.input-box').classList.remove('is-generating');
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

  // If replaying a saved chat, render web results card before the bot message
  if (msg.webResults && msg.webResults.length > 0) {
    const card = renderWebResultsCard(msg.webResults);
    chatMessages.appendChild(card);
  }

  chatMessages.appendChild(div);

  // Add interactive buttons for bot messages (derive, ask)
  if (msg.role !== 'user') {
    setupInteractiveButtons(body);
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
  // 1. "Derive equation" below each block-level formula
  //    Walk up to the direct child of msg-content, insert bar after that
  const contentRoot = msgBody.querySelector('.msg-content') || msgBody;

  contentRoot.querySelectorAll('.katex-display').forEach(block => {
    // Walk up to direct child of contentRoot
    let insertAfter = block;
    while (insertAfter.parentElement && insertAfter.parentElement !== contentRoot) {
      insertAfter = insertAfter.parentElement;
    }
    if (insertAfter.nextElementSibling && insertAfter.nextElementSibling.classList.contains('math-explain-bar')) return;

    const bar = document.createElement('div');
    bar.className = 'math-explain-bar';
    const btn = document.createElement('button');
    btn.className = 'math-explain-btn';
    btn.textContent = 'Explain derivation';
    bar.appendChild(btn);
    insertAfter.insertAdjacentElement('afterend', bar);

    btn.addEventListener('click', async () => {
      if (btn.disabled) return;

      const annotation = block.querySelector('annotation[encoding="application/x-tex"]');
      const latex = annotation ? annotation.textContent.trim() : block.textContent.trim();

      // Remove old result if exists
      const old = bar.nextElementSibling;
      if (old && old.classList.contains('math-explanation-result')) old.remove();

      const resultDiv = document.createElement('div');
      resultDiv.className = 'math-explanation-result';
      resultDiv.textContent = '...';
      bar.insertAdjacentElement('afterend', resultDiv);

      btn.disabled = true;
      btn.textContent = 'Explaining...';

      const prompt = `you are an expert assistant, use KATEX for all math formulas and expressions and any simple in line math, if a school problem / math problem is given, find the soloution explaining the steps as if it were simple`;

      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: [{ role: 'user', content: prompt }], stream: true, model: modelSelect.value })
        });

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let fullText = '';
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
              if (d.message?.content) {
                fullText += d.message.content;
                resultDiv.innerHTML = renderMarkdown(fullText);
              }
            } catch {}
          }
        }
        resultDiv.innerHTML = renderMarkdown(fullText);
        highlightCode(resultDiv);
        btn.textContent = 'Explained';
      } catch {
        resultDiv.textContent = 'Could not load explanation.';
        btn.disabled = false;
        btn.textContent = 'Explain derivation';
      }
    });
  });

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

      floatingBtn = document.createElement('button');
      floatingBtn.className = 'selection-prompt-btn';
      floatingBtn.textContent = 'Ask more';
      document.body.appendChild(floatingBtn);

      // Measure actual button width after render, then position left of selection
      const btnW = floatingBtn.offsetWidth;
      floatingBtn.style.left = Math.max(4, minLeft - btnW - 10) + 'px';
      floatingBtn.style.top = vertCenter + 'px';
      floatingBtn.style.transform = 'translateY(-50%)';

      floatingBtn.addEventListener('mousedown', (e) => {
        e.preventDefault();
      });

      floatingBtn.addEventListener('click', () => {
        const cleanText = extractCleanText(sel);

        // Grab the full bot message content for LLM context
        const fullMsgContent = msgBody.querySelector('.msg-content');
        const fullContext = fullMsgContent ? fullMsgContent.textContent.trim() : cleanText;

        // Show the quote reference card above the input
        const refEl = document.getElementById('quote-reference');
        const refText = document.getElementById('quote-reference-text');
        refText.textContent = cleanText;
        refEl.style.display = 'flex';
        refEl._quoteText = cleanText;         // what the user selected (shown in card)
        refEl._quoteFullContext = fullContext;  // full bot response (sent to LLM, hidden from user)

        chatInput.focus();
        chatSendBtn.disabled = !chatInput.value.trim();
        sel.removeAllRanges();
        removeBtn();
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

// ── File tree ────────────────────────────────────────────────
async function loadFileTree() {
  try {
    const res = await fetch('/api/files');
    const files = await res.json();
    const tree = $('#file-tree');
    tree.innerHTML = '';
    renderTree(files, tree);
  } catch {}
}

function renderTree(items, parent) {
  items.forEach(item => {
    if (item.isDirectory) {
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = item.name;
      details.appendChild(summary);
      if (item.children) renderTree(item.children, details);
      parent.appendChild(details);
    } else {
      const div = document.createElement('div');
      div.className = 'file-item';
      div.textContent = item.name;
      div.addEventListener('click', () => attachFileFromTree(item));
      parent.appendChild(div);
    }
  });
}

async function attachFileFromTree(item) {
  try {
    const res = await fetch(`/api/files/read?path=${encodeURIComponent(item.path)}`);
    const data = await res.json();
    attachedFiles.push({ name: item.name, type: 'text/plain', textContent: data.content });
    renderAttachedFiles();
    chatSendBtn.disabled = false;
  } catch (err) {
    statusBar.textContent = 'Failed to read file: ' + err.message;
  }
}

$('#refresh-files-btn').addEventListener('click', loadFileTree);

// ── Upload zone ──────────────────────────────────────────────
function initUploadZone() {
  const toggle = $('#upload-toggle-btn');
  const zone = $('#upload-zone');
  const fileInput = $('#file-upload-input');

  toggle.addEventListener('click', () => {
    zone.style.display = zone.style.display === 'none' ? 'block' : 'none';
  });

  zone.addEventListener('dragover', e => { e.preventDefault(); zone.style.borderColor = 'var(--accent)'; });
  zone.addEventListener('dragleave', () => { zone.style.borderColor = ''; });
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.style.borderColor = '';
    for (const file of e.dataTransfer.files) uploadFile(file);
  });

  fileInput.addEventListener('change', () => {
    for (const file of fileInput.files) uploadFile(file);
    fileInput.value = '';
  });

  // Click on label opens file picker
  zone.querySelector('.upload-label').addEventListener('click', (e) => {
    e.preventDefault();
    requestAnimationFrame(() => fileInput.click());
  });
}

async function uploadFile(file) {
  const form = new FormData();
  form.append('file', file);
  try {
    await fetch('/api/files/upload', { method: 'POST', body: form });
    statusBar.textContent = `Uploaded: ${file.name}`;
    loadFileTree();
  } catch (err) {
    statusBar.textContent = 'Upload failed: ' + err.message;
  }
}

// ── Settings ─────────────────────────────────────────────────
function initSettings() {
  // Load current config
  fetch('/api/config').then(r => r.json()).then(cfg => {
    $('#files-dir-input').value = cfg.filesDir || '';
  }).catch(() => {});

  // User location
  const locInput = $('#user-location-input');
  if (locInput) {
    locInput.value = userLocation;
    $('#save-location-btn').addEventListener('click', () => {
      userLocation = locInput.value.trim();
      localStorage.setItem('userLocation', userLocation);
      statusBar.textContent = userLocation ? `Location set: ${userLocation}` : 'Location cleared';
    });
  }

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
    loadFileTree();
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
  { name: 'gemma3:latest', desc: 'Google Gemma 3 — versatile general model', tags: ['general'] },
  { name: 'gemma2:2b', desc: 'Gemma 2 2B — lightweight and fast', tags: ['general'] },
  { name: 'llama3.2:latest', desc: 'Meta Llama 3.2 — strong general purpose', tags: ['general'] },
  { name: 'llama3.1:8b', desc: 'Meta Llama 3.1 8B — balanced performance', tags: ['general'] },
  { name: 'mistral:latest', desc: 'Mistral 7B — efficient and capable', tags: ['general'] },
  { name: 'phi3:latest', desc: 'Microsoft Phi-3 — compact powerhouse', tags: ['general'] },
  { name: 'qwen2.5:latest', desc: 'Alibaba Qwen 2.5 — multilingual', tags: ['general'] },
  { name: 'deepseek-coder-v2:latest', desc: 'DeepSeek Coder V2 — code generation', tags: ['code'] },
  { name: 'codellama:latest', desc: 'Meta Code Llama — code specialist', tags: ['code'] },
  { name: 'starcoder2:latest', desc: 'StarCoder 2 — code completion', tags: ['code'] },
  { name: 'qwen2.5-coder:latest', desc: 'Qwen 2.5 Coder — code focused', tags: ['code'] },
  { name: 'llava:latest', desc: 'LLaVA — vision + language', tags: ['vision'] },
  { name: 'llama3.2-vision:latest', desc: 'Llama 3.2 Vision — image understanding', tags: ['vision'] },
  { name: 'moondream:latest', desc: 'Moondream — tiny vision model', tags: ['vision'] },
  { name: 'nomic-embed-text:latest', desc: 'Nomic Embed — text embeddings', tags: ['embedding'] },
  { name: 'mxbai-embed-large:latest', desc: 'MixedBread Embed — high quality embeddings', tags: ['embedding'] },
];

function renderModelCatalog(filter = 'all') {
  const cat = $('#model-catalog');
  cat.innerHTML = '';
  const installedNames = models.map(m => m.name);
  const filtered = filter === 'all' ? MODEL_CATALOG : MODEL_CATALOG.filter(m => m.tags.includes(filter));
  filtered.forEach(m => {
    const installed = installedNames.includes(m.name);
    const card = document.createElement('div');
    card.className = 'catalog-card';
    card.innerHTML = `
      <h4>${escHtml(m.name)} ${installed ? '<span class="installed-badge">[installed]</span>' : ''}</h4>
      <p>${escHtml(m.desc)}</p>
      <span class="catalog-tag">${m.tags.join(', ')}</span>
    `;
    cat.appendChild(card);
  });
}

// ═══════════════════════════════════════════════════════════
//  WEB MODE — toggle, results card, image gallery
// ═══════════════════════════════════════════════════════════

function initWebMode() {
  const toggle = document.getElementById('web-mode-toggle');
  if (!toggle) return;

  toggle.addEventListener('click', () => {
    webModeEnabled = !webModeEnabled;
    toggle.classList.toggle('active', webModeEnabled);
    toggle.title = webModeEnabled ? 'Web mode ON' : 'Web mode OFF';
  });
}

// ═══════════════════════════════════════════════════════════
//  TINY MODEL — smollm2:135m for instant search query gen
// ═══════════════════════════════════════════════════════════

const TINY_MODEL = 'smollm2:135m';
let _tinyModelReady = false;

async function ensureTinyModel(statusEl) {
  if (_tinyModelReady) return true;
  if (models.some(m => m.name === TINY_MODEL || m.name.startsWith('smollm2'))) {
    _tinyModelReady = true; return true;
  }
  // Download it — one-time, ~270 MB
  if (statusEl) statusEl.textContent = 'Installing smollm2:135m (270 MB, one-time)…';
  console.log('[TinyModel] Pulling smollm2:135m…');
  try {
    const res = await fetch('/api/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: TINY_MODEL, stream: true })
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) {
        try {
          const d = JSON.parse(line);
          if (d.status && statusEl) {
            const pct = d.total ? ` ${Math.round((d.completed||0)/d.total*100)}%` : '';
            statusEl.textContent = `Installing smollm2:135m…${pct}`;
          }
        } catch {}
      }
    }
    // Refresh model list
    const r = await fetch('/api/tags');
    const data = await r.json();
    models = data.models || [];
    populateModelSelect(modelSelect, models);
    updateInstalledModels(models);
    _tinyModelReady = true;
    console.log('[TinyModel] Ready');
    return true;
  } catch(e) {
    console.warn('[TinyModel] Install failed:', e);
    return false;
  }
}

async function getSearchQuery(userText, statusEl) {
  const ready = await ensureTinyModel(statusEl);
  if (!ready) return userText;
  if (statusEl) statusEl.textContent = 'Generating search query…';
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: TINY_MODEL,
        messages: [{ role: 'user', content: `Reply with ONLY a short statistics-focused search query (6 words max) that would find data and numbers for:\n"${userText}"\nInclude words like "statistics", "data", "rate", "percent", or "by year" as appropriate.` }],
        stream: false
      })
    });
    const data = await res.json();
    const q = (data.message?.content || '').trim().replace(/^["'`]|["'`]$/g, '').slice(0, 120);
    console.log(`[TinyModel] Query: "${q}"`);
    return q || userText;
  } catch { return userText; }
}

// ═══════════════════════════════════════════════════════════
//  LARGE WEB CARDS — live webview + streaming AI overview
// ═══════════════════════════════════════════════════════════

function buildLargeWebCard(page) {
  const card = document.createElement('div');
  card.className = 'wcard-large';
  card.innerHTML = `
    <div class="wcard-header">
      <img class="wcard-favicon" src="${escHtml(page.favicon || `https://www.google.com/s2/favicons?domain=${encodeURIComponent(page.domain)}&sz=32`)}" alt="" onerror="this.style.display='none'">
      <div class="wcard-meta">
        <div class="wcard-domain">${escHtml(page.domain)}</div>
        <div class="wcard-url">${escHtml(page.url.length > 80 ? page.url.slice(0,80)+'…' : page.url)}</div>
      </div>
      <a class="wcard-ext" href="${escHtml(page.url)}" target="_blank" rel="noopener">↗ Open</a>
    </div>
    <div class="wcard-browser">
      <webview class="wcard-webview" src="${escHtml(page.url)}" partition="persist:search" disablewebsecurity></webview>
      <div class="wcard-browser-overlay"></div>
    </div>
    <div class="wcard-ai-section">
      <div class="wcard-ai-label">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
        AI Overview
      </div>
      <div class="wcard-ai-content">
        <div class="wcard-ai-spinner"></div>
        <span class="wcard-ai-text">Analyzing…</span>
      </div>
    </div>`;

  const wv = card.querySelector('.wcard-webview');
  if (wv) {
    wv.addEventListener('did-stop-loading', () => console.log(`[Card] Loaded: ${page.url}`));
    wv.addEventListener('did-fail-load', e => { if (e.errorCode !== -3) console.warn(`[Card] Load failed (${e.errorCode}): ${page.url}`); });
  }

  card.querySelector('.wcard-browser-overlay').addEventListener('click', () => {
    const browserTab = document.querySelector('#top-tabs .tab[data-tab="browser"]');
    if (browserTab) browserTab.click();
    if (typeof browserNavigate === 'function') browserNavigate(page.url);
  });

  return card;
}

async function runCardAI(page, card, model) {
  const textEl  = card.querySelector('.wcard-ai-text');
  const spinner = card.querySelector('.wcard-ai-spinner');
  if (!page.text || page.text.length < 40) {
    if (textEl) textEl.textContent = 'Insufficient page content.';
    spinner?.remove();
    return;
  }
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: `Extract the key statistics, numbers, percentages, and data points from this page. List them as short bullet points with the actual figures. Focus on specific facts with numbers, not vague claims.\n\nSource: ${page.domain}\nTitle: ${page.title}\n\n${page.text.slice(0, 2800)}` }],
        stream: true
      })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', started = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const d = JSON.parse(line);
          if (d.message?.content) {
            if (!started) { textEl.textContent = ''; spinner?.remove(); started = true; }
            textEl.textContent += d.message.content;
          }
        } catch {}
      }
    }
    if (!started) { textEl.textContent = 'No analysis available.'; spinner?.remove(); }
  } catch(e) {
    if (textEl) textEl.textContent = 'Analysis failed.';
    spinner?.remove();
    console.error('[CardAI] Failed:', e);
  }
}

// ── Source card builder (used by browser search) ─────────────
function buildSourceCard(r) {
  // r = { url, title, description, image, screenshot, favicon, domain }
  console.log(`[WebSearch] Building card → ${r.url}`);
  const card = document.createElement('div');
  card.className = 'wsource-card';

  // Live Chromium webview embedded in the card (real rendered page, not screenshot)
  card.innerHTML = `
    <div class="wsource-webview-wrap">
      <webview class="wsource-webview" src="${escHtml(r.url)}" partition="persist:search" disablewebsecurity></webview>
      <div class="wsource-webview-overlay" title="Click to open in browser"></div>
    </div>
    <div class="wsource-body">
      <div class="wsource-head">
        <img class="wsource-favicon" src="${escHtml(r.favicon || `https://www.google.com/s2/favicons?domain=${encodeURIComponent(r.domain)}&sz=16`)}" alt="" onerror="this.style.display='none'">
        <span class="wsource-domain">${escHtml(r.domain)}</span>
        <a class="wsource-ext" href="${escHtml(r.url)}" target="_blank" rel="noopener" title="Open in browser">↗</a>
      </div>
      <div class="wsource-title">${escHtml(r.title || r.domain)}</div>
      <div class="wsource-snippet">${escHtml(r.description || '')}</div>
    </div>`;

  // Log when webview loads inside the card
  const wv = card.querySelector('.wsource-webview');
  if (wv) {
    wv.addEventListener('did-stop-loading', () => {
      console.log(`[WebSearch] Card webview loaded: ${r.url}`);
    });
    wv.addEventListener('did-fail-load', e => {
      if (e.errorCode !== -3) console.warn(`[WebSearch] Card webview failed (${e.errorCode}): ${r.url}`);
    });
  }

  // Click overlay or card body to open in browser tab
  const openInBrowser = (e) => {
    if (e.target.closest('.wsource-ext')) return;
    console.log(`[WebSearch] Card clicked → opening in browser tab: ${r.url}`);
    const browserTab = document.querySelector('#top-tabs .tab[data-tab="browser"]');
    if (browserTab) browserTab.click();
    if (typeof browserNavigate === 'function') browserNavigate(r.url);
  };
  card.querySelector('.wsource-webview-overlay').addEventListener('click', openInBrowser);
  card.querySelector('.wsource-body').addEventListener('click', openInBrowser);

  return card;
}

function renderWebResultsCard(webResults) {
  const card = document.createElement('div');
  card.className = 'web-results-card';

  // Header
  const header = document.createElement('div');
  header.className = 'web-results-header';
  header.innerHTML = `<span>Sources (${webResults.length})</span><span class="toggle-icon">&#9660;</span>`;
  header.addEventListener('click', () => card.classList.toggle('collapsed'));
  card.appendChild(header);

  // Body
  const body = document.createElement('div');
  body.className = 'web-results-body';

  // Collect all images across results
  const allImages = [];

  webResults.forEach(r => {
    const item = document.createElement('div');
    item.className = 'web-source-item';

    let domain = '';
    try { domain = new URL(r.url).hostname.replace('www.', ''); } catch {}
    const faviconUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;

    item.innerHTML = `
      <img class="web-source-favicon" src="${faviconUrl}" alt="" onerror="this.style.display='none'">
      <div class="web-source-info">
        <a class="web-source-title" href="${escHtml(r.url)}" target="_blank" rel="noopener">${escHtml(r.title || r.pageTitle || domain)}</a>
        <div class="web-source-domain">${escHtml(domain)}</div>
        ${r.snippet ? `<div class="web-source-snippet">${escHtml(r.snippet)}</div>` : ''}
      </div>
    `;
    body.appendChild(item);

    // Gather images
    if (r.images && r.images.length) {
      r.images.forEach(img => {
        if (!allImages.some(i => i.src === img.src)) {
          allImages.push(img);
        }
      });
    }
  });

  // Image gallery
  if (allImages.length > 0) {
    const gallery = document.createElement('div');
    gallery.className = 'web-images-gallery';
    allImages.slice(0, 12).forEach(img => {
      const imgEl = document.createElement('img');
      // Use image proxy to avoid mixed content and CORS issues
      imgEl.src = `/api/web/image-proxy?url=${encodeURIComponent(img.src)}`;
      imgEl.alt = img.alt || '';
      imgEl.loading = 'lazy';
      imgEl.title = img.alt || 'Web image';
      imgEl.addEventListener('click', () => openLightbox(img.src));
      imgEl.addEventListener('error', () => imgEl.remove());
      gallery.appendChild(imgEl);
    });
    body.appendChild(gallery);
  }

  card.appendChild(body);
  return card;
}

// ── Place card with embedded Leaflet map ─────────────────────
function renderPlaceCard(place) {
  const card = document.createElement('div');
  card.className = 'place-card';
  const mapId = 'map-' + Math.random().toString(36).slice(2, 9);

  const starsHtml = (rating) => {
    if (!rating) return '';
    const full = Math.round(rating);
    return '★'.repeat(full) + '☆'.repeat(Math.max(0, 5 - full));
  };

  card.innerHTML = `
    <div class="place-card-top">
      <div class="place-card-info">
        <div class="place-name">${escHtml(place.name)}</div>
        ${place.rating ? `<div class="place-rating"><span class="place-stars">${starsHtml(place.rating)}</span> <span class="place-rating-val">${place.rating}</span>${place.ratingCount ? `<span class="place-rating-count"> (${place.ratingCount})</span>` : ''}</div>` : ''}
        ${place.address ? `<div class="place-address"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg> ${escHtml(place.address)}</div>` : ''}
        ${place.phone ? `<div class="place-phone">📞 ${escHtml(place.phone)}</div>` : ''}
        ${place.priceRange ? `<div class="place-price">${escHtml(place.priceRange)}</div>` : ''}
      </div>
      <div class="place-card-actions">
        ${place.lat && place.lng ? `<a href="https://www.google.com/maps/dir/?api=1&destination=${place.lat},${place.lng}" target="_blank" class="place-btn directions-btn">🗺 Directions</a>` : ''}
        ${place.website ? `<a href="${escHtml(place.website)}" target="_blank" class="place-btn website-btn">🔗 Website</a>` : ''}
      </div>
    </div>
    ${place.lat && place.lng ? `<div id="${mapId}" class="place-map"></div>` : ''}
    ${place.images && place.images.length > 0 ? `<div class="place-photos">${place.images.slice(0, 6).map(img => `<img src="/api/web/image-proxy?url=${encodeURIComponent(img.src)}" alt="${escHtml(img.alt || '')}" loading="lazy" onerror="this.remove()">`).join('')}</div>` : ''}
    ${place.reviews && place.reviews.length > 0 ? `<div class="place-reviews">${place.reviews.map(r => `<div class="place-review"><div class="review-meta">${escHtml(r.author)}${r.rating ? ` · ${'★'.repeat(Math.round(r.rating))}` : ''}</div><div class="review-text">${escHtml(r.text)}</div></div>`).join('')}</div>` : ''}
  `;

  // Init Leaflet map after element is in DOM
  if (place.lat && place.lng) {
    setTimeout(() => {
      const mapEl = document.getElementById(mapId);
      if (!mapEl || mapEl._leaflet_id || !window.L) return;
      const map = L.map(mapId, { zoomControl: true, scrollWheelZoom: false })
        .setView([place.lat, place.lng], 15);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© <a href="https://openstreetmap.org">OpenStreetMap</a>'
      }).addTo(map);
      L.marker([place.lat, place.lng]).addTo(map).bindPopup(escHtml(place.name)).openPopup();
    }, 50);
  }

  return card;
}

function openLightbox(src) {
  const overlay = document.createElement('div');
  overlay.className = 'web-lightbox';
  const img = document.createElement('img');
  img.src = src;
  img.alt = 'Full size';
  overlay.appendChild(img);
  overlay.addEventListener('click', () => overlay.remove());
  document.addEventListener('keydown', function handler(e) {
    if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', handler); }
  });
  document.body.appendChild(overlay);
}
