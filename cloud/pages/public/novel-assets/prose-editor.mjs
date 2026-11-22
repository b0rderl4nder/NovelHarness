import {
  EditorState,
  EditorView,
  Transaction,
  keymap,
  drawSelection,
  defaultKeymap,
  history,
  historyKeymap,
} from './editor-vendor.mjs';
import { editorText, editorValue, editorRange, editorChange } from './editor-text.mjs';
import { illustrationExtension, prepareIllustration } from './illustration-editor.mjs';
import { createIllustrationGallery } from './illustration-gallery.mjs';
import {
  insertIllustration,
  illustrationMarker,
  illustrationEntries,
} from '../../../worker/shared/illustrations.mjs';
// EditorView is an ephemeral rendering/undo view of the EXISTING manuscript
// draft. No second persisted body, API, autosave loop or task lifecycle.
export function createProseEditor(React) {
  const IllustrationGallery = createIllustrationGallery(React);
  return function ProseEditor({
    value,
    onChange,
    onSelection,
    onSave,
    readOnly = false,
    label = '书稿正文',
    revealLine = null,
    illustrationApi = null,
    bookId = null,
    initialPosition = null,
    onPosition,
  }) {
    const host = React.useRef(null),
      view = React.useRef(null),
      applying = React.useRef(false);
    const latest = React.useRef({});
    const [hidden, setHidden] = React.useState(false),
      [toolsOpen, setToolsOpen] = React.useState(false),
      [caption, setCaption] = React.useState(''),
      [uploading, setUploading] = React.useState(false),
      [message, setMessage] = React.useState('');
    const fileInput = React.useRef(null),
      replacement = React.useRef(null),
      mounted = React.useRef(true),
      illustrations = React.useRef(null),
      insertionPoint = React.useRef(null),
      uploadingNow = React.useRef(false);
    latest.current = { value, onChange, onSelection, onSave, illustrationApi, hidden, readOnly, onPosition };
    function insertSaved(imagePath, label) {
      const editor = view.current,
        source = latest.current.value;
      if (!editor || latest.current.readOnly) return;
      const range = editorRange(
        editor.state.doc.toString(),
        insertionPoint.current === null ? editor.state.doc.length : editor.state.selection.main.to,
        insertionPoint.current === null ? editor.state.doc.length : editor.state.selection.main.to,
        source,
      );
      editor.dispatch({
        changes: editorChange(
          editor.state.doc.toString(),
          editorValue(insertIllustration(source, imagePath, label, range.end)),
        ),
        userEvent: 'input',
      });
      setMessage('已插入；随正文保存。');
      setToolsOpen(false);
    }
    async function upload(event) {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file || uploadingNow.current) return;
      const editor = view.current,
        source = latest.current.value,
        ownerApi = latest.current.illustrationApi,
        before = editor?.state.doc.toString(),
        at = insertionPoint.current === null ? editor?.state.doc.length : editor?.state.selection.main.to,
        target = replacement.current;
      if (!editor || !ownerApi || latest.current.readOnly) return;
      uploadingNow.current = true;
      setUploading(true);
      setMessage('正在处理插图…');
      try {
        const content = await prepareIllustration(file, caption || file.name.replace(/\.[^.]+$/, ''));
        if (!mounted.current) return;
        setMessage('正在保存插图…');
        const result = await ownerApi('illustrations', { action: 'upload', content });
        if (!mounted.current) return;
        if (
          view.current !== editor ||
          ownerApi !== latest.current.illustrationApi ||
          before !== editor.state.doc.toString() ||
          source !== latest.current.value
        )
          throw new Error('插图已存入本书，期间正文或位置发生变化；请重新选择位置插入。');
        const label = caption || file.name.replace(/\.[^.]+$/, '');
        if (target) {
          if (before.slice(target.from, target.to) !== target.marker)
            throw new Error('原插图位置已变化，请重新选择。');
          editor.dispatch({
            changes: {
              from: target.from,
              to: target.to,
              insert: illustrationMarker(result.imagePath, label),
            },
            userEvent: 'input',
          });
        } else {
          const range = editorRange(before, at, at, source);
          editor.dispatch({
            changes: editorChange(
              before,
              editorValue(insertIllustration(source, result.imagePath, label, range.end)),
            ),
            userEvent: 'input',
          });
        }
        setMessage('已插入；随正文保存。');
        setCaption('');
        setToolsOpen(false);
      } catch (error) {
        if (mounted.current) setMessage(error.message);
      } finally {
        uploadingNow.current = false;
        replacement.current = null;
        if (mounted.current) setUploading(false);
      }
    }
    React.useLayoutEffect(() => {
      mounted.current = true;
      const source = editorValue(latest.current.value);
      const caret = Number.isSafeInteger(initialPosition?.caret)
        ? Math.max(0, Math.min(source.length, initialPosition.caret))
        : 0;
      let positionTimer;
      let positionChanged = false;
      const persistPosition = () => {
        positionTimer = undefined;
        if (positionChanged)
          latest.current.onPosition?.({
            caret: editor.state.selection.main.head,
            scrollTop: editor.scrollDOM.scrollTop,
          });
      };
      const queuePosition = () => {
        if (!latest.current.onPosition) return;
        positionChanged = true;
        if (positionTimer === undefined) positionTimer = setTimeout(persistPosition, 250);
      };
      const editor = new EditorView({
        parent: host.current,
        state: EditorState.create({
          doc: source,
          selection: { anchor: caret },
          extensions: [
            ...(illustrationApi
              ? [
                  (() => {
                    const addon = illustrationExtension({
                      hidden: () => latest.current.hidden,
                      readOnly: () => latest.current.readOnly,
                      read: (imagePath) =>
                        latest.current.illustrationApi('illustrations', null, { action: 'read', imagePath }),
                      replace: (entry) => {
                        replacement.current = entry;
                        setCaption(entry.caption);
                        fileInput.current?.click();
                      },
                    });
                    illustrations.current = addon;
                    return addon.extension;
                  })(),
                ]
              : []),
            EditorState.readOnly.of(readOnly),
            EditorView.editable.of(!readOnly),
            history(),
            keymap.of([...defaultKeymap, ...historyKeymap]),
            drawSelection(),
            EditorView.lineWrapping,
            EditorView.contentAttributes.of({
              'aria-label': label,
              spellcheck: 'false',
              autocorrect: 'off',
              autocapitalize: 'off',
            }),
            EditorView.domEventHandlers({
              keydown(event) {
                if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
                  event.preventDefault();
                  event.stopPropagation();
                  latest.current.onSave?.();
                  return true;
                }
                return false;
              },
            }),
            EditorView.updateListener.of((update) => {
              if (applying.current || (!update.docChanged && !update.selectionSet)) return;
              queuePosition();
              const props = latest.current,
                normalized = update.state.doc.toString();
              const source = update.docChanged ? editorText(normalized, props.value) : props.value;
              if (update.docChanged) props.onChange(source);
              const selection = update.state.selection.main;
              if (update.view.hasFocus) insertionPoint.current = selection.to;
              props.onSelection?.(editorRange(normalized, selection.from, selection.to, source));
            }),
          ],
        }),
      });
      view.current = editor;
      const restoreFrame = requestAnimationFrame(() => {
        if (Number.isFinite(initialPosition?.scrollTop))
          editor.scrollDOM.scrollTop = Math.max(0, initialPosition.scrollTop);
        editor.scrollDOM.addEventListener('scroll', queuePosition, { passive: true });
      });
      // Keep the ORIGINAL focused selection visible when keyboard/viewport
      // geometry changes. The editor owns scrolling; no document/selection
      // rewrite, draft copy or independent caret controller.
      let viewportFrame;
      const viewport = globalThis.visualViewport;
      const canReveal = () => editor.hasFocus && (!viewport || viewport.scale === 1);
      const revealCaret = () => {
        if (!canReveal() || viewportFrame !== undefined) return;
        viewportFrame = requestAnimationFrame(() => {
          viewportFrame = undefined;
          if (canReveal())
            editor.dispatch({
              effects: EditorView.scrollIntoView(editor.state.selection.main.head, { y: 'nearest' }),
            });
        });
      };
      viewport?.addEventListener('resize', revealCaret);
      window.addEventListener('resize', revealCaret);
      return () => {
        mounted.current = false;
        viewport?.removeEventListener('resize', revealCaret);
        window.removeEventListener('resize', revealCaret);
        if (viewportFrame !== undefined) cancelAnimationFrame(viewportFrame);
        cancelAnimationFrame(restoreFrame);
        editor.scrollDOM.removeEventListener('scroll', queuePosition);
        if (positionTimer !== undefined) {
          clearTimeout(positionTimer);
          persistPosition();
        }
        view.current = null;
        editor.destroy();
      };
    }, []);
    React.useLayoutEffect(() => {
      if (view.current && illustrations.current)
        view.current.dispatch({ effects: illustrations.current.refresh.of(null) });
    }, [hidden]);
    React.useLayoutEffect(() => {
      const editor = view.current,
        normalized = editorValue(value);
      if (!editor) return;
      const change = editorChange(editor.state.doc.toString(), normalized);
      if (!change) return;
      applying.current = true;
      try {
        editor.dispatch({
          changes: change,
          annotations: Transaction.addToHistory.of(false),
        });
      } finally {
        applying.current = false;
      }
    }, [value]);
    React.useLayoutEffect(() => {
      const editor = view.current;
      if (!editor || !readOnly || !revealLine) return;
      const line = Math.max(1, Math.min(editor.state.doc.lines, revealLine.line));
      editor.dispatch({
        effects: EditorView.scrollIntoView(editor.state.doc.line(line).from, { y: 'start' }),
      });
    }, [revealLine?.line, revealLine?.request, readOnly]);
    const h = React.createElement;
    return h(
      React.Fragment,
      null,
      illustrationApi && !readOnly
        ? h(
            'div',
            { className: 'novel-illustration-toolbar' },
            h(
              'button',
              { type: 'button', 'aria-haspopup': 'dialog', onClick: () => setToolsOpen(true) },
              '▧ 插图',
            ),
            illustrationEntries(value).length
              ? h(
                  'button',
                  { type: 'button', 'aria-pressed': hidden, onClick: () => setHidden(!hidden) },
                  hidden ? '展开插图' : '收起插图',
                )
              : null,
            h('input', {
              type: 'file',
              ref: fileInput,
              accept: 'image/png,image/jpeg,image/webp',
              hidden: true,
              onChange: upload,
              'aria-label': '上传章节插图',
            }),
            toolsOpen && bookId
              ? h(IllustrationGallery, {
                  key: bookId,
                  bookId,
                  api: illustrationApi,
                  caption,
                  setCaption,
                  uploading,
                  upload: () => {
                    replacement.current = null;
                    fileInput.current?.click();
                  },
                  insert: insertSaved,
                  close: () => setToolsOpen(false),
                })
              : null,
            message ? h('small', { role: 'status' }, message) : null,
          )
        : null,
      h('div', { className: 'novel-prose-editor', ref: host }),
    );
  };
}
