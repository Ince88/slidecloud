import { getStore } from '@netlify/blobs';

export default async (req) => {
  const slug = new URL(req.url).searchParams.get('slug');

  if (!slug) {
    return Response.json({ error: 'Missing slug parameter' }, { status: 400 });
  }

  try {
    const store = getStore('presentations');
    const data  = await store.get(slug, { type: 'json' });

    if (data === null) {
      return Response.json({ error: 'Presentation not found' }, { status: 404 });
    }

    return Response.json(data);
  } catch (err) {
    console.error('[load] error:', err);
    return Response.json({ error: 'Failed to load presentation' }, { status: 500 });
  }
};

export const config = { path: '/api/load' };
