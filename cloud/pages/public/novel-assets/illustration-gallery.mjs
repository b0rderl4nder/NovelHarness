import { openIllustrationLightbox } from './illustration-editor.mjs';

const sections = [
  ['generated', '生成批次'],
  ['characters', '人设候选'],
  ['other', '其他插图'],
];
const visualLabels = { anime: '动漫', realistic: '真人', legacy: '旧版' };

export function createIllustrationGallery(React) {
  const h = React.createElement;
  function Thumbnail({ item, urlFor, read, ...button }) {
    const [fallback, setFallback] = React.useState(null);
    const ref = React.useRef(null);
    React.useEffect(() => {
      if (urlFor) return;
      let active = true;
      const load = () =>
        read(item.imagePath)
          .then(({ data }) => {
            if (active) setFallback(data);
          })
          .catch(() => {});
      const observer = new IntersectionObserver((entries) => {
        if (entries.some(({ isIntersecting }) => isIntersecting)) {
          observer.disconnect();
          void load();
        }
      });
      observer.observe(ref.current);
      return () => {
        active = false;
        observer.disconnect();
      };
    }, [item.imagePath, urlFor, read]);
    return h(
      'button',
      { ...button, type: 'button', ref, className: 'novel-gallery-thumb' },
      h(
        'span',
        { className: 'novel-gallery-frame' },
        urlFor || fallback
          ? h('img', {
              alt: '',
              loading: 'lazy',
              decoding: 'async',
              src: urlFor?.(item.imagePath) ?? fallback,
            })
          : null,
      ),
      h('span', null, item.title),
    );
  }
  return function IllustrationGallery({
    bookId,
    api,
    caption,
    setCaption,
    uploading,
    upload,
    insert,
    close,
  }) {
    const [section, setSection] = React.useState('generated');
    const [page, setPage] = React.useState(null);
    const [picked, setPicked] = React.useState(null);
    const [notice, setNotice] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const [version, setVersion] = React.useState(0);
    const [supportsBatches, setSupportsBatches] = React.useState(true);
    const dialog = React.useRef(null);
    const request = React.useRef(null);
    const lightbox = React.useRef(null);
    const base = '/api/novels/' + bookId;
    const urlFor = React.useMemo(
      () =>
        supportsBatches
          ? (path) =>
              base +
              '/image-preview/' +
              path
                .split('/')
                .at(-1)
                .replace(/\.json$/, '')
          : null,
      [base, supportsBatches],
    );
    const read = React.useCallback(
      (path) => api('illustrations', null, { action: 'read', imagePath: path }),
      [api],
    );
    React.useLayoutEffect(() => {
      dialog.current.showModal();
      return () => lightbox.current?.remove();
    }, []);

    async function load(cursor, signal) {
      if (!supportsBatches) return api('illustrations', null, cursor ? { cursor } : {});
      const params = new URLSearchParams({ type: section });
      if (cursor) params.set('cursor', cursor);
      const response = await fetch(base + '/image-gallery?' + params, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
        credentials: 'same-origin',
      });
      if (response.status === 404 && section === 'generated' && !cursor && !signal.aborted) {
        setSupportsBatches(false);
        setSection('other');
        return null;
      }
      if (!response.ok) throw new Error('暂时无法打开图集。');
      return response.json();
    }
    React.useEffect(() => {
      const owner = new AbortController();
      request.current = owner;
      setBusy(true);
      load(null, owner.signal)
        .then((result) => {
          if (result && !owner.signal.aborted) setPage(result);
        })
        .catch((error) => {
          if (!owner.signal.aborted) setNotice(error.message);
        })
        .finally(() => {
          if (!owner.signal.aborted) setBusy(false);
        });
      return () => owner.abort();
    }, [api, section, supportsBatches, version]);

    async function more() {
      const signal = request.current.signal;
      setBusy(true);
      try {
        const result = await load(page.nextCursor, signal);
        if (result && !signal.aborted) {
          const key = section === 'other' ? 'images' : 'batches';
          setPage({ ...result, [key]: [...page[key], ...result[key]] });
        }
      } catch (error) {
        if (!signal.aborted) setNotice(error.message);
      } finally {
        if (!signal.aborted) setBusy(false);
      }
    }
    function changeSection(next) {
      request.current?.abort();
      setPicked(null);
      setNotice('');
      setPage(null);
      setSection(next);
    }
    async function apply() {
      if (!picked || busy) return;
      const { item, character } = picked;
      if (!character) return insert(item.imagePath, item.label || '');
      const signal = request.current.signal;
      setBusy(true);
      try {
        const response = await fetch(base + '/character-visuals', {
          method: 'PUT',
          credentials: 'same-origin',
          signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            id: character.id,
            visualType: character.visualType,
            revision: character.revision,
            imagePath: item.imagePath,
          }),
        });
        const result = await response.json();
        if (!response.ok) {
          if (response.status === 409 && !signal.aborted) {
            setPicked(null);
            setVersion((value) => value + 1);
          }
          throw new Error(result.error || '定妆保存失败。');
        }
        if (!signal.aborted) {
          setPicked({ ...picked, character: result });
          setPage((previous) => ({
            ...previous,
            batches: previous.batches.map((batch) =>
              batch.character?.id === result.id && batch.character?.visualType === result.visualType
                ? { ...batch, character: result }
                : batch,
            ),
          }));
          setNotice('已设为' + visualLabels[result.visualType ?? 'legacy'] + '定妆');
          window.dispatchEvent(
            new CustomEvent('novel-character-visual-updated', {
              detail: { bookId, character: result },
            }),
          );
        }
      } catch (error) {
        if (!signal.aborted) setNotice(error.message);
      } finally {
        if (!signal.aborted) setBusy(false);
      }
    }
    async function zoom(event) {
      const trigger = event.currentTarget;
      try {
        const { imagePath, title } = picked.item;
        const src = urlFor ? urlFor(imagePath) : (await read(imagePath)).data;
        if (dialog.current?.open) lightbox.current = openIllustrationLightbox(src, title, trigger);
      } catch (error) {
        setNotice(error.message);
      }
    }
    const character = picked?.character;
    const groups =
      section === 'other'
        ? page?.images?.length
          ? [{ id: 'other', images: page.images, caption: '其他插图' }]
          : []
        : (page?.batches ?? []);
    return h(
      'dialog',
      {
        ref: dialog,
        className: 'novel-illustration-gallery',
        'aria-label': '插画图集',
        onClose: close,
        onClick: (event) => {
          if (event.target === event.currentTarget) event.currentTarget.close();
        },
      },
      h(
        'div',
        { className: 'novel-gallery-panel' },
        h(
          'header',
          null,
          h('h2', null, '插画图集'),
          h('button', { type: 'button', onClick: () => dialog.current.close() }, '关闭'),
        ),
        h(
          'nav',
          { 'aria-label': '图集分类' },
          ...sections
            .filter(([key]) => supportsBatches || key === 'other')
            .map(([key, label]) =>
              h(
                'button',
                {
                  key,
                  type: 'button',
                  'aria-pressed': section === key,
                  onClick: () => {
                    if (section !== key) changeSection(key);
                  },
                },
                label,
              ),
            ),
        ),
        h(
          'div',
          { className: 'novel-gallery-content', 'aria-busy': busy },
          ...groups.map((batch) =>
            h(
              'section',
              { key: batch.id, className: 'novel-gallery-batch' },
              h(
                'h3',
                null,
                batch.character
                  ? batch.character.name +
                      ' · ' +
                      visualLabels[batch.character.visualType ?? 'legacy'] +
                      '人设'
                  : batch.caption || '插画',
                h('small', null, ' · ' + batch.images.length + ' 张'),
              ),
              h(
                'div',
                { className: 'novel-gallery-grid' },
                ...batch.images.map((image, index) => {
                  const title = batch.character
                    ? '候选 ' + String.fromCharCode(65 + index)
                    : image.label || '插图 ' + (index + 1);
                  const key = batch.id + '/' + image.imagePath;
                  return h(Thumbnail, {
                    key,
                    item: {
                      ...image,
                      title: image.imagePath === batch.character?.chosen ? title + ' · 已定妆' : title,
                    },
                    urlFor,
                    read,
                    'aria-pressed': picked?.key === key,
                    onClick: () => {
                      setNotice('');
                      setPicked({ key, item: { ...image, title }, character: batch.character });
                    },
                  });
                }),
              ),
            ),
          ),
          !groups.length && !busy && !notice ? h('p', null, '这一类暂无插画。') : null,
          busy && !page ? h('p', { role: 'status' }, '正在载入图集…') : null,
          page?.nextCursor
            ? h('button', { type: 'button', disabled: busy, onClick: more }, '加载更多')
            : null,
        ),
        h(
          'footer',
          null,
          h(
            'div',
            { className: 'novel-gallery-upload' },
            h('input', {
              value: caption,
              maxLength: 160,
              'aria-label': '新插图图注',
              placeholder: '上传图注（选填）',
              onChange: (event) => setCaption(event.target.value),
            }),
            h(
              'button',
              { type: 'button', disabled: uploading, onClick: upload },
              uploading ? '上传中…' : '上传并插入',
            ),
          ),
          h(
            'div',
            { className: 'novel-gallery-selection' },
            h('span', { role: 'status' }, notice || picked?.item.title || '选择缩略图'),
            h('button', { type: 'button', disabled: !picked, onClick: zoom }, '放大'),
            h(
              'button',
              {
                type: 'button',
                className: 'novel-gallery-primary',
                onClick: apply,
                disabled:
                  !picked ||
                  busy ||
                  (!!character &&
                    (!character.candidates.includes(picked.item.imagePath) ||
                      character.candidates.length < 2 ||
                      character.chosen === picked.item.imagePath)),
              },
              character ? '设为' + visualLabels[character.visualType ?? 'legacy'] + '定妆' : '插入正文',
            ),
          ),
        ),
      ),
    );
  };
}
