import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import test from 'node:test';
import { bindWorkflow, main } from '../scripts/novel-comfy.mjs';
import { illustrationEntries, imageAsset } from '../worker/shared/illustrations.mjs';
import { installComfyTools } from '../official/novel/comfy-tools.mjs';
import { installNovelTools } from '../worker/novel-tools.mjs';

const sha = (text) => createHash('sha256').update(text).digest('hex');
const bytes = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64');
const template = {
  5: { class_type: 'MyLayoutOrTextEncoder', inputs: { text: '', images: ['4', 0] } },
  4: { class_type: 'LoadImage', inputs: { image: 'example.png' } },
  6: { class_type: 'Sampler', inputs: { seed: 0, style: '' } },
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

test('book-scoped agent can submit, resume after reload, and publish a candidate without editing prose', async (t) => {
  const db = new DatabaseSync(':memory:');
  db.transaction = (run) => () => {
    db.exec('BEGIN');
    try {
      const result = run();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  t.after(() => db.close());
  const dir = await mkdtemp(join(tmpdir(), 'novel-comfy-tool-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let prompts = 0;
  let ready = false;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (value) => res.end(JSON.stringify(value));
    if (url.pathname === '/prompt') {
      prompts++;
      const data = JSON.parse(await new Response(ReadableStream.from(req)).text());
      assert.equal(data.prompt['5'].inputs.text, '夜里的灯塔和一束微弱暖光');
      assert.equal(data.prompt['4'].inputs.image, 'fixture/upload.webp');
      return send({ prompt_id: 'comfy-receipt' });
    }
    if (url.pathname === '/upload/image') {
      for await (const _chunk of req) {
        /* drain test reference */
      }
      return send({ name: 'upload.webp', subfolder: 'fixture' });
    }
    if (url.pathname === '/history/comfy-receipt')
      return send(
        ready
          ? { 'comfy-receipt': { outputs: { 8: { images: [{ type: 'output', filename: 'one.webp' }] } } } }
          : {},
      );
    if (url.pathname === '/view') return res.end(bytes);
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
  function tools(book) {
    const definitions = new Map();
    const agent = {
      session: {},
      ctx: { get: () => ({ register: (tool) => definitions.set(tool.name, tool) }) },
    };
    installComfyTools(
      {
        ctx: { storage: db },
        sessions: {
          context: {
            on: (_event, listener) => listener({ agent }),
            get: () => ({ get: () => '/workspace/novels/' + book }),
          },
        },
      },
      {
        installNovelTools,
        imageAsset,
        makeDocumentService: (_fs, _db, id) => ({
          run(operation) {
            assert.equal(id, novelId);
            assert.equal(operation.kind, 'illustrations');
            if (operation.action === 'read') {
              assert.equal(operation.imagePath, reference);
              return { data: 'data:image/webp;base64,' + bytes.toString('base64') };
            }
            assert.equal(operation.action, 'upload');
            assert.equal(imageAsset(operation.content).label, '灯塔');
            uploads.push(operation.content);
            return { imagePath: 'illustrations/' + sha(operation.content) + '.json' };
          },
        }),
      },
      config,
      { waitMs: 0 },
    );
    return async (args, callId = 'native-call') =>
      JSON.parse(
        await definitions
          .get('novel_generate_image')
          .execute(args, { agent, signal: new AbortController().signal, callId }),
      );
  }
  const call = tools(novelId);
  const request = { action: 'generate', prompt: '夜里的灯塔和一束微弱暖光', caption: '灯塔', reference };
  const queued = await call(request);
  assert.equal(queued.status, 'queued');
  assert.equal((await call(request)).jobId, queued.jobId);
  assert.equal(prompts, 1);
  const status = { action: 'status', job_id: queued.jobId };
  await assert.rejects(tools('b-' + 'b'.repeat(32))(status), /找不到本书/);
  ready = true;
  const completed = await tools(novelId)(status);
  assert.equal(completed.status, 'ready');
  assert.equal(completed.images[0].label, '灯塔');
  assert.deepEqual(await call(status), completed);
  assert.equal(uploads.length, 1);
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
