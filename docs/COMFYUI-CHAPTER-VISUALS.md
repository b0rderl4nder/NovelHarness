# NovelHarness 与 ComfyUI 的章节视觉流程

## 对话中生成插图

私人部署可在 NovelHarness 服务主机设置环境变量 `NOVEL_COMFY_CONFIG`，值为下面的配置文件绝对路径。ComfyUI 地址从主机侧访问，模型、节点和 API 格式工作流由部署者配置。公开访客隔离模式不会加载主机生图工具。

登录后，从侧栏进入 **数据与访问 → 插图生成 · ComfyUI**。这里可测试连接，选择默认文生图和参考图预设，并在「工作流参数」下修改预设已开放的尺寸、采样步数、采样器、CFG 等默认值。保存后用于新任务。主机配置可用 `allowedComfyEndpoints` 登记其他 ComfyUI 地址，网页从已登记的地址中切换。添加模型、工作流或新节点绑定仍在主机的 JSON 文件中完成。

聊天会在插图任务运行时显示队列或当前采样步骤。支持运行中预览的 ComfyUI 工作流会同时发来临时小图。成图存入图集后就在聊天里显示，回合结束、工具详情折叠后仍能查看。浏览器通过 NovelHarness 读取进度和图片，由主机连接 ComfyUI。 [ComfyUI WebSocket 接口](https://docs.comfy.org/development/comfyui-server/comms_routes)

有具名角色首次出图时，助手会把人设候选直接发在对话里。点「候选 A / B / C」切换，点大图看细节，然后点「设为定妆」。同一本书里换画风仍使用已选图，改选时用「更换定妆」。等待选图期间可继续写正文。

```json
{
  "comfy": "http://127.0.0.1:18188",
  "workflow": "illustration.api.json",
  "bindings": {
    "prompt": [["5", "positive"]],
    "seed": [["6", "seed"]],
    "negativePrompt": [["5", "negative"]],
    "steps": [["6", "steps"]],
    "sampler": [["6", "sampler_name"]]
  },
  "controls": {
    "steps": { "min": 16, "max": 42, "step": 1 },
    "sampler": { "choices": ["euler", "er_sde"] }
  }
}
```

`workflow` 相对于配置文件，节点编号和输入名按实际模板填写。`prompt` 必填，`seed` 可选，助手省略种子时自动取新值。可用 `values` 填模板所需的固定参数。模板支持图生图时，可绑定 `reference` 和可选的布尔开关 `useReference`。需要参考图才能运行的工作流设置 `requiresReference: true`；可选参考图的工作流可在 `values` 指定占位图。工作流需有保存图片的输出节点。非 WebP 或超出图集限制的输出通过 FFmpeg 转换，可在 `ffmpeg` 指定路径。

启动服务后，在书内和助手对话即可。可以直接说「把这一幕画成插图」，也可以在原对话用加号上传图片，再说「看一下这张图，把屋顶换成钴蓝色，保留构图」。助手选择工作流、撰写提示词并发起任务。生成时可以继续浏览书稿，完成后图片显示在对话并进入本书图集。超过工具等待时间的任务会返回任务号，可在对话里请助手继续查询。明确要求插到某段后时，助手可用现有插图工具放置。

写带插图的章节时，助手可以在 `novel_proposal_submit` 的最终提交中用 `illustrations` 把章文和已有图集图片一次保存。每项填写 `imagePath` 和正文中的唯一定位 `after`。本轮章节交付前，同一场景的重画调用会返回已生成的图片和保存步骤。章节和首版插图入书后，助手可以继续审图、重画和更换。

### 在对话里换工作流和画面

主机可在同一配置写入 `defaultPreset` 和 `presets`。将上方每套工作流的 `workflow`、`bindings`、`values` 放进 `presets` 的对应项，`comfy` 仍在外层。每项可设 `label`。原单工作流配置会显示为 `default`。传了参考图但未指定工作流时，工具会选择支持参考图的默认工作流，也可以用 `defaultReferencePreset` 明确指定。助手可通过 `presets` 查看实际能力。

- 正向 `prompt` 由对话助手撰写。服务按助手选择的 `style`、`composition`、`atmosphere` 和 `regions` 绘图参数转换格式。工作流绑定 `negativePrompt` 后，助手可以另填 `negative_prompt`。旧配置的 `promptPrefix` 不会加入新任务。
- 预设可用 `guidance` 提供对应模型的措辞和构图建议，由 `presets` 返回给助手。正向提示词仍由助手按当次要求编写。
- 在 `bindings` 映射实际节点，再用 `controls` 声明助手可用的范围和枚举。步数、CFG、采样器、调度器、尺寸、降噪和 LoRA 强度都可按工作流开放。助手通过预设列表看到范围与默认值；未指定时用工作流或 `values` 的默认值。更换模型通常要选对应工作流。
- 图生图工作流同时开放带 `step` 的 `width` 和 `height` 时，默认在允许范围内沿用参考图的比例。助手仍可明确设置尺寸，未指定的另一边会尽量维持参考图比例。
- MOSS 版式预设设置 `layout: [宽, 高]`，与实际工作流尺寸一致。`regions` 用 `[左, 上, 右, 下]` 的 0–1000 相对坐标标注人、物和文字。文字框另给逐字文本。服务会换算为 MOSS 的中心像素坐标。
- `reference` 可填 `chat:latest`、`references` 返回的当前对话图片 ID，或本书图集路径。它提供一张单独的场景参考图，需要有对应输入的 ComfyUI 工作流。助手理解画面还需要当前 DSH 模型支持视觉输入，可用 `inspect` 查看图集图片并分析成图。
- `character_sheet` 为一个角色生成三张候选，每张为面部近照及正、侧、背全身图。作者确认后，`generate` 随 `characters` 列出的名字自动传该角色的图集参考图。换画风仍读取同一次定妆，角色关系和正文保存在原有位置。作者要求探索新一批样式时可设 `new_variants`，原定妆会保留到作者再次选择。
- 单角色可沿用图生图工作流的 `reference`。多角色工作流可按作者提供的出场顺序绑定 `characterReference1` 到 `characterReference4`，可用相应的 `useCharacterReference1` 等开关。当前图生图预设未提供足够独立输入时，助手会收到需要兼容工作流的状态。
- 固定 `seed` 可在相同工作流和输入下复查。查询结果会带实际预设和种子。暂未完成的任务需要原预设才能继续取图。

### 高质量二次元人物

私人 ComfyUI 主机可直接使用 [Anima 配置](../cloud/shared/workflows/anima-quality.json)，也可将它的 `presets.anima` 合并进自己的配置并相应填写 `workflow` 路径。默认原生画幅 `1024×1344`，Anima Base v1、`er_sde`、32 步、CFG 4.5，保存 WebP 质量 94。也可在对话中指定横向、全身、镜头与画风。工作流需要 Anima Base、Qwen 0.6B 文本编码器和 Qwen Image VAE。模型权重由部署者按原许可安装。 [Anima 模型说明](https://huggingface.co/circlestone-labs/Anima) · [ComfyUI 示例](https://docs.comfy.org/tutorials/image/anima/anima)

符合图集限制的 WebP 原样保存。图集单边支持 2048 像素，单个插图文件上限 480 KiB；超过限制时，先尝试保持像素尺寸重编码，再逐步缩小。实际生成分辨率由工作流决定。

## 命令行批量生成

命令行流程适合逐页画漫画或需要留存原图的任务。每次任务在本地保存章节版本、API 任务 ID、渲染参数和原图。

## 一次配置，按页改提示词与种子

在 ComfyUI 保存一份 **API 格式**工作流，把该文件和任务配置放在同一个本地目录。用 `GET /api/novels/<书 ID>/documents` 查章节和资料路径。通过环境变量 `NOVELHARNESS_SESSION_COOKIE` 提供已登录的 NovelHarness 会话 Cookie。这个值只用于访问你指定的 NovelHarness 服务，建议不要把它写入配置、日志或提交记录。渲染步骤只把你通过模板绑定选择的资料和参考图发往配置中的 ComfyUI。

下面是 MOSS 示例。模板来自已能跑通的漫画工作流时，节点编号对应括号内的输入。自己的模板要按 API JSON 中的节点编号和输入名填写。每个参数可以同时填写多个节点输入，格式为 `[[节点编号, 输入名], ...]`。

```json
{
  "novel": "http://127.0.0.1:3210",
  "comfy": "http://127.0.0.1:18188",
  "book": "b-00000000000000000000000000000000",
  "chapter": "chapters/1.md",
  "materials": ["setting.md", "canon.json", "outline.json"],
  "workflow": "moss.api.json",
  "output": "visual-output",
  "bindings": {
    "prompt": [["5", "positive"]],
    "seed": [["6", "seed"]],
    "lora": [["12", "lora_name"]],
    "reference": [["4", "image"]],
    "useReference": [["10", "value"]]
  },
  "values": {
    "lora": "fkey-lora-r4-muon-step6840-comfy.safetensors",
    "reference": "example.png",
    "useReference": false
  },
  "pages": [
    {
      "textFiles": { "prompt": "01.prompt.txt" },
      "values": { "seed": 72461201 }
    },
    {
      "textFiles": { "prompt": "02.prompt.txt" },
      "values": { "seed": 72461202 }
    }
  ],
  "publish": [
    { "file": "01-1.png", "label": "漫画 · 第一页" },
    { "file": "02-1.png", "label": "漫画 · 第二页" }
  ],
  "after": "这里填选定段落的一句原文。"
}
```

- 画漫画时，每页的 TXT 可以放 MOSS 分镜 JSON、角色表和对白。画单张插画时，留一项 `pages`，使用适合该模型的成图描述。
- 画风由模板、底模、LoRA 和提示词决定。用同一模板时可以在本页 `values` 覆盖已绑定的底模、LoRA、强度、画幅等参数。换模型家族时，改用它自己的 API 工作流并重新映射输入。服务器需要安装该工作流使用的节点与权重。
- 参考图用本页 `references` 指定。例如 `"references": {"reference": "角色母图.webp"}`。也可填本书图集返回的 `illustrations/<摘要>.json`。模板有参考图开关时，同时改本页 `values.useReference`。模板支持多参考图时，每个参考节点分配一个绑定。
- 想把书内文档直接传给支持文本上下文的节点时，用本页 `textSources` 显式选择。例如 `"textSources": {"sceneContext": "setting.md"}`。该字段必须出现在 bindings 中，资料也必须已提取。普通扩散模型的正向输入通常适合整理过的分镜或成图描述。

## 从章节到入库

在仓库根目录执行。所有配置中引用的文件路径，相对于任务 JSON 所在目录。

```powershell
node cloud/scripts/novel-comfy.mjs context C:/art/task.json
node cloud/scripts/novel-comfy.mjs submit C:/art/task.json
node cloud/scripts/novel-comfy.mjs collect C:/art/task.json
node cloud/scripts/novel-comfy.mjs publish C:/art/task.json
```

1. `context` 保存原文、当前版本和选定资料的快照。根据快照写分镜或插画提示词。
2. `submit` 向 ComfyUI 提交每页 API 图谱并保存任务 ID。收到一个不确定的提交结果时，先用 ComfyUI 队列和历史查证。该页有 `job-N.pending.json` 而无任务回执时，命令会保留这个状态，防止误重复生成。更换参数重新出候选时，使用新的 `output` 并提取新快照。
3. `collect` 拉取已经完成的原图。仍在队列的页会列在 `waiting`。可重复运行，已存在且内容不同的文件会保留并报告冲突。
4. 检查原图，在 `publish` 里按阅读顺序挑选成图。已有合规 WebP 可直接提交。其他格式需要 FFmpeg 和 libwebp，`ffmpeg` 可填可执行文件绝对路径。原图留在本地，章节使用符合本书图集尺寸与体积要求的 WebP。
5. `publish` 将图片存入本书图集。填了 `after` 时，它以原章节版本做一次提交，将所选图按序放在相应段落后；并发改稿时会报告冲突，已上传的图仍在本书图集中。省略 `after` 时只归档到图集，可在网页用现有插图入口挑选放置。

ComfyUI 使用服务器提供的排队、回执、图片上传与读取接口。[ComfyUI Server Routes](https://docs.comfy.org/development/comfyui-server/comms_routes)
