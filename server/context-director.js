const http = require('http');
const { OLLAMA_BASE, ollamaChat } = require('./ollama');

const SMALL_MODEL_PREFERENCE = [
  'qwen2.5:0.5b', 'llama3.2:1b', 'gemma2:2b', 'phi3:mini',
  'phi3:latest', 'qwen2.5:1.5b', 'gemma3:1b', 'llama3.2:3b', 'gemma3:4b'
];

let _cachedSmallModel = null;

async function getSmallModel() {
  if (_cachedSmallModel) return _cachedSmallModel;
  return new Promise((resolve) => {
    http.get(`${OLLAMA_BASE}/api/tags`, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const { models } = JSON.parse(data);
          if (!models || !models.length) { resolve(null); return; }
          for (const pref of SMALL_MODEL_PREFERENCE) {
            if (models.find(m => m.name === pref)) {
              _cachedSmallModel = pref; resolve(pref); return;
            }
          }
          // Fall back to smallest by size
          const sorted = [...models].sort((a, b) => (a.size || 0) - (b.size || 0));
          _cachedSmallModel = sorted[0].name;
          resolve(_cachedSmallModel);
        } catch { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

async function warmUpSmallModel() {
  const model = await getSmallModel();
  if (!model) { console.log('[context-director] No small model found, skipping warm-up'); return; }
  console.log(`[context-director] Warming up ${model} with keep_alive: -1`);
  try {
    await ollamaChat(model, [{ role: 'user', content: 'Hi' }], { keep_alive: -1, num_ctx: 512 });
    console.log(`[context-director] ${model} loaded into VRAM permanently`);
  } catch (err) {
    console.warn(`[context-director] Warm-up failed: ${err.message}`);
  }
}

function startKeepAlive() {
  setInterval(async () => {
    const model = await getSmallModel();
    if (!model) return;
    try {
      await ollamaChat(model, [{ role: 'user', content: '.' }], { keep_alive: -1, num_ctx: 128 });
    } catch (err) {
      console.warn(`[context-director] Keep-alive ping failed: ${err.message}`);
    }
  }, 5 * 60 * 1000);
}

const CONTEXT_DIRECTOR_PROMPT = `You are a context analysis engine. Return ONLY a JSON object — no explanation, no markdown.

Analyze the conversation and new query. Determine:
1. What is the active topic being discussed?
2. What is the user ACTUALLY asking (resolve pronouns/implicit refs from context)?
3. Does this require a location/places search? (physical businesses, restaurants, venues)
4. Does this require a web search? (facts, news, current info)

Rules:
- If user says "places", "where to", "somewhere to", "nearby" but doesn't specify a type, infer type from recent messages.
- Example: conversation about sushi + "where are some places" → locationSearchQuery: "sushi restaurants"
- needsLocationSearch = true only for physical places the user might visit.
- needsWebSearch = true only for factual/current information, NOT general conversation.

Output format (exactly):
{"topic":"...","expandedQuery":"...","needsLocationSearch":false,"locationSearchQuery":null,"needsWebSearch":false,"webSearchQuery":null}`;

async function analyzeContext(messages, query, userLocation) {
  const model = await getSmallModel();
  if (!model) return null;
  // Hard 5s timeout so a slow small model never blocks the main chat
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('context-director timeout')), 5000));

  const recent = messages.slice(-5);
  const conversationText = recent.map(m =>
    `${m.role === 'user' ? 'User' : 'Assistant'}: ${
      typeof m.content === 'string' ? m.content.substring(0, 300) : ''
    }`
  ).join('\n');

  const userMsg = userLocation
    ? `Conversation:\n${conversationText}\n\nNew query: "${query}"\nUser location: ${userLocation}`
    : `Conversation:\n${conversationText}\n\nNew query: "${query}"`;

  try {
    const result = await Promise.race([
      ollamaChat(model,
        [{ role: 'system', content: CONTEXT_DIRECTOR_PROMPT }, { role: 'user', content: userMsg }],
        { keep_alive: -1, temperature: 0.1, num_ctx: 2048 }
      ),
      timeout
    ]);
    let text = (result.message?.content || '').replace(/```json?\s*/gi, '').replace(/```/g, '').trim();
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    if (typeof parsed.needsLocationSearch !== 'boolean') return null;
    return parsed;
  } catch (err) {
    console.warn('[context-director] analyzeContext failed:', err.message);
    return null;
  }
}

module.exports = { getSmallModel, warmUpSmallModel, startKeepAlive, analyzeContext };
