const express = require('express');
const path = require('path');

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

function replaceImage(html, index, newUrl, newId) {
  const old = ORIGINAL_IMAGES[index];
  let result = html.replace(old.url, newUrl);
  if (newId) {
    result = result.replace(`wp-image-${old.id}`, `wp-image-${newId}`);
    result = result.replace(`"id":${old.id}`, `"id":${newId}`);
  }
  return result;
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
    if (sections[0]?.imageUrl) content = replaceImage(content, 0, sections[0].imageUrl, sections[0].imageId);

    if (sections[1]?.heading) content = content.replace('Highlight and paste your subheading', escHtml(sections[1].heading));
    if (sections[1]?.paragraph) {
      content = content.replace(
        '<!-- wp:paragraph -->\n<p>Highlight and paste your paragraph</p>\n<!-- /wp:paragraph -->',
        paraBlocks(sections[1].paragraph)
      );
    }
    if (sections[1]?.imageUrl) content = replaceImage(content, 1, sections[1].imageUrl, sections[1].imageId);

    if (sections[2]?.heading) content = content.replace('Highlight and paste your subheading', escHtml(sections[2].heading));
    if (sections[2]?.paragraph) {
      content = content.replace(
        '<!-- wp:paragraph -->\n<p>Highlight and paste your paragraph</p>\n<!-- /wp:paragraph -->',
        paraBlocks(sections[2].paragraph)
      );
    }
    if (sections[2]?.imageUrl) content = replaceImage(content, 2, sections[2].imageUrl, sections[2].imageId);

    if (readMore !== undefined) {
      const raw = (readMore || '').replace(/\r\n/g, '\n').trim();
      const blocks = raw.includes('\n\n')
        ? raw.split(/\n{2,}/).map(p => p.trim()).filter(Boolean)
        : raw.split('\n').map(l => l.trim()).filter(Boolean);
      const paras = blocks.map(p => {
        const text = escHtml(p);
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
          ...(seo.seoTitle ? { title: seo.seoTitle } : {}),
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

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Page Creator: http://localhost:${PORT}`));
}

module.exports = app;
