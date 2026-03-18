const { readLifeEntries, writeLifeEntries } = require('../data');

module.exports = function (app) {
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
};
