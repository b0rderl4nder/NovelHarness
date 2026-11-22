import { randomUUID } from 'node:crypto';

const previewLimit = 1024 * 1024;
const validBook = /^b-[a-f0-9]{32}$/;

export function createComfyProgress() {
  const live = new Map();
  return {
    begin(book, callId) {
      const key = book + '/' + callId;
      const entry = { stage: 'submitting', previewId: 0 };
      live.set(key, entry);
      return {
        update(stage, details = {}) {
          Object.assign(entry, { stage, value: undefined, max: undefined }, details);
        },
        image(bytes, type) {
          // The image endpoint only serves the last frame; do not build a gallery of temporary previews.
          entry.preview = { bytes, type };
          entry.previewId++;
        },
        end() {
          if (live.get(key) === entry) live.delete(key);
        },
      };
    },
    read(book, callId, image = false) {
      if (!validBook.test(book ?? '') || typeof callId !== 'string' || !callId || callId.length > 256)
        return null;
      const entry = live.get(book + '/' + callId);
      if (!entry) return null;
      const { preview, ...state } = entry;
      return image ? (preview ?? null) : state;
    },
  };
}

export async function watchComfy(base, live, signal) {
  const clientId = randomUUID();
  const url = new URL('ws', base);
  url.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('clientId', clientId);
  let socket,
    promptId,
    pending = [],
    confirmed = false,
    nextPreviewAt = 0;
  function stop() {
    socket?.close();
    signal.removeEventListener('abort', stop);
  }
  function receive({ type, data }) {
    if (data?.prompt_id !== promptId || !promptId) return;
    if (type === 'execution_start' || (type === 'executing' && data.node != null)) {
      confirmed = true;
      live.update('generating');
    } else if (
      type === 'progress' &&
      Number.isFinite(data.value) &&
      Number.isFinite(data.max) &&
      data.max > 0
    ) {
      confirmed = true;
      live.update('generating', { value: Math.min(data.max, Math.max(0, data.value)), max: data.max });
    } else if (type === 'execution_success' || (type === 'executing' && data.node === null)) {
      live.update('saving');
    }
  }
  try {
    signal.throwIfAborted();
    socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';
    signal.addEventListener('abort', stop, { once: true });
    socket.addEventListener('message', ({ data }) => {
      if (typeof data === 'string') {
        if (data.length > 16384) return;
        try {
          const event = JSON.parse(data);
          if (promptId) receive(event);
          else if (event.data?.prompt_id && pending.length < 12) pending.push(event);
        } catch {
          /* Ignore non-protocol data. */
        }
        return;
      }
      const now = Date.now();
      if (
        !confirmed ||
        now < nextPreviewAt ||
        !(data instanceof ArrayBuffer) ||
        data.byteLength < 12 ||
        data.byteLength > previewLimit
      )
        return;
      const header = new DataView(data);
      if (header.getUint32(0) !== 1) return;
      const kind = header.getUint32(4);
      const type =
        kind === 1 && header.getUint16(8) === 0xffd8
          ? 'image/jpeg'
          : kind === 2 && header.getUint32(8) === 0x89504e47
            ? 'image/png'
            : null;
      if (!type) return;
      nextPreviewAt = now + 1200;
      live.image(new Uint8Array(data, 8), type);
    });
    const opened = await new Promise((done) => {
      const timer = setTimeout(() => finish(false), 1000);
      function finish(value) {
        clearTimeout(timer);
        done(value);
      }
      socket.addEventListener('open', () => finish(true), { once: true });
      socket.addEventListener('error', () => finish(false), { once: true });
      socket.addEventListener('close', () => finish(false), { once: true });
    });
    if (!opened || signal.aborted) {
      stop();
      return null;
    }
    return {
      clientId,
      stop,
      track(id) {
        promptId = id;
        for (const item of pending) receive(item);
        pending = [];
      },
    };
  } catch {
    stop();
    return null;
  }
}
