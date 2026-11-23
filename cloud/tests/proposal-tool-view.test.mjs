import test from 'node:test';
import assert from 'node:assert/strict';
import {
  proposalToolModel,
  installProposalToolViews,
  resultImages,
  turnImageResults,
} from '../pages/public/novel-assets/proposal-tool-view.mjs';

test('live candidate presentation reads native incremental arguments and never treats partial or failed calls as saved', () => {
  let content = '前半句';
  const args = { text: (key) => (key === 'content' ? content : undefined) };
  const partial = { phase: 'preparing', args };
  assert.equal(proposalToolModel('novel_proposal_submit', partial).content, '前半句');
  assert.match(proposalToolModel('novel_proposal_submit', partial).label, /正在写作/);
  content += '，后半句。';
  assert.equal(proposalToolModel('novel_proposal_submit', partial).content, content);
  const saved = {
    kind: 'tool-result',
    args,
    content: [{ type: 'text', text: '{"saved":true,"published":false}' }],
  };
  assert.equal(proposalToolModel('novel_proposal_submit', saved).label, '草稿已保留');
  assert.match(proposalToolModel('novel_proposal_submit', { ...saved, isError: true }).label, /失败/);
  assert.match(
    proposalToolModel('novel_proposal_submit', { ...saved, isError: true, error: { code: 'interrupted' } })
      .label,
    /停止/,
  );
  assert.doesNotMatch(proposalToolModel('novel_proposal_submit', { ...saved, content: [] }).label, /已保存/);
});

test('novel views register native tool details', () => {
  const registrations = [];
  const ctx = {
    effect: (fn) => fn(),
    slots: {
      inject: (name, fn) => {
        return name === 'tool.call.toolview' ? [...fn()] : fn();
      },
      register: (options) => {
        registrations.push(options);
      },
    },
  };
  installProposalToolViews(ctx, {});
  assert.deepEqual(
    registrations.map((r) => r.key ?? r.id),
    [
      'novel_proposal_prepare',
      'novel_proposal_inspect',
      'novel_proposal_submit',
      'novel_generate_image',
      'novel-generated-images',
    ],
  );
});

test('a generated thumbnail uses the stored asset and reports its intrinsic dimensions', () => {
  let ImageView;
  const bookId = 'b-' + 'a'.repeat(32);
  const cwd = '/workspace/novels/' + bookId;
  const src = '/api/novels/' + bookId + '/image-preview/' + '1'.repeat(64);
  let state = {};
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: () => [state, (next) => { state = next; }],
    useRef: () => ({ current: null }),
    useEffect: () => {},
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
  };
  installProposalToolViews(
    {
      effect: (fn) => fn(),
      sessions: { list: { getSnapshot: () => ({ byId: { sample: { cwd } } }) } },
      slots: {
        inject: (name, register) => (name === 'tool.call.toolview' ? [...register()] : register()),
        register: ({ key }, component) => {
          if (key === 'novel_generate_image') ImageView = component;
        },
      },
    },
    React,
  );
  const root = {
    kind: 'tool-result',
    name: 'novel_generate_image',
    call: { name: 'novel_generate_image' },
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          bookId,
          images: [{ imagePath: 'illustrations/' + '1'.repeat(64) + '.json', label: '票务窗口' }],
        }),
      },
    ],
  };
  assert.deepEqual(resultImages(JSON.parse(root.content[0].text), '/workspace/novels/other'), []);
  assert.equal(turnImageResults([{ root }, { root }], cwd).images.length, 1);
  const tool = ImageView({ toolName: 'novel_generate_image', block: root, cwd });
  assert.equal(tool.children.length, 1);
  const candidate = tool.children.find((child) => typeof child?.type === 'function');
  const figure = candidate.type(candidate.props);
  const [trigger] = figure.children;
  assert.equal(trigger.type, 'button');
  assert.equal(trigger.props['aria-label'], '放大插图：票务窗口');
  const image = trigger.children[0];
  assert.equal(image.props.src, src);
  assert.equal(image.props.loading, 'lazy');
  assert.equal(image.props.decoding, 'async');
  assert.equal(trigger.props.disabled, true);
  image.props.onLoad({ currentTarget: { naturalWidth: 1024, naturalHeight: 640 } });
  const [loadedTrigger, caption] = candidate.type(candidate.props).children;
  assert.equal(loadedTrigger.props.disabled, false);
  assert.deepEqual(caption.children, ['票务窗口 · 1024 × 640']);
  image.props.onError();
  assert.equal(candidate.type(candidate.props).props.role, 'status');
  assert.equal(
    ImageView({ toolName: 'novel_generate_image', block: { ...root, args: { text: () => 'inspect' } }, cwd }),
    null,
  );
});

