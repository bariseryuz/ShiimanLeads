/**
 * GEMINI CLIENT — structured JSON vs natural-language (Gemini-app style prose).
 * JSON mode stays on for extraction, discovery, navigation, signal scoring, etc.
 * Prose mode (no JSON mime) + system instruction for summaries and chat-style answers.
 */
const { GoogleGenerativeAI } = require('@google/generative-ai');
const logger = require('../../utils/logger');
const { retryWithBackoff } = require('../../utils/aiRetry');
const scaleLimits = require('../../config/scaleLimits');

const API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
const genAI = API_KEY ? new GoogleGenerativeAI(API_KEY) : null;

// ─────────────────────────────────────────────────────────────────────────────
// Gemini concurrency limiter (prevents 429 storms)
// ─────────────────────────────────────────────────────────────────────────────

class Semaphore {
  /**
   * @param {number} max
   */
  constructor(max) {
    this.max = Math.max(1, Number.isFinite(Number(max)) ? Number(max) : 2);
    this.inFlight = 0;
    /** @type {Array<() => void>} */
    this.queue = [];
  }

  /**
   * @param {{ timeoutMs?: number }} [opts]
   * @returns {Promise<() => void>} release fn
   */
  acquire(opts = {}) {
    const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : 45000;
    if (this.inFlight < this.max) {
      this.inFlight += 1;
      return Promise.resolve(() => this.release());
    }
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              // Remove ourselves from queue if still present.
              const idx = this.queue.indexOf(grant);
              if (idx >= 0) this.queue.splice(idx, 1);
              reject(new Error('AI queue timeout (too many concurrent requests). Please retry.'));
            }, timeoutMs)
          : null;

      const grant = () => {
        if (timer) clearTimeout(timer);
        this.inFlight += 1;
        resolve(() => this.release());
      };

      this.queue.push(grant);
    });
  }

  release() {
    this.inFlight = Math.max(0, this.inFlight - 1);
    const next = this.queue.shift();
    if (next) next();
  }
}

const GEMINI_MAX_CONCURRENT = parseInt(String(process.env.GEMINI_MAX_CONCURRENT || '2'), 10) || 2;
const GEMINI_QUEUE_TIMEOUT_MS =
  parseInt(String(process.env.GEMINI_QUEUE_TIMEOUT_MS || '45000'), 10) || 45000;

const geminiSemaphore = new Semaphore(GEMINI_MAX_CONCURRENT);

function wrapModelWithLimiter(model, meta) {
  if (!model || typeof model.generateContent !== 'function') return model;
  if (model.__shiimanLimited) return model;

  const original = model.generateContent.bind(model);
  model.generateContent = async (...args) => {
    const release = await geminiSemaphore.acquire({ timeoutMs: GEMINI_QUEUE_TIMEOUT_MS });
    try {
      return await original(...args);
    } catch (e) {
      const msg = String(e?.message || e);
      // Add a small amount of context to logs to correlate with 429 bursts.
      logger.warn(`[Gemini] generateContent failed (${meta?.model || 'model'}): ${msg}`);
      throw e;
    } finally {
      release();
    }
  };
  Object.defineProperty(model, '__shiimanLimited', { value: true, enumerable: false });
  return model;
}

/** Cheap + deterministic JSON for scraping, vision, structured pipelines */
const MODEL_JSON = process.env.GEMINI_MODEL_JSON || 'gemini-2.0-flash-lite';
/** Clearer writing for user-facing text (closer to the Gemini app experience) */
const MODEL_PROSE = process.env.GEMINI_MODEL_PROSE || 'gemini-2.0-flash';

