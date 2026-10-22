/**
 * Companion skill for the meeting-minutes plugin.
 *
 * The plugin already registers model-facing tools; the skill adds the routing
 * and workflow knowledge the model needs to pick those tools proactively when
 * a conversation contains meeting notes or asks for todos/calendar updates.
 *
 * Registered at runtime, so installing the plugin makes the skill appear in the
 * session skill catalog without a separate skill package or user-level file.
 *
 * @module dsh-plugin-meeting-minutes/skill
 */

/** Kebab-case name shown in the session skill catalog. */
export const SKILL_NAME = 'meeting-minutes-workflow'

/** One-line catalog description; this is what the model scans first. */
export const SKILL_DESCRIPTION =
  '把会议文本/录音整理成结构化纪要，并把确认后的待办写入任务日历。涉及会议纪要、转写、腾讯会议导入、待办确认、加日历任务、会议自动入库时使用。'

/** Richer routing hint shown by catalog UIs. */
export const SKILL_WHEN_TO_USE =
  '用户粘贴会议纪要/聊天记录/转写文本、给出录音或视频文件、说“整理会议纪要”“生成待办”“把待办加进日历”“查一下上次会议”“导出纪要”“会议结束自动入库”时使用。用户只是随口提到“开会”但没有纪要或待办需求时不要主动整理。'

