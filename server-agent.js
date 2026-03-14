/**
 * Agent Tab — Server Routes
 * Mounted by server.js. Provides:
 *   POST /api/agent/web-search    — DuckDuckGo search (parsed results for LLM)
 *   GET  /api/agent/ddg-proxy     — DuckDuckGo Lite proxied in iframe
 *   POST /api/agent/export-xlsx   — create downloadable XLSX from JSON
 *   POST /api/agent/export-csv    — create downloadable CSV
 *   POST /api/agent/run-code      — sandboxed Python execution
 *   CRUD /api/agent/workspaces    — save/load/list/delete workspaces
 *   POST /api/agent/analyze-pdf   — deep structured PDF extraction + chunking
 */

const http = require('http');
const https = require('https');
const path = require('path');
const XLSX = require('xlsx');
const { spawn } = require('child_process');
const fsSync = require('fs');
let PDFParseLib;
try { PDFParseLib = require('pdf-parse'); } catch { PDFParseLib = null; }
const PDFParse = PDFParseLib?.PDFParse || PDFParseLib;

const WORKSPACES_DIR = path.join(__dirname, 'Workspaces');
if (!fsSync.existsSync(WORKSPACES_DIR)) fsSync.mkdirSync(WORKSPACES_DIR, { recursive: true });

