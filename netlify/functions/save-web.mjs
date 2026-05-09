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
          const source = (img.source === 'ppt' || img.source === 'web') ? img.source : null;
          return {
            dataUrl: img.dataUrl,
            caption: typeof img.caption === 'string' ? img.caption.slice(0, 200) : '',
            originSlide: Number.isFinite(img.originSlide) ? img.originSlide : null,
            source,
            originUrl: typeof img.originUrl === 'string' ? img.originUrl.slice(0, 500) : null,
          };
        }
        return null;
      })
      .filter(Boolean);
  }

  // Validate brand colors (DATA.brand). Keep only well-formed hex values.
  let brandClean = null;
  if (data.brand && typeof data.brand === 'object') {
    const isHex = (v) => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
    const accent  = isHex(data.brand.accent)  ? data.brand.accent  : null;
    const accent2 = isHex(data.brand.accent2) ? data.brand.accent2 : null;
    if (accent) {
      brandClean = {
        accent,
        accent2: accent2 || accent,
        source: (data.brand.source === 'logo' || data.brand.source === 'manual') ? data.brand.source : 'manual',
      };
    }
  }

  // Sanitize per-block actions (block._action). Keep only the supported
  // shapes: gallery (image indices) or page (eyebrow/heading/lead/body/imageIndex).
  if (Array.isArray(data.sections)) {
    const imgCount = images.length;
    data.sections.forEach(sec => {
      if (!sec || !Array.isArray(sec.blocks)) return;
      sec.blocks.forEach(b => {
        if (!b || typeof b !== 'object' || !b._action) return;
        const a = b._action;
        if (a.type === 'gallery' && Array.isArray(a.images)) {
          const valid = a.images.filter(n => Number.isInteger(n) && n >= 0 && n < imgCount).slice(0, 30);
          if (valid.length === 0) { delete b._action; return; }
          b._action = {
            type: 'gallery',
            images: valid,
          };
        } else if (a.type === 'page' && a.page && typeof a.page === 'object') {
          const p = a.page;
          const headingTrim = String(p.heading ?? '').trim().slice(0, 200);
          if (!headingTrim) { delete b._action; return; }
          b._action = {
            type: 'page',
            page: {
              eyebrow:    String(p.eyebrow ?? '').slice(0, 80),
              heading:    headingTrim,
              lead:       String(p.lead ?? '').slice(0, 280),
              body:       String(p.body ?? '').slice(0, 2000),
              imageIndex: (Number.isInteger(p.imageIndex) && p.imageIndex >= 0 && p.imageIndex < imgCount) ? p.imageIndex : null,
            },
          };
        } else {
          delete b._action;
        }
      });
    });
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

  // Per-text-element font/style overrides (set by the editor's font panel).
  // Pass through as a string-keyed map of objects only.
  let stylesMap = null;
    if (data._styles && typeof data._styles === 'object' && !Array.isArray(data._styles)) {
      stylesMap = {};
      for (const [k, v] of Object.entries(data._styles)) {
        if (typeof k !== 'string' || k.length > 200) continue;
        if (!v || typeof v !== 'object') continue;
        const clean = {};
        if (typeof v.fontFamily === 'string')   clean.fontFamily   = v.fontFamily.slice(0, 200);
        if (typeof v.fontSize   === 'string')   clean.fontSize     = v.fontSize.slice(0, 30);
        if (v.fontWeight != null)               clean.fontWeight   = v.fontWeight;
        if (v.opacity   != null)                clean.opacity      = Number(v.opacity);
        if (typeof v.textShadow === 'string')   clean.textShadow   = v.textShadow.slice(0, 200);
        if (typeof v.color === 'string')        clean.color        = v.color.slice(0, 30);
        if (typeof v.letterSpacing === 'string')clean.letterSpacing= v.letterSpacing.slice(0, 20);
        if (typeof v.fontStyle === 'string')    clean.fontStyle    = v.fontStyle.slice(0, 20);
        if (Object.keys(clean).length) stylesMap[k] = clean;
      }
      if (Object.keys(stylesMap).length === 0) stylesMap = null;
    }

    const payload = {
      slug,
      type: 'web',
      data: {
        type: 'web',
        title: String(data.title ?? '').slice(0, 200),
        subtitle: String(data.subtitle ?? '').slice(0, 280),
        logoDataUrl: typeof data.logoDataUrl === 'string' ? data.logoDataUrl : null,
        brand: brandClean,
        sections: data.sections,
        images,
        _styles: stylesMap,
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
