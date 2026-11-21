import test from 'node:test';
import assert from 'node:assert/strict';
import {
  proposalToolModel,
  installProposalToolViews,
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

test('novel tool views extend only the original keyed tool slot, without replacing the conversation or creating a new event source', () => {
  const registrations = [];
  const ctx = {
    effect: (fn) => fn(),
    slots: {
      inject: (name, fn) => {
        assert.equal(name, 'tool.call.toolview');
        return [...fn()];
      },
      register: (options) => {
        registrations.push(options);
      },
    },
  };
  installProposalToolViews(ctx, {});
  assert.deepEqual(
    registrations.map((r) => r.key),
    ['novel_proposal_prepare', 'novel_proposal_inspect', 'novel_proposal_submit', 'novel_generate_image'],
  );
});

test('a generated thumbnail uses the stored asset and reports its intrinsic dimensions', () => {
  let ToolView;
  const asset = { data: 'data:image/webp;base64,fixture', width: 1024, height: 640 };
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: () => [{ asset }],
    useRef: () => ({ current: null }),
    useEffect: () => {},
  };
  installProposalToolViews(
    {
      effect: (fn) => fn(),
      slots: {
        inject: (_name, register) => [...register()],
        register: ({ key }, component) => {
          if (key === 'novel_generate_image') ToolView = component;
        },
      },
    },
    React,
  );
  const bookId = 'b-' + 'a'.repeat(32);
  const tool = ToolView({
    toolName: 'novel_generate_image',
    cwd: '/workspace/novels/' + bookId,
    block: {
      kind: 'tool-result',
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            bookId,
            images: [{ imagePath: 'illustrations/' + '1'.repeat(64) + '.json', label: '票务窗口' }],
          }),
        },
      ],
    },
  });
  const candidate = tool.children.find((child) => typeof child?.type === 'function');
  const figure = candidate.type(candidate.props);
  const [trigger, caption] = figure.children;
  assert.equal(trigger.type, 'button');
  assert.equal(trigger.props['aria-label'], '放大插图：票务窗口');
  assert.equal(trigger.children[0].props.src, asset.data);
  assert.deepEqual(caption.children, ['票务窗口 · 1024 × 640']);
});
