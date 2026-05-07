/**
 * GET /api/ai-status?id=<generationId>
 *
 * Polls a Gamma generation and, when complete, fetches the exported PPTX
 * server-side and returns it as base64. This avoids any CORS/auth issues
 * the browser would hit when going directly to Gamma's CDN, and keeps the
 * GAMMA_API_KEY server-side.
 *
 * Note: Netlify Functions cap responses at ~6 MB. For typical Gamma decks
 * (8–12 slides with AI images) the PPTX usually lands in the 1–5 MB range.
 * If a generation comes back larger we return a JSON error rather than a
 * truncated payload, and the client can fall back to opening gammaUrl.
 */

const GAMMA_BASE = 'https://public-api.gamma.app/v1.0/generations';
const MAX_PPTX_BYTES = 5_500_000; // safe under the 6 MB function response cap

export default async (req) => {
  if (req.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 });
  }

  const apiKey = process.env.GAMMA_API_KEY;
  if (!apiKey) {
    return Response.json({ error: 'AI generation isn\'t configured.' }, { status: 503 });
  }

  const url = new URL(req.url);
  const id = (url.searchParams.get('id') || '').trim();
  if (!/^[a-zA-Z0-9_-]{4,128}$/.test(id)) {
    return Response.json({ error: 'Invalid generation id' }, { status: 400 });
  }

  let statusRes;
  try {
    statusRes = await fetch(`${GAMMA_BASE}/${encodeURIComponent(id)}`, {
      method: 'GET',
      headers: { 'X-API-KEY': apiKey },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    console.error('[ai-status] Gamma poll failed:', err);
    return Response.json({ error: 'Could not reach the AI service.' }, { status: 502 });
  }

  if (statusRes.status === 404) {
    return Response.json({ error: 'Generation not found' }, { status: 404 });
  }
  if (!statusRes.ok) {
    const t = await statusRes.text().catch(() => '');
    console.warn('[ai-status] Gamma error', statusRes.status, t.slice(0, 300));
    return Response.json({ error: 'AI service error.' }, { status: 502 });
  }

  let data;
  try {
    data = await statusRes.json();
  } catch {
    return Response.json({ error: 'AI service returned invalid JSON.' }, { status: 502 });
  }

  // Gamma's status field can be a string (commonly) or an object — handle both.
  const status = typeof data.status === 'string' ? data.status : (data.status?.status || data.status?.state || 'pending');

  if (status === 'failed') {
    return Response.json({
      status: 'failed',
      error: data.error?.message || 'Generation failed.',
    });
  }

  if (status !== 'completed') {
    return Response.json({
      status: status || 'pending',
      gammaId: data.gammaId ?? null,
    });
  }

  // Completed → fetch the PPTX bytes server-side.
  const exportUrl = data.exportUrl;
  if (!exportUrl) {
    return Response.json({
      status: 'completed',
      error: 'Generation completed but no export URL was returned.',
      gammaUrl: data.gammaUrl ?? null,
    });
  }

  let pptxRes;
  try {
    pptxRes = await fetch(exportUrl, { signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    console.error('[ai-status] export fetch failed:', err);
    return Response.json({
      status: 'completed',
      error: 'Could not download the generated file. Open it on Gamma instead.',
      gammaUrl: data.gammaUrl ?? null,
      exportUrl,
    }, { status: 502 });
  }

  if (!pptxRes.ok) {
    return Response.json({
      status: 'completed',
      error: `Could not download the generated file (HTTP ${pptxRes.status}).`,
      gammaUrl: data.gammaUrl ?? null,
      exportUrl,
    }, { status: 502 });
  }

  const buffer = await pptxRes.arrayBuffer();
  if (buffer.byteLength > MAX_PPTX_BYTES) {
    return Response.json({
      status: 'completed',
      error: 'Generated file is too large to import directly. Open it on Gamma instead.',
      gammaUrl: data.gammaUrl ?? null,
      exportUrl,
      sizeBytes: buffer.byteLength,
    }, { status: 413 });
  }

  const base64 = Buffer.from(buffer).toString('base64');

  return Response.json({
    status: 'completed',
    gammaId: data.gammaId ?? null,
    gammaUrl: data.gammaUrl ?? null,
    pptxBase64: base64,
    sizeBytes: buffer.byteLength,
    credits: data.credits ?? null,
  });
};

export const config = { path: '/api/ai-status' };
