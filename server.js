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

const OLLAMA_BASE = 'http://127.0.0.1:11434';

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

    function ollamaChat(model, messages, stream = false, { options, timeoutMs } = {}) {
        return new Promise((resolve, reject) => {
            const body = { model, messages, stream };
            if (options) body.options = options;
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

    function ollamaChatStream(model, messages, outRes) {
        return new Promise((resolve, reject) => {
            const payload = JSON.stringify({ model, messages, stream: true });
            const req = http.request(`${OLLAMA_BASE}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            }, (res) => {
                let finished = false;
                res.on('data', (chunk) => {
                    if (finished) return;
                    try {
                        outRes.write(chunk);
                        const text = chunk.toString();
                        const lines = text.split('\n');
                        for (const line of lines) {
                            if (line.trim()) {
                                try {
                                    const parsed = JSON.parse(line);
                                    if (parsed.done) {
                                        finished = true;
                                        return;
                                    }
                                } catch {}
                            }
                        }
                    } catch {}
                });
                res.on('end', resolve);
            });
            req.on('error', reject);
            req.setTimeout(300000, () => { req.destroy(); reject(new Error('Thinking model timed out')); });
            req.write(payload);
            req.end();
        });
    }

    ensureChatsDir();
    ensureFilesDir();

    const publicDir = path.join(__dirname, 'public');
    app.use(express.static(publicDir));

    let tesseractWorker = null;
    async function getOcrWorker() {
        if (!tesseractWorker) {
            tesseractWorker = await Tesseract.createWorker('eng');
        }
        return tesseractWorker;
    }

    app.post('/api/chat/vision', express.json({ limit: '100mb' }), async (req, res) => {
        const { visionModel, thinkingModel, messages, images } = req.body;

        if (!visionModel || !thinkingModel || !images || images.length === 0) {
            return res.status(400).json({ error: 'Missing required fields: visionModel, thinkingModel, and images' });
        }

        const userMessage = [...messages].reverse().find(m => m.role === 'user');
        const userQuestion = userMessage?.content?.replace(/\n\n\(System instructions[\s\S]*$/, '').trim() || '';

        try {
            console.log(`[Pipeline] Start — vision=${visionModel}, thinking=${thinkingModel}, images=${images.length}`);

            // ── Stage 1a: Tesseract OCR (fast, runs in parallel with 1b) ──
            console.log('[Pipeline] Stage 1: OCR + Vision running in parallel...');

            const ocrPromise = (async () => {
                const allText = [];
                const worker = await getOcrWorker();
                for (let i = 0; i < images.length; i++) {
                    const imgBuffer = Buffer.from(images[i], 'base64');
                    const { data } = await worker.recognize(imgBuffer);
                    if (data.text.trim()) allText.push(data.text.trim());
                }
                return allText.join('\n\n---\n\n');
            })();

            // ── Stage 1b: Vision model for diagrams/visuals (parallel) ──
            const visionPromise = ollamaChat(visionModel, [{
                role: 'user',
                content: 'Briefly describe any diagrams, graphs, figures, charts, geometric shapes, or visual elements in this image. If the image is only text, reply with "TEXT_ONLY". Keep it concise.',
                images
            }], false).catch(err => {
                console.log(`[Pipeline] Vision pass failed: ${err.message}`);
                return { message: { content: '' } };
            });

            const [ocrText, visionResponse] = await Promise.all([ocrPromise, visionPromise]);
            const visionDesc = (visionResponse.message?.content || '').trim();
            const hasVisuals = visionDesc && !visionDesc.toUpperCase().includes('TEXT_ONLY');

            let extractedContent = ocrText || '(No text could be extracted)';
            if (hasVisuals) {
                extractedContent += `\n\n--- Visual Elements ---\n${visionDesc}`;
            }

            const MAX_CHARS = 8000;
            if (extractedContent.length > MAX_CHARS) {
                extractedContent = extractedContent.substring(0, MAX_CHARS) + '\n[Truncated]';
            }
            console.log(`[Pipeline] Stage 1 complete — OCR: ${ocrText.length} chars, Visuals: ${hasVisuals ? visionDesc.length + ' chars' : 'none'}`);

            // ── Stage 2: Router Agent — fast classification ──
            console.log('[Pipeline] Stage 2: Router classifying...');
            let isSchoolwork = true;
            try {
                const sample = extractedContent.substring(0, 500);
                const routerResponse = await ollamaChat(thinkingModel, [{
                    role: 'user',
                    content: `Classify this content as SCHOOLWORK or GENERAL. Reply with one word only.\n\n"${sample}"`
                }], false, { options: { num_predict: 10, temperature: 0 }, timeoutMs: 15000 });
                const routerRaw = (routerResponse.message?.content || '').trim().toUpperCase();
                isSchoolwork = !routerRaw.includes('GENERAL');
                console.log(`[Pipeline] Stage 2 complete — ${isSchoolwork ? 'SCHOOLWORK' : 'GENERAL'} (raw: "${routerRaw.substring(0, 30)}")`);
            } catch (routerErr) {
                console.log(`[Pipeline] Stage 2 — router failed (${routerErr.message}), defaulting to SCHOOLWORK`);
            }

            // ── Stage 3: Thinking model — generate the response ──
            console.log(`[Pipeline] Stage 3: Thinking model (${isSchoolwork ? 'tutor' : 'general'} mode)...`);

            res.setHeader('Content-Type', 'application/x-ndjson');
            res.setHeader('Transfer-Encoding', 'chunked');

            res.write(JSON.stringify({
                vision_analysis: extractedContent,
                classification: isSchoolwork ? 'schoolwork' : 'general'
            }) + '\n');

            // Build a clean, unified context for the thinking model
            const fileContextMsgs = messages.filter(m => m.role === 'system');
            const conversationMsgs = messages.filter(m => m.role !== 'system');

            let fileContextBlock = '';
            if (fileContextMsgs.length > 0) {
                fileContextBlock = '\n\n## ATTACHED FILES\n' + fileContextMsgs.map(m => m.content).join('\n');
            }

            let systemPrompt;
            if (isSchoolwork) {
                systemPrompt = `You are an expert tutor helping a student with their schoolwork.

## IMAGE CONTENT (via OCR)
${ocrText || '(No text detected)'}
${hasVisuals ? `\n## VISUAL ELEMENTS (diagrams, graphs, figures)\n${visionDesc}` : ''}
${fileContextBlock}
${userQuestion ? `\n## STUDENT'S QUESTION\n${userQuestion}` : ''}

## YOUR INSTRUCTIONS
1. Identify each problem — restate what is being asked in your own words.
2. Show EVERY step — never skip. Write out each transformation, calculation, or logical move.
3. Explain the "why" — for each step, briefly explain the rule, theorem, or reasoning behind it.
4. Use LaTeX — render ALL math with inline $...$ or block $$...$$ notation.
5. Box final answers: $$\\boxed{answer}$$
6. For multiple problems, use clear headings (## Problem 1, ## Problem 2, etc.).
7. Be thorough but clear — a student should be able to follow your work and learn from it.
8. Do NOT mention OCR, image analysis, or extraction. Act as if you see the image directly.
9. If the student asked a specific question, prioritize that over solving everything.`;
            } else {
                systemPrompt = `The user shared an image.

## IMAGE CONTENT
${ocrText || '(No text detected)'}
${hasVisuals ? `\n## VISUAL ELEMENTS\n${visionDesc}` : ''}
${fileContextBlock}
${userQuestion ? `\n## USER'S QUESTION\n${userQuestion}` : ''}

Answer based on the content above. Be thorough and helpful. Do not mention OCR or image analysis.`;
            }

            await ollamaChatStream(thinkingModel, [
                { role: 'system', content: systemPrompt },
                ...conversationMsgs
            ], res);
            res.end();
            console.log('[Pipeline] Complete.');
        } catch (error) {
            console.error('[Pipeline] Error:', error.message);
            if (!res.headersSent) {
                res.status(500).json({ error: error.message });
            } else {
                try { res.write(JSON.stringify({ error: error.message }) + '\n'); } catch {}
                res.end();
            }
        }
    });

    app.use(['/api/chat', '/api/tags', '/api/pull'], createProxyMiddleware({
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
            await ensureChatsDir();
            const files = await fs.readdir(CHATS_DIR);
            const jsonFiles = files.filter(f => f.endsWith('.json'));

            const chats = [];
            for (const file of jsonFiles) {
                try {
                    const raw = await fs.readFile(path.join(CHATS_DIR, file), 'utf-8');
                    const parsed = JSON.parse(raw);
                    chats.push({ id: parsed.id, title: parsed.title });
                } catch (e) { console.error("Error reading chat file:", file); }
            }

            chats.sort((a, b) => b.id - a.id);
            res.json(chats);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    app.get('/api/chats/:id', async (req, res) => {
        try {
            const filePath = path.join(CHATS_DIR, `${req.params.id}.json`);
            const content = await fs.readFile(filePath, 'utf-8');
            res.json(JSON.parse(content));
        } catch (error) {
            res.status(404).json({ error: 'Chat not found' });
        }
    });

    app.post('/api/chats', async (req, res) => {
        const { id, history, title } = req.body;
        try {
            await ensureChatsDir();
            const chatId = id || Date.now();

            const cleanHistory = (history || []).filter(m => m.role !== 'system');
            const chatData = { id: chatId, title: title || 'New Chat', history: cleanHistory };

            const filePath = path.join(CHATS_DIR, `${chatId}.json`);
            await fs.writeFile(filePath, JSON.stringify(chatData, null, 2));

            res.json({ success: true, id: chatId });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
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
