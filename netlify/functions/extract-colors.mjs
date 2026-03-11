/**
 * Extract dominant colors from a webpage for slide gradients.
 * Prioritizes DARKER, more saturated colors (header, logo, accents) over light backgrounds.
 */

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(v => Math.min(255, Math.max(0, Math.round(v))).toString(16).padStart(2, '0')).join('');
}

function brightness(r, g, b) {
  return (r + g + b) / 3;
}

function saturation(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max === 0) return 0;
  return (max - min) / max;
}

export default async (req) => {
  const url = new URL(req.url).searchParams.get('url');
  if (!url) {
    return Response.json({ error: 'Missing url parameter' }, { status: 400 });
  }

  try {
    // 1. Try theme-color from HTML first (often the brand color)
    let themeColor = null;
    try {
      const htmlRes = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SlideCloud/1.0)' },
        signal: AbortSignal.timeout(5000),
      });
      if (htmlRes.ok) {
        const html = await htmlRes.text();
        const m = html.match(/<meta[^>]+name=["']theme-color["'][^>]+content=["']([^"']+)["']/i)
          || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']theme-color["']/i);
        if (m) {
          const hex = m[1].trim();
          if (/^#[0-9a-fA-F]{3,8}$/.test(hex)) themeColor = hex.length === 4 ? '#' + hex.slice(1).split('').map(c => c + c).join('') : hex;
        }
      }
    } catch (_) { /* ignore */ }

    // 2. Get screenshot for color extraction
    const microlinkRes = await fetch(
      `https://api.microlink.io/?url=${encodeURIComponent(url)}&screenshot=true`,
      { headers: { 'User-Agent': 'SlideCloud/1.0' } }
    );
    if (!microlinkRes.ok) {
      return Response.json({ error: 'Could not capture screenshot' }, { status: 502 });
    }
    const microlink = await microlinkRes.json();
    const screenshotUrl = microlink?.data?.screenshot?.url;
    if (!screenshotUrl) {
      return Response.json({ error: 'No screenshot in response' }, { status: 502 });
    }

    const imgRes = await fetch(screenshotUrl, {
      headers: { 'User-Agent': 'SlideCloud/1.0' },
    });
    if (!imgRes.ok) {
      return Response.json({ error: 'Could not fetch screenshot image' }, { status: 502 });
    }
    const imgBuffer = await imgRes.arrayBuffer();

    const Jimp = (await import('jimp')).default;
    const img = await Jimp.read(Buffer.from(imgBuffer));
    img.resize(100, 75);

    const { width, height } = img.bitmap;
    const counts = new Map();

    // Sample: prioritize TOP 20% (header/nav area) and LEFT 30% (logo area) — where brand colors usually are
    const q = 24;
    for (let y = 0; y < height; y += 2) {
      for (let x = 0; x < width; x += 2) {
        const c = img.getPixelColor(x, y);
        const r = (c >> 24) & 0xff;
        const g = (c >> 16) & 0xff;
        const b = (c >> 8) & 0xff;
        const a = c & 0xff;
        if (a < 128) continue;
        const br = brightness(r, g, b);
        if (br > 200) continue; // skip white/very light
        if (br < 15) continue;  // skip near-black (text)
        const key = `${Math.floor(r / q) * q},${Math.floor(g / q) * q},${Math.floor(b / q) * q}`;
        const weight = (y < height * 0.2 ? 3 : 1) * (x < width * 0.3 ? 2 : 1); // boost header + left
        counts.set(key, (counts.get(key) || 0) + weight);
      }
    }

    // Score: prefer DARKER and more SATURATED colors (brand accents, not gray)
    const entries = [...counts.entries()].map(([k, count]) => {
      const [r, g, b] = k.split(',').map(Number);
      const br = brightness(r, g, b);
      const sat = saturation(r, g, b);
      const darknessBonus = (255 - br) / 255;
      const satBonus = 0.5 + sat * 0.5;
      const score = count * darknessBonus * satBonus;
      return { key: k, count, r, g, b, score };
    });

    const sorted = entries.sort((a, b) => b.score - a.score);

    if (sorted.length === 0 || (themeColor && sorted.every(e => brightness(e.r, e.g, e.b) > 180))) {
      if (themeColor) {
        const n = parseInt(themeColor.slice(1), 16);
        const r = (n >> 16) & 0xff, g = (n >> 8) & 0xff, b = n & 0xff;
        const darken = 0.4;
        return Response.json({
          from: rgbToHex(r * darken, g * darken, b * darken),
          to: rgbToHex(r * 0.25, g * 0.25, b * 0.25),
          source: 'theme-color',
        });
      }
      return Response.json({ from: '#0f172a', to: '#1e293b', source: 'fallback' });
    }

    const c1 = sorted[0];
    const c2 = sorted.find(s => Math.abs(s.r - c1.r) + Math.abs(s.g - c1.g) + Math.abs(s.b - c1.b) > 40) || sorted[1] || c1;

    const darken = 0.4;
    const [r1, g1, b1] = [c1.r * darken, c1.g * darken, c1.b * darken];
    const [r2, g2, b2] = [c2.r * darken, c2.g * darken, c2.b * darken];

    if (brightness(r1, g1, b1) > 80) {
      return Response.json({ from: '#0f172a', to: '#1e293b', source: 'fallback' });
    }

    return Response.json({
      from: rgbToHex(r1, g1, b1),
      to: rgbToHex(r2, g2, b2),
      source: 'screenshot',
    });
  } catch (err) {
    console.error('[extract-colors]', err);
    return Response.json(
      { error: 'Color extraction failed', from: '#0f172a', to: '#1e293b', source: 'fallback' },
      { status: 200 }
    );
  }
};

export const config = { path: '/api/extract-colors' };
