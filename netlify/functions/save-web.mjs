import { getStore } from '@netlify/blobs';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;
const MAX_SECTIONS = 20;
const MAX_IMAGES   = 40;
const MAX_BYTES    = 6_000_000; // 6 MB (room for embedded images)

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

  const { slug, data, presenterToken, overwrite } = body;

  if (!slug || typeof slug !== 'string' || !SLUG_RE.test(slug)) {
    return Response.json({ error: 'Invalid name — use letters, numbers and hyphens (3–50 chars)' }, { status: 400 });
  }
  if (!data || typeof data !== 'object') {
    return Response.json({ error: 'Missing presentation data' }, { status: 400 });
  }
  if (!Array.isArray(data.sections) || data.sections.length === 0) {
    return Response.json({ error: 'No sections in presentation' }, { status: 400 });
  }
  if (data.sections.length > MAX_SECTIONS) {
    return Response.json({ error: `Too many sections (max ${MAX_SECTIONS})` }, { status: 400 });
  }

  // Normalize images array (optional). Each entry is either a plain data-URL
  // string, or an object { dataUrl, caption?, originSlide? }.
  let images = [];
  if (Array.isArray(data.images)) {
    if (data.images.length > MAX_IMAGES) {
      return Response.json({ error: `Too many images (max ${MAX_IMAGES})` }, { status: 400 });
    }
    images = data.images
      .map(img => {
        if (typeof img === 'string') return { dataUrl: img };
        if (img && typeof img === 'object' && typeof img.dataUrl === 'string') {
          return {
            dataUrl: img.dataUrl,
            caption: typeof img.caption === 'string' ? img.caption.slice(0, 200) : '',
            originSlide: Number.isFinite(img.originSlide) ? img.originSlide : null,
          };
        }
        return null;
      })
      .filter(Boolean);
  }

  const json = JSON.stringify({ ...data, images });
  if (json.length > MAX_BYTES) {
    return Response.json({ error: 'Presentation too large. Try fewer images or disable some from the gallery.' }, { status: 413 });
  }

  try {
    const store = getStore('presentations');

    const existing = await store.get(slug);
    if (existing !== null && !overwrite) {
      return Response.json({ error: 'That name is already taken — please choose another' }, { status: 409 });
    }

    const payload = {
      slug,
      type: 'web',
      data: {
        type: 'web',
        title: String(data.title ?? '').slice(0, 200),
        subtitle: String(data.subtitle ?? '').slice(0, 280),
        logoDataUrl: typeof data.logoDataUrl === 'string' ? data.logoDataUrl : null,
        sections: data.sections,
        images,
        createdAt: data.createdAt ?? new Date().toISOString(),
      },
      presenterToken: typeof presenterToken === 'string' ? presenterToken.slice(0, 64) : null,
      createdAt: new Date().toISOString(),
    };

    await store.setJSON(slug, payload);

    return Response.json({ success: true, slug });
  } catch (err) {
    console.error('[save-web] error:', err);
    return Response.json({ error: 'Failed to publish — please try again' }, { status: 500 });
  }
};

export const config = { path: '/api/save-web' };
