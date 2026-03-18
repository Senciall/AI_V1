const fs = require('fs').promises;
const path = require('path');
const { CHATS_DIR } = require('../paths');

module.exports = function (app) {
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
};
