/**
 * GEMINI CLIENT — structured JSON vs natural-language (Gemini-app style prose).
 * JSON mode stays on for extraction, discovery, navigation, signal scoring, etc.
 * Prose mode (no JSON mime) + system instruction for summaries and chat-style answers.
 */
const { GoogleGenerativeAI } = require('@google/generative-ai');
const logger = require('../../utils/logger');

const API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
const genAI = API_KEY ? new GoogleGenerativeAI(API_KEY) : null;

/** Cheap + deterministic JSON for scraping, vision, structured pipelines */
const MODEL_JSON = process.env.GEMINI_MODEL_JSON || 'gemini-2.0-flash-lite';
/** Clearer writing for user-facing text (closer to the Gemini app experience) */
const MODEL_PROSE = process.env.GEMINI_MODEL_PROSE || 'gemini-2.0-flash';

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
    return genAI.getGenerativeModel({
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
  }

  return genAI.getGenerativeModel({
    model: MODEL_JSON,
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 8192,
      responseMimeType: 'application/json'
    },
    safetySettings: SAFETY
  });
}

function getEmbeddingModel() {
  if (!genAI) {
    logger.error('❌ AI Client: Embeddings require GEMINI_API_KEY / GOOGLE_API_KEY');
    throw new Error('GEMINI_API_KEY is missing from environment variables');
  }
  return genAI.getGenerativeModel({ model: 'text-embedding-004' });
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
  const result = await model.generateContent(text);
  const out = (await result.response).text();
  return String(out || '').trim();
}

module.exports = {
  genAI,
  getGeminiModel,
  getEmbeddingModel,
  generateProseAnswer,
  MODEL_JSON,
  MODEL_PROSE,
  isAIAvailable: () => {
    const available = !!genAI;
    if (!available) {
      logger.warn('⚠️ AI Service Status: NOT AVAILABLE (Check Railway Env Vars)');
    }
    return available;
  }
};
