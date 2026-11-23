import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import {
  assetEncoding,
  assetDeliveryHeaders,
  streamBrowserBody,
  nativePluginEncoding,
  novelModulePreloads,
  invalidatesNativeTransports,
} from '../official/novel/web-performance.mjs';

const headers = {
  'content-type': 'text/javascript; charset=utf-8',
  'cache-control': 'public, max-age=31536000, immutable',
};
const request = (path, encoding = 'gzip, br', method = 'GET') =>
  new Request('https://novel.example' + path, { method, headers: { 'accept-encoding': encoding } });
test('large immutable native modules are streamed compressed without changing their bytes', async () => {
  const text = 'const 中文小说 = "完整的正文与插件";\n'.repeat(20000);
  const response = new Response(text, {
    headers: { ...headers, 'content-length': String(Buffer.byteLength(text)), vary: 'Origin' },
  });
  assert.equal(assetEncoding(request('/plugins/?combo=revision'), response), 'br');
  const delivery = assetDeliveryHeaders(response.headers, 'gzip');
  assert.equal(delivery.get('content-encoding'), 'gzip');
  assert.equal(delivery.get('content-length'), null);
  assert.equal(delivery.get('vary'), 'Origin, Accept-Encoding');
  const chunks = [];
  await streamBrowserBody(
    response,
    new Writable({
      write(chunk, encoding, done) {
        chunks.push(chunk);
        done();
      },
    }),
    'gzip',
  );
  const encoded = Buffer.concat(chunks);
  assert.equal(gunzipSync(encoded).toString('utf8'), text);
  assert(encoded.length < Buffer.byteLength(text) / 10);
  chunks.length = 0;
  await streamBrowserBody(
    new Response(text, { headers }),
    new Writable({ write(chunk, encoding, done) { chunks.push(chunk); done(); } }),
    'br',
  );
  assert.equal(brotliDecompressSync(Buffer.concat(chunks)).toString('utf8'), text);
});
test('compression excludes live streams, private files, disabled encodings and already encoded responses', () => {
  for (const path of [
    '/api/session/prompt',
    '/api/remote.mux',
    '/api/novels/book/documents',
    '/plugins/events',
  ])
    assert.equal(
      assetEncoding(
        request(path),
        new Response('event', { headers: { 'content-type': 'text/event-stream' } }),
      ),
      null,
    );
  for (const encoding of ['gzip;q=0, br', 'gzip;q=0, *;q=1', 'identity', 'gzip;q=no'])
    assert.equal(assetEncoding(request('/plugins/', encoding), new Response('code', { headers })), encoding.includes('br') ? 'br' : null);
  for (const extra of [
    { 'content-encoding': 'br' },
    { 'cache-control': 'private' },
    { 'cache-control': 'public, no-transform' },
  ])
    assert.equal(
      assetEncoding(request('/plugins/'), new Response('code', { headers: { ...headers, ...extra } })),
      null,
    );
  assert(
    assetEncoding(request('/studio/revision/runtime.mjs', '*;q=1'), new Response('code', { headers })),
  );
  assert.equal(
    assetEncoding(request('/plugins/', 'gzip', 'HEAD'), new Response('code', { headers })),
    null,
  );
});
test('version-addressed private code can compress while private API data stays untouched', () => {
  const revision = 'official-novel-' + '1'.repeat(16);
  const response = new Response('module', {
    headers: { ...headers, 'cache-control': 'private, max-age=31536000, immutable' },
  });
  assert.equal(assetEncoding(request('/studio/' + revision + '/editor.mjs'), response), 'br');
  const native = '/plugins/@deepseek-ai/dsh-client-ui-conversation/client.js';
  assert.equal(assetEncoding(request(native + '?novel=' + revision, 'gzip, br;q=0.5'), response), 'gzip');
  for (const path of [native, '/api/novels/book/documents', '/studio/development/editor.mjs'])
    assert.equal(assetEncoding(request(path), response), null);
});
test('native plugin bundles use loopback identity only when the browser prefers Brotli', () => {
  const plugin = '/plugins/??one/client.js,two/client.js&rev=example';
  assert.equal(nativePluginEncoding(request(plugin)), 'identity');
  assert.equal(nativePluginEncoding(request(plugin, 'gzip')), null);
  assert.equal(nativePluginEncoding(request(plugin, 'gzip, br;q=0.5')), null);
  assert.equal(nativePluginEncoding(request(plugin, 'gzip, br', 'HEAD')), null);
  assert.equal(nativePluginEncoding(request(plugin.replace('&rev=example', ''))), null);
  assert.equal(nativePluginEncoding(request('/api/session/list')), null);
  const range = new Request(request(plugin), { headers: { 'accept-encoding': 'br', range: 'bytes=0-9' } });
  assert.equal(nativePluginEncoding(range), null);
});
test('native shell preloads the same versioned novel entries before plugin activation', () => {
  const html = novelModulePreloads('/studio/current/pages/public/novel-assets/');
  assert.equal((html.match(/rel="modulepreload"/g) ?? []).length, 8);
  assert(html.includes('/studio/current/pages/public/novel-assets/manuscript.mjs'));
  assert(html.includes('/studio/current/pages/public/novel-assets/editor-vendor.mjs'));
});
test('a normal recovery login preserves other devices; PIN epoch changes still disconnect stale carriers', () => {
  const base = {
    method: 'POST',
    status: 200,
    path: '/api/auth/recover',
    beforeEpoch: 'existing',
    afterEpoch: 'existing',
  };
  assert.equal(invalidatesNativeTransports(base), false);
  assert.equal(invalidatesNativeTransports({ ...base, afterEpoch: 'new' }), true);
  assert.equal(invalidatesNativeTransports({ ...base, path: '/api/auth/pin', afterEpoch: 'new' }), true);
  assert.equal(invalidatesNativeTransports({ ...base, status: 401 }), false);
  assert.equal(invalidatesNativeTransports({ ...base, path: '/api/auth/logout' }), true);
});