test('turnaround options stay in one review card instead of appearing as ordinary illustrations', () => {
  const bookId = 'b-' + 'a'.repeat(32);
  const paths = ['1', '2', '3'].map((n) => 'illustrations/' + n.repeat(64) + '.json');
  const character = { id: 'c'.repeat(32), name: '陆蘅', revision: 1, chosen: null, candidates: paths };
  const jobId = '12345678-1234-1234-1234-123456789abc';
  const call = (value) => ({
    root: {
      name: 'novel_generate_image',
      kind: 'tool-result',
      content: [{ type: 'text', text: JSON.stringify({ bookId, ...value }) }],
    },
  });
  const proposal = call({
    jobId,
    status: 'character-options',
    images: paths.map((imagePath) => ({ imagePath })),
    characterVisual: character,
  });
  const waiting = call({ status: 'character-design-needed', characters: [character] });
  const queued = call({ status: 'queued', jobId });
  const drawing = call({
    status: 'ready',
    images: [{ imagePath: 'illustrations/' + '4'.repeat(64) + '.json' }],
  });
  const cwd = '/workspace/novels/' + bookId;
  assert.equal(turnImageResults([queued, queued], cwd).jobs.length, 1);
  assert.equal(turnImageResults([queued], '/workspace/novels/other').jobs.length, 0);
  const result = turnImageResults([queued, proposal, waiting, drawing], cwd);
  assert.deepEqual(result.jobs, []);
  assert.equal(result.sheets.length, 1);
  assert.deepEqual(result.sheets[0].candidates, paths);
  const realistic = call({
    status: 'character-options',
    characterVisual: { ...character, visualType: 'realistic' },
  });
  assert.deepEqual(
    turnImageResults([proposal, realistic], cwd).sheets.map(({ character }) => character.visualType),
    [undefined, 'realistic'],
  );
  assert.equal(result.images.length, 1);
  assert.equal(turnImageResults([proposal], '/workspace/novels/other').sheets.length, 0);
});

test('the original chat turn resolves a queued receipt into an inline character review', async (t) => {
  const bookId = 'b-' + 'a'.repeat(32);
  const jobId = '12345678-1234-1234-1234-123456789abc';
  const paths = ['1', '2', '3'].map((n) => 'illustrations/' + n.repeat(64) + '.json');
  const receipt = { status: 'queued', bookId, jobId };
  const finished = {
    ...receipt,
    status: 'character-options',
    images: paths.map((imagePath) => ({ imagePath })),
    characterVisual: { id: 'f'.repeat(32), name: '试画角色', candidates: paths, revision: 1, chosen: null },
  };
  const call = {
    root: {
      name: 'novel_generate_image',
      kind: 'tool-result',
      content: [{ type: 'text', text: JSON.stringify(receipt) }],
    },
  };
  let Tail, mount, state, resolveState;
  const updated = new Promise((done) => (resolveState = done));
  installProposalToolViews(
    {
      effect: (fn) => fn(),
      slots: {
        inject: (name, register) => (name === 'tool.call.toolview' ? [...register()] : register()),
        register: ({ id }, component) => {
          if (id === 'novel-generated-images') Tail = component;
        },
      },
    },
    {
      createElement: (type, props, ...children) => ({ type, props, children }),
      useState: () => [
        state,
        (value) => {
          state = value;
          resolveState();
        },
      ],
      useEffect: (fn) => (mount = fn),
      useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
    },
  );
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json(finished));
  const tail = Tail({
    turn: { turn: 1 },
    chat: { getSnapshot: () => ({ nodes: { turnDataSource: () => ({ getSnapshot: () => [call] }) } }) },
  });
  const pending = tail.children[0];
  assert.equal(pending.type(pending.props).children[0].children[0], 'ComfyUI 排队中');
  const dispose = mount();
  t.after(dispose);
  await updated;
  assert.equal(fetch.mock.callCount(), 1);
  const [url, options] = fetch.mock.calls[0].arguments;
  assert.equal(url, '/api/novels/' + bookId + '/image-jobs/' + jobId);
  assert.equal(options.method, 'POST');
  const [review] = pending.type(pending.props);
  assert.equal(review.type.name, 'CharacterSheetReview');
  assert.deepEqual(review.props.candidates, paths);
});
