import { constants, createBrotliCompress, createGzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// Compress program assets only. RPC, conversations, and book data stream unchanged.
export function assetEncoding(request, response) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method !== 'GET' || response.status !== 200 || !response.body) return null;
  const cache = response.headers.get('cache-control') ?? '';
  const publicCode = /^\/(?:plugins|assets|studio|__host-assets)\//.test(path) && /\bpublic\b/i.test(cache);
  const versionedCode =
    /^\/studio\/official-novel-[a-f0-9]{16}\//.test(path) ||
    (/^\/plugins\/@deepseek-ai\/dsh-client-ui-(?:conversation|sidebar|layout|settings-general)\/client\.js$/.test(path) &&
      /^official-novel-[a-f0-9]{16}$/.test(url.searchParams.get('novel') ?? ''));
  if (!publicCode && !(versionedCode && /\bprivate\b/i.test(cache) && /\bimmutable\b/i.test(cache)))
    return null;
  if (
    response.headers.has('content-encoding') ||
    /\bno-transform\b/i.test(cache)
  )
    return null;
  if (
    !/^(?:text\/(?:javascript|css)|application\/(?:javascript|wasm))(?:;|$)/i.test(
      response.headers.get('content-type') ?? '',
    )
  )
    return null;
  const encodings = (request.headers.get('accept-encoding') ?? '').split(',').map((part) => {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    const quality = params.find((p) => /^\s*q\s*=/.test(p));
    return [name, quality ? Number(quality.split('=')[1]) : 1];
  });
  const quality = (name) =>
    (encodings.find(([key]) => key === name) ?? encodings.find(([key]) => key === '*'))?.[1] || 0;
  const gzip = quality('gzip');
  // Only send Brotli when the browser advertises it explicitly. HTTP browsers
  // do not generally advertise it outside secure origins.
  const br = encodings.find(([name]) => name === 'br')?.[1] || 0;
  if (br > 0 && br >= gzip) return 'br';
  return gzip > 0 ? 'gzip' : null;
}

export function assetDeliveryHeaders(headers, encoding) {
  const result = new Headers(headers);
  if (encoding) {
    result.delete('content-length');
    result.set('content-encoding', encoding);
    const vary = result.get('vary');
    if (!vary?.split(',').some((v) => ['*', 'accept-encoding'].includes(v.trim().toLowerCase())))
      result.set('vary', [vary, 'Accept-Encoding'].filter(Boolean).join(', '));
  }
  return result;
}

export async function streamBrowserBody(response, destination, encoding = null) {
  const input = Readable.fromWeb(response.body);
  if (encoding === 'br')
    await pipeline(input, createBrotliCompress({ params: { [constants.BROTLI_PARAM_QUALITY]: 4 } }), destination);
  else if (encoding === 'gzip') await pipeline(input, createGzip({ level: 4 }), destination);
  else await pipeline(input, destination);
}

export function novelModulePreloads(asset) {
  return [
    'bridge-core',
    'harness-navigation',
    'manuscript',
    'editor-vendor',
    'application',
    'task-message',
    'proposal-tool-view',
    'studio-theme',
  ]
    .map((name) => '<link rel="modulepreload" href="' + asset + name + '.mjs">')
    .join('');
}

export function invalidatesNativeTransports({ method, status, path, beforeEpoch, afterEpoch }) {
  return (
    method === 'POST' &&
    status >= 200 &&
    status < 400 &&
    (path === '/api/auth/logout' || beforeEpoch !== afterEpoch)
  );
}
