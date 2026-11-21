import { illustrationEntries } from '../../worker/shared/illustrations.mjs';

// Use receipts from the open native turn. Image-only requests and later turns
// do not inherit an old writing task or any per-scene generation policy.
const proseTools = new Set(['novel_proposal_prepare', 'novel_proposal_inspect', 'novel_proposal_submit']);
const galleryPath = /^illustrations\/[a-f0-9]{64}\.json$/;
const chapterPath = /^chapters\/[^/]+\.md$/;

function coversScenes(scenes, paths) {
  const placed = new Set(paths);
  return (
    scenes.size > 0 &&
    [...scenes.values()].every((variants) => variants.some(({ imagePath }) => placed.has(imagePath)))
  );
}

function openChapterDelivery(events, root, bookId) {
  const start = events.findLastIndex((event) => event.type === 'turn/start' || event.type === 'turn/end');
  if (start < 0 || events[start].type !== 'turn/start') return null;
  const calls = new Map();
  const scenes = new Map();
  let task;
  for (let index = start + 1; index < events.length; index++) {
    const event = events[index];
    if (event.type === 'tool/call') calls.set(event.data.callId, event.data.name);
    if (event.type !== 'tool/result') continue;
    const message = event.data.message;
    const name = calls.get(message?.toolCallId);
    if (
      message?.isError ||
      (!proseTools.has(name) && name !== 'novel_generate_image' && name !== 'novel_illustration')
    )
      continue;
    let result;
    try {
      result = JSON.parse(message.content.find((part) => part.type === 'text')?.text);
    } catch {
      continue;
    }
    if (name === 'novel_illustration') {
      if (
        task?.published &&
        result?.saved === true &&
        result.path === task.path &&
        Array.isArray(result.images)
      )
        task.delivered ||= coversScenes(
          scenes,
          result.images.map((image) => image.path),
        );
      continue;
    }
    if (result?.bookId !== bookId) continue;
    if (proseTools.has(name) && result.task?.kind === 'prose' && typeof result.target === 'string') {
      const path = result.target.startsWith(root + '/')
        ? result.target.slice(root.length + 1)
        : result.target;
      if (!chapterPath.test(path) || typeof result.proposalId !== 'string') continue;
      if (task?.proposalId !== result.proposalId) {
        scenes.clear();
        task = { path, proposalId: result.proposalId };
      }
      task.expectedHash = result.expectedHash;
      task.published = result.status === 'accepted';
      if (task.published && Array.isArray(result.chapterIllustrations))
        task.delivered ||= coversScenes(scenes, result.chapterIllustrations);
    }
    if (
      task &&
      !task.delivered &&
      name === 'novel_generate_image' &&
      result.status === 'ready' &&
      Array.isArray(result.images)
    ) {
      const variants = result.images
        .filter((image) => galleryPath.test(image?.imagePath))
        .map(({ imagePath, label }) => ({ imagePath, label }));
      if (variants.length) scenes.set(result.jobId ?? variants[0].imagePath, variants);
    }
  }
  if (!task) return null;
  return { ...task, scenes };
}

export async function chapterDeliveryFor(sessionQuery, exec, root, book, service) {
  const { events } = await sessionQuery.readSession(exec.agent.session.id);
  exec.signal.throwIfAborted();
  const delivery = openChapterDelivery(events, root, book);
  if (!delivery?.scenes.size || delivery.delivered) return null;
  const { scenes, ...task } = delivery;
  if (task.published) {
    const placements = illustrationEntries(service.run({ kind: 'read', path: task.path }).text);
    if (
      coversScenes(
        scenes,
        placements.map(({ path }) => path),
      )
    )
      return null;
  }
  const variants = [...scenes.values()];
  return {
    ...task,
    images: variants.flat(),
    ...(variants.some((group) => group.length > 1) ? { scenes: variants } : {}),
    next: task.published
      ? '正文已保存。先用 novel_illustration 给每个已有成图的场景选一张并放入对应段落，再决定重画。'
      : '先用 novel_proposal_submit 的 complete=true 与 illustrations 提交完整正文，每个已有成图的场景选一张。凑不齐配图时先交付完整章文与可用图。入书后再决定是否重画。',
  };
}
