const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const multer = require('multer');
const XLSX = require('xlsx');
const { DOCUMENTS_DIR, TEMP_DIR, DOCS_PDFS, DOCS_IMAGES, DOCS_SPREADSHEETS, DOCS_OTHER } = require('../paths');
const { loadManifest, saveManifest } = require('../data');
const { extractMetadata, normalizeMetadata } = require('../rag/metadata-agent');
const { indexDocument, removeDocument } = require('../rag/vector-store');

// Category mapping by extension
const CATEGORY_MAP = {
  '.pdf': 'pdfs',
  '.png': 'images', '.jpg': 'images', '.jpeg': 'images', '.gif': 'images',
  '.webp': 'images', '.svg': 'images', '.bmp': 'images',
  '.xlsx': 'spreadsheets', '.xls': 'spreadsheets', '.csv': 'spreadsheets',
};

const CATEGORY_DIRS = {
  pdfs: DOCS_PDFS,
  images: DOCS_IMAGES,
  spreadsheets: DOCS_SPREADSHEETS,
  other: DOCS_OTHER,
};

const MIME_MAP = {
  '.pdf': 'application/pdf',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel', '.csv': 'text/csv',
  '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json',
};

function generateDocId() {
  return `doc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function generateFolderId() {
  return `folder_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function getCategory(ext) {
  return CATEGORY_MAP[ext.toLowerCase()] || 'other';
}

// Extract text from a file for LLM retrieval
async function extractText(filePath, ext) {
  try {
    if (ext === '.pdf') {
      const { PDFParse } = require('pdf-parse');
      const buf = await fs.readFile(filePath);
      const parser = new PDFParse({ data: buf });
      const pdf = await parser.getText();
      await parser.destroy();
      return pdf.text || '';
    }

    if (['.xlsx', '.xls', '.csv'].includes(ext)) {
      const wb = XLSX.readFile(filePath);
      let text = '';
      for (const sn of wb.SheetNames) {
        text += `--- Sheet: ${sn} ---\n` + XLSX.utils.sheet_to_csv(wb.Sheets[sn]) + '\n';
      }
      return text;
    }

    if (['.txt', '.md', '.json', '.js', '.py', '.html', '.css'].includes(ext)) {
      return await fs.readFile(filePath, 'utf-8');
    }
  } catch (err) {
    console.error(`Text extraction failed for ${filePath}:`, err.message);
  }
  return null;
}

// Multer storage: files go to temp/ first
const tempStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, TEMP_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `upload_${Date.now()}${ext}`);
  }
});
const upload = multer({ storage: tempStorage });

// Get all descendant folder IDs (for recursive delete)
function getDescendantFolderIds(folders, parentId) {
  const ids = [];
  const children = folders.filter(f => f.parent === parentId);
  for (const child of children) {
    ids.push(child.id);
    ids.push(...getDescendantFolderIds(folders, child.id));
  }
  return ids;
}

