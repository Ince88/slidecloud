import { getStore } from '@netlify/blobs';

export default async (req) => {
  if (req.method !== 'DELETE' && req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const url  = new URL(req.url);
  let slug   = url.searchParams.get('slug');

  // Also accept slug from JSON body (POST)
  if (!slug && req.method === 'POST') {
    try { const b = await req.json(); slug = b.slug ?? null; } catch {}
  }
  if (!slug) {
    return Response.json({ error: 'Missing slug' }, { status: 400 });
  }

  try {
    const store = getStore('presentations');
    await store.delete(slug);
    return Response.json({ success: true });
  } catch (err) {
    console.error('[delete] error:', err);
    return Response.json({ error: 'Failed to delete' }, { status: 500 });
  }
};

export const config = { path: '/api/delete' };
