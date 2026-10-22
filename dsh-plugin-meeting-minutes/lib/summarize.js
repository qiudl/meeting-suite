/**
 * LLM-backed meeting summarizer.
 *
 * The plugin never re-implements a model client: it resolves the current
 * default route from `agentDefaultModel`, prepares one call through `ctx.llm`,
 * and converts the streamed text into the canonical summary shape from
 * `model.js`. A malformed reply gets one repair attempt; both attempts failing
 * raises a Chinese, user-readable error.
 *
 * @module dsh-plugin-meeting-minutes/summarize
 */

import { normalizeSummary, parseSummaryJson } from './model.js'

/** Maximum characters of transcript sent to the model in one request. */
const MAX_TRANSCRIPT_CHARS = 140_000
/** Head/tail split when the transcript exceeds the cap. */
const HEAD_CHARS = 105_000
const TAIL_CHARS = 34_000
/** Hard deadline for one summary attempt. */
const CALL_TIMEOUT_MS = 180_000
/** Output-token cap for one summary attempt. */
const MAX_TOKENS = 8192

/** System instruction: role, output contract, and grounding rules. */
export const SYSTEM_PROMPT = [
  '你是一位专业的中文会议纪要助理。你会读到一场会议的标题、日期、参会人和完整转写/纪要文本。',
  '你的任务是把内容整理成结构化的会议纪要 JSON，供后续渲染成可视化文档并抽取待办。',
  '',
  '硬性要求：',
  '1. 只输出一个 JSON 对象，不要输出 Markdown 代码围栏、解释、前言或后记。',
  '2. 严格使用下面给出的字段名和类型，不要增删字段、不要改字段名。',
  '3. 只依据提供的文本，不要编造事实、人名、数字或日期；文本没提到的信息留空字符串或空数组。',
  '4. 待办只提取“有明确交付物 + 有负责人或明确截止时间”的行动项；泛泛而谈的“加强沟通”不算待办。',
  '5. 相对时间（“下周三”“本周五前”“月底”）必须换算成具体日期：日期用 YYYY-MM-DD，带时刻用 YYYY-MM-DD HH:mm；无法确定就留空字符串。',
  '6. 使用参会文本本身的语言；中文会议就用中文。',
  '7. oneLine 不超过 60 个汉字；overview 不超过 300 个汉字；keyPoints 3-8 条；sections 按议题分节，每节 2-8 条要点。',
  '8. suggestedTitle 用 8-20 个汉字概括会议主题（例如“Q4预算评审与投放排期”），不要用“会议纪要”“讨论”等空泛词。',
  '',
  '输出 JSON 形状：',
  '{',
  '  "suggestedTitle": "为这场会议起一个 8-20 字的标题，概括主题，不要写“会议纪要”“讨论”这类空话",',
  '  "oneLine": "一句话结论",',
  '  "overview": "整体概述",',
  '  "keyPoints": ["关键要点"],',
  '  "decisions": [{"text": "已决定的事项", "owner": "负责人或空"}],',
  '  "risks": [{"text": "风险或待确认事项", "level": "low|medium|high"}],',
  '  "sections": [{"heading": "议题标题", "bullets": ["该议题下的要点"]}],',
  '  "attendees": ["从文本中能确认的参会人"],',
  '  "todos": [{"title": "交付物", "owner": "负责人或空", "due": "截止时间或空", "priority": "high|normal|low", "notes": "验收标准或补充信息"}]',
  '}',
].join('\n')

/** Keep a long transcript under the request budget without losing the ending. */
export function clampTranscript(text, limit = MAX_TRANSCRIPT_CHARS) {
  const value = typeof text === 'string' ? text : ''
  if (value.length <= limit) return value
  const head = value.slice(0, HEAD_CHARS)
  const tail = value.slice(-TAIL_CHARS)
  return `${head}\n\n[……中间省略 ${value.length - HEAD_CHARS - TAIL_CHARS} 字……]\n\n${tail}`
}

/** User message: meeting metadata plus the transcript. */
export function buildUserPrompt(meeting) {
  const lines = [
    `会议标题：${meeting.title}`,
    `会议日期：${meeting.date}`,
    `参会人：${meeting.attendees.length > 0 ? meeting.attendees.join('、') : '（未提供）'}`,
    meeting.notes === '' ? '' : `补充说明：${meeting.notes}`,
    '',
    '会议文本如下（可能是转写稿或腾讯会议纪要原文）：',
    '----- 会议文本开始 -----',
    clampTranscript(meeting.transcript),
    '----- 会议文本结束 -----',
  ].filter((line) => line !== '')
  return lines.join('\n')
}

/** Repair prompt used when the first reply is not a parseable JSON object. */
export function buildRepairPrompt(previousText, meeting) {
  const excerpt = typeof previousText === 'string' ? previousText.slice(0, 6000) : ''
  return [
    buildUserPrompt(meeting),
    '',
    '你上一次的输出无法被解析为 JSON。上一次输出如下（可能被截断）：',
    '----- 上一次输出开始 -----',
    excerpt,
    '----- 上一次输出结束 -----',
    '',
    '请重新输出：只输出一个 JSON 对象，字段与类型必须完全符合要求，不要代码围栏或任何解释。',
  ].join('\n')
}

