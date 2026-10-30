/**
 * Provider-independent AI adapter.
 *
 * Providers (AI_PROVIDER):
 *   anthropic          - Anthropic Messages API
 *   openai             - OpenAI Chat Completions API
 *   openai-compatible  - any Chat-Completions-compatible endpoint (set AI_BASE_URL),
 *                        e.g. OpenRouter, Groq, a Gemini compatibility endpoint, or a local server.
 *
 * Nothing here is mocked: with no key configured every call fails with a clear
 * "ai_not_configured" error and the rest of MITRA keeps working.
 * Requests are never retried automatically (to avoid duplicate charges).
 */
const config = require('../config');
const db = require('../database/db');
const { HttpError } = require('../lib/errors');
const { localDate } = require('../lib/dates');
const prompts = require('./prompts');

const anthropicVersion = '2023-06-01';

const err = {
  notConfigured: (missing) =>
    new HttpError(
      503,
      'ai_not_configured',
      `Online AI is not set up yet (missing ${missing.join(' and ')}). Open Settings → Online AI to add your API key. Everything saved on this computer still works.`
    ),
  offline: () =>
    new HttpError(503, 'ai_offline', 'MITRA could not reach the AI service. Please check your internet connection and try again. Your text has been kept.'),
  timeout: (ms) =>
    new HttpError(504, 'ai_timeout', `The AI service took longer than ${Math.round(ms / 1000)} seconds to answer. Please try again in a moment. Your text has been kept.`),
  provider: (status, detail) => new HttpError(502, 'ai_provider_error', providerMessage(status, detail)),
  invalid: () =>
    new HttpError(502, 'ai_invalid_response', 'The AI service sent an answer MITRA could not read. Nothing was saved. Please try again.'),
  limit: (n) =>
    new HttpError(429, 'ai_limit_reached', `You have reached today's limit of ${n} AI requests (set by AI_DAILY_LIMIT). Saved material is still available.`),
  tooLong: (len, max) =>
    new HttpError(413, 'ai_input_too_long', `That text is ${len.toLocaleString()} characters. The limit for one AI request is ${max.toLocaleString()}. Please select a smaller part.`),
};

function providerMessage(status, detail) {
  if (status === 401 || status === 403) return 'The AI service rejected the API key. Please check the key in Settings → Online AI.';
  if (status === 404) return 'The AI service could not find that model. Please check the model name in Settings → Online AI.';
  if (status === 429) return 'The AI service says you have made too many requests or used up your quota. Please wait a little or check your account.';
  if (status >= 500) return 'The AI service is having problems right now. Please try again later.';
  return `The AI service refused the request (${status}).${detail ? ' ' + detail : ''}`;
}

function missingSettings(cfg) {
  const missing = [];
  if (!cfg.apiKey) missing.push('an API key');
  if (!cfg.model) missing.push('a model name');
  if (cfg.provider === 'openai-compatible' && !cfg.baseUrl) missing.push('a base URL');
  return missing;
}

function usedToday() {
  return db.prepare('SELECT COUNT(*) AS c FROM ai_usage WHERE day = ? AND ok = 1').get(localDate()).c;
}

/** Safe status for the UI (never includes the key). */
function status() {
  const cfg = config.ai();
  const missing = missingSettings(cfg);
  return {
    configured: missing.length === 0 && ['anthropic', 'openai', 'openai-compatible'].includes(cfg.provider),
    providerKnown: ['anthropic', 'openai', 'openai-compatible'].includes(cfg.provider),
    provider: cfg.provider,
    model: cfg.model || null,
    baseUrl: cfg.baseUrl || null,
    hasKey: !!cfg.apiKey,
    missing,
    timeoutMs: cfg.timeoutMs,
    maxInputChars: cfg.maxInputChars,
    dailyLimit: cfg.dailyLimit,
    usedToday: usedToday(),
  };
}

function assertReady(inputLength) {
  const cfg = config.ai();
  if (!['anthropic', 'openai', 'openai-compatible'].includes(cfg.provider)) {
    throw new HttpError(503, 'ai_not_configured', `AI_PROVIDER "${cfg.provider}" is not supported. Use anthropic, openai or openai-compatible.`);
  }
  const missing = missingSettings(cfg);
  if (missing.length) throw err.notConfigured(missing);
  if (inputLength !== undefined && inputLength > cfg.maxInputChars) throw err.tooLong(inputLength, cfg.maxInputChars);
  if (usedToday() >= cfg.dailyLimit) throw err.limit(cfg.dailyLimit);
  return cfg;
}

