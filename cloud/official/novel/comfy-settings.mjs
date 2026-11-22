import { createHash } from 'node:crypto';
import { endpoint, request } from '../../shared/comfy-render.mjs';
import { loadComfyPresets, visualAdjustments } from './comfy-presets.mjs';

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const invalid = (message, status = 400) => Object.assign(new Error(message), { status });
const presetsObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
const references = (preset) => Object.hasOwn(preset.bindings, 'reference');

export function createComfySettings(db, path) {
  db.run(
    'CREATE TABLE IF NOT EXISTS novel_comfy_settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)',
  );
  const stored = () => db.one('SELECT value FROM novel_comfy_settings WHERE id=1')?.value ?? '';
  let loading, cached;
  const original = () =>
    (loading ??= loadComfyPresets(path).catch((error) => {
      loading = undefined;
      if (error.code === 'ENOENT') throw invalid('主机尚未设置可用的 ComfyUI 工作流文件。', 503);
      throw error;
    }));

  function apply(original, changes) {
    const first = original.presets.get(original.defaultPreset).base;
    const base = changes.comfy ? endpoint(changes.comfy) : first;
    if (!original.endpoints.includes(base.href)) throw invalid('请选择主机已登记的 ComfyUI 地址。');
    const defaultPreset = changes.defaultPreset ?? original.defaultPreset;
    const defaultReferencePreset = changes.defaultReferencePreset ?? original.defaultReferencePreset;
    if (
      !original.presets.has(defaultPreset) ||
      (defaultReferencePreset &&
        !references(original.presets.get(defaultReferencePreset) ?? { bindings: {} }))
    )
      throw invalid('默认生图预设无效，参考图预设需要支持图像输入。');
    const values = changes.values ?? {};
    if (!presetsObject(values) || Object.keys(values).some((id) => !original.presets.has(id)))
      throw invalid('预设参数无效。');
    const presets = new Map();
    for (const [id, preset] of original.presets) {
      const overrides = Object.hasOwn(values, id) ? values[id] : {};
      if (!presetsObject(overrides)) throw invalid('预设参数无效。');
      const options = Object.entries(overrides).filter(
        ([key, value]) => value !== preset.controls[key]?.default,
      );
      const selected = visualAdjustments(
        preset,
        options.map(([name, value]) => ({ name, [typeof value === 'string' ? 'choice' : 'number']: value })),
      );
      const controls = Object.fromEntries(
        Object.entries(preset.controls).map(([key, rule]) => [
          key,
          { ...rule, default: selected[key] ?? rule.default },
        ]),
      );
      presets.set(id, {
        ...preset,
        base,
        controls,
        revision:
          base.href === first.href && !options.length
            ? preset.revision
            : hash([preset.revision, base.href, controls]),
      });
    }
    return { base, defaultPreset, defaultReferencePreset, presets };
  }

  async function load() {
    const originalConfig = await original();
    const raw = stored();
    if (cached?.raw === raw) return cached;
    let active, notice;
    try {
      active = apply(originalConfig, raw ? JSON.parse(raw) : {});
    } catch {
      active = apply(originalConfig, {});
      notice = '主机工作流已变更，当前使用主机默认设置。可重新选择并保存。';
    }
    return (cached = {
      ...active,
      raw,
      endpoints: originalConfig.endpoints,
      notice,
      revision: hash([
        raw,
        originalConfig.endpoints,
        ...Array.from(originalConfig.presets.values(), ({ revision }) => revision),
      ]),
    });
  }

  function view({ revision, base, endpoints, presets, defaultPreset, defaultReferencePreset, notice }) {
    return {
      supported: true,
      revision,
      comfy: base.href,
      endpoints,
      defaultPreset,
      defaultReferencePreset,
      notice,
      presets: [...presets.values()].map(({ id, label, bindings, controls }) => ({
        id,
        label,
        reference: Object.hasOwn(bindings, 'reference'),
        controls,
      })),
    };
  }

  return {
    load,
    original,
    async read() {
      return view(await load());
    },
    async save(input) {
      if (
        !presetsObject(input) ||
        typeof input.revision !== 'string' ||
        typeof input.comfy !== 'string' ||
        typeof input.defaultPreset !== 'string' ||
        (input.defaultReferencePreset !== undefined && typeof input.defaultReferencePreset !== 'string')
      )
        throw invalid('生图设置格式不正确。');
      const current = await load();
      if (current.revision !== input.revision) throw invalid('设置已在别处更新，请刷新页面后再改。', 409);
      const base = await original();
      const changes = {
        comfy: input.comfy,
        defaultPreset: input.defaultPreset,
        defaultReferencePreset: input.defaultReferencePreset,
        values: input.values,
      };
      try {
        apply(base, changes);
      } catch (error) {
        throw invalid(error.message);
      }
      if (stored() !== current.raw) throw invalid('设置已在别处更新，请刷新页面后再改。', 409);
      db.run(
        'INSERT INTO novel_comfy_settings(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value',
        JSON.stringify(changes),
      );
      return view(await load());
    },
    async check(address, signal) {
      let base;
      try {
        base = endpoint(address);
      } catch {
        throw invalid('ComfyUI 地址格式不正确。');
      }
      if (!(await original()).endpoints.includes(base.href))
        throw invalid('请选择主机已登记的 ComfyUI 地址。');
      try {
        const stats = await request(base, 'system_stats', {
          signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
        });
        if (!stats?.system || !Array.isArray(stats.devices)) throw new Error('Unexpected response');
      } catch {
        throw invalid('从主机连接 ComfyUI 失败，请检查地址与运行状态。', 502);
      }
      return { connected: true };
    },
  };
}
