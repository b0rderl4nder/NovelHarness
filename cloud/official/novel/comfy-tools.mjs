import { createHash, randomInt, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { bindWorkflow, encodeIllustration, request, webpSize } from '../../shared/comfy-render.mjs';
import {
  compileVisualPrompt,
  loadComfyPresets,
  referenceCanvas,
  regionLabels,
  visualAdjustments,
} from './comfy-presets.mjs';
import { chatImageReferences, loadChatImage } from './comfy-chat-images.mjs';

const maxImageBytes = 16 * 1024 * 1024;
const jobId = /^[0-9a-f-]{36}$/;
const sha = (text) => createHash('sha256').update(text).digest('hex');

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
  { fs, installNovelTools, makeDocumentService, imageAsset, attachments, sessionQuery },
  configPath,
  { waitMs = 12 * 60 * 1000, pollMs = 4000 } = {},
) {
  const db = instance.ctx.storage;
  db.run(`CREATE TABLE IF NOT EXISTS novel_comfy_jobs (
    id TEXT PRIMARY KEY, book TEXT NOT NULL, call_id TEXT NOT NULL,
    revision TEXT NOT NULL, caption TEXT NOT NULL, prompt_id TEXT, images TEXT, recipe TEXT,
    UNIQUE (book, call_id)
  )`);
  if (!db.all('PRAGMA table_info(novel_comfy_jobs)').some((column) => column.name === 'recipe'))
    db.run('ALTER TABLE novel_comfy_jobs ADD COLUMN recipe TEXT');
  const find = (book, id) => db.one('SELECT * FROM novel_comfy_jobs WHERE book = ? AND id = ?', book, id);
  const findCall = (book, id) =>
    db.one('SELECT * FROM novel_comfy_jobs WHERE book = ? AND call_id = ?', book, id);
  let configured;
  return installNovelTools(instance.sessions.context, ({ root, assertScope }) => {
    const book = root.slice('/workspace/novels/'.length);
    return [
      {
        name: 'novel_generate_image',
        description:
          '画图、改图、按参考图生成新图。对话中上传的图片可直接用 reference: "chat:latest"。presets 列出工作流和调参范围，references 列出对话图片。generate 接收你撰写的 prompt，成图自动显示在对话并存入本书图集。要查看图集里的图片内容，用 inspect 和图片路径；要继续改它，可直接用该路径作 reference。queued 用 status 查询；插入正文用 novel_illustration。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['presets', 'references', 'inspect', 'generate', 'status'] },
            prompt: { type: 'string', maxLength: 12000 },
            caption: { type: 'string', maxLength: 160 },
            preset: { type: 'string', maxLength: 40 },
            seed: { type: 'integer', minimum: 0, maximum: 4294967295 },
            style: { type: 'string', maxLength: 1000 },
            composition: { type: 'string', maxLength: 1000 },
            atmosphere: { type: 'string', maxLength: 1000 },
            negative_prompt: { type: 'string', maxLength: 4000 },
            adjustments: {
              type: 'array',
              maxItems: 16,
              description: '按预设列出的范围或选项设置，数值填 number，枚举填 choice。',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string', maxLength: 40 },
                  number: { type: 'number' },
                  choice: { type: 'string', maxLength: 100 },
                },
                required: ['name'],
                additionalProperties: false,
              },
            },
            regions: {
              type: 'array',
              minItems: 1,
              maxItems: 16,
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string', enum: regionLabels },
                  caption: { type: 'string', maxLength: 800 },
                  box: {
                    type: 'array',
                    minItems: 4,
                    maxItems: 4,
                    items: { type: 'integer', minimum: 0, maximum: 1000 },
                    description: '[左,上,右,下]，从左上角起，以 0–1000 表示相对位置。',
                  },
                  text: { type: 'string', maxLength: 160, description: '文字框要显示的逐字原文。' },
                },
                required: ['label', 'caption', 'box'],
                additionalProperties: false,
              },
            },
            reference: {
              type: 'string',
              maxLength: 256,
              description:
                'generate 支持 chat:latest、对话图片 ID 或本书 illustrations/ 路径；inspect 用图集路径。',
            },
            job_id: { type: 'string', description: 'status 使用本工具先前返回的任务 ID。' },
          },
          required: ['action'],
          additionalProperties: false,
        },
        output: {
          schema: { type: 'string' },
          render(args, value) {
            if (args.action !== 'inspect') return [{ type: 'text', text: value }];
            const { attachment, label } = JSON.parse(value);
            return [
              { type: 'text', text: label },
              { type: 'image', attachment },
            ];
          },
        },
        isConcurrencySafe: () => false,
        presentCall: ({ action }) => ({
          card: 'generic',
          kind: 'read',
          title:
            action === 'presets'
              ? '查看生图预设'
              : action === 'references'
                ? '查看对话参考图'
                : action === 'inspect'
                  ? '查看生成的图'
                  : action === 'status'
                    ? '查询插图任务'
                    : '生成插图',
        }),
        async execute(args, exec) {
          const { action, prompt, reference, job_id: id } = args;
          const references = () => chatImageReferences(sessionQuery, exec.agent.session.id, exec.signal);
          const keys =
            action === 'presets' || action === 'references'
              ? ['action']
              : action === 'status'
                ? ['action', 'job_id']
                : action === 'inspect'
                  ? ['action', 'reference']
                  : [
                      'action',
                      'prompt',
                      'caption',
                      'reference',
                      'preset',
                      'seed',
                      'style',
                      'composition',
                      'atmosphere',
                      'negative_prompt',
                      'adjustments',
                      'regions',
                    ];
          if (
            !['presets', 'references', 'inspect', 'status', 'generate'].includes(action) ||
            Object.keys(args).some((key) => !keys.includes(key)) ||
            (action === 'inspect' && typeof reference !== 'string') ||
            (action === 'status'
              ? typeof id !== 'string' || !jobId.test(id)
              : action === 'generate' &&
                (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 12000))
          )
            throw new Error('生图任务参数无效。');
          if (action === 'references') {
            const found = await references();
            assertScope(exec);
            return JSON.stringify({
              references: [...found].map(([id, { name, width, height }]) => ({ id, name, width, height })),
            });
          }
          if (action === 'inspect') {
            const service = makeDocumentService(fs, db, book);
            const { data, label } = service.run({
              kind: 'illustrations',
              action: 'read',
              imagePath: reference,
            });
            const attachment = await attachments.saveImage({
              data: Buffer.from(data.split(',')[1], 'base64'),
              mediaType: 'image/webp',
              name: 'novel-illustration.webp',
            });
            assertScope(exec);
            return JSON.stringify({ attachment, label: label || '本书插图' });
          }
          let row =
            action === 'status' ? find(book, id) : action === 'generate' ? findCall(book, exec.callId) : null;
          if (!row && action === 'status') throw new Error('找不到本书中的生图任务。');
          const result = (status, extra = {}) =>
            JSON.stringify({
              status,
              bookId: book,
              jobId: row.id,
              ...(row.recipe ? JSON.parse(row.recipe) : {}),
              ...extra,
            });
          if (row?.images) return result('ready', { images: JSON.parse(row.images) });
          if (row && !row.prompt_id) return result('unknown');
          const available = await (configured ??= loadComfyPresets(configPath).catch((error) => {
            configured = undefined;
            if (error.code === 'ENOENT') throw new Error('主机尚未设置可用的 ComfyUI 工作流文件。');
            throw error;
          }));
          assertScope(exec);
          if (action === 'presets')
            return JSON.stringify({
              defaultPreset: available.defaultPreset,
              defaultReferencePreset: available.defaultReferencePreset,
              presets: [...available.presets.values()].map((preset) => ({
                id: preset.id,
                label: preset.label,
                layout: preset.layout,
                reference: Object.hasOwn(preset.bindings, 'reference'),
                requiresReference: preset.requiresReference,
                seed: Object.hasOwn(preset.bindings, 'seed'),
                negativePrompt: Object.hasOwn(preset.bindings, 'negativePrompt'),
                controls: preset.controls,
              })),
            });
          const config = row
            ? (available.presets.get(row.recipe ? JSON.parse(row.recipe).preset : undefined) ??
              [...available.presets.values()].find((preset) => preset.revision === row.revision))
            : available.presets.get(
                args.preset ??
                  (reference
                    ? (available.defaultReferencePreset ?? available.defaultPreset)
                    : available.defaultPreset),
              );
          if (!config || (row && row.revision !== config.revision))
            throw new Error(
              row ? '生图预设已改变，无法从另一套预设查询此任务。' : '没有这个生图预设，请先查看预设列表。',
            );
          const service = makeDocumentService(fs, db, book);
          const comfy = (route, options) => request(config.base, route, { ...options, signal: exec.signal });
          if (!row) {
            if (config.requiresReference && !reference) throw new Error('此编辑预设需要提供参考图。');
            let asset;
            if (reference) {
              if (!Object.hasOwn(config.bindings, 'reference')) throw new Error('此工作流未配置参考图输入。');
              if (reference.startsWith('chat:')) {
                asset = await loadChatImage(attachments, await references(), reference, exec.signal);
              } else {
                const { data, width, height } = service.run({
                  kind: 'illustrations',
                  action: 'read',
                  imagePath: reference,
                });
                asset = {
                  data: Buffer.from(data.split(',')[1], 'base64'),
                  mediaType: 'image/webp',
                  extension: 'webp',
                  width,
                  height,
                };
              }
              assertScope(exec);
              if (asset.data.length > maxImageBytes) throw new Error('ComfyUI 参考图超过 16 MiB。');
            }
            const chosen = visualAdjustments(config, args.adjustments);
            const adjustments = asset
              ? { ...referenceCanvas(config.controls, chosen, asset), ...chosen }
              : chosen;
            const values = {
              ...config.values,
              ...Object.fromEntries(
                Object.entries(config.controls).map(([key, control]) => [key, control.default]),
              ),
              ...adjustments,
              prompt: compileVisualPrompt(config, args, adjustments),
            };
            if (Object.hasOwn(config.bindings, 'negativePrompt')) {
              const [node, input] = config.bindings.negativePrompt[0];
              values.negativePrompt =
                args.negative_prompt ?? values.negativePrompt ?? config.template[node].inputs[input];
            } else if (args.negative_prompt !== undefined) throw new Error('此工作流没有负向提示词输入。');
            const supportsSeed = Object.hasOwn(config.bindings, 'seed');
            if (
              args.seed !== undefined &&
              (!supportsSeed || !Number.isSafeInteger(args.seed) || args.seed < 0 || args.seed >= 2 ** 32)
            )
              throw new Error('此预设不支持固定种子，或种子超出 0–4294967295。');
            const seed = supportsSeed ? (args.seed ?? randomInt(2 ** 32)) : null;
            if (supportsSeed) values.seed = seed;
            if (Object.hasOwn(config.bindings, 'useReference')) values.useReference = Boolean(reference);
            if (!reference && Object.hasOwn(config.bindings, 'reference') && values.reference === undefined) {
              const [node, input] = config.bindings.reference[0];
              values.reference = config.template[node].inputs[input];
            }
            if (asset) {
              values.reference = '';
              bindWorkflow(config.template, config.bindings, values);
              const form = new FormData();
              form.set(
                'image',
                new Blob([asset.data], { type: asset.mediaType }),
                sha(asset.data) + '.' + asset.extension,
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
            db.run(
              'INSERT INTO novel_comfy_jobs (id, book, call_id, revision, caption, recipe) VALUES (?, ?, ?, ?, ?, ?)',
              job,
              book,
              exec.callId,
              config.revision,
              args.caption?.trim() || 'AI 插图',
              JSON.stringify({
                preset: config.id,
                seed,
                ...(Object.keys(adjustments).length ? { adjustments } : {}),
              }),
            );
            row = find(book, job);
            // A lost POST response is ambiguous. Retain the receipt and never submit it twice.
            try {
              const submitted = await comfy('prompt', { data: { prompt: graph } });
              if (typeof submitted.prompt_id !== 'string' || !submitted.prompt_id) return result('unknown');
              db.run('UPDATE novel_comfy_jobs SET prompt_id = ? WHERE id = ?', submitted.prompt_id, job);
              row = find(book, job);
            } catch (error) {
              if (error.status >= 400 && error.status < 500) {
                db.run('DELETE FROM novel_comfy_jobs WHERE id = ?', job);
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
            .filter((file) => file.type === 'output' && /\.(png|jpe?g|webp)$/i.test(file.filename))
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
            const images = db.transactionSync(() => {
              const published = assets.map((content) => ({
                imagePath: service.run({ kind: 'illustrations', action: 'upload', content }).imagePath,
                label: row.caption,
              }));
              const unique = [...new Map(published.map((image) => [image.imagePath, image])).values()];
              db.run('UPDATE novel_comfy_jobs SET images = ? WHERE id = ?', JSON.stringify(unique), row.id);
              return unique;
            });
            return result('ready', { images });
          } finally {
            await rm(scratch, { recursive: true, force: true });
          }
        },
      },
    ];
  });
}
