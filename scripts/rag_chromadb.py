"""
RAG Post-Processing Script: ChromaDB Integration

Reads documents from MyAI's user_data directory, extracts metadata via Ollama,
generates embeddings, and pushes everything into ChromaDB for production-grade
vector search.

Usage:
    pip install chromadb requests
    python scripts/rag_chromadb.py [--reset] [--host localhost] [--port 8000]

Options:
    --reset     Clear and rebuild the entire collection
    --host      ChromaDB server host (default: localhost, or uses local persistent storage)
    --port      ChromaDB server port (default: 8000)
    --local     Use local persistent ChromaDB (no server needed)
    --model     Ollama model for metadata extraction (default: gemma3:latest)
"""

import json
import os
import sys
import argparse
import requests
from pathlib import Path

# ─── Config ───

OLLAMA_BASE = "http://127.0.0.1:11434"
EMBED_MODEL = "nomic-embed-text"
COLLECTION_NAME = "myai_documents"

SCRIPT_DIR = Path(__file__).parent
PROJECT_ROOT = SCRIPT_DIR.parent
USER_DATA = PROJECT_ROOT / "user_data"
DOCUMENTS_DIR = USER_DATA / "documents"
MANIFEST_FILE = DOCUMENTS_DIR / "manifest.json"

CATEGORY_DIRS = {
    "pdfs": DOCUMENTS_DIR / "pdfs",
    "images": DOCUMENTS_DIR / "images",
    "spreadsheets": DOCUMENTS_DIR / "spreadsheets",
    "other": DOCUMENTS_DIR / "other",
}

# ─── Metadata Extraction Prompt ───

METADATA_PROMPT = """<role>
You are the File Intelligence Agent for a RAG system.
Analyze the document and produce a structured JSON metadata fingerprint.
</role>

<instructions>
1. Read the document inside <document_content> tags.
2. Inside <analysis> tags, think step-by-step about the document.
3. Output valid JSON inside <metadata_json> tags using this schema:
   - primary_topic (string): core subject in 3-8 words
   - document_type (string): source_code|documentation|tutorial|legal_contract|internal_memo|research_paper|configuration|data_file|correspondence|specification|report|notes|other
   - technical_depth (float 0.0-1.0): 0.0-0.2 general, 0.2-0.4 familiar, 0.4-0.6 practitioner, 0.6-0.8 deep implementation, 0.8-1.0 expert/research
   - key_entities (array): technologies, people, organizations, versions
   - summary (string): exactly 2 sentences
   - priority_weight (int 1-10): 1-2 ephemeral, 3-4 supporting, 5-6 standard, 7-8 authoritative, 9-10 source of truth
   - context_tags (array): 3-5 keywords for hybrid search
</instructions>

<document_content>
{content}
</document_content>"""


# ─── Ollama Helpers ───

def ollama_chat(prompt: str, model: str = "gemma3:latest") -> str:
    """Send a chat request to Ollama and return the response text."""
    resp = requests.post(f"{OLLAMA_BASE}/api/chat", json={
        "model": model,
        "messages": [
            {"role": "system", "content": "You are a metadata extraction agent. Respond with <analysis> then <metadata_json> containing valid JSON."},
            {"role": "user", "content": prompt},
        ],
        "stream": False,
        "options": {"temperature": 0.05, "num_ctx": 8192},
    }, timeout=180)
    resp.raise_for_status()
    return resp.json()["message"]["content"]


def ollama_embed(text: str) -> list[float]:
    """Get an embedding vector from Ollama."""
    resp = requests.post(f"{OLLAMA_BASE}/api/embed", json={
        "model": EMBED_MODEL,
        "input": text,
    }, timeout=60)
    resp.raise_for_status()
    data = resp.json()
    return data["embeddings"][0]


def extract_metadata(text: str, filename: str, model: str) -> dict | None:
    """Extract structured metadata from document text via Ollama."""
    truncated = text[:6000]
    prompt = METADATA_PROMPT.format(content=truncated)
    prompt = f"Analyze this file ({filename}):\n\n{prompt}"

    try:
        response = ollama_chat(prompt, model)
        return parse_metadata(response)
    except Exception as e:
        print(f"  [WARN] Metadata extraction failed: {e}")
        return None


