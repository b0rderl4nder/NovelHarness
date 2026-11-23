import { createProseEditor } from './prose-editor.mjs';
import { openTaskProposal } from './proposal-navigation.mjs';
import { makeDocumentClient } from './manuscript-core.mjs';
import { openIllustrationLightbox } from './illustration-editor.mjs';
import { illustrationPath, imageAsset } from '../../../worker/shared/illustrations.mjs';
import { characterSheetKey, characterSheets, createCharacterSheetReview } from './character-sheet-review.mjs';

const activeImageStatuses = ['queued', 'generating', 'retrying'];
const imageJobMessages = {
  queued: 'ComfyUI 排队中',
  generating: 'ComfyUI 生成中',
  retrying: '暂时无法同步插图，稍后自动重试',
  failed: 'ComfyUI 执行失败',
  'no-output': 'ComfyUI 已结束，未返回可保存的图片',
  unavailable: '当前无法找到原生图任务',
  unknown: 'ComfyUI 尚未确认收到任务',
};

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

export function resultImages(result, cwd) {
  if (
    !/^b-[a-f0-9]{32}$/.test(result?.bookId ?? '') ||
    result.status === 'character-options' ||
    (cwd && cwd.replace(/\/$/, '') !== '/workspace/novels/' + result.bookId) ||
    !Array.isArray(result.images)
  )
    return [];
  return result.images
    .filter((item) => illustrationPath(item?.imagePath))
    .slice(0, 4)
    .map((item) => ({ ...item, bookId: result.bookId }));
}

export function turnImageResults(calls, cwd) {
  const images = new Map();
  const sheets = new Map();
  const jobs = new Map();
  const ready = new Set();
  function visit(block) {
    if (block.name === 'novel_generate_image' && block.kind === 'tool-result' && !block.isError) {
      const { result } = proposalToolModel(block.name, block);
      if (
        /^b-[a-f0-9]{32}$/.test(result?.bookId ?? '') &&
        /^[a-f0-9-]{36}$/.test(result?.jobId ?? '') &&
        (!cwd || cwd.replace(/\/$/, '') === '/workspace/novels/' + result.bookId)
      ) {
        const key = result.bookId + '/' + result.jobId;
        if (Object.hasOwn(imageJobMessages, result.status)) jobs.set(key, result);
        else if (result.images?.length) ready.add(key);
      }
      for (const image of resultImages(result, cwd)) {
        if (!images.has(image.imagePath)) images.set(image.imagePath, image);
      }
      for (const sheet of characterSheets(result, cwd)) {
        const key = sheet.bookId + ':' + characterSheetKey(sheet.character);
        const previous = sheets.get(key);
        if (!previous || result.images?.length || !previous.candidates.length) sheets.set(key, sheet);
      }
    }
    for (const child of block.subCalls ?? []) visit(child);
  }
  for (const call of calls) if (call.root) visit(call.root);
  for (const key of ready) jobs.delete(key);
  return { images: [...images.values()], sheets: [...sheets.values()], jobs: [...jobs.values()] };
}

