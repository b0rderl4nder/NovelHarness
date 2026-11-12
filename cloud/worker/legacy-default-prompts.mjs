// Author-editable defaults; the export name preserves V4 import compatibility.
// Frozen tasks and author overrides are unchanged. Material paths/ranges live
// in the existing task context; schemas and save semantics live in tool rules.
export const LEGACY_DEFAULT_PROMPTS = Object.freeze({
  outline:
    '作品：{title}｜{genre}；全书目标：{chapterCount} 章。\n按作者要求读取相关资料，规划当前任务范围。方向未定且未要求直接写或由你决定时，用 ask_user_question 给 2–4 个具体方向，允许自由填写、组合或否定；不重复问已明确的事，不将未回答视为同意。\n首批先定全篇方向，再展开本批章纲；已有方向时沿用。写清事件、衔接和重要变化，不固定概要长度或剧情点数量。按工具协议保存本次规划；作者也要求正文时，规划保存后继续写。',
  write:
    '作品：{title}｜{genre}\n第 {chapterNumber} 章：{chapterTitle}\n章纲：{chapterSummary}\n剧情点：{plotPoints}\n章内要求：{note}\n全书备注：{novelNote}\n最低字数与范围：{wordCount}；{mode}\n\n' +
    '**先写好完整的故事，再安排少数重点内容。** 用大部分篇幅搭好故事的前因后果、氛围和节奏，让指定的主题、桥段或卖点在合适的位置自然出现。到了关键处集中笔墨写足，其余部分按故事本身的需要展开。即使本次只强调某一个看点，也保留铺垫、过渡和余波各自的作用。',
  deai: '按作者要求修改指定范围，保留本书语言、人物声音及未要求改变的情节与事实。\n优先修正指代、因果、应答与动作衔接；把宣读人设、重复空转和含混表达改为可信的交谈与叙述。可重组句段，保留有作用的短答、沉默和心理，不逐句解释台词，不把润色变成梗概；不凭单个词或修辞判错，不臆造设定圆场。\n保留原文信息与展开，不以压缩字数为目标。只交付修改后的正文，局部修改不扩成整章，按工具协议保存。',
  ending:
    '根据作者要求承接当前情节、人物与语言，完成本章收束或结束故事。停顿、过渡、揭示、解决冲突均可，不强制悬念或突然反转人物立场。\n字数只作下限，不设上限；范围服从作者，只交付所需正文，按工具协议保存。',
  outlineContinue:
    '作品：{title}｜{genre}；全书目标：{chapterCount} 章。\n本次补充第 {startChapter}–{endChapter} 章，共 {missingChapterCount} 章。\n沿用既有全篇方向，按需读取相关资料和已写正文，保持范围外章纲与正文不变，写清本批事件、重要变化和前后衔接。不固定概要长度或剧情点数量。只补本批章纲，按工具协议保存。',
});
