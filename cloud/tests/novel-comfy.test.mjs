import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';
import { bindWorkflow, main } from '../scripts/novel-comfy.mjs';
import { illustrationEntries, imageAsset } from '../worker/shared/illustrations.mjs';
import { installComfyTools } from '../official/novel/comfy-tools.mjs';
import { installNovelTools } from '../worker/novel-tools.mjs';
import { compileVisualPrompt, loadComfyPresets, referenceCanvas } from '../official/novel/comfy-presets.mjs';
import { createComfySettings } from '../official/novel/comfy-settings.mjs';
import { createComfyProgress, watchComfy } from '../official/novel/comfy-progress.mjs';
import {
  createCharacterVisuals,
  sheetGraph,
  identityBindings,
  visualCharacter,
} from '../official/novel/character-visuals.mjs';
import { WebSocketServer } from '../tools/node_modules/ws/wrapper.mjs';

const sha = (text) => createHash('sha256').update(text).digest('hex');
const bytes = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64');
const template = {
  5: { class_type: 'MyLayoutOrTextEncoder', inputs: { text: '', images: ['4', 0] } },
  4: { class_type: 'LoadImage', inputs: { image: 'example.png' } },
  6: { class_type: 'Sampler', inputs: { seed: 0, style: '', width: 1024 } },
};
const bindings = {
  script: [['5', 'text']],
  ref: [['4', 'image']],
  seed: [['6', 'seed']],
  style: [['6', 'style']],
};
const novelId = 'b-' + 'a'.repeat(32);
const chapter = 'chapters/1.md';
const reference = 'illustrations/' + 'b'.repeat(64) + '.json';

test('author-locked character sheets are book-scoped and checked on changes', (t) => {
  const raw = new DatabaseSync(':memory:');
  t.after(() => raw.close());
  const db = {
    run: (sql, ...args) => raw.prepare(sql).run(...args),
    one: (sql, ...args) => raw.prepare(sql).get(...args),
    all: (sql, ...args) => raw.prepare(sql).all(...args),
    transactionSync(fn) {
      raw.exec('BEGIN');
      try {
        const value = fn();
        raw.exec('COMMIT');
        return value;
      } catch (error) {
        raw.exec('ROLLBACK');
        throw error;
      }
    },
  };
  const person = visualCharacter('陆蘅');
  const alternate = 'illustrations/' + 'c'.repeat(64) + '.json';
  raw.exec(`CREATE TABLE novel_character_visuals (
    book TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, revision INTEGER NOT NULL,
    chosen TEXT, candidates TEXT NOT NULL, PRIMARY KEY(book,id)
  )`);
  db.run('INSERT INTO novel_character_visuals VALUES (?,?,?,?,?,?)',
    novelId, person.id, person.name, 9, alternate, JSON.stringify([alternate]));
  const store = createCharacterVisuals(db);
  assert.equal(store.get(novelId, person).chosen, alternate);
  assert.equal(store.get(novelId, person).revision, 9);
  const initial = store.record(novelId, person, [reference]);
  const pick = (value) => ({ id: person.id, revision: value.revision, imagePath: reference });
  const candidates = store.record(novelId, person, [alternate]);
  assert.throws(() => store.choose('b-' + 'a'.repeat(31) + 'b', pick(candidates), () => {}), { status: 404 });
  assert.throws(() => store.choose(novelId, pick(initial), () => {}), { status: 409 });
  assert.throws(
    () =>
      store.choose(novelId, pick(candidates), () => {
        throw new Error('Missing asset');
      }),
    /Missing asset/,
  );
  assert.equal(store.resolve(novelId, ['陆蘅'])[0].chosen, alternate);
  const locked = store.choose(novelId, pick(candidates), (path) => assert.equal(path, reference));
  assert.equal(store.choose(novelId, pick(candidates), () => {}).revision, locked.revision);
  assert.equal(createCharacterVisuals(db).resolve(novelId, ['　陆蘅　'])[0].chosen, reference);
  assert.equal(store.record(novelId, person, [alternate]).chosen, reference);
  const anime = visualCharacter('陆蘅', 'anime');
  const realistic = visualCharacter('陆蘅', 'realistic');
  assert.equal(anime.id, realistic.id);
  const animeOptions = store.record(novelId, anime, [reference, alternate]);
  assert.equal(store.resolve(novelId, ['陆蘅'], 'realistic')[0].candidates.length, 0);
  const realOptions = store.record(novelId, realistic, [alternate, reference]);
  assert.equal(realOptions.revision, animeOptions.revision);
  store.choose(novelId, { ...pick(animeOptions), visualType: 'anime' }, () => {});
  store.choose(novelId, { ...pick(realOptions), visualType: 'realistic', imagePath: alternate }, () => {});
  assert.equal(store.resolve(novelId, ['陆蘅'], 'realistic')[0].chosen, alternate);
  assert.equal(store.resolve(novelId, ['陆蘅'], 'anime')[0].chosen, reference);
  const views = { full_body: [250, 30, 530, 970] };
  const dimensions = { width: 1536, height: 896 };
  store.saveReferenceViews(novelId, anime, reference, views, dimensions);
  assert.deepEqual(createCharacterVisuals(db).get(novelId, anime).referenceViews, views);
  assert.equal(store.get(novelId, realistic).referenceViews, undefined);
  const latest = store.get(novelId, anime);
  store.choose(novelId, { ...pick(latest), visualType: 'anime', imagePath: alternate }, () => {});
  assert.equal(store.get(novelId, anime).referenceViews, undefined);
  assert.throws(() => store.saveReferenceViews(novelId, anime, reference, views, dimensions), {
    status: 409,
  });
});

