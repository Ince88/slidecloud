import { getStore } from '@netlify/blobs';

const SLUG_RE   = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;
const MAX_SLIDES = 40;

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { slug, slides, presenterToken } = body;

  if (!slug || typeof slug !== 'string') {
    return Response.json({ error: 'Missing slug' }, { status: 400 });
  }
  if (!SLUG_RE.test(slug)) {
    return Response.json({ error: 'Invalid slug — use letters, numbers and hyphens (3–50 chars)' }, { status: 400 });
  }
  if (!Array.isArray(slides) || slides.length === 0) {
    return Response.json({ error: 'No slides provided' }, { status: 400 });
  }
  if (slides.length > MAX_SLIDES) {
    return Response.json({ error: `Too many slides (max ${MAX_SLIDES})` }, { status: 400 });
  }

  try {
    const store = getStore('presentations');

    const existing = await store.get(slug);
    if (existing !== null) {
      return Response.json({ error: 'That name is already taken — please choose another' }, { status: 409 });
    }

    const payload = {
      slug,
      slides: slides.map(s => ({
        dataUrl:    s.dataUrl,
        fileName:   s.fileName   ?? '',
        pageNum:    s.pageNum    ?? 1,
        totalPages: s.totalPages ?? 1,
      })),
      // Store the presenter token so check-presenter.mjs can validate it
      presenterToken: typeof presenterToken === 'string' ? presenterToken.slice(0, 64) : null,
      createdAt: new Date().toISOString(),
    };

    await store.setJSON(slug, payload);

    return Response.json({ success: true });
  } catch (err) {
    console.error('[save] error:', err);
    return Response.json({ error: 'Failed to save — please try again' }, { status: 500 });
  }
};

export const config = { path: '/api/save' };
