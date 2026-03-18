const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const path = require('path');
const { spawn } = require('child_process');
const { OLLAMA_BASE } = require('./ollama');
const { warmUpSmallModel, startKeepAlive } = require('./context-director');

// Ensure Ollama is running before anything else
function ensureOllama() {
  return new Promise((resolve) => {
    const http = require('http');
    console.log('[ollama] Checking if ollama is running...');

    function pollUntilReady() {
      let attempts = 0;
      const poll = setInterval(() => {
        if (++attempts > 40) {
          clearInterval(poll);
          console.warn('[ollama] Timed out waiting — continuing anyway');
          resolve();
          return;
        }
        const r = http.get(`${OLLAMA_BASE}/api/tags`, (res) => {
          res.resume();
          clearInterval(poll);
          console.log('[ollama] Ready');
          resolve();
        });
        r.setTimeout(400, () => r.destroy());
        r.on('error', () => {});
      }, 500);
    }

    function launchOllama() {
      console.log('[ollama] Not running — launching ollama serve...');
      // Try powershell Start-Process which reliably detaches on Windows
      try {
        const proc = spawn('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
          '-Command', 'Start-Process ollama -ArgumentList serve -WindowStyle Hidden'
        ], { stdio: 'ignore', windowsHide: true });
        proc.on('error', () => {
          // Fallback: plain spawn with shell
          try {
            const fb = spawn('ollama', ['serve'], { shell: true, detached: true, stdio: 'ignore', windowsHide: true });
            fb.on('error', (e) => console.error('[ollama] Launch failed:', e.message));
            fb.unref();
          } catch (e) {
            console.error('[ollama] Launch failed:', e.message);
          }
        });
      } catch (err) {
        console.error('[ollama] Launch error:', err.message);
      }
      pollUntilReady();
    }

    // Check if already running
    const req = http.get(`${OLLAMA_BASE}/api/tags`, (res) => {
      res.resume();
      console.log('[ollama] Already running');
      resolve();
    });
    req.setTimeout(1500, () => req.destroy());
    req.on('error', launchOllama);
  });
}

// Ensure directories exist on startup
require('./paths');

// Run migration if needed
require('./migrate');

const app = express();
const PORT = 3000;

// Static files
app.use(express.static(path.join(__dirname, '..', 'public')));

// Ollama proxy (tags, pull, delete)
app.use(['/api/tags', '/api/pull', '/api/delete'], createProxyMiddleware({
  target: OLLAMA_BASE, changeOrigin: true
}));

// TTS proxy (Kokoro on port 5111)
app.use('/api/tts', createProxyMiddleware({
  target: 'http://127.0.0.1:5111',
  changeOrigin: true,
  pathRewrite: { '^/api/tts': '/tts' },
}));

app.use(express.json({ limit: '20mb' }));

// Mount routes
require('./routes/chat')(app);
require('./routes/chats')(app);
require('./routes/documents')(app);
require('./routes/files')(app);
require('./routes/life')(app);
require('./routes/settings')(app);
require('./routes/rag')(app);
require('./web-agent')(app);
require('./routes/context')(app);

// Start server
function startServer(port) {
  const server = app.listen(port, () => {
    console.log(`MyAI running at http://localhost:${port}`);
    warmUpSmallModel().then(() => startKeepAlive());
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`Port ${port} in use, trying ${port + 1}...`);
      startServer(port + 1);
    } else {
      throw err;
    }
  });
}

ensureOllama().then(() => startServer(PORT));