test('turnaround sheets use three seeds and scene references require sufficient independent slots', () => {
  const source = {
    template: {
      1: { class_type: 'Sampler', inputs: { seed: 0 } },
      2: { class_type: 'Save', inputs: { images: ['1', 0] } },
    },
    bindings: { seed: [['1', 'seed']] },
  };
  const graph = sheetGraph(source, { seed: 12 });
  assert.deepEqual(
    [0, 1, 2].map((i) => graph[i + '-1'].inputs.seed),
    [12, 13, 14],
  );
  assert.deepEqual(graph['2-2'].inputs.images, ['2-1', 0]);
  assert.deepEqual(source.template[2].inputs.images, ['1', 0]);
  assert.deepEqual(identityBindings({ bindings: { reference: [] } }, 1, false), ['reference']);
  assert.equal(identityBindings({ bindings: { reference: [] } }, 2, false), null);
  assert.deepEqual(
    identityBindings(
      { bindings: { reference: [], characterReference1: [], characterReference2: [] } },
      2,
      true,
    ),
    ['characterReference1', 'characterReference2'],
  );
});

test('ComfyUI settings validate host endpoints, numeric controls and concurrent saves', async (t) => {
  const raw = new DatabaseSync(':memory:');
  t.after(() => raw.close());
  const db = {
    run: (sql, ...args) => raw.prepare(sql).run(...args),
    one: (sql, ...args) => raw.prepare(sql).get(...args),
  };
  const dir = await mkdtemp(join(tmpdir(), 'novel-comfy-settings-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'config.json');
  await writeFile(join(dir, 'workflow.json'), JSON.stringify(template));
  await writeFile(
    file,
    JSON.stringify({
      comfy: 'http://127.0.0.1:8188',
      allowedComfyEndpoints: ['http://127.0.0.1:8288'],
      workflow: 'workflow.json',
      bindings: { prompt: bindings.script, width: [['6', 'width']] },
      controls: { width: { min: 512, max: 1600, step: 16 } },
    }),
  );
  const settings = createComfySettings(db, file);
  const initial = await settings.read();
  const input = { ...initial, comfy: initial.endpoints[1], values: { default: { width: 1152 } } };
  await assert.rejects(settings.save({ ...input, comfy: 'http://127.0.0.1:80' }), /主机已登记/);
  await assert.rejects(settings.save({ ...input, values: { default: { width: 1153 } } }), /超出/);
  const saved = await settings.save(input);
  assert.equal(saved.presets[0].controls.width.default, 1152);
  assert.equal(saved.comfy, 'http://127.0.0.1:8288/');
  await assert.rejects(settings.save(input), { status: 409 });
  assert.deepEqual(await createComfySettings(db, file).read(), saved);
});

test('ComfyUI forwards the matching sampler progress and short-lived preview', async (t) => {
  const server = createServer();
  const sockets = new WebSocketServer({ server });
  t.after(() => {
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
    server.close();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const pending = once(sockets, 'connection');
  const progress = createComfyProgress();
  const live = progress.begin(novelId, 'test-call');
  const watcher = await watchComfy(
    new URL(`http://127.0.0.1:${server.address().port}/`),
    live,
    new AbortController().signal,
  );
  const [socket, request] = await pending;
  assert.match(request.url, new RegExp('clientId=' + watcher.clientId));
  watcher.track('my-prompt');
  for (const [value, prompt_id] of [
    [99, 'other-prompt'],
    [7, 'my-prompt'],
  ])
    socket.send(JSON.stringify({ type: 'progress', data: { value, max: 32, prompt_id } }));
  socket.send(Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 255, 216, 255, 217]));
  for (let attempt = 0; attempt < 30 && !progress.read(novelId, 'test-call').previewId; attempt++)
    await delay(20);
  const snapshot = progress.read(novelId, 'test-call');
  assert.deepEqual(snapshot, { stage: 'generating', value: 7, max: 32, previewId: 1 });
  assert.equal(progress.read(novelId, 'test-call', true).type, 'image/jpeg');
  assert.equal(progress.read('b-' + 'b'.repeat(32), 'test-call'), null);
  watcher.stop();
  live.end();
  assert.equal(progress.read(novelId, 'test-call', true), null);
});

test('a saved candidate appears before its batch finishes and survives background handoff', async (t) => {
  const fetched = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    fetched.push(url.searchParams.get('filename'));
    res.writeHead(200, { 'content-type': 'image/webp' }).end(bytes);
  });
  const sockets = new WebSocketServer({ server });
  t.after(() => { for (const socket of sockets.clients) socket.terminate(); sockets.close(); server.close(); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const connecting = once(sockets, 'connection');
  const progress = createComfyProgress();
  const live = progress.begin(novelId, 'sheet-call', 3);
  const turn = new AbortController();
  const watcher = await watchComfy(new URL(`http://127.0.0.1:${server.address().port}/`), live, turn.signal, { candidateCount: 3 });
  const [socket] = await connecting;
  watcher.track('sheet-prompt');
  watcher.retain();
  turn.abort();
  for (const [promptId, filename] of [['wrong-prompt', 'wrong.webp'], ['sheet-prompt', 'first.webp'], ['sheet-prompt', 'first.webp']])
    socket.send(JSON.stringify({ type: 'executed', data: { prompt_id: promptId, output: { images: [{ filename, type: 'output' }] } } }));
  for (let i = 0; i < 30 && !progress.read(novelId, 'sheet-call').previewId; i++) await delay(20);
  assert.deepEqual(fetched, ['first.webp']);
  assert.equal(progress.read(novelId, 'sheet-call').candidatesFinished, 1);
  assert.equal(progress.read(novelId, 'sheet-call').previewCompleted, true);
  assert.deepEqual(progress.read(novelId, 'sheet-call', true).bytes, bytes);
  watcher.stop();
  live.end();
});

test('book-scoped agent can submit, resume after reload, and publish a candidate without editing prose', async (t) => {
  const raw = new DatabaseSync(':memory:');
  const db = {
    run: (sql, ...args) => raw.prepare(sql).run(...args),
    all: (sql, ...args) => raw.prepare(sql).all(...args),
    one: (sql, ...args) => raw.prepare(sql).get(...args),
    transactionSync(run) {
      raw.exec('SAVEPOINT fixture_tool');
      try {
        const result = run();
        raw.exec('RELEASE fixture_tool');
        return result;
      } catch (error) {
        raw.exec('ROLLBACK TO fixture_tool; RELEASE fixture_tool');
        throw error;
      }
    },
  };
  t.after(() => raw.close());
  const dir = await mkdtemp(join(tmpdir(), 'novel-comfy-tool-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let prompts = 0;
  const rendered = [];
  const referenceUploads = [];
  const chatImage = {
    attachmentId: 'chat-digest',
    mediaType: 'image/png',
    name: '图.png',
    width: 32,
    height: 32,
  };
  let ready = false;
  let running = false;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (value) => res.end(JSON.stringify(value));
    if (url.pathname === '/prompt') {
      prompts++;
      const data = JSON.parse(await new Response(ReadableStream.from(req)).text());
      rendered.push(data.prompt);
      return send({ prompt_id: 'comfy-receipt' });
    }
    if (url.pathname === '/upload/image') {
      const payload = Buffer.from(await new Response(ReadableStream.from(req)).arrayBuffer());
      referenceUploads.push(payload);
      return send({ name: 'upload.webp', subfolder: 'fixture' });
    }
    if (url.pathname === '/history/comfy-receipt') {
      const files = Object.hasOwn(rendered.at(-1) ?? {}, '0-5')
        ? ['one.webp', 'two.webp', 'three.webp']
        : ['one.webp'];
      return send(
        ready
          ? {
              'comfy-receipt': {
                outputs: { 8: { images: files.map((filename) => ({ type: 'output', filename })) } },
              },
            }
          : {},
      );
    }
    if (url.pathname === '/queue')
      return send({
        queue_running: running ? [[1, 'comfy-receipt']] : [],
        queue_pending: running ? [] : [[1, 'comfy-receipt']],
      });
    if (url.pathname === '/view') {
      const version = ['one.webp', 'two.webp', 'three.webp'].indexOf(url.searchParams.get('filename'));
      const sample = Buffer.from(bytes);
      if (version > 0) sample[sample.length - 1] = version;
      return res.end(sample);
    }
    res.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((done) => server.close(done)));
  const config = join(dir, 'tool.json');
  await writeFile(join(dir, 'workflow.json'), JSON.stringify(template));
  await writeFile(
    config,
    JSON.stringify({
      comfy: 'http://127.0.0.1:' + server.address().port,
      workflow: 'workflow.json',
      bindings: { prompt: bindings.script, reference: bindings.ref, seed: bindings.seed },
    }),
  );
  const uploads = [];
  const turnEvents = [];
  const root = '/workspace/novels/' + novelId;
  const proseTask = {
    bookId: novelId,
    target: root + '/' + chapter,
    task: { kind: 'prose' },
    proposalId: 'current-prose',
    status: 'pending',
    expectedHash: 'initial',
  };
  function receipt(name, value) {
    const callId = 'receipt-' + turnEvents.length;
    turnEvents.push({ type: 'tool/call', data: { name, callId } });
    turnEvents.push({
      type: 'tool/result',
      data: { message: { toolCallId: callId, content: [{ type: 'text', text: JSON.stringify(value) }] } },
    });
  }
  function tools(book, configPath = config, backgroundJobs) {
    const definitions = new Map();
    const agent = {
      session: { id: book },
      ctx: { get: () => ({ register: (tool) => definitions.set(tool.name, tool) }) },
    };
    const instance = {
        ctx: { storage: db },
        sessions: {
          context: {
            on: (_event, listener) => listener({ agent }),
            get: () => ({ get: () => '/workspace/novels/' + book }),
          },
        },
    };
    installComfyTools(
      instance,
      {
        installNovelTools,
        backgroundJobs,
        imageAsset,
        sessionQuery: {
          readSession(session) {
            return {
              events:
                session === novelId
                  ? [
                      {
                        type: 'tool/result',
                        data: {
                          content: [
                            { type: 'image', attachment: { ...chatImage, attachmentId: 'tool-only' } },
                          ],
                        },
                      },
                      { type: 'user/message', data: { content: [{ type: 'image', attachment: chatImage }] } },
                      ...turnEvents,
                    ]
                  : [],
            };
          },
        },
        attachments: {
          readImage: (ref) => {
            assert.equal(ref, chatImage);
            return { data: bytes };
          },
          saveImage({ data, mediaType }) {
            assert.deepEqual(data, bytes);
            assert.equal(mediaType, 'image/webp');
            return { ...chatImage, mediaType, attachmentId: 'saved-gallery-image' };
          },
        },
        makeDocumentService: (_fs, _db, id) => ({
          run(operation) {
            assert.equal(id, novelId);
            assert.equal(operation.kind, 'illustrations');
            if (operation.action === 'read') {
              if (operation.imagePath === reference)
                return { data: 'data:image/webp;base64,' + bytes.toString('base64') };
              const match = uploads.find(
                (item) => operation.imagePath === 'illustrations/' + sha(item) + '.json',
              );
              assert(match);
              return { ...imageAsset(match), width: 1536, height: 896 };
            }
            assert.equal(operation.action, 'upload');
            assert.equal(imageAsset(operation.content).label, '灯塔');
            uploads.push(operation.content);
            return { imagePath: 'illustrations/' + sha(operation.content) + '.json' };
          },
        }),
      },
      configPath,
      { waitMs: 0, backgroundAfterMs: 0, backgroundPollMs: 5 },
    );
    const execute = async (args, callId = 'native-call') =>
      JSON.parse(
        await definitions
          .get('novel_generate_image')
          .execute(args, { agent, signal: new AbortController().signal, callId }),
      );
    execute.job = (id) => instance.comfy.job(book, id);
    execute.gallery = (type) => instance.comfy.gallery(book, Number.MAX_SAFE_INTEGER, type === 'characters');
    execute.unbatched = (images) => instance.comfy.unbatched(book, images);
    return execute;
  }
  const call = tools(novelId);
  const request = {
    action: 'generate',
    characters: [],
    prompt: '夜里的灯塔和一束微弱暖光',
    caption: '灯塔',
    reference,
  };
  const legacyCall = { ...request };
  delete legacyCall.characters;
  assert.equal((await call(legacyCall, 'no-cast')).status, 'identify-characters');
  const drawing = { ...request, characters: ['陆蘅'], reference: undefined, visual_type: 'anime' };
  assert.equal((await call(drawing, 'before-lock')).status, 'character-design-needed');
  assert.equal(prompts, 0);
  const inspected = await call({ action: 'inspect', reference }, 'inspect');
  assert.equal(inspected.attachment.attachmentId, 'saved-gallery-image');
  const queued = await call(request);
  assert.equal(queued.status, 'queued');
  assert.equal((await call(request)).jobId, queued.jobId);
  assert.equal(prompts, 1);
  const status = { action: 'status', job_id: queued.jobId };
  const otherBook = tools('b-' + 'b'.repeat(32));
  await assert.rejects(otherBook(status), /找不到本书/);
  assert.equal(await otherBook.job(queued.jobId), null);
  running = true;
  assert.equal((await call.job(queued.jobId)).status, 'generating');
  running = false;
  ready = true;
  const completed = await tools(novelId)(status);
  assert.equal(completed.status, 'ready');
  assert.equal(completed.images[0].label, '灯塔');
  assert.deepEqual(await call(status), completed);
  assert.equal(uploads.length, 1);
  assert.equal(completed.preset, 'default');
  assert.equal(completed.seed, queued.seed);
  assert.equal(rendered[0]['5'].inputs.text, '夜里的灯塔和一束微弱暖光');
  assert.equal(rendered[0]['4'].inputs.image, 'fixture/upload.webp');
  turnEvents.push({ type: 'turn/start', data: { turn: 1 } });
  receipt('novel_proposal_prepare', proseTask);
  receipt('novel_generate_image', completed);
  const deferred = await call({ ...request, prompt: '消掉黑边' }, 'clock-redraw-before-delivery');
  assert.equal(deferred.status, 'deliver-chapter');
  assert.equal(deferred.chapterDelivery.images[0].imagePath, completed.images[0].imagePath);
  assert.equal(deferred.chapterDelivery.expectedHash, 'initial');
  assert.equal(prompts, 1);
  assert.equal(
    (
      await call(
        { ...request, caption: '改称旧钟', revises: completed.images[0].imagePath },
        'renamed-redraw',
      )
    ).status,
    'deliver-chapter',
  );
  const second = {
    status: 'ready',
    bookId: novelId,
    images: [
      { imagePath: 'illustrations/' + 'c'.repeat(64) + '.json', label: '另一幕' },
      { imagePath: 'illustrations/' + 'e'.repeat(64) + '.json', label: '另一幕' },
    ],
  };
  receipt('novel_generate_image', second);
  receipt('novel_proposal_submit', {
    ...proseTask,
    status: 'accepted',
    chapterIllustrations: [completed.images[0].imagePath, second.images[1].imagePath],
  });
  receipt('novel_generate_image', {
    ...completed,
    images: [{ imagePath: 'illustrations/' + 'd'.repeat(64) + '.json', label: '灯塔' }],
  });
  assert.equal((await call({ ...request, prompt: '消掉黑边' }, 'redraw-after-delivery')).status, 'ready');
  assert.equal(prompts, 2);
  turnEvents.push({ type: 'turn/end', data: { turn: 1 } }, { type: 'turn/start', data: { turn: 2 } });

  const multi = join(dir, 'presets.json');
  await writeFile(
    multi,
    JSON.stringify({
      comfy: 'http://127.0.0.1:' + server.address().port,
      defaultPreset: 'paint',
      presets: {
        paint: {
          workflow: 'workflow.json',
          bindings: { prompt: bindings.script },
          guidance: '明确动作和前后景。',
        },
        layout: {
          workflow: 'workflow.json',
          bindings: {
            prompt: bindings.script,
            seed: bindings.seed,
            reference: bindings.ref,
            width: [['6', 'width']],
            negativePrompt: bindings.style,
          },
          controls: { width: { min: 512, max: 1280, step: 16 } },
          layout: [1024, 640],
        },
      },
    }),
  );
  const profiled = tools(novelId, multi);
  const advertised = await profiled({ action: 'presets' });
  assert.equal(advertised.defaultPreset, 'paint');
  assert.equal(advertised.presets.find((item) => item.id === 'paint').guidance, '明确动作和前后景。');
  assert.equal(advertised.defaultReferencePreset, 'layout');
  assert.deepEqual(advertised.presets.find((item) => item.id === 'layout').layout, [1024, 640]);
  const references = await profiled({ action: 'references' });
  assert.deepEqual(references.references, [
    { id: 'chat:chat-digest', name: '图.png', width: 32, height: 32 },
  ]);
  const editArgs = {
    action: 'generate',
    characters: [],
    preset: 'layout',
    prompt: '换一盏灯',
    caption: '灯塔',
  };
  await assert.rejects(
    tools('b-' + 'b'.repeat(32), multi)({ ...editArgs, reference: references.references[0].id }, 'foreign'),
    /当前对话没有/,
  );
  await assert.rejects(profiled({ ...editArgs, reference: 'chat:tool-only' }, 'tool-output'), /当前对话没有/);
  await assert.rejects(
    profiled({ ...editArgs, adjustments: [{ name: 'width', number: 1025 }] }, 'bad-width'),
    /超出/,
  );
  await assert.rejects(
    profiled({ action: 'generate', characters: [], prompt: '灯塔', seed: 0 }, 'no-seed'),
    /不支持固定种子/,
  );
  const selected = await profiled(
    {
      action: 'generate',
      characters: [],
      seed: 0,
      reference: 'chat:latest',
      adjustments: [{ name: 'width', number: 1152 }],
      negative_prompt: '水印',
      prompt: '灯塔',
      caption: '灯塔',
      atmosphere: '暖灯与海雾',
      regions: [{ label: 'object', caption: '左边灯塔', box: [40, 60, 400, 800] }],
    },
    'selected-layout',
  );
  assert.equal(selected.seed, 0);
  assert.equal(selected.preset, 'layout');
  assert.equal(rendered.length, 3);
  const layoutGraph = rendered.at(-1);
  assert.equal(layoutGraph['6'].inputs.seed, 0);
  assert.equal(layoutGraph['6'].inputs.width, 1152);
  assert.equal(layoutGraph['6'].inputs.style, '水印');
  assert.match(referenceUploads.at(-1).toString('latin1'), /Content-Type: image\/png/i);
  assert.ok(referenceUploads.at(-1).includes(bytes));
  assert.deepEqual(selected.adjustments, { width: 1152 });
  assert.equal(JSON.parse(layoutGraph['5'].inputs.text).items[0].caption, '左边灯塔');
  assert.equal(JSON.parse(layoutGraph['5'].inputs.text).items[0].bbox[1], -530);
  assert.match(JSON.parse(layoutGraph['5'].inputs.text).summary.caption, /暖灯与海雾/);
  ready = false;
  const waitingSheet = await call(
    {
      action: 'character_sheet',
      visual_type: 'anime',
      character: '陆蘅',
      caption: '灯塔',
      prompt: '陆蘅，平刘海，白围巾。',
      seed: 37,
    },
    'lu-sheet',
  );
  assert.equal(waitingSheet.status, 'queued');
  const promptCountBeforeRecovery = prompts;
  const repeatSheet = await call({ action: 'character_sheet', visual_type: 'anime', character: '陆蘅', prompt: '同一角色，改用另一个动作。', new_variants: true }, 'lu-sheet-new-call');
  assert.equal(repeatSheet.jobId, waitingSheet.jobId);
  assert.equal(repeatSheet.progressCallId, 'lu-sheet');
  assert.equal(prompts, promptCountBeforeRecovery);
  const uploadsBeforeRecovery = uploads.length;
  ready = true;
  // After the original turn and tool instance are gone, a reopened chat can
  // recover all outputs, without a second render or duplicate gallery writes.
  const reopened = tools(novelId);
  const [sheet, sameSheet] = await Promise.all([
    reopened.job(waitingSheet.jobId),
    reopened({ action: 'status', job_id: waitingSheet.jobId }, 'sheet-status'),
  ]);
  assert.deepEqual(sameSheet, sheet);
  assert.deepEqual(await reopened.job(waitingSheet.jobId), sheet);
  assert.equal(prompts, promptCountBeforeRecovery);
  assert.equal(uploads.length, uploadsBeforeRecovery + 3);
  assert.equal(sheet.status, 'character-options');
  assert.equal(sheet.characterVisual.candidates.length, 3);
  assert.equal(sheet.characterVisual.chosen, null);
  assert.equal(rendered.at(-1)['2-6'].inputs.seed, 39);
  assert.match(rendered.at(-1)['0-5'].inputs.text, /full body front, profile and back/);
  assert.equal((await call(drawing, 'still-needs-lock')).status, 'character-design-needed');
  const store = createCharacterVisuals(db);
  const chosen = sheet.characterVisual.candidates[0];
  store.choose(
    novelId,
    { id: sheet.characterVisual.id, visualType: 'anime', revision: sheet.characterVisual.revision, imagePath: chosen },
    () => {},
  );
  const scene = await profiled({ ...drawing, preset: 'paint', style: '手绘水彩' }, 'locked-reference');
  assert.equal(scene.status, 'ready');
  assert.equal(scene.preset, 'layout');
  assert.deepEqual(scene.characterReferences, [{ name: '陆蘅', imagePath: chosen }]);
  assert.equal(rendered.at(-1)['4'].inputs.image, 'fixture/upload.webp');
  assert.match(rendered.at(-1)['5'].inputs.text, /手绘水彩/);
  assert.equal((await call({ action: 'characters' }, 'check-lock')).characters[0].chosen, chosen);
  const beforeMarking = prompts;
  const shot = { ...drawing, shot: 'close_up' };
  assert.equal((await profiled(shot, 'missing-views')).status, 'character-reference-views-needed');
  const turnaround = await profiled({ action: 'inspect', reference: chosen }, 'inspect-chosen-views');
  assert.deepEqual([turnaround.width, turnaround.height], [1536, 896]);
  const mark = {
    action: 'character_reference_views',
    character: '陆蘅',
    visual_type: 'anime',
    reference: chosen,
    views: { close_up: [65, 50, 250, 510], full_body: [270, 30, 500, 950] },
  };
  await assert.rejects(profiled({ ...mark, reference }, 'other-image'), /只能标记/);
  await assert.rejects(
    profiled({ ...mark, views: { close_up: [0, 0, 1000, 1000] } }, 'whole-sheet'),
    /小于整张/,
  );
  const marked = await profiled(mark, 'remember-views');
  assert.deepEqual(marked.characterVisual.referenceViews, mark.views);
  assert.equal(prompts, beforeMarking);
  const close = await profiled(shot, 'close-up-reference');
  assert.deepEqual(close.characterReferences, [
    { name: '陆蘅', imagePath: chosen, view: 'close_up', box: mark.views.close_up },
  ]);
  assert.deepEqual(rendered.at(-1)['reference-crop-4'], {
    class_type: 'ImageCrop',
    inputs: { image: ['4', 0], x: 100, y: 45, width: 284, height: 412 },
  });
  assert.deepEqual(rendered.at(-1)['5'].inputs.images, ['reference-crop-4', 0]);
  const full = await profiled({ ...drawing, shot: 'full_body' }, 'full-body-reference');
  assert.equal(full.characterReferences[0].view, 'full_body');
  assert.deepEqual(rendered.at(-1)['reference-crop-4'].inputs, {
    image: ['4', 0],
    x: 415,
    y: 27,
    width: 353,
    height: 824,
  });
  const sheetReference = await profiled(drawing, 'default-sheet-reference');
  assert.deepEqual(sheetReference.characterReferences, [{ name: '陆蘅', imagePath: chosen }]);
  assert.deepEqual(rendered.at(-1)['5'].inputs.images, ['4', 0]);
  const realistic = await call({ ...drawing, visual_type: 'realistic' }, 'realism-after-anime-lock');
  assert.equal(realistic.status, 'character-design-needed');
  assert.equal(realistic.characters[0].visualType, 'realistic');
  assert.deepEqual(realistic.characters[0].candidates, []);
  const beforeRealistic = referenceUploads.length;
  const realisticSheet = await call(
    {
      action: 'character_sheet',
      character: '陆蘅',
      visual_type: 'realistic',
      caption: '灯塔',
      prompt: '成年女性，白围巾，写实摄影。',
    },
    'realistic-sheet-after-anime',
  );
  assert.equal(realisticSheet.status, 'character-options');
  assert.equal(realisticSheet.characterVisual.id, sheet.characterVisual.id);
  assert.equal(realisticSheet.characterVisual.candidates.length, 3);
  assert.equal(referenceUploads.length, beforeRealistic);
  const realChoice = realisticSheet.characterVisual.candidates[1];
  store.choose(
    novelId,
    {
      id: realisticSheet.characterVisual.id,
      visualType: 'realistic',
      revision: realisticSheet.characterVisual.revision,
      imagePath: realChoice,
    },
    () => {},
  );
  const realisticScene = await call({ ...drawing, visual_type: 'realistic' }, 'locked-realistic');
  assert.deepEqual(realisticScene.characterReferences, [{ name: '陆蘅', imagePath: realChoice }]);
  assert.equal(store.resolve(novelId, ['陆蘅'], 'anime')[0].chosen, chosen);
  let handle,
    backgroundStarts = 0;
  const native = tools(novelId, config, {
    start(spec) {
      assert.equal(spec.owner, novelId);
      assert.equal(spec.kind, 'comfy');
      backgroundStarts++;
      handle = spec.run();
      return 'comfy-test';
    },
  });
  const beforeBackground = prompts;
  ready = false;
  const overdue = { ...request, prompt: '无人码头', reference: undefined };
  const deferredJob = await native(overdue, 'native-background-test');
  assert.equal(deferredJob.backgroundJobId, 'comfy-test');
  assert.equal((await native(overdue, 'native-background-test')).backgroundJobId, 'comfy-test');
  assert.equal(backgroundStarts, 1);
  assert.equal(prompts, beforeBackground + 1);
  ready = true;
  const outcome = await handle.done;
  assert.equal(outcome.status, 'completed');
  assert.deepEqual(JSON.parse(outcome.result).paths, (await native.job(deferredJob.jobId)).images.map(({ imagePath }) => imagePath));
  const { batches } = native.gallery('generated');
  assert.equal(batches[0].id, deferredJob.jobId);
  const characters = native.gallery('characters').batches;
  assert.equal(characters[0].character.visualType, 'realistic');
  assert.equal(characters[1].character.visualType, 'anime');
  assert.equal(characters[0].images.length, 3);
  assert.deepEqual(otherBook.gallery('generated').batches, []);
  assert.deepEqual(native.unbatched([...batches[0].images, { imagePath: reference }]), [{ imagePath: reference }]);
});

test('MOSS regions compile into centered pixel boxes while keeping style, shot and light separate', () => {
  const args = {
    prompt: '人物从窗外递进一张车票',
    style: '厚涂动画',
    composition: '双人侧视',
    atmosphere: '夜雨与暖灯',
    regions: [
      { label: 'character', caption: '左侧旅客', box: [0, 100, 500, 900] },
      { label: 'text', caption: '票面', box: [500, 500, 700, 700], text: '末班车' },
    ],
  };
  const preset = { layout: [1024, 640], promptPrefix: 'fixture\n' };
  const compiled = compileVisualPrompt(preset, args);
  assert.equal(compileVisualPrompt(preset, { prompt: '  仅由助手撰写  ' }), '  仅由助手撰写  ');
  const body = JSON.parse(compiled);
  assert.equal(body.summary.canvas, 'landscape');
  assert.match(
    body.summary.caption,
    /Style：厚涂动画\nComposition：双人侧视\nLighting and atmosphere：夜雨与暖灯/,
  );
  assert.deepEqual(
    body.items.map((item) => item.bbox),
    [
      [-256, -512, 256, 0],
      [0, 0, 128, 205],
    ],
  );
  assert.equal(body.items[1].text, '末班车');
  assert.throws(() => compileVisualPrompt({ promptPrefix: '' }, args), /不支持位置框/);
  assert.throws(
    () =>
      compileVisualPrompt(preset, { ...args, regions: [{ ...args.regions[0], box: [500, 0, 400, 500] }] }),
    /位置框无效/,
  );
});

test('reference edits retain the input ratio when the workflow exposes both canvas dimensions', () => {
  const size = { width: 768, height: 512 };
  const rule = { min: 384, max: 1280, step: 16 };
  const controls = { width: rule, height: rule };
  assert.deepEqual(referenceCanvas(controls, {}, size), size);
  assert.deepEqual(referenceCanvas(controls, { width: 1152 }, size), { width: 1152, height: 768 });
  assert.deepEqual(referenceCanvas(controls, {}, { width: 1920, height: 1280 }), {
    width: 1280,
    height: 848,
  });
  assert.deepEqual(referenceCanvas({ width: rule }, {}, size), {});
});

test('the Anima character workflow keeps its expected portrait defaults and exposes native controls', async () => {
  const config = await loadComfyPresets(
    fileURLToPath(new URL('../shared/workflows/anima-quality.json', import.meta.url)),
  );
  const preset = config.presets.get(config.defaultPreset);
  assert.deepEqual([preset.controls.width.default, preset.controls.height.default], [1024, 1344]);
  assert.equal(preset.controls.sampler.default, 'er_sde');
  assert.equal(preset.template['9'].inputs.quality, 94);
  assert.match(preset.guidance, /动作/);
});

test('the visual bridge binds arbitrary API node inputs and preserves graph edges', () => {
  const graph = bindWorkflow(template, bindings, {
    script: 'page A',
    ref: 'input.webp',
    seed: 71,
    style: 'Ink',
  });
  assert.equal(graph['5'].inputs.text, 'page A');
  assert.deepEqual(graph['5'].inputs.images, ['4', 0]);
  assert.equal(graph['6'].inputs.seed, 71);
  assert.equal(graph['6'].inputs.style, 'Ink');
  assert.equal(template['6'].inputs.style, '');
  assert.throws(() => bindWorkflow(template, { seed: [['6', 'wrong']] }, { seed: 1 }), /绑定无效/);
});

test('chapter context, two ComfyUI pages, reference reuse, ordered chapter commit and safe retries', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'novel-comfy-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, 'task.json');
  const output = join(dir, 'output');
  let text = '# 灯塔\r\n\r\n风吹过灯塔。\r\n\r\n她关上门。';
  const jobs = [];
  const images = new Map();
  let saves = 0;
  let conflict = false;
  const send = (response, value, status = 200) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(value));
  };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const parts = [];
      for await (const part of request) parts.push(part);
      const body = Buffer.concat(parts).toString();
      if (url.pathname.startsWith('/api/novels/')) {
        assert.equal(request.headers.cookie, 'session=test-only');
        const route = url.pathname.split('/').at(-1);
        if (route === 'document') {
          if (request.method === 'GET') {
            const path = url.searchParams.get('path');
            const content = path === chapter ? text : '阿竹戴蓝色围巾。';
            return send(response, { path, text: content, hash: sha(content) });
          }
          const edit = JSON.parse(body);
          assert.equal(request.method, 'PUT');
          assert.equal(edit.path, chapter);
          if (conflict || edit.expectedHash !== sha(text)) return send(response, { error: '冲突' }, 409);
          saves++;
          text = edit.text;
          return send(response, { path: chapter, hash: sha(text) });
        }
        assert.equal(route, 'illustrations');
        if (request.method === 'GET') {
          assert.equal(url.searchParams.get('imagePath'), reference);
          return send(response, {
            format: 'novel-illustration-v1',
            width: 1,
            height: 1,
            data: 'data:image/webp;base64,' + bytes.toString('base64'),
          });
        }
        const { action, content } = JSON.parse(body);
        assert.equal(action, 'upload');
        imageAsset(content);
        const imagePath = 'illustrations/' + sha(content) + '.json';
        images.set(imagePath, content);
        return send(response, { imagePath });
      }
      assert.equal(request.headers.cookie, undefined);
      if (url.pathname === '/upload/image') {
        assert.match(request.headers['content-type'], /^multipart\/form-data/);
        assert.match(body, /name="image"/);
        return send(response, { name: 'reference.webp', subfolder: 'imported' });
      }
      if (url.pathname === '/prompt') {
        const { prompt } = JSON.parse(body);
        jobs.push(prompt);
        return send(response, { prompt_id: 'fixture-' + jobs.length });
      }
      if (url.pathname.startsWith('/history/')) {
        const id = url.pathname.split('/').at(-1);
        return send(response, {
          [id]: {
            status: { status_str: 'success' },
            outputs: {
              8: { images: [{ filename: id + '.webp', type: 'output', subfolder: 'fixture' }] },
            },
          },
        });
      }
      assert.equal(url.pathname, '/view');
      assert.equal(url.searchParams.get('subfolder'), 'fixture');
      response.writeHead(200, { 'content-type': 'image/webp' });
      return response.end(bytes);
    } catch (error) {
      send(response, { error: String(error) }, 500);
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const url = 'http://127.0.0.1:' + server.address().port;
  const config = {
    novel: url,
    comfy: url,
    book: novelId,
    chapter,
    output: 'output',
    materials: ['setting.md'],
    workflow: 'api.json',
    bindings,
    values: { style: 'Woodcut', ref: 'example.png' },
    pages: [
      { textFiles: { script: 'page1.txt' }, values: { seed: 11 }, references: { ref: reference } },
      { textSources: { script: 'setting.md' }, values: { seed: 12, style: 'Fantasy' } },
    ],
    publish: [
      { file: '01-1.webp', label: '第一页' },
      { file: '02-1.webp', label: '第二页' },
    ],
    after: '风吹过灯塔。',
  };
  const env = { NOVELHARNESS_SESSION_COOKIE: 'session=test-only' };
  await writeFile(configPath, JSON.stringify(config));
  await writeFile(join(dir, 'api.json'), JSON.stringify(template));
  await writeFile(join(dir, 'page1.txt'), '第一页');
  const call = (action) => main([action, configPath], env);
  await call('context');
  const context = JSON.parse(await readFile(join(output, 'context.json'), 'utf8'));
  assert.equal(context.chapter.text, text);
  assert.equal(context.sources[0].role, 'author-setting');
  await call('submit');
  await call('submit');
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0]['5'].inputs.text, '第一页');
  assert.equal(jobs[0]['4'].inputs.image, 'imported/reference.webp');
  assert.equal(jobs[1]['6'].inputs.style, 'Fantasy');
  assert.equal(jobs[1]['5'].inputs.text, '阿竹戴蓝色围巾。');
  assert.deepEqual((await call('collect')).completed, ['01-1.webp', '02-1.webp']);
  await call('collect');
  const original = text;
  conflict = true;
  await assert.rejects(call('publish'), /冲突/);
  assert.equal(text, original);
  conflict = false;
  await call('publish');
  await call('publish');
  assert.equal(saves, 1);
  assert.equal(images.size, 2);
  assert.deepEqual(
    illustrationEntries(text).map((item) => item.caption),
    ['第一页', '第二页'],
  );
  assert.equal(text.replace(/\r\n\r\n!\[[^\]]+\]\([^\)]+\)/g, ''), original);
});
