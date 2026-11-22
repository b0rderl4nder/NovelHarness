import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { endpoint } from '../../shared/comfy-render.mjs';

export const regionLabels = ['character', 'object', 'text'];
const presetId = /^[a-z][a-z0-9-]{0,39}$/;
const text = (value, max) => typeof value === 'string' && value.trim() && value.length <= max;
const internalBindings = new Set([
  'prompt',
  'negativePrompt',
  'seed',
  'reference',
  'useReference',
  ...[1, 2, 3, 4].flatMap((i) => ['characterReference' + i, 'useCharacterReference' + i]),
]);

function readControls(template, bindings, values, entries) {
  const controls = Object.create(null);
  const entriesList = Object.entries(entries ?? {});
  if (entriesList.length > 16) throw new Error('ComfyUI 预设的可调参数超过 16 项。');
  for (const [key, rule] of entriesList) {
    const [node, input] = bindings[key]?.[0] ?? [];
    const initial = values[key] ?? template[node]?.inputs[input];
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(key) || internalBindings.has(key) || !rule)
      throw new Error('可调参数绑定无效：' + key);
    if (
      Array.isArray(rule.choices) &&
      rule.choices.length <= 32 &&
      rule.choices.every((choice) => text(choice, 100))
    ) {
      controls[key] = { choices: rule.choices, default: initial };
    } else if (
      Number.isFinite(rule.min) &&
      Number.isFinite(rule.max) &&
      rule.max >= rule.min &&
      (rule.step === undefined || (Number.isFinite(rule.step) && rule.step > 0))
    ) {
      controls[key] = {
        min: rule.min,
        max: rule.max,
        ...(rule.step ? { step: rule.step } : {}),
        default: initial,
      };
    } else throw new Error('可调参数需要有效的范围或选项：' + key);
    if (!validControl(controls[key], initial)) throw new Error('可调参数的工作流默认值无效：' + key);
  }
  return controls;
}

function validControl(rule, value) {
  if (rule.choices) return rule.choices.includes(value);
  if (!Number.isFinite(value) || value < rule.min || value > rule.max) return false;
  const steps = rule.step ? (value - rule.min) / rule.step : 0;
  return Math.abs(steps - Math.round(steps)) < 1e-7;
}

export function visualAdjustments(preset, adjustments = []) {
  const selected = Object.create(null);
  for (const { name, number, choice } of adjustments) {
    if (!Object.hasOwn(preset.controls, name) || Object.hasOwn(selected, name))
      throw new Error('此工作流没有这个可调参数，或参数重复：' + name);
    if (
      (number === undefined) === (choice === undefined) ||
      !validControl(preset.controls[name], number ?? choice)
    )
      throw new Error('可调参数超出该工作流的范围或选项：' + name);
    selected[name] = number ?? choice;
  }
  return selected;
}

export function referenceCanvas(controls, selected, { width, height }) {
  const { width: horizontal, height: vertical } = controls;
  if (!horizontal?.step || !vertical?.step || !(width > 0 && height > 0)) return {};
  const fit = (size, rule) =>
    rule.min +
    Math.min(
      Math.floor((rule.max - rule.min) / rule.step),
      Math.max(0, Math.round((size - rule.min) / rule.step)),
    ) *
      rule.step;
  const maxScale = Math.min(horizontal.max / width, vertical.max / height);
  const minScale = Math.max(horizontal.min / width, vertical.min / height);
  const scale =
    selected.width !== undefined
      ? selected.width / width
      : selected.height !== undefined
        ? selected.height / height
        : Math.min(maxScale, Math.max(1, minScale));
  return { width: fit(width * scale, horizontal), height: fit(height * scale, vertical) };
}

export async function loadComfyPresets(path) {
  const config = JSON.parse(await readFile(path, 'utf8'));
  const base = endpoint(config.comfy);
  const alternatives = config.allowedComfyEndpoints ?? [];
  if (
    !Array.isArray(alternatives) ||
    alternatives.length > 12 ||
    alternatives.some((value) => typeof value !== 'string')
  )
    throw new Error('ComfyUI 可切换地址列表无效。');
  const endpoints = [...new Set([base.href, ...alternatives.map((value) => endpoint(value).href)])];
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
          guidance = '',
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
        if (typeof guidance !== 'string' || guidance.length > 800) throw new Error('ComfyUI 预设说明无效。');
        if (requiresReference && !Object.hasOwn(bindings, 'reference'))
          throw new Error('强制参考图的预设缺少 reference 绑定。');
        const controls = readControls(template, bindings, values, entry.controls);
        const recipe = [base.href, template, bindings, values];
        // Keep old job receipts readable. Prompt prefixes no longer enter new prompts.
        if (layout || promptPrefix) recipe.push(layout, promptPrefix);
        if (Object.keys(controls).length) recipe.push(controls);
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
            guidance: guidance.trim(),
            controls,
            requiresReference,
            revision,
            ffmpeg: entry.ffmpeg ?? config.ffmpeg ?? 'ffmpeg',
          },
        ];
      }),
    ),
  );
  const supportsReference = (id) => Object.hasOwn(presets.get(id)?.bindings ?? {}, 'reference');
  const defaultReferencePreset =
    config.defaultReferencePreset ??
    (supportsReference(defaultPreset)
      ? defaultPreset
      : ([...presets.keys()].find((id) => presets.get(id).requiresReference) ??
        [...presets.keys()].find(supportsReference)));
  if (defaultReferencePreset !== undefined && !supportsReference(defaultReferencePreset))
    throw new Error('ComfyUI 默认参考图预设未绑定 reference。');
  return { defaultPreset, defaultReferencePreset, presets, endpoints };
}

export function compileVisualPrompt(preset, args, adjustments = {}) {
  if (
    args.regions === undefined &&
    ['style', 'composition', 'atmosphere'].every((key) => args[key] === undefined)
  )
    return args.prompt;
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
  if (args.regions === undefined) return caption;
  if (!preset.layout) throw new Error('此预设不支持位置框，请选择 MOSS 版式预设。');
  if (!Array.isArray(args.regions) || !args.regions.length || args.regions.length > 16)
    throw new Error('版式需要 1 至 16 个位置框。');
  const width = adjustments.width ?? preset.layout[0];
  const height = adjustments.height ?? preset.layout[1];
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
  const prompt = JSON.stringify({
    summary: { canvas: width === height ? 'square' : width > height ? 'landscape' : 'portrait', caption },
    items,
    bbox_coord_space: 'abs_centralized',
    bbox_format: 'yxyx',
  });
  if (prompt.length > 12000) throw new Error('编排后的提示词超过 12000 字符，请缩短位置说明。');
  return prompt;
}
