/**
 * Returns runtime config to the browser.
 * Set RAILWAY_WS_URL in Netlify environment variables after deploying to Railway,
 * e.g.  wss://slidecloud-server.railway.app
 */
export default async () => {
  return Response.json({
    wsUrl: process.env.RAILWAY_WS_URL ?? null,
  });
};

export const config = { path: '/api/config' };
