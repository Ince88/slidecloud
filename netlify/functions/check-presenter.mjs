/**
 * Called by the Railway WebSocket server to validate a presenter token.
 * Returns 200 if valid, 403 if not.
 */
import { getStore } from '@netlify/blobs';

export default async (req) => {
  const params = new URL(req.url).searchParams;
  const slug   = params.get('slug');
  const token  = params.get('token');

  if (!slug || !token) {
    return new Response('Bad Request', { status: 400 });
  }

  try {
    const store = getStore('presentations');
    const data  = await store.get(slug, { type: 'json' });

    if (!data) return new Response('Not Found', { status: 404 });

    if (data.presenterToken && data.presenterToken === token) {
      return new Response('OK', { status: 200 });
    }
    return new Response('Forbidden', { status: 403 });
  } catch (err) {
    console.error('[check-presenter]', err);
    return new Response('Error', { status: 500 });
  }
};

export const config = { path: '/api/check-presenter' };
