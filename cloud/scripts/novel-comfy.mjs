import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  imageAsset,
  illustrationEntries,
  illustrationPath,
  illustrationMarker,
  insertIllustration,
} from '../worker/shared/illustrations.mjs';
import { materialSources } from '../worker/shared/writing-context.mjs';

const exec = promisify(execFile);
const checked = (condition, message) => {
  if (!condition) throw new Error(message);
};
const jsonFile = async (path) => JSON.parse(await readFile(path, 'utf8'));
const saveJson = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const own = (object, key) => object && Object.hasOwn(object, key);
const chapterPath = (path) =>
  typeof path === 'string' &&
  /^chapters\/.+\.(md|txt)$/.test(path) &&
  !/[\\\u0000-\u001f]/.test(path) &&
  !path.split('/').some((part) => !part || part === '.' || part === '..');

const digest = (value) => createHash('sha256').update(value).digest('hex');

function endpoint(value) {
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

async function request(base, route, { query, data, form, cookie, method, binary = false } = {}) {
  const url = new URL(route, base);
  if (query) url.search = new URLSearchParams(query);
  const response = await fetch(url, {
    redirect: 'error',
    method: method ?? (data || form ? 'POST' : 'GET'),
    headers: { ...headersFor(cookie, base), ...(data ? { 'content-type': 'application/json' } : {}) },
    body: form ?? (data ? JSON.stringify(data) : undefined),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(
      body?.error?.message ??
        (typeof body?.error === 'string' ? body.error : 'HTTP ' + response.status + ' ' + route),
    );
  }
  return binary ? response : response.json();
}

export function chapterWithVisuals(document, images, after) {
  const text = document.text;
  const found = illustrationEntries(text);
  const pending = images.filter(({ imagePath }) => !found.some((entry) => entry.path === imagePath));
  if (!pending.length) return text;
  checked(
    typeof after === 'string' && after.trim() && after.length <= 2000,
    '请指定插图前一段原文（after）。',
  );
  const start = text.indexOf(after);
  checked(start >= 0 && text.indexOf(after, start + 1) === -1, '正文定位不唯一或已变化，请核对 after。');
  const newline = /\r\n|\r|\n/.exec(text)?.[0] ?? '\n';
  const position = start + after.length;
  // Reuse the editor's paragraph boundary, then insert the remaining pages
  // directly after the first marker in selected reading order.
  const [first, ...rest] = pending;
  let next = insertIllustration(text, first.imagePath, first.label, position);
  const inserted = illustrationEntries(next).find((entry) => entry.path === first.imagePath);
  checked(inserted, '所选位置落在代码块内，请重新定位。');
  const end = inserted.to;
  const following = rest
    .map(({ imagePath, label }) => illustrationMarker(imagePath, label))
    .join(newline + newline);
  if (following) next = next.slice(0, end) + newline + newline + following + next.slice(end);
  return next;
}

function illustrationEnvelope(bytes, label) {
  const [width, height] = webpSize(bytes);
  return JSON.stringify(
    imageAsset(
      JSON.stringify({
        format: 'novel-illustration-v1',
        width,
        height,
        label,
        data: 'data:image/webp;base64,' + bytes.toString('base64'),
      }),
    ),
  );
}

async function encodeIllustration(ffmpeg, source, scratch, label) {
  if (/\.webp$/i.test(source)) {
    try {
      return illustrationEnvelope(await readFile(source), label);
    } catch {
      // Re-encode images larger than the manuscript's import limits.
    }
  }
  for (const side of [1600, 1200, 800]) {
    const file = join(scratch, 'edition.webp');
    const filter =
      "scale=w='min(iw," + side + ")':h='min(ih," + side + ")':force_original_aspect_ratio=decrease";
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
        '78',
        file,
      ],
      { timeout: 60000, windowsHide: true },
    );
    try {
      return illustrationEnvelope(await readFile(file), label);
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

function outputImages(response, folder, index) {
  const images = Object.values(response.outputs ?? {}).flatMap((node) => node.images ?? []);
  return images
    .filter((image) => image.type === 'output')
    .map((image, page) => {
      const extension = /\.(png|jpe?g|webp)$/i.exec(image.filename)?.[0];
      checked(extension, '只收集 PNG、JPEG 和 WebP 输出。');
      return {
        query: { filename: image.filename, subfolder: image.subfolder ?? '', type: image.type },
        path: join(folder, String(index + 1).padStart(2, '0') + '-' + (page + 1) + extension.toLowerCase()),
      };
    });
}

export async function main([action, configPath], env = process.env) {
  checked(
    ['context', 'submit', 'collect', 'publish'].includes(action) && configPath,
    '用法：node cloud/scripts/novel-comfy.mjs context|submit|collect|publish <任务.json>',
  );
  const config = await jsonFile(configPath);
  const home = dirname(resolve(configPath));
  const novel = endpoint(config.novel);
  const work = resolve(home, config.output ?? 'visual-output');
  const comfy = ['submit', 'collect'].includes(action) ? endpoint(config.comfy) : null;
  checked(
    /^b-[a-f0-9]{32}$/.test(config.book) && chapterPath(config.chapter),
    '请提供有效的书 ID 与章节路径。',
  );
  const cookie = env.NOVELHARNESS_SESSION_COOKIE;
  const novelRequest = (method, route, query, data) => {
    checked(cookie, '需通过 NOVELHARNESS_SESSION_COOKIE 提供 NovelHarness 的已登录会话。');
    return request(novel, 'api/novels/' + config.book + '/' + route, { query, data, cookie, method });
  };
  const getChapter = () => novelRequest('GET', 'document', { path: config.chapter });
  await mkdir(work, { recursive: true });
  const contextPath = join(work, 'context.json');
  if (action === 'context') {
    const chapter = await getChapter();
    const materials = [];
    for (const path of new Set(config.materials ?? [])) {
      materials.push(await novelRequest('GET', 'document', { path }));
    }
    await saveJson(contextPath, {
      novel: novel.href,
      book: config.book,
      chapter,
      materials,
      sources: materialSources({ root: '/workspace/novels/' + config.book }, materials),
    });
    return { context: contextPath };
  }

  const context = await jsonFile(contextPath);
  checked(
    context.novel === novel.href && context.book === config.book && context.chapter.path === config.chapter,
    '当前任务与章节快照不匹配。',
  );
  const entries = config.pages ?? [];
  checked(Array.isArray(entries) && entries.length > 0, '至少配置一页。');

  if (action === 'submit') {
    const template = await jsonFile(resolve(home, config.workflow));
    const graphs = [];
    for (const page of entries) {
      const values = { ...config.values, ...page.values };
      for (const [key, file] of Object.entries(page.textFiles ?? {}))
        values[key] = await readFile(resolve(home, file), 'utf8');
      for (const [key, source] of Object.entries(page.textSources ?? {})) {
        const document = [context.chapter, ...context.materials].find((item) => item.path === source);
        checked(document, '任务快照中没有资料 ' + source);
        values[key] = document.text;
      }
      for (const key of Object.keys(page.references ?? {})) values[key] = '';
      graphs.push(bindWorkflow(template, config.bindings, values));
    }
    // A request can be accepted while its response is lost. Persist intent
    // before sending and fail closed, so rerunning never silently duplicates it.
    const jobs = [];
    for (const [i, graph] of graphs.entries()) {
      const receipt = join(work, 'job-' + (i + 1));
      const known = await readFile(receipt + '.json', 'utf8').then(JSON.parse, (error) => {
        if (error.code !== 'ENOENT') throw error;
      });
      if (known) {
        checked(known.comfy === comfy.href, '保存的任务来自其他 ComfyUI 地址。');
        jobs.push(known);
        continue;
      }
      for (const [key, reference] of Object.entries(entries[i].references ?? {})) {
        checked(own(config.bindings, key), '参考图缺少绑定 ' + key);
        const form = new FormData();
        if (illustrationPath(reference)) {
          const asset = await novelRequest('GET', 'illustrations', { action: 'read', imagePath: reference });
          const data = Buffer.from(asset.data.split(',')[1], 'base64');
          form.append(
            'image',
            new Blob([data], { type: 'image/webp' }),
            basename(reference, '.json') + '.webp',
          );
        } else {
          const file = resolve(home, reference);
          form.append('image', new Blob([await readFile(file)]), basename(file));
        }
        form.append('type', 'input');
        const uploaded = await request(comfy, 'upload/image', { form });
        for (const [id, field] of config.bindings[key])
          graph[id].inputs[field] = [uploaded.subfolder, uploaded.name].filter(Boolean).join('/');
      }
      await saveJson(receipt + '.pending.json', { page: i + 1, comfy: comfy.href });
      const result = await request(comfy, 'prompt', { data: { prompt: graph } });
      checked(typeof result.prompt_id === 'string' && result.prompt_id, 'ComfyUI 未返回任务 ID。');
      const job = { id: result.prompt_id, page: i + 1, comfy: comfy.href, graph };
      await saveJson(receipt + '.json', job);
      jobs.push(job);
    }
    return { jobs: jobs.map(({ id, page }) => ({ id, page })) };
  }

  if (action === 'collect') {
    const completed = [],
      waiting = [];
    for (const [i] of entries.entries()) {
      const job = await jsonFile(join(work, 'job-' + (i + 1) + '.json'));
      checked(job.comfy === comfy.href, '保存的任务来自其他 ComfyUI 地址。');
      const result = (await request(comfy, 'history/' + encodeURIComponent(job.id)))[job.id];
      if (!result) {
        waiting.push(job.page);
        continue;
      }
      checked(result.status?.status_str === 'success', 'ComfyUI 第 ' + job.page + ' 页执行失败 ' + job.id);
      const files = outputImages(result, work, i);
      checked(files.length, '第 ' + job.page + ' 页没有保存的图片。');
      for (const file of files) {
        const response = await request(comfy, 'view', { query: file.query, binary: true });
        const image = Buffer.from(await response.arrayBuffer());
        try {
          await writeFile(file.path, image, { flag: 'wx' });
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
          checked(image.equals(await readFile(file.path)), '本地文件已有不同内容：' + basename(file.path));
        }
        completed.push(basename(file.path));
      }
    }
    return { completed, waiting };
  }

  checked(Array.isArray(config.publish) && config.publish.length, '请在 publish 里按阅读顺序选图。');
  const chapter = await getChapter();
  const images = [];
  const scratch = await mkdtemp(join(work, '.encode-'));
  try {
    for (const { file, label = '' } of config.publish) {
      checked(typeof file === 'string' && basename(file) === file, '发布图片必须来自任务输出目录。');
      const content = await encodeIllustration(config.ffmpeg ?? 'ffmpeg', join(work, file), scratch, label);
      const imagePath = 'illustrations/' + digest(content) + '.json';
      if (!images.some((item) => item.imagePath === imagePath)) images.push({ imagePath, label, content });
    }
  } finally {
    await rm(join(scratch, 'edition.webp'), { force: true });
    await rmdir(scratch);
  }
  const placements = images.map(({ imagePath, label }) => ({ imagePath, label }));
  const text = config.after ? chapterWithVisuals(chapter, placements, config.after) : chapter.text;
  if (config.after && text === chapter.text)
    return { images: placements, chapter: config.chapter, hash: chapter.hash };
  if (config.after)
    checked(chapter.hash === context.chapter.hash, '章节自提取以来有修改，请重新提取并核对定位。');
  for (const { imagePath, content } of images) {
    const asset = await novelRequest('POST', 'illustrations', undefined, { action: 'upload', content });
    checked(asset.imagePath === imagePath, 'NovelHarness 插图内容摘要不匹配。');
  }
  if (!config.after) return { images: placements };
  const saved = await novelRequest('PUT', 'document', undefined, {
    path: config.chapter,
    text,
    expectedHash: chapter.hash,
  });
  return { images: placements, chapter: saved.path, hash: saved.hash };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    console.log(JSON.stringify(await main(process.argv.slice(2)), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
