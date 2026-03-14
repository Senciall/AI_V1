/**
 * Agent Workspace — Client Logic
 * Self-contained module. Does NOT depend on script.js.
 *
 * Features: zoom, canvas pan, floating panels, connections, workspace save/load,
 *           DDG search iframe, code runner, diagrams, spreadsheets, file tree.
 */
document.addEventListener("DOMContentLoaded", () => {

    // ═══════════════════════════════════════════════════════════════
    //  DOM REFERENCES
    // ═══════════════════════════════════════════════════════════════
    const agentView   = document.getElementById("agent-view");
    if (!agentView) return;

    const chatContainer    = document.getElementById("agent-chat-container");
    const chatForm         = document.getElementById("agent-chat-form");
    const userInput        = document.getElementById("user-input-agent");
    const sendBtn          = document.getElementById("send-btn-agent");
    const emptyState       = document.getElementById("agent-empty-state");
    const statusDot        = document.getElementById("agent-status-dot");
    const statusText       = document.getElementById("agent-status-text");
    const thoughtDisplay   = document.getElementById("thought-display-agent");
    const panelsContainer  = document.getElementById("agent-panels-container");
    const panelsEmpty      = document.getElementById("agent-panels-empty");
    const attachBtn        = document.getElementById("attach-btn-agent");
    const fileInput        = document.getElementById("file-input-agent");
    const attachedContainer = document.getElementById("attached-files-container-agent");
    const agentCanvas      = document.getElementById("agent-canvas");
    const canvasInner      = document.getElementById("agent-canvas-inner");
    const gridBg           = document.getElementById("agent-grid-bg");
    const ctxMenu          = document.getElementById("agent-context-menu");
    const connEditor       = document.getElementById("conn-editor");

    // Model picker
    const pickerBtn      = document.getElementById("model-picker-btn-agent");
    const pickerLabel    = document.getElementById("model-picker-label-agent");
    const pickerDropdown = document.getElementById("model-picker-dropdown-agent");
    document.body.appendChild(pickerDropdown);

    // ═══════════════════════════════════════════════════════════════
    //  STATE
    // ═══════════════════════════════════════════════════════════════
    let selectedModel      = "gemma3:latest";
    let agentHistory       = [];
    let currentAgentChatId = null;
    let currentWorkspaceId = null;
    let isGenerating       = false;
    let attachedFiles      = [];
    let panelCounter       = 0;
    let panels             = [];    // { id, toolId, filename }
    let connections        = [];    // { id, sourceId, targetId, prompt, label }
    let connCounter        = 0;

    // Zoom / pan
    let zoom = 1, panX = 0, panY = 0;
    let isPanning = false, panStartX = 0, panStartY = 0, panOriginX = 0, panOriginY = 0;

    // Connection drag
    let connectingFrom = null;   // panel id
    let tempLine       = null;   // SVG line element

    // ═══════════════════════════════════════════════════════════════
    //  HELPERS
    // ═══════════════════════════════════════════════════════════════
    function screenToCanvas(cx, cy) {
        const r = agentCanvas.getBoundingClientRect();
        return { x: (cx - r.left - panX) / zoom, y: (cy - r.top - panY) / zoom };
    }

    function applyTransform() {
        canvasInner.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
        const gs = 40 * zoom;
        gridBg.style.backgroundSize = `${gs}px ${gs}px`;
        gridBg.style.backgroundPosition = `${panX % gs}px ${panY % gs}px`;
    }

    function updateZoomDisplay() {
        const el = document.getElementById('agent-zoom-display');
        if (el) el.textContent = Math.round(zoom * 100) + '%';
    }

    // ═══════════════════════════════════════════════════════════════
    //  MARKED CONFIG
    // ═══════════════════════════════════════════════════════════════
    if (typeof marked !== 'undefined') {
        marked.setOptions({
            highlight: (code, lang) => {
                if (typeof hljs !== 'undefined') {
                    const language = hljs.getLanguage(lang) ? lang : 'plaintext';
                    return hljs.highlight(code, { language }).value;
                }
                return code;
            },
            breaks: false
        });
    }

    // ═══════════════════════════════════════════════════════════════
    //  TOOL REGISTRY
    // ═══════════════════════════════════════════════════════════════
    const TOOLS = {
        pdf:         { name: 'PDF Viewer',   icon: '📕', accepts: ['.pdf'] },
        spreadsheet: { name: 'Spreadsheet',  icon: '📊', accepts: ['.xlsx','.xls','.csv'], canCreate: true },
        text:        { name: 'Text Editor',  icon: '📝', accepts: ['.txt','.md','.html','.json','.js','.py','.css'], canCreate: true },
        search:      { name: 'Web Search',   icon: '🔍' },
        gallery:     { name: 'Image Gallery', icon: '🖼️' },
        code:        { name: 'Code Runner',  icon: '▶️', canCreate: true },
        image:       { name: 'Image Viewer', icon: '🖼️', accepts: ['.png','.jpg','.jpeg','.gif','.webp'] },
        diagram:     { name: 'Diagram',      icon: '📐', canCreate: true },
    };

    // ═══════════════════════════════════════════════════════════════
    //  MODEL PICKER
    // ═══════════════════════════════════════════════════════════════
    async function loadAgentModels() {
        let models = [];
        try { const r = await fetch('/api/tags'); const d = await r.json(); models = (d.models || []).map(m => m.name); } catch {}
        if (!models.length) models = ["gemma3:latest"];
        pickerDropdown.innerHTML = models.map(m =>
            `<li data-value="${m}"${m === selectedModel ? ' class="active"' : ''}>${m}</li>`
        ).join('');
        try { const s = await fetch('/api/settings'); const d = await s.json(); if (d.model && models.includes(d.model)) selectedModel = d.model; } catch {}
        if (!models.includes(selectedModel)) selectedModel = models[0];
        pickerLabel.textContent = selectedModel;
        pickerDropdown.querySelectorAll('li').forEach(li => li.classList.toggle('active', li.dataset.value === selectedModel));
    }

    pickerBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = pickerDropdown.classList.toggle('open');
        pickerBtn.classList.toggle('open', open);
        if (open) { const r = pickerBtn.getBoundingClientRect(); pickerDropdown.style.left = r.left+'px'; pickerDropdown.style.bottom = (window.innerHeight - r.top + 8)+'px'; }
    });
    pickerDropdown.addEventListener('click', (e) => {
        e.stopPropagation();
        const li = e.target.closest('li'); if (!li) return;
        selectedModel = li.dataset.value;
        pickerLabel.textContent = selectedModel;
        pickerDropdown.querySelectorAll('li').forEach(l => l.classList.toggle('active', l.dataset.value === selectedModel));
        pickerDropdown.classList.remove('open'); pickerBtn.classList.remove('open');
        fetch('/api/settings', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({model:selectedModel}) }).catch(()=>{});
    });
    document.addEventListener('click', () => { pickerDropdown.classList.remove('open'); pickerBtn.classList.remove('open'); });

    // ═══════════════════════════════════════════════════════════════
    //  FILE ATTACHMENT
    // ═══════════════════════════════════════════════════════════════
    const IMAGE_EXTS = ['jpg','jpeg','png','gif','webp','bmp','svg'];
    function isImage(name) { return IMAGE_EXTS.includes(name.split('.').pop().toLowerCase()); }
    function fileIcon(name) {
        const ext = name.split('.').pop().toLowerCase();
        if (ext === 'pdf') return '📕';
        if (['xlsx','xls','csv'].includes(ext)) return '📊';
        if (IMAGE_EXTS.includes(ext)) return '🖼️';
        return '📄';
    }

    attachBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => { if (fileInput.files.length) { handleFiles(fileInput.files); fileInput.value = ''; } });

    userInput.addEventListener('paste', (e) => {
        const items = e.clipboardData?.items; if (!items) return;
        for (const item of items) {
            if (item.type.startsWith('image/')) {
                e.preventDefault();
                const file = item.getAsFile();
                if (file) handleFiles([new File([file], `pasted-${Date.now()}.${file.type.split('/')[1]||'png'}`, { type: file.type })]);
                return;
            }
        }
    });

    async function handleFiles(files) {
        for (const file of files) {
            const ext = '.' + file.name.split('.').pop().toLowerCase();
            const entry = { name: file.name, ext, content: '', base64: null };
            if (isImage(file.name)) {
                entry.base64 = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result.replace(/^data:[^;]+;base64,/,'')); fr.readAsDataURL(file); });
            } else {
                const fd = new FormData(); fd.append('file', file);
                try {
                    const u = await fetch('/api/files/upload?target=temp', { method:'POST', body:fd });
                    const d = await u.json();
                    if (d.path) {
                        entry.serverPath = d.path;
                        try { const rr = await fetch(`/api/files/read?path=${encodeURIComponent(entry.serverPath)}`); const rd = await rr.json(); entry.content = rd.content || ''; } catch{}
                    }
                } catch(e) { console.error('Upload failed:', e); }
            }
            attachedFiles.push(entry);
            const toolId = Object.keys(TOOLS).find(t => TOOLS[t].accepts?.includes(ext));
            if (toolId === 'pdf' && entry.serverPath) {
                // Trigger deep PDF pipeline (opens panel + extracts structured text)
                const pdfContext = await runPdfPipeline(entry);
                if (pdfContext) entry.pdfAnalysis = pdfContext;
            }
            else if (toolId === 'image' && entry.base64) openPanel('image', file.name, { base64: entry.base64, type: file.type });
            else if (toolId === 'spreadsheet' && entry.content) openPanel('spreadsheet', file.name, { csv: entry.content });
        }
        renderAttached();
    }

    function renderAttached() {
        attachedContainer.innerHTML = attachedFiles.map((f,i) =>
            `<div class="file-chip"><span class="file-chip-icon">${fileIcon(f.name)}</span><span>${f.name}</span><span class="file-chip-remove" data-idx="${i}">&times;</span></div>`
        ).join('');
        attachedContainer.querySelectorAll('.file-chip-remove').forEach(btn => btn.addEventListener('click', () => { attachedFiles.splice(+btn.dataset.idx,1); renderAttached(); }));
        updateSendState();
    }

    // ═══════════════════════════════════════════════════════════════
    //  CHAT INPUT
    // ═══════════════════════════════════════════════════════════════
    userInput.addEventListener('input', function() {
        this.style.height = 'auto'; this.style.height = this.scrollHeight + 'px';
        this.style.overflowY = this.scrollHeight > 200 ? 'auto' : 'hidden';
        updateSendState();
    });
    userInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!sendBtn.disabled) chatForm.dispatchEvent(new Event('submit')); } });
    function updateSendState() { sendBtn.disabled = (!userInput.value.trim() && !attachedFiles.some(f=>f.base64)) || isGenerating; }

    // ═══════════════════════════════════════════════════════════════
    //  MESSAGE RENDERING
    // ═══════════════════════════════════════════════════════════════
    function addMessage(role, text, imageAttachments) {
        if (emptyState) emptyState.style.display = 'none';
        const msg = document.createElement('div'); msg.className = `message ${role}`;
        const avatar = document.createElement('div'); avatar.className = 'avatar'; avatar.textContent = role === 'user' ? 'U' : 'A';
        const content = document.createElement('div'); content.className = 'message-content';
        if (text && typeof marked !== 'undefined') content.innerHTML = marked.parse(text);
        else if (text) content.textContent = text;
        msg.appendChild(avatar);
        if (imageAttachments?.length) {
            const grid = document.createElement('div'); grid.className = 'message-image-grid';
            for (const img of imageAttachments) {
                const thumb = document.createElement('div'); thumb.className = 'message-image-thumb';
                const imgEl = document.createElement('img');
                imgEl.src = img.base64 ? `data:${img.type||'image/png'};base64,${img.base64}` : img.src;
                thumb.appendChild(imgEl);
                const nameEl = document.createElement('div'); nameEl.className = 'message-image-name'; nameEl.textContent = img.name || 'Image';
                thumb.appendChild(nameEl); grid.appendChild(thumb);
            }
            msg.appendChild(grid);
        }
        msg.appendChild(content); chatContainer.appendChild(msg); chatContainer.scrollTop = chatContainer.scrollHeight;
        return content;
    }

    // ═══════════════════════════════════════════════════════════════
    //  STATUS
    // ═══════════════════════════════════════════════════════════════
    function setStatus(t, busy = false) {
        statusText.textContent = t;
        statusDot.className = 'agent-status-dot' + (busy ? ' busy' : '');
        if (thoughtDisplay) { thoughtDisplay.textContent = t; thoughtDisplay.style.opacity = t ? '1' : '0'; }
    }

    // ═══════════════════════════════════════════════════════════════
    //  SVG CONNECTION LAYER
    // ═══════════════════════════════════════════════════════════════
    const svgOverlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svgOverlay.setAttribute('width', '4000');
    svgOverlay.setAttribute('height', '4000');
    svgOverlay.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;z-index:3;overflow:visible;';
    canvasInner.appendChild(svgOverlay);

    function renderConnections() {
        svgOverlay.innerHTML = '';
        for (const conn of connections) {
            const srcEl = document.getElementById(conn.sourceId);
            const tgtEl = document.getElementById(conn.targetId);
            if (!srcEl || !tgtEl) continue;

            const sx = srcEl.offsetLeft + srcEl.offsetWidth;
            const sy = srcEl.offsetTop + srcEl.offsetHeight / 2;
            const tx = tgtEl.offsetLeft;
            const ty = tgtEl.offsetTop + tgtEl.offsetHeight / 2;
            const dx = Math.max(60, Math.abs(tx - sx) / 2);

            // Bezier path
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', `M${sx},${sy} C${sx+dx},${sy} ${tx-dx},${ty} ${tx},${ty}`);
            path.setAttribute('stroke', 'rgba(94,106,210,0.45)');
            path.setAttribute('stroke-width', '2');
            path.setAttribute('fill', 'none');
            path.style.pointerEvents = 'stroke';
            path.style.cursor = 'pointer';
            path.addEventListener('click', (e) => { e.stopPropagation(); openConnEditor(conn, e.clientX, e.clientY); });
            svgOverlay.appendChild(path);

            // Label
            const mx = (sx + tx) / 2, my = (sy + ty) / 2;
            const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            label.setAttribute('x', mx); label.setAttribute('y', my - 10);
            label.setAttribute('text-anchor', 'middle');
            label.setAttribute('fill', 'rgba(255,255,255,0.38)');
            label.setAttribute('font-size', '11');
            label.setAttribute('font-family', 'Inter, sans-serif');
            label.textContent = conn.label || 'Transform';
            label.style.pointerEvents = 'auto'; label.style.cursor = 'pointer';
            label.addEventListener('click', (e) => { e.stopPropagation(); openConnEditor(conn, e.clientX, e.clientY); });
            svgOverlay.appendChild(label);

            // Run button circle
            const run = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            run.setAttribute('cx', mx); run.setAttribute('cy', my + 8); run.setAttribute('r', '9');
            run.setAttribute('fill', 'rgba(67,233,123,0.15)'); run.setAttribute('stroke', 'rgba(67,233,123,0.35)'); run.setAttribute('stroke-width', '1.5');
            run.style.pointerEvents = 'auto'; run.style.cursor = 'pointer';
            run.addEventListener('click', (e) => { e.stopPropagation(); executeConnection(conn); });
            svgOverlay.appendChild(run);

            const play = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            play.setAttribute('x', mx); play.setAttribute('y', my + 12);
            play.setAttribute('text-anchor', 'middle'); play.setAttribute('fill', '#43e97b'); play.setAttribute('font-size', '10');
            play.textContent = '▶'; play.style.pointerEvents = 'none';
            svgOverlay.appendChild(play);
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  PANEL SYSTEM
    // ═══════════════════════════════════════════════════════════════
    function openPanel(toolId, filename, data, atX, atY) {
        panelCounter++;
        const id = `panel-${panelCounter}`;
        const tool = TOOLS[toolId] || { name: toolId, icon: '📄' };
        if (panelsEmpty) panelsEmpty.style.display = 'none';

        const panel = document.createElement('div');
        panel.className = 'agent-panel';
        panel.id = id;
        const isLargePanel = toolId === 'search' || toolId === 'gallery';
        panel.style.width  = isLargePanel ? '520px' : '480px';
        panel.style.height = isLargePanel ? '480px' : '360px';
        if (atX !== undefined && atY !== undefined) { panel.style.left = atX+'px'; panel.style.top = atY+'px'; }
        else { const o = (panels.length % 5) * 30; panel.style.left = (20+o)+'px'; panel.style.top = (20+o)+'px'; }

        panel.innerHTML = `
            <div class="agent-panel-header">
                <span class="agent-panel-icon">${tool.icon}</span>
                <span class="agent-panel-title">${filename || tool.name}</span>
                <button class="agent-panel-action close" title="Close">&times;</button>
            </div>
            <div class="agent-panel-body"></div>
            <div class="agent-panel-status"><span></span><span></span></div>
            <div class="agent-panel-resize"></div>
            <div class="agent-panel-handle handle-out" title="Drag to connect output"></div>
            <div class="agent-panel-handle handle-in" title="Drop connection here"></div>
        `;

        const body = panel.querySelector('.agent-panel-body');
        const statusBar = panel.querySelector('.agent-panel-status');

        if (toolId === 'pdf') {
            body.classList.add('panel-pdf');
            body.style.padding = '0';
            body.innerHTML = `<iframe src="${data.src}"></iframe>`;
        } else if (toolId === 'image') {
            body.classList.add('panel-image');
            const src = data.useUrl ? data.base64 : `data:${data.type||'image/png'};base64,${data.base64}`;
            body.innerHTML = `<img src="${src}">`;
        } else if (toolId === 'spreadsheet') {
            body.classList.add('panel-spreadsheet');
            renderSpreadsheet(body, statusBar, data, filename);
        } else if (toolId === 'text') {
            body.classList.add('panel-text-editor');
            body.contentEditable = 'true';
            body.textContent = data.text || '';
            statusBar.querySelector('span').textContent = `${(data.text||'').split('\n').length} lines`;
        } else if (toolId === 'search') {
            body.classList.add('panel-search');
            body.style.padding = '0';
            renderSearchPanel(body, data.query || '', data.results || null);
        } else if (toolId === 'gallery') {
            body.classList.add('panel-gallery');
            body.style.padding = '0';
            renderImageGallery(body, data.images || [], data.sourceUrl || '');
        } else if (toolId === 'code') {
            body.classList.add('panel-code-runner');
            renderCodeRunner(body, data);
        } else if (toolId === 'diagram') {
            body.classList.add('panel-diagram');
            body.innerHTML = `<div class="mermaid">${data.code||''}</div>`;
            if (typeof mermaid !== 'undefined') { try { mermaid.init(undefined, body.querySelector('.mermaid')); } catch {} }
        }

        panel.querySelector('.close').addEventListener('click', () => closePanel(id));
        setupDrag(panel);
        setupResize(panel);
        setupConnectionHandles(panel, id);

        panel.addEventListener('mousedown', () => {
            panels.forEach(p => document.getElementById(p.id)?.classList.remove('focused'));
            panel.classList.add('focused');
        });

        panelsContainer.appendChild(panel);
        panels.push({ id, toolId, filename });
        panel.classList.add('focused');
        return { id, body, statusBar };
    }

    function closePanel(id) {
        const el = document.getElementById(id); if (el) el.remove();
        panels = panels.filter(p => p.id !== id);
        connections = connections.filter(c => c.sourceId !== id && c.targetId !== id);
        if (!panels.length && panelsEmpty) panelsEmpty.style.display = '';
        renderConnections();
    }

    // ═══════════════════════════════════════════════════════════════
    //  PANEL RENDERERS
    // ═══════════════════════════════════════════════════════════════
    function renderSpreadsheet(body, statusBar, data, filename) {
        let rows;
        if (data.csv) rows = data.csv.trim().split('\n').map(r => r.split(',').map(c => c.replace(/^"|"$/g, '').trim()));
        else if (data.rows) rows = data.rows;
        else return;
        if (!rows.length) return;
        const header = rows[0], dataRows = rows.slice(1);
        let html = '<table><thead><tr>';
        header.forEach(h => html += `<th>${h}</th>`);
        html += '</tr></thead><tbody>';
        dataRows.forEach(r => { html += '<tr>'; r.forEach(c => html += `<td contenteditable="true">${c}</td>`); html += '</tr>'; });
        html += '</tbody></table>';
        body.innerHTML = html;
        statusBar.querySelector('span').textContent = `${dataRows.length} rows × ${header.length} cols`;
        const btn = document.createElement('button'); btn.className = 'agent-panel-export-btn'; btn.textContent = '⬇ Export XLSX';
        btn.addEventListener('click', () => exportSpreadsheet(body, filename));
        statusBar.querySelector('span:last-child').appendChild(btn);
    }

    async function exportSpreadsheet(body, filename) {
        const table = body.querySelector('table'); if (!table) return;
        const data = []; table.querySelectorAll('tr').forEach(tr => { const row = []; tr.querySelectorAll('th, td').forEach(c => row.push(c.textContent)); data.push(row); });
        try {
            const r = await fetch('/api/agent/export-xlsx', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ filename:(filename||'export').replace(/\.[^.]+$/,''), sheets:[{name:'Sheet1',data}] }) });
            const blob = await r.blob(); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename || 'export.xlsx'; a.click();
        } catch(e) { console.error('Export failed:', e); }
    }

    function renderSearchPanel(body, query, preloadedResults) {
        body.innerHTML = `
            <div class="search-panel-content">
                <div class="search-tabs-bar">
                    <button class="search-tab active" data-tab="web">Web</button>
                    <button class="search-tab" data-tab="images">Images</button>
                </div>
                <div class="search-results-area" data-tab-panel="web">
                    <div class="search-results-list"></div>
                </div>
                <div class="search-results-area hidden" data-tab-panel="images">
                    <div class="search-images-grid"></div>
                </div>
            </div>
            <div class="search-bottom-bar">
                <span class="search-bottom-icon">⌕</span>
                <input type="text" class="search-input-bottom" value="${query.replace(/"/g, '&quot;')}" placeholder="Search the web…" autocomplete="off" spellcheck="false" />
                <button class="search-go-btn" title="Search">↵</button>
            </div>
        `;

        const input   = body.querySelector('.search-input-bottom');
        const goBtn   = body.querySelector('.search-go-btn');
        const list    = body.querySelector('.search-results-list');
        const imgGrid = body.querySelector('.search-images-grid');
        const tabs    = body.querySelectorAll('.search-tab');
        const panels  = body.querySelectorAll('[data-tab-panel]');

        tabs.forEach(tab => tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            panels.forEach(p => p.classList.toggle('hidden', p.dataset.tabPanel !== tab.dataset.tab));
        }));

        const setLoading = () => {
            list.innerHTML = `<div class="search-loading"><div class="search-spinner"></div><span>Searching…</span></div>`;
            imgGrid.innerHTML = '';
        };

        const renderCards = (results) => {
            if (!results.length) {
                list.innerHTML = `<div class="search-empty">No results found</div>`;
                return;
            }
            list.innerHTML = results.map((r, i) => {
                let domain = '';
                try { domain = new URL(r.url).hostname.replace('www.', ''); } catch {}
                const favicon = `https://www.google.com/s2/favicons?domain=${domain}&sz=16`;
                const isBest = i === 0;
                return `
                <div class="src-card${isBest ? ' src-best' : ''}" data-idx="${i}">
                    ${isBest ? '<div class="src-best-badge">★ Best Match</div>' : ''}
                    <div class="src-header">
                        <img class="src-favicon" src="${favicon}" onerror="this.style.display='none'" />
                        <div class="src-meta">
                            <div class="src-title">${r.title || domain}</div>
                            <div class="src-domain">${domain}</div>
                        </div>
                    </div>
                    <div class="src-snippet">${r.snippet || ''}</div>
                    <div class="src-actions">
                        <button class="src-btn src-use" data-url="${encodeURIComponent(r.url)}" data-title="${encodeURIComponent(r.title||domain)}">⬇ Use in Workspace</button>
                        <button class="src-btn src-imgs" data-url="${encodeURIComponent(r.url)}">🖼 Images</button>
                        <a class="src-btn src-open" href="${r.url}" target="_blank" rel="noopener">↗</a>
                    </div>
                </div>`;
            }).join('');

            // Wire "Use in Workspace" buttons
            list.querySelectorAll('.src-use').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const url   = decodeURIComponent(btn.dataset.url);
                    const title = decodeURIComponent(btn.dataset.title);
                    btn.textContent = '⏳ Reading…';
                    btn.disabled = true;
                    try {
                        const resp = await fetch('/api/agent/scrape-url', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ url }) });
                        const scraped = await resp.json();
                        if (scraped.content) {
                            openPanel('text', title || 'Web Content', { text: `Source: ${url}\n\n# ${scraped.title || title}\n\n${scraped.description ? scraped.description + '\n\n' : ''}${scraped.content}` });
                            btn.textContent = '✓ Added';
                            btn.style.color = '#43e97b';
                        } else { btn.textContent = '✗ No content'; btn.disabled = false; }
                    } catch { btn.textContent = '✗ Error'; btn.disabled = false; }
                });
            });

            // Wire "Images" buttons
            list.querySelectorAll('.src-imgs').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const url = decodeURIComponent(btn.dataset.url);
                    btn.textContent = '⏳ Loading…';
                    btn.disabled = true;
                    try {
                        const resp = await fetch('/api/agent/scrape-url', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ url, includeImages: true }) });
                        const scraped = await resp.json();
                        if (scraped.images?.length) {
                            // Also populate the images tab
                            renderImgGrid(imgGrid, scraped.images, url);
                            // Switch to images tab
                            tabs.forEach(t => { t.classList.toggle('active', t.dataset.tab === 'images'); });
                            panels.forEach(p => p.classList.toggle('hidden', p.dataset.tabPanel !== 'images'));
                            btn.textContent = `🖼 ${scraped.images.length}`;
                        } else { btn.textContent = '✗ None found'; btn.disabled = false; }
                    } catch { btn.textContent = '✗ Error'; btn.disabled = false; }
                });
            });
        };

        const renderImgGrid = (container, images, sourceUrl) => {
            container.innerHTML = images.map(img => `
                <div class="sgrid-item" title="${img.alt || ''}">
                    <img src="${img.src}" loading="lazy" onerror="this.closest('.sgrid-item').remove()" />
                    <button class="sgrid-use" data-src="${encodeURIComponent(img.src)}" data-alt="${encodeURIComponent(img.alt||'')}">Use</button>
                </div>
            `).join('');
            container.querySelectorAll('.sgrid-use').forEach(b => {
                b.addEventListener('click', () => {
                    openPanel('image', decodeURIComponent(b.dataset.alt) || 'Image', { base64: decodeURIComponent(b.dataset.src), useUrl: true });
                });
            });
        };

        const doSearch = async () => {
            const q = input.value.trim();
            if (!q) return;
            setLoading();
            try {
                const r = await fetch('/api/agent/web-search', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ query: q }) });
                const data = await r.json();
                renderCards(data.results || []);
            } catch { list.innerHTML = `<div class="search-empty">Search failed — check connection</div>`; }
        };

        goBtn.addEventListener('click', doSearch);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });

        if (preloadedResults) renderCards(preloadedResults);
        else if (query) doSearch();
    }

    function renderImageGallery(body, images, sourceUrl) {
        body.innerHTML = `
            <div class="gallery-source">${sourceUrl ? `<a href="${sourceUrl}" target="_blank" rel="noopener">${sourceUrl}</a>` : 'Image Gallery'}</div>
            <div class="gallery-grid">
                ${images.map(img => `
                    <div class="gallery-item" title="${img.alt || ''}">
                        <img src="${img.src}" loading="lazy" onerror="this.closest('.gallery-item').remove()" />
                        <div class="gallery-caption">${img.alt || ''}</div>
                        <button class="gallery-use-btn" data-src="${encodeURIComponent(img.src)}" data-alt="${encodeURIComponent(img.alt||'')}">+ Add Panel</button>
                    </div>
                `).join('')}
            </div>
        `;
        body.querySelectorAll('.gallery-use-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                openPanel('image', decodeURIComponent(btn.dataset.alt) || 'Image', { base64: decodeURIComponent(btn.dataset.src), useUrl: true });
            });
        });
    }

    function renderCodeRunner(body, data) {
        body.innerHTML = `
            <textarea spellcheck="false" placeholder="# Write Python code here...">${data?.code || ''}</textarea>
            <button class="panel-code-run-btn">▶ Run</button>
            <div class="panel-code-output">Output will appear here</div>
        `;
        body.querySelector('.panel-code-run-btn').addEventListener('click', async () => {
            const code = body.querySelector('textarea').value;
            const output = body.querySelector('.panel-code-output');
            output.textContent = 'Running...';
            try {
                const r = await fetch('/api/agent/run-code', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({code, language:'python'}) });
                const result = await r.json();
                output.textContent = result.stdout || result.stderr || '(no output)';
                output.style.color = result.exitCode === 0 ? 'rgba(67,233,123,0.8)' : 'rgba(255,100,100,0.8)';
            } catch(e) { output.textContent = 'Error: ' + e.message; }
        });
    }

    // ═══════════════════════════════════════════════════════════════
    //  DRAG & RESIZE (zoom-aware)
    // ═══════════════════════════════════════════════════════════════
    function setupDrag(panel) {
        const header = panel.querySelector('.agent-panel-header');
        let dragging = false, sx, sy, ox, oy;
        header.addEventListener('pointerdown', (e) => {
            if (e.target.closest('.agent-panel-action')) return;
            dragging = true; sx = e.clientX; sy = e.clientY; ox = panel.offsetLeft; oy = panel.offsetTop;
            header.setPointerCapture(e.pointerId);
        });
        header.addEventListener('pointermove', (e) => {
            if (!dragging) return;
            panel.style.left = (ox + (e.clientX - sx) / zoom) + 'px';
            panel.style.top  = (oy + (e.clientY - sy) / zoom) + 'px';
        });
        header.addEventListener('pointerup', () => { if (dragging) { dragging = false; renderConnections(); } });
    }

    function setupResize(panel) {
        const handle = panel.querySelector('.agent-panel-resize');
        let resizing = false, sw, sh, sx, sy;
        handle.addEventListener('pointerdown', (e) => { resizing = true; sw = panel.offsetWidth; sh = panel.offsetHeight; sx = e.clientX; sy = e.clientY; handle.setPointerCapture(e.pointerId); e.stopPropagation(); });
        handle.addEventListener('pointermove', (e) => {
            if (!resizing) return;
            panel.style.width  = Math.max(300, sw + (e.clientX - sx) / zoom) + 'px';
            panel.style.height = Math.max(180, sh + (e.clientY - sy) / zoom) + 'px';
        });
        handle.addEventListener('pointerup', () => { if (resizing) { resizing = false; renderConnections(); } });
    }

    // ═══════════════════════════════════════════════════════════════
    //  CONNECTION HANDLES
    // ═══════════════════════════════════════════════════════════════
    function setupConnectionHandles(panel, panelId) {
        const handleOut = panel.querySelector('.handle-out');

        handleOut.addEventListener('mousedown', (e) => {
            e.stopPropagation(); e.preventDefault();
            connectingFrom = panelId;
            handleOut.classList.add('active');
            // Show all input handles
            document.querySelectorAll('.handle-in').forEach(h => h.classList.add('highlight'));

            const sx = panel.offsetLeft + panel.offsetWidth;
            const sy = panel.offsetTop + panel.offsetHeight / 2;
            tempLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            tempLine.setAttribute('x1', sx); tempLine.setAttribute('y1', sy);
            tempLine.setAttribute('x2', sx); tempLine.setAttribute('y2', sy);
            tempLine.setAttribute('stroke', 'rgba(94,106,210,0.6)');
            tempLine.setAttribute('stroke-width', '2');
            tempLine.setAttribute('stroke-dasharray', '6,4');
            svgOverlay.appendChild(tempLine);
        });
    }

    // Global mouse move/up for connection dragging
    window.addEventListener('mousemove', (e) => {
        if (!connectingFrom || !tempLine) return;
        const pos = screenToCanvas(e.clientX, e.clientY);
        tempLine.setAttribute('x2', pos.x);
        tempLine.setAttribute('y2', pos.y);
    });

    window.addEventListener('mouseup', (e) => {
        if (!connectingFrom) return;
        document.querySelectorAll('.handle-out.active, .handle-in.highlight').forEach(h => { h.classList.remove('active'); h.classList.remove('highlight'); });

        // Check if dropped on a panel
        const targetPanel = e.target.closest?.('.agent-panel');
        if (targetPanel && targetPanel.id !== connectingFrom) {
            connCounter++;
            connections.push({
                id: `conn-${connCounter}`,
                sourceId: connectingFrom,
                targetId: targetPanel.id,
                prompt: 'Process the data from the source panel and produce a useful output for the target panel.',
                label: 'Transform'
            });
            renderConnections();
        }

        if (tempLine) { tempLine.remove(); tempLine = null; }
        connectingFrom = null;
    });

    // ═══════════════════════════════════════════════════════════════
    //  CONNECTION EDITOR
    // ═══════════════════════════════════════════════════════════════
    let editingConn = null;

    function openConnEditor(conn, cx, cy) {
        editingConn = conn;
        document.getElementById('conn-label-input').value = conn.label || '';
        document.getElementById('conn-prompt-input').value = conn.prompt || '';
        connEditor.style.display = 'block';
        connEditor.style.left = Math.min(cx, window.innerWidth - 320) + 'px';
        connEditor.style.top = Math.min(cy, window.innerHeight - 300) + 'px';
    }

    document.getElementById('conn-close-btn').addEventListener('click', () => { connEditor.style.display = 'none'; editingConn = null; });
    document.getElementById('conn-delete-btn').addEventListener('click', () => {
        if (editingConn) { connections = connections.filter(c => c.id !== editingConn.id); renderConnections(); }
        connEditor.style.display = 'none'; editingConn = null;
    });
    document.getElementById('conn-run-btn').addEventListener('click', () => {
        if (editingConn) {
            editingConn.label = document.getElementById('conn-label-input').value || 'Transform';
            editingConn.prompt = document.getElementById('conn-prompt-input').value;
            renderConnections();
            executeConnection(editingConn);
        }
        connEditor.style.display = 'none'; editingConn = null;
    });

    async function executeConnection(conn) {
        const srcEl = document.getElementById(conn.sourceId);
        const tgtEl = document.getElementById(conn.targetId);
        if (!srcEl || !tgtEl) return;
        const srcContent = srcEl.querySelector('.agent-panel-body')?.textContent?.trim() || '';
        const tgtBody = tgtEl.querySelector('.agent-panel-body');
        setStatus(`Running: ${conn.label}...`, true);
        try {
            const r = await fetch('/api/chat', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: selectedModel, stream: true, messages: [
                    { role: 'system', content: conn.prompt || 'Process this data.' },
                    { role: 'user', content: srcContent }
                ]})
            });
            const reader = r.body.getReader();
            const decoder = new TextDecoder('utf-8');
            let buf = '', result = '';
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += decoder.decode(value, { stream: true });
                const lines = buf.split('\n'); buf = lines.pop();
                for (const line of lines) {
                    if (!line.trim()) continue;
                    try { const d = JSON.parse(line); if (d.message?.content) result += d.message.content; } catch {}
                }
            }
            const tgtPanel = panels.find(p => p.id === conn.targetId);
            if (tgtPanel?.toolId === 'text') { tgtBody.textContent = result; }
            else if (tgtPanel?.toolId === 'spreadsheet') {
                const rows = result.split('\n').map(r => r.split(',').map(c => c.trim()));
                renderSpreadsheet(tgtBody, tgtEl.querySelector('.agent-panel-status'), { rows }, tgtPanel.filename);
            } else { if (typeof marked !== 'undefined') tgtBody.innerHTML = marked.parse(result); else tgtBody.textContent = result; }
        } catch(e) { console.error('Connection execution failed:', e); }
        setStatus('Ready', false);
    }

    // ═══════════════════════════════════════════════════════════════
    //  TOOL DIRECTIVE PARSER
    // ═══════════════════════════════════════════════════════════════
    function parseToolDirectives(text) {
        const directives = [];
        // Match ```tool:TYPE filename="name"  OR  ```tool:TYPE  (filename optional)
        const regex = /```tool:(\w+)(?:\s+filename="([^"]*)")?[^\n]*\n([\s\S]*?)```/g;
        let m;
        while ((m = regex.exec(text)) !== null) {
            directives.push({ tool: m[1], filename: m[2] || (m[1] + '.txt'), content: m[3].trim() });
        }
        const sm = text.match(/\[SEARCH:\s*(.+?)\]/);
        if (sm) directives.push({ tool: 'search', query: sm[1] });
        return directives;
    }

    function executeDirectives(directives) {
        for (const d of directives) {
            if (d.tool === 'spreadsheet') { const rows = d.content.split('\n').map(l => l.split(',').map(c => c.trim())); openPanel('spreadsheet', d.filename, { rows }); }
            else if (d.tool === 'text') openPanel('text', d.filename, { text: d.content });
            else if (d.tool === 'code' || d.tool === 'python') openPanel('code', d.filename || 'script.py', { code: d.content });
            else if (d.tool === 'diagram' || d.tool === 'mermaid') openPanel('diagram', d.filename || 'diagram', { code: d.content });
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  WEB SEARCH
    // ═══════════════════════════════════════════════════════════════
    async function webSearch(query) {
        setStatus(`Searching: "${query}"…`, true);
        try {
            // Fetch parsed results
            const r = await fetch('/api/agent/web-search', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ query }) });
            const data = await r.json();
            const results = data.results || [];

            // Open a search panel pre-loaded with results (no duplicate network call)
            openPanel('search', `Search: ${query}`, { query, results });

            // Auto-scrape the best result so the agent can read the actual page
            if (results.length > 0) {
                setStatus(`Reading: ${results[0].url.slice(0, 48)}…`, true);
                try {
                    const sr = await fetch('/api/agent/scrape-url', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ url: results[0].url }) });
                    const scraped = await sr.json();
                    if (scraped.content) {
                        return [
                            { ...results[0], scrapedContent: scraped.content.substring(0, 8000), scrapedTitle: scraped.title },
                            ...results.slice(1)
                        ];
                    }
                } catch(e) { /* fallback to snippets only */ }
            }
            return results;
        } catch(e) { console.error('Search failed:', e); return []; }
    }

    // ═══════════════════════════════════════════════════════════════
    //  AGENT SYSTEM PROMPT
    // ═══════════════════════════════════════════════════════════════
    const AGENT_SYSTEM = `You are an AI Agent operating in a visual workspace canvas. You EXECUTE tasks immediately — you do NOT describe, plan, or announce what you will do. You just do it.

## CRITICAL RULE
**Output tool directives FIRST. Explain AFTER (briefly, 1 sentence).** Never say "I will create..." — just create it. Never say "Here is my plan..." — just execute it.

## Tool Directives — USE THESE TO CREATE WORKSPACE PANELS
Every response that involves data, analysis, or documents MUST contain at least one tool block.

\`\`\`tool:diagram filename="overview.mmd"
graph TD
    A[Input] --> B[Process]
    B --> C[Output]
\`\`\`

\`\`\`tool:spreadsheet filename="data.xlsx"
Header1, Header2, Header3
Value1, Value2, Value3
\`\`\`

\`\`\`tool:text filename="notes.md"
Content goes here...
\`\`\`

\`\`\`tool:code filename="script.py"
print("Hello World")
\`\`\`

## PDF Analysis — MANDATORY OUTPUT FORMAT
When PDF content is in context, IMMEDIATELY output ALL of the following (no preamble):

1. A structure diagram using Mermaid (graph TD showing sections/topics/relationships):
\`\`\`tool:diagram filename="[docname]-structure.mmd"
graph TD
    ...every section as a node...
\`\`\`

2. An executive summary text panel:
\`\`\`tool:text filename="[docname]-summary.md"
# [Document Title]
## Key Points
- ...bullet points from actual content...
## Main Findings
...
\`\`\`

3. A data spreadsheet IF the document contains any numbers, metrics, tables, or lists:
\`\`\`tool:spreadsheet filename="[docname]-data.xlsx"
Category, Value, Notes
...rows from the actual document...
\`\`\`

After the tool blocks, write 1-2 sentences summarizing what you created.

## Web Search
For current information: [SEARCH: your query here]
The search agent will automatically read the top result's full page content and inject it into context — use it to answer questions accurately. If the user asks about images on a topic, still trigger a search so the image scraping tools become available in the workspace panel.

## General Rules
- Use LaTeX ($..$ and $$..$$) for all math.
- Diagrams ALWAYS use real content from the document — never placeholder nodes like "A[Input]"
- Spreadsheet rows come from ACTUAL data in the document
- Text summaries use REAL quotes and findings from the document
- After creating artifacts, verify: "Did I cover all sections?"`;

    // ═══════════════════════════════════════════════════════════════
    //  AUTO-ANALYSIS DIRECTIVE PROMPT (used after PDF upload)
    // ═══════════════════════════════════════════════════════════════
    const PDF_AUTO_PROMPT = (filename) =>
        `PDF uploaded: "${filename}". Analyze the full document content above and immediately output tool directives. Do NOT describe what you will do — just output the tool blocks now. Required: (1) a diagram of the document structure using actual section names, (2) a text summary with real bullet points from the content, (3) a spreadsheet of any data/tables/metrics found.`;

    // ═══════════════════════════════════════════════════════════════
    //  AGENTIC PDF PIPELINE
    // ═══════════════════════════════════════════════════════════════
    async function runPdfPipeline(entry) {
        if (!entry.serverPath) return null;
        setStatus('Analyzing PDF structure...', true);
        try {
            const r = await fetch('/api/agent/analyze-pdf', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filePath: entry.serverPath })
            });
            const analysis = await r.json();
            if (!analysis.chunks?.length && !analysis.rawText) return null;

            // Build structured context for the LLM — include full content
            let pdfContext = `═══ PDF DOCUMENT CONTENT: ${entry.name} ═══\n`;
            pdfContext += `Pages: ${analysis.metadata?.pages || '?'} | Characters: ${analysis.metadata?.totalChars || '?'}\n`;
            pdfContext += `Sections: ${analysis.metadata?.sectionCount || 0} | Tables: ${analysis.metadata?.tableCount || 0} | Lists: ${analysis.metadata?.listCount || 0}\n\n`;

            if (analysis.chunks?.length) {
                for (const chunk of analysis.chunks) {
                    pdfContext += `--- [${chunk.type.toUpperCase()}] ${chunk.title} ---\n`;
                    // Include full content (up to 3000 chars per chunk to keep context manageable)
                    const content = chunk.charCount < 3000 ? chunk.content : chunk.content.substring(0, 3000) + `\n...[${chunk.charCount - 3000} more chars]`;
                    pdfContext += content + '\n\n';
                }
            } else if (analysis.rawText) {
                pdfContext += analysis.rawText.substring(0, 12000);
                if (analysis.rawText.length > 12000) pdfContext += `\n[...truncated at 12000/${analysis.rawText.length} chars]`;
            }

            pdfContext += `\n═══ END OF DOCUMENT ═══`;

            // Open the PDF in a viewer panel
            openPanel('pdf', entry.name, { src: `/api/files/serve?path=${encodeURIComponent(entry.serverPath)}` });

            setStatus('PDF analyzed — running agent...', true);

            // Auto-trigger analysis immediately — don't wait for user to type
            await autoAnalyzePdf(entry.name, pdfContext);
            // Mark so chat submit won't re-inject this context (already in agentHistory)
            entry.pdfContextInHistory = true;

            setStatus('Ready', false);
            return pdfContext;
        } catch (e) {
            console.error('PDF pipeline error:', e);
            setStatus('PDF analysis failed', false);
            return null;
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  AUTO-ANALYZE PDF — streams LLM response and creates panels
    // ═══════════════════════════════════════════════════════════════
    async function autoAnalyzePdf(filename, pdfContext) {
        if (isGenerating) return;
        isGenerating = true;
        if (emptyState) emptyState.style.display = 'none';

        // Show "user" trigger message
        addMessage('user', `📕 Analyzing "${filename}"...`);

        // Single system message: AGENT_SYSTEM + PDF content merged
        const combinedSystem = AGENT_SYSTEM + '\n\n' + pdfContext;
        const userMsg = { role: 'user', content: PDF_AUTO_PROMPT(filename) };

        // Keep history so follow-up questions have context (use user role for pdfContext to avoid Ollama issues)
        agentHistory.push({ role: 'user', content: `[Document loaded: ${filename}]\n\n${pdfContext}` });
        agentHistory.push({ role: 'assistant', content: `Document received. Analyzing "${filename}" now.` });
        agentHistory.push(userMsg);

        const contentDiv = addMessage('assistant', '');
        let fullText = '';
        setStatus('Generating analysis...', true);

        try {
            const response = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: selectedModel,
                    stream: true,
                    messages: [
                        { role: 'system', content: combinedSystem },
                        userMsg
                    ]
                })
            });

            if (!response.ok) throw new Error('API error ' + response.status);

            const reader = response.body.getReader();
            const decoder = new TextDecoder('utf-8');
            let buf = '', done = false, renderPending = false;

            const render = () => {
                let t = fullText.replace(/\\\[/g, '$$').replace(/\\\]/g, '$$').replace(/\\\(/g, '$').replace(/\\\)/g, '$');
                if (typeof marked !== 'undefined') contentDiv.innerHTML = marked.parse(t);
                else contentDiv.textContent = t;
                const atBottom = chatContainer.scrollHeight - chatContainer.clientHeight <= chatContainer.scrollTop + 100;
                if (atBottom) chatContainer.scrollTop = chatContainer.scrollHeight;
                renderPending = false;
            };

            while (!done) {
                const chunk = await reader.read();
                if (chunk.done) break;
                buf += decoder.decode(chunk.value, { stream: true });
                const lines = buf.split('\n'); buf = lines.pop();
                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const d = JSON.parse(line);
                        if (d.done) { done = true; break; }
                        if (d.message?.content) {
                            fullText += d.message.content;
                            if (!renderPending) { renderPending = true; requestAnimationFrame(render); }
                        }
                    } catch {}
                }
            }
            render();

            agentHistory.push({ role: 'assistant', content: fullText });

            const directives = parseToolDirectives(fullText);
            if (directives.length) {
                // Space panels across canvas starting at x=60
                let xOffset = 60;
                for (const d of directives) {
                    if (d.tool === 'spreadsheet') {
                        const rows = d.content.split('\n').map(l => l.split(',').map(c => c.trim()));
                        openPanel('spreadsheet', d.filename, { rows }, xOffset, 60);
                    } else if (d.tool === 'text') {
                        openPanel('text', d.filename, { text: d.content }, xOffset, 60);
                    } else if (d.tool === 'code' || d.tool === 'python') {
                        openPanel('code', d.filename || 'script.py', { code: d.content }, xOffset, 60);
                    } else if (d.tool === 'diagram' || d.tool === 'mermaid') {
                        openPanel('diagram', d.filename || 'diagram.mmd', { code: d.content }, xOffset, 60);
                    }
                    xOffset += 520;
                }
            }

            if (!currentAgentChatId) currentAgentChatId = `agent_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
            fetch('/api/chats', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ id: currentAgentChatId, history: agentHistory, isAgentChat: true, title: `Agent: ${filename}` }) }).catch(()=>{});

        } catch(err) {
            contentDiv.innerHTML = `<span style="color:#ff6464">Analysis error: ${err.message}</span>`;
        }

        isGenerating = false;
        updateSendState();
    }

    // ═══════════════════════════════════════════════════════════════
    //  CHAT SUBMIT
    // ═══════════════════════════════════════════════════════════════
    chatForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (isGenerating) return;
        const text = userInput.value.trim();
        const hasImages = attachedFiles.some(f => f.base64);
        if (!text && !hasImages) return;

        const messageText = text || 'Analyze these files.';
        userInput.value = ''; userInput.style.height = 'auto'; sendBtn.disabled = true; isGenerating = true;

        const imageDisplay = attachedFiles.filter(f => f.base64).map(f => ({ base64: f.base64, type: 'image/png', name: f.name }));
        addMessage('user', messageText, imageDisplay);

        let context = '';
        if (attachedFiles.length) {
            // Inject PDF analyses only if not already in agentHistory (auto-analysis didn't run)
            attachedFiles.forEach(f => { if (f.pdfAnalysis && !f.pdfContextInHistory) context += f.pdfAnalysis + '\n\n'; });
            // Regular file content (non-PDF)
            const nonPdfFiles = attachedFiles.filter(f => f.content && !f.pdfAnalysis);
            if (nonPdfFiles.length) {
                context += '--- Attached Files ---';
                nonPdfFiles.forEach(f => { context += `\n\n[File: ${f.name}]\n${f.content}\n[End of ${f.name}]`; });
                context += '\n--- End Attached Files ---';
            }
        }
        panels.forEach(p => {
            const el = document.getElementById(p.id); if (!el) return;
            const body = el.querySelector('.agent-panel-body'); if (!body) return;
            const t = body.textContent?.trim();
            if (t && t.length < 8000) context += `\n\n--- Open Panel: ${p.filename || p.toolId} ---\n${t}\n--- End Panel ---`;
        });
        if (connections.length) {
            context += '\n\n--- Connections ---';
            connections.forEach(c => {
                const src = panels.find(p => p.id === c.sourceId);
                const tgt = panels.find(p => p.id === c.targetId);
                context += `\n${src?.filename||src?.toolId||'?'} → [${c.label}] → ${tgt?.filename||tgt?.toolId||'?'}`;
            });
            context += '\n--- End Connections ---';
        }
        // Fold workspace context into the user message (Ollama only allows system at position 0)
        const fullUserContent = context ? `[Workspace context:${context}]\n\nUser: ${messageText}` : messageText;
        agentHistory.push({ role: 'user', content: fullUserContent });

        const currentAttached = [...attachedFiles]; attachedFiles = []; renderAttached();
        setStatus('Generating...', true);

        const contentDiv = addMessage('assistant', '');
        let fullText = '';
        try {
            const base64Images = currentAttached.filter(f => f.base64).map(f => f.base64);
            const endpoint = base64Images.length ? '/api/chat/vision' : '/api/chat';
            const reqBody = { messages: [{ role: 'system', content: AGENT_SYSTEM }, ...agentHistory], stream: true, model: selectedModel };
            if (base64Images.length) reqBody.images = base64Images;

            const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reqBody) });
            if (!response.ok) throw new Error('API error');

            const reader = response.body.getReader();
            const decoder = new TextDecoder('utf-8');
            let buf = '', done = false, renderPending = false;
            const render = () => {
                let t = fullText.replace(/\\\[/g, '$$').replace(/\\\]/g, '$$').replace(/\\\(/g, '$').replace(/\\\)/g, '$');
                if (typeof marked !== 'undefined') contentDiv.innerHTML = marked.parse(t);
                else contentDiv.textContent = t;
                const atBottom = chatContainer.scrollHeight - chatContainer.clientHeight <= chatContainer.scrollTop + 100;
                if (atBottom) chatContainer.scrollTop = chatContainer.scrollHeight;
                renderPending = false;
            };

            while (!done) {
                const chunk = await reader.read();
                if (chunk.done) break;
                buf += decoder.decode(chunk.value, { stream: true });
                const lines = buf.split('\n'); buf = lines.pop();
                for (const line of lines) {
                    if (!line.trim()) continue;
                    try { const d = JSON.parse(line); if (d.done) { done = true; break; } if (d.message?.content) { fullText += d.message.content; if (!renderPending) { renderPending = true; requestAnimationFrame(render); } } } catch {}
                }
                const sm = fullText.match(/\[SEARCH:\s*(.+?)\]/);
                if (sm && !fullText.includes('[SEARCH_DONE]')) {
                    const results = await webSearch(sm[1]);
                    if (results.length) {
                        const ctx = results.map((r, i) => {
                            let entry = `${i+1}. ${r.title}\nURL: ${r.url}\nSnippet: ${r.snippet}`;
                            if (r.scrapedContent) entry += `\n\nFull page content (${r.scrapedTitle || r.title}):\n${r.scrapedContent}`;
                            return entry;
                        }).join('\n\n---\n\n');
                        agentHistory.push({ role: 'system', content: `Web search results for "${sm[1]}":\n\n${ctx}` });
                    }
                    fullText += '\n[SEARCH_DONE]';
                }
            }
            render();
            agentHistory.push({ role: 'assistant', content: fullText });
            const directives = parseToolDirectives(fullText);
            if (directives.length) executeDirectives(directives);

            // ── Critic / Verification Pass ──
            // If PDFs were analyzed, run a brief self-check
            const hadPdf = currentAttached.some(f => f.pdfAnalysis);
            if (hadPdf && directives.length > 0) {
                setStatus('Verifying output...', true);
                try {
                    const criticReq = await fetch('/api/chat', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            model: selectedModel, stream: true,
                            messages: [
                                { role: 'system', content: 'You are a Critic Agent. Review the analysis below for completeness and accuracy. If anything was missed or seems wrong, point it out briefly. If the analysis looks good, say "Verification: All sections covered." Keep it under 3 sentences.' },
                                { role: 'user', content: `Original document context:\n${currentAttached.filter(f=>f.pdfAnalysis).map(f=>f.pdfAnalysis).join('\n')}\n\nAgent output:\n${fullText}` }
                            ]
                        })
                    });
                    const criticReader = criticReq.body.getReader();
                    const criticDecoder = new TextDecoder('utf-8');
                    let criticBuf = '', criticText = '';
                    while (true) {
                        const { done: cd, value: cv } = await criticReader.read();
                        if (cd) break;
                        criticBuf += criticDecoder.decode(cv, { stream: true });
                        const cLines = criticBuf.split('\n'); criticBuf = cLines.pop();
                        for (const cl of cLines) {
                            if (!cl.trim()) continue;
                            try { const d = JSON.parse(cl); if (d.message?.content) criticText += d.message.content; } catch {}
                        }
                    }
                    if (criticText.trim()) {
                        const verifyDiv = document.createElement('div');
                        verifyDiv.className = 'message assistant';
                        verifyDiv.innerHTML = `<div class="avatar" style="background:rgba(67,233,123,0.15);color:#43e97b;font-size:0.7rem">✓</div><div class="message-content" style="opacity:0.7;font-size:0.85rem;border-left:2px solid rgba(67,233,123,0.3);padding-left:10px"><strong>Verification:</strong> ${criticText}</div>`;
                        chatContainer.appendChild(verifyDiv);
                        chatContainer.scrollTop = chatContainer.scrollHeight;
                        agentHistory.push({ role: 'system', content: `[Critic verification]: ${criticText}` });
                    }
                } catch(e) { console.error('Critic pass failed:', e); }
            }

            if (!currentAgentChatId) currentAgentChatId = `agent_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
            fetch('/api/chats', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ id: currentAgentChatId, history: agentHistory, isAgentChat: true, title: `Agent: ${messageText.substring(0,25)}...` }) }).catch(()=>{});
        } catch(err) { contentDiv.innerHTML = `<span style="color:#ff6464">Error: ${err.message}</span>`; }

        isGenerating = false; setStatus('Ready', false); updateSendState();
    });

    // ═══════════════════════════════════════════════════════════════
    //  TOOL SPAWNER + TOOLBAR
    // ═══════════════════════════════════════════════════════════════
    function spawnTool(toolId, atX, atY) {
        if (toolId === 'search') {
            const panelResult = openPanel('search', 'Web Search', { query: '', results: null }, atX, atY);
            // Focus the input after render
            requestAnimationFrame(() => {
                const inp = panelResult?.body?.querySelector('.search-input-bottom');
                if (inp) inp.focus();
            });
        }
        else if (toolId === 'spreadsheet') openPanel('spreadsheet', 'New Spreadsheet.xlsx', { rows: [['A','B','C'],['','','']] }, atX, atY);
        else if (toolId === 'text') openPanel('text', 'Untitled.md', { text: '' }, atX, atY);
        else if (toolId === 'code') openPanel('code', 'script.py', { code: '' }, atX, atY);
        else if (toolId === 'diagram') openPanel('diagram', 'diagram.mmd', { code: 'graph TD\n    A[Start] --> B[End]' }, atX, atY);
    }

    document.querySelectorAll('.agent-top-btn[data-tool]').forEach(btn => btn.addEventListener('click', () => spawnTool(btn.dataset.tool)));

    // ═══════════════════════════════════════════════════════════════
    //  CLEAR / NEW CHAT
    // ═══════════════════════════════════════════════════════════════
    const clearBtn = document.getElementById('agent-clear-workspace');
    if (clearBtn) clearBtn.addEventListener('click', () => {
        panels.forEach(p => { const el = document.getElementById(p.id); if (el) el.remove(); });
        panels = []; connections = []; renderConnections();
        if (panelsEmpty) panelsEmpty.style.display = '';
    });

    const newChatBtn = document.getElementById('agent-new-chat');
    if (newChatBtn) newChatBtn.addEventListener('click', () => {
        agentHistory = []; currentAgentChatId = null;
        chatContainer.innerHTML = '';
        if (emptyState) emptyState.style.display = '';
    });

    // ═══════════════════════════════════════════════════════════════
    //  ZOOM
    // ═══════════════════════════════════════════════════════════════
    agentCanvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        const factor = e.deltaY > 0 ? 0.92 : 1.08;
        const newZoom = Math.max(0.15, Math.min(3, zoom * factor));
        const r = agentCanvas.getBoundingClientRect();
        const mx = e.clientX - r.left, my = e.clientY - r.top;
        panX = mx - (mx - panX) * (newZoom / zoom);
        panY = my - (my - panY) * (newZoom / zoom);
        zoom = newZoom;
        applyTransform(); updateZoomDisplay();
    }, { passive: false });

    document.getElementById('agent-zoom-in')?.addEventListener('click', () => { zoom = Math.min(3, zoom * 1.2); applyTransform(); updateZoomDisplay(); });
    document.getElementById('agent-zoom-out')?.addEventListener('click', () => { zoom = Math.max(0.15, zoom * 0.8); applyTransform(); updateZoomDisplay(); });
    document.getElementById('agent-zoom-reset')?.addEventListener('click', () => { zoom = 1; panX = 0; panY = 0; applyTransform(); updateZoomDisplay(); });

    // ═══════════════════════════════════════════════════════════════
    //  CANVAS PANNING
    // ═══════════════════════════════════════════════════════════════
    agentCanvas.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        if (e.target.closest('.agent-panel') || e.target.closest('.agent-context-menu') || e.target.closest('.agent-panel-handle')) return;
        isPanning = true; panStartX = e.clientX; panStartY = e.clientY; panOriginX = panX; panOriginY = panY;
        agentCanvas.classList.add('is-panning'); e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
        if (isPanning) { panX = panOriginX + (e.clientX - panStartX); panY = panOriginY + (e.clientY - panStartY); applyTransform(); }
    });

    window.addEventListener('mouseup', () => { if (isPanning) { isPanning = false; agentCanvas.classList.remove('is-panning'); } });

    // ═══════════════════════════════════════════════════════════════
    //  CONTEXT MENU
    // ═══════════════════════════════════════════════════════════════
    agentCanvas.addEventListener('contextmenu', (e) => {
        if (e.target.closest('.agent-panel')) return;
        e.preventDefault();
        ctxMenu.style.display = 'block';
        const pos = screenToCanvas(e.clientX, e.clientY);
        ctxMenu._canvasX = pos.x; ctxMenu._canvasY = pos.y;
        ctxMenu.style.left = Math.min(e.clientX, window.innerWidth - 200) + 'px';
        ctxMenu.style.top = Math.min(e.clientY, window.innerHeight - 200) + 'px';
    });

    ctxMenu.querySelectorAll('.agent-ctx-item').forEach(item => item.addEventListener('click', () => {
        spawnTool(item.dataset.tool, ctxMenu._canvasX, ctxMenu._canvasY);
        ctxMenu.style.display = 'none';
    }));
    document.addEventListener('click', (e) => { if (!ctxMenu.contains(e.target)) ctxMenu.style.display = 'none'; });
    document.addEventListener('contextmenu', (e) => { if (!agentCanvas.contains(e.target) || e.target.closest('.agent-panel')) ctxMenu.style.display = 'none'; });

    // ═══════════════════════════════════════════════════════════════
    //  CHAT SIDEBAR COLLAPSE / EXPAND / RESIZE
    // ═══════════════════════════════════════════════════════════════
    const chatSidebar = document.getElementById('agent-chat-sidebar');
    const chatCollapseBtn = document.getElementById('agent-chat-collapse');
    const chatExpandBtn = document.getElementById('agent-chat-expand');
    const chatResizeHandle = document.getElementById('agent-chat-resize-handle');

    chatCollapseBtn.addEventListener('click', () => { chatSidebar.classList.add('collapsed'); chatResizeHandle.style.display = 'none'; chatExpandBtn.classList.add('visible'); });
    chatExpandBtn.addEventListener('click', () => { chatSidebar.classList.remove('collapsed'); chatResizeHandle.style.display = ''; chatExpandBtn.classList.remove('visible'); });

    let isResizingChat = false, chatResizeStartX = 0, chatResizeStartW = 0;
    chatResizeHandle.addEventListener('mousedown', (e) => { isResizingChat = true; chatResizeStartX = e.clientX; chatResizeStartW = chatSidebar.offsetWidth; chatResizeHandle.classList.add('resizing'); e.preventDefault(); });
    window.addEventListener('mousemove', (e) => { if (isResizingChat) { chatSidebar.style.width = Math.max(220, Math.min(620, chatResizeStartW + (chatResizeStartX - e.clientX))) + 'px'; } });
    window.addEventListener('mouseup', () => { if (isResizingChat) { isResizingChat = false; chatResizeHandle.classList.remove('resizing'); } });

    // ═══════════════════════════════════════════════════════════════
    //  LEFT SIDEBAR
    // ═══════════════════════════════════════════════════════════════
    const leftSidebar = document.getElementById('agent-left-sidebar');
    const leftCollapseBtn = document.getElementById('agent-left-collapse');
    const leftExpandBtn = document.getElementById('agent-left-expand');

    leftCollapseBtn.addEventListener('click', () => { leftSidebar.classList.add('collapsed'); leftExpandBtn.style.display = 'flex'; });
    leftExpandBtn.addEventListener('click', () => { leftSidebar.classList.remove('collapsed'); leftExpandBtn.style.display = 'none'; });

    // File explorer
    const explorerHeader = document.getElementById('agent-explorer-header');
    const explorerChevron = document.getElementById('agent-explorer-chevron');
    const fileTree = document.getElementById('agent-file-tree');

    explorerHeader.addEventListener('click', () => { const c = fileTree.classList.toggle('hidden'); explorerChevron.classList.toggle('collapsed', c); });

    function renderFileTreeItems(items, depth) {
        return items.map(f => {
            const indent = depth * 12;
            if (f.isDirectory) {
                const children = f.children?.length ? renderFileTreeItems(f.children, depth+1) : '';
                return `<div class="agent-file-item is-folder" style="padding-left:${8+indent}px" title="${f.name}">📁 ${f.name}</div>${children}`;
            }
            return `<div class="agent-file-item" style="padding-left:${8+indent}px" data-path="${f.path||f.name}" title="${f.name}">${fileIcon(f.name)} ${f.name}</div>`;
        }).join('');
    }

    async function loadAgentFileTree() {
        try {
            const r = await fetch('/api/files');
            if (!r.ok) throw new Error();
            const items = await r.json();
            if (!Array.isArray(items) || !items.length) { fileTree.innerHTML = '<div class="agent-file-loading">No files found</div>'; return; }
            fileTree.innerHTML = renderFileTreeItems(items, 0);
            fileTree.querySelectorAll('.agent-file-item:not(.is-folder)').forEach(item => {
                item.addEventListener('click', () => {
                    const p = item.dataset.path, name = item.title;
                    const ext = name.split('.').pop().toLowerCase();
                    if (ext === 'pdf') openPanel('pdf', name, { src: `/api/files/serve?path=${encodeURIComponent(p)}` });
                    else if (['png','jpg','jpeg','gif','webp'].includes(ext)) {
                        fetch(`/api/files/serve?path=${encodeURIComponent(p)}`).then(r=>r.blob()).then(blob => {
                            openPanel('image', name, { base64: URL.createObjectURL(blob), useUrl: true, type: `image/${ext}` });
                        });
                    } else if (['txt','md','json','js','py','css','html'].includes(ext)) {
                        fetch(`/api/files/read?path=${encodeURIComponent(p)}`).then(r=>r.json()).then(d => {
                            openPanel('text', name, { text: d.content || '' });
                        }).catch(()=>{});
                    } else if (['xlsx','xls','csv'].includes(ext)) {
                        fetch(`/api/files/read?path=${encodeURIComponent(p)}`).then(r=>r.json()).then(d => {
                            openPanel('spreadsheet', name, { csv: d.content || '' });
                        }).catch(()=>{});
                    }
                });
            });
        } catch { fileTree.innerHTML = '<div class="agent-file-loading">Set a path in Settings</div>'; }
    }

    // ═══════════════════════════════════════════════════════════════
    //  WORKSPACE SAVE / LOAD
    // ═══════════════════════════════════════════════════════════════
    const workspaceList = document.querySelector('.agent-workspace-list');

    function getPanelContent(toolId, body) {
        if (toolId === 'text') return body.textContent || '';
        if (toolId === 'spreadsheet') {
            const rows = []; body.querySelectorAll('tr').forEach(tr => { const r = []; tr.querySelectorAll('th,td').forEach(c => r.push(c.textContent)); rows.push(r); });
            return JSON.stringify(rows);
        }
        if (toolId === 'code') return body.querySelector('textarea')?.value || '';
        if (toolId === 'diagram') return body.querySelector('.mermaid')?.textContent || '';
        return '';
    }

    function getWorkspaceState() {
        return {
            panels: panels.map(p => {
                const el = document.getElementById(p.id); if (!el) return null;
                const body = el.querySelector('.agent-panel-body');
                return { toolId: p.toolId, filename: p.filename, x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight, content: getPanelContent(p.toolId, body) };
            }).filter(Boolean),
            connections: connections.map(c => ({ ...c })),
            pan: { x: panX, y: panY }, zoom,
            chatHistory: agentHistory
        };
    }

    async function saveWorkspace(name) {
        const state = getWorkspaceState();
        state.name = name || 'Untitled Workspace';
        if (currentWorkspaceId) state.id = currentWorkspaceId;
        try {
            const r = await fetch('/api/agent/workspaces', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state) });
            const d = await r.json();
            currentWorkspaceId = d.id;
            loadWorkspaceList();
            setStatus('Workspace saved', false);
        } catch(e) { console.error('Save failed:', e); }
    }

    async function loadWorkspace(id) {
        try {
            const r = await fetch(`/api/agent/workspaces/${id}`);
            const ws = await r.json();
            // Clear current state
            panels.forEach(p => { const el = document.getElementById(p.id); if (el) el.remove(); });
            panels = []; connections = []; panelCounter = 0; connCounter = 0;

            // Restore pan/zoom
            panX = ws.pan?.x || 0; panY = ws.pan?.y || 0; zoom = ws.zoom || 1;
            applyTransform(); updateZoomDisplay();

            // Restore panels
            const idMap = {}; // old id → new id
            for (const p of (ws.panels || [])) {
                let data = {};
                if (p.toolId === 'text') data = { text: p.content };
                else if (p.toolId === 'code') data = { code: p.content };
                else if (p.toolId === 'diagram') data = { code: p.content };
                else if (p.toolId === 'spreadsheet') { try { data = { rows: JSON.parse(p.content) }; } catch { data = { rows: [['A','B','C']] }; } }
                else if (p.toolId === 'search') data = { query: p.filename?.replace('Search: ', '') || '' };
                else data = {};
                const result = openPanel(p.toolId, p.filename, data, p.x, p.y);
                const el = document.getElementById(result.id);
                if (el) { el.style.width = p.w + 'px'; el.style.height = p.h + 'px'; }
                idMap[p.id || result.id] = result.id;
            }

            // Restore connections (remap IDs)
            for (const c of (ws.connections || [])) {
                connCounter++;
                connections.push({ id: `conn-${connCounter}`, sourceId: idMap[c.sourceId] || c.sourceId, targetId: idMap[c.targetId] || c.targetId, prompt: c.prompt, label: c.label });
            }
            renderConnections();

            // Restore chat
            agentHistory = ws.chatHistory || [];
            currentWorkspaceId = ws.id;
            currentAgentChatId = null;
            chatContainer.innerHTML = '';
            if (emptyState) emptyState.style.display = agentHistory.length ? 'none' : '';
            agentHistory.filter(m => m.role === 'user' || m.role === 'assistant').forEach(m => addMessage(m.role, m.content));

            if (panelsEmpty) panelsEmpty.style.display = panels.length ? 'none' : '';
            setStatus(`Loaded: ${ws.name}`, false);
        } catch(e) { console.error('Load failed:', e); }
    }

    async function loadWorkspaceList() {
        try {
            const r = await fetch('/api/agent/workspaces');
            const list = await r.json();

            workspaceList.innerHTML = '';

            // "New workspace" button
            const newBtn = document.createElement('button');
            newBtn.className = 'agent-workspace-new';
            newBtn.innerHTML = '<span>+</span><span>New Workspace</span>';
            newBtn.addEventListener('click', () => {
                const name = prompt('Workspace name:', 'Untitled Workspace');
                if (!name) return;
                // Clear everything
                panels.forEach(p => { const el = document.getElementById(p.id); if (el) el.remove(); });
                panels = []; connections = []; agentHistory = []; currentWorkspaceId = null; currentAgentChatId = null;
                chatContainer.innerHTML = ''; if (emptyState) emptyState.style.display = '';
                if (panelsEmpty) panelsEmpty.style.display = '';
                panX = 0; panY = 0; zoom = 1; applyTransform(); updateZoomDisplay();
                renderConnections();
                saveWorkspace(name);
            });
            workspaceList.appendChild(newBtn);

            for (const ws of list) {
                const item = document.createElement('div');
                item.className = 'agent-workspace-item' + (ws.id === currentWorkspaceId ? ' active' : '');
                item.innerHTML = `<span>📋</span><span style="flex:1;overflow:hidden;text-overflow:ellipsis">${ws.name}</span>
                    <div class="ws-actions">
                        <button class="ws-action-btn" title="Save" data-action="save">💾</button>
                        <button class="ws-action-btn delete" title="Delete" data-action="delete">✕</button>
                    </div>`;
                item.addEventListener('click', (e) => {
                    if (e.target.closest('.ws-action-btn')) return;
                    loadWorkspace(ws.id);
                    workspaceList.querySelectorAll('.agent-workspace-item').forEach(i => i.classList.remove('active'));
                    item.classList.add('active');
                });
                item.querySelector('[data-action="save"]').addEventListener('click', (e) => {
                    e.stopPropagation();
                    currentWorkspaceId = ws.id;
                    saveWorkspace(ws.name);
                });
                item.querySelector('[data-action="delete"]').addEventListener('click', async (e) => {
                    e.stopPropagation();
                    if (!confirm(`Delete workspace "${ws.name}"?`)) return;
                    await fetch(`/api/agent/workspaces/${ws.id}`, { method: 'DELETE' });
                    if (currentWorkspaceId === ws.id) currentWorkspaceId = null;
                    loadWorkspaceList();
                });
                workspaceList.appendChild(item);
            }
        } catch { /* no workspaces yet */ }
    }

    // Auto-save on Ctrl+S
    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 's' && agentView.classList.contains('active')) {
            e.preventDefault();
            if (currentWorkspaceId) saveWorkspace();
            else { const name = prompt('Save workspace as:', 'Untitled Workspace'); if (name) saveWorkspace(name); }
        }
    });

    // ═══════════════════════════════════════════════════════════════
    //  INNER TAB SWITCHING
    // ═══════════════════════════════════════════════════════════════
    document.querySelectorAll('.agent-inner-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.agent-inner-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.agent-tab-panel').forEach(p => p.classList.remove('active'));
            tab.classList.add('active');
            const panel = document.getElementById('agtab-' + tab.dataset.agtab);
            if (panel) panel.classList.add('active');
            // Lazy-init tabs on first visit
            if (tab.dataset.agtab === 'life' && !lifeInitialized) initLifeTab();
            if (tab.dataset.agtab === 'pdf' && !pfeInitialized) initPdfStudio();
        });
    });

    // ═══════════════════════════════════════════════════════════════
    //  PDF STUDIO — MANUSCRIPT EDITOR
    // ═══════════════════════════════════════════════════════════════
    // PDF.js setup
    if (typeof pdfjsLib !== 'undefined') {
        pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
    }

    const PFE = {
        file: null,          // { name, serverPath }
        pdfDoc: null,        // PDF.js document
        totalPages: 0,
        currentPage: 1,
        zoom: 1.5,
        blocks: [],          // [{ id, type, content, originalContent, pageNum }]
        selected: new Set(), // selected block IDs
        dragSrcId: null,
        initialized: false
    };

    let pfeInitialized = false;

    function initPdfStudio() {
        if (pfeInitialized) return;
        pfeInitialized = true;

        const viewer    = document.getElementById('pfe-viewer');
        const viewerScroll = document.getElementById('pfe-viewer-scroll');
        const viewerEmpty  = document.getElementById('pfe-viewer-empty');
        const editorScroll = document.getElementById('pfe-editor-scroll');
        const editorEmpty  = document.getElementById('pfe-editor-empty');
        const editorHeader = document.getElementById('pfe-editor-header');
        const selCount     = document.getElementById('pfe-sel-count');
        const pageInfo     = document.getElementById('pfe-page-info');
        const aiInput      = document.getElementById('pfe-ai-input');
        const aiSend       = document.getElementById('pfe-ai-send');
        const openBtn      = document.getElementById('pfe-open-btn');
        const fileInput    = document.getElementById('pfe-file-input');
        const exportMdBtn  = document.getElementById('pfe-export-md-btn');
        const exportCanvasBtn = document.getElementById('pfe-export-canvas-btn');
        const prevBtn      = document.getElementById('pfe-prev-btn');
        const nextBtn      = document.getElementById('pfe-next-btn');
        const splitter     = document.getElementById('pfe-splitter');

        if (!viewer) return; // HTML not ready yet

        // Open button
        openBtn.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', () => {
            if (fileInput.files[0]) { loadPfeFile(fileInput.files[0]); fileInput.value = ''; }
        });

        // Drag-drop on viewer
        viewer.addEventListener('dragover', e => { e.preventDefault(); viewer.classList.add('drag-over'); });
        viewer.addEventListener('dragleave', () => viewer.classList.remove('drag-over'));
        viewer.addEventListener('drop', e => {
            e.preventDefault(); viewer.classList.remove('drag-over');
            const f = [...e.dataTransfer.files].find(f => f.name.endsWith('.pdf'));
            if (f) loadPfeFile(f);
        });

        // Page nav
        prevBtn.addEventListener('click', () => { if (PFE.currentPage > 1) { PFE.currentPage--; scrollToPage(PFE.currentPage); updatePageInfo(); }});
        nextBtn.addEventListener('click', () => { if (PFE.currentPage < PFE.totalPages) { PFE.currentPage++; scrollToPage(PFE.currentPage); updatePageInfo(); }});

        // AI bar pills
        document.querySelectorAll('.pfe-pill').forEach(pill => {
            pill.addEventListener('click', () => {
                aiInput.value = pill.dataset.prompt || pill.textContent;
                aiInput.focus();
            });
        });

        // AI send
        aiSend.addEventListener('click', runAiBulk);
        aiInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); runAiBulk(); }});

        // Export
        exportMdBtn.addEventListener('click', exportMarkdown);
        exportCanvasBtn.addEventListener('click', sendToCanvas);

        // Splitter drag
        let splitterDragging = false, splitterStartX = 0, splitterStartW = 0;
        splitter.addEventListener('mousedown', e => {
            splitterDragging = true;
            splitterStartX = e.clientX;
            splitterStartW = viewer.offsetWidth;
            splitter.classList.add('dragging');
            document.body.style.userSelect = 'none';
        });
        document.addEventListener('mousemove', e => {
            if (!splitterDragging) return;
            const delta = e.clientX - splitterStartX;
            const newW = Math.max(180, Math.min(splitterStartW + delta, viewer.parentElement.offsetWidth - 300));
            viewer.style.width = newW + 'px';
        });
        document.addEventListener('mouseup', () => {
            if (splitterDragging) { splitterDragging = false; splitter.classList.remove('dragging'); document.body.style.userSelect = ''; }
        });

        async function loadPfeFile(file) {
            PFE.file = { name: file.name };
            PFE.blocks = [];
            PFE.selected.clear();
            renderBlocks();

            // Show loading state
            viewerEmpty.style.display = 'none';
            viewerScroll.innerHTML = '<div style="color:rgba(255,255,255,0.3);text-align:center;padding:40px;font-size:0.82rem;">Loading PDF…</div>';

            try {
                // Upload file
                const fd = new FormData();
                fd.append('file', file);
                const ur = await fetch('/api/files/upload?target=temp', { method: 'POST', body: fd });
                const ud = await ur.json();
                if (!ud.path) throw new Error('Upload failed');
                PFE.file.serverPath = ud.path;

                // Render with PDF.js
                const arrayBuf = await file.arrayBuffer();
                PFE.pdfDoc = await pdfjsLib.getDocument({ data: arrayBuf }).promise;
                PFE.totalPages = PFE.pdfDoc.numPages;
                PFE.currentPage = 1;
                updatePageInfo();
                await renderPdfPages();

                // Extract blocks via server
                editorEmpty.innerHTML = '<div class="pfe-block-thinking">Extracting content…</div>';
                const ar = await fetch('/api/agent/analyze-pdf', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ filePath: ud.path })
                });
                const analysis = await ar.json();
                buildBlocksFromAnalysis(analysis, file.name);
                renderBlocks();
            } catch(err) {
                console.error('PFE load error:', err);
                viewerScroll.innerHTML = `<div style="color:rgba(255,100,100,0.6);padding:20px;font-size:0.8rem;">Error: ${err.message}</div>`;
                editorEmpty.innerHTML = '<div class="pfe-editor-empty"><div class="pfe-editor-empty-icon">⚠️</div><div>Could not load this PDF.</div></div>';
            }
        }

        async function renderPdfPages() {
            viewerScroll.innerHTML = '';
            for (let i = 1; i <= PFE.totalPages; i++) {
                const page = await PFE.pdfDoc.getPage(i);
                const vp = page.getViewport({ scale: PFE.zoom });
                const canvas = document.createElement('canvas');
                canvas.className = 'pfe-page-canvas';
                canvas.dataset.page = i;
                canvas.width = vp.width;
                canvas.height = vp.height;
                canvas.style.width = Math.min(vp.width, viewerScroll.clientWidth - 24) + 'px';
                viewerScroll.appendChild(canvas);
                page.render({ canvasContext: canvas.getContext('2d'), viewport: vp });
            }
        }

        function scrollToPage(n) {
            const canvas = viewerScroll.querySelector(`canvas[data-page="${n}"]`);
            if (canvas) canvas.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }

        function updatePageInfo() {
            if (pageInfo) pageInfo.textContent = `${PFE.currentPage} / ${PFE.totalPages || '–'}`;
        }

        function buildBlocksFromAnalysis(analysis, name) {
            PFE.blocks = [];
            const chunks = analysis.chunks || [];
            if (chunks.length) {
                chunks.forEach((c, i) => {
                    PFE.blocks.push({
                        id: 'blk-' + i,
                        type: c.type || 'text',
                        title: c.title || '',
                        content: c.content || '',
                        originalContent: c.content || '',
                        pageNum: c.page || null,
                        pendingNew: null
                    });
                });
            } else if (analysis.rawText) {
                // Split into ~400 char paragraphs
                const paras = analysis.rawText.split(/\n{2,}/);
                paras.forEach((p, i) => {
                    if (!p.trim()) return;
                    PFE.blocks.push({
                        id: 'blk-' + i,
                        type: p.length < 80 ? 'section' : 'text',
                        title: '',
                        content: p.trim(),
                        originalContent: p.trim(),
                        pageNum: null,
                        pendingNew: null
                    });
                });
            }
            if (!PFE.blocks.length) {
                editorEmpty.innerHTML = '<div class="pfe-editor-empty"><div class="pfe-editor-empty-icon">📭</div><div>No extractable text found.</div></div>';
            }
        }

        function renderBlocks() {
            if (!editorScroll) return;
            editorScroll.innerHTML = '';
            if (!PFE.blocks.length) {
                const emp = document.getElementById('pfe-editor-empty');
                if (emp) { emp.style.display = 'flex'; return; }
            }
            const emp = document.getElementById('pfe-editor-empty');
            if (emp) emp.style.display = 'none';

            updateSelCount();

            PFE.blocks.forEach(blk => {
                const el = document.createElement('div');
                el.className = 'pfe-block' + (PFE.selected.has(blk.id) ? ' selected' : '');
                el.dataset.id = blk.id;
                el.draggable = true;

                const typeClass = { section:'pfe-type-section', text:'pfe-type-text', table:'pfe-type-table', list:'pfe-type-list', note:'pfe-type-note' }[blk.type] || 'pfe-type-text';
                const typeLabel = blk.type.charAt(0).toUpperCase() + blk.type.slice(1);
                const pageLabel = blk.pageNum ? `<span style="font-size:0.65rem;color:rgba(255,255,255,0.2);margin-left:auto;">p.${blk.pageNum}</span>` : '';

                el.innerHTML = `
                    <div class="pfe-block-header">
                        <span class="pfe-block-drag">⠿</span>
                        <input type="checkbox" class="pfe-block-check" ${PFE.selected.has(blk.id) ? 'checked' : ''}>
                        <span class="pfe-block-type ${typeClass}">${typeLabel}</span>
                        ${blk.title ? `<span style="font-size:0.76rem;color:rgba(255,255,255,0.4);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${blk.title}</span>` : '<span class="pfe-block-spacer"></span>'}
                        ${pageLabel}
                        <button class="pfe-block-btn prompt-btn" title="AI edit this block">✦</button>
                        <button class="pfe-block-btn del-btn" title="Delete block">✕</button>
                    </div>
                    <div class="pfe-block-content" contenteditable="true" data-placeholder="Empty block…">${escHtml(blk.content)}</div>
                    <div class="pfe-inline-prompt">
                        <input type="text" placeholder="Rewrite this block… e.g. 'make formal', 'summarize', 'fix grammar'">
                        <button class="run-btn">Apply ✦</button>
                        <button class="cancel-btn">Cancel</button>
                    </div>
                    ${blk.pendingNew !== null ? renderDiff(blk) : ''}
                `;

                // Checkbox
                el.querySelector('.pfe-block-check').addEventListener('change', e => {
                    if (e.target.checked) PFE.selected.add(blk.id);
                    else PFE.selected.delete(blk.id);
                    el.classList.toggle('selected', e.target.checked);
                    updateSelCount();
                });

                // Content editable sync
                el.querySelector('.pfe-block-content').addEventListener('input', e => {
                    blk.content = e.target.textContent;
                });
                el.querySelector('.pfe-block-content').addEventListener('focus', () => {
                    el.classList.add('focused');
                    if (blk.pageNum) { PFE.currentPage = blk.pageNum; scrollToPage(blk.pageNum); updatePageInfo(); }
                });
                el.querySelector('.pfe-block-content').addEventListener('blur', () => el.classList.remove('focused'));

                // Prompt toggle
                el.querySelector('.prompt-btn').addEventListener('click', () => {
                    el.classList.toggle('prompting');
                    if (el.classList.contains('prompting')) el.querySelector('.pfe-inline-prompt input').focus();
                });
                el.querySelector('.cancel-btn').addEventListener('click', () => el.classList.remove('prompting'));
                el.querySelector('.run-btn').addEventListener('click', () => {
                    const instr = el.querySelector('.pfe-inline-prompt input').value.trim();
                    if (instr) aiRewriteBlock(blk.id, instr);
                });
                el.querySelector('.pfe-inline-prompt input').addEventListener('keydown', e => {
                    if (e.key === 'Enter') { e.preventDefault(); const instr = e.target.value.trim(); if (instr) aiRewriteBlock(blk.id, instr); }
                });

                // Delete
                el.querySelector('.del-btn').addEventListener('click', () => {
                    PFE.blocks = PFE.blocks.filter(b => b.id !== blk.id);
                    PFE.selected.delete(blk.id);
                    renderBlocks();
                });

                // Drag reorder
                el.addEventListener('dragstart', e => { PFE.dragSrcId = blk.id; el.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
                el.addEventListener('dragend', () => el.classList.remove('dragging'));
                el.addEventListener('dragover', e => { e.preventDefault(); el.classList.add('drag-over'); });
                el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
                el.addEventListener('drop', e => {
                    e.preventDefault(); el.classList.remove('drag-over');
                    if (PFE.dragSrcId && PFE.dragSrcId !== blk.id) {
                        const fromIdx = PFE.blocks.findIndex(b => b.id === PFE.dragSrcId);
                        const toIdx   = PFE.blocks.findIndex(b => b.id === blk.id);
                        const [moved] = PFE.blocks.splice(fromIdx, 1);
                        PFE.blocks.splice(toIdx, 0, moved);
                        renderBlocks();
                    }
                });

                editorScroll.appendChild(el);
            });
        }

        function renderDiff(blk) {
            return `
                <div class="pfe-diff-view">
                    <div class="pfe-diff-label old-label">Before</div>
                    <div class="pfe-diff-old">${escHtml(blk.originalContent)}</div>
                    <div class="pfe-diff-label new-label">After</div>
                    <div class="pfe-diff-new">${escHtml(blk.pendingNew)}</div>
                    <div class="pfe-diff-actions">
                        <button class="pfe-diff-accept" data-id="${blk.id}">✓ Accept</button>
                        <button class="pfe-diff-reject" data-id="${blk.id}">✕ Reject</button>
                    </div>
                </div>
            `;
        }

        // Accept/Reject diffs (delegated)
        editorScroll.addEventListener('click', e => {
            if (e.target.classList.contains('pfe-diff-accept')) {
                const blk = PFE.blocks.find(b => b.id === e.target.dataset.id);
                if (blk) { blk.content = blk.pendingNew; blk.originalContent = blk.pendingNew; blk.pendingNew = null; renderBlocks(); }
            }
            if (e.target.classList.contains('pfe-diff-reject')) {
                const blk = PFE.blocks.find(b => b.id === e.target.dataset.id);
                if (blk) { blk.pendingNew = null; renderBlocks(); }
            }
        });

        function updateSelCount() {
            if (!selCount) return;
            const n = PFE.selected.size;
            selCount.textContent = `${n} selected`;
            selCount.classList.toggle('visible', n > 0);
        }

        async function aiRewriteBlock(blockId, instruction) {
            const blk = PFE.blocks.find(b => b.id === blockId);
            if (!blk || !selectedModel) return;

            const el = editorScroll.querySelector(`[data-id="${blockId}"]`);
            if (el) {
                el.classList.remove('prompting');
                const thinking = document.createElement('div');
                thinking.className = 'pfe-block-thinking';
                thinking.textContent = 'Rewriting…';
                el.appendChild(thinking);
            }

            try {
                const messages = [
                    { role: 'system', content: 'You are a document editor. Rewrite the given text block according to the instruction. Return ONLY the rewritten text with no preamble or explanation.' },
                    { role: 'user', content: `Instruction: ${instruction}\n\nOriginal text:\n${blk.content}` }
                ];
                const r = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: selectedModel, stream: false, messages }) });
                const data = await r.json();
                const newText = (data.message?.content || data.response || '').trim();
                blk.pendingNew = newText;
                renderBlocks();
            } catch(err) {
                if (el) { const t = el.querySelector('.pfe-block-thinking'); if (t) t.remove(); }
                console.error('AI rewrite error:', err);
            }
        }

        async function runAiBulk() {
            const instr = aiInput.value.trim();
            if (!instr || !selectedModel) return;
            aiInput.value = '';

            const targets = PFE.selected.size > 0
                ? PFE.blocks.filter(b => PFE.selected.has(b.id))
                : PFE.blocks.slice(0, 1);

            for (const blk of targets) {
                await aiRewriteBlock(blk.id, instr);
            }
        }

        function exportMarkdown() {
            if (!PFE.blocks.length) return;
            let md = PFE.file?.name ? `# ${PFE.file.name.replace('.pdf', '')}\n\n` : '';
            PFE.blocks.forEach(blk => {
                if (blk.type === 'section') md += `## ${blk.title || blk.content}\n\n`;
                else md += blk.content + '\n\n';
            });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
            a.download = (PFE.file?.name || 'document').replace('.pdf', '.md');
            a.click();
        }

        function sendToCanvas() {
            if (!PFE.blocks.length) return;
            const text = PFE.blocks.map(b => b.content).join('\n\n');
            switchToCanvasTab();
            openPanel('text', PFE.file?.name || 'PDF Content', { text });
        }
    }

    function switchToCanvasTab() {
        document.querySelectorAll('.agent-inner-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.agent-tab-panel').forEach(p => p.classList.remove('active'));
        document.querySelector('.agent-inner-tab[data-agtab="canvas"]')?.classList.add('active');
        document.getElementById('agtab-canvas')?.classList.add('active');
    }

    function escHtml(str) {
        return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    // ═══════════════════════════════════════════════════════════════
    //  WEB SCRAPE TAB
    // ═══════════════════════════════════════════════════════════════
    const scrapeUrlInput    = document.getElementById('scrape-url-input');
    const scrapeGoBtn       = document.getElementById('scrape-go-btn');
    const scrapeOptImages   = document.getElementById('scrape-opt-images');
    const scrapeHistoryList = document.getElementById('scrape-history-list');
    const scrapeEmptyState  = document.getElementById('scrape-empty-state');
    const scrapeTextContent = document.getElementById('scrape-text-content');
    const scrapeImgGrid     = document.getElementById('scrape-img-grid');
    const scrapeLinksList   = document.getElementById('scrape-links-list');
    const scrapeToCanvas    = document.getElementById('scrape-to-canvas-btn');
    const scrapeToLife      = document.getElementById('scrape-to-life-btn');
    const scrapeCopy        = document.getElementById('scrape-copy-btn');
    const scrapeMeta        = document.getElementById('scrape-meta');
    const scrapeInfoBox     = document.getElementById('scrape-info-box');
    const scrapeInfoTitle   = document.getElementById('scrape-info-title');
    const scrapeInfoDesc    = document.getElementById('scrape-info-desc');
    const scrapeInfoStats   = document.getElementById('scrape-info-stats');

    let scrapeHistory = [];
    let lastScraped   = null;

    // Content sub-tabs
    document.querySelectorAll('.scrape-ctab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.scrape-ctab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.scrape-cpanel').forEach(p => p.classList.remove('active'));
            tab.classList.add('active');
            document.getElementById('scpanel-' + tab.dataset.ctab)?.classList.add('active');
        });
    });

    scrapeGoBtn.addEventListener('click', doScrape);
    scrapeUrlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doScrape(); });

    async function doScrape() {
        let url = scrapeUrlInput.value.trim();
        if (!url) return;
        if (!url.startsWith('http')) url = 'https://' + url;
        scrapeUrlInput.value = url;

        scrapeGoBtn.textContent = 'Scraping…';
        scrapeGoBtn.disabled = true;
        scrapeEmptyState?.style.setProperty('display', 'flex');
        scrapeTextContent.style.display = 'none';

        try {
            const r = await fetch('/api/agent/scrape-url', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url, includeImages: scrapeOptImages?.checked })
            });
            const data = await r.json();
            if (data.error) throw new Error(data.error);

            lastScraped = data;

            // Text panel
            scrapeEmptyState?.style.setProperty('display', 'none');
            scrapeTextContent.style.display = 'block';
            scrapeTextContent.textContent = data.content || '(No text content extracted)';

            // Images panel
            scrapeImgGrid.innerHTML = (data.images || []).map(img => `
                <div class="scrape-img-item" title="${img.alt || ''}">
                    <img src="${img.src}" loading="lazy" onerror="this.closest('.scrape-img-item').remove()">
                    <button class="scrape-img-use" data-src="${encodeURIComponent(img.src)}" data-alt="${encodeURIComponent(img.alt||'')}">Add to Canvas</button>
                </div>
            `).join('');
            scrapeImgGrid.querySelectorAll('.scrape-img-use').forEach(b => {
                b.addEventListener('click', () => {
                    openAgentTab();
                    openPanel('image', decodeURIComponent(b.dataset.alt) || 'Image', { base64: decodeURIComponent(b.dataset.src), useUrl: true });
                });
            });

            // Links panel — extract from content (rough heuristic: find URLs)
            const urlRe = /https?:\/\/[^\s"'<>()]+/g;
            const foundLinks = [...new Set((data.content || '').match(urlRe) || [])].slice(0, 50);
            scrapeLinksList.innerHTML = foundLinks.map(l => `<a class="scrape-link-item" href="${l}" target="_blank" rel="noopener">${l}</a>`).join('');

            // Meta + info box
            scrapeMeta.textContent = `~${data.wordCount || 0} words · ${(data.images||[]).length} images`;
            scrapeInfoBox.style.display = 'block';
            scrapeInfoTitle.textContent = data.title || url;
            scrapeInfoDesc.textContent = data.description || '';
            scrapeInfoStats.textContent = `${data.wordCount || 0} words · ${(data.images||[]).length} images · ${foundLinks.length} links`;

            // Enable action buttons
            [scrapeToCanvas, scrapeToLife, scrapeCopy].forEach(b => b.disabled = false);

            // Add to history
            const histItem = { url, title: data.title || url, data };
            scrapeHistory.unshift(histItem);
            if (scrapeHistory.length > 20) scrapeHistory.pop();
            renderScrapeHistory();

        } catch(e) {
            scrapeTextContent.style.display = 'block';
            scrapeTextContent.textContent = 'Error scraping URL: ' + e.message;
            scrapeEmptyState?.style.setProperty('display', 'none');
        } finally {
            scrapeGoBtn.textContent = 'Scrape';
            scrapeGoBtn.disabled = false;
        }
    }

    function renderScrapeHistory() {
        const empty = scrapeHistoryList.querySelector('.scrape-history-empty');
        if (empty) empty.remove();
        scrapeHistoryList.innerHTML = scrapeHistory.map((h, i) => {
            let domain = '';
            try { domain = new URL(h.url).hostname.replace('www.', ''); } catch {}
            return `<div class="scrape-history-item" data-idx="${i}" title="${h.url}">${domain || h.url}</div>`;
        }).join('');
        scrapeHistoryList.querySelectorAll('.scrape-history-item').forEach(el => {
            el.addEventListener('click', () => {
                scrapeUrlInput.value = scrapeHistory[+el.dataset.idx].url;
                doScrape();
            });
        });
    }

    scrapeToCanvas.addEventListener('click', () => {
        if (!lastScraped) return;
        openAgentTab();
        openPanel('text', lastScraped.title || 'Scraped Content', { text: `Source: ${lastScraped.url}\n\n# ${lastScraped.title}\n\n${lastScraped.description ? lastScraped.description + '\n\n' : ''}${lastScraped.content}` });
    });

    scrapeCopy.addEventListener('click', () => {
        if (!lastScraped) return;
        navigator.clipboard.writeText(lastScraped.content || '').then(() => { scrapeCopy.textContent = '✓ Copied'; setTimeout(() => { scrapeCopy.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg> Copy Text`; }, 2000); }).catch(() => {});
    });

    scrapeToLife.addEventListener('click', () => {
        if (!lastScraped) return;
        // Switch to life tab and pre-fill a note
        document.querySelectorAll('.agent-inner-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.agent-tab-panel').forEach(p => p.classList.remove('active'));
        document.querySelector('.agent-inner-tab[data-agtab="life"]')?.classList.add('active');
        document.getElementById('agtab-life')?.classList.add('active');
        if (!lifeInitialized) initLifeTab();
        // Open the modal pre-filled as a note
        openLifeModal('note', { name: lastScraped.title || '', description: lastScraped.description || '', notes: lastScraped.content?.substring(0, 2000) || '', tags: '' });
    });

    // ═══════════════════════════════════════════════════════════════
    //  YOUR LIFE TAB
    // ═══════════════════════════════════════════════════════════════
    let lifeInitialized = false;
    let lifeEntries     = [];
    let lifeCurrent     = { cat: 'all', search: '', editId: null };

    const LIFE_TYPE_META = {
        person: { icon: '👤', label: 'Person',  color: 'rgba(94,106,210,0.15)',  tc: '#9ba5e8' },
        place:  { icon: '📍', label: 'Place',   color: 'rgba(43,180,120,0.12)',  tc: '#6ec9a0' },
        thing:  { icon: '📦', label: 'Thing',   color: 'rgba(255,180,60,0.12)',  tc: '#f0bc6e' },
        event:  { icon: '📅', label: 'Event',   color: 'rgba(220,80,80,0.12)',   tc: '#e8908a' },
        note:   { icon: '📝', label: 'Note',    color: 'rgba(220,80,160,0.12)',  tc: '#e89ace' },
    };

    const LIFE_FIELDS = {
        person: [
            { key: 'name',         label: 'Name',              type: 'text',     required: true },
            { key: 'relationship', label: 'Relationship',       type: 'text',     placeholder: 'friend, colleague, family…' },
            { key: 'date_met',     label: 'Date Met',           type: 'date' },
            { key: 'description',  label: 'About them',         type: 'textarea' },
            { key: 'notes',        label: 'Notes / memories',   type: 'textarea' },
            { key: 'tags',         label: 'Tags (comma-separated)', type: 'text' },
        ],
        place: [
            { key: 'name',         label: 'Place Name',         type: 'text',     required: true },
            { key: 'location',     label: 'Location / Address', type: 'text' },
            { key: 'date_visited', label: 'Date Visited',       type: 'date' },
            { key: 'description',  label: 'Description',        type: 'textarea' },
            { key: 'notes',        label: 'Notes / memories',   type: 'textarea' },
            { key: 'tags',         label: 'Tags',               type: 'text' },
        ],
        thing: [
            { key: 'name',         label: 'Name',               type: 'text',     required: true },
            { key: 'category',     label: 'Category',           type: 'text',     placeholder: 'book, gadget, keepsake…' },
            { key: 'date',         label: 'Date',               type: 'date' },
            { key: 'description',  label: 'Description',        type: 'textarea' },
            { key: 'notes',        label: 'Notes',              type: 'textarea' },
            { key: 'tags',         label: 'Tags',               type: 'text' },
        ],
        event: [
            { key: 'name',         label: 'Event Name',         type: 'text',     required: true },
            { key: 'date',         label: 'Date',               type: 'date' },
            { key: 'location',     label: 'Location',           type: 'text' },
            { key: 'people',       label: 'People Present',     type: 'text',     placeholder: 'names, comma-separated' },
            { key: 'description',  label: 'What happened',      type: 'textarea' },
            { key: 'notes',        label: 'Notes',              type: 'textarea' },
            { key: 'tags',         label: 'Tags',               type: 'text' },
        ],
        note: [
            { key: 'name',         label: 'Title',              type: 'text',     required: true },
            { key: 'date',         label: 'Date',               type: 'date' },
            { key: 'description',  label: 'Content',            type: 'textarea' },
            { key: 'notes',        label: 'Extra notes',        type: 'textarea' },
            { key: 'tags',         label: 'Tags',               type: 'text' },
        ],
    };

    function initLifeTab() {
        lifeInitialized = true;
        loadLifeEntries();

        // Category buttons
        document.getElementById('life-categories').querySelectorAll('.life-cat').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.life-cat').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                lifeCurrent.cat = btn.dataset.cat;
                renderLifeGrid();
            });
        });

        // Search
        document.getElementById('life-search-input').addEventListener('input', (e) => {
            lifeCurrent.search = e.target.value.toLowerCase();
            renderLifeGrid();
        });

        // Add button
        document.getElementById('life-add-btn').addEventListener('click', () => openLifeModal('person'));

        // Modal close
        document.getElementById('life-modal-close').addEventListener('click', closeLifeModal);
        document.getElementById('life-modal-cancel').addEventListener('click', closeLifeModal);
        document.getElementById('life-modal-overlay').addEventListener('click', (e) => { if (e.target.id === 'life-modal-overlay') closeLifeModal(); });

        // Type picker inside modal
        document.getElementById('life-type-picker').querySelectorAll('.life-type-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.life-type-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                renderLifeModalForm(btn.dataset.type);
            });
        });

        // Save
        document.getElementById('life-modal-save').addEventListener('click', saveLifeEntry);

        // Detail modal close / edit
        document.getElementById('life-detail-close').addEventListener('click', () => document.getElementById('life-detail-overlay').style.display = 'none');
        document.getElementById('life-detail-overlay').addEventListener('click', (e) => { if (e.target.id === 'life-detail-overlay') document.getElementById('life-detail-overlay').style.display = 'none'; });
        document.getElementById('life-detail-edit').addEventListener('click', () => {
            const id = document.getElementById('life-detail-edit').dataset.entryId;
            const entry = lifeEntries.find(e => e.id === id);
            if (entry) { document.getElementById('life-detail-overlay').style.display = 'none'; openLifeModal(entry.type, entry, id); }
        });

        // Life chat
        const lifeChatSend = document.getElementById('life-chat-send');
        const lifeChatInput = document.getElementById('life-chat-input');
        lifeChatInput.addEventListener('input', () => { lifeChatSend.disabled = !lifeChatInput.value.trim(); });
        lifeChatSend.addEventListener('click', sendLifeChatMsg);
        lifeChatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendLifeChatMsg(); } });
    }

    async function loadLifeEntries() {
        try {
            const r = await fetch('/api/life/entries');
            lifeEntries = await r.json();
            renderLifeGrid();
            updateLifeCounts();
            renderLifeTags();
        } catch(e) { console.error('Life load failed:', e); }
    }

    function updateLifeCounts() {
        const counts = { all: lifeEntries.length };
        for (const type of Object.keys(LIFE_TYPE_META)) {
            counts[type] = lifeEntries.filter(e => e.type === type).length;
        }
        for (const [key, val] of Object.entries(counts)) {
            const el = document.getElementById(`lc-${key}`);
            if (el) el.textContent = val;
        }
    }

    function renderLifeTags() {
        const tagSet = new Map();
        lifeEntries.forEach(e => (e.tags || []).forEach(t => tagSet.set(t, (tagSet.get(t) || 0) + 1)));
        const cloud = document.getElementById('life-tags-cloud');
        if (!cloud) return;
        cloud.innerHTML = [...tagSet.entries()].sort((a,b) => b[1]-a[1]).slice(0, 20).map(([tag]) =>
            `<span class="life-tag-chip" data-tag="${tag}">${tag}</span>`
        ).join('');
        cloud.querySelectorAll('.life-tag-chip').forEach(chip => {
            chip.addEventListener('click', () => {
                document.getElementById('life-search-input').value = chip.dataset.tag;
                lifeCurrent.search = chip.dataset.tag.toLowerCase();
                renderLifeGrid();
            });
        });
    }

    function renderLifeGrid() {
        const grid = document.getElementById('life-grid');
        const empty = document.getElementById('life-empty');
        let filtered = lifeEntries;
        if (lifeCurrent.cat !== 'all') filtered = filtered.filter(e => e.type === lifeCurrent.cat);
        if (lifeCurrent.search) {
            const q = lifeCurrent.search;
            filtered = filtered.filter(e =>
                (e.name || '').toLowerCase().includes(q) ||
                (e.description || '').toLowerCase().includes(q) ||
                (e.notes || '').toLowerCase().includes(q) ||
                (e.tags || []).some(t => t.toLowerCase().includes(q))
            );
        }
        if (!filtered.length) {
            grid.innerHTML = '';
            if (empty) { empty.classList.remove('hidden'); empty.style.display = 'flex'; }
            return;
        }
        if (empty) { empty.classList.add('hidden'); empty.style.display = 'none'; }

        grid.innerHTML = filtered.map(entry => {
            const meta = LIFE_TYPE_META[entry.type] || LIFE_TYPE_META.note;
            const tags = (entry.tags || []).slice(0, 4).map(t => `<span class="life-card-tag">${t}</span>`).join('');
            const dateLine = entry.date_met || entry.date_visited || entry.date || '';
            return `
            <div class="life-card" data-id="${entry.id}">
                <div class="life-card-type ${entry.type}" style="background:${meta.color};color:${meta.tc}">${meta.icon} ${meta.label}</div>
                <div class="life-card-name">${entry.name || entry.title || ''}</div>
                ${dateLine ? `<div class="life-card-meta">📅 ${dateLine}${entry.relationship ? ` · ${entry.relationship}` : ''}${entry.location ? ` · 📍 ${entry.location}` : ''}</div>` : ''}
                ${entry.description ? `<div class="life-card-desc">${entry.description}</div>` : ''}
                ${tags ? `<div class="life-card-tags">${tags}</div>` : ''}
                <div class="life-card-actions">
                    <button class="life-card-act-btn edit-btn" title="Edit">✎</button>
                    <button class="life-card-act-btn del life-card-del-btn" title="Delete">×</button>
                </div>
            </div>`;
        }).join('');

        grid.querySelectorAll('.life-card').forEach(card => {
            card.addEventListener('click', (e) => {
                if (e.target.closest('.life-card-act-btn')) return;
                showLifeDetail(card.dataset.id);
            });
        });
        grid.querySelectorAll('.edit-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const entry = lifeEntries.find(en => en.id === btn.closest('.life-card').dataset.id);
                if (entry) openLifeModal(entry.type, entry, entry.id);
            });
        });
        grid.querySelectorAll('.life-card-del-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const id = btn.closest('.life-card').dataset.id;
                if (!confirm('Delete this memory?')) return;
                await fetch(`/api/life/entries/${id}`, { method: 'DELETE' });
                await loadLifeEntries();
            });
        });
    }

    function openLifeModal(type, prefill = {}, editId = null) {
        lifeCurrent.editId = editId;
        const modal = document.getElementById('life-modal-overlay');
        const titleEl = document.getElementById('life-modal-title');
        titleEl.textContent = editId ? 'Edit Memory' : 'Add Memory';
        // Select type
        document.querySelectorAll('.life-type-btn').forEach(b => b.classList.toggle('active', b.dataset.type === type));
        // Hide type picker when editing
        document.getElementById('life-type-picker').style.display = editId ? 'none' : '';
        renderLifeModalForm(type, prefill);
        modal.style.display = 'flex';
        setTimeout(() => modal.querySelector('.life-modal-box input, .life-modal-box textarea')?.focus(), 50);
    }

    function closeLifeModal() {
        document.getElementById('life-modal-overlay').style.display = 'none';
        lifeCurrent.editId = null;
    }

    function renderLifeModalForm(type, prefill = {}) {
        const fields = LIFE_FIELDS[type] || LIFE_FIELDS.note;
        const form = document.getElementById('life-modal-form');
        form.innerHTML = fields.map(f => {
            const val = prefill[f.key] || '';
            if (f.type === 'textarea') return `<div class="life-field"><label>${f.label}</label><textarea name="${f.key}" placeholder="${f.placeholder || ''}">${val}</textarea></div>`;
            return `<div class="life-field"><label>${f.label}${f.required ? ' *' : ''}</label><input type="${f.type}" name="${f.key}" value="${val}" placeholder="${f.placeholder || ''}"></div>`;
        }).join('');
        form.dataset.type = type;
    }

    async function saveLifeEntry() {
        const form = document.getElementById('life-modal-form');
        const type = form.dataset.type || 'note';
        const fields = LIFE_FIELDS[type] || LIFE_FIELDS.note;
        const entry = { type };
        fields.forEach(f => {
            const el = form.querySelector(`[name="${f.key}"]`);
            if (!el) return;
            if (f.key === 'tags') entry.tags = el.value.split(',').map(t => t.trim()).filter(Boolean);
            else entry[f.key] = el.value.trim();
        });
        if (!entry.name) { alert('Please enter a name or title.'); return; }

        const editId = lifeCurrent.editId;
        if (editId) {
            await fetch(`/api/life/entries/${editId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(entry) });
        } else {
            await fetch('/api/life/entries', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(entry) });
        }
        closeLifeModal();
        await loadLifeEntries();
    }

    function showLifeDetail(id) {
        const entry = lifeEntries.find(e => e.id === id);
        if (!entry) return;
        const meta = LIFE_TYPE_META[entry.type] || LIFE_TYPE_META.note;
        const overlay = document.getElementById('life-detail-overlay');
        const badge = document.getElementById('life-detail-type');
        badge.textContent = meta.icon + ' ' + meta.label;
        badge.className = `life-detail-type-badge ${entry.type}`;
        badge.style.background = meta.color;
        badge.style.color = meta.tc;
        document.getElementById('life-detail-name').textContent = entry.name || '';
        document.getElementById('life-detail-edit').dataset.entryId = id;

        const body = document.getElementById('life-detail-body');
        const fields = LIFE_FIELDS[entry.type] || LIFE_FIELDS.note;
        body.innerHTML = fields.filter(f => entry[f.key] && f.key !== 'name').map(f => {
            let val = entry[f.key];
            if (f.key === 'tags') val = (entry.tags || []).join(', ');
            return `<div class="life-detail-field"><div class="life-detail-field-label">${f.label}</div><div class="life-detail-field-value">${val}</div></div>`;
        }).join('');

        overlay.style.display = 'flex';
    }

    async function sendLifeChatMsg() {
        const input = document.getElementById('life-chat-input');
        const msgs  = document.getElementById('life-chat-messages');
        const q = input.value.trim();
        if (!q) return;
        input.value = '';
        document.getElementById('life-chat-send').disabled = true;

        // Remove welcome message on first use
        const welcome = msgs.querySelector('.life-chat-welcome');
        if (welcome) welcome.remove();

        const addMsg = (role, text) => {
            const el = document.createElement('div');
            el.className = `life-chat-msg ${role}`;
            el.textContent = text;
            msgs.appendChild(el);
            msgs.scrollTop = msgs.scrollHeight;
            return el;
        };

        addMsg('user', q);
        const thinking = addMsg('assistant', '…');

        // Build context from all life entries
        const context = lifeEntries.length
            ? lifeEntries.map(e => {
                const fields = LIFE_FIELDS[e.type] || LIFE_FIELDS.note;
                const parts = [`[${(LIFE_TYPE_META[e.type]||{}).label||e.type}] ${e.name}`];
                fields.forEach(f => { if (f.key !== 'name' && e[f.key]) parts.push(`${f.label}: ${f.key === 'tags' ? (e.tags||[]).join(', ') : e[f.key]}`); });
                return parts.join(' | ');
            }).join('\n')
            : 'No life entries yet.';

        try {
            const r = await fetch('/api/chat', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: selectedModel, stream: false,
                    messages: [
                        { role: 'system', content: `You are a personal memory assistant. The user has recorded their life: people, places, things, events, and notes. Answer questions about their life based on this data. Be warm, helpful, and specific.\n\nLife data:\n${context}` },
                        { role: 'user', content: q }
                    ]
                })
            });
            const data = await r.json();
            thinking.textContent = data.message?.content || data.response || 'No answer found.';
        } catch(e) { thinking.textContent = 'Error: ' + e.message; }

        document.getElementById('life-chat-send').disabled = !input.value.trim();
    }

    // ═══════════════════════════════════════════════════════════════
    //  INIT
    // ═══════════════════════════════════════════════════════════════
    loadAgentModels();
    loadAgentFileTree();
    loadWorkspaceList();
    applyTransform();
    updateZoomDisplay();
    if (typeof mermaid !== 'undefined') mermaid.initialize({ startOnLoad: false, theme: 'dark' });
});
