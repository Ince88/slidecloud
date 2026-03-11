/**
 * SlideCloud — real-time WebSocket server (deploy on Railway)
 *
 * Environment variables to set in Railway:
 *   PORT         — set automatically by Railway
 *   NETLIFY_URL  — e.g. https://slidecloud.netlify.app
 *
 * After deploying, copy the Railway public URL (e.g. wss://slidecloud-server.railway.app)
 * and set it as RAILWAY_WS_URL in your Netlify environment variables.
 */

import http          from 'http';
import { WebSocketServer, WebSocket } from 'ws';

const PORT        = process.env.PORT        ?? 8080;
const NETLIFY_URL = process.env.NETLIFY_URL ?? 'https://slidecloud.netlify.app';

// ── In-memory rooms ───────────────────────────────────────────
// Map<slug, { currentSlide, presenterWs, viewers: Map<id, ws>, nextId }>
const rooms = new Map();

function getRoom(slug) {
  if (!rooms.has(slug)) {
    rooms.set(slug, { currentSlide: 0, presenterWs: null, viewers: new Map(), nextId: 0 });
  }
  return rooms.get(slug);
}

function pruneRoom(slug) {
  const r = rooms.get(slug);
  if (r && !r.presenterWs && r.viewers.size === 0) rooms.delete(slug);
}

function broadcast(viewers, msg) {
  const raw = JSON.stringify(msg);
  for (const [, ws] of viewers) {
    if (ws.readyState === WebSocket.OPEN) ws.send(raw);
  }
}

// ── Token validation via Netlify ──────────────────────────────
async function validateToken(slug, token) {
  try {
    const url = `${NETLIFY_URL}/api/check-presenter`
      + `?slug=${encodeURIComponent(slug)}&token=${encodeURIComponent(token)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    return res.ok;
  } catch {
    return false;
  }
}

// ── HTTP server (health check + CORS) ────────────────────────
const server = http.createServer((req, res) => {
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  const totalClients = [...rooms.values()]
    .reduce((n, r) => n + r.viewers.size + (r.presenterWs ? 1 : 0), 0);
  res.end(JSON.stringify({ status: 'ok', rooms: rooms.size, clients: totalClients }));
});

// ── WebSocket server ──────────────────────────────────────────
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let role     = null;   // 'presenter' | 'viewer'
  let slug     = null;
  let viewerId = null;

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // Heartbeat
    if (msg.type === 'ping') {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'pong' }));
      return;
    }

    // ── Join ─────────────────────────────────────────────────
    if (msg.type === 'join' && !role) {
      slug = String(msg.slug ?? '').slice(0, 60);
      if (!slug) return;

      if (msg.role === 'presenter') {
        const valid = await validateToken(slug, msg.token ?? '');
        if (!valid) {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid presenter token' }));
          ws.close();
          return;
        }
        const room = getRoom(slug);
        if (room.presenterWs?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'error', message: 'A presenter is already connected' }));
          ws.close();
          return;
        }
        role = 'presenter';
        room.presenterWs = ws;
        ws.send(JSON.stringify({
          type: 'joined', role: 'presenter',
          currentSlide: room.currentSlide,
          viewerCount: room.viewers.size,
        }));
        broadcast(room.viewers, { type: 'presenter-status', connected: true });
        broadcast(room.viewers, { type: 'slide', index: room.currentSlide });

      } else {
        const room = getRoom(slug);
        viewerId = room.nextId++;
        role = 'viewer';
        room.viewers.set(viewerId, ws);
        ws.send(JSON.stringify({
          type: 'joined', role: 'viewer',
          currentSlide: room.currentSlide,
          presenterConnected: room.presenterWs?.readyState === WebSocket.OPEN,
        }));
        if (room.presenterWs?.readyState === WebSocket.OPEN) {
          room.presenterWs.send(JSON.stringify({ type: 'viewers', count: room.viewers.size }));
        }
      }
    }

    // ── Slide change (presenter only) ─────────────────────────
    if (msg.type === 'slide' && role === 'presenter') {
      const room = rooms.get(slug);
      if (!room) return;
      const idx = Number(msg.index);
      if (!Number.isFinite(idx) || idx < 0 || idx > 999) return;
      room.currentSlide = idx;
      broadcast(room.viewers, { type: 'slide', index: idx });
    }

    // ── Next/Prev (layer or slide) ───────────────────────────
    if ((msg.type === 'next' || msg.type === 'prev') && role === 'presenter') {
      const room = rooms.get(slug);
      if (!room) return;
      broadcast(room.viewers, { type: msg.type });
    }
  });

  ws.on('close', () => {
    if (!slug) return;
    const room = rooms.get(slug);
    if (!room) return;

    if (role === 'presenter') {
      room.presenterWs = null;
      broadcast(room.viewers, { type: 'presenter-status', connected: false });
    } else if (role === 'viewer' && viewerId !== null) {
      room.viewers.delete(viewerId);
      if (room.presenterWs?.readyState === WebSocket.OPEN) {
        room.presenterWs.send(JSON.stringify({ type: 'viewers', count: room.viewers.size }));
      }
    }
    pruneRoom(slug);
  });

  ws.on('error', () => {}); // prevent crashes from individual socket errors
});

// ── Periodic cleanup of stale connections ─────────────────────
setInterval(() => {
  for (const [slug, room] of rooms) {
    if (room.presenterWs && room.presenterWs.readyState !== WebSocket.OPEN) {
      room.presenterWs = null;
      broadcast(room.viewers, { type: 'presenter-status', connected: false });
    }
    for (const [id, ws] of room.viewers) {
      if (ws.readyState !== WebSocket.OPEN) room.viewers.delete(id);
    }
    pruneRoom(slug);
  }
}, 30_000);

server.listen(PORT, () => {
  console.log(`SlideCloud WS server listening on :${PORT}`);
});
