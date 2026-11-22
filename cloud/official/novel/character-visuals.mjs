import { createHash, randomInt } from 'node:crypto';
import { illustrationPath } from '../../worker/shared/illustrations.mjs';
import { bindWorkflow } from '../../shared/comfy-render.mjs';
import { referenceCanvas } from './comfy-presets.mjs';

const invalid = (status, message) => Object.assign(new Error(message), { status });
const maxCast = 4;
const maxSheets = 12;
export const characterVisualTypes = ['realistic', 'anime'];
const validType = (type) => type === 'legacy' || characterVisualTypes.includes(type);

export function visualCharacter(value, visualType = 'legacy') {
  const name = typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/g, ' ') : '';
  if (!name || name.length > 80 || /[\p{C}]/u.test(name)) throw invalid(400, '请使用书内角色的姓名。');
  const id = createHash('sha256').update(name.toLowerCase()).digest('hex').slice(0, 32);
  if (!validType(visualType)) throw invalid(400, '未知的人设画风。');
  return { id, name, visualType };
}

export function createCharacterVisuals(db) {
  db.run(`CREATE TABLE IF NOT EXISTS novel_character_visuals (
    book TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, revision INTEGER NOT NULL,
    chosen TEXT, candidates TEXT NOT NULL, PRIMARY KEY(book,id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS novel_character_visual_variants (
    book TEXT NOT NULL, id TEXT NOT NULL, visual_type TEXT NOT NULL CHECK(visual_type IN ('realistic','anime')),
    name TEXT NOT NULL, revision INTEGER NOT NULL,
    chosen TEXT, candidates TEXT NOT NULL, PRIMARY KEY(book,id,visual_type)
  )`);
  const rows = (book) =>
    db.all(`SELECT id,name,revision,chosen,candidates,'legacy' AS visual_type FROM novel_character_visuals WHERE book=?
      UNION ALL SELECT id,name,revision,chosen,candidates,visual_type FROM novel_character_visual_variants WHERE book=?
      ORDER BY name,id,visual_type`, book, book);
  const find = (book, id, type) =>
    type === 'legacy'
      ? db.one('SELECT * FROM novel_character_visuals WHERE book=? AND id=?', book, id)
      : db.one('SELECT * FROM novel_character_visual_variants WHERE book=? AND id=? AND visual_type=?', book, id, type);
  const shape = ({ id, name, visual_type = 'legacy', revision, chosen, candidates }) => ({
    id,
    name,
    visualType: visual_type,
    revision,
    chosen,
    candidates: JSON.parse(candidates),
  });
  return {
    list: (book) => rows(book).map(shape),
    get(book, character) {
      const visualType = character.visualType ?? 'legacy';
      const row = find(book, character.id, visualType);
      return row ? shape(row) : { ...character, visualType, revision: 0, chosen: null, candidates: [] };
    },
    resolve(book, names, visualType) {
      if (!Array.isArray(names) || names.length > maxCast)
        throw invalid(400, '请列出画面中的具名角色，每张图最多四位。');
      const identities = names.map((name) => visualCharacter(name, visualType));
      if (new Set(identities.map(({ id }) => id)).size !== names.length)
        throw invalid(400, '画面角色名单有重复。');
      return identities.map((character) => this.get(book, character));
    },
    record(book, character, paths) {
      if (!paths.every(illustrationPath)) throw invalid(400, '人物候选图路径无效。');
      return db.transactionSync(() => {
        const { name, chosen, candidates, revision, visualType } = this.get(book, character);
        const next = [...new Set([...paths, ...candidates])]
          .filter((path) => path !== chosen)
          .slice(0, maxSheets - Number(!!chosen));
        if (chosen) next.unshift(chosen);
        if (visualType === 'legacy')
          db.run(
            `INSERT INTO novel_character_visuals(book,id,name,revision,candidates) VALUES (?,?,?,?,?)
            ON CONFLICT(book,id) DO UPDATE SET revision=excluded.revision,candidates=excluded.candidates`,
            book, character.id, name, revision + 1, JSON.stringify(next),
          );
        else
          db.run(
            `INSERT INTO novel_character_visual_variants(book,id,visual_type,name,revision,candidates) VALUES (?,?,?,?,?,?)
            ON CONFLICT(book,id,visual_type) DO UPDATE SET revision=excluded.revision,candidates=excluded.candidates`,
            book, character.id, visualType, name, revision + 1, JSON.stringify(next),
          );
        return this.get(book, character);
      });
    },
    choose(book, input, checkImage) {
      const visualType = input?.visualType ?? 'legacy';
      if (
        !/^[a-f0-9]{32}$/.test(input?.id ?? '') ||
        !validType(visualType) ||
        !Number.isSafeInteger(input.revision) ||
        !illustrationPath(input.imagePath)
      )
        throw invalid(400, '定妆选择无效。');
      return db.transactionSync(() => {
        const row = find(book, input.id, visualType);
        if (!row || !JSON.parse(row.candidates).includes(input.imagePath))
          throw invalid(404, '本书角色的候选图不存在。');
        if (row.chosen === input.imagePath) return shape(row);
        if (row.revision !== input.revision) throw invalid(409, '另一台设备已更新定妆，请重新打开候选图。');
        if (!row.chosen && JSON.parse(row.candidates).length < 2)
          throw invalid(409, '至少有两张不同的候选后才能定妆。');
        checkImage(input.imagePath);
        if (visualType === 'legacy')
          db.run(
            'UPDATE novel_character_visuals SET chosen=?,revision=revision+1 WHERE book=? AND id=?',
            input.imagePath, book, input.id,
          );
        else
          db.run(
            'UPDATE novel_character_visual_variants SET chosen=?,revision=revision+1 WHERE book=? AND id=? AND visual_type=?',
            input.imagePath, book, input.id, visualType,
          );
        return shape(find(book, input.id, visualType));
      });
    },
  };
}