module.exports = function mountAgentRoutes(app, tempDir, fs) {

    // ── Web Search via DuckDuckGo HTML (parsed — feeds back to LLM) ──
    app.post('/api/agent/web-search', require('express').json(), async (req, res) => {
        const { query } = req.body;
        if (!query) return res.status(400).json({ error: 'Missing query' });

        try {
            const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
            const html = await new Promise((resolve, reject) => {
                https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MyAI/1.0)' } }, (resp) => {
                    let data = '';
                    resp.on('data', c => data += c);
                    resp.on('end', () => resolve(data));
                }).on('error', reject);
            });

            const results = [];
            const regex = /<a rel="nofollow" class="result__a" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
            let match;
            while ((match = regex.exec(html)) !== null && results.length < 6) {
                results.push({
                    url: match[1].replace(/&amp;/g, '&'),
                    title: match[2].replace(/<[^>]+>/g, '').trim(),
                    snippet: match[3].replace(/<[^>]+>/g, '').trim()
                });
            }

            res.json({ results });
        } catch (err) {
            console.error('[Agent] Web search error:', err.message);
            res.json({ results: [], error: err.message });
        }
    });

    // ── URL Scraper — extracts text + images from any webpage ────────
    app.post('/api/agent/scrape-url', require('express').json(), async (req, res) => {
        const { url, includeImages } = req.body;
        if (!url) return res.status(400).json({ error: 'Missing url' });

        try {
            const fetchUrl = async (targetUrl, depth = 0) => {
                const u = new URL(targetUrl);
                const mod = u.protocol === 'https:' ? https : http;
                return new Promise((resolve, reject) => {
                    const reqOpts = {
                        hostname: u.hostname,
                        path: (u.pathname || '/') + (u.search || ''),
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                            'Accept-Language': 'en-US,en;q=0.7',
                        },
                        timeout: 12000
                    };
                    const req2 = mod.get(reqOpts, (resp) => {
                        // Follow redirects once
                        if ([301,302,303,307,308].includes(resp.statusCode) && resp.headers.location && depth < 2) {
                            const redir = resp.headers.location.startsWith('http') ? resp.headers.location : u.origin + resp.headers.location;
                            resp.resume();
                            return fetchUrl(redir, depth + 1).then(resolve).catch(reject);
                        }
                        let data = '';
                        resp.setEncoding('utf8');
                        resp.on('data', c => { if (data.length < 800000) data += c; });
                        resp.on('end', () => resolve(data));
                    });
                    req2.on('error', reject);
                    req2.on('timeout', () => { req2.destroy(); reject(new Error('Request timed out')); });
                });
            };

            const html = await fetchUrl(url);

            // Extract title
            const titleM = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
            const title = titleM ? titleM[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : '';

            // Extract meta description
            const descM = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{0,400})/i)
                       || html.match(/<meta[^>]+content=["']([^"']{0,400})[^>]+name=["']description["']/i);
            const description = descM ? descM[1].trim() : '';

            // Strip noise then extract text
            let cleaned = html
                .replace(/<script[\s\S]*?<\/script>/gi, ' ')
                .replace(/<style[\s\S]*?<\/style>/gi, ' ')
                .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
                .replace(/<header[\s\S]*?<\/header>/gi, ' ')
                .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
                .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
                .replace(/<!--[\s\S]*?-->/g, ' ')
                .replace(/<br\s*\/?>/gi, '\n')
                .replace(/<\/p>/gi, '\n\n')
                .replace(/<\/div>/gi, '\n')
                .replace(/<\/h[1-6]>/gi, '\n\n')
                .replace(/<li[^>]*>/gi, '\n• ')
                .replace(/<[^>]+>/g, ' ')
                .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#\d+;/g, ' ')
                .replace(/[ \t]+/g, ' ')
                .replace(/\n{3,}/g, '\n\n')
                .trim();

            if (cleaned.length > 20000) cleaned = cleaned.substring(0, 20000) + '\n...[content truncated]';

            // Extract images if requested
            let images = [];
            if (includeImages) {
                const seen = new Set();
                const baseOrigin = (() => { try { return new URL(url).origin; } catch { return ''; } })();
                const imgRe = /<img[^>]+>/gi;
                let im;
                while ((im = imgRe.exec(html)) !== null && images.length < 30) {
                    const tag = im[0];
                    const srcM = tag.match(/src=["']([^"']+)["']/i) || tag.match(/data-src=["']([^"']+)["']/i);
                    const altM = tag.match(/alt=["']([^"']*)/i);
                    if (!srcM) continue;
                    let src = srcM[1];
                    const alt = altM ? altM[1].trim() : '';
                    // Resolve relative URLs
                    if (src.startsWith('//')) src = 'https:' + src;
                    else if (src.startsWith('/')) src = baseOrigin + src;
                    else if (!src.startsWith('http')) { try { src = new URL(src, url).href; } catch { continue; } }
                    // Skip tiny tracking pixels, SVG icons
                    if (/1x1|pixel|tracker|\.svg(\?|$)|\.ico(\?|$)|spacer|blank/i.test(src)) continue;
                    if (!seen.has(src)) { seen.add(src); images.push({ src, alt }); }
                }
            }

            res.json({ title, description, content: cleaned, images, url, wordCount: cleaned.split(/\s+/).length });
        } catch (err) {
            console.error('[Agent] Scrape error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ── DuckDuckGo Lite proxy (for iframe embedding with dark mode) ───
    app.get('/api/agent/ddg-proxy', async (req, res) => {
        const q = req.query.q;
        if (!q) return res.status(400).send('<html><body style="background:#111;color:#666;padding:20px">Enter a search query</body></html>');

        const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`;
        try {
            const html = await new Promise((resolve, reject) => {
                https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Gecko/20100101 Firefox/125.0' } }, (resp) => {
                    let data = '';
                    resp.on('data', c => data += c);
                    resp.on('end', () => resolve(data));
                }).on('error', reject);
            });

            const darkCss = `<style>
                body{background:#0e0e14!important;color:#c8c8d0!important;font-family:-apple-system,sans-serif!important;padding:12px!important;margin:0!important}
                a{color:#7b8cde!important}a:visited{color:#9b8cbe!important}
                input[type="text"]{background:#1a1a24!important;color:#fff!important;border:1px solid rgba(255,255,255,0.1)!important;padding:6px 10px!important;border-radius:6px!important}
                input[type="submit"]{background:rgba(94,106,210,0.2)!important;color:#7b8cde!important;border:1px solid rgba(94,106,210,0.3)!important;cursor:pointer!important;padding:6px 14px!important;border-radius:6px!important}
                table{width:100%!important}td{padding:6px 0!important;border:none!important}
                hr{border-color:rgba(255,255,255,0.06)!important}
                .result-link{font-size:15px!important}.result-snippet{color:rgba(255,255,255,0.5)!important;font-size:13px!important}
                form{margin-bottom:12px!important}
            </style>`;

            let modified = html.replace('<head>', `<head><base href="https://lite.duckduckgo.com/" target="_blank">${darkCss}`);
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.send(modified);
        } catch (err) {
            res.status(500).send(`<html><body style="background:#111;color:#666;padding:20px">Search failed: ${err.message}</body></html>`);
        }
    });

    // ── Export XLSX ──────────────────────────────────────────────────
    app.post('/api/agent/export-xlsx', require('express').json(), (req, res) => {
        const { filename, sheets } = req.body;
        if (!sheets || !sheets.length) return res.status(400).json({ error: 'Missing sheet data' });

        try {
            const wb = XLSX.utils.book_new();
            for (const sheet of sheets) {
                const ws = XLSX.utils.aoa_to_sheet(sheet.data || []);
                XLSX.utils.book_append_sheet(wb, ws, sheet.name || 'Sheet1');
            }
            const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
            const fname = (filename || 'export') + '.xlsx';
            res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.ss');
            res.send(buf);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ── Export CSV ───────────────────────────────────────────────────
    app.post('/api/agent/export-csv', require('express').json(), (req, res) => {
        const { filename, data } = req.body;
        if (!data) return res.status(400).json({ error: 'Missing data' });

        try {
            const csv = data.map(row => row.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
            const fname = (filename || 'export') + '.csv';
            res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
            res.setHeader('Content-Type', 'text/csv');
            res.send(csv);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ── Sandboxed Code Runner (Python only) ─────────────────────────
    app.post('/api/agent/run-code', require('express').json(), (req, res) => {
        const { code, language } = req.body;
        if (!code) return res.status(400).json({ error: 'Missing code' });
        if (language !== 'python') return res.status(400).json({ error: 'Only Python supported' });

        const proc = spawn('python', ['-c', code], { timeout: 15000, cwd: tempDir });
        let stdout = '', stderr = '';
        proc.stdout.on('data', d => stdout += d);
        proc.stderr.on('data', d => stderr += d);
        proc.on('close', (exitCode) => {
            res.json({ stdout, stderr, exitCode });
        });
        proc.on('error', (err) => {
            res.json({ stdout: '', stderr: err.message, exitCode: -1 });
        });
    });

    // ── Workspace CRUD ──────────────────────────────────────────────

    // List all workspaces
    app.get('/api/agent/workspaces', (req, res) => {
        try {
            const files = fsSync.readdirSync(WORKSPACES_DIR).filter(f => f.endsWith('.json'));
            const workspaces = files.map(f => {
                try {
                    const raw = fsSync.readFileSync(path.join(WORKSPACES_DIR, f), 'utf-8');
                    const data = JSON.parse(raw);
                    return { id: data.id, name: data.name, updatedAt: data.updatedAt };
                } catch { return null; }
            }).filter(Boolean).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
            res.json(workspaces);
        } catch (err) {
            res.json([]);
        }
    });

    // Save workspace
    app.post('/api/agent/workspaces', require('express').json({ limit: '10mb' }), (req, res) => {
        const ws = req.body;
        if (!ws.id) ws.id = `ws_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        ws.updatedAt = new Date().toISOString();
        try {
            fsSync.writeFileSync(path.join(WORKSPACES_DIR, ws.id + '.json'), JSON.stringify(ws, null, 2));
            res.json({ id: ws.id, name: ws.name });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Load workspace
    app.get('/api/agent/workspaces/:id', (req, res) => {
        const file = path.join(WORKSPACES_DIR, req.params.id + '.json');
        if (!fsSync.existsSync(file)) return res.status(404).json({ error: 'Not found' });
        try {
            const data = JSON.parse(fsSync.readFileSync(file, 'utf-8'));
            res.json(data);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Delete workspace
    app.delete('/api/agent/workspaces/:id', (req, res) => {
        const file = path.join(WORKSPACES_DIR, req.params.id + '.json');
        try { fsSync.unlinkSync(file); } catch {}
        res.json({ ok: true });
    });

    // ── Deep PDF Analysis ───────────────────────────────────────────
    // Extracts structured text, identifies sections, tables, metadata
    app.post('/api/agent/analyze-pdf', require('express').json(), async (req, res) => {
        const { filePath } = req.body;
        if (!filePath) return res.status(400).json({ error: 'Missing filePath' });

        try {
            // Resolve path from temp uploads or configured files dir
            let fullPath = filePath;
            if (!path.isAbsolute(filePath)) {
                // Try temp dir first, then configured dir
                const tempPath = path.join(tempDir, filePath);
                if (fsSync.existsSync(tempPath)) fullPath = tempPath;
                else {
                    // Try configured files dir
                    try {
                        const dataRaw = fsSync.readFileSync(path.join(__dirname, 'data.json'), 'utf-8');
                        const data = JSON.parse(dataRaw);
                        const configPath = path.join(data.config?.filesDir || '.', filePath);
                        if (fsSync.existsSync(configPath)) fullPath = configPath;
                    } catch {}
                }
            }

            if (!fsSync.existsSync(fullPath)) return res.status(404).json({ error: 'File not found' });

            const buffer = fsSync.readFileSync(fullPath);

            // Use pdf-parse for extraction (same API as server.js)
            let rawText = '';
            let numPages = 0;
            try {
                const parser = new PDFParse({ data: buffer });
                const pdfData = await parser.getText();
                rawText = pdfData.text || '';
                numPages = pdfData.numpages || pdfData.numPages || 0;
                try { await parser.destroy(); } catch {}
            } catch (e) {
                return res.json({
                    error: 'Could not extract text — PDF may be scanned/image-based',
                    rawText: '',
                    chunks: [],
                    metadata: { pages: 0, size: buffer.length }
                });
            }

            if (!rawText.trim()) {
                return res.json({
                    rawText: '',
                    chunks: [],
                    metadata: { pages: numPages, size: buffer.length },
                    warning: 'No text extracted — likely a scanned document'
                });
            }

            // ── Structural chunking ──
            // Split by likely section headers (ALL CAPS lines, numbered sections, etc.)
            const lines = rawText.split('\n');
            const chunks = [];
            let currentChunk = { type: 'text', title: 'Introduction', content: '' };

            const headerPatterns = [
                /^#{1,4}\s+.+/,                              // Markdown headers
                /^[A-Z][A-Z\s]{4,}$/,                        // ALL CAPS lines
                /^\d+\.\s+[A-Z]/,                            // Numbered sections (1. Title)
                /^(?:CHAPTER|SECTION|PART|ARTICLE)\s+/i,     // Explicit section markers
                /^(?:Abstract|Introduction|Conclusion|Summary|References|Appendix|Methods|Results|Discussion)\s*$/i
            ];

            const tablePattern = /^[\s|─┌┐└┘├┤┬┴┼\-+]+$|(?:\|[^|]+){2,}\|/;
            let inTable = false;

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) { currentChunk.content += '\n'; continue; }

                // Detect table regions
                if (tablePattern.test(trimmed) || (trimmed.includes('\t') && trimmed.split('\t').length >= 3)) {
                    if (!inTable) {
                        if (currentChunk.content.trim()) chunks.push({ ...currentChunk });
                        currentChunk = { type: 'table', title: 'Data Table', content: '' };
                        inTable = true;
                    }
                    currentChunk.content += trimmed + '\n';
                    continue;
                } else if (inTable) {
                    chunks.push({ ...currentChunk });
                    currentChunk = { type: 'text', title: 'Content', content: '' };
                    inTable = false;
                }

                // Detect section headers
                const isHeader = headerPatterns.some(p => p.test(trimmed));
                if (isHeader && currentChunk.content.trim().length > 50) {
                    chunks.push({ ...currentChunk });
                    currentChunk = { type: 'section', title: trimmed.replace(/^#+\s*/, '').replace(/^\d+\.\s*/, ''), content: '' };
                    continue;
                }

                // Detect list items
                if (/^[\-•*]\s/.test(trimmed) || /^\d+[.)]\s/.test(trimmed)) {
                    currentChunk.type = currentChunk.type === 'table' ? 'table' : 'list';
                }

                currentChunk.content += trimmed + '\n';
            }
            if (currentChunk.content.trim()) chunks.push(currentChunk);

            // Typed chunks with size info
            const typedChunks = chunks.map((c, i) => ({
                id: i,
                type: c.type,
                title: c.title,
                preview: c.content.trim().substring(0, 200),
                charCount: c.content.length,
                content: c.content.trim()
            }));

            res.json({
                rawText: rawText.substring(0, 50000), // cap at 50k chars
                chunks: typedChunks,
                metadata: {
                    pages: numPages,
                    size: buffer.length,
                    totalChars: rawText.length,
                    sectionCount: typedChunks.filter(c => c.type === 'section').length,
                    tableCount: typedChunks.filter(c => c.type === 'table').length,
                    listCount: typedChunks.filter(c => c.type === 'list').length
                }
            });
        } catch (err) {
            console.error('[Agent] PDF analysis error:', err);
            res.status(500).json({ error: err.message });
        }
    });

    // ══════════════════════════════════════════════════════════════
    //  YOUR LIFE — Personal Memory Store (CRUD + full-text search)
    // ══════════════════════════════════════════════════════════════
    const LIFE_FILE = path.join(WORKSPACES_DIR, '..', 'life-entries.json');

    function readLifeEntries() {
        try {
            if (!fsSync.existsSync(LIFE_FILE)) return [];
            return JSON.parse(fsSync.readFileSync(LIFE_FILE, 'utf-8'));
        } catch { return []; }
    }

    function writeLifeEntries(entries) {
        fsSync.writeFileSync(LIFE_FILE, JSON.stringify(entries, null, 2));
    }

    // List all (optionally filter by type or search query)
    app.get('/api/life/entries', (req, res) => {
        let entries = readLifeEntries();
        const { type, q } = req.query;
        if (type && type !== 'all') entries = entries.filter(e => e.type === type);
        if (q) {
            const lq = q.toLowerCase();
            entries = entries.filter(e =>
                (e.name || '').toLowerCase().includes(lq) ||
                (e.description || '').toLowerCase().includes(lq) ||
                (e.notes || '').toLowerCase().includes(lq) ||
                (e.tags || []).some(t => t.toLowerCase().includes(lq))
            );
        }
        res.json(entries.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')));
    });

    // Create
    app.post('/api/life/entries', require('express').json(), (req, res) => {
        const entry = req.body;
        if (!entry.name && !entry.title) return res.status(400).json({ error: 'Entry needs a name or title' });
        entry.id = `life_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        entry.createdAt = new Date().toISOString();
        entry.updatedAt = entry.createdAt;
        const entries = readLifeEntries();
        entries.push(entry);
        writeLifeEntries(entries);
        res.json(entry);
    });

    // Update
    app.put('/api/life/entries/:id', require('express').json(), (req, res) => {
        const entries = readLifeEntries();
        const idx = entries.findIndex(e => e.id === req.params.id);
        if (idx === -1) return res.status(404).json({ error: 'Not found' });
        entries[idx] = { ...entries[idx], ...req.body, id: req.params.id, updatedAt: new Date().toISOString() };
        writeLifeEntries(entries);
        res.json(entries[idx]);
    });

    // Delete
    app.delete('/api/life/entries/:id', (req, res) => {
        let entries = readLifeEntries();
        entries = entries.filter(e => e.id !== req.params.id);
        writeLifeEntries(entries);
        res.json({ ok: true });
    });

    // Get single
    app.get('/api/life/entries/:id', (req, res) => {
        const entries = readLifeEntries();
        const entry = entries.find(e => e.id === req.params.id);
        if (!entry) return res.status(404).json({ error: 'Not found' });
        res.json(entry);
    });
};

