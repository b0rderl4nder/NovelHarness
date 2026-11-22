const labels = {
  width: '宽度',
  height: '高度',
  steps: '采样步数',
  cfg: 'CFG',
  denoise: '降噪强度',
  sampler: '采样器',
  scheduler: '调度器',
  shift: '偏移',
  megapixels: '像素规模',
  seed: '种子',
};

async function ask(route, method, body, signal) {
  const response = await fetch('/api/comfy/' + route, {
    method,
    credentials: 'same-origin',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(9000)]) : AbortSignal.timeout(9000),
    ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  if (method === 'GET' && response.status === 404) return { supported: false };
  const result = await response.json().catch(() => null);
  if (!response.ok || !result) throw new Error(result?.error ?? '无法连接生图设置，请稍后重试。');
  return result;
}

export function createComfySettingsPanel(React) {
  const h = React.createElement;
  function Form({ config }) {
    const [comfy, setComfy] = React.useState(config.comfy);
    const [defaultPreset, setDefaultPreset] = React.useState(config.defaultPreset);
    const [reference, setReference] = React.useState(config.defaultReferencePreset);
    const [editing, setEditing] = React.useState(config.defaultPreset);
    const [values, setValues] = React.useState({});
    const [revision, setRevision] = React.useState(config.revision);
    const [busy, setBusy] = React.useState('');
    const [message, setMessage] = React.useState(config.notice ?? '');
    const preset = config.presets.find(({ id }) => id === editing);
    const referencePresets = config.presets.filter((item) => item.reference);
    const currentValue = (id, key, rule) => values[id]?.[key] ?? rule.default;
    const editValue = (key, value) =>
      setValues({ ...values, [editing]: { ...values[editing], [key]: value } });
    async function action(kind) {
      if (busy) return;
      setBusy(kind);
      setMessage('');
      try {
        if (kind === 'check') {
          await ask('check', 'POST', { comfy });
          setMessage('主机可连接 ComfyUI。');
        } else {
          const defaults = Object.fromEntries(
            config.presets.map(({ id, controls }) => [
              id,
              Object.fromEntries(
                Object.entries(controls).map(([key, rule]) => {
                  const value = currentValue(id, key, rule);
                  if (value === '') throw new Error('请填写 ' + (labels[key] ?? key) + '。');
                  return [key, rule.choices ? value : Number(value)];
                }),
              ),
            ]),
          );
          const result = await ask('settings', 'PUT', {
            comfy,
            defaultPreset,
            defaultReferencePreset: reference,
            values: defaults,
            revision,
          });
          setRevision(result.revision);
          setMessage('已保存。新生图任务将使用此设置。');
        }
      } catch (error) {
        setMessage(error.message);
      } finally {
        setBusy('');
      }
    }
    const presetOptions = (list) => list.map(({ id, label }) => h('option', { key: id, value: id }, label));
    const field = (label, input, key = label) => h('label', { key }, h('span', null, label), input);
    const select = (value, update, options) =>
      h('select', { value, onChange: (event) => update(event.target.value) }, ...options);
    return h(
      'form',
      {
        onSubmit: (event) => {
          event.preventDefault();
          void action('save');
        },
      },
      h(
        'fieldset',
        { disabled: !!busy },
        field(
          'ComfyUI 地址',
          select(
            comfy,
            setComfy,
            config.endpoints.map((url) => h('option', { key: url, value: url }, url)),
          ),
        ),
        config.endpoints.length === 1
          ? h('p', { className: 'novel-app-hint' }, '其他 ComfyUI 地址由主机登记。')
          : null,
        field('默认生图预设', select(defaultPreset, setDefaultPreset, presetOptions(config.presets))),
        referencePresets.length
          ? field('默认参考图预设', select(reference, setReference, presetOptions(referencePresets)))
          : null,
        h(
          'details',
          { className: 'novel-comfy-controls' },
          h('summary', null, '工作流参数'),
          field('编辑预设', select(editing, setEditing, presetOptions(config.presets))),
          h(
            'div',
            { className: 'novel-comfy-fields' },
            ...Object.entries(preset.controls).map(([key, rule]) =>
              field(
                labels[key] ?? key,
                rule.choices
                  ? select(
                      currentValue(editing, key, rule),
                      (value) => editValue(key, value),
                      rule.choices.map((value) => h('option', { key: value, value }, value)),
                    )
                  : h('input', {
                      type: 'number',
                      inputMode: 'decimal',
                      required: true,
                      min: rule.min,
                      max: rule.max,
                      step: rule.step ?? 'any',
                      value: currentValue(editing, key, rule),
                      onChange: (event) => editValue(key, event.target.value),
                    }),
                key,
              ),
            ),
          ),
          !Object.keys(preset.controls).length
            ? h('p', { className: 'novel-app-hint' }, '这个预设使用工作流的默认参数。')
            : null,
        ),
        h(
          'div',
          { className: 'novel-comfy-actions' },
          h(
            'button',
            { type: 'button', onClick: () => void action('check') },
            busy === 'check' ? '连接中…' : '测试连接',
          ),
          h('button', { type: 'submit' }, busy === 'save' ? '保存中…' : '保存生图设置'),
        ),
      ),
      message ? h('p', { role: 'status' }, message) : null,
    );
  }
  return function ComfySettings() {
    const [config, setConfig] = React.useState(null);
    const [error, setError] = React.useState('');
    React.useEffect(() => {
      const owner = new AbortController();
      ask('settings', 'GET', null, owner.signal)
        .then((value) => {
          if (!owner.signal.aborted) setConfig(value);
        })
        .catch((reason) => {
          if (!owner.signal.aborted) setError(reason.message);
        });
      return () => owner.abort();
    }, []);
    if (!config?.supported && !error) return null;
    return h(
      'details',
      { className: 'novel-access-details novel-comfy-settings' },
      h('summary', null, '插图生成 · ComfyUI'),
      config?.supported ? h(Form, { config }) : h('p', { role: 'status' }, error),
    );
  };
}