// Built-in text-to-image presets can render sheets. Three graph branches use
// separate seeds and execute in one job without tripling the latent batch.
export function sheetGraph(config, values, count = 3) {
  if (!Object.hasOwn(config.bindings, 'seed')) throw new Error('候选人设图需要可设置种子的工作流。');
  const result = {};
  for (let index = 0; index < count; index++) {
    const diagram = bindWorkflow(config.template, config.bindings, {
      ...values,
      seed: ((values.seed ?? randomInt(2 ** 32)) + index) >>> 0,
    });
    const key = (id) => index + '-' + id;
    for (const [id, node] of Object.entries(diagram)) {
      for (const [name, value] of Object.entries(node.inputs)) {
        if (
          Array.isArray(value) &&
          value.length === 2 &&
          typeof value[0] === 'string' &&
          Number.isSafeInteger(value[1]) &&
          Object.hasOwn(diagram, value[0])
        )
          node.inputs[name] = [key(value[0]), value[1]];
      }
      result[key(id)] = node;
    }
  }
  return result;
}

export const characterSheetLayout =
  'One character turnaround sheet on a plain neutral background. Left panel: clear face close-up. Right panels: full body front, profile and back, on the same floor line. All four panels depict the same person, outfit and colors. Make each full body view visible head to toe. No text or watermark.';

export function identityBindings(preset, count, hasSceneReference) {
  const bindings = Array.from({ length: count }, (_, i) => 'characterReference' + (i + 1));
  if (
    bindings.every((key) => Object.hasOwn(preset.bindings, key)) &&
    (!preset.requiresReference || hasSceneReference) &&
    (!hasSceneReference || Object.hasOwn(preset.bindings, 'reference'))
  )
    return bindings;
  if (count === 1 && !hasSceneReference && Object.hasOwn(preset.bindings, 'reference')) return ['reference'];
  return null;
}

export function sheetCanvas(config, chosen) {
  const { width } = config.controls;
  return width?.step && config.controls.height?.step
    ? referenceCanvas(
        config.controls,
        { width: chosen.width ?? (chosen.height ? undefined : width.max), height: chosen.height },
        { width: 16, height: 9 },
      )
    : {};
}
