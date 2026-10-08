// Servidor web y proxy privado para consultar noticias de Colombia.
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, relative, resolve, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDirectory = dirname(fileURLToPath(import.meta.url));
const newsCacheDuration = 6 * 60 * 60 * 1000;
let cachedNews = null;
let cacheExpiresAt = 0;
let pendingNewsRequest = null;

// Lee el archivo local de variables sin instalar dependencias adicionales.
const loadEnvironmentFile = async () => {
  const environmentPath = resolve(rootDirectory, '.env');
  if (!existsSync(environmentPath)) return;

  const contents = await readFile(environmentPath, 'utf8');
  contents.split(/\r?\n/).forEach((line) => {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]] !== undefined) return;
    const value = match[2].replace(/^(?:"(.*)"|'(.*)')$/, (_, doubleQuoted, singleQuoted) => doubleQuoted ?? singleQuoted);
    process.env[match[1]] = value;
  });
};

const sendJson = (response, statusCode, payload, headers = {}) => {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers
  });
  response.end(JSON.stringify(payload));
};

const safeHttpsUrl = (value) => {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
};

const plainText = (value, maximumLength = 500) => {
  if (typeof value !== 'string') return '';
  return value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maximumLength);
};

// Convierte la respuesta del proveedor al contrato mínimo que consume la landing.
const normalizeArticle = (article) => {
  const url = safeHttpsUrl(article?.href);
  if (!url) return null;

  const category = Array.isArray(article.categories)
    ? article.categories.find((entry) => entry?.name || entry?.id)
    : null;
  const date = typeof article.published_at === 'string' && !Number.isNaN(Date.parse(article.published_at))
    ? new Date(article.published_at).toISOString()
    : null;

  return {
    title: plainText(article.title, 240) || 'Noticia de Colombia',
    description: plainText(article.description || article.body, 500),
    url,
    image: safeHttpsUrl(article.image),
    publishedAt: date,
    source: plainText(article.source?.domain || article.source?.name, 100),
    category: plainText(category?.name || category?.id, 80) || 'Actualidad nacional'
  };
};

// Consulta noticias de fuentes colombianas y conserva el resultado para respetar el nivel gratuito.
const getColombianNews = async () => {
  const apiKey = process.env.APITUBE_API_KEY?.trim();
  if (!apiKey) {
    return {
      status: 503,
      payload: {
        error: 'Falta configurar APITUBE_API_KEY en el archivo .env.',
        setupRequired: true
      }
    };
  }

  if (cachedNews && Date.now() < cacheExpiresAt) {
    return { status: 200, payload: cachedNews, cache: 'HIT' };
  }

  if (pendingNewsRequest) return pendingNewsRequest;

  pendingNewsRequest = (async () => {
  const requestBody = {
    'source.country.code': 'co',
    'language.code': 'es',
    'sort.by': 'published_at',
    'sort.order': 'desc',
    per_page: 10,
    page: 1
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    let upstreamResponse;
    try {
      upstreamResponse = await fetch('https://api.apitube.io/v1/news/everything', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-API-Key': apiKey
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }

    const upstreamPayload = await upstreamResponse.json().catch(() => ({}));
    if (!upstreamResponse.ok) {
      const providerMessage = upstreamPayload.errors?.[0]?.message;
      if (upstreamResponse.status === 401) {
        return { status: 502, payload: { error: 'La clave de APITube no es válida. Revísala en el archivo .env.' } };
      }
      if (upstreamResponse.status === 429) {
        return { status: 503, payload: { error: 'Se alcanzó el límite gratuito de consultas. Las noticias se volverán a cargar cuando se renueve la cuota.' } };
      }
      return {
        status: 502,
        payload: { error: providerMessage || 'La fuente de noticias no pudo completar la consulta.' }
      };
    }

    const articles = Array.isArray(upstreamPayload.results)
      ? upstreamPayload.results.map(normalizeArticle).filter(Boolean).slice(0, 4)
      : [];
    const payload = { updatedAt: new Date().toISOString(), articles };
    cachedNews = payload;
    cacheExpiresAt = Date.now() + newsCacheDuration;
    return { status: 200, payload, cache: 'MISS' };
  } catch (error) {
    const message = error.name === 'AbortError'
      ? 'La consulta de noticias tardó demasiado. Intenta de nuevo más tarde.'
      : 'No fue posible conectar con APITube. Revisa la conexión e intenta de nuevo.';
    return { status: 502, payload: { error: message } };
  }
  })();

  try {
    return await pendingNewsRequest;
  } finally {
    pendingNewsRequest = null;
  }
};

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.json': 'application/json; charset=utf-8'
};

// Sirve la landing y el resto de páginas del proyecto desde el mismo origen.
const serveStaticFile = async (requestPath, response) => {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(requestPath);
  } catch {
    sendJson(response, 400, { error: 'La ruta solicitada no es válida.' });
    return;
  }

  if (decodedPath.split('/').some((segment) => segment.startsWith('.'))) {
    sendJson(response, 404, { error: 'No se encontró el recurso solicitado.' });
    return;
  }

  const requestedPath = decodedPath === '/' ? '/index.html' : decodedPath;
  const filePath = resolve(rootDirectory, `.${requestedPath}`);
  const relativePath = relative(rootDirectory, filePath);
  if (relativePath.startsWith(`..${sep}`) || relativePath === '..' || isAbsolute(relativePath)) {
    sendJson(response, 403, { error: 'No se permite acceder a esa ruta.' });
    return;
  }

  try {
    const fileStats = await stat(filePath);
    if (!fileStats.isFile()) throw new Error('El recurso no es un archivo.');
    const file = await readFile(filePath);
    response.writeHead(200, {
      'Content-Type': contentTypes[extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': extname(filePath).toLowerCase() === '.html' ? 'no-cache' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff'
    });
    response.end(file);
  } catch {
    sendJson(response, 404, { error: 'No se encontró el recurso solicitado.' });
  }
};

await loadEnvironmentFile();

const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '0.0.0.0';

const server = createServer(async (request, response) => {
  const requestUrl = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  if (requestUrl.pathname === '/api/noticias') {
    if (request.method !== 'GET') {
      sendJson(response, 405, { error: 'Este endpoint solo acepta solicitudes GET.' }, { Allow: 'GET' });
      return;
    }
    const result = await getColombianNews();
    sendJson(response, result.status, result.payload, {
      'Cache-Control': result.status === 200 ? 'public, max-age=300' : 'no-store',
      'X-API-Cache': result.cache || 'BYPASS'
    });
    return;
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendJson(response, 405, { error: 'Este servidor solo acepta solicitudes GET.' }, { Allow: 'GET, HEAD' });
    return;
  }
  await serveStaticFile(requestUrl.pathname, response);
});

server.listen(port, host, () => {
  console.log(`Denuncias Virtuales disponible en http://localhost:${port}`);
});
