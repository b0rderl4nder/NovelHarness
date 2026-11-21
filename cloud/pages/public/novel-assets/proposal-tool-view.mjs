import { createProseEditor } from './prose-editor.mjs';
import { openTaskProposal } from './proposal-navigation.mjs';
import { makeDocumentClient } from './manuscript-core.mjs';
import { openIllustrationLightbox } from './illustration-editor.mjs';
import { illustrationPath, imageAsset } from '../../../worker/shared/illustrations.mjs';

// Presentation only, read directly from the ORIGINAL native Tool block and its
// incremental PartialArguments. No provider stream, copied transcript or draft.
export function proposalToolModel(toolName, block) {
  const settled = 'kind' in block;
  const raw = settled
    ? (block.content ?? [])
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('\n')
    : '';
  let result;
  try {
    result = JSON.parse(raw);
  } catch {
    /* The actual non-JSON error remains visible. */
  }
  const submit = toolName === 'novel_proposal_submit';
  const stopped = block.error?.code === 'interrupted';
  return {
    settled,
    raw,
    result,
    content: submit ? (block.args?.text?.('content') ?? '') : '',
    failed: settled && !!block.isError,
    label: stopped
      ? '写作已停止，草稿保留'
      : settled && block.isError
        ? '本次操作失败'
        : !submit
          ? settled
            ? '执行详情'
            : '准备写作…'
          : !settled
            ? block.phase === 'preparing'
              ? '正在写作…'
              : '正在保存…'
            : result?.published === true
              ? '已保存到书稿'
              : result?.saved === true && result?.published === false
                ? result.publicationIssue || result.warning
                  ? '未保存到书稿，草稿已保留'
                  : '草稿已保留'
                : '执行详情',
  };
}

function resultImages(result, cwd) {
  if (
    !/^b-[a-f0-9]{32}$/.test(result?.bookId ?? '') ||
    cwd !== '/workspace/novels/' + result.bookId ||
    !Array.isArray(result.images)
  )
    return [];
  return result.images
    .filter((item) => illustrationPath(item?.imagePath))
    .slice(0, 4)
    .map((item) => ({ ...item, bookId: result.bookId }));
}

export function turnImages(snapshot, turn, cwd) {
  const images = new Map();
  const visit = (block) => {
    if (!block) return;
    const name = block.call?.name ?? block.name;
    if (name === 'novel_generate_image' && 'kind' in block && !block.isError) {
      const { result } = proposalToolModel(name, block);
      for (const image of resultImages(result, cwd)) {
        if (!images.has(image.imagePath)) images.set(image.imagePath, image);
      }
    }
    for (const child of block.subCalls ?? []) visit(child);
  };
  for (const key of snapshot?.locations.getTurn(turn) ?? []) {
    const node = snapshot.nodes.get(key);
    if (node?.kind === 'tool-call') visit(node.data.root);
  }
  return [...images.values()];
}

