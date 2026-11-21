import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ILLUSTRATION_ENCODING } from '../worker/shared/illustrations.mjs';

const exec = promisify(execFile);
const checked = (condition, message) => {
  if (!condition) throw new Error(message);
};
const own = (object, key) => object && Object.hasOwn(object, key);

export function endpoint(value) {
  const url = new URL(value);
  checked(
    ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash,
    '服务地址必须是没有认证信息的 HTTP(S) 地址。',
  );
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

export function bindWorkflow(template, bindings, values) {
  const graph = structuredClone(template);
  checked(
    Object.keys(graph).length > 0 &&
      Object.values(graph).every(
        (node) => typeof node?.class_type === 'string' && node.inputs && !Array.isArray(node.inputs),
      ),
    '请使用 ComfyUI 的 API 格式工作流。',
  );
  for (const [key, targets] of Object.entries(bindings)) {
    checked(own(values, key), '工作流缺少参数 ' + key);
    checked(Array.isArray(targets) && targets.length, '参数未指定目标节点 ' + key);
    for (const target of targets) {
      checked(
        Array.isArray(target) &&
          target.length === 2 &&
          own(graph, target[0]) &&
          own(graph[target[0]].inputs, target[1]),
        '工作流参数绑定无效 ' + key,
      );
      graph[target[0]].inputs[target[1]] = structuredClone(values[key]);
    }
  }
  return graph;
}

function headersFor(session, endpoint) {
  return session ? { cookie: session, origin: endpoint.origin, 'sec-fetch-site': 'same-origin' } : {};
}

export async function request(
  base,
  route,
  { query, data, form, cookie, method, binary = false, signal } = {},
) {
  const url = new URL(route, base);
  if (query) url.search = new URLSearchParams(query);
  const response = await fetch(url, {
    redirect: 'error',
    method: method ?? (data || form ? 'POST' : 'GET'),
    headers: { ...headersFor(cookie, base), ...(data ? { 'content-type': 'application/json' } : {}) },
    body: form ?? (data ? JSON.stringify(data) : undefined),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const error = new Error(
      body?.error?.message ??
        (typeof body?.error === 'string' ? body.error : 'HTTP ' + response.status + ' ' + route),
    );
    error.status = response.status;
    throw error;
  }
  return binary ? response : response.json();
}

export async function encodeIllustration(ffmpeg, source, scratch, pack, signal) {
  if (/\.webp$/i.test(source)) {
    try {
      return pack(await readFile(source));
    } catch {
      // Re-encode images larger than the manuscript's import limits.
    }
  }
  for (const [side, quality] of ILLUSTRATION_ENCODING) {
    const file = join(scratch, 'edition.webp');
    const filter =
      "scale=w='min(iw," +
      side +
      ")':h='min(ih," +
      side +
      ")':force_original_aspect_ratio=decrease:flags=lanczos";
    await exec(
      ffmpeg,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-threads',
        '1',
        '-i',
        source,
        '-filter_threads',
        '1',
        '-vf',
        filter,
        '-frames:v',
        '1',
        '-c:v',
        'libwebp',
        '-threads',
        '1',
        '-quality',
        String(quality),
        file,
      ],
      { timeout: 60000, windowsHide: true, signal },
    );
    try {
      return pack(await readFile(file));
    } catch (error) {
      if (side === 800) throw error;
    }
  }
}

export function webpSize(webp) {
  checked(
    webp.length >= 30 && webp.toString('ascii', 0, 4) === 'RIFF' && webp.toString('ascii', 8, 12) === 'WEBP',
    '输出 WebP 头无效。',
  );
  const type = webp.toString('ascii', 12, 16);
  if (type === 'VP8X') return [webp.readUIntLE(24, 3) + 1, webp.readUIntLE(27, 3) + 1];
  if (type === 'VP8L' && webp[20] === 0x2f) {
    const bits = webp.readUInt32LE(21);
    return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
  }
  checked(type === 'VP8 ' && webp.readUIntLE(23, 3) === 0x2a019d, '无法解析 WebP 尺寸。');
  return [webp.readUInt16LE(26) & 0x3fff, webp.readUInt16LE(28) & 0x3fff];
}
