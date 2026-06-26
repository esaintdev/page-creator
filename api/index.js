const express = require('express');
const path = require('path');

const app = express();
app.use(express.json({ limit: '10mb' }));

// Load .env for local dev
try { require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') }); } catch (e) {}

// Serve static files for local dev
app.use(express.static(path.join(__dirname, '..', 'public')));

const WP_URL = process.env.WP_URL?.replace(/\/+$/, '');
const WP_USER = process.env.WP_USER;
const WP_APP_PASS = process.env.WP_APP_PASS;
const AUTH = WP_USER && WP_APP_PASS ? Buffer.from(`${WP_USER}:${WP_APP_PASS}`).toString('base64') : '';

async function wpFetch(endpoint, options = {}) {
  const url = `${WP_URL}/wp-json${endpoint}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Basic ${AUTH}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
  return data;
}

function escHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const PATTERN_ID = 5746;
const ORIGINAL_IMAGES = [
  { url: 'https://m25chauffeurs.com/wp-content/uploads/2026/03/ChatGPT-Image-May-24-2026-11_57_11-AM-1.png', id: 32395 },
  { url: 'https://m25chauffeurs.com/wp-content/uploads/2026/05/Premium-Wedding-Chauffeur-Service-in-Tulse-Hill-with-bentley.png', id: 32322 },
  { url: 'https://m25chauffeurs.com/wp-content/uploads/2026/05/Rolls-Royce-Chauffeur-Hire-in-Liverpool.png', id: 32500 },
];

// GET /api/pattern
app.get('/api/pattern', async (req, res) => {
  try {
    const pattern = await wpFetch(`/wp/v2/blocks/${PATTERN_ID}?_fields=id,title,content`);
    res.json({ success: true, content: pattern.content?.raw || '' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/upload — accepts base64 data URL or raw buffer
app.post('/api/upload', async (req, res) => {
  try {
    const { file: fileData, filename, mimeType } = req.body;
    if (!fileData) return res.status(400).json({ success: false, error: 'No file data provided' });

    // Decode base64
    const base64Data = fileData.includes('base64,') ? fileData.split('base64,')[1] : fileData;
    const buffer = Buffer.from(base64Data, 'base64');
    const detectedMime = mimeType || (filename?.endsWith('.png') ? 'image/png' : 'image/jpeg');

    const url = `${WP_URL}/wp-json/wp/v2/media`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${AUTH}`,
        'Content-Disposition': `attachment; filename="${filename || 'upload.png'}"`,
        'Content-Type': detectedMime,
      },
      body: buffer,
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.message || `HTTP ${response.status}`);

    res.json({
      success: true,
      id: data.id,
      url: data.source_url,
      title: data.title?.rendered || filename,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/create-page
app.post('/api/create-page', async (req, res) => {
  try {
    const { title, status, sections, readMore } = req.body;

    const pattern = await wpFetch(`/wp/v2/blocks/${PATTERN_ID}?_fields=id,title,content`);
    let content = pattern.content?.raw || '';

    // ── Section 1: text left (empty heading + paragraph), image right ──
    if (sections[0]?.heading) {
      content = content.replace(
        '<h3 class="wp-block-heading has-text-align-left"></h3>',
        `<h3 class="wp-block-heading has-text-align-left">${escHtml(sections[0].heading)}</h3>`
      );
    }
    content = content.replace('<p></p>', `<p>${escHtml(sections[0]?.paragraph || '')}</p>`);
    if (sections[0]?.imageUrl) {
      content = replaceImage(content, 0, sections[0].imageUrl, sections[0].imageId);
    }

    // ── Section 2: image left, text right ──
    if (sections[1]?.heading) {
      content = content.replace('Highlight and paste your subheading', escHtml(sections[1].heading));
    }
    if (sections[1]?.paragraph) {
      content = content.replace('Highlight and paste your paragraph', escHtml(sections[1].paragraph));
    }
    if (sections[1]?.imageUrl) {
      content = replaceImage(content, 1, sections[1].imageUrl, sections[1].imageId);
    }

    // ── Section 3: text left, image right ──
    if (sections[2]?.heading) {
      content = content.replace('Highlight and paste your subheading', escHtml(sections[2].heading));
    }
    if (sections[2]?.paragraph) {
      content = content.replace('Highlight and paste your paragraph', escHtml(sections[2].paragraph));
    }
    if (sections[2]?.imageUrl) {
      content = replaceImage(content, 2, sections[2].imageUrl, sections[2].imageId);
    }

    // ── Read More accordion ──
    if (readMore !== undefined) {
      content = content.replace(
        /(<!-- wp:accordion-panel[\s\S]*?)(<p><\/p>)([\s\S]*?<!-- \/wp:accordion-panel -->)/,
        `$1<p>${escHtml(readMore || '')}</p>$3`
      );
    }

    const pageData = await wpFetch('/wp/v2/pages', {
      method: 'POST',
      body: JSON.stringify({
        title: title || 'New Page',
        status: status || 'draft',
        content: content,
      }),
    });

    res.json({
      success: true,
      id: pageData.id,
      link: pageData.link,
      title: pageData.title?.rendered,
      status: pageData.status,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

function replaceImage(html, index, newUrl, newId) {
  const old = ORIGINAL_IMAGES[index];
  let result = html.replace(old.url, newUrl);
  if (newId) {
    result = result.replace(`wp-image-${old.id}`, `wp-image-${newId}`);
    result = result.replace(`"id":${old.id}`, `"id":${newId}`);
  }
  return result;
}

// Local dev
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Page Creator: http://localhost:${PORT}`);
    console.log(`WordPress: ${WP_URL}`);
  });
}

module.exports = app;