export function installProposalToolViews(ctx, React) {
  const h = React.createElement,
    ProseEditor = createProseEditor(React);
  function GeneratedImage({ bookId, imagePath, label }) {
    const [state, setState] = React.useState({});
    const dialog = React.useRef(null);
    const caption = label || 'AI 插图';
    React.useEffect(() => {
      let active = true;
      makeDocumentClient(bookId)('illustrations', null, { action: 'read', imagePath })
        .then((value) => {
          if (active) setState({ asset: imageAsset(JSON.stringify(value)) });
        })
        .catch(() => {
          if (active) setState({ error: true });
        });
      return () => {
        active = false;
        dialog.current?.remove();
      };
    }, [bookId, imagePath]);
    return state.asset
      ? h(
          'figure',
          { className: 'novel-generated-image' },
          h(
            'button',
            {
              type: 'button',
              className: 'novel-generated-image-trigger',
              'aria-label': '放大插图：' + caption,
              onClick: (event) => {
                dialog.current = openIllustrationLightbox(state.asset.data, caption, event.currentTarget);
              },
            },
            h('img', {
              src: state.asset.data,
              alt: caption,
              width: state.asset.width,
              height: state.asset.height,
            }),
          ),
          h('figcaption', null, caption + ' · ' + state.asset.width + ' × ' + state.asset.height),
        )
      : h('p', { role: 'status' }, state.error ? '预览加载失败，可在本书图集查看。' : '正在载入插图…');
  }
  function GeneratedImageToolView({ toolName, block, cwd }) {
    if (block.call?.args?.text?.('action') === 'inspect') return null;
    const { result, settled, failed, raw } = proposalToolModel(toolName, block);
    const presets = Array.isArray(result?.presets) ? result.presets : null;
    const references = Array.isArray(result?.references) ? result.references : null;
    const images = resultImages(result, cwd);
    const message = failed
      ? '插图生成失败'
      : !settled
        ? '正在生成插图…'
        : images.length
          ? '候选图已存入本书图集'
          : result?.status === 'queued'
            ? 'ComfyUI 正在排队或生成'
            : result?.status === 'deliver-chapter'
              ? '先保存本章和已生成的插图'
              : result?.status === 'unknown'
                ? '提交结果未确认，请在 ComfyUI 核对队列'
                : presets
                  ? '可用生图预设'
                  : references
                    ? `当前对话有 ${references.length} 张可引用的图片`
                    : '暂无可预览的插图';
    return h(
      'section',
      { className: 'novel-proposal-tool', 'aria-label': 'AI 生图执行详情' },
      h('p', { role: 'status' }, message),
      presets ? h('p', null, presets.map((preset) => preset.label).join(' · ')) : null,
      failed && raw ? h('details', null, h('summary', null, '查看原因'), h('pre', null, raw)) : null,
    );
  }
  function GeneratedImagesTail({ turn, chat, sessionId }) {
    const snapshot = React.useSyncExternalStore(chat.subscribe, chat.getSnapshot);
    const catalog = React.useSyncExternalStore(ctx.sessions.list.subscribe, ctx.sessions.list.getSnapshot);
    const images = turnImages(snapshot, turn.turn, catalog.byId[sessionId]?.cwd);
    return images.length
      ? h(
          'section',
          { className: 'novel-proposal-tool', 'aria-label': 'AI 插图结果' },
          ...images.map((image) => h(GeneratedImage, { key: image.imagePath, ...image })),
        )
      : null;
  }
  function ProposalToolView({ toolName, block, useDisclosure }) {
    const model = proposalToolModel(toolName, block);
    const { expanded, toggle } = useDisclosure();
    const open = expanded;
    return h(
      'section',
      { className: 'novel-proposal-tool', 'aria-label': model.label },
      h(
        'button',
        {
          type: 'button',
          'aria-expanded': open,
          onClick: toggle,
        },
        model.label,
      ),
      model.failed ? h('p', { role: 'alert' }, '操作未完成。展开执行详情查看原因；未声称已保存。') : null,
      open && model.result?.bookId && model.result?.proposalId
        ? h(
            'button',
            {
              type: 'button',
              onClick: () =>
                openTaskProposal(ctx, { bookId: model.result.bookId, proposalId: model.result.proposalId }),
            },
            '打开生成记录',
          )
        : null,
      open
        ? h(
            React.Fragment,
            null,
            model.content
              ? h(ProseEditor, { value: model.content, readOnly: true, label: '候选流式预览' })
              : null,
            model.result?.warning ? h('p', { role: 'note' }, model.result.warning) : null,
            model.result?.publicationIssue ? h('p', { role: 'alert' }, model.result.publicationIssue) : null,
            model.result?.validation?.issues?.length
              ? h('ul', null, ...model.result.validation.issues.map((issue, i) => h('li', { key: i }, issue)))
              : null,
            model.settled
              ? h('details', null, h('summary', null, '调用结果'), h('pre', null, model.raw))
              : null,
          )
        : null,
    );
  }
  ctx.effect(
    () =>
      ctx.slots.inject('tool.call.toolview', function* () {
        for (const key of ['novel_proposal_prepare', 'novel_proposal_inspect', 'novel_proposal_submit'])
          yield ctx.slots.register({ name: 'tool.call.toolview', key }, ProposalToolView);
        yield ctx.slots.register(
          { name: 'tool.call.toolview', key: 'novel_generate_image' },
          GeneratedImageToolView,
        );
      }),
    'novel: original native proposal tool presentation',
  );
  ctx.effect(() =>
    ctx.slots.inject('conversation.chat.turnTail', () =>
      ctx.slots.register(
        {
          name: 'conversation.chat.turnTail',
          id: 'novel-generated-images',
          inject: (sessionId) => ({
            sessionId,
            chat: ctx.uiConversation.binding(ctx.sessions.binding(sessionId)).target('chat'),
          }),
        },
        GeneratedImagesTail,
      ),
    ),
  );
}
