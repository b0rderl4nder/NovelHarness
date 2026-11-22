import { createHash, randomInt, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { bindWorkflow, encodeIllustration, request, webpSize } from '../../shared/comfy-render.mjs';
import { compileVisualPrompt, referenceCanvas, regionLabels, visualAdjustments } from './comfy-presets.mjs';
import { chatImageReferences, loadChatImage } from './comfy-chat-images.mjs';
import { chapterDeliveryFor } from './comfy-chapter-delivery.mjs';
import { createComfySettings } from './comfy-settings.mjs';
import { createComfyProgress, watchComfy } from './comfy-progress.mjs';
import {
  characterSheetLayout,
  createCharacterVisuals,
  identityBindings,
  sheetCanvas,
  sheetGraph,
  visualCharacter,
} from './character-visuals.mjs';

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
    revision TEXT NOT NULL, caption TEXT NOT NULL, prompt_id TEXT, images TEXT, recipe TEXT, connection TEXT,
    UNIQUE (book, call_id)
  )`);
  const columns = db.all('PRAGMA table_info(novel_comfy_jobs)');
  for (const name of ['recipe', 'connection'])
    if (!columns.some((column) => column.name === name))
      db.run(`ALTER TABLE novel_comfy_jobs ADD COLUMN ${name} TEXT`);
  const find = (book, id) => db.one('SELECT * FROM novel_comfy_jobs WHERE book = ? AND id = ?', book, id);
  const findCall = (book, id) =>
    db.one('SELECT * FROM novel_comfy_jobs WHERE book = ? AND call_id = ?', book, id);
  const settings = createComfySettings(db, configPath);
  const progress = createComfyProgress();
  const characterVisuals = createCharacterVisuals(db);
  instance.comfy = {
    settings,
    progress,
    characterVisuals,
    characterBook: (book) => makeDocumentService(fs, db, book),
  };
  return installNovelTools(instance.sessions.context, ({ root, assertScope }) => {
    const book = root.slice('/workspace/novels/'.length);
    return [
      {
        name: 'novel_generate_image',
        description:
          '画图、改图和生成候选人设图。generate 的 characters 必须列出画面所有具名人物，空镜或路人用空数组。任何画风下，未定妆角色先用 character_sheet 生成同一角色的三张候选，由作者选择后再画有该角色的情节图。characters 可查询定妆状态（action=characters）。已定妆会自动传入真实参考图，换画风继续用同一角色名；写正文不必等待定妆。presets 查看参数，inspect 看图，queued 用 status 查询。章节首版入书后再按判断重画，revises 填图集路径。',
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: [
                'presets',
                'references',
                'inspect',
                'generate',
                'status',
                'characters',
                'character_sheet',
              ],
            },
            character: {
              type: 'string',
              maxLength: 80,
              description: 'character_sheet 的一个角色姓名，优先使用书中固定叫法。',
            },
            new_variants: {
              type: 'boolean',
              description: '作者明确想看新一批候选时才用，会保留已选的人设图。',
            },
            characters: {
              type: 'array',
              items: { type: 'string', maxLength: 80 },
              maxItems: 4,
              uniqueItems: true,
              description: 'generate 必填，画面中所有具名人物的姓名，非人物图用 []。',
            },
            prompt: { type: 'string', maxLength: 12000 },
            caption: { type: 'string', maxLength: 160 },
            revises: { type: 'string', description: '可选，本次重画对应的已有 illustrations/ 路径。' },
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
            const { attachment, label, chapterDelivery } = JSON.parse(value);
            return [
              {
                type: 'text',
                text: chapterDelivery ? label + '\n' + JSON.stringify(chapterDelivery) : label,
              },
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
                  : action === 'character_sheet'
                    ? '生成候选人设图'
                    : action === 'characters'
                      ? '查看已定妆角色'
                      : action === 'status'
                        ? '查询插图任务'
                        : '生成插图',
        }),
        async execute(args, exec) {
          const { action, prompt, reference, job_id: id } = args;
          const sheet = action === 'character_sheet';
          const generation = sheet || action === 'generate';
          const references = () => chatImageReferences(sessionQuery, exec.agent.session.id, exec.signal);
          const service = makeDocumentService(fs, db, book);
          const chapterDelivery = () => chapterDeliveryFor(sessionQuery, exec, root, book, service);
          const keys =
            action === 'presets' || action === 'references' || action === 'characters'
              ? ['action']
              : action === 'status'
                ? ['action', 'job_id']
                : action === 'inspect'
                  ? ['action', 'reference']
                  : [
                      'action',
                      'prompt',
                      'caption',
                      ...(sheet ? ['character', 'new_variants'] : ['characters', 'revises']),
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
            ![
              'presets',
              'references',
              'inspect',
              'status',
              'generate',
              'characters',
              'character_sheet',
            ].includes(action) ||
            Object.keys(args).some((key) => !keys.includes(key)) ||
            (action === 'inspect' && typeof reference !== 'string') ||
            (args.revises !== undefined && !/^illustrations\/[a-f0-9]{64}\.json$/.test(args.revises)) ||
            (action === 'status'
              ? typeof id !== 'string' || !jobId.test(id)
              : generation && (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 12000))
          )
            throw new Error('生图任务参数无效。');
          assertScope(exec);
          if (action === 'characters')
            return JSON.stringify({ bookId: book, characters: characterVisuals.list(book) });
          if (action === 'references') {
            const found = await references();
            assertScope(exec);
            return JSON.stringify({
              references: [...found].map(([id, { name, width, height }]) => ({ id, name, width, height })),
            });
          }
          if (action === 'inspect') {
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
            const pending = await chapterDelivery();
            assertScope(exec);
            return JSON.stringify({
              attachment,
              label: label || '本书插图',
              ...(pending ? { chapterDelivery: pending } : {}),
            });
          }
          let row = action === 'status' ? find(book, id) : generation ? findCall(book, exec.callId) : null;
          if (!row && action === 'status') throw new Error('找不到本书中的生图任务。');
          const result = (status, extra = {}) =>
            JSON.stringify({
              status,
              bookId: book,
              jobId: row.id,
              ...(row.recipe ? JSON.parse(row.recipe) : {}),
              ...extra,
            });
          const characterFromRow = () => (row?.recipe ? JSON.parse(row.recipe).characterSheet : undefined);
          const completed = (images) => {
            const character = characterFromRow();
            return character
              ? result('character-options', {
                  images,
                  characterVisual: characterVisuals.get(book, character),
                })
              : result('ready', { images });
          };
          if (row?.images) return completed(JSON.parse(row.images));
          if (row && !row.prompt_id) return result('unknown');
          const sheetCharacter = !row && sheet ? visualCharacter(args.character) : null;
          const state = (status, extra) => JSON.stringify({ status, bookId: book, ...extra });
          let cast = [];
          if (!row && action === 'generate') {
            if (args.characters === undefined)
              return state('identify-characters', {
                next: '重试时传入 characters，列出画面中全部具名角色，无角色时填 []。',
              });
            cast = characterVisuals.resolve(book, args.characters);
            const pending = cast.filter(({ chosen }) => !chosen);
            if (pending.length)
              return state('character-design-needed', {
                characters: pending,
                next: '为缺少候选的角色生成候选人设图，有候选的等作者定妆。正文可继续交付。',
              });
          }
          if (sheetCharacter && !args.new_variants) {
            const characterVisual = characterVisuals.get(book, sheetCharacter);
            if (characterVisual.chosen) return state('character-locked', { characterVisual });
            if (characterVisual.candidates.length >= 2)
              return state('character-options', { characterVisual });
          }
          if (!row && action === 'generate' && (args.caption?.trim() || args.revises)) {
            const pending = await chapterDelivery();
            assertScope(exec);
            if (
              pending?.images.some((image) =>
                args.revises ? image.imagePath === args.revises : image.label === args.caption.trim(),
              )
            )
              return JSON.stringify({ status: 'deliver-chapter', bookId: book, chapterDelivery: pending });
          }
          const available = row?.connection ? null : row ? await settings.original() : await settings.load();
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
                characterSlots: [1, 2, 3, 4].filter((n) => identityBindings(preset, n, false)).length,
                controls: preset.controls,
                ...(preset.guidance ? { guidance: preset.guidance } : {}),
              })),
            });
          let config = row
            ? row.connection
              ? JSON.parse(row.connection)
              : [...available.presets.values()].find((preset) => preset.revision === row.revision)
            : available.presets.get(
                args.preset ??
                  (reference
                    ? (available.defaultReferencePreset ?? available.defaultPreset)
                    : available.defaultPreset),
              );
          if (!config)
            throw new Error(
              row ? '生图预设已改变，无法从另一套预设查询此任务。' : '没有这个生图预设，请先查看预设列表。',
            );
          let identitySlots = [];
          let style = args.style;
          if (cast.length) {
            const hasSceneReference = Boolean(reference);
            identitySlots = identityBindings(config, cast.length, hasSceneReference);
            if (!identitySlots) {
              const candidates = new Set([
                available.presets.get(available.defaultReferencePreset),
                ...available.presets.values(),
              ]);
              for (const candidate of candidates) {
                if (!candidate) continue;
                const next = identityBindings(candidate, cast.length, hasSceneReference);
                if (!next) continue;
                style ??= config.label;
                config = candidate;
                identitySlots = next;
                break;
              }
            }
            if (!identitySlots)
              return state('character-reference-unavailable', {
                characters: cast.map(({ name }) => name),
                next: '当前工作流没有足够独立角色参考图输入，请选择兼容工作流。',
              });
          }
          const base = new URL(config.base);
          const comfy = (route, options) => request(base, route, { ...options, signal: exec.signal });
          const live = progress.begin(book, exec.callId);
          let watcher;
          try {
            if (!row) {
              const refs = Object.fromEntries(
                cast.map(({ chosen }, index) => [identitySlots[index], chosen]),
              );
              if (reference) refs.reference = reference;
              if (config.requiresReference && !refs.reference) throw new Error('此编辑预设需要提供参考图。');
              const assets = {};
              for (const [key, path] of Object.entries(refs)) {
                if (!Object.hasOwn(config.bindings, key)) throw new Error('此工作流未配置参考图输入。');
                if (path.startsWith('chat:')) {
                  assets[key] = await loadChatImage(attachments, await references(), path, exec.signal);
                } else {
                  const { data, width, height } = service.run({
                    kind: 'illustrations',
                    action: 'read',
                    imagePath: path,
                  });
                  assets[key] = {
                    data: Buffer.from(data.split(',')[1], 'base64'),
                    mediaType: 'image/webp',
                    extension: 'webp',
                    width,
                    height,
                  };
                }
                assertScope(exec);
                if (assets[key].data.length > maxImageBytes) throw new Error('ComfyUI 参考图超过 16 MiB。');
              }
              const chosen = visualAdjustments(config, args.adjustments);
              const adjustments = sheetCharacter
                ? { ...sheetCanvas(config, chosen), ...chosen }
                : reference
                  ? { ...referenceCanvas(config.controls, chosen, assets.reference), ...chosen }
                  : chosen;
              const values = {
                ...config.values,
                ...Object.fromEntries(
                  Object.entries(config.controls).map(([key, control]) => [key, control.default]),
                ),
                ...adjustments,
                prompt: compileVisualPrompt(
                  config,
                  sheetCharacter
                    ? { ...args, prompt: characterSheetLayout + '\n\n' + prompt }
                    : { ...args, style },
                  adjustments,
                ),
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
              for (const key of [
                'reference',
                'characterReference1',
                'characterReference2',
                'characterReference3',
                'characterReference4',
              ]) {
                if (!Object.hasOwn(config.bindings, key)) continue;
                const [node, input] = config.bindings[key][0];
                const switchKey = 'use' + key[0].toUpperCase() + key.slice(1);
                if (Object.hasOwn(config.bindings, switchKey)) values[switchKey] = Boolean(assets[key]);
                values[key] = assets[key] ? '' : (values[key] ?? config.template[node].inputs[input]);
              }
              if (Object.keys(assets).length) bindWorkflow(config.template, config.bindings, values);
              for (const [key, asset] of Object.entries(assets)) {
                const form = new FormData();
                form.set(
                  'image',
                  new Blob([asset.data], { type: asset.mediaType }),
                  sha(asset.data) + '.' + asset.extension,
                );
                const uploaded = await comfy('upload/image', { form });
                if (typeof uploaded.name !== 'string' || !uploaded.name)
                  throw new Error('ComfyUI 没有返回参考图回执。');
                values[key] = uploaded.subfolder ? uploaded.subfolder + '/' + uploaded.name : uploaded.name;
              }
              const graph = sheetCharacter
                ? sheetGraph(config, values)
                : bindWorkflow(config.template, config.bindings, values);
              assertScope(exec);
              const job = randomUUID();
              db.run(
                'INSERT INTO novel_comfy_jobs (id, book, call_id, revision, caption, recipe, connection) VALUES (?, ?, ?, ?, ?, ?, ?)',
                job,
                book,
                exec.callId,
                config.revision,
                args.caption?.trim() || (sheetCharacter ? sheetCharacter.name + ' · 候选人设图' : 'AI 插图'),
                JSON.stringify({
                  preset: config.id,
                  seed,
                  ...(sheetCharacter ? { characterSheet: sheetCharacter } : {}),
                  ...(cast.length
                    ? { characterReferences: cast.map(({ name, chosen }) => ({ name, imagePath: chosen })) }
                    : {}),
                  ...(Object.keys(adjustments).length ? { adjustments } : {}),
                }),
                JSON.stringify({ base: base.href, ffmpeg: config.ffmpeg }),
              );
              row = find(book, job);
              // A lost POST response is ambiguous. Retain the receipt and never submit it twice.
              try {
                watcher = await watchComfy(base, live, exec.signal);
                exec.signal.throwIfAborted();
                const submitted = await comfy('prompt', {
                  data: {
                    prompt: graph,
                    ...(watcher
                      ? { client_id: watcher.clientId, extra_data: { preview_method: 'latent2rgb' } }
                      : {}),
                  },
                });
                if (typeof submitted.prompt_id !== 'string' || !submitted.prompt_id) return result('unknown');
                db.run('UPDATE novel_comfy_jobs SET prompt_id = ? WHERE id = ?', submitted.prompt_id, job);
                row = find(book, job);
                live.update(watcher ? 'queued' : 'waiting');
                watcher?.track(row.prompt_id);
              } catch (error) {
                if (error.status >= 400 && error.status < 500) {
                  db.run('DELETE FROM novel_comfy_jobs WHERE id = ?', job);
                  throw new Error('ComfyUI 拒绝了工作流，请检查节点和模型配置。');
                }
                exec.signal.throwIfAborted();
                return result('unknown');
              }
            } else live.update('waiting');
            const deadline = Date.now() + (generation ? waitMs : 0);
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
            live.update('saving');
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
                const character = characterFromRow();
                if (character)
                  characterVisuals.record(
                    book,
                    character,
                    unique.map(({ imagePath }) => imagePath),
                  );
                db.run('UPDATE novel_comfy_jobs SET images = ? WHERE id = ?', JSON.stringify(unique), row.id);
                return unique;
              });
              return completed(images);
            } finally {
              await rm(scratch, { recursive: true, force: true });
            }
          } finally {
            watcher?.stop();
            live.end();
          }
        },
      },
    ];
  });
}
