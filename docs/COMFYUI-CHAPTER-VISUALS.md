# NovelHarness 与 ComfyUI 的章节视觉流程

## 对话中生成插图

私人部署可在 NovelHarness 服务主机设置环境变量 `NOVEL_COMFY_CONFIG`，值为下面的配置文件绝对路径。ComfyUI 地址从主机侧访问，模型、节点和 API 格式工作流由部署者配置。公开访客隔离模式不会加载主机生图工具。

```json
{
  "comfy": "http://127.0.0.1:18188",
  "workflow": "illustration.api.json",
  "bindings": {
    "prompt": [["5", "positive"]],
    "seed": [["6", "seed"]]
  }
}
```

`workflow` 相对于配置文件，节点编号和输入名按实际模板填写。`prompt` 必填，`seed` 可选，绑定时每次自动取新种子。可用 `values` 填模板所需的固定参数。模板支持图生图时，可绑定 `reference` 和可选的布尔开关 `useReference`。参考图从当前作品的图集读取，无参考图时沿用模板或 `values` 中的占位图。工作流需有保存图片的输出节点。非 WebP 或超出图集限制的输出通过 FFmpeg 转换，可在 `ffmpeg` 指定路径。

启动服务后，可在书内对话说「把这一幕画成插图，重点画人物的神态和站台的夜光」。候选图会显示在对话并进入本书图集。长任务会先返回排队状态，你可以在对话里请助手继续查询。明确要求插到某段后时，助手可用现有插图工具放置。

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