/** Full instruction body loaded on demand by the `skill` tool. */
export const SKILL_CONTENT = `# 会议纪要 → 待办 → 日历

这个 skill 让会议纪要和任务日历两个插件配合工作。插件已经注册了工具；本 skill 负责**在正确时机选对工具、遵守确认规则**。

## 工具速查

| 工具 | 用途 |
| :-- | :-- |
| \`meeting_list\` | 列出会议纪要库（可按标题/参会人/正文搜索） |
| \`meeting_get\` | 读一场会议的完整纪要、待办及原始文本 |
| \`meeting_create\` | 新建会议记录，\`transcript\` 放**原文**，不要先总结 |
| \`meeting_transcribe\` | 把本机录音/视频转成文字并新建会议 |
| \`meeting_summarize\` | 用当前默认模型生成/重新生成结构化纪要 |
| \`meeting_push_todos\` | 把**用户确认过**的待办写入任务日历 |
| \`meeting_export\` | 导出独立 HTML / Markdown 纪要文档 |
| \`meeting_auto_ingest\` | 查看/启用/关闭/扫描会议自动入库 |
| \`calendar_list_tasks\` / \`calendar_add_tasks\` / \`calendar_update_task\` / \`calendar_delete_task\` / \`calendar_reminder_config\` | 任务日历的查询与维护 |

如果这些工具不存在，说明插件没装或没启用：提示用户安装 \`@zhangguitao666/meeting-suite\`（一次装两个）或对应的单个 npm 包，不要用文件读写去模拟。

## 先判断场景

1. **用户给了会议文本**（纪要、聊天记录、转写稿）
   → \`meeting_create\`（title 可先留空或让用户给；transcript 必须放原文）→ \`meeting_summarize\`。
2. **用户给了录音/视频文件路径**
   → 确认文件存在 → \`meeting_transcribe\` → \`meeting_summarize\`。
3. **用户问“上次会议/某场会议”**
   → \`meeting_list\` 搜索 → 需要细节时 \`meeting_get\`（includeTranscript 只在需要核对原文时打开）。
4. **用户只要待办，不关心纪要**
   → 先定位会议（\`meeting_list\`/\`meeting_get\`）；没有会议记录时，把用户给的内容用 \`meeting_create\` 存下来再总结，不要凭空手写待办。
5. **用户要把待办加到日历**
   → 先展示待办清单，等用户确认；确认后 \`meeting_push_todos\`。只有一两个待办要手动建时，才用 \`calendar_add_tasks\`。
6. **用户问日历任务/提醒**
   → \`calendar_list_tasks\`；改期/完成用 \`calendar_update_task\`；提醒规则用 \`calendar_reminder_config\`。
7. **用户要导出/分享纪要**
   → \`meeting_export\`（format=html 或 md），把返回的文件路径给用户。
8. **用户问“会议结束自动整理”**
   → \`meeting_auto_ingest\` action=status 看状态；需要时 enable/scan；说明它监控的是本机腾讯会议录制，不是云端智能纪要。

## 待办确认规则（最重要）

- **绝不自动写入日历。** 生成纪要后，先把待办以编号列表展示给用户，问“哪些写入日历？”。
- 用户明确说“都写/第 1、3 条写/按这个来”后，再调 \`meeting_push_todos\`；\`todoIds\` 只传用户确认的编号。
- 用户改负责人/截止时间/优先级时，先更新纪要里的待办（重新 summarize 或让用户确认修改），再推送。
- 相对时间（“下周三前”“月底”“明天下午”）必须换算成具体日期再推送；不确定时反问，不要猜。
- 已写入的待办重复调用不会重复创建；但仍应避免无意义重推。

## 纪要质量规则

- \`meeting_create\` 的 \`transcript\` 必须是原文；总结交给 \`meeting_summarize\`，不要把总结当原文存。
- 标题：用户没给标题时可以先用默认/临时标题；\`meeting_summarize\` 会在标题过于通用时自动生成更合适的标题。之后用户可随时改。
- \`meeting_summarize\` 输出一句话结论、要点、决策、风险、分节纪要、待办（含负责人/截止/优先级）；重新生成不会破坏已写入日历的待办关联。
- 参会人能从原文识别就填；识别不出就留空，不要编造。
- 会议日期不明确时问用户，不要默认今天。

## 回答风格

- 中文回答；先给结论，再给待办清单。
- 展示待办时用编号 + 负责人 + 截止时间 + 优先级；没有的信息标“待确认”。
- 推送完成后告诉用户写了几条、日历里怎么查看/改期。
- 纪要很长时，聊天里只给摘要和待办，完整内容用 \`meeting_export\` 导出。

## 反模式

- ❌ 用户贴了会议文本，只口头总结，不落 \`meeting_create\`。
- ❌ 未经确认直接 \`meeting_push_todos\`。
- ❌ 用 \`write\` 直接改 \`~/.dsh/storages/*.json\` 绕过插件。
- ❌ 把“下周三”原样写进日历。
- ❌ 没装插件却假装有工具；先检查工具是否可用。
- ❌ 为了“省事”跳过 \`meeting_summarize\`，自己写一份纪要存进去。

## 典型对话

用户：“这是今天的会议记录：…… 帮我整理，待办加到日历。”
→ \`meeting_create\`（原文）→ \`meeting_summarize\` → 展示纪要和待办 → 问“这 4 条都写入日历吗？” → 用户确认 → \`meeting_push_todos\` → 汇报写入结果。

用户：“把上周产品会的待办都加到日历。”
→ \`meeting_list\` 搜索“产品会” → 必要时 \`meeting_get\` → 展示待办 → 确认后 \`meeting_push_todos\`。

用户：“这个录音帮我转成纪要。”
→ 确认文件路径存在 → \`meeting_transcribe\` → \`meeting_summarize\` → 展示结果。
`

/**
 * Register the companion skill when the host composition exposes the skills
 * service. Registration is an effect, so reloading/disabling the plugin removes
 * the catalog entry again.
 *
 * @param ctx - host Cordis context.
 * @returns the disposer when registered, otherwise undefined.
 */
export function registerMeetingSkill(ctx) {
  const skills = ctx.get?.('skills')
  if (!skills?.register) return undefined
  return skills.register({
    name: SKILL_NAME,
    description: SKILL_DESCRIPTION,
    whenToUse: SKILL_WHEN_TO_USE,
    source: 'bundled',
    content: SKILL_CONTENT,
  })
}
