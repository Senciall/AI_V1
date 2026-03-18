const fs = require('fs').promises;
const path = require('path');
const { extractMetadata, normalizeMetadata } = require('../rag/metadata-agent');
const { indexDocument, removeDocument, search, getIndexedDocs, EMBED_MODEL } = require('../rag/vector-store');
const { loadManifest } = require('../data');
const { DOCS_PDFS, DOCS_IMAGES, DOCS_SPREADSHEETS, DOCS_OTHER } = require('../paths');

const CATEGORY_DIRS = {
  pdfs: DOCS_PDFS,
  images: DOCS_IMAGES,
  spreadsheets: DOCS_SPREADSHEETS,
  other: DOCS_OTHER,
};

async function getDocText(doc) {
  const textPath = path.join(CATEGORY_DIRS[doc.category], `${doc.id}.txt`);
  try {
    return await fs.readFile(textPath, 'utf-8');
  } catch {
    return null;
  }
}

module.exports = function (app) {

  // ═══ SEARCH ═══

  // Semantic search across all indexed documents
  app.get('/api/rag/search', async (req, res) => {
    try {
      const { q, top_k, threshold, weighted } = req.query;
      if (!q || !q.trim()) return res.status(400).json({ error: 'Query parameter "q" is required' });

      const results = await search(q, {
        topK: parseInt(top_k) || 5,
        threshold: parseFloat(threshold) || 0.3,
        useWeighting: weighted !== 'false',
      });

      // Enrich results with document names from manifest
      const manifest = await loadManifest();
      const enriched = results.map(r => {
        const doc = manifest.documents.find(d => d.id === r.docId);
        return {
          ...r,
          documentName: doc?.originalName || 'unknown',
          embedding: undefined, // don't send embeddings to client
        };
      });

      res.json({ query: q, results: enriched, total: enriched.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ═══ INDEXING ═══

  // Index a specific document by ID
  app.post('/api/rag/index/:docId', async (req, res) => {
    try {
      const manifest = await loadManifest();
      const doc = manifest.documents.find(d => d.id === req.params.docId);
      if (!doc) return res.status(404).json({ error: 'Document not found' });

      const text = await getDocText(doc);
      if (!text) return res.status(400).json({ error: 'No extracted text available for this document' });

      // Extract metadata using LLM
      const model = req.body?.model || 'gemma3:latest';
      const rawMeta = await extractMetadata(text, doc.originalName, model);
      const metadata = normalizeMetadata(rawMeta);

      // Index with embeddings
      const result = await indexDocument(doc.id, text, metadata);

      res.json({
        ...result,
        metadata,
        documentName: doc.originalName,
        embeddingModel: EMBED_MODEL,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Index ALL documents that have extracted text
  app.post('/api/rag/index-all', async (req, res) => {
    try {
      const manifest = await loadManifest();
      const model = req.body?.model || 'gemma3:latest';
      const results = [];
      const errors = [];

      for (const doc of manifest.documents) {
        if (!doc.hasText) continue;

        try {
          const text = await getDocText(doc);
          if (!text) continue;

          const rawMeta = await extractMetadata(text, doc.originalName, model);
          const metadata = normalizeMetadata(rawMeta);
          const result = await indexDocument(doc.id, text, metadata);
          results.push({ ...result, documentName: doc.originalName, metadata });
        } catch (err) {
          errors.push({ docId: doc.id, name: doc.originalName, error: err.message });
        }
      }

      res.json({ indexed: results.length, errors: errors.length, results, errors });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Index all documents in a specific folder
  app.post('/api/rag/index-folder/:folderId', async (req, res) => {
    try {
      const manifest = await loadManifest();
      const folderId = req.params.folderId;
      const model = req.body?.model || 'gemma3:latest';

      // Get all folder IDs (this folder + descendants)
      const allFolderIds = [folderId];
      function collectChildren(parentId) {
        (manifest.folders || []).filter(f => f.parent === parentId).forEach(f => {
          allFolderIds.push(f.id);
          collectChildren(f.id);
        });
      }
      collectChildren(folderId);

      const docsInFolder = manifest.documents.filter(d => d.hasText && allFolderIds.includes(d.folder));
      const results = [];
      const errors = [];

      for (const doc of docsInFolder) {
        try {
          const text = await getDocText(doc);
          if (!text) continue;
          const rawMeta = await extractMetadata(text, doc.originalName, model);
          const metadata = normalizeMetadata(rawMeta);
          const result = await indexDocument(doc.id, text, metadata);
          results.push({ ...result, documentName: doc.originalName, metadata });
        } catch (err) {
          errors.push({ docId: doc.id, name: doc.originalName, error: err.message });
        }
      }

      res.json({ folderId, indexed: results.length, errors: errors.length, results, errors });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Remove a document from the RAG index
  app.delete('/api/rag/index/:docId', async (req, res) => {
    try {
      const result = await removeDocument(req.params.docId);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ═══ METADATA ═══

  // Get metadata for a specific indexed document
  app.get('/api/rag/metadata/:docId', async (req, res) => {
    try {
      const docs = await getIndexedDocs();
      const doc = docs.find(d => d.docId === req.params.docId);
      if (!doc) return res.status(404).json({ error: 'Document not indexed' });
      res.json(doc);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // List all indexed documents
  app.get('/api/rag/index', async (req, res) => {
    try {
      const docs = await getIndexedDocs();
      res.json({ documents: docs, total: docs.length, embeddingModel: EMBED_MODEL });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ═══ RAG-AUGMENTED CHAT CONTEXT ═══

  // Get relevant context for a query (used by chat to inject context)
  app.get('/api/rag/context', async (req, res) => {
    try {
      const { q, top_k } = req.query;
      if (!q) return res.status(400).json({ error: 'Query parameter "q" required' });

      const results = await search(q, { topK: parseInt(top_k) || 3, threshold: 0.35 });

      // Build context string for LLM injection
      const manifest = await loadManifest();
      const contextBlocks = results.map(r => {
        const doc = manifest.documents.find(d => d.id === r.docId);
        const name = doc?.originalName || 'unknown';
        return `[Source: ${name} | Relevance: ${(r.weightedScore * 100).toFixed(1)}%]\n${r.chunkText}`;
      });

      res.json({
        context: contextBlocks.join('\n\n---\n\n'),
        sources: results.map(r => ({
          docId: r.docId,
          documentName: manifest.documents.find(d => d.id === r.docId)?.originalName,
          score: r.weightedScore,
        })),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
};
