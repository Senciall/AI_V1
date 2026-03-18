const { ollamaChat } = require('../ollama');
const { buildMetadataPrompt } = require('./prompt');

/**
 * Extract structured metadata from document text using Ollama.
 * Returns parsed metadata object or null on failure.
 */
async function extractMetadata(text, filename, model) {
  const llmModel = model || 'gemma3:latest';
  const messages = buildMetadataPrompt(text, filename);

  try {
    const result = await ollamaChat(llmModel, messages, {
      temperature: 0.05,  // near-deterministic for structured output
      num_ctx: 8192,
    });

    const response = result.message?.content || '';
    return parseMetadataResponse(response);
  } catch (err) {
    console.error(`[RAG] Metadata extraction failed for ${filename}:`, err.message);
    return null;
  }
}

/**
 * Parse the LLM response to extract JSON from <metadata_json> tags.
 * Falls back to regex JSON extraction if tags are missing.
 */
function parseMetadataResponse(response) {
  // Try extracting from <metadata_json> tags first
  const tagMatch = response.match(/<metadata_json>\s*([\s\S]*?)\s*<\/metadata_json>/);
  if (tagMatch) {
    try {
      return JSON.parse(tagMatch[1].trim());
    } catch (e) {
      console.error('[RAG] Failed to parse metadata JSON from tags:', e.message);
    }
  }

  // Fallback: find the first valid JSON object in the response
  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch (e) {
      console.error('[RAG] Failed to parse fallback JSON:', e.message);
    }
  }

  console.error('[RAG] No valid JSON found in metadata response');
  return null;
}

/**
 * Validate and normalize metadata, filling defaults for missing fields.
 */
function normalizeMetadata(meta) {
  if (!meta) return null;

  return {
    primary_topic: meta.primary_topic || 'unknown',
    document_type: meta.document_type || 'other',
    technical_depth: Math.max(0, Math.min(1, parseFloat(meta.technical_depth) || 0.5)),
    key_entities: Array.isArray(meta.key_entities) ? meta.key_entities : [],
    summary: meta.summary || '',
    priority_weight: Math.max(1, Math.min(10, parseInt(meta.priority_weight) || 5)),
    context_tags: Array.isArray(meta.context_tags) ? meta.context_tags.slice(0, 5) : [],
    language_complexity: ['simple', 'moderate', 'technical', 'academic'].includes(meta.language_complexity)
      ? meta.language_complexity : 'moderate',
    suggested_chunk_size: [256, 512, 1024, 2048].includes(meta.suggested_chunk_size)
      ? meta.suggested_chunk_size : 512,
  };
}

module.exports = { extractMetadata, parseMetadataResponse, normalizeMetadata };
