const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const path = require('path');
const multer = require('multer');
const fs = require('fs').promises;
const fsSync = require('fs');
const http = require('http');
const { PDFParse } = require('pdf-parse');
const XLSX = require('xlsx');
const Tesseract = require('tesseract.js');
const { spawn } = require('child_process');

const OLLAMA_BASE = 'http://127.0.0.1:11434';
const PYTHON_AGENT_BASE = 'http://127.0.0.1:3001';

function getBasePath() {
    try {
        const { app } = require('electron');
        return app.getPath('userData');
    } catch {
        return __dirname;
    }
}

function startServer(port = 3000) {
    const app = express();
    const BASE_PATH = getBasePath();
    const DATA_FILE = path.join(BASE_PATH, 'data.json');
    const CHATS_DIR = path.join(BASE_PATH, 'Chats');
    const DEFAULT_FILES_DIR = path.join(BASE_PATH, 'files');
    const TEMP_UPLOADS_DIR = path.join(BASE_PATH, 'temp_uploads');

    async function ensureChatsDir() {
        try { await fs.mkdir(CHATS_DIR, { recursive: true }); } catch (e) { }
    }

    async function ensureFilesDir() {
        try { await fs.mkdir(DEFAULT_FILES_DIR, { recursive: true }); } catch (e) { }
        try { await fs.mkdir(TEMP_UPLOADS_DIR, { recursive: true }); } catch (e) { }
    }

    async function loadData() {
        try {
            const content = await fs.readFile(DATA_FILE, 'utf-8');
            return JSON.parse(content);
        } catch (e) {
            return { config: { filesDir: DEFAULT_FILES_DIR } };
        }
    }

    async function saveData(data) {
        await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2));
    }

    const STABILITY_OPTIONS = {
        temperature: 0.1,
        top_p: 0.9,
        num_ctx: 4096
    };

    function ollamaChat(model, messages, stream = false, { options, timeoutMs } = {}) {
        return new Promise((resolve, reject) => {
            const body = { model, messages, stream };
            body.options = { ...STABILITY_OPTIONS, ...options };
            const payload = JSON.stringify(body);
            const timeout = timeoutMs || 180000;
            const req = http.request(`${OLLAMA_BASE}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            }, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(data);
                        if (res.statusCode !== 200) {
                            reject(new Error(parsed.error || `Ollama returned status ${res.statusCode}`));
                        } else {
                            resolve(parsed);
                        }
                    }
                    catch (e) { reject(new Error(`Failed to parse Ollama response (status ${res.statusCode}): ${data.substring(0, 200)}`)); }
                });
            });
            req.on('error', (err) => reject(new Error(`Cannot reach Ollama: ${err.message}`)));
            req.setTimeout(timeout, () => { req.destroy(); reject(new Error(`Model "${model}" timed out after ${Math.round(timeout / 1000)}s`)); });
            req.write(payload);
            req.end();
        });
    }

    function ollamaChatStream(model, messages, outRes, suppressDone = false) {
        return new Promise((resolve, reject) => {
            const payload = JSON.stringify({ 
                model, 
                messages, 
                stream: true,
                options: STABILITY_OPTIONS
            });
            const req = http.request(`${OLLAMA_BASE}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            }, (res) => {
                let buffer = '';
                res.on('data', (chunk) => {
                    buffer += chunk.toString();
                    let lines = buffer.split('\n');
                    buffer = lines.pop(); // Keep the last partial line

                    for (const line of lines) {
                        if (!line.trim()) continue;
                        try {
                            const parsed = JSON.parse(line);
                            if (parsed.done && suppressDone) {
                                const { done, ...rest } = parsed;
                                outRes.write(JSON.stringify(rest) + '\n');
                            } else {
                                outRes.write(line + '\n');
                            }
                        } catch (e) {
                            // If it's not JSON, just pass it through as is
                            outRes.write(line + '\n');
                        }
                    }
                });
                res.on('end', () => {
                    if (buffer.trim()) outRes.write(buffer + '\n');
                    resolve();
                });
            });
            req.on('error', reject);
            req.setTimeout(300000, () => { req.destroy(); reject(new Error('Model timed out')); });
            req.write(payload);
            req.end();
        });
    }

    async function getThinContext(chatId, prompt) {
        return new Promise((resolve) => {
            const payload = JSON.stringify({ chat_id: chatId, prompt });
            const req = http.request(`${PYTHON_AGENT_BASE}/api/thin_context`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            }, (res) => {
                let data = '';
                res.on('data', d => data += d);
                res.on('end', () => {
                    try { resolve(JSON.parse(data)); } catch { resolve({ forensic_history: [], semantic_context: '', schema: '' }); }
                });
            });
            req.on('error', () => resolve({ forensic_history: [], semantic_context: '', schema: '' }));
            req.setTimeout(2000, () => { req.destroy(); resolve({ forensic_history: [], semantic_context: '', schema: '' }); });
            req.write(payload);
            req.end();
        });
    }

    function startPythonAgent() {
        console.log('[System] Spawning Python SQL Agent...');
        const py = spawn('py', [path.join(__dirname, 'sql_agent.py'), '3001']);
        py.stdout.on('data', (data) => console.log(`[Python] ${data.toString().trim()}`));
        py.stderr.on('data', (data) => console.error(`[Python Error] ${data.toString().trim()}`));
        process.on('exit', () => py.kill());
    }

    ensureChatsDir();
    ensureFilesDir();
    startPythonAgent();

    const publicDir = path.join(__dirname, 'public');
    app.use(express.static(publicDir));

    // Mount agent-specific routes (separate file for safety)
    require('./server-agent')(app, TEMP_UPLOADS_DIR, fs);

    app.post('/api/chat/vision', express.json({ limit: '100mb' }), async (req, res) => {
        const { messages, images, model: requestedModel } = req.body;
        const visionModel = requestedModel || "gemma3:latest";

        if (!images || images.length === 0) {
            return res.status(400).json({ error: 'Missing images' });
        }

        try {
            console.log(`[Vision] model=${visionModel}, images=${images.length}`);

            res.setHeader('Content-Type', 'application/x-ndjson');
            res.setHeader('Transfer-Encoding', 'chunked');
            res.write(JSON.stringify({ agent_metadata: { keywords: [] } }) + '\n');

            const SYSTEM_PROMPT = {
                role: 'system',
                content: `You are a technical vision assistant. When the user provides an image, follow this structure exactly:

## Visual Analysis
Describe every visible component, label, text, part number, brand, price, unit, or specification shown in the image. Miss nothing — read all text literally including small print.

## Technical Summary
Provide a structured breakdown using headers and bullet points:
- **Component / Product name**
- **Brand / Manufacturer**
- **Part numbers or model identifiers**
- **Key specifications** (dimensions, ratings, protocols, etc.)
- **Price or units if visible**
- **Notable details or observations**

## Response
Answer the user's specific question using the visual analysis above as your primary context.

For any mathematical expressions or formulas, use LaTeX: $...$ for inline and $$...$$ for block math. Do not mention LaTeX — just use it.`
            };

            // Build messages: system + full history, attaching images only to the last user message
            const fullMessages = [SYSTEM_PROMPT, ...messages.map((m, i, arr) => {
                const isLastUser = m.role === 'user' && i === arr.map(x => x.role).lastIndexOf('user');
                if (isLastUser) {
                    return { ...m, images };
                }
                return m;
            })];

            await ollamaChatStream(visionModel, fullMessages, res);
            res.end();
        } catch (error) {
            console.error('[Vision] Error:', error.message);
            if (!res.headersSent) {
                res.status(500).json({ error: error.message });
            } else {
                try { res.write(JSON.stringify({ error: error.message }) + '\n'); } catch {}
                res.end();
            }
        }
    });

    app.post('/api/chat', express.json({ limit: '50mb' }), async (req, res) => {
        const { messages, stream, chatId, model: requestedModel } = req.body;
        const model = requestedModel || "gemma3:latest";

        try {
            const targetModel = model;

            const SYSTEM_PROMPT = `You are a helpful assistant. When your response includes any mathematical expressions, equations, formulas, or numeric calculations, always render them using LaTeX notation. Use $...$ for inline math and $$...$$ for block/display math. Never write raw math without LaTeX formatting. Do not mention or reference LaTeX — simply use it.`;

            const hasSystem = messages.some(m => m.role === 'system');
            const messagesWithSystem = hasSystem
                ? messages.map(m => m.role === 'system' ? { ...m, content: m.content + '\n\n' + SYSTEM_PROMPT } : m)
                : [{ role: 'system', content: SYSTEM_PROMPT }, ...messages];

            if (stream) {
                res.setHeader('Content-Type', 'application/x-ndjson');
                res.write(JSON.stringify({ agent_metadata: { keywords: [] } }) + '\n');
                await ollamaChatStream(targetModel, messagesWithSystem, res);
                res.end();
            } else {
                const response = await ollamaChat(targetModel, messagesWithSystem);
                res.json({ ...response, agent_metadata: { keywords: [] } });
            }
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    app.use(['/api/tags', '/api/pull', '/api/delete'], createProxyMiddleware({
        target: OLLAMA_BASE,
        changeOrigin: true
    }));

    app.use(express.json({ limit: '100mb' }));

    const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg'];

    app.get('/api/files/serve', async (req, res) => {
        const filePath = req.query.path;
        if (!filePath) return res.status(400).send('Path required');
        try {
            const data = await loadData();
            let fullPath = path.join(data.config.filesDir, filePath);
            if (!fullPath.startsWith(data.config.filesDir)) {
                return res.status(403).send('Access denied');
            }

            // Fallback to temp_uploads if it doesn't exist in local space
            try {
                await fs.access(fullPath);
            } catch (e) {
                const tempPath = path.join(TEMP_UPLOADS_DIR, filePath);
                try {
                    await fs.access(tempPath);
                    fullPath = tempPath;
                } catch (e2) {
                    return res.status(404).send('File not found');
                }
            }
            const ext = path.extname(fullPath).toLowerCase();
            const mimeMap = {
                '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
                '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml'
            };
            res.setHeader('Content-Type', mimeMap[ext] || 'application/octet-stream');
            const stream = require('fs').createReadStream(fullPath);
            stream.pipe(res);
        } catch (error) {
            res.status(500).send(error.message);
        }
    });

    app.get('/api/config', async (req, res) => {
        const data = await loadData();
        res.json(data.config);
    });

    app.post('/api/config', async (req, res) => {
        const { filesDir } = req.body;
        const data = await loadData();
        if (filesDir) {
            data.config.filesDir = path.isAbsolute(filesDir) ? filesDir : path.join(BASE_PATH, filesDir);
            try { await fs.mkdir(data.config.filesDir, { recursive: true }); } catch (e) { }
        }
        await saveData(data);
        res.json(data.config);
    });

    app.get('/api/chats', async (req, res) => {
        try {
            const files = await fs.readdir(CHATS_DIR);
            const chats = [];
            for (const file of files) {
                if (!file.endsWith('.json')) continue;
                try {
                    const content = await fs.readFile(path.join(CHATS_DIR, file), 'utf-8');
                    const chat = JSON.parse(content);
                    chats.push({ id: chat.id, title: chat.title, isFilesChat: !!chat.isFilesChat, updatedAt: chat.updatedAt || 0 });
                } catch {}
            }
            chats.sort((a, b) => b.updatedAt - a.updatedAt);
            res.json(chats);
        } catch { res.json([]); }
    });

    app.get('/api/chats/:id', async (req, res) => {
        try {
            const content = await fs.readFile(path.join(CHATS_DIR, `${req.params.id}.json`), 'utf-8');
            res.json(JSON.parse(content));
        } catch { res.status(404).json({ error: 'Not found' }); }
    });

    app.post('/api/chats', express.json(), async (req, res) => {
        const { id, history, title, isFilesChat } = req.body;
        const chatId = id || `chat_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const chat = { id: chatId, title: title || 'New Chat', history: history || [], isFilesChat: !!isFilesChat, updatedAt: Date.now() };
        await fs.writeFile(path.join(CHATS_DIR, `${chatId}.json`), JSON.stringify(chat, null, 2));
        res.json({ success: true, id: chatId });
    });

    app.delete('/api/chats/:id', async (req, res) => {
        try {
            await fs.unlink(path.join(CHATS_DIR, `${req.params.id}.json`));
            res.json({ success: true });
        } catch { res.status(404).json({ error: 'Not found' }); }
    });

    app.get('/api/settings', async (req, res) => {
        const data = await loadData();
        res.json(data.settings || {});
    });

    app.post('/api/settings', express.json(), async (req, res) => {
        const data = await loadData();
        data.settings = { ...(data.settings || {}), ...req.body };
        await saveData(data);
        res.json(data.settings);
    });

    app.get('/api/files', async (req, res) => {
        try {
            const data = await loadData();
            const dirToRead = data.config.filesDir;
            const getFiles = async (dir) => {
                const entries = await fs.readdir(dir, { withFileTypes: true });
                const files = await Promise.all(entries.map(async (entry) => {
                    const resPath = path.resolve(dir, entry.name);
                    return entry.isDirectory()
                        ? { name: entry.name, isDirectory: true, children: await getFiles(resPath) }
                        : { name: entry.name, isDirectory: false, path: path.relative(dirToRead, resPath) };
                }));
                return files;
            };
            const files = await getFiles(dirToRead);
            res.json(files);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    app.get('/api/files/read', async (req, res) => {
        const filePath = req.query.path;
        if (!filePath) return res.status(400).json({ error: 'Path required' });

        try {
            const data = await loadData();
            let fullPath = path.join(data.config.filesDir, filePath);
            if (!fullPath.startsWith(data.config.filesDir)) {
                return res.status(403).json({ error: 'Access denied' });
            }

            try {
                await fs.access(fullPath);
            } catch (e) {
                const tempPath = path.join(TEMP_UPLOADS_DIR, filePath);
                try {
                    await fs.access(tempPath);
                    fullPath = tempPath;
                } catch (e2) {
                    return res.status(404).json({ error: 'File not found' });
                }
            }

            const ext = path.extname(fullPath).toLowerCase();
            if (ext === '.pdf') {
                try {
                    const dataBuffer = await fs.readFile(fullPath);
                    const parser = new PDFParse({ data: dataBuffer });
                    const pdfData = await parser.getText();
                    await parser.destroy();
                    
                    if (!pdfData.text || pdfData.text.trim().length === 0) {
                        return res.json({ content: "[Warning: No text could be extracted from this PDF. It might be a scanned image or protected.]" });
                    }
                    return res.json({ content: pdfData.text });
                } catch (pdfErr) {
                    console.error(`Error parsing PDF ${filePath}:`, pdfErr);
                    return res.status(500).json({ error: `Failed to parse PDF: ${pdfErr.message}` });
                }
            }

            if (['.xlsx', '.xls', '.csv'].includes(ext)) {
                const workbook = XLSX.readFile(fullPath);
                let text = '';
                for (const sheetName of workbook.SheetNames) {
                    text += `--- Sheet: ${sheetName} ---\n`;
                    text += XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName]);
                    text += '\n';
                }
                return res.json({ content: text });
            }

            const content = await fs.readFile(fullPath, 'utf-8');
            res.json({ content });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    const storage = multer.diskStorage({
        destination: async (req, file, cb) => {
            if (req.query.target === 'temp') {
                cb(null, TEMP_UPLOADS_DIR);
            } else {
                const data = await loadData();
                cb(null, data.config.filesDir);
            }
        },
        filename: (req, file, cb) => {
            if (req.query.target === 'temp') {
                const ext = path.extname(file.originalname);
                const name = path.basename(file.originalname, ext);
                cb(null, `${name}-${Date.now()}${ext}`);
            } else {
                cb(null, file.originalname);
            }
        }
    });
    const upload = multer({ storage });

    app.post('/api/files/upload', upload.single('file'), async (req, res) => {
        try {
            if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
            
            res.json({ success: true, name: req.file.originalname, path: req.file.filename });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    return new Promise((resolve, reject) => {
        const server = app.listen(port, () => {
            console.log(`ChatGPT 2.0 running at http://localhost:${port}`);
            resolve({ server, port });
        });
        server.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                console.log(`Port ${port} in use, trying ${port + 1}...`);
                server.close();
                startServer(port + 1).then(resolve).catch(reject);
            } else {
                reject(err);
            }
        });
    });
}

if (require.main === module) {
    startServer();
}

module.exports = { startServer };
