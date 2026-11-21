import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { endpoint } from '../../shared/comfy-render.mjs';

export const regionLabels = ['character', 'object', 'text'];
const presetId = /^[a-z][a-z0-9-]{0,39}$/;
const text = (value, max) => typeof value === 'string' && value.trim() && value.length <= max;

export async function loadComfyPresets(path) {
  const config = JSON.parse(await readFile(path, 'utf8'));
  const base = endpoint(config.comfy);
  const defaultPreset = config.defaultPreset ?? 'default';
  const entries = Object.entries(config.presets ?? { default: config });
  if (!entries.length || entries.length > 12 || !entries.some(([id]) => id === defaultPreset))
    throw new Error('ComfyUI 默认预设不存在或预设数量无效。');
  const presets = new Map(
    await Promise.all(
      entries.map(async ([id, entry]) => {
        if (!presetId.test(id) || typeof entry?.workflow !== 'string')
          throw new Error('ComfyUI 预设标识或工作流无效。');
        const template = JSON.parse(await readFile(resolve(dirname(path), entry.workflow), 'utf8'));
        const {
          bindings = {},
          values = {},
          layout = null,
          promptPrefix = '',
          requiresReference = false,
        } = entry;
        if (!Object.hasOwn(bindings, 'prompt')) throw new Error('ComfyUI 预设缺少 prompt 绑定。');
        if (
          layout &&
          (!Array.isArray(layout) ||
            layout.length !== 2 ||
            layout.some((size) => !Number.isSafeInteger(size) || size < 16 || size > 1600 || size % 16))
        )
          throw new Error('MOSS 版式预设需要以 16 像素为单位的实际画幅。');
        if (typeof promptPrefix !== 'string' || promptPrefix.length > 1000)
          throw new Error('ComfyUI 预设提示前缀无效。');
        if (requiresReference && !Object.hasOwn(bindings, 'reference'))
          throw new Error('强制参考图的预设缺少 reference 绑定。');
        const recipe = [base.href, template, bindings, values];
        if (layout || promptPrefix) recipe.push(layout, promptPrefix);
        const revision = createHash('sha256').update(JSON.stringify(recipe)).digest('hex');
        return [
          id,
          {
            id,
            label: entry.label ?? id,
            base,
            template,
            bindings,
            values,
            layout,
            promptPrefix,
            requiresReference,
            revision,
            ffmpeg: entry.ffmpeg ?? config.ffmpeg ?? 'ffmpeg',
          },
        ];
      }),
    ),
  );
  return { defaultPreset, presets };
}

export function compileVisualPrompt(preset, args) {
  const description = [args.prompt.trim()];
  for (const [key, label] of [
    ['style', 'Style'],
    ['composition', 'Composition'],
    ['atmosphere', 'Lighting and atmosphere'],
  ]) {
    if (args[key] === undefined) continue;
    if (!text(args[key], 1000)) throw new Error(label + '描述无效。');
    description.push(label + '：' + args[key].trim());
  }
  const caption = description.join('\n');
  if (args.regions === undefined) return preset.promptPrefix + caption;
  if (!preset.layout) throw new Error('此预设不支持位置框，请选择 MOSS 版式预设。');
  if (!Array.isArray(args.regions) || !args.regions.length || args.regions.length > 16)
    throw new Error('版式需要 1 至 16 个位置框。');
  const [width, height] = preset.layout;
  const items = args.regions.map((region) => {
    const { label, caption: regionCaption, box, text: lettering } = region ?? {};
    if (
      !regionLabels.includes(label) ||
      !text(regionCaption, 800) ||
      !Array.isArray(box) ||
      box.length !== 4 ||
      box.some((value) => !Number.isSafeInteger(value) || value < 0 || value > 1000) ||
      box[0] >= box[2] ||
      box[1] >= box[3] ||
      (label === 'text' ? !text(lettering, 160) : lettering !== undefined)
    )
      throw new Error('位置框无效。用 [左,上,右,下] 的 0–1000 坐标标注，文字框还须给出原文。');
    const [x1, y1, x2, y2] = box;
    const project = (value, size) => Math.round((value / 1000 - 0.5) * size);
    const bbox = [project(y1, height), project(x1, width), project(y2, height), project(x2, width)];
    if (bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) throw new Error('位置框小于当前画幅的一个像素。');
    return {
      label,
      caption: regionCaption.trim(),
      bbox,
      ...(lettering === undefined ? {} : { text: lettering }),
    };
  });
  const prompt =
    preset.promptPrefix +
    JSON.stringify({
      summary: { canvas: width === height ? 'square' : width > height ? 'landscape' : 'portrait', caption },
      items,
      bbox_coord_space: 'abs_centralized',
      bbox_format: 'yxyx',
    });
  if (prompt.length > 12000) throw new Error('编排后的提示词超过 12000 字符，请缩短位置说明。');
  return prompt;
}
