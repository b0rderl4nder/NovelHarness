// Palette composition uses the ORIGINAL theme owner and original Appearance
// preference. Only the optional device-local accent is stored in the browser.
export const ACCENTS = Object.freeze({
  neutral: { label: '蓝图', light: '#004fd6', dark: '#77b2ff' },
  blue: { label: '雾蓝', light: '#365aa3', dark: '#a4bdf2' },
  violet: { label: '浅紫', light: '#7550a2', dark: '#c8b1e8' },
  amber: { label: '琥珀', light: '#876019', dark: '#dcc38b' },
});
const key = 'novel-studio-accent';
const pair = (light, dark) => ({ light, dark });
export function studioTokens(accent = 'neutral') {
  const color = ACCENTS[accent] ?? ACCENTS.neutral;
  return {
    '--dsw-alias-bg-base': pair('#ebedef', '#111316'),
    '--dsw-alias-bg-layer-1': pair('#ffffff', '#1b1d20'),
    '--dsw-alias-bg-layer-2': pair('#f4f6fa', '#262a31'),
    '--dsw-alias-bg-layer-3': pair('#e6edf6', '#303743'),
    '--dsw-alias-bg-module-platform': pair('#ebedef', '#111316'),
    '--dsw-alias-border-l2': pair('#c4cfdf', '#394353'),
    '--dsw-alias-border-l3': pair('#8a9bb5', '#485567'),
    '--dsw-alias-label-primary': pair('#171d25', '#dbe6f3'),
    '--dsw-alias-label-secondary': pair('#43516a', '#aebed3'),
    '--dsw-alias-label-tertiary': pair('#56647a', '#9eabbd'),
    '--dsw-alias-state-business-primary': pair(color.light, color.dark),
    '--dsw-alias-brand-primary': pair(color.light, color.dark),
    '--dsw-alias-link': pair(color.light, color.dark),
    '--dsw-alias-label-primary-foreground': pair('#ffffff', '#18191c'),
    '--dsw-alias-interactive-bg-hover': pair('#004fd60b', '#77b2ff12'),
    '--dsw-alias-interactive-bg-active': pair('#004fd61a', '#77b2ff20'),
    '--novel-control-bg': pair('#ffffff', '#262a31'),
    '--novel-control-border': pair('#677e9e', '#75859c'),
    '--novel-control-hover': pair('#e7effb', '#313d4f'),
    '--novel-control-disabled-bg': pair('#e1e5eb', '#23262d'),
    '--novel-surface-shadow': pair('none', 'none'),
    '--novel-blueprint-grid': pair('#152c5815', '#acc1e514'),
    '--novel-blueprint-rail': pair('#141921', '#090a0d'),
    '--novel-blueprint-header': pair('#1b222e', '#101216'),
    '--novel-blueprint-yellow': pair('#ffe13b', '#e8c94d'),
  };
}
export function installStudioTheme(ctx, React, { storage } = {}) {
  if (storage === undefined) {
    try {
      storage = globalThis.localStorage;
    } catch {
      storage = null;
    }
  }
  let accent = 'neutral',
    release;
  try {
    const saved = storage?.getItem(key);
    if (Object.hasOwn(ACCENTS, saved)) accent = saved;
  } catch {}
  const listeners = new Set();
  const apply = () => {
    const old = release;
    release = ctx.theme.overrideTokens('novel-studio', studioTokens(accent));
    old?.(); // Original owner ignores an obsolete layer disposer.
    for (const listener of listeners) listener();
  };
  ctx.effect(() => {
    apply();
    return () => release?.();
  }, 'novel: unified native theme palette');
  const select = (value) => {
    if (!Object.hasOwn(ACCENTS, value)) throw new Error('未知强调色。');
    try {
      storage?.setItem(key, value);
    } catch {
      /* Palette still works for this visit. */
    }
    accent = value;
    apply();
  };
  ctx.effect(() => {
    const changed = (event) => {
      if (event.key === key) {
        accent = Object.hasOwn(ACCENTS, event.newValue) ? event.newValue : 'neutral';
        apply();
      }
    };
    globalThis.addEventListener?.('storage', changed);
    return () => globalThis.removeEventListener?.('storage', changed);
  }, 'novel: device accent synchronization');
  function AccentRow() {
    const selected = React.useSyncExternalStore(
      (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      () => accent,
    );
    return React.createElement(
      'fieldset',
      { className: 'novel-theme-accents' },
      React.createElement('legend', null, '强调色'),
      ...Object.entries(ACCENTS).map(([id, value]) =>
        React.createElement(
          'button',
          {
            key: id,
            type: 'button',
            'aria-pressed': selected === id,
            onClick: () => select(id),
          },
          value.label,
        ),
      ),
      React.createElement('small', null, '仅影响本设备；明暗模式沿用上方外观设置。'),
    );
  }
  ctx.slots.inject('settings.general.item', () =>
    ctx.slots.register(
      {
        name: 'settings.general.item',
        id: 'novel-accent',
        order: 10.5,
      },
      AccentRow,
    ),
  );
  return { select, getAccent: () => accent };
}
