import { createHash, randomInt, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { bindWorkflow, encodeIllustration, endpoint, request, webpSize } from '../../shared/comfy-render.mjs';

const maxImageBytes = 16 * 1024 * 1024;
const jobId = /^[0-9a-f-]{36}$/;
const sha = (text) => createHash('sha256').update(text).digest('hex');

async function loadConfig(path) {
  const config = JSON.parse(await readFile(path, 'utf8'));
  const base = endpoint(config.comfy);
  const template = JSON.parse(await readFile(resolve(dirname(path), config.workflow), 'utf8'));
  const bindings = config.bindings ?? {};
  const values = config.values ?? {};
  if (!Object.hasOwn(bindings, 'prompt')) throw new Error('ComfyUI 预设缺少 prompt 绑定。');
  const ffmpeg = config.ffmpeg ?? 'ffmpeg';
  const revision = sha(JSON.stringify([base.href, template, bindings, values]));
  return { base, template, bindings, values, ffmpeg, revision };
}

async function boundedImage(response) {
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > maxImageBytes) throw new Error('ComfyUI 原图超过 16 MiB，无法存入本书图集。');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}

export function installComfyTools(
  instance,
  { fs, installNovelTools, makeDocumentService, imageAsset },
  configPath,
  { waitMs = 35000, pollMs = 2000 } = {},
) {
  const db = instance.ctx.storage;
  db.exec(`CREATE TABLE IF NOT EXISTS novel_comfy_jobs (
    id TEXT PRIMARY KEY, book TEXT NOT NULL, call_id TEXT NOT NULL,
    revision TEXT NOT NULL, caption TEXT NOT NULL, prompt_id TEXT, images TEXT,
    UNIQUE (book, call_id)
  )`);
  const find = db.prepare('SELECT * FROM novel_comfy_jobs WHERE book = ? AND id = ?');
  const findCall = db.prepare('SELECT * FROM novel_comfy_jobs WHERE book = ? AND call_id = ?');
  const insert = db.prepare(
    'INSERT INTO novel_comfy_jobs (id, book, call_id, revision, caption) VALUES (?, ?, ?, ?, ?)',
  );
  const recordPrompt = db.prepare('UPDATE novel_comfy_jobs SET prompt_id = ? WHERE id = ?');
  const complete = db.prepare('UPDATE novel_comfy_jobs SET images = ? WHERE id = ?');
  let configured;
  return installNovelTools(instance.sessions.context, ({ root, assertScope }) => {
    const book = root.slice('/workspace/novels/'.length);
    return [
      {
        name: 'novel_generate_image',
        description:
          '作者要生成图片时调用。generate 用已配置的 ComfyUI 工作流出图，把候选图存进本书图集并显示在工具结果；可带本书现有参考图路径。prompt 描述场景、构图、人物神态和画风。返回 queued 时可用 job_id 查询一次 status；仍排队则告知作者，后续可继续查询，勿重新提交。仅在作者要求插入正文时，再用 novel_illustration 放置。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['generate', 'status'] },
            prompt: { type: 'string', maxLength: 12000 },
            caption: { type: 'string', maxLength: 160 },
            reference: { type: 'string', description: '可选，本书 illustrations/ 图集路径。' },
            job_id: { type: 'string', description: 'status 使用本工具先前返回的任务 ID。' },
          },
          required: ['action'],
          additionalProperties: false,
        },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        isConcurrencySafe: () => false,
        presentCall: ({ action }) => ({
          card: 'generic',
          kind: 'read',
          title: action === 'status' ? '查询插图任务' : '生成插图',
        }),
        async execute(args, exec) {
          const { action, prompt, reference, job_id: id } = args;
          const keys =
            action === 'status' ? ['action', 'job_id'] : ['action', 'prompt', 'caption', 'reference'];
          if (
            !['status', 'generate'].includes(action) ||
            Object.keys(args).some((key) => !keys.includes(key)) ||
            (action === 'status'
              ? typeof id !== 'string' || !jobId.test(id)
              : typeof prompt !== 'string' || !prompt.trim() || prompt.length > 12000)
          )
            throw new Error('生图任务参数无效。');
          let row = action === 'status' ? find.get(book, id) : findCall.get(book, exec.callId);
          if (!row && action === 'status') throw new Error('找不到本书中的生图任务。');
          const result = (status, extra = {}) =>
            JSON.stringify({ status, bookId: book, jobId: row.id, ...extra });
          if (row?.images) return result('ready', { images: JSON.parse(row.images) });
          if (row && !row.prompt_id) return result('unknown');
          const config = await (configured ??= loadConfig(configPath).catch((error) => {
            configured = undefined;
            if (error.code === 'ENOENT') throw new Error('主机尚未设置可用的 ComfyUI 工作流文件。');
            throw error;
          }));
          assertScope(exec);
          if (row && row.revision !== config.revision)
            throw new Error('生图预设已改变，无法从另一套 ComfyUI 预设查询此任务。');
          const service = makeDocumentService(fs, db, book);
          const comfy = (route, options) => request(config.base, route, { ...options, signal: exec.signal });
          if (!row) {
            const values = { ...config.values, prompt: prompt.trim() };
            if (Object.hasOwn(config.bindings, 'seed')) values.seed = randomInt(2 ** 32);
            if (Object.hasOwn(config.bindings, 'useReference')) values.useReference = Boolean(reference);
            if (reference) {
              if (!Object.hasOwn(config.bindings, 'reference')) throw new Error('此工作流未配置参考图输入。');
              const asset = service.run({ kind: 'illustrations', action: 'read', imagePath: reference });
              values.reference = '';
              bindWorkflow(config.template, config.bindings, values);
              const form = new FormData();
              form.set(
                'image',
                new Blob([Buffer.from(asset.data.split(',')[1], 'base64')], { type: 'image/webp' }),
                sha(asset.data) + '.webp',
              );
              const uploaded = await comfy('upload/image', { form });
              if (typeof uploaded.name !== 'string' || !uploaded.name)
                throw new Error('ComfyUI 没有返回参考图回执。');
              values.reference = uploaded.subfolder
                ? uploaded.subfolder + '/' + uploaded.name
                : uploaded.name;
            }
            const graph = bindWorkflow(config.template, config.bindings, values);
            assertScope(exec);
            const job = randomUUID();
            insert.run(job, book, exec.callId, config.revision, args.caption?.trim() || 'AI 插图');
            row = find.get(book, job);
            // A lost POST response is ambiguous. Retain the receipt and never submit it twice.
            try {
              const submitted = await comfy('prompt', { data: { prompt: graph } });
              if (typeof submitted.prompt_id !== 'string' || !submitted.prompt_id) return result('unknown');
              recordPrompt.run(submitted.prompt_id, job);
              row = find.get(book, job);
            } catch (error) {
              if (error.status >= 400 && error.status < 500) {
                db.prepare('DELETE FROM novel_comfy_jobs WHERE id = ?').run(job);
                throw new Error('ComfyUI 拒绝了工作流，请检查节点和模型配置。');
              }
              exec.signal.throwIfAborted();
              return result('unknown');
            }
          }
          const deadline = Date.now() + (action === 'generate' ? waitMs : 0);
          let history;
          do {
            const response = await comfy('history/' + encodeURIComponent(row.prompt_id));
            history = response[row.prompt_id];
            if (history || Date.now() >= deadline) break;
            await delay(Math.min(pollMs, Math.max(0, deadline - Date.now())), undefined, {
              signal: exec.signal,
            });
          } while (true);
          if (!history) return result('queued');
          if (history.status?.status_str === 'error')
            throw new Error('ComfyUI 生图失败，请检查工作流执行记录。');
          const files = Object.values(history.outputs ?? {})
            .flatMap((node) => node.images ?? [])
            .filter((file) => file.type === 'output' && /.(png|jpe?g|webp)$/i.test(file.filename))
            .slice(0, 4);
          if (!files.length) throw new Error('ComfyUI 任务完成，但工作流没有保存可用图片。');
          const scratch = await mkdtemp(join(tmpdir(), 'novel-comfy-image-'));
          try {
            const assets = [];
            for (const file of files) {
              const response = await comfy('view', {
                query: { filename: file.filename, subfolder: file.subfolder ?? '', type: 'output' },
                binary: true,
              });
              const source = join(scratch, 'original' + /\.[a-z]+$/i.exec(file.filename)[0].toLowerCase());
              await writeFile(source, await boundedImage(response));
              const content = await encodeIllustration(
                config.ffmpeg,
                source,
                scratch,
                (bytes) => {
                  const [width, height] = webpSize(bytes);
                  return JSON.stringify(
                    imageAsset(
                      JSON.stringify({
                        format: 'novel-illustration-v1',
                        width,
                        height,
                        label: row.caption,
                        data: 'data:image/webp;base64,' + bytes.toString('base64'),
                      }),
                    ),
                  );
                },
                exec.signal,
              );
              assets.push(content);
            }
            assertScope(exec);
            const images = db.transaction(() => {
              const published = assets.map((content) => ({
                imagePath: service.run({ kind: 'illustrations', action: 'upload', content }).imagePath,
                label: row.caption,
              }));
              const unique = [...new Map(published.map((image) => [image.imagePath, image])).values()];
              complete.run(JSON.stringify(unique), row.id);
              return unique;
            })();
            return result('ready', { images });
          } finally {
            await rm(scratch, { recursive: true, force: true });
          }
        },
      },
    ];
  });
}