def parse_metadata(response: str) -> dict | None:
    """Parse JSON from <metadata_json> tags or fallback to regex."""
    import re

    # Try tag extraction
    match = re.search(r"<metadata_json>\s*(.*?)\s*</metadata_json>", response, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(1).strip())
        except json.JSONDecodeError:
            pass

    # Fallback: find first JSON object
    match = re.search(r"\{.*\}", response, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(0))
        except json.JSONDecodeError:
            pass

    return None


# ─── Chunking ───

def chunk_text(text: str, chunk_size: int = 512, overlap: int = 64) -> list[str]:
    """Split text into overlapping word-based chunks."""
    words = text.split()
    words_per_chunk = int(chunk_size * 0.75)
    overlap_words = int(overlap * 0.75)
    chunks = []

    i = 0
    while i < len(words):
        chunk = " ".join(words[i:i + words_per_chunk])
        if chunk.strip():
            chunks.append(chunk.strip())
        i += words_per_chunk - overlap_words
        if i + words_per_chunk >= len(words) and i < len(words):
            last = " ".join(words[i:])
            if last.strip():
                chunks.append(last.strip())
            break

    return chunks if chunks else [text.strip()]


# ─── Main Pipeline ───

def load_manifest() -> dict:
    """Load the document manifest."""
    if not MANIFEST_FILE.exists():
        return {"documents": []}
    return json.loads(MANIFEST_FILE.read_text(encoding="utf-8"))


def get_doc_text(doc: dict) -> str | None:
    """Read extracted text file for a document."""
    cat_dir = CATEGORY_DIRS.get(doc["category"])
    if not cat_dir:
        return None
    text_path = cat_dir / f"{doc['id']}.txt"
    if text_path.exists():
        return text_path.read_text(encoding="utf-8")
    return None


def run(args):
    """Main pipeline: extract metadata, embed, push to ChromaDB."""
    import chromadb

    # Initialize ChromaDB
    if args.local:
        chroma_path = str(USER_DATA / "chromadb")
        client = chromadb.PersistentClient(path=chroma_path)
        print(f"Using local ChromaDB at {chroma_path}")
    else:
        client = chromadb.HttpClient(host=args.host, port=args.port)
        print(f"Connecting to ChromaDB at {args.host}:{args.port}")

    # Get or create collection
    if args.reset:
        try:
            client.delete_collection(COLLECTION_NAME)
            print(f"Deleted existing collection '{COLLECTION_NAME}'")
        except Exception:
            pass

    collection = client.get_or_create_collection(
        name=COLLECTION_NAME,
        metadata={"description": "MyAI document store with semantic metadata"},
    )
    print(f"Collection '{COLLECTION_NAME}' ready ({collection.count()} existing entries)")

    # Load documents
    manifest = load_manifest()
    docs = [d for d in manifest.get("documents", []) if d.get("hasText")]
    print(f"\nFound {len(docs)} documents with extracted text\n")

    total_chunks = 0
    errors = 0

    for i, doc in enumerate(docs, 1):
        name = doc["originalName"]
        print(f"[{i}/{len(docs)}] {name}")

        text = get_doc_text(doc)
        if not text:
            print("  [SKIP] No text file found")
            continue

        # Extract metadata
        meta = extract_metadata(text, name, args.model)
        if meta is None:
            meta = {
                "primary_topic": "unknown",
                "document_type": "other",
                "technical_depth": 0.5,
                "priority_weight": 5,
                "context_tags": [],
            }
            print("  [WARN] Using default metadata")

        # Chunk and embed
        chunk_size = meta.get("suggested_chunk_size", 512)
        chunks = chunk_text(text, chunk_size)
        print(f"  Chunks: {len(chunks)} | Type: {meta.get('document_type', '?')} | Priority: {meta.get('priority_weight', '?')}")

        # Prepare batch for ChromaDB
        ids = []
        embeddings = []
        documents = []
        metadatas = []

        for j, chunk in enumerate(chunks):
            try:
                embedding = ollama_embed(chunk)
                ids.append(f"{doc['id']}_chunk_{j}")
                embeddings.append(embedding)
                documents.append(chunk[:500])  # ChromaDB stores the text too
                metadatas.append({
                    "doc_id": doc["id"],
                    "doc_name": name,
                    "chunk_index": j,
                    "primary_topic": str(meta.get("primary_topic", "")),
                    "document_type": str(meta.get("document_type", "")),
                    "technical_depth": float(meta.get("technical_depth", 0.5)),
                    "priority_weight": int(meta.get("priority_weight", 5)),
                    "context_tags": ",".join(meta.get("context_tags", [])),
                    "summary": str(meta.get("summary", "")),
                })
            except Exception as e:
                print(f"  [ERROR] Chunk {j}: {e}")
                errors += 1

        # Upsert batch
        if ids:
            collection.upsert(
                ids=ids,
                embeddings=embeddings,
                documents=documents,
                metadatas=metadatas,
            )
            total_chunks += len(ids)
            print(f"  Indexed {len(ids)} chunks")

    print(f"\n{'='*50}")
    print(f"Done! {total_chunks} total chunks indexed, {errors} errors")
    print(f"Collection now has {collection.count()} entries")

    # Example search
    if total_chunks > 0:
        print(f"\n--- Example Search ---")
        query = "main topic of the documents"
        query_emb = ollama_embed(query)
        results = collection.query(
            query_embeddings=[query_emb],
            n_results=3,
        )
        for doc_text, meta, dist in zip(
            results["documents"][0],
            results["metadatas"][0],
            results["distances"][0],
        ):
            print(f"  [{meta['doc_name']}] (distance: {dist:.4f})")
            print(f"    {doc_text[:100]}...")


