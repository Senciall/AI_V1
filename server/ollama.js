const http = require('http');

const OLLAMA_BASE = 'http://127.0.0.1:11434';
const STABILITY_OPTIONS = { temperature: 0.1, top_p: 0.9, num_ctx: 4096 };

function ollamaChat(model, messages, options = {}) {
  return new Promise((resolve, reject) => {
    const { keep_alive, ...ollamaOptions } = options;
    const body = JSON.stringify({
      model, messages, stream: false,
      ...(keep_alive !== undefined && { keep_alive }),
      options: { ...STABILITY_OPTIONS, ...ollamaOptions }
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

module.exports = { OLLAMA_BASE, STABILITY_OPTIONS, ollamaChat, ollamaChatStream };
