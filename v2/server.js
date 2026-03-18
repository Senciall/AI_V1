const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const path = require('path');
const multer = require('multer');
const fs = require('fs').promises;
const fsSync = require('fs');
const http = require('http');
const https = require('https');
const XLSX = require('xlsx');
const { spawn } = require('child_process');

const OLLAMA_BASE = 'http://127.0.0.1:11434';
const PORT = 3000;

const BASE_PATH = __dirname;
const DATA_FILE = path.join(BASE_PATH, 'data.json');
const CHATS_DIR = path.join(BASE_PATH, 'Chats');
const DEFAULT_FILES_DIR = path.join(BASE_PATH, 'files');
const TEMP_UPLOADS_DIR = path.join(BASE_PATH, 'temp_uploads');
const LIFE_FILE = path.join(BASE_PATH, 'life-entries.json');

// Ensure directories exist
for (const dir of [CHATS_DIR, DEFAULT_FILES_DIR, TEMP_UPLOADS_DIR]) {
  if (!fsSync.existsSync(dir)) fsSync.mkdirSync(dir, { recursive: true });
}

// ── Data helpers ─────────────────────────────────────────────
async function loadData() {
  try {
    return JSON.parse(await fs.readFile(DATA_FILE, 'utf-8'));
  } catch {
    return { config: { filesDir: DEFAULT_FILES_DIR }, settings: {} };
  }
}

async function saveData(data) {
  await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2));
}

// ── Ollama helpers ───────────────────────────────────────────
const STABILITY_OPTIONS = { temperature: 0.1, top_p: 0.9, num_ctx: 4096 };

function ollamaChat(model, messages, options = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model, messages, stream: false,
      options: { ...STABILITY_OPTIONS, ...options }
    });
    const req = http.request(`${OLLAMA_BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          res.statusCode !== 200 ? reject(new Error(parsed.error || `Status ${res.statusCode}`)) : resolve(parsed);
        } catch { reject(new Error('Bad Ollama response')); }
      });
    });
    req.on('error', e => reject(new Error(`Cannot reach Ollama: ${e.message}`)));
    req.setTimeout(180000, () => { req.destroy(); reject(new Error('Ollama timed out')); });
    req.write(body);
    req.end();
  });
}

function ollamaChatStream(model, messages, outRes) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model, messages, stream: true, options: STABILITY_OPTIONS });
    const req = http.request(`${OLLAMA_BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let buffer = '';
      res.on('data', chunk => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (line.trim()) outRes.write(line + '\n');
        }
      });
      res.on('end', () => {
        if (buffer.trim()) outRes.write(buffer + '\n');
        resolve();
      });
    });
    req.on('error', reject);
    req.setTimeout(300000, () => { req.destroy(); reject(new Error('Stream timed out')); });
    req.write(body);
    req.end();
  });
}

// ── Life entries helpers ─────────────────────────────────────
function readLifeEntries() {
  try { return JSON.parse(fsSync.readFileSync(LIFE_FILE, 'utf-8')); }
  catch { return []; }
}
function writeLifeEntries(entries) {
  fsSync.writeFileSync(LIFE_FILE, JSON.stringify(entries, null, 2));
}

// ── Express app ──────────────────────────────────────────────
const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// ── Ollama proxy (tags, pull, delete) ────────────────────────
app.use(['/api/tags', '/api/pull', '/api/delete'], createProxyMiddleware({
  target: OLLAMA_BASE, changeOrigin: true
}));

app.use(express.json({ limit: '20mb' }));

// ══════════════════════════════════════════════════════════════
//  CHAT APIs
// ══════════════════════════════════════════════════════════════

const SYSTEM_PROMPT = `You are a helpful assistant. When your response includes any mathematical expressions, equations, formulas, or numeric calculations, always render them using LaTeX notation. Use $...$ for inline math and $$...$$ for block/display math. Never write raw math without LaTeX formatting. Do not mention or reference LaTeX — simply use it.`;

app.post('/api/chat', async (req, res) => {
  const { messages, stream, model: reqModel } = req.body;
  const model = reqModel || 'gemma3:latest';

  // Inject live notification summary if any accounts are connected
  const notifSummary = browserAgent.getNotificationSummary();
  const fullSystem = notifSummary
    ? SYSTEM_PROMPT + '\n\n' + notifSummary
    : SYSTEM_PROMPT;

  const hasSystem = messages.some(m => m.role === 'system');
  const msgs = hasSystem
    ? messages.map(m => m.role === 'system' ? { ...m, content: m.content + '\n\n' + fullSystem } : m)
    : [{ role: 'system', content: fullSystem }, ...messages];

  try {
    if (stream) {
      res.setHeader('Content-Type', 'application/x-ndjson');
      res.setHeader('Transfer-Encoding', 'chunked');
      await ollamaChatStream(model, msgs, res);
      res.end();
    } else {
      const result = await ollamaChat(model, msgs);
      res.json(result);
    }
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else { try { res.write(JSON.stringify({ error: err.message }) + '\n'); } catch {} res.end(); }
  }
});

