import { getStore } from '@netlify/blobs';

export default async () => {
  try {
    const store = getStore('presentations');
    const { blobs } = await store.list();

    const items = await Promise.all(
      blobs.map(async ({ key }) => {
        try {
          const data = await store.get(key, { type: 'json' });
          return {
            slug:       key,
            createdAt:  data?.createdAt  ?? null,
            slideCount: data?.slides?.length ?? 0,
          };
        } catch {
          return { slug: key, createdAt: null, slideCount: 0 };
        }
      })
    );

    items.sort((a, b) => new Date(b.createdAt ?? 0) - new Date(a.createdAt ?? 0));

    return Response.json({ items });
  } catch (err) {
    console.error('[list] error:', err);
    return Response.json({ error: 'Failed to list presentations' }, { status: 500 });
  }
};

export const config = { path: '/api/list' };
