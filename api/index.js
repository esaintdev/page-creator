const express = require('express');
const path = require('path');
const fs = require('fs');
const mammoth = require('mammoth');

const app = express();
app.use(express.json({ limit: '10mb' }));

try { require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') }); } catch (e) {}
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── Credential helpers ──
function getCreds(req) {
  const url = req.headers['x-wp-url'] || process.env.WP_URL;
  const user = req.headers['x-wp-user'] || process.env.WP_USER;
  const pass = req.headers['x-wp-app-pass'] || process.env.WP_APP_PASS;
  const auth = user && pass ? Buffer.from(`${user}:${pass}`).toString('base64') : '';
  return { url: url?.replace(/\/+$/, ''), user, pass, auth };
}

async function wpFetch(endpoint, options, req) {
  const creds = options._creds || getCreds(req);
  const method = (options.method || 'GET').toUpperCase();
  const body = options.body || undefined;
  const customHeaders = options.headers || {};

  const url = `${creds.url}/wp-json${endpoint}`;
  const res = await fetch(url, {
    method,
    headers: {
      'Authorization': `Basic ${creds.auth}`,
      'Content-Type': 'application/json',
      ...customHeaders,
    },
    body,
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { message: text }; }

  if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
  return data;
}

async function wpFetchRaw(endpoint, options, req) {
  const creds = options._creds || getCreds(req);
  const url = `${creds.url}/wp-json${endpoint}`;
  const res = await fetch(url, {
    method: options.method || 'POST',
    headers: {
      'Authorization': `Basic ${creds.auth}`,
      ...(options.headers || {}),
    },
    body: options.body,
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { message: text }; }
  if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
  return data;
}

const PATTERN_ID = 5746;
const ORIGINAL_IMAGES = [
  { url: 'https://m25chauffeurs.com/wp-content/uploads/2026/03/ChatGPT-Image-May-24-2026-11_57_11-AM-1.png', id: 32395 },
  { url: 'https://m25chauffeurs.com/wp-content/uploads/2026/05/Premium-Wedding-Chauffeur-Service-in-Tulse-Hill-with-bentley.png', id: 32322 },
  { url: 'https://m25chauffeurs.com/wp-content/uploads/2026/05/Rolls-Royce-Chauffeur-Hire-in-Liverpool.png', id: 32500 },
];

const LINK_RULES = [
  { phrase: 'Why Choose M25 Chauffeurs Ltd', url: 'https://m25chauffeurs.com/book-now/' },
  { phrase: 'Book Your Luxury Chauffeur Service with M25 Chauffeurs Ltd', url: 'https://m25chauffeurs.com/book-now/' },
];

function escHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function paraBlocks(text) {
  if (!text) return '';
  const normalized = text.replace(/\r\n/g, '\n').trim();
  let parts;
  if (normalized.includes('\n\n')) {
    parts = normalized.split(/\n{2,}/);
  } else if (normalized.includes('\n')) {
    parts = normalized.split('\n');
  } else {
    parts = normalized.split(/\.\s+/).filter(Boolean);
    if (parts.length > 1) {
      parts = parts.map((s, i, a) => i < a.length - 1 ? s + '.' : s);
    }
  }
  return parts.map(p => p.trim()).filter(Boolean)
    .map(p => `<!-- wp:paragraph -->\n<p>${escHtml(p)}</p>\n<!-- /wp:paragraph -->`)
    .join('\n');
}

function autoLink(text) {
  let result = text;
  for (const rule of LINK_RULES) {
    const re = new RegExp(rule.phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    result = result.replace(re, `<a href="${rule.url}" target="_blank" rel="noopener">$&</a>`);
  }
  return result;
}

function replaceImage(html, index, newUrl, newId) {
  const old = ORIGINAL_IMAGES[index];
  let result = html.replace(old.url, newUrl);
  if (newId) {
    result = result.replace(`wp-image-${old.id}`, `wp-image-${newId}`);
    result = result.replace(`"id":${old.id}`, `"id":${newId}`);
  }
  return result;
}

function extractVehicleName(title) {
  const parts = title.split(/\b(?:with|by|in)\s+/i);
  return parts.length > 1 ? parts[parts.length - 1].trim() : null;
}

async function autoMatchVehicleImages(content, vehicleName, req) {
  if (!vehicleName) return content;
  try {
    const results = await wpFetch(`/wp/v2/media?search=${encodeURIComponent(vehicleName)}&per_page=50&_fields=id,source_url`, {}, req);
    if (!results?.length) return content;
    const items = results.filter(r => r.source_url);
    if (!items.length) return content;

    // Shuffle to get random picks each time
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }

    // Extract current image URLs by position
    const imgUrls = [];
    const re = /src="([^"]+)"/g;
    let m;
    while ((m = re.exec(content)) !== null) imgUrls.push(m[1]);

    // Extract current image IDs by position
    const ids = [];
    const idRe = /"id":(\d+)/g;
    while ((m = idRe.exec(content)) !== null) ids.push(m[1]);

    const first = items[0];
    const second = items[1] || first;

    // Replace img0 and img2 with first result, img1 with second result
    if (imgUrls[0]) content = content.replace(imgUrls[0], first.source_url);
    if (ids[0]) content = content.replace(`"id":${ids[0]}`, `"id":${first.id}`);
    if (ids[0]) content = content.replace(`wp-image-${ids[0]}`, `wp-image-${first.id}`);

    if (imgUrls[1]) content = content.replace(imgUrls[1], second.source_url);
    if (ids[1]) content = content.replace(`"id":${ids[1]}`, `"id":${second.id}`);
    if (ids[1]) content = content.replace(`wp-image-${ids[1]}`, `wp-image-${second.id}`);

    if (imgUrls[2]) content = content.replace(imgUrls[2], first.source_url);
    if (ids[2]) content = content.replace(`"id":${ids[2]}`, `"id":${first.id}`);
    if (ids[2]) content = content.replace(`wp-image-${ids[2]}`, `wp-image-${first.id}`);
  } catch {}
  return content;
}

// ── Verify credentials ──
app.post('/api/verify', async (req, res) => {
  try {
    const data = await wpFetch('/wp/v2/users/me?_fields=id,name,slug', {}, req);
    res.json({ success: true, user: { id: data.id, name: data.name, slug: data.slug } });
  } catch (err) {
    res.status(401).json({ success: false, error: err.message });
  }
});

// ── Get pattern ──
app.get('/api/pattern', async (req, res) => {
  try {
    const pattern = await wpFetch(`/wp/v2/blocks/${PATTERN_ID}?_fields=id,title,content`, {}, req);
    res.json({ success: true, content: pattern.content?.raw || '' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Upload image ──
app.post('/api/upload', async (req, res) => {
  try {
    const { file: fileData, filename, mimeType } = req.body;
    if (!fileData) return res.status(400).json({ success: false, error: 'No file data' });

    const base64Data = fileData.includes('base64,') ? fileData.split('base64,')[1] : fileData;
    const buffer = Buffer.from(base64Data, 'base64');
    const detectedMime = mimeType || (filename?.endsWith('.png') ? 'image/png' : 'image/jpeg');

    const data = await wpFetchRaw('/wp/v2/media', {
      method: 'POST',
      headers: {
        'Content-Disposition': `attachment; filename="${filename || 'upload.png'}"`,
        'Content-Type': detectedMime,
        'Content-Length': buffer.length.toString(),
      },
      body: buffer,
    }, req);

    res.json({ success: true, id: data.id, url: data.source_url, title: data.title?.rendered || filename });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Create page ──
app.post('/api/create-page', async (req, res) => {
  try {
    const { title, status, sections, readMore, seo } = req.body;

    const pattern = await wpFetch(`/wp/v2/blocks/${PATTERN_ID}?_fields=id,title,content`, {}, req);
    let content = pattern.content?.raw || '';

    if (sections[0]?.heading) {
      content = content.replace(
        '<h3 class="wp-block-heading has-text-align-left"></h3>',
        `<h3 class="wp-block-heading has-text-align-left">${escHtml(sections[0].heading)}</h3>`
      );
    }
    if (sections[0]?.paragraph) {
      content = content.replace(
        '<!-- wp:paragraph -->\n<p></p>\n<!-- /wp:paragraph -->',
        paraBlocks(sections[0].paragraph)
      );
    }

    if (sections[1]?.heading) content = content.replace('Highlight and paste your subheading', escHtml(sections[1].heading));
    if (sections[1]?.paragraph) {
      content = content.replace(
        '<!-- wp:paragraph -->\n<p>Highlight and paste your paragraph</p>\n<!-- /wp:paragraph -->',
        paraBlocks(sections[1].paragraph)
      );
    }

    if (sections[2]?.heading) content = content.replace('Highlight and paste your subheading', escHtml(sections[2].heading));
    if (sections[2]?.paragraph) {
      content = content.replace(
        '<!-- wp:paragraph -->\n<p>Highlight and paste your paragraph</p>\n<!-- /wp:paragraph -->',
        paraBlocks(sections[2].paragraph)
      );
    }

    if (readMore !== undefined) {
      const raw = (readMore || '').replace(/\r\n/g, '\n').trim();
      const blocks = raw.includes('\n\n')
        ? raw.split(/\n{2,}/).map(p => p.trim()).filter(Boolean)
        : raw.split('\n').map(l => l.trim()).filter(Boolean);
      const paras = blocks.map(p => {
        const text = autoLink(escHtml(p));
        const isHeading = p.length < 100 && !/[.!:]$/.test(p.trim());
        return `<!-- wp:paragraph -->\n<p>${isHeading ? `<strong>${text}</strong>` : text}</p>\n<!-- /wp:paragraph -->`;
      }).join('\n') || `<p>${escHtml(readMore || '')}</p>`;

      content = content.replace(
        /(<!-- wp:accordion-panel[\s\S]*?)<!--\s*wp:paragraph[\s\S]*?\/wp:paragraph\s*-->([\s\S]*?<!-- \/wp:accordion-panel -->)/,
        `$1\n${paras}\n$2`
      );
    }

    if (seo?.metaDescription) {
      content = content.replace(/alt=""/g, `alt="${escHtml(seo.metaDescription)}"`);
    }

    const pageData = await wpFetch('/wp/v2/pages', {
      method: 'POST',
      body: JSON.stringify({ title: title || 'New Page', status: status || 'draft', content }),
    }, req);

    if (seo && (seo.focusKeyphrase || seo.metaDescription || seo.seoTitle || seo.additionalKeyphrases?.length)) {
      const kp = {};
      if (seo.focusKeyphrase) kp.focus = { keyphrase: seo.focusKeyphrase };
      if (seo.additionalKeyphrases?.length) {
        kp.additional = seo.additionalKeyphrases.filter(Boolean).map(k => ({ keyphrase: k }));
      }
      await wpFetch('/aioseo/v1/post', {
        method: 'POST',
        _creds: getCreds(req),
        body: JSON.stringify({
          id: pageData.id,
          postId: String(pageData.id),
          post_type: 'page',
          postType: 'page',
          ...(seo.seoTitle ? { title: `#post_title #separator_sa ${seo.seoTitle}` } : {}),
          ...(seo.metaDescription ? { description: seo.metaDescription } : {}),
          ...(Object.keys(kp).length ? { keyphrases: kp } : {}),
        }),
      }, req);
    }

    res.json({ success: true, id: pageData.id, link: pageData.link, title: pageData.title?.rendered, status: pageData.status });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Batch import from .docx files ──
function parseDocxLines(lines) {
  const nonEmpty = lines.filter(Boolean);
  const result = { additionalKeyphrases: [] };
  let bodyIdx = 0;

  for (let i = 0; i < nonEmpty.length; i++) {
    const line = nonEmpty[i];
    const lower = line.toLowerCase();

    if (lower.startsWith('page title:')) {
      const val = line.substring(line.indexOf(':') + 1).trim();
      result.title = val || (i + 1 < nonEmpty.length ? nonEmpty[++i] : '');
    } else if (lower.startsWith('seo title:')) {
      const val = line.substring(line.indexOf(':') + 1).trim();
      result.seoTitle = val || (i + 1 < nonEmpty.length ? nonEmpty[++i] : '');
    } else if (lower.startsWith('focus keyword:')) {
      const val = line.substring(line.indexOf(':') + 1).trim();
      result.focusKeyphrase = val || (i + 1 < nonEmpty.length ? nonEmpty[++i] : '');
    } else if (lower.startsWith('additional keyword:')) {
      const val = line.substring(line.indexOf(':') + 1).trim();
      const kw = val || (i + 1 < nonEmpty.length ? nonEmpty[++i] : '');
      if (kw) result.additionalKeyphrases.push(kw);
    } else if (lower.startsWith('meta description:')) {
      const val = line.substring(line.indexOf(':') + 1).trim();
      result.metaDescription = val || (i + 1 < nonEmpty.length ? nonEmpty[++i] : '');
      bodyIdx = i + 1;
      break;
    }
  }

  // If no Page Title label was found, use the first non-label non-empty line as title
  if (!result.title) {
    const rest = nonEmpty.slice(bodyIdx);
    // Skip first body line only if it's a known leftover label
    const first = rest.find(l => !/^(seo title|focus keyword|additional keyword|meta description):/i.test(l));
    if (first) result.title = first;
  }

  const body = nonEmpty.slice(bodyIdx);
  // Remove title line from body if it was inferred (no label)
  const cleanBody = result.title && !nonEmpty.some(l => l.toLowerCase().startsWith('page title:'))
    ? body.filter(l => l !== result.title)
    : body;
  const groups = [];
  let current = null;

  for (const line of cleanBody) {
    const isH = line.length < 100 && !/[.!:]$/.test(line.trim());
    if (isH) {
      current = { heading: line, paragraphs: [] };
      groups.push(current);
    } else if (current) {
      current.paragraphs.push(line);
    }
  }

  result.sections = groups.slice(0, 3).map(g => ({
    heading: g.heading,
    paragraph: g.paragraphs.join(' '),
  }));

  result.readMore = groups.slice(3).map(g =>
    [g.heading, ...g.paragraphs].join('\n\n')
  ).join('\n\n');

  return result;
}

app.post('/api/batch-import', async (req, res) => {
  try {
    const docsDir = path.join(__dirname, '..', 'documents');
    const processedDir = path.join(docsDir, 'processed');

    const files = fs.readdirSync(docsDir).filter(f => f.endsWith('.docx'));
    if (!files.length) return res.json({ success: true, pages: [], message: 'No .docx files found' });

    const results = [];

    for (const [idx, file] of files.entries()) {
      if (idx > 0) await new Promise(r => setTimeout(r, 200));
      const filePath = path.join(docsDir, file);
      const { value: text } = await mammoth.extractRawText({ path: filePath });
      const parsed = parseDocxLines(text.split('\n').map(l => l.trim()));

      if (!parsed.title) continue;

      const pattern = await wpFetch(`/wp/v2/blocks/${PATTERN_ID}?_fields=id,title,content`, {}, req);
      let content = pattern.content?.raw || '';

      if (parsed.sections[0]?.heading) {
        content = content.replace(
          '<h3 class="wp-block-heading has-text-align-left"></h3>',
          `<h3 class="wp-block-heading has-text-align-left">${escHtml(parsed.sections[0].heading)}</h3>`
        );
      }
      if (parsed.sections[0]?.paragraph) {
        content = content.replace(
          '<!-- wp:paragraph -->\n<p></p>\n<!-- /wp:paragraph -->',
          paraBlocks(parsed.sections[0].paragraph)
        );
      }

      if (parsed.sections[1]?.heading) content = content.replace('Highlight and paste your subheading', escHtml(parsed.sections[1].heading));
      if (parsed.sections[1]?.paragraph) {
        content = content.replace(
          '<!-- wp:paragraph -->\n<p>Highlight and paste your paragraph</p>\n<!-- /wp:paragraph -->',
          paraBlocks(parsed.sections[1].paragraph)
        );
      }

      if (parsed.sections[2]?.heading) content = content.replace('Highlight and paste your subheading', escHtml(parsed.sections[2].heading));
      if (parsed.sections[2]?.paragraph) {
        content = content.replace(
          '<!-- wp:paragraph -->\n<p>Highlight and paste your paragraph</p>\n<!-- /wp:paragraph -->',
          paraBlocks(parsed.sections[2].paragraph)
        );
      }

      if (parsed.readMore) {
        const raw = parsed.readMore.replace(/\r\n/g, '\n').trim();
        const blocks = raw.includes('\n\n')
          ? raw.split(/\n{2,}/).map(p => p.trim()).filter(Boolean)
          : raw.split('\n').map(l => l.trim()).filter(Boolean);
        const paras = blocks.map(p => {
          const text = autoLink(escHtml(p));
          const isHeading = p.length < 100 && !/[.!:]$/.test(p.trim());
          return `<!-- wp:paragraph -->\n<p>${isHeading ? `<strong>${text}</strong>` : text}</p>\n<!-- /wp:paragraph -->`;
        }).join('\n');

        content = content.replace(
          /(<!-- wp:accordion-panel[\s\S]*?)<!--\s*wp:paragraph[\s\S]*?\/wp:paragraph\s*-->([\s\S]*?<!-- \/wp:accordion-panel -->)/,
          `$1\n${paras}\n$2`
        );
      }

      if (parsed.metaDescription) {
        content = content.replace(/alt=""/g, `alt="${escHtml(parsed.metaDescription)}"`);
      }

      // Auto-match vehicle images from media library
      if (parsed.title) {
        const vehicle = extractVehicleName(parsed.title);
        if (vehicle) content = await autoMatchVehicleImages(content, vehicle, req);
      }

      const pageData = await wpFetch('/wp/v2/pages', {
        method: 'POST',
        body: JSON.stringify({ title: parsed.title, status: 'publish', content }),
      }, req);

      if (parsed.focusKeyphrase || parsed.metaDescription || parsed.additionalKeyphrases?.length || parsed.seoTitle) {
        const kp = {};
        if (parsed.focusKeyphrase) kp.focus = { keyphrase: parsed.focusKeyphrase };
        if (parsed.additionalKeyphrases?.length) {
          kp.additional = parsed.additionalKeyphrases.filter(Boolean).map(k => ({ keyphrase: k }));
        }
        await wpFetch('/aioseo/v1/post', {
          method: 'POST',
          _creds: getCreds(req),
          body: JSON.stringify({
            id: pageData.id,
            postId: String(pageData.id),
            post_type: 'page',
            postType: 'page',
            ...(parsed.metaDescription ? { description: parsed.metaDescription } : {}),
            ...(parsed.seoTitle ? { title: `#post_title #separator_sa ${parsed.seoTitle}` } : {}),
            ...(Object.keys(kp).length ? { keyphrases: kp } : {}),
          }),
        }, req);
      }

      fs.renameSync(filePath, path.join(processedDir, file));
      results.push({ id: pageData.id, title: parsed.title, link: pageData.link });
    }

    res.json({ success: true, pages: results });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Import single .docx from upload ──
app.post('/api/import-docx', async (req, res) => {
  try {
    const { file: fileData, filename } = req.body;
    if (!fileData) return res.status(400).json({ success: false, error: 'No file data' });

    const base64Data = fileData.includes('base64,') ? fileData.split('base64,')[1] : fileData;
    const buffer = Buffer.from(base64Data, 'base64');
    const { value: text } = await mammoth.extractRawText({ buffer });

    const parsed = parseDocxLines(text.split('\n').map(l => l.trim()));
    if (!parsed.title) return res.status(400).json({ success: false, error: 'Could not parse page title from document' });

    const pattern = await wpFetch(`/wp/v2/blocks/${PATTERN_ID}?_fields=id,title,content`, {}, req);
    let content = pattern.content?.raw || '';

    if (parsed.sections[0]?.heading) {
      content = content.replace(
        '<h3 class="wp-block-heading has-text-align-left"></h3>',
        `<h3 class="wp-block-heading has-text-align-left">${escHtml(parsed.sections[0].heading)}</h3>`
      );
    }
    if (parsed.sections[0]?.paragraph) {
      content = content.replace(
        '<!-- wp:paragraph -->\n<p></p>\n<!-- /wp:paragraph -->',
        paraBlocks(parsed.sections[0].paragraph)
      );
    }

    if (parsed.sections[1]?.heading) content = content.replace('Highlight and paste your subheading', escHtml(parsed.sections[1].heading));
    if (parsed.sections[1]?.paragraph) {
      content = content.replace(
        '<!-- wp:paragraph -->\n<p>Highlight and paste your paragraph</p>\n<!-- /wp:paragraph -->',
        paraBlocks(parsed.sections[1].paragraph)
      );
    }

    if (parsed.sections[2]?.heading) content = content.replace('Highlight and paste your subheading', escHtml(parsed.sections[2].heading));
    if (parsed.sections[2]?.paragraph) {
      content = content.replace(
        '<!-- wp:paragraph -->\n<p>Highlight and paste your paragraph</p>\n<!-- /wp:paragraph -->',
        paraBlocks(parsed.sections[2].paragraph)
      );
    }

    if (parsed.readMore) {
      const raw = parsed.readMore.replace(/\r\n/g, '\n').trim();
      const blocks = raw.includes('\n\n')
        ? raw.split(/\n{2,}/).map(p => p.trim()).filter(Boolean)
        : raw.split('\n').map(l => l.trim()).filter(Boolean);
      const paras = blocks.map(p => {
        const text = autoLink(escHtml(p));
        const isHeading = p.length < 100 && !/[.!:]$/.test(p.trim());
        return `<!-- wp:paragraph -->\n<p>${isHeading ? `<strong>${text}</strong>` : text}</p>\n<!-- /wp:paragraph -->`;
      }).join('\n');

      content = content.replace(
        /(<!-- wp:accordion-panel[\s\S]*?)<!--\s*wp:paragraph[\s\S]*?\/wp:paragraph\s*-->([\s\S]*?<!-- \/wp:accordion-panel -->)/,
        `$1\n${paras}\n$2`
      );
    }

    if (parsed.metaDescription) {
      content = content.replace(/alt=""/g, `alt="${escHtml(parsed.metaDescription)}"`);
    }

    // Auto-match vehicle images from media library
    if (parsed.title) {
      const vehicle = extractVehicleName(parsed.title);
      if (vehicle) content = await autoMatchVehicleImages(content, vehicle, req);
    }

    const pageData = await wpFetch('/wp/v2/pages', {
      method: 'POST',
      body: JSON.stringify({ title: parsed.title, status: 'publish', content }),
    }, req);

    if (parsed.focusKeyphrase || parsed.metaDescription || parsed.additionalKeyphrases?.length || parsed.seoTitle) {
      const kp = {};
      if (parsed.focusKeyphrase) kp.focus = { keyphrase: parsed.focusKeyphrase };
      if (parsed.additionalKeyphrases?.length) {
        kp.additional = parsed.additionalKeyphrases.filter(Boolean).map(k => ({ keyphrase: k }));
      }
      await wpFetch('/aioseo/v1/post', {
        method: 'POST',
        _creds: getCreds(req),
        body: JSON.stringify({
          id: pageData.id,
          postId: String(pageData.id),
          post_type: 'page',
          postType: 'page',
          ...(parsed.metaDescription ? { description: parsed.metaDescription } : {}),
          ...(parsed.seoTitle ? { title: `#post_title #separator_sa ${parsed.seoTitle}` } : {}),
          ...(Object.keys(kp).length ? { keyphrases: kp } : {}),
        }),
      }, req);
    }

    res.json({ success: true, id: pageData.id, link: pageData.link, title: parsed.title });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Resolve page URL to ID ──
app.post('/api/resolve-page', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ success: false, error: 'url required' });

    const slug = url.replace(/\/+$/, '').split('/').pop().split('?')[0].split('#')[0];
    if (!slug) return res.status(400).json({ success: false, error: 'Could not extract slug from URL' });

    const pages = await wpFetch(`/wp/v2/pages?slug=${encodeURIComponent(slug)}&_fields=id`, {}, req);
    if (!pages?.length) return res.status(404).json({ success: false, error: 'Page not found' });

    res.json({ success: true, id: pages[0].id });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Get page (for editing) ──
app.get('/api/get-page/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const page = await wpFetch(`/wp/v2/pages/${id}?context=edit&_fields=id,title,content`, {}, req);
    const seo = await wpFetch(`/wp/v2/pages/${id}?_fields=aioseo_meta_data`, {}, req);

    const raw = page.content?.raw || '';
    const kp = (seo.aioseo_meta_data?.keyphrases) || {};

    // Extract image URLs from content (by position, allow duplicates)
    const imgUrls = [];
    const imgRe = /src="([^"]+)"/g;
    let m;
    while ((m = imgRe.exec(raw)) !== null) {
      imgUrls.push(m[1]);
    }

    res.json({
      success: true,
      id: page.id,
      title: page.title?.raw || page.title?.rendered || '',
      images: imgUrls,
      seo: {
        title: seo.aioseo_meta_data?.title || '',
        description: seo.aioseo_meta_data?.description || '',
        focusKeyphrase: (kp.focus || {}).keyphrase || '',
        additionalKeyphrases: (kp.additional || []).map(a => a.keyphrase),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Update page (images, title, SEO) ──
app.post('/api/update-page', async (req, res) => {
  try {
    const { pageId, title, sections, seo } = req.body;
    if (!pageId) return res.status(400).json({ success: false, error: 'pageId required' });

    // Fetch current content
    const page = await wpFetch(`/wp/v2/pages/${pageId}?context=edit&_fields=id,title,content`, {}, req);
    let content = page.content?.raw || '';
    let newTitle = page.title?.raw || page.title?.rendered || '';
    if (title) newTitle = title;

    // Replace images by scanning current image URLs in order (allow duplicates)
    const imgUrls = [];
    const imgRe = /src="([^"]+)"/g;
    let m;
    while ((m = imgRe.exec(content)) !== null) {
      imgUrls.push(m[1]);
    }

    for (let i = 0; i < 3; i++) {
      if (sections?.[i]?.imageUrl && imgUrls[i]) {
        content = content.replace(imgUrls[i], sections[i].imageUrl);
        if (sections[i]?.imageId) {
          // Replace wp-image-XX and id:XX
          content = content.replace(
            /wp-image-\d+/,
            `wp-image-${sections[i].imageId}`
          );
          content = content.replace(
            /"id":\d+/,
            `"id":${sections[i].imageId}`
          );
        }
      }
    }

    // Update the page
    const updateBody = { content };
    if (title) updateBody.title = title;
    await wpFetch(`/wp/v2/pages/${pageId}`, {
      method: 'POST',
      body: JSON.stringify(updateBody),
    }, req);

    // Update AIOSEO
    if (seo && (seo.focusKeyphrase || seo.metaDescription || seo.seoTitle || seo.additionalKeyphrases?.length)) {
      const kp = {};
      if (seo.focusKeyphrase) kp.focus = { keyphrase: seo.focusKeyphrase };
      if (seo.additionalKeyphrases?.length) {
        kp.additional = seo.additionalKeyphrases.filter(Boolean).map(k => ({ keyphrase: k }));
      }
      await wpFetch('/aioseo/v1/post', {
        method: 'POST',
        _creds: getCreds(req),
        body: JSON.stringify({
          id: pageId,
          postId: String(pageId),
          post_type: 'page',
          postType: 'page',
          ...(seo.seoTitle ? { title: `#post_title #separator_sa ${seo.seoTitle}` } : {}),
          ...(seo.metaDescription ? { description: seo.metaDescription } : {}),
          ...(Object.keys(kp).length ? { keyphrases: kp } : {}),
        }),
      }, req);
    }

    res.json({ success: true, id: pageId, title: newTitle });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Page Creator: http://localhost:${PORT}`));
}

module.exports = app;