app.post('/api/chat/vision', async (req, res) => {
  const { messages, images, model: reqModel } = req.body;
  const model = reqModel || 'gemma3:latest';
  if (!images || !images.length) return res.status(400).json({ error: 'Missing images' });

  const VISION_SYSTEM = {
    role: 'system',
    content: `You are a technical vision assistant. Describe every visible component, label, text, part, brand, price, or specification. Use LaTeX for math: $...$ inline, $$...$$ block.`
  };

  const fullMessages = [VISION_SYSTEM, ...messages.map((m, i, arr) => {
    const isLastUser = m.role === 'user' && i === arr.map(x => x.role).lastIndexOf('user');
    return isLastUser ? { ...m, images } : m;
  })];

  try {
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Transfer-Encoding', 'chunked');
    await ollamaChatStream(model, fullMessages, res);
    res.end();
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else { try { res.write(JSON.stringify({ error: err.message }) + '\n'); } catch {} res.end(); }
  }
});

// ══════════════════════════════════════════════════════════════
//  CHAT HISTORY CRUD
// ══════════════════════════════════════════════════════════════

app.get('/api/chats', async (req, res) => {
  try {
    const files = await fs.readdir(CHATS_DIR);
    const chats = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const c = JSON.parse(await fs.readFile(path.join(CHATS_DIR, f), 'utf-8'));
        chats.push({ id: c.id, title: c.title, updatedAt: c.updatedAt || 0 });
      } catch {}
    }
    chats.sort((a, b) => b.updatedAt - a.updatedAt);
    res.json(chats);
  } catch { res.json([]); }
});

app.get('/api/chats/:id', async (req, res) => {
  try {
    const c = JSON.parse(await fs.readFile(path.join(CHATS_DIR, `${req.params.id}.json`), 'utf-8'));
    res.json(c);
  } catch { res.status(404).json({ error: 'Not found' }); }
});