/** Gemini API embedding model (NOT Vertex legacy names like text-embedding-004). See https://ai.google.dev/gemini-api/docs/embeddings */
const EMBEDDING_MODEL =
  String(process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-001').trim() || 'gemini-embedding-001';

const PROSE_PURPOSES = new Set(['summarize', 'prose', 'assistant', 'chat']);

const DEFAULT_PROSE_SYSTEM = `You are a helpful AI assistant in the style of Google Gemini.
Write in clear, natural English. Use short paragraphs; use bullet lists only when they improve scanability.
Be direct and accurate. If something is uncertain, say so briefly. Avoid filler, robotic phrasing, and unnecessary jargon.
For business or permit data, stay factual and cite what is in the data rather than inventing contacts or amounts.`;

function proseSystemInstruction() {
  const extra = String(process.env.GEMINI_PROSE_SYSTEM_INSTRUCTION || '').trim();
  return extra ? `${DEFAULT_PROSE_SYSTEM}\n\n${extra}` : DEFAULT_PROSE_SYSTEM;
}

const SAFETY = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' }
];

/**
 * @param {string} purpose - extraction|discovery|navigation|signal|summarize|prose|...
 */
function getGeminiModel(purpose = 'extraction') {
  if (!genAI) {
    logger.error('❌ AI Client: Attempted to call Gemini but API_KEY is missing');
    throw new Error('GEMINI_API_KEY is missing from environment variables');
  }

  const useProse = PROSE_PURPOSES.has(String(purpose || '').toLowerCase());

  if (useProse) {
    const temp = parseFloat(String(process.env.GEMINI_PROSE_TEMPERATURE || '0.65'), 10);
    const maxTok = parseInt(String(process.env.GEMINI_PROSE_MAX_TOKENS || '8192'), 10) || 8192;
    const m = genAI.getGenerativeModel({
      model: MODEL_PROSE,
      systemInstruction: proseSystemInstruction(),
      generationConfig: {
        temperature: Number.isFinite(temp) ? temp : 0.65,
        maxOutputTokens: maxTok,
        topP: 0.95,
        topK: 40
      },
      safetySettings: SAFETY
    });
    return wrapModelWithLimiter(m, { model: MODEL_PROSE, purpose: String(purpose || '') });
  }

  const m = genAI.getGenerativeModel({
    model: MODEL_JSON,
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 8192,
      responseMimeType: 'application/json'
    },
    safetySettings: SAFETY
  });
  return wrapModelWithLimiter(m, { model: MODEL_JSON, purpose: String(purpose || '') });
}

function getEmbeddingModelName() {
  return EMBEDDING_MODEL;
}

function getEmbeddingModel() {
  if (!genAI) {
    logger.error('❌ AI Client: Embeddings require GEMINI_API_KEY / GOOGLE_API_KEY');
    throw new Error('GEMINI_API_KEY is missing from environment variables');
  }
  const m = genAI.getGenerativeModel({ model: EMBEDDING_MODEL });
  return wrapModelWithLimiter(m, { model: EMBEDDING_MODEL, purpose: 'embeddings' });
}

/**
 * One-shot natural-language answer (same prose stack as summarize).
 * @param {string} userPrompt
 * @param {{ context?: string }} [opts]
 * @returns {Promise<string>}
 */
async function generateProseAnswer(userPrompt, opts = {}) {
  const model = getGeminiModel('assistant');
  const q = String(userPrompt || '').trim();
  if (q.length < 2) {
    throw new Error('Prompt is empty');
  }
  const ctx = String(opts.context || '').trim();
  const text =
    ctx.length > 0
      ? `Context (for reference — user may ask about this):\n${ctx.slice(0, 24000)}\n\n---\n\nUser request:\n${q}`
      : q;
  const result = await retryWithBackoff(
    () => model.generateContent(text),
    { maxRetries: scaleLimits.gemini.maxRetries, baseMs: scaleLimits.gemini.retryBaseMs }
  );
  const out = (await result.response).text();
  return String(out || '').trim();
}

module.exports = {
  genAI,
  getGeminiModel,
  getEmbeddingModel,
  getEmbeddingModelName,
  generateProseAnswer,
  MODEL_JSON,
  MODEL_PROSE,
  EMBEDDING_MODEL,
  isAIAvailable: () => {
    const available = !!genAI;
    if (!available) {
      logger.warn('⚠️ AI Service Status: NOT AVAILABLE (Check Railway Env Vars)');
    }
    return available;
  }
};
