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
  bindReferenceCrops,
  characterReferenceViews,
  characterSheetCount,
  characterSheetLayout,
  characterVisualTypes,
  createCharacterVisuals,
  identityBindings,
  referenceViewCrop,
  sheetCanvas,
  sheetGraph,
  visualCharacter,
} from './character-visuals.mjs';

const maxImageBytes = 16 * 1024 * 1024;
const jobId = /^[0-9a-f-]{36}$/;
const sha = (text) => createHash('sha256').update(text).digest('hex');
const preferredVisualPresets = { anime: 'anima', realistic: 'moss-realistic' };

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
  { fs, installNovelTools, makeDocumentService, imageAsset, attachments, sessionQuery, backgroundJobs },
  configPath,
  { waitMs = 12 * 60 * 1000, pollMs = 4000, backgroundAfterMs = 8000, backgroundPollMs = 12000 } = {},
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
  const pendingSheet = (book, character) => db.one(`SELECT * FROM novel_comfy_jobs
    WHERE book=? AND images IS NULL AND json_extract(recipe,'$.characterSheet.id')=?
    AND COALESCE(json_extract(recipe,'$.characterSheet.visualType'),'legacy')=? ORDER BY rowid DESC LIMIT 1`,
    book, character.id, character.visualType,
  );
  const settings = createComfySettings(db, configPath);
  const progress = createComfyProgress();
  const characterVisuals = createCharacterVisuals(db);
  const resolving = new Map();
  const background = new Map();
  function jobResult(row, status, extra = {}) {
    return { ...JSON.parse(row.recipe ?? '{}'), status, bookId: row.book, jobId: row.id, ...extra };
  }
  function completed(row, images) {
    const character = JSON.parse(row.recipe ?? '{}').characterSheet;
    return character
      ? jobResult(row, 'character-options', { images, characterVisual: characterVisuals.get(row.book, character) })
      : jobResult(row, 'ready', { images });
  }
  async function resolveJob(row, { signal, update, checkQueue }) {
    if (row.images) return completed(row, JSON.parse(row.images));
    if (!row.prompt_id) return jobResult(row, 'unknown');
    let config = JSON.parse(row.connection ?? 'null');
    if (!config) {
      const original = await settings.original();
      config = [...original.presets.values()].find((preset) => preset.revision === row.revision);
    }
    if (!config) return jobResult(row, 'unavailable');
    const base = new URL(config.base);
    const comfy = (route, options) => request(base, route, { ...options, signal });
    const historyPath = 'history/' + encodeURIComponent(row.prompt_id);
    let history = (await comfy(historyPath))[row.prompt_id];
    if (!history && checkQueue) {
      const queue = await comfy('queue');
      const contains = (items) => items?.some((item) => item?.[1] === row.prompt_id);
      if (contains(queue.queue_running)) return jobResult(row, 'generating');
      if (contains(queue.queue_pending)) return jobResult(row, 'queued');
      // The job may have finished between the history lookup and the queue snapshot.
      history = (await comfy(historyPath))[row.prompt_id];
      if (!history) return jobResult(row, 'unavailable');
    }
    if (!history) return jobResult(row, 'queued');
    if (history.status?.status_str === 'error') return jobResult(row, 'failed');
    const files = Object.values(history.outputs ?? {})
      .flatMap((node) => node.images ?? [])
      .filter((file) => file.type === 'output' && /\.(png|jpe?g|webp)$/i.test(file.filename))
      .slice(0, 4);
    if (!files.length) return jobResult(row, 'no-output');
    update?.('saving');
    const service = makeDocumentService(fs, db, row.book);
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
          signal,
        );
        assets.push(content);
      }
      signal?.throwIfAborted();
      const images = db.transactionSync(() => {
        const stored = find(row.book, row.id)?.images;
        if (stored) return JSON.parse(stored);
        const published = assets.map((content) => ({
          imagePath: service.run({ kind: 'illustrations', action: 'upload', content }).imagePath,
          label: row.caption,
        }));
        const unique = [...new Map(published.map((image) => [image.imagePath, image])).values()];
        const character = JSON.parse(row.recipe ?? '{}').characterSheet;
        if (character)
          characterVisuals.record(row.book, character, unique.map(({ imagePath }) => imagePath));
        db.run('UPDATE novel_comfy_jobs SET images = ? WHERE book = ? AND id = ?', JSON.stringify(unique), row.book, row.id);
        return unique;
      });
      return completed(row, images);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
  function reconcile(row, options) {
    if (row.images) return Promise.resolve(completed(row, JSON.parse(row.images)));
    if (!resolving.has(row.id)) {
      // The image belongs to the book even if the requesting tab or turn closes.
      const pending = resolveJob(row, { ...options, signal: AbortSignal.timeout(120_000) })
        .catch(() => jobResult(row, 'retrying'));
      resolving.set(row.id, pending);
      pending.finally(() => resolving.delete(row.id)).catch(() => {});
    }
    return resolving.get(row.id);
  }
  function trackInBackground(jobs, row, exec, live, watcher) {
    const current = background.get(row.id);
    if (current) return current;
    try {
      const id = jobs.start({
        kind: 'comfy',
        label: '小说插画 · ' + row.id,
        owner: exec.agent.session.id,
        ...(exec.rootCallId ? { toolCall: { callId: exec.callId, rootCallId: exec.rootCallId } } : {}),
        outputLimitBytes: 2000,
        run() {
          const owner = new AbortController();
          const signal = AbortSignal.any([owner.signal, AbortSignal.timeout(6 * 60 * 60 * 1000)]);
          async function finish() {
            let missing = 0;
            while (true) {
              await delay(backgroundPollMs, undefined, { signal });
              const result = await reconcile(find(row.book, row.id) ?? row, {
                checkQueue: true,
                update: live.update,
              });
              signal.throwIfAborted();
              if (result.status === 'unavailable' && ++missing < 3) continue;
              if (['queued', 'generating', 'retrying'].includes(result.status)) {
                missing = 0;
                continue;
              }
              const ready = ['ready', 'character-options'].includes(result.status);
              return {
                status: ready ? 'completed' : 'failed',
                result: JSON.stringify({
                  status: result.status,
                  jobId: row.id,
                  paths: result.images?.map(({ imagePath }) => imagePath),
                  next: result.status === 'character-options'
                    ? '候选已在原对话和图集显示；等待作者选择，无需再次生图。'
                    : ready
                      ? '图已存入本书，继续本次尚未完成的写作或插画安排。'
                      : '本次生图未完成；简述状态，继续可独立完成的部分。',
                }),
              };
            }
          }
          return {
            cancel: () => owner.abort(),
            done: finish()
              .catch(() => owner.signal.aborted
                ? { status: 'killed' }
                : { status: 'failed', detail: '同步等待超过时限' })
              .finally(() => {
                background.delete(row.id);
                watcher?.stop();
                live.end();
              }),
          };
        },
      });
      watcher?.retain();
      background.set(row.id, id);
      return id;
    } catch {
      // The job controller may be intentionally absent from this assistant preset.
      return null;
    }
  }
  instance.comfy = {
    settings,
    progress,
    characterVisuals,
    characterBook: (book) => makeDocumentService(fs, db, book),
    gallery(book, cursor, sheetsOnly) {
      const limit = 8;
      const rows = db.all(`SELECT rowid AS position,id,caption,recipe,images FROM novel_comfy_jobs
        WHERE book=? AND images IS NOT NULL AND rowid < ?
        ${sheetsOnly ? "AND json_type(recipe, '$.characterSheet') = 'object'" : ''}
        ORDER BY rowid DESC LIMIT ?`, book, cursor, limit + 1);
      return {
        batches: rows.slice(0, limit).map((row) => {
          const character = JSON.parse(row.recipe ?? '{}').characterSheet;
          return {
            id: row.id,
            caption: row.caption,
            images: JSON.parse(row.images),
            ...(character ? { character: characterVisuals.get(book, character) } : {}),
          };
        }),
        nextCursor: rows.length > limit ? rows[limit - 1].position : null,
      };
    },
    unbatched(book, images) {
      const batched = db.all(`SELECT DISTINCT json_extract(image.value, '$.imagePath') AS path
        FROM novel_comfy_jobs AS batch, json_each(batch.images) AS image
        WHERE batch.book=? AND batch.images IS NOT NULL AND json_extract(image.value, '$.imagePath')
          IN (SELECT value FROM json_each(?))`, book, JSON.stringify(images.map(({ imagePath }) => imagePath)));
      const paths = new Set(batched.map(({ path }) => path));
      return images.filter(({ imagePath }) => !paths.has(imagePath));
    },
    job(book, id) {
      const row = jobId.test(id) && find(book, id);
      return row ? reconcile(row, { checkQueue: true }) : null;
    },
  };
  return installNovelTools(instance.sessions.context, ({ root, assertScope }) => {
    const book = root.slice('/workspace/novels/'.length);
    return [
      {
        name: 'novel_generate_image',
        description:
          '画图、改图和生成候选人设图。generate 的 characters 列出全部具名角色，空镜或路人用空数组。具名角色和 character_sheet 都需要 visual_type：realistic（真人）或 anime（动漫）。每种画风由作者独立定妆。需要单人参考时传入 shot，工具按镜头取用已标记的视图；省略 shot 使用完整定妆图。缺少视图时用 inspect 查看 chosen，再用 character_reference_views 标记清晰的正面全身和脸部近景，后续按镜头复用。缺少定妆时用 character_sheet 生成三张候选供作者选择。characters 查看定妆，presets 查看工作流。已排队或生成中时继续独立工作或结束本轮，等待通知后用 job_output 取结果，无需轮询或重新提交。章节首版入书后再重画，revises 填图集路径。',
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
                'character_reference_views',
              ],
            },
            character: {
              type: 'string',
              maxLength: 80,
              description: 'character_sheet 或 character_reference_views 的角色姓名。',
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
            visual_type: { type: 'string', enum: characterVisualTypes },
            shot: {
              type: 'string',
              enum: characterReferenceViews,
              description: 'generate 镜头：全身或动作填 full_body；脸部或肩部特写填 close_up。',
            },
            views: {
              type: 'object',
              properties: Object.fromEntries(
                characterReferenceViews.map((view) => [
                  view,
                  {
                    type: 'array',
                    minItems: 4,
                    maxItems: 4,
                    items: { type: 'integer', minimum: 0, maximum: 1000 },
                    description: '当前定妆原图上的单人框 [左,上,右,下]，坐标为整张图的千分比。',
                  },
                ]),
              ),
              additionalProperties: false,
            },
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
                'generate 支持 chat:latest、对话图片 ID 或本书 illustrations/ 路径。inspect 用图集路径，character_reference_views 必须填写当前定妆图路径。',
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
            const { attachment, label, width, height, chapterDelivery } = JSON.parse(value);
            const caption = width && height ? `${label}（${width} × ${height}）` : label;
            return [
              {
                type: 'text',
                text: chapterDelivery ? caption + '\n' + JSON.stringify(chapterDelivery) : caption,
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
                      : action === 'character_reference_views'
                        ? '保存定妆图参考范围'
                        : action === 'status'
                          ? '查询插图任务'
                          : '生成插图',
        }),
        async execute(args, exec) {
          const { action, prompt, reference, job_id: id } = args;
          const sheet = action === 'character_sheet';
          const marking = action === 'character_reference_views';
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
                  : marking
                    ? ['action', 'character', 'visual_type', 'reference', 'views']
                    : [
                        'action',
                        'prompt',
                        'caption',
                        ...(sheet ? ['character', 'new_variants'] : ['characters', 'revises', 'shot']),
                        'reference',
                        'preset',
                        'visual_type',
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
              'character_reference_views',
            ].includes(action) ||
            Object.keys(args).some((key) => !keys.includes(key)) ||
            (args.visual_type !== undefined && !characterVisualTypes.includes(args.visual_type)) ||
            (args.shot !== undefined && !characterReferenceViews.includes(args.shot)) ||
            (marking &&
              (!characterVisualTypes.includes(args.visual_type) || typeof reference !== 'string')) ||
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
          if (marking) {
            const character = visualCharacter(args.character, args.visual_type);
            if (characterVisuals.get(book, character).chosen !== reference)
              throw new Error('只能标记作者当前选定的人设图。');
            const dimensions = service.run({ kind: 'illustrations', action: 'read', imagePath: reference });
            const characterVisual = characterVisuals.saveReferenceViews(
              book,
              character,
              reference,
              args.views,
              dimensions,
            );
            return JSON.stringify({ status: 'character-reference-saved', bookId: book, characterVisual });
          }
          if (action === 'references') {
            const found = await references();
            assertScope(exec);
            return JSON.stringify({
              references: [...found].map(([id, { name, width, height }]) => ({ id, name, width, height })),
            });
          }
          if (action === 'inspect') {
            const { data, label, width, height } = service.run({
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
              width,
              height,
              ...(pending ? { chapterDelivery: pending } : {}),
            });
          }
          let row = action === 'status' ? find(book, id) : generation ? findCall(book, exec.callId) : null;
          if (!row && action === 'status') throw new Error('找不到本书中的生图任务。');
          const result = (status, extra) => JSON.stringify(jobResult(row, status, extra));
          if (row?.images) return JSON.stringify(completed(row, JSON.parse(row.images)));
          if (row && !row.prompt_id) return result('unknown');
          if (action === 'status') {
            const current = await reconcile(row, { checkQueue: true });
            assertScope(exec);
            return JSON.stringify(current);
          }
          const existingBackground = row && background.get(row.id);
          if (existingBackground)
            return result('queued', { backgroundJobId: existingBackground, progressCallId: row.call_id });
          const state = (status, extra) => JSON.stringify({ status, bookId: book, ...extra });
          if (!row && (sheet || (Array.isArray(args.characters) && args.characters.length)) && !args.visual_type)
            return state('identify-visual-type', {
              next: '请按画面需求传入 visual_type：realistic（真人）或 anime（动漫）。',
            });
          const sheetCharacter = !row && sheet ? visualCharacter(args.character, args.visual_type) : null;
          let cast = [];
          if (!row && action === 'generate') {
            if (args.characters === undefined)
              return state('identify-characters', {
                next: '重试时传入 characters，列出画面中全部具名角色，无角色时填 []。',
              });
            cast = characterVisuals.resolve(book, args.characters, args.visual_type);
            const pending = cast.filter(({ chosen }) => !chosen);
            if (pending.length)
              return state('character-design-needed', {
                characters: pending,
                next: '为缺少候选的角色生成同一 visual_type 的候选，有候选的等作者定妆。正文可继续交付。',
              });
            if (args.shot) {
              const missing = cast.filter(({ referenceViews }) => !referenceViews?.[args.shot]);
              if (missing.length)
                return state('character-reference-views-needed', {
                  shot: args.shot,
                  characters: missing,
                  next: '用 inspect 查看 chosen，再用 character_reference_views 标记单人视图，随后重试。',
                });
            }
          }
          let checkedSheet;
          const existingSheet = (pending, status) => JSON.stringify(jobResult(pending, status, {
            progressCallId: pending.call_id,
            next: '已提交同一角色的这类候选，请等待本批完成。',
          }));
          if (sheetCharacter) {
            const characterVisual = characterVisuals.get(book, sheetCharacter);
            if (!args.new_variants) {
              if (characterVisual.chosen) return state('character-locked', { characterVisual });
              if (characterVisual.candidates.length >= 2) return state('character-options', { characterVisual });
            }
            checkedSheet = pendingSheet(book, sheetCharacter);
            if (checkedSheet) {
              const active = progress.read(book, checkedSheet.call_id);
              if (active) return existingSheet(checkedSheet, active.stage === 'generating' ? 'generating' : 'queued');
              const current = await reconcile(checkedSheet, { checkQueue: true });
              assertScope(exec);
              if (['queued', 'generating', 'retrying', 'unknown'].includes(current.status))
                return existingSheet(checkedSheet, current.status);
              if (current.status === 'character-options' && !args.new_variants) return JSON.stringify(current);
            }
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
                    : available.presets.has(preferredVisualPresets[args.visual_type])
                      ? preferredVisualPresets[args.visual_type]
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
          const jobs = backgroundJobs ?? exec.agent.ctx?.get('jobs');
          const candidateCount = sheetCharacter ? characterSheetCount : 0;
          const live = progress.begin(book, exec.callId, candidateCount);
          let watcher, handedOff = false;
          try {
            if (!row) {
              const refs = Object.fromEntries(
                cast.map(({ chosen }, index) => [identitySlots[index], chosen]),
              );
              if (reference) refs.reference = reference;
              if (config.requiresReference && !refs.reference) throw new Error('此编辑预设需要提供参考图。');
              const referenceCrops = {};
              const usedViews = cast.map(({ name, chosen, referenceViews }, index) => {
                const shot = args.shot;
                const box = shot && referenceViews?.[shot];
                if (box) referenceCrops[identitySlots[index]] = box;
                return { name, imagePath: chosen, ...(box ? { view: shot, box } : {}) };
              });
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
              const crops = Object.fromEntries(
                Object.entries(referenceCrops).map(([key, box]) => [
                  key,
                  referenceViewCrop(box, assets[key]),
                ]),
              );
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
              const graph = bindReferenceCrops(
                bindWorkflow(config.template, config.bindings, values),
                config.bindings,
                crops,
                Object.keys(assets),
              );
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
                const path = uploaded.subfolder ? uploaded.subfolder + '/' + uploaded.name : uploaded.name;
                values[key] = path;
                for (const [node, input] of config.bindings[key]) graph[node].inputs[input] = path;
              }
              const promptGraph = sheetCharacter ? sheetGraph(config, values) : graph;
              assertScope(exec);
              if (sheetCharacter) {
                const pending = pendingSheet(book, sheetCharacter);
                if (pending && pending.id !== checkedSheet?.id) return existingSheet(pending, 'queued');
                // Another turn can finish its submission while this one prepares the graph.
                if (!args.new_variants) {
                  const latest = characterVisuals.get(book, sheetCharacter);
                  if (latest.chosen) return state('character-locked', { characterVisual: latest });
                  if (latest.candidates.length >= 2) return state('character-options', { characterVisual: latest });
                }
              }
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
                  ...(cast.length ? { characterReferences: usedViews } : {}),
                  ...(args.visual_type ? { visualType: args.visual_type } : {}),
                  ...(Object.keys(adjustments).length ? { adjustments } : {}),
                }),
                JSON.stringify({ base: base.href, ffmpeg: config.ffmpeg }),
              );
              row = find(book, job);
              // A lost POST response is ambiguous. Retain the receipt and never submit it twice.
              try {
                watcher = await watchComfy(base, live, exec.signal, { candidateCount });
                exec.signal.throwIfAborted();
                const submitted = await comfy('prompt', {
                  data: {
                    prompt: promptGraph,
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
            const startedWaiting = Date.now();
            const deadline = startedWaiting + (generation ? waitMs : 0);
            while (true) {
              const current = await reconcile(row, {
                update: live.update,
                checkQueue: Date.now() >= deadline,
              });
              assertScope(exec);
              if (jobs?.start && ['queued', 'generating', 'retrying'].includes(current.status) &&
                  (current.status === 'retrying' || Date.now() >= startedWaiting + backgroundAfterMs)) {
                const backgroundJobId = trackInBackground(jobs, row, exec, live, watcher);
                if (backgroundJobId) {
                  handedOff = true;
                  return JSON.stringify({ ...current, backgroundJobId, progressCallId: row.call_id,
                    next: '等待系统完成通知。继续独立工作或结束本轮，无需查询或重新提交。' });
                }
              }
              if (!['queued', 'generating'].includes(current.status) || Date.now() >= deadline)
                return JSON.stringify(current);
              await delay(Math.min(pollMs, Math.max(0, deadline - Date.now())), undefined, {
                signal: exec.signal,
              });
            }
          } finally {
            if (!handedOff) {
              watcher?.stop();
              live.end();
            }
          }
        },
      },
    ];
  });
}
