/**
 * Flipcloud — shared PPTX parser & section mapper.
 *
 * Loaded as a classic script (no modules) so any HTML page can drop it in
 * with `<script src="/assets/pptx-parser.js"></script>` after JSZip.
 * Attaches its API to `window.PptxParser`.
 *
 * Exposed:
 *   PptxParser.extractPptData(arrayBuffer) -> Promise<Slide[]>
 *     Slide = { n, text, images: [{ path, ext, size, dataUrl }] }
 *
 *   PptxParser.slidesToFlipcloud(slides, options) -> Presentation
 *     Maps Gamma-style PPTX slides to the Flipcloud "web presentation" schema
 *     ({ title, subtitle, sections, images }) without requiring an LLM.
 */
(function (global) {
  'use strict';

  function decodeXml(s) {
    return String(s)
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');
  }

  function blobToDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  }

  // Extract text from a single <a:p> paragraph element. Joins all <a:t> runs
  // inside that paragraph into a single line, preserving order.
  function extractParagraphs(slideXml) {
    var paragraphs = [];
    var pRe = /<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g;
    var pMatch;
    while ((pMatch = pRe.exec(slideXml)) !== null) {
      var inner = pMatch[1];
      var runs = [];
      var tRe = /<a:t[^>]*>([\s\S]*?)<\/a:t>/g;
      var tMatch;
      while ((tMatch = tRe.exec(inner)) !== null) {
        runs.push(decodeXml(tMatch[1]));
      }
      var line = runs.join('').trim();
      if (line) paragraphs.push(line);
    }
    return paragraphs;
  }

  async function extractPptData(arrayBuffer) {
    if (typeof JSZip === 'undefined') {
      throw new Error('JSZip is not loaded. Include it before pptx-parser.js.');
    }
    var zip = await JSZip.loadAsync(arrayBuffer);
    var slideFiles = Object.keys(zip.files)
      .filter(function (n) { return /^ppt\/slides\/slide\d+\.xml$/.test(n); })
      .sort(function (a, b) {
        var na = parseInt(a.match(/slide(\d+)\.xml/)[1], 10);
        var nb = parseInt(b.match(/slide(\d+)\.xml/)[1], 10);
        return na - nb;
      });

    var slides = [];
    for (var i = 0; i < slideFiles.length; i++) {
      var name = slideFiles[i];
      var xml = await zip.files[name].async('string');

      var paragraphs = extractParagraphs(xml);

      // rIds of embedded images
      var rids = [];
      var bre = /<a:blip[^>]*r:embed="([^"]+)"/g;
      var m;
      while ((m = bre.exec(xml)) !== null) rids.push(m[1]);

      // Resolve rIds via the rels file
      var relsName = 'ppt/slides/_rels/' + name.split('/').pop() + '.rels';
      var relsFile = zip.files[relsName];
      var relMap = {};
      if (relsFile) {
        var relsXml = await relsFile.async('string');
        var rre = /<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g;
        var r;
        while ((r = rre.exec(relsXml)) !== null) relMap[r[1]] = r[2];
      }

      var images = [];
      for (var k = 0; k < rids.length; k++) {
        var target = relMap[rids[k]];
        if (!target) continue;
        var mediaPath = target.replace(/^\.\.\//, 'ppt/');
        if (mediaPath.indexOf('ppt/') !== 0) mediaPath = 'ppt/' + mediaPath;
        var f = zip.files[mediaPath];
        if (!f) continue;
        var extMatch = mediaPath.match(/\.([a-z0-9]+)$/i);
        var ext = extMatch ? extMatch[1].toLowerCase() : '';
        if (ext && !/^(png|jpg|jpeg|gif|svg|webp|bmp)$/.test(ext)) continue;

        var blob = await f.async('blob');
        var dataUrl = await blobToDataUrl(blob);
        images.push({ path: mediaPath, ext: ext, size: blob.size, dataUrl: dataUrl });
      }

      if (paragraphs.length || images.length) {
        slides.push({
          n: slides.length + 1,
          text: paragraphs.join('\n'),
          paragraphs: paragraphs,
          images: images,
        });
      }
    }
    return slides;
  }

  // ── Deterministic Gamma PPTX → Flipcloud section mapping ──────
  //
  // Gamma's exported PPTX has a predictable shape: the first slide is a cover
  // (title + subtitle), each subsequent slide has a heading + a few bullet
  // points (and often one image). We map each content slide to one Flipcloud
  // section, picking sensible block types based on what's on the slide.

  function slugifyId(s, idx) {
    var base = String(s || '')
      .toLowerCase()
      .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s-]/g, ' ')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 40);
    if (!base) base = 'section';
    return base + '-' + (idx + 1);
  }

  function shortLabel(heading) {
    if (!heading) return '';
    var words = heading.split(/\s+/).filter(Boolean);
    if (words.length <= 3) return heading;
    return words.slice(0, 3).join(' ');
  }

  function pickEyebrow(heading, idx) {
    if (!heading) return 'Topic ' + (idx + 1);
    var words = heading.split(/\s+/).filter(Boolean);
    if (words.length <= 2) return heading;
    return words.slice(0, 2).join(' ');
  }

  // Try to detect short "stat-like" lines: things like "40M€ turnover" or
  // "1993 — Foundation". Returns null if nothing convincing is found.
  function maybeStatItems(lines) {
    if (!lines || lines.length < 2) return null;
    var stats = [];
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      // Pattern: leading number/short symbol followed by a label.
      var m = l.match(/^([\p{Sc}\d][\p{L}\p{N}\p{Sc}\.,%+\-/]{0,8})\s+[—\-:|\s]\s*(.{2,40})$/u)
           || l.match(/^([\p{Sc}\d][\p{L}\p{N}\p{Sc}\.,%+\-/]{0,8})\s+(.{2,40})$/u);
      if (!m) return null;
      stats.push({ strong: m[1].trim(), span: m[2].trim() });
    }
    return stats.length >= 2 && stats.length <= 5 ? stats : null;
  }

  function buildBlocksForSlide(slide, options) {
    var paragraphs = (slide.paragraphs || []).slice();
    if (!paragraphs.length && slide.text) paragraphs = slide.text.split(/\n+/);

    var heading = paragraphs.shift() || '';
    var lead = '';

    // If the next paragraph is a long sentence, treat it as a lead.
    if (paragraphs.length && paragraphs[0].length >= 40 && paragraphs[0].split(/\s+/).length >= 6) {
      lead = paragraphs.shift();
    }

    var blocks = [];

    // If the slide has an image and there's still some text, use image-text.
    if (slide.images && slide.images.length) {
      var imgIndex = options.imageIndexBySlide[slide.n];
      if (typeof imgIndex === 'number') {
        if (paragraphs.length) {
          var firstBullets = paragraphs.slice(0, 4);
          paragraphs = paragraphs.slice(firstBullets.length);
          blocks.push({
            type: 'image-text',
            index: imgIndex,
            side: (options.sideToggle++ % 2 === 0) ? 'right' : 'left',
            h3: shortLabel(heading) || 'Highlights',
            p: firstBullets[0] || '',
            ul: firstBullets.slice(1),
          });
        } else {
          blocks.push({ type: 'figure', index: imgIndex, caption: '' });
        }
      }
    }

    if (paragraphs.length) {
      var stats = maybeStatItems(paragraphs.slice(0, 5));
      if (stats) {
        blocks.push({ type: 'stats', items: stats });
      } else if (paragraphs.length <= 6 && paragraphs.every(function (p) { return p.length <= 32; })) {
        blocks.push({ type: 'pills', items: paragraphs.slice(0, 6) });
      } else {
        // Cards: pair lines up — each card gets a short title + body.
        var cards = [];
        var max = Math.min(4, paragraphs.length);
        for (var i = 0; i < max; i++) {
          var line = paragraphs[i];
          var parts = line.split(/[—:–]\s+/);
          if (parts.length >= 2 && parts[0].length <= 32) {
            cards.push({ h3: parts[0].trim(), p: parts.slice(1).join(' — ').trim() });
          } else {
            cards.push({ h3: shortLabel(line), p: line });
          }
        }
        blocks.push({ type: 'cards', cols: cards.length >= 3 ? 3 : 2, cards: cards });
      }
    }

    if (!blocks.length) {
      // Fallback so the section isn't empty.
      blocks.push({ type: 'pills', items: [heading || 'Overview'] });
    }

    return { heading: heading, lead: lead, blocks: blocks };
  }

  function slidesToFlipcloud(slides, options) {
    options = options || {};
    if (!slides || !slides.length) {
      return { title: options.fallbackTitle || 'Untitled', subtitle: '', sections: [], images: [] };
    }

    // Cover slide: first slide whose first paragraph looks like a title.
    var cover = slides[0];
    var coverParagraphs = (cover.paragraphs || []).slice();
    var presTitle = coverParagraphs[0] || options.fallbackTitle || 'Untitled';
    var presSubtitle = coverParagraphs[1] || '';

    // Collect images (skip tiny decorations) and remember their slide origin.
    var MIN_BYTES = 4000;
    var images = [];
    var imageIndexBySlide = {};
    for (var i = 0; i < slides.length; i++) {
      var s = slides[i];
      if (!s.images) continue;
      // Pick the largest image per slide (most likely the hero, not a logo).
      var biggest = null;
      for (var j = 0; j < s.images.length; j++) {
        var img = s.images[j];
        if (img.size < MIN_BYTES) continue;
        if (!biggest || img.size > biggest.size) biggest = img;
      }
      if (biggest) {
        imageIndexBySlide[s.n] = images.length;
        images.push({
          dataUrl: biggest.dataUrl,
          caption: '',
          originSlide: s.n,
        });
      }
    }

    var contentSlides = slides.slice(1);
    if (!contentSlides.length) contentSlides = slides;

    var ctx = { imageIndexBySlide: imageIndexBySlide, sideToggle: 0 };
    var sections = [];
    for (var k = 0; k < contentSlides.length; k++) {
      var slide = contentSlides[k];
      var built = buildBlocksForSlide(slide, ctx);
      var heading = built.heading || ('Section ' + (k + 1));
      sections.push({
        id: slugifyId(heading, k),
        label: shortLabel(heading) || ('Section ' + (k + 1)),
        eyebrow: pickEyebrow(heading, k),
        heading: heading,
        lead: built.lead,
        blocks: built.blocks,
      });
    }

    return {
      type: 'web',
      title: presTitle,
      subtitle: presSubtitle,
      logoDataUrl: null,
      sections: sections,
      images: images,
      createdAt: new Date().toISOString(),
    };
  }

  global.PptxParser = {
    extractPptData: extractPptData,
    slidesToFlipcloud: slidesToFlipcloud,
    blobToDataUrl: blobToDataUrl,
    decodeXml: decodeXml,
  };
})(typeof window !== 'undefined' ? window : this);
