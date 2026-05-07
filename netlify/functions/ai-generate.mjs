/**
 * POST /api/ai-generate
 *
 * Kicks off an asynchronous Gamma generation. The browser POSTs the user's
 * prompt and a few options; we forward to Gamma's public API with our own
 * GAMMA_API_KEY (kept server-side) and return the generationId so the client
 * can poll /api/ai-status.
 *
 * Required env: GAMMA_API_KEY  (Gamma Pro/Ultra/Teams/Business plan).
 * Optional env: AI_RATE_LIMIT_PER_DAY  (default 5)
 *               AI_RATE_LIMIT_DISABLED ('1' to skip rate limiting)
 */
import { getStore } from '@netlify/blobs';

const GAMMA_ENDPOINT = 'https://public-api.gamma.app/v1.0/generations';

const TONES = new Set([
  'professional', 'casual', 'enthusiastic', 'persuasive',
  'educational', 'playful', 'inspirational', 'serious',
]);
const IMAGE_SOURCES = new Set([
  'aiGenerated', 'webFreeToUse', 'webFreeToUseCommercially',
  'pexels', 'placeholder', 'noImages', 'themeAccent',
]);
const TEXT_AMOUNTS = new Set(['brief', 'medium', 'detailed', 'extensive']);

function clientIp(req) {
  const fwd = req.headers.get('x-forwarded-for') || req.headers.get('x-nf-client-connection-ip') || '';
  return (fwd.split(',')[0] || 'unknown').trim();
}

async function checkRateLimit(ip) {
  if (process.env.AI_RATE_LIMIT_DISABLED === '1') return { ok: true };
  const max = Number(process.env.AI_RATE_LIMIT_PER_DAY ?? 5);
  if (!Number.isFinite(max) || max <= 0) return { ok: true };

  try {
    const store = getStore('ai-rate-limits');
    const key = `${new Date().toISOString().slice(0, 10)}:${ip}`;
    const current = (await store.get(key, { type: 'json' })) ?? { count: 0 };
    if (current.count >= max) {
      return { ok: false, max, used: current.count };
    }
    await store.setJSON(key, { count: current.count + 1 });
    return { ok: true, max, used: current.count + 1 };
  } catch (err) {
    console.warn('[ai-generate] rate-limit blob unavailable, allowing through:', err);
    return { ok: true };
  }
}

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const apiKey = process.env.GAMMA_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: 'AI generation isn\'t configured yet. Missing GAMMA_API_KEY on the server.' },
      { status: 503 },
    );
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const prompt = String(body.prompt ?? '').trim();
  if (prompt.length < 8) {
    return Response.json({ error: 'Please describe what you want — at least 8 characters.' }, { status: 400 });
  }
  if (prompt.length > 8000) {
    return Response.json({ error: 'Prompt is too long (max 8000 characters).' }, { status: 400 });
  }

  const numCards = clampInt(body.numCards, 4, 20, 8);
  const tone = TONES.has(body.tone) ? body.tone : 'professional';
  const audience = String(body.audience ?? '').trim().slice(0, 200);
  const language = typeof body.language === 'string' ? body.language.slice(0, 8) : 'en';
  const imageSource = IMAGE_SOURCES.has(body.imageSource) ? body.imageSource : 'aiGenerated';
  const textAmount = TEXT_AMOUNTS.has(body.textAmount) ? body.textAmount : 'medium';
  const title = typeof body.title === 'string' ? body.title.trim().slice(0, 200) : '';

  const ip = clientIp(req);
  const rl = await checkRateLimit(ip);
  if (!rl.ok) {
    return Response.json(
      { error: `Daily AI generation limit reached (${rl.max}/day). Try again tomorrow.` },
      { status: 429 },
    );
  }

  const gammaPayload = {
    inputText: prompt,
    textMode: 'generate',
    format: 'presentation',
    exportAs: 'pptx',
    numCards,
    textOptions: {
      amount: textAmount,
      language,
      tone,
      audience: audience || undefined,
    },
    imageOptions: {
      source: imageSource,
    },
    cardOptions: {
      dimensions: '16x9',
    },
  };
  if (title) gammaPayload.title = title;
  if (body.additionalInstructions && typeof body.additionalInstructions === 'string') {
    gammaPayload.additionalInstructions = body.additionalInstructions.slice(0, 5000);
  }

  let gammaRes;
  try {
    gammaRes = await fetch(GAMMA_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': apiKey,
      },
      body: JSON.stringify(gammaPayload),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    console.error('[ai-generate] Gamma request failed:', err);
    return Response.json({ error: 'Could not reach the AI service. Please try again.' }, { status: 502 });
  }

  if (!gammaRes.ok) {
    const text = await gammaRes.text().catch(() => '');
    console.warn('[ai-generate] Gamma error', gammaRes.status, text.slice(0, 500));
    if (gammaRes.status === 401) {
      return Response.json({ error: 'AI service rejected our credentials.' }, { status: 502 });
    }
    if (gammaRes.status === 402) {
      return Response.json({ error: 'AI generation credits exhausted. Please contact the site owner.' }, { status: 402 });
    }
    if (gammaRes.status === 429) {
      return Response.json({ error: 'AI service is rate-limiting requests. Try again in a minute.' }, { status: 429 });
    }
    return Response.json({ error: 'AI generation failed. Please try a different prompt.' }, { status: 502 });
  }

  let gammaData;
  try {
    gammaData = await gammaRes.json();
  } catch {
    return Response.json({ error: 'AI service returned an invalid response.' }, { status: 502 });
  }

  if (!gammaData?.generationId) {
    return Response.json({ error: 'AI service did not return a generation ID.' }, { status: 502 });
  }

  return Response.json({
    generationId: gammaData.generationId,
    warnings: gammaData.warnings ?? null,
    used: rl.used ?? null,
    dailyLimit: rl.max ?? null,
  });
};

function clampInt(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

export const config = { path: '/api/ai-generate' };
