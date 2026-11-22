import { illustrationPath } from '../../../worker/shared/illustrations.mjs';

const bookPattern = /^b-[a-f0-9]{32}$/;
const identityPattern = /^[a-f0-9]{32}$/;
const sheetStatuses = new Set(['character-options', 'character-locked', 'character-design-needed']);
export const characterSheetKey = (character) => character.id + ':' + (character.visualType ?? 'legacy');
const typeLabel = { realistic: '真人', anime: '动漫', legacy: '旧版' };

export function characterSheets(result, cwd) {
  if (
    !sheetStatuses.has(result?.status) ||
    !bookPattern.test(result.bookId) ||
    (cwd && cwd.replace(/\/$/, '') !== '/workspace/novels/' + result.bookId)
  )
    return [];
  const entries = result.characterVisual ? [result.characterVisual] : result.characters;
  if (!Array.isArray(entries)) return [];
  return entries
    .filter(
      (item) =>
        identityPattern.test(item?.id) && typeof item.name === 'string' && Array.isArray(item.candidates),
    )
    .flatMap((character) => {
      const offered =
        result.characterVisual && Array.isArray(result.images)
          ? result.images.map((item) => item?.imagePath).slice(0, 4)
          : character.candidates.slice(0, 3);
      const candidates = [...new Set(offered.filter(illustrationPath))];
      return candidates.length || illustrationPath(character.chosen)
        ? [{ bookId: result.bookId, character, candidates }]
        : [];
    });
}

function bookUrl(book) {
  return '/api/novels/' + book + '/character-visuals';
}

async function visualRequest(book, input) {
  const response = await fetch(bookUrl(book), {
    credentials: 'same-origin',
    signal: AbortSignal.timeout(10000),
    ...(input
      ? { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }
      : {}),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) {
    const error = new Error(data?.error ?? '暂时无法读取人物定妆。');
    error.status = response.status;
    throw error;
  }
  return data;
}

export function createCharacterSheetReview(React, GeneratedImage) {
  const h = React.createElement;
  const pending = new Map();
  const listeners = new EventTarget();
  function read(book) {
    if (!pending.has(book)) {
      pending.set(
        book,
        visualRequest(book).finally(() => pending.delete(book)),
      );
    }
    return pending.get(book);
  }

  return function CharacterSheetReview({ bookId, character, candidates }) {
    const [visual, setVisual] = React.useState(null);
    const [picked, setPicked] = React.useState(null);
    const [error, setError] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const [retry, setRetry] = React.useState(0);
    const id = character.id;
    const visualType = character.visualType ?? 'legacy';
    const identity = characterSheetKey(character);
    React.useEffect(() => {
      let active = true;
      const update = (next) => {
        if (active && next && characterSheetKey(next) === identity)
          setVisual((before) => (!before || next.revision >= before.revision ? next : before));
      };
      const receive = (event) => update(event.detail);
      const external = (event) => {
        if (event.detail.bookId === bookId) update(event.detail.character);
      };
      listeners.addEventListener(bookId, receive);
      window.addEventListener('novel-character-visual-updated', external);
      read(bookId)
        .then(({ characters }) => {
          const next = characters.find((item) => characterSheetKey(item) === identity);
          if (next) update(next);
          else if (active) setError('这条定妆记录暂不可用。');
        })
        .catch((reason) => {
          if (active) setError(reason.message);
        });
      return () => {
        active = false;
        listeners.removeEventListener(bookId, receive);
        window.removeEventListener('novel-character-visual-updated', external);
      };
    }, [bookId, identity, character.revision, retry]);

    const current = visual ?? character;
    const offered = candidates.filter((path) => current.candidates.includes(path));
    const visible = [...new Set([...offered, ...(current.chosen ? [current.chosen] : [])])];
    const selected = visible.includes(picked) ? picked : (current.chosen ?? visible[0]);
    const label = (path) => {
      const index = offered.indexOf(path);
      return index === -1 ? '当前定妆' : '候选 ' + String.fromCharCode(65 + index);
    };

    async function confirm() {
      if (!visual || !selected || selected === current.chosen || busy) return;
      setBusy(true);
      setError('');
      try {
        const saved = await visualRequest(bookId, {
          id,
          visualType,
          revision: current.revision,
          imagePath: selected,
        });
        setPicked(null);
        listeners.dispatchEvent(new CustomEvent(bookId, { detail: saved }));
      } catch (reason) {
        setError(reason.status === 409 ? '定妆已更新。请核对当前选择，再确认。' : reason.message);
        if (reason.status === 409) setRetry((value) => value + 1);
      } finally {
        setBusy(false);
      }
    }
    return h(
      'section',
      { className: 'novel-character-sheet', 'aria-label': character.name + '的人设图' },
      h(
        'header',
        null,
        h('strong', null, character.name + ' · ' + typeLabel[visualType] + '人设'),
        h('span', { role: 'status' }, current.chosen ? '已定妆' : '待定妆'),
      ),
      selected
        ? h(GeneratedImage, {
            key: selected,
            bookId,
            imagePath: selected,
            label: label(selected),
            wide: true,
          })
        : null,
      visible.length
        ? h(
            'div',
            { className: 'novel-character-sheet-options', role: 'group', 'aria-label': '候选人设图' },
            ...visible.map((path) =>
              h(
                'button',
                {
                  key: path,
                  type: 'button',
                  'aria-pressed': path === selected,
                  disabled: busy,
                  onClick: () => setPicked(path),
                },
                label(path) + (path === current.chosen && offered.includes(path) ? ' · 已定妆' : ''),
              ),
            ),
          )
        : null,
      h(
        'div',
        { className: 'novel-character-sheet-actions' },
        h(
          'button',
          {
            className: 'novel-character-sheet-confirm',
            type: 'button',
            disabled:
              busy || !visual || !selected || current.chosen === selected || current.candidates.length < 2,
            onClick: () => void confirm(),
          },
          busy
            ? '正在保存…'
            : current.chosen === selected
              ? '已设为定妆'
              : current.chosen
                ? '更换定妆'
                : '设为定妆',
        ),
        !visual && error
          ? h(
              'button',
              {
                type: 'button',
                onClick: () => {
                  setError('');
                  setRetry((value) => value + 1);
                },
              },
              '重新加载',
            )
          : null,
        h(
          'span',
          { className: 'novel-character-sheet-note' },
          current.chosen
            ? '后续同类型出图会沿用这张定妆'
            : current.candidates.length < 2
              ? '还需要至少一张不同的候选'
              : '选定后用于后续情节图',
        ),
      ),
      error ? h('p', { role: 'alert' }, error) : null,
    );
  };
}