async function callProvider(cfg, { system, messages, maxTokens }) {
  let url;
  let headers;
  let body;
  if (cfg.provider === 'anthropic') {
    url = `${cfg.baseUrl || 'https://api.anthropic.com'}/v1/messages`;
    headers = { 'content-type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': anthropicVersion };
    body = { model: cfg.model, max_tokens: maxTokens, system, messages };
  } else {
    const base = cfg.baseUrl || (cfg.provider === 'openai' ? 'https://api.openai.com/v1' : '');
    url = `${base}/chat/completions`;
    headers = { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` };
    body = { model: cfg.model, messages: [{ role: 'system', content: system }, ...messages] };
    // OpenAI's newer models require max_completion_tokens; compatible servers use max_tokens.
    if (cfg.provider === 'openai') body.max_completion_tokens = maxTokens;
    else body.max_tokens = maxTokens;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
    } catch (e) {
      if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) throw err.timeout(cfg.timeoutMs);
      throw err.offline();
    }
    let data = null;
    let raw = '';
    try {
      raw = await res.text();
      data = raw ? JSON.parse(raw) : null;
    } catch (e) {
      if (controller.signal.aborted) throw err.timeout(cfg.timeoutMs);
      if (res.ok) throw err.invalid();
    }
    if (!res.ok) {
      const detail = data && (data.error?.message || data.message);
      console.error(`[ai] provider returned HTTP ${res.status}`); // status only: no study content in logs
      throw err.provider(res.status, typeof detail === 'string' ? detail.slice(0, 160) : '');
    }
    let out;
    if (cfg.provider === 'anthropic') {
      out = Array.isArray(data?.content) ? data.content.filter((b) => b.type === 'text').map((b) => b.text).join('') : '';
    } else {
      const c = data?.choices?.[0]?.message?.content;
      out = typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => p.text || '').join('') : '';
    }
    if (!out || !out.trim()) throw err.invalid();
    return out.trim();
  } finally {
    clearTimeout(timer);
  }
}

/** One AI round-trip with limit checking and usage accounting. */
async function complete({ system, messages, inputLength, maxTokens }) {
  const cfg = assertReady(inputLength);
  try {
    const text = await callProvider(cfg, { system, messages, maxTokens: maxTokens || cfg.maxOutputTokens });
    db.prepare('INSERT INTO ai_usage (day, provider, model, ok) VALUES (?, ?, ?, 1)').run(localDate(), cfg.provider, cfg.model);
    return { text, provider: cfg.provider, model: cfg.model };
  } catch (e) {
    db.prepare('INSERT INTO ai_usage (day, provider, model, ok) VALUES (?, ?, ?, 0)').run(localDate(), cfg.provider, cfg.model);
    throw e;
  }
}

// ------------------------------------------------------------- JSON helpers
function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw err.invalid();
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (_) {
    throw err.invalid();
  }
}

const s = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// ------------------------------------------------------------------- tasks
async function explain({ mode, text, sourceLabel, history }) {
  if (!prompts.TEXT_MODES[mode]) throw new HttpError(400, 'invalid_input', 'Unknown explanation type.');
  const r = await complete({
    system: prompts.textSystem(mode),
    messages: prompts.buildTextMessages({ text, sourceLabel, history }),
    inputLength: text.length,
  });
  return r;
}

async function defineTerm(termText) {
  const r = await complete({
    system: prompts.TERM_SYSTEM,
    messages: [{ role: 'user', content: `Term: ${termText}` }],
    inputLength: termText.length,
    maxTokens: 1200,
  });
  const j = extractJson(r.text);
  const term = s(j.term, 120) || s(termText, 120);
  const entry = {
    term,
    pronunciation: s(j.pronunciation, 120),
    simple_english: s(j.simple_english, 800),
    tamil: s(j.tamil, 1200),
    definition: s(j.definition, 1000),
    example: s(j.example, 500),
    everyday_example: s(j.everyday_example, 600),
    related: Array.isArray(j.related) ? j.related.map((x) => s(x, 80)).filter(Boolean).slice(0, 8) : [],
  };
  if (!entry.simple_english) throw err.invalid();
  return { entry, provider: r.provider, model: r.model };
}

async function generateFlashcards({ text, topic, count = 6, sourceLabel }) {
  const hasText = !!text;
  const input = hasText ? prompts.sourceBlock(text, sourceLabel) : `Topic: ${topic}`;
  const r = await complete({
    system: prompts.flashcardsSystem(count, hasText),
    messages: [{ role: 'user', content: input }],
    inputLength: (text || topic).length,
    maxTokens: 2500,
  });
  const j = extractJson(r.text);
  const cards = (Array.isArray(j.cards) ? j.cards : [])
    .map((c) => ({ front: s(c?.front, 300), back: s(c?.back, 800), example: s(c?.example, 400) }))
    .filter((c) => c.front && c.back)
    .slice(0, count);
  if (!cards.length) throw err.invalid();
  return { cards, provider: r.provider, model: r.model };
}

async function generateQuiz({ text, topic, count = 5, types = ['mcq', 'tf'], sourceLabel }) {
  const hasText = !!text;
  const input = hasText ? prompts.sourceBlock(text, sourceLabel) : `Topic: ${topic}`;
  const r = await complete({
    system: prompts.quizSystem(count, hasText, types),
    messages: [{ role: 'user', content: input }],
    inputLength: (text || topic).length,
    maxTokens: 3500,
  });
  const j = extractJson(r.text);
  const questions = [];
  for (const q of Array.isArray(j.questions) ? j.questions : []) {
    const question = s(q?.question, 500);
    const explanation = s(q?.explanation, 600);
    if (!question) continue;
    if (q.type === 'mcq' && types.includes('mcq')) {
      const options = Array.isArray(q.options) ? q.options.map((o) => s(o, 300)).filter(Boolean) : [];
      const idx = Number(q.answer);
      if (options.length !== 4 || !Number.isInteger(idx) || idx < 0 || idx > 3) continue;
      if (new Set(options.map((o) => o.toLowerCase())).size !== 4) continue;
      questions.push({ type: 'mcq', question, options, correct: String(idx), explanation });
    } else if (q.type === 'tf' && types.includes('tf')) {
      if (typeof q.answer !== 'boolean') continue;
      questions.push({ type: 'tf', question, options: null, correct: q.answer ? 'true' : 'false', explanation });
    }
  }
  if (!questions.length) throw err.invalid();
  return { title: s(j.title, 120), questions: questions.slice(0, count), provider: r.provider, model: r.model };
}

module.exports = { status, assertReady, explain, defineTerm, generateFlashcards, generateQuiz, complete, errors: err };
