const { ollamaChat, ollamaChatStream } = require('../ollama');

const SYSTEM_PROMPT = `You are a helpful assistant. When your response includes any mathematical expressions, equations, formulas, or numeric calculations, always render them using LaTeX notation. Use $...$ for inline math and $$...$$ for block/display math. Never write raw math without LaTeX formatting. Do not mention or reference LaTeX — simply use it.`;

const VOICE_SYSTEM_PROMPT = `You are a voice assistant having a real-time conversation. Keep responses SHORT — 1-3 sentences max. Be direct, natural, and conversational. No markdown, no bullet points, no code blocks, no LaTeX. Speak like a human would in a phone call. If asked something complex, give the key point first, then offer to explain more.`;

module.exports = function (app) {
  app.post('/api/chat', async (req, res) => {
    const { messages, stream, model: reqModel, voice } = req.body;
    const model = reqModel || 'gemma3:latest';
    const systemPrompt = voice ? VOICE_SYSTEM_PROMPT : SYSTEM_PROMPT;
    const hasSystem = messages.some(m => m.role === 'system');
    const msgs = hasSystem
      ? messages.map(m => m.role === 'system' ? { ...m, content: m.content + '\n\n' + systemPrompt } : m)
      : [{ role: 'system', content: systemPrompt }, ...messages];

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
};