def search_interactive(args):
    """Interactive search mode against ChromaDB."""
    import chromadb

    if args.local:
        client = chromadb.PersistentClient(path=str(USER_DATA / "chromadb"))
    else:
        client = chromadb.HttpClient(host=args.host, port=args.port)

    collection = client.get_collection(COLLECTION_NAME)
    print(f"Collection has {collection.count()} entries. Type 'quit' to exit.\n")

    while True:
        query = input("Search> ").strip()
        if query.lower() in ("quit", "exit", "q"):
            break
        if not query:
            continue

        query_emb = ollama_embed(query)
        results = collection.query(
            query_embeddings=[query_emb],
            n_results=5,
            where={"priority_weight": {"$gte": args.min_priority}} if args.min_priority > 1 else None,
        )

        if not results["documents"][0]:
            print("  No results found.\n")
            continue

        for i, (doc_text, meta, dist) in enumerate(zip(
            results["documents"][0],
            results["metadatas"][0],
            results["distances"][0],
        ), 1):
            score = max(0, 1 - dist)  # Convert distance to similarity
            weighted = score * (meta.get("priority_weight", 5) / 10)
            print(f"\n  #{i} [{meta['doc_name']}] chunk {meta['chunk_index']}")
            print(f"      Similarity: {score:.3f} | Weighted: {weighted:.3f} | Priority: {meta['priority_weight']}")
            print(f"      Type: {meta['document_type']} | Topic: {meta['primary_topic']}")
            print(f"      {doc_text[:200]}...")
        print()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="RAG Pipeline: Index documents into ChromaDB")
    sub = parser.add_subparsers(dest="command", help="Command to run")

    # Index command
    idx = sub.add_parser("index", help="Index all documents into ChromaDB")
    idx.add_argument("--reset", action="store_true", help="Clear and rebuild the collection")
    idx.add_argument("--host", default="localhost", help="ChromaDB host")
    idx.add_argument("--port", type=int, default=8000, help="ChromaDB port")
    idx.add_argument("--local", action="store_true", help="Use local persistent ChromaDB")
    idx.add_argument("--model", default="gemma3:latest", help="Ollama model for metadata")

    # Search command
    srch = sub.add_parser("search", help="Interactive search")
    srch.add_argument("--host", default="localhost", help="ChromaDB host")
    srch.add_argument("--port", type=int, default=8000, help="ChromaDB port")
    srch.add_argument("--local", action="store_true", help="Use local persistent ChromaDB")
    srch.add_argument("--min-priority", type=int, default=1, help="Minimum priority weight filter")

    args = parser.parse_args()

    if args.command == "index":
        run(args)
    elif args.command == "search":
        search_interactive(args)
    else:
        parser.print_help()
        print("\nExamples:")
        print("  python scripts/rag_chromadb.py index --local")
        print("  python scripts/rag_chromadb.py index --local --reset")
        print("  python scripts/rag_chromadb.py search --local")
