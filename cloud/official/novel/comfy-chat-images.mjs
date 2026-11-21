const maxReferences = 24;
const extensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

// Only references admitted by DSH for the current conversation are eligible.
export async function chatImageReferences(sessionQuery, sessionId, signal) {
  const { events } = await sessionQuery.readSession(sessionId);
  signal.throwIfAborted();
  const references = new Map();
  for (let i = events.length - 1; i >= 0 && references.size < maxReferences; i--) {
    if (events[i].type !== 'user/message') continue;
    for (const part of events[i].data.content ?? []) {
      const ref = part.attachment;
      if (part.type !== 'image' || !Object.hasOwn(extensions, ref?.mediaType)) continue;
      const id = 'chat:' + ref.attachmentId;
      if (!references.has(id)) references.set(id, ref);
      if (references.size >= maxReferences) break;
    }
  }
  return references;
}

export async function loadChatImage(attachments, references, selection, signal) {
  const ref = selection === 'chat:latest' ? references.values().next().value : references.get(selection);
  if (!ref) throw new Error('当前对话没有这张参考图。可先上传，或查看当前对话中可引用的图片。');
  const { data } = await attachments.readImage(ref, signal);
  return {
    data,
    mediaType: ref.mediaType,
    extension: extensions[ref.mediaType],
    width: ref.width,
    height: ref.height,
  };
}
