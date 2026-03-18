const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const http = require('http');
const { OLLAMA_BASE } = require('../ollama');

// Storage paths
const RAG_DIR = path.join(__dirname, '..', '..', 'user_data', 'rag');
const INDEX_FILE = path.join(RAG_DIR, 'vector-index.json');
const EMBED_MODEL = 'nomic-embed-text';

// Ensure RAG directory exists
if (!fsSync.existsSync(RAG_DIR)) fsSync.mkdirSync(RAG_DIR, { recursive: true });

// ─── Embedding via Ollama ───

function getEmbedding(text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: EMBED_MODEL, input: text });
    const req = http.request(`${OLLAMA_BASE}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.embeddings && parsed.embeddings.length > 0) {
            resolve(parsed.embeddings[0]);
          } else {
            reject(new Error('No embeddings returned'));
          }
        } catch { reject(new Error('Bad embedding response')); }
      });
    });
    req.on('error', e => reject(new Error(`Embedding request failed: ${e.message}`)));
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('Embedding timed out')); });
    req.write(body);
    req.end();
  });
}

// ─── Vector Math ───

function cosineSimilarity(a, b) {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  magA = Math.sqrt(magA);
  magB = Math.sqrt(magB);
  if (magA === 0 || magB === 0) return 0;
  return dot / (magA * magB);
}

// ─── Index Management ───

async function loadIndex() {
  try {
    return JSON.parse(await fs.readFile(INDEX_FILE, 'utf-8'));
  } catch {
    return { entries: [], version: 1 };
  }
}

async function saveIndex(index) {
  await fs.writeFile(INDEX_FILE, JSON.stringify(index));
}

/**
 * Chunk text into segments for embedding.
 * Uses simple paragraph/sentence boundaries.
 */
function chunkText(text, chunkSize = 512, overlap = 64) {
  const words = text.split(/\s+/);
  const chunks = [];

  // Approximate tokens as words (rough 1:1.3 ratio)
  const wordsPerChunk = Math.floor(chunkSize * 0.75);
  const overlapWords = Math.floor(overlap * 0.75);

  for (let i = 0; i < words.length; i += wordsPerChunk - overlapWords) {
    const chunk = words.slice(i, i + wordsPerChunk).join(' ');
    if (chunk.trim()) chunks.push(chunk.trim());
    if (i + wordsPerChunk >= words.length) break;
  }

  return chunks.length > 0 ? chunks : [text.trim()];
}

/**
 * Index a document: chunk it, embed each chunk, store with metadata.
 */
async function indexDocument(docId, text, metadata, chunkSize) {
  const index = await loadIndex();

  // Remove existing entries for this document (re-index)
  index.entries = index.entries.filter(e => e.docId !== docId);

  const chunks = chunkText(text, chunkSize || metadata?.suggested_chunk_size || 512);

  for (let i = 0; i < chunks.length; i++) {
    try {
      const embedding = await getEmbedding(chunks[i]);
      index.entries.push({
        docId,
        chunkIndex: i,
        chunkText: chunks[i].slice(0, 500), // store preview for retrieval
        embedding,
        metadata: metadata || {},
        indexedAt: new Date().toISOString(),
      });
    } catch (err) {
      console.error(`[RAG] Failed to embed chunk ${i} of ${docId}:`, err.message);
    }
  }

  await saveIndex(index);
  return { docId, chunksIndexed: chunks.length };
}

/**
 * Remove a document from the index.
 */
async function removeDocument(docId) {
  const index = await loadIndex();
  const before = index.entries.length;
  index.entries = index.entries.filter(e => e.docId !== docId);
  await saveIndex(index);
  return { removed: before - index.entries.length };
}

/**
 * Semantic search: embed the query, find closest chunks.
 * Uses weighted scoring: Final Score = similarity * (priority_weight / 10)
 */
async function search(query, options = {}) {
  const { topK = 5, threshold = 0.3, useWeighting = true } = options;

  const queryEmbedding = await getEmbedding(query);
  const index = await loadIndex();

  if (index.entries.length === 0) return [];

  const scored = index.entries.map(entry => {
    const similarity = cosineSimilarity(queryEmbedding, entry.embedding);
    const weight = useWeighting ? (entry.metadata?.priority_weight || 5) / 10 : 1;
    return {
      docId: entry.docId,
      chunkIndex: entry.chunkIndex,
      chunkText: entry.chunkText,
      similarity,
      weightedScore: similarity * weight,
      metadata: entry.metadata,
    };
  });

  return scored
    .filter(s => s.similarity >= threshold)
    .sort((a, b) => b.weightedScore - a.weightedScore)
    .slice(0, topK);
}

/**
 * Get all indexed document IDs.
 */
async function getIndexedDocs() {
  const index = await loadIndex();
  const docIds = [...new Set(index.entries.map(e => e.docId))];
  return docIds.map(id => {
    const entries = index.entries.filter(e => e.docId === id);
    return {
      docId: id,
      chunks: entries.length,
      metadata: entries[0]?.metadata || {},
      indexedAt: entries[0]?.indexedAt,
    };
  });
}

module.exports = {
  getEmbedding,
  cosineSimilarity,
  chunkText,
  indexDocument,
  removeDocument,
  search,
  getIndexedDocs,
  loadIndex,
  EMBED_MODEL,
};
