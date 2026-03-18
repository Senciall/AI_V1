// Refined metadata extraction prompt for RAG indexing
// Improvements over Gemini's template:
// - technical_depth anchored to concrete calibration examples (not subjective)
// - priority_weight has explicit grounding criteria
// - language_complexity added for readability-aware retrieval
// - chunk_strategy hint for downstream chunking decisions

const METADATA_PROMPT = `<role>
You are the File Intelligence Agent for a RAG (Retrieval-Augmented Generation) system.
Your job: analyze the document and produce a structured JSON metadata fingerprint.
</role>

<instructions>
1. Read the document inside <document_content> tags carefully.
2. Inside <analysis> tags, think step-by-step:
   - What is the core subject and intent?
   - What is the technical depth? (see calibration below)
   - What specific entities appear (names, versions, dates, technologies)?
   - How authoritative is this document? (see priority criteria below)
3. Output a single valid JSON object inside <metadata_json> tags using the schema below.
4. Output ONLY valid JSON inside the metadata_json tags — no comments, no trailing commas.
</instructions>

<schema>
{
  "primary_topic": "string — the core subject matter in 3-8 words",
  "document_type": "string — one of: source_code, documentation, tutorial, legal_contract, internal_memo, research_paper, configuration, data_file, correspondence, specification, report, notes, other",
  "technical_depth": "float 0.0-1.0 — calibrated as follows:
    0.0-0.2: General audience, no domain knowledge needed (blog post, FAQ)
    0.2-0.4: Some familiarity assumed (README, onboarding doc)
    0.4-0.6: Practitioner-level (API docs, design doc)
    0.6-0.8: Deep implementation detail (source code, architecture spec)
    0.8-1.0: Research/expert-level (papers, proofs, low-level internals)",
  "key_entities": ["array of specific technologies, people, organizations, versions, or proper nouns found in the document"],
  "summary": "string — exactly 2 sentences: (1) What this document IS, (2) What problem it addresses or why it exists",
  "priority_weight": "integer 1-10 — grounded criteria:
    1-2: Ephemeral/low-signal (chat logs, scratch notes, temp files)
    3-4: Supporting material (meeting notes, informal docs)
    5-6: Standard working documents (design docs, tickets, READMEs)
    7-8: Authoritative reference (official docs, specs, tested code)
    9-10: Source of truth (schemas, contracts, compliance docs, canonical implementations)",
  "context_tags": ["3-5 keyword strings optimized for hybrid keyword+vector search"],
  "language_complexity": "string — one of: simple, moderate, technical, academic",
  "suggested_chunk_size": "integer — recommended token count per chunk for this document type (256, 512, 1024, or 2048)"
}
</schema>

<document_content>
{{CONTENT}}
</document_content>`;

function buildMetadataPrompt(content, filename) {
  // Truncate to ~6000 chars to stay within reasonable context for local models
  const maxLen = 6000;
  const truncated = content.length > maxLen
    ? content.slice(0, maxLen) + '\n\n[... truncated for metadata extraction ...]'
    : content;

  const prompt = METADATA_PROMPT.replace('{{CONTENT}}', truncated);

  return [
    {
      role: 'system',
      content: 'You are a precise metadata extraction agent. Always respond with <analysis> thinking first, then <metadata_json> containing valid JSON. Never add text outside these tags.'
    },
    {
      role: 'user',
      content: `Analyze this file (${filename}):\n\n${prompt}`
    }
  ];
}

module.exports = { METADATA_PROMPT, buildMetadataPrompt };