/** One assistant reply assembled from the streamed chunks. */
async function collectStream(stream) {
  let text = ''
  let finish = null
  for await (const chunk of stream) {
    if (chunk?.type === 'text-delta') text += chunk.text
    else if (chunk?.type === 'finish') finish = chunk.reason ?? null
  }
  if (finish !== null && finish.kind === 'error') {
    throw new Error(`总结失败：${finish.failure?.message ?? '模型返回错误'}`)
  }
  if (finish !== null && finish.kind === 'aborted') {
    throw new Error(`总结已取消：${finish.failure?.message ?? '调用被中断'}`)
  }
  return { text, finish }
}

/** Resolve the model route: explicit options, then the agent default model. */
export function resolveRoute(ctx, options = {}) {
  const selection = options.selection ?? ctx.get?.('agentDefaultModel')?.currentSelection?.()
  if (selection === null || selection === undefined || typeof selection.provider !== 'string' || typeof selection.model !== 'string') {
    throw new Error('没有可用的默认模型：请先在模型设置里选择一个模型，再生成会议纪要。')
  }
  return { provider: selection.provider, model: selection.model, reasoningEffort: selection.reasoningEffort }
}

/**
 * Create the summarizer.
 * @param options - `ctx` (host Cordis context), `logger` (optional).
 */
export function createSummarizer(options) {
  const ctx = options.ctx
  const logger = options.logger

  /**
   * Run one model call and return the raw text.
   * @param messages - request messages.
   * @param system - system instruction.
   */
  async function callModel(messages, system, signal) {
    const llm = ctx.get?.('llm')
    if (llm === undefined || llm === null) {
      throw new Error('本机没有可用的模型服务（llm），无法生成会议纪要。')
    }
    const route = resolveRoute(ctx, {})
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('总结超时')), CALL_TIMEOUT_MS)
    const onAbort = () => controller.abort(signal.reason)
    if (signal !== undefined) {
      if (signal.aborted) controller.abort(signal.reason)
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    try {
      let call
      try {
        call = await llm.prepareCall({
          provider: route.provider,
          model: route.model,
          maxTokens: MAX_TOKENS,
        }, controller.signal)
      } catch (error) {
        // Some routes cap output tokens below this request; retry once with the
        // adapter's own default cap instead of failing the whole summary.
        if (!/max.?tokens|output/i.test(String(error?.message ?? ''))) throw error
        call = await llm.prepareCall({ provider: route.provider, model: route.model }, controller.signal)
      }
      const streamOptions = {
        ...call.config,
        messages,
        system,
        signal: controller.signal,
      }
      const { text } = await collectStream(call.stream(streamOptions))
      return { text, route }
    } finally {
      clearTimeout(timer)
      if (signal !== undefined) signal.removeEventListener('abort', onAbort)
    }
  }

  /**
   * Summarize one meeting.
   * @param meeting - canonical meeting with non-empty transcript.
   * @param options - `signal` (AbortSignal).
   * @returns canonical summary.
   */
  async function summarize(meeting, options = {}) {
    if (typeof meeting?.transcript !== 'string' || meeting.transcript.trim() === '') {
      throw new Error('这场会议还没有文本内容：请先录音转写，或导入腾讯会议纪要文本。')
    }
    const signal = options.signal
    const messages = [{ role: 'user', content: [{ type: 'text', text: buildUserPrompt(meeting) }] }]
    const first = await callModel(messages, SYSTEM_PROMPT, signal)
    const parsed = parseSummaryJson(first.text)
    if (parsed !== null) {
      return normalizeSummary(parsed, {
        previous: meeting.summary,
        now: new Date(),
        model: `${first.route.provider}/${first.route.model}`,
      })
    }
    logger?.warn?.('meeting-minutes: first summary reply was not JSON, retrying once')
    const repairMessages = [{
      role: 'user',
      content: [{ type: 'text', text: buildRepairPrompt(first.text, meeting) }],
    }]
    const second = await callModel(repairMessages, SYSTEM_PROMPT, signal)
    const repaired = parseSummaryJson(second.text)
    if (repaired === null) {
      throw new Error('模型返回的纪要格式无法解析，请重试一次；若持续失败，可换一个模型再生成。')
    }
    return normalizeSummary(repaired, {
      previous: meeting.summary,
      now: new Date(),
      model: `${second.route.provider}/${second.route.model}`,
    })
  }

  /** Current model route label for the panel footer. */
  function describeRoute() {
    try {
      const route = resolveRoute(ctx, {})
      return { provider: route.provider, model: route.model }
    } catch {
      return { provider: null, model: null }
    }
  }

  return { summarize, describeRoute }
}
