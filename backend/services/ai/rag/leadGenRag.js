/**
 * RAG for lead-gen / discovery prompts: embed corpus with Gemini embedding API
 * (default model gemini-embedding-001 — override with GEMINI_EMBEDDING_MODEL),
 * retrieve top chunks by cosine similarity to the user query, inject as context.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { TaskType } = require('@google/generative-ai');
const logger = require('../../../utils/logger');
const { isAIAvailable, getEmbeddingModel, getEmbeddingModelName } = require('../geminiClient');
const { retryWithBackoff } = require('../../../utils/aiRetry');
const scaleLimits = require('../../../config/scaleLimits');

/** Bundled with source so Docker/git deploy includes it (backend/data/ is often gitignored). */
const CORPUS_PATH = path.join(__dirname, 'corpus.jsonl');
const CACHE_PATH = path.join(__dirname, 'embeddings-cache.json');

function isRagEnabled() {
  return process.env.RAG_ENABLED !== 'false' && process.env.RAG_ENABLED !== '0';
}

function sha256(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function loadCorpusChunks() {
  if (!fs.existsSync(CORPUS_PATH)) {
    logger.warn(`[RAG] Corpus missing at ${CORPUS_PATH}`);
    return [];
  }
  const raw = fs.readFileSync(CORPUS_PATH, 'utf8');
  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const chunks = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      const o = JSON.parse(lines[i]);
      const text = String(o.text || '').trim();
      if (!text) continue;
      chunks.push({
        id: String(o.id || `chunk_${i}`).slice(0, 128),
        text: text.slice(0, 8000)
      });
    } catch (e) {
      logger.warn(`[RAG] Bad corpus line ${i + 1}: ${e.message}`);
    }
  }
  return chunks;
}

function cosineSim(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d > 0 ? dot / d : 0;
}

async function embedOneDocument(model, text) {
  const res = await model.embedContent({
    content: { parts: [{ text }] },
    taskType: TaskType.RETRIEVAL_DOCUMENT
  });
  const v = res.embedding?.values;
  if (!v || !v.length) throw new Error('empty document embedding');
  return [...v];
}

async function embedAllDocuments(chunks) {
  const model = getEmbeddingModel();
  try {
    const requests = chunks.map(c => ({
      content: { parts: [{ text: c.text }] },
      taskType: TaskType.RETRIEVAL_DOCUMENT
    }));
    const res = await retryWithBackoff(
      () => model.batchEmbedContents({ requests }),
      { maxRetries: scaleLimits.gemini.maxRetries, baseMs: scaleLimits.gemini.retryBaseMs }
    );
    const list = res.embeddings || [];
    if (list.length === chunks.length) {
      return list.map((e, i) => {
        const v = e?.values;
        if (!v || !v.length) throw new Error(`batch embedding missing at ${i}`);
        return [...v];
      });
    }
    logger.warn('[RAG] batchEmbedContents length mismatch; falling back to sequential embeds');
  } catch (e) {
    logger.warn(`[RAG] batchEmbedContents failed: ${e.message} — sequential fallback`);
  }

  const out = [];
  const modelSeq = getEmbeddingModel();
  for (let i = 0; i < chunks.length; i++) {
    const v = await retryWithBackoff(
      () => embedOneDocument(modelSeq, chunks[i].text),
      { maxRetries: scaleLimits.gemini.maxRetries, baseMs: scaleLimits.gemini.retryBaseMs }
    );
    out.push(v);
    if ((i + 1) % 10 === 0) {
      logger.info(`[RAG] Embedded ${i + 1}/${chunks.length} chunks`);
    }
  }
  return out;
}

async function embedQueryVector(text) {
  const model = getEmbeddingModel();
  const res = await retryWithBackoff(
    () =>
      model.embedContent({
        content: { parts: [{ text: String(text || '').slice(0, 8000) }] },
        taskType: TaskType.RETRIEVAL_QUERY
      }),
    { maxRetries: scaleLimits.gemini.maxRetries, baseMs: scaleLimits.gemini.retryBaseMs }
  );
  const v = res.embedding?.values;
  if (!v || !v.length) throw new Error('empty query embedding');
  return v;
}

function readCache(expectedHash, chunkCount) {
  try {
    if (!fs.existsSync(CACHE_PATH)) return null;
    const j = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    if (j.hash !== expectedHash || !Array.isArray(j.vectors) || j.vectors.length !== chunkCount) {
      return null;
    }
    return j.vectors.map(row => {
      const v = row.values || row;
      return Array.isArray(v) ? v.map(Number) : null;
    });
  } catch {
    return null;
  }
}

function writeCache(hash, vectors) {
  try {
    const dir = path.dirname(CACHE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      CACHE_PATH,
      JSON.stringify({ hash, vectors: vectors.map(values => ({ values })) }),
      'utf8'
    );
  } catch (e) {
    logger.warn(`[RAG] Could not write embedding cache: ${e.message}`);
  }
}

let _chunks = null;
let _hash = null;
/** @type {number[][]|null} */
let _vectors = null;
let _initPromise = null;

async function ensureIndex() {
  if (!isRagEnabled()) return;
  if (_vectors && _chunks) return;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    const chunks = loadCorpusChunks();
    if (!chunks.length) {
      logger.info('[RAG] Empty corpus — skipping RAG');
      return;
    }
    const h = sha256(`${getEmbeddingModelName()}\n${chunks.map(c => c.text).join('\n---\n')}`);
    let vectors = readCache(h, chunks.length);

    if (!vectors && isAIAvailable()) {
      logger.info(`[RAG] Building embeddings for ${chunks.length} chunks (hash ${h.slice(0, 12)}…)`);
      vectors = await embedAllDocuments(chunks);
      writeCache(h, vectors);
    } else if (vectors) {
      logger.info(`[RAG] Loaded ${chunks.length} cached embeddings`);
    } else {
      logger.warn('[RAG] No embeddings and GEMINI_API_KEY missing — RAG off');
      return;
    }

    _chunks = chunks;
    _hash = h;
    _vectors = vectors;
  })();

  try {
    await _initPromise;
  } finally {
    _initPromise = null;
  }
}

/**
 * @param {string} queryText
 * @param {{ topK?: number, maxChars?: number }} [opts]
 * @returns {Promise<string>} Formatted passages for prompts (or empty)
 */
async function retrieveLeadGenContext(queryText, opts = {}) {
  if (!isRagEnabled()) return '';
  const q = String(queryText || '').trim();
  if (q.length < 4) return '';

  const topK = Math.min(
    12,
    Math.max(1, opts.topK != null ? opts.topK : parseInt(process.env.RAG_TOP_K, 10) || 5)
  );
  const maxChars = opts.maxChars != null ? opts.maxChars : 4500;

  try {
    await ensureIndex();
    if (!_chunks || !_vectors || !_chunks.length) return '';
    if (!isAIAvailable()) return '';

    const qv = await embedQueryVector(q);
    const scored = _chunks
      .map((c, i) => ({
        chunk: c,
        score: cosineSim(qv, _vectors[i])
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    let out = '';
    for (const s of scored) {
      const block = `[${s.chunk.id}]\n${s.chunk.text}`;
      if (out.length + block.length + 2 > maxChars) break;
      out += (out ? '\n\n' : '') + block;
    }
    logger.debug(`[RAG] top score ${scored[0]?.score?.toFixed(3) ?? 'n/a'}, ${scored.length} chunks`);
    return out;
  } catch (e) {
    logger.warn(`[RAG] retrieve failed: ${e.message}`);
    return '';
  }
}

module.exports = {
  isRagEnabled,
  retrieveLeadGenContext,
  ensureIndex
};
