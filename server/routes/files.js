const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const multer = require('multer');
const XLSX = require('xlsx');
const { TEMP_DIR } = require('../paths');
const { loadData } = require('../data');

module.exports = function (app) {
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

      // Fallback to temp
      try { await fs.access(fullPath); } catch {
        const tp = path.join(TEMP_DIR, filePath);
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
        const tp = path.join(TEMP_DIR, filePath);
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
      if (req.query.target === 'temp') cb(null, TEMP_DIR);
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
};
