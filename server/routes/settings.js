const path = require('path');
const fs = require('fs').promises;
const { loadData, saveData } = require('../data');
const { ROOT } = require('../paths');

module.exports = function (app) {
  app.get('/api/config', async (req, res) => {
    const d = await loadData(); res.json(d.config);
  });

  app.post('/api/config', async (req, res) => {
    const { filesDir } = req.body;
    const d = await loadData();
    if (filesDir) {
      d.config.filesDir = path.isAbsolute(filesDir) ? filesDir : path.join(ROOT, filesDir);
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
};