export function installProposalToolViews(ctx, React) {
  const h = React.createElement,
    ProseEditor = createProseEditor(React);
  function GeneratedImage({ bookId, imagePath, label, wide = false }) {
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
          { className: 'novel-generated-image' + (wide ? ' novel-generated-image-wide' : '') },
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
  const CharacterSheetReview = createCharacterSheetReview(React, GeneratedImage);
  function DrawingProgress({ book, call, caption, fallback }) {
    const [state, setState] = React.useState(null);
    const [previewError, setPreviewError] = React.useState(0);
    const url = '/api/comfy/progress?' + new URLSearchParams({ book, call });
    React.useEffect(() => {
      if (!book || !call) return;
      const owner = new AbortController();
      let timer;
      async function poll() {
        try {
          const response = await fetch(url, {
            credentials: 'same-origin',
            signal: AbortSignal.any([owner.signal, AbortSignal.timeout(5000)]),
          });
          if ([401, 403, 404].includes(response.status)) return;
          if (response.ok && !owner.signal.aborted) {
            const next = await response.json();
            if (!owner.signal.aborted) setState(next.active ? next : null);
          }
        } catch {
          /* The active tool remains visible while the connection recovers. */
        }
        if (!owner.signal.aborted) timer = setTimeout(poll, 2200);
      }
      poll();
      return () => {
        owner.abort();
        clearTimeout(timer);
      };
    }, [url, book, call]);
    const message =
      {
        submitting: '正在提交给 ComfyUI',
        queued: '插图已排队',
        waiting: '等待 ComfyUI 返回成图',
        generating: '正在生成插图',
        saving: '正在存入本书图集',
      }[state?.stage] ?? fallback ?? '正在准备插图';
    return h(
      React.Fragment,
      null,
      h(
        'p',
        { role: 'status' },
        [caption, message, state?.candidateCount && `${state.candidatesFinished} / ${state.candidateCount} 张已画好`, state?.max && `${state.value} / ${state.max} 步`].filter(Boolean).join(' · '),
      ),
      state?.max ? h('progress', { max: state.max, value: state.value, 'aria-label': '当前采样进度' }) : null,
      state?.previewId && state.previewId !== previewError
        ? h(
            'figure',
            { className: 'novel-generated-image' },
            h('img', {
              src: url + '&image=' + state.previewId,
              alt: state.previewCompleted ? '最新完成的候选图' : '绘制中的插图预览',
              onError: () => setPreviewError(state.previewId),
            }),
            h('figcaption', null, state.previewCompleted ? '最新完成的候选图' : '生成中预览'),
          )
        : null,
    );
  }
  function GeneratedImageToolView({ toolName, block, cwd, callId }) {
    const { result, settled, failed, raw } = proposalToolModel(toolName, block);
    const action = block.args?.text?.('action');
    if (
      ['inspect', 'presets', 'references', 'characters', 'character_reference_views'].includes(action) ||
      result?.status === 'character-reference-views-needed' ||
      result?.presets ||
      result?.references ||
      (settled && !failed && !result?.status && !result?.images)
    )
      return null;
    const sheets = characterSheets(result, cwd);
    if (sheets.length)
      return sheets.map((sheet) =>
        h(CharacterSheetReview, { key: sheet.bookId + ':' + characterSheetKey(sheet.character), ...sheet }),
      );
    const images = resultImages(result, cwd);
    if (images.length)
      return h(
        'section',
        { className: 'novel-proposal-tool', 'aria-label': 'AI 插图结果' },
        ...images.map((image) => h(GeneratedImage, { key: image.imagePath, ...image })),
      );
    if (!settled) {
      const book = /^\/workspace\/novels\/(b-[a-f0-9]{32})\/?$/.exec(cwd ?? '')?.[1];
      return h(
        'section',
        { className: 'novel-proposal-tool', 'aria-label': 'AI 生图进度' },
        h(DrawingProgress, {
          book,
          call: callId ?? block.callId,
          caption: block.args?.text?.('caption') ?? block.args?.text?.('character'),
        }),
      );
    }
    const characterStatus = {
      'character-options': '候选人设图暂未就绪',
      'character-design-needed': '这个场景需要先定妆',
      'character-reference-unavailable': '当前工作流缺少足够的人物参考图输入',
      'identify-characters': '正在确认画面角色',
      'identify-visual-type': '正在确认真人或动漫画风',
    }[result?.status];
    const message = failed
      ? '插图生成失败'
      : (imageJobMessages[result?.status] ??
        (result?.status === 'deliver-chapter' ? '先保存本章和已生成的插图' : characterStatus) ??
        '插图结果暂无法读取');
    return h(
      'section',
      { className: 'novel-proposal-tool', 'aria-label': 'AI 生图执行详情' },
      h('p', { role: 'status' }, message),
      failed && raw ? h('details', null, h('summary', null, '查看原因'), h('pre', null, raw)) : null,
    );
  }
  function PendingImageJob({ bookId, jobId, status, progressCallId }) {
    const [result, setResult] = React.useState(null);
    React.useEffect(() => {
      if (!activeImageStatuses.includes(status)) return;
      const owner = new AbortController();
      let timer;
      async function poll() {
        let next;
        try {
          const response = await fetch('/api/novels/' + bookId + '/image-jobs/' + jobId, {
            method: 'POST',
            credentials: 'same-origin',
            signal: AbortSignal.any([owner.signal, AbortSignal.timeout(25_000)]),
          });
          if (response.ok) next = await response.json();
          else if ([401, 403, 404].includes(response.status)) next = { status: 'unavailable' };
        } catch {
          // Keep the same receipt while the connection is unavailable.
        }
        if (owner.signal.aborted) return;
        setResult(next ?? { status: 'retrying' });
        if (!next || activeImageStatuses.includes(next.status))
          timer = setTimeout(poll, !next || next.status === 'retrying' ? 30_000 : 12_000);
      }
      poll();
      return () => {
        owner.abort();
        clearTimeout(timer);
      };
    }, [bookId, jobId, status]);
    const sheets = characterSheets(result, '/workspace/novels/' + bookId);
    if (sheets.length)
      return sheets.map((sheet) =>
        h(CharacterSheetReview, { key: characterSheetKey(sheet.character), ...sheet }),
      );
    const images = resultImages(result, '/workspace/novels/' + bookId);
    const current = result?.status ?? status;
    return h(
      'section',
      { className: 'novel-proposal-tool', 'aria-label': 'AI 插图任务' },
      images.length
        ? images.map((image) => h(GeneratedImage, { key: image.imagePath, ...image }))
        : progressCallId && activeImageStatuses.includes(current)
          ? h(DrawingProgress, { book: bookId, call: progressCallId, fallback: imageJobMessages[current] })
          : h('p', { role: 'status' }, imageJobMessages[current]),
    );
  }
  function GeneratedImagesTail({ turn, chat }) {
    const source = chat.getSnapshot().nodes.turnDataSource(turn.turn, 'tool-call');
    const calls = React.useSyncExternalStore(source.subscribe, source.getSnapshot);
    const { images, sheets, jobs } = turnImageResults(calls);
    return h(
      React.Fragment,
      null,
      ...sheets.map((sheet) =>
        h(CharacterSheetReview, { key: sheet.bookId + ':' + characterSheetKey(sheet.character), ...sheet }),
      ),
      ...jobs.map(({ bookId, jobId, status, progressCallId }) =>
        h(PendingImageJob, { key: bookId + '/' + jobId, bookId, jobId, status, progressCallId }),
      ),
      images.length
        ? h(
            'section',
            { className: 'novel-proposal-tool', 'aria-label': '插图结果' },
            ...images.map((image) => h(GeneratedImage, { key: image.imagePath, ...image })),
          )
        : null,
    );
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
            chat: ctx.uiConversation.binding(ctx.sessions.binding(sessionId)).target('chat'),
          }),
        },
        GeneratedImagesTail,
      ),
    ),
  );
}
