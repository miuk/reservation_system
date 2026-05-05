import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 8080);
const backendUrl = (process.env.BACKEND_URL || '').replace(/\/$/, '');
const backendAudience = process.env.BACKEND_AUDIENCE || backendUrl;

if (!backendUrl) {
  throw new Error('BACKEND_URL is required for the frontend proxy.');
}

const app = express();
let cachedCloudRunToken = null;

function shouldUseCloudRunIdentity() {
  return !backendUrl.includes('localhost') && !backendUrl.includes('127.0.0.1');
}

async function getCloudRunIdentityToken() {
  if (!shouldUseCloudRunIdentity()) return null;
  const now = Math.floor(Date.now() / 1000);
  if (cachedCloudRunToken && cachedCloudRunToken.expiresAt - 60 > now) {
    return cachedCloudRunToken.token;
  }

  const url = new URL(
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity'
  );
  url.searchParams.set('audience', backendAudience);
  url.searchParams.set('format', 'full');

  const response = await fetch(url, {
    headers: { 'Metadata-Flavor': 'Google' }
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch Cloud Run identity token: ${response.status}`);
  }

  const token = await response.text();
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  cachedCloudRunToken = { token, expiresAt: Number(payload.exp || now + 300) };
  return token;
}

app.use('/api', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  try {
    const targetUrl = `${backendUrl}${req.originalUrl}`;
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (!value) continue;
      const lower = key.toLowerCase();
      if (['host', 'connection', 'content-length'].includes(lower)) continue;
      headers.set(key, Array.isArray(value) ? value.join(',') : value);
    }

    const cloudRunToken = await getCloudRunIdentityToken();
    if (cloudRunToken) {
      headers.set('X-Serverless-Authorization', `Bearer ${cloudRunToken}`);
    }

    const response = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req.body
    });

    res.status(response.status);
    response.headers.forEach((value, key) => {
      if (!['content-encoding', 'transfer-encoding'].includes(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    });
    res.send(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error('Backend proxy failed:', error);
    res.status(502).json({ error: 'backend への接続に失敗しました。' });
  }
});

app.use(
  express.static(path.join(__dirname, 'dist'), {
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-store');
      }
    }
  })
);
app.get('*', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(port, () => {
  console.log(`frontend listening on ${port}`);
});