app.post('/api/chats', async (req, res) => {
  const { id, history, title } = req.body;
  const chatId = id || `chat_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const chat = { id: chatId, title: title || 'New Chat', history: history || [], updatedAt: Date.now() };
  await fs.writeFile(path.join(CHATS_DIR, `${chatId}.json`), JSON.stringify(chat, null, 2));
  res.json({ success: true, id: chatId });
});

app.delete('/api/chats/:id', async (req, res) => {
  try {
    await fs.unlink(path.join(CHATS_DIR, `${req.params.id}.json`));
    res.json({ success: true });
  } catch { res.status(404).json({ error: 'Not found' }); }
});

// ══════════════════════════════════════════════════════════════
//  SETTINGS & CONFIG
// ══════════════════════════════════════════════════════════════

app.get('/api/config', async (req, res) => {
  const d = await loadData(); res.json(d.config);
});

app.post('/api/config', async (req, res) => {
  const { filesDir } = req.body;
  const d = await loadData();
  if (filesDir) {
    d.config.filesDir = path.isAbsolute(filesDir) ? filesDir : path.join(BASE_PATH, filesDir);
    try { await fs.mkdir(d.config.filesDir, { recursive: true }); } catch {}
  }
  await saveData(d);
  res.json(d.config);
});

app.get('/api/settings', async (req, res) => {
  const d = await loadData(); res.json(d.settings || {});
});

app.post('/api/settings', async (req, res) => {
  const d = await loadData();
  d.settings = { ...(d.settings || {}), ...req.body };
  await saveData(d);
  res.json(d.settings);
});

// ══════════════════════════════════════════════════════════════
//  FILES
// ══════════════════════════════════════════════════════════════

app.get('/api/files', async (req, res) => {
  try {
    const d = await loadData();
    const dir = d.config.filesDir;
    async function walk(p) {
      const entries = await fs.readdir(p, { withFileTypes: true });
      return Promise.all(entries.map(async e => {
        const full = path.resolve(p, e.name);
        return e.isDirectory()
          ? { name: e.name, isDirectory: true, children: await walk(full) }
          : { name: e.name, isDirectory: false, path: path.relative(dir, full) };
      }));
    }
    res.json(await walk(dir));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/files/read', async (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: 'Path required' });

  try {
    const d = await loadData();
    let fullPath = path.join(d.config.filesDir, filePath);
    if (!fullPath.startsWith(d.config.filesDir)) return res.status(403).json({ error: 'Access denied' });

    // Fallback to temp_uploads
    try { await fs.access(fullPath); } catch {
      const tp = path.join(TEMP_UPLOADS_DIR, filePath);
      try { await fs.access(tp); fullPath = tp; } catch { return res.status(404).json({ error: 'Not found' }); }
    }

    const ext = path.extname(fullPath).toLowerCase();

    if (ext === '.pdf') {
      const { PDFParse } = require('pdf-parse');
      const buf = await fs.readFile(fullPath);
      const parser = new PDFParse({ data: buf });
      const pdf = await parser.getText();
      await parser.destroy();
      return res.json({ content: pdf.text || '[No text extracted]' });
    }

    if (['.xlsx', '.xls', '.csv'].includes(ext)) {
      const wb = XLSX.readFile(fullPath);
      let text = '';
      for (const sn of wb.SheetNames) {
        text += `--- Sheet: ${sn} ---\n` + XLSX.utils.sheet_to_csv(wb.Sheets[sn]) + '\n';
      }
      return res.json({ content: text });
    }

    res.json({ content: await fs.readFile(fullPath, 'utf-8') });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/files/serve', async (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).send('Path required');
  try {
    const d = await loadData();
    let fullPath = path.join(d.config.filesDir, filePath);
    if (!fullPath.startsWith(d.config.filesDir)) return res.status(403).send('Access denied');
    try { await fs.access(fullPath); } catch {
      const tp = path.join(TEMP_UPLOADS_DIR, filePath);
      try { await fs.access(tp); fullPath = tp; } catch { return res.status(404).send('Not found'); }
    }
    const ext = path.extname(fullPath).toLowerCase();
    const mime = { '.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.gif':'image/gif','.webp':'image/webp','.svg':'image/svg+xml','.pdf':'application/pdf' };
    res.setHeader('Content-Type', mime[ext] || 'application/octet-stream');
    fsSync.createReadStream(fullPath).pipe(res);
  } catch (err) { res.status(500).send(err.message); }
});

const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    if (req.query.target === 'temp') cb(null, TEMP_UPLOADS_DIR);
    else { const d = await loadData(); cb(null, d.config.filesDir); }
  },
  filename: (req, file, cb) => {
    if (req.query.target === 'temp') {
      const ext = path.extname(file.originalname);
      cb(null, `${path.basename(file.originalname, ext)}-${Date.now()}${ext}`);
    } else cb(null, file.originalname);
  }
});
const upload = multer({ storage });

app.post('/api/files/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  res.json({ success: true, name: req.file.originalname, path: req.file.filename });
});

// ══════════════════════════════════════════════════════════════
//  YOUR LIFE — Personal Memory Store
// ══════════════════════════════════════════════════════════════

app.get('/api/life/entries', (req, res) => {
  let entries = readLifeEntries();
  const { type, q } = req.query;
  if (type && type !== 'all') entries = entries.filter(e => e.type === type);
  if (q) {
    const lq = q.toLowerCase();
    entries = entries.filter(e =>
      (e.name||'').toLowerCase().includes(lq) ||
      (e.description||'').toLowerCase().includes(lq) ||
      (e.notes||'').toLowerCase().includes(lq) ||
      (e.tags||[]).some(t => t.toLowerCase().includes(lq))
    );
  }
  res.json(entries.sort((a,b) => (b.updatedAt||'').localeCompare(a.updatedAt||'')));
});

app.post('/api/life/entries', (req, res) => {
  const entry = req.body;
  if (!entry.name && !entry.title) return res.status(400).json({ error: 'Needs name or title' });
  entry.id = `life_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
  entry.createdAt = new Date().toISOString();
  entry.updatedAt = entry.createdAt;
  const entries = readLifeEntries();
  entries.push(entry);
  writeLifeEntries(entries);
  res.json(entry);
});

app.put('/api/life/entries/:id', (req, res) => {
  const entries = readLifeEntries();
  const idx = entries.findIndex(e => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  entries[idx] = { ...entries[idx], ...req.body, id: req.params.id, updatedAt: new Date().toISOString() };
  writeLifeEntries(entries);
  res.json(entries[idx]);
});

app.delete('/api/life/entries/:id', (req, res) => {
  let entries = readLifeEntries();
  entries = entries.filter(e => e.id !== req.params.id);
  writeLifeEntries(entries);
  res.json({ ok: true });
});

app.get('/api/life/entries/:id', (req, res) => {
  const entry = readLifeEntries().find(e => e.id === req.params.id);
  if (!entry) return res.status(404).json({ error: 'Not found' });
  res.json(entry);
});

// ── Web Agent ────────────────────────────────────────────────
require('./server/web-agent')(app, ollamaChat);

// ── Browser Agent ─────────────────────────────────────────────
const browserAgent = require('./server/browser-agent');
browserAgent.mount(app);

// ── Start ────────────────────────────────────────────────────
function startServer(port, onReady) {
  const server = app.listen(port, () => {
    console.log(`MyAI v2 running at http://localhost:${port}`);
    if (onReady) onReady(port);
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`Port ${port} in use, trying ${port + 1}...`);
      startServer(port + 1, onReady);
    } else {
      throw err;
    }
  });
}

if (require.main === module) startServer(PORT);
module.exports = { startServer, PORT };
