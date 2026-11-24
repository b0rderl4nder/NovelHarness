const loraId = /^[a-z][a-z0-9-]{0,39}$/;

export function readMossLoras(entries = {}) {
  if (!entries || typeof entries !== 'object' || Array.isArray(entries) || Object.keys(entries).length > 64)
    throw new Error('MOSS LoRA 清单无效。');
  return new Map(
    Object.entries(entries).map(([id, entry]) => {
      const { label, file, trigger, strength = 1 } = entry ?? {};
      if (
        !loraId.test(id) ||
        typeof label !== 'string' ||
        !label.trim() ||
        label.length > 100 ||
        typeof file !== 'string' ||
        !/^[\w .-]+\.safetensors$/.test(file) ||
        typeof trigger !== 'string' ||
        trigger.length > 240 ||
        /[\r\n{}]/.test(trigger) ||
        !Number.isFinite(strength) ||
        strength <= 0 ||
        strength > 2
      )
        throw new Error('MOSS LoRA 登记项无效。');
      return [id, { id, label: label.trim(), file, trigger: trigger.trim(), strength }];
    }),
  );
}

function mossModelInputs(graph) {
  return Object.entries(graph).filter(([, node]) => {
    if (node.class_type !== 'MossCandidatePrompt') return false;
    const seen = new Set();
    let link = node.inputs.model;
    while (Array.isArray(link) && link[1] === 0 && !seen.has(link[0])) {
      const source = graph[link[0]];
      if (source?.class_type === 'UNETLoader') return /moss[_-]image/i.test(source.inputs.unet_name ?? '');
      if (source?.class_type !== 'LoraLoaderModelOnly') return false;
      seen.add(link[0]);
      link = source.inputs.model;
    }
    return false;
  });
}

export const supportsMossLoras = (graph) => mossModelInputs(graph).length > 0;

export function bindMossLoras(graph, loras) {
  if (!loras.length) return graph;
  for (const [target, node] of mossModelInputs(graph)) {
    for (const lora of loras) {
      let id = 'novel-lora-' + target + '-' + lora.id;
      while (Object.hasOwn(graph, id)) id += '-node';
      graph[id] = {
        class_type: 'LoraLoaderModelOnly',
        inputs: { model: node.inputs.model, lora_name: lora.file, strength_model: lora.strength },
      };
      node.inputs.model = [id, 0];
    }
  }
  return graph;
}

export function mossLoraPrompt(prompt, loras) {
  const triggers = loras.flatMap(({ trigger }) =>
    trigger ? trigger.split(',').map((tag) => tag.trim()) : [],
  );
  const unique = [...new Set(triggers.filter(Boolean))];
  return unique.length ? unique.join(', ') + ', ' + prompt : prompt;
}