module.exports = function (app) {

  // ═══ FOLDER CRUD ═══

  // Get full tree (folders + documents)
  app.get('/api/documents/tree', async (req, res) => {
    try {
      const manifest = await loadManifest();
      res.json({
        folders: manifest.folders || [],
        documents: manifest.documents || [],
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Create folder
  app.post('/api/folders', async (req, res) => {
    try {
      const { name, parent } = req.body;
      if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });

      const manifest = await loadManifest();
      if (!manifest.folders) manifest.folders = [];

      // Validate parent exists if specified
      if (parent && !manifest.folders.find(f => f.id === parent)) {
        return res.status(400).json({ error: 'Parent folder not found' });
      }

      const folder = {
        id: generateFolderId(),
        name: name.trim(),
        parent: parent || null,
        createdAt: new Date().toISOString(),
      };
      manifest.folders.push(folder);
      await saveManifest(manifest);
      res.json(folder);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Rename folder
  app.put('/api/folders/:id', async (req, res) => {
    try {
      const { name } = req.body;
      if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });

      const manifest = await loadManifest();
      const folder = (manifest.folders || []).find(f => f.id === req.params.id);
      if (!folder) return res.status(404).json({ error: 'Not found' });

      folder.name = name.trim();
      await saveManifest(manifest);
      res.json(folder);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Move folder to new parent
  app.put('/api/folders/:id/move', async (req, res) => {
    try {
      const { parent } = req.body; // null = root
      const manifest = await loadManifest();
      const folder = (manifest.folders || []).find(f => f.id === req.params.id);
      if (!folder) return res.status(404).json({ error: 'Not found' });

      // Prevent moving folder into itself or its descendants
      if (parent) {
        const descendants = getDescendantFolderIds(manifest.folders, folder.id);
        if (parent === folder.id || descendants.includes(parent)) {
          return res.status(400).json({ error: 'Cannot move folder into itself' });
        }
        if (!manifest.folders.find(f => f.id === parent)) {
          return res.status(400).json({ error: 'Target folder not found' });
        }
      }

      folder.parent = parent || null;
      await saveManifest(manifest);
      res.json(folder);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Delete folder (and all contents recursively)
  app.delete('/api/folders/:id', async (req, res) => {
    try {
      const manifest = await loadManifest();
      const folder = (manifest.folders || []).find(f => f.id === req.params.id);
      if (!folder) return res.status(404).json({ error: 'Not found' });

      // Get all descendant folder IDs
      const allFolderIds = [folder.id, ...getDescendantFolderIds(manifest.folders, folder.id)];

      // Delete all documents in these folders
      const docsToDelete = manifest.documents.filter(d => allFolderIds.includes(d.folder));
      for (const doc of docsToDelete) {
        const filePath = path.join(CATEGORY_DIRS[doc.category], doc.filename);
        const textPath = path.join(CATEGORY_DIRS[doc.category], `${doc.id}.txt`);
        try { await fs.unlink(filePath); } catch {}
        try { await fs.unlink(textPath); } catch {}
      }

      // Remove documents and folders from manifest
      manifest.documents = manifest.documents.filter(d => !allFolderIds.includes(d.folder));
      manifest.folders = manifest.folders.filter(f => !allFolderIds.includes(f.id));
      await saveManifest(manifest);

      res.json({ success: true, deletedFolders: allFolderIds.length, deletedDocuments: docsToDelete.length });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ═══ DOCUMENT CRUD ═══

  // Upload a document
  app.post('/api/documents/upload', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file' });

    try {
      const ext = path.extname(req.file.originalname).toLowerCase();
      const category = getCategory(ext);
      const docId = generateDocId();
      const filename = `${docId}${ext}`;
      const destDir = CATEGORY_DIRS[category];
      const destPath = path.join(destDir, filename);

      // Move from temp to permanent location
      await fs.rename(req.file.path, destPath);

      // Extract text for LLM retrieval
      const text = await extractText(destPath, ext);
      let hasText = false;
      if (text && text.trim()) {
        const textPath = path.join(destDir, `${docId}.txt`);
        await fs.writeFile(textPath, text);
        hasText = true;
      }

      // Add to manifest — folder comes from query param
      const manifest = await loadManifest();
      const doc = {
        id: docId,
        originalName: req.file.originalname,
        filename,
        category,
        mimeType: MIME_MAP[ext] || 'application/octet-stream',
        size: req.file.size,
        uploadedAt: new Date().toISOString(),
        hasText,
        folder: req.query.folder || null,
      };
      manifest.documents.push(doc);
      await saveManifest(manifest);

      res.json(doc);

      // Auto-index for RAG in background (non-blocking)
      if (text && text.trim()) {
        setImmediate(async () => {
          try {
            const rawMeta = await extractMetadata(text, req.file.originalname);
            const metadata = normalizeMetadata(rawMeta);
            await indexDocument(docId, text, metadata);
            console.log(`[RAG] Auto-indexed ${req.file.originalname}`);
          } catch (err) {
            console.error(`[RAG] Auto-index failed for ${req.file.originalname}:`, err.message);
          }
        });
      }
    } catch (err) {
      // Clean up temp file on error
      try { await fs.unlink(req.file.path); } catch {}
      res.status(500).json({ error: err.message });
    }
  });

  // List all documents
  app.get('/api/documents', async (req, res) => {
    try {
      const manifest = await loadManifest();
      let docs = manifest.documents;
      const { category, folder } = req.query;
      if (category && category !== 'all') {
        docs = docs.filter(d => d.category === category);
      }
      if (folder !== undefined) {
        docs = docs.filter(d => (d.folder || null) === (folder || null));
      }
      docs.sort((a, b) => (b.uploadedAt || '').localeCompare(a.uploadedAt || ''));
      res.json(docs);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Get single document metadata
  app.get('/api/documents/:id', async (req, res) => {
    try {
      const manifest = await loadManifest();
      const doc = manifest.documents.find(d => d.id === req.params.id);
      if (!doc) return res.status(404).json({ error: 'Not found' });
      res.json(doc);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Move document to folder
  app.put('/api/documents/:id/move', async (req, res) => {
    try {
      const { folder } = req.body; // null = root
      const manifest = await loadManifest();
      const doc = manifest.documents.find(d => d.id === req.params.id);
      if (!doc) return res.status(404).json({ error: 'Not found' });

      if (folder && !(manifest.folders || []).find(f => f.id === folder)) {
        return res.status(400).json({ error: 'Target folder not found' });
      }

      doc.folder = folder || null;
      await saveManifest(manifest);
      res.json(doc);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Rename document
  app.put('/api/documents/:id', async (req, res) => {
    try {
      const { name } = req.body;
      if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });

      const manifest = await loadManifest();
      const doc = manifest.documents.find(d => d.id === req.params.id);
      if (!doc) return res.status(404).json({ error: 'Not found' });

      doc.originalName = name.trim();
      await saveManifest(manifest);
      res.json(doc);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Get extracted text (for LLM injection)
  app.get('/api/documents/:id/text', async (req, res) => {
    try {
      const manifest = await loadManifest();
      const doc = manifest.documents.find(d => d.id === req.params.id);
      if (!doc) return res.status(404).json({ error: 'Not found' });

      const textPath = path.join(CATEGORY_DIRS[doc.category], `${doc.id}.txt`);
      try {
        const content = await fs.readFile(textPath, 'utf-8');
        res.json({ content, documentId: doc.id, originalName: doc.originalName });
      } catch {
        const filePath = path.join(CATEGORY_DIRS[doc.category], doc.filename);
        const ext = path.extname(doc.filename).toLowerCase();
        const text = await extractText(filePath, ext);
        if (text) {
          res.json({ content: text, documentId: doc.id, originalName: doc.originalName });
        } else {
          res.status(404).json({ error: 'No text available for this document' });
        }
      }
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Serve raw file
  app.get('/api/documents/:id/raw', async (req, res) => {
    try {
      const manifest = await loadManifest();
      const doc = manifest.documents.find(d => d.id === req.params.id);
      if (!doc) return res.status(404).send('Not found');

      const filePath = path.join(CATEGORY_DIRS[doc.category], doc.filename);
      res.setHeader('Content-Type', doc.mimeType || 'application/octet-stream');
      fsSync.createReadStream(filePath).pipe(res);
    } catch (err) { res.status(500).send(err.message); }
  });

  // Delete a document
  app.delete('/api/documents/:id', async (req, res) => {
    try {
      const manifest = await loadManifest();
      const idx = manifest.documents.findIndex(d => d.id === req.params.id);
      if (idx === -1) return res.status(404).json({ error: 'Not found' });

      const doc = manifest.documents[idx];
      const filePath = path.join(CATEGORY_DIRS[doc.category], doc.filename);
      const textPath = path.join(CATEGORY_DIRS[doc.category], `${doc.id}.txt`);

      try { await fs.unlink(filePath); } catch {}
      try { await fs.unlink(textPath); } catch {}

      manifest.documents.splice(idx, 1);
      await saveManifest(manifest);

      // Remove from RAG index
      try { await removeDocument(doc.id); } catch {}

      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
};
