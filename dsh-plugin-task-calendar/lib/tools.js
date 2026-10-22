/**
 * Model-facing tools for the task-calendar plugin.
 *
 * These are plain ToolDefinition objects registered directly on `ctx.tools`:
 * the plugin ships as a local package with zero bare imports, so it cannot call
 * `defineTool` from `@deepseek-ai/dsh-tools`. Registering raw means the registry
 * does not pre-validate arguments, so every `execute` validates its own input
 * and throws a Chinese, model-readable error.
 *
 * @module dsh-plugin-task-calendar/tools
 */

import {
  PRIORITIES, STATUSES, projectTask, sortTasks, summarize, taskLine,
} from './model.js'
import { addDays, formatDay, formatMoment } from './dates.js'

/** Every tool declares a text-only canonical value. */
const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render(_args, value) {
    return [{ type: 'text', text: String(value) }]
  },
}

/** Shared schema fragment for one task input. */
const TASK_INPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string', description: '任务标题，一句话说清交付物' },
    start: { type: 'string', description: '开始时间，如 2026-10-12 18:00 / 明天 09:30 / 下周三（可选）' },
    due: { type: 'string', description: '截止时间，如 2026-10-12 18:00 / 2026-10-12 / 周五 17:00（可选）' },
    priority: { type: 'string', enum: PRIORITIES, description: '优先级，默认 normal' },
    status: { type: 'string', enum: STATUSES, description: '状态，默认 todo' },
    owner: { type: 'string', description: '负责人（可选）' },
    notes: { type: 'string', description: '补充说明、验收标准（可选）' },
    tags: { type: 'array', items: { type: 'string' }, description: '标签（可选）' },
  },
  required: ['title'],
}

/** Schema fragment describing where a batch of tasks came from. */
const SOURCE_INPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', description: '来源类型，默认 minutes（会议纪要）' },
    title: { type: 'string', description: '会议/文档标题' },
    date: { type: 'string', description: '会议日期，如 2026-10-09' },
    ref: { type: 'string', description: '文件路径或链接（可选）' },
  },
}

/** Turn a thrown value into the Chinese message the model reads. */
function fail(error) {
  const message = error instanceof Error ? error.message : String(error)
  throw new Error(message)
}

/** Assert the model passed a usable string. */
function requireText(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} 必须是非空字符串`)
  }
  return value.trim()
}

/** Human-readable block for a batch of tasks. */
function taskBlock(tasks, now, heading) {
  const stats = summarize(tasks, now)
  const lines = [
    `${heading}（${formatMoment(now)}）`,
    `共 ${stats.total} 项 · 今天/进行中 ${stats.today} · 逾期 ${stats.overdue} · 已完成 ${stats.done}`,
  ]
  if (tasks.length === 0) lines.push('（没有符合条件的任务）')
  for (const task of sortTasks(tasks, now)) lines.push(`- ${taskLine(task, now)}`)
  return lines.join('\n')
}

/** `range` → `[from, to]` canonical day bounds. */
function rangeBounds(range, now) {
  const today = formatDay(now)
  switch (range) {
    case 'today': return [today, today]
    case 'week': return [today, addDays(today, 7)]
    case 'week-calendar': {
      const weekday = (now.getDay() + 6) % 7
      const monday = addDays(today, -weekday)
      return [monday, addDays(monday, 6)]
    }
    case 'month': {
      const first = `${today.slice(0, 7)}-01`
      const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
      return [first, `${today.slice(0, 7)}-${String(lastDay).padStart(2, '0')}`]
    }
    default: return null
  }
}

/** Does a task fall inside the requested window? */
function inRange(task, range, now) {
  if (range === 'all' || range === undefined) return true
  const bounds = rangeBounds(range, now)
  if (bounds === null) return true
  const day = (task.start ?? task.due ?? '').slice(0, 10)
  if (day === '') return true // unscheduled work stays visible
  return day >= bounds[0] && day <= bounds[1]
}

/**
 * Register the calendar tools.
 * @param ctx - Cordis context carrying the `tools` service.
 * @param store - the plugin's TaskStore.
 * @returns disposers for every registration.
 */
export function registerTools(ctx, store) {
  const disposers = []

  disposers.push(ctx.tools.register({
    name: 'calendar_add_tasks',
    description: [
      '把已经确认的事项写入任务日历（会出现在日历面板中并按开始时间/截止时间提醒）。',
      '典型用法：用户丢来一段会议纪要或聊天记录，你先自己读，把其中"谁要做什么、什么时候之前完成"抽成任务，再调用本工具批量写入 —— 不要反过来让本工具去理解原始纪要。',
      '写之前请做到：① 每条任务一句话说清交付物；② 纪要里的相对时间（"下周三前""本周五""月底"）换算成具体日期填进 due；③ 听到谁负责就填 owner；④ 有验收标准或补充信息填 notes；⑤ 同一场会议的任务用同一个 source 传入，方便回溯来源。',
      '时间格式：2026-10-12 18:00 / 2026-10-12 / 明天 09:30 / 下周三。start 用于"任务开始"提醒，due 用于"还剩 N 天"和"逾期"提醒；只有 date 会当作全天任务。',
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        tasks: { type: 'array', items: TASK_INPUT, description: '要创建的任务列表（至少一条）' },
        source: { ...SOURCE_INPUT, description: '这批任务的来源（如某场会议纪要）' },
      },
      required: ['tasks'],
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const list = args?.tasks
      if (!Array.isArray(list) || list.length === 0) fail(new Error('tasks 必须是非空数组'))
      const now = new Date()
      const source = args?.source === undefined ? null : args.source
      const created = await store.addMany(list.map((task) => ({ ...task, source })), { now })
      return [
        `已创建 ${created.length} 条任务日历：`,
        ...created.map((task) => `- ${taskLine(task, now)}`),
        created.some((task) => task.due === null && task.start === null)
          ? '提示：有任务没有排期，日历里会显示为"未排期"，不会触发到期提醒。'
          : '',
        '提醒规则：到期前 3 天/1 天/2 小时、到点、逾期后每天 09:00 各提醒一次，开始前 30 分钟提醒开始（均可在日历面板里调整）。',
      ].filter((line) => line !== '').join('\n')
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'calendar_list_tasks',
    description: [
      '查看日历里的待办事项，返回每条任务的状态、剩余天数或逾期天数。',
      'range 可选：all（默认，全部未删除任务）、today（今天）、week（今天起 7 天）、week-calendar（本周一至周日）、month（本月）、overdue（只看逾期）、upcoming（今天之后）。',
      'status 可选：todo / doing / done / open（未完成）。query 按标题和备注模糊匹配。',
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        range: { type: 'string', enum: ['all', 'today', 'week', 'week-calendar', 'month', 'overdue', 'upcoming'] },
        status: { type: 'string', enum: [...STATUSES, 'open'] },
        query: { type: 'string', description: '按标题/备注/负责人模糊搜索' },
      },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      await store.load()
      const now = new Date()
      const range = args?.range ?? 'all'
      const status = args?.status
      const query = typeof args?.query === 'string' ? args.query.trim().toLowerCase() : ''
      let tasks = store.snapshot().tasks
      if (range === 'overdue') {
        tasks = tasks.filter((task) => projectTask(task, now).phase === 'overdue')
      } else if (range === 'upcoming') {
        tasks = tasks.filter((task) => {
          const day = (task.start ?? task.due ?? '').slice(0, 10)
          return day !== '' && day > formatDay(now)
        })
      } else {
        tasks = tasks.filter((task) => inRange(task, range, now))
      }
      if (status === 'open') tasks = tasks.filter((task) => task.status !== 'done')
      else if (status !== undefined) tasks = tasks.filter((task) => task.status === status)
      if (query !== '') {
        tasks = tasks.filter((task) => `${task.title} ${task.notes} ${task.owner} ${task.tags.join(' ')}`.toLowerCase().includes(query))
      }
      return taskBlock(tasks, now, `任务日历 · ${range}`)
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'calendar_update_task',
    description: [
      '修改一条任务日历：改标题、改时间、标记完成/进行中、补负责人备注标签。',
      '用 id（list 返回的 [tk_xxx]）精确定位，或者用 match 传标题关键词（仅在唯一匹配时生效）。',
      '把 start/due 传空字符串可以清除该时间；addTags/removeTags 增删标签而不影响其他标签。',
      '把 status 设为 done 即完成任务（会记录完成时间，并停止后续提醒）。',
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: '任务 id' },
        match: { type: 'string', description: '标题关键词（唯一匹配时使用）' },
        title: { type: 'string' },
        start: { type: 'string', description: '新开始时间；空字符串表示清除' },
        due: { type: 'string', description: '新截止时间；空字符串表示清除' },
        status: { type: 'string', enum: STATUSES },
        priority: { type: 'string', enum: PRIORITIES },
        owner: { type: 'string' },
        notes: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' }, description: '整体替换标签' },
        addTags: { type: 'array', items: { type: 'string' } },
        removeTags: { type: 'array', items: { type: 'string' } },
      },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const reference = args?.id ?? args?.match
      if (typeof reference !== 'string' || reference.trim() === '') {
        fail(new Error('需要提供 id 或 match 来定位任务'))
      }
      await store.load()
      const current = store.find(reference)
      if (current === null) fail(new Error(`没有找到唯一匹配的任务：${reference}（先用 calendar_list_tasks 确认 id）`))
      const patch = {}
      for (const key of ['title', 'start', 'due', 'status', 'priority', 'owner', 'notes']) {
        if (args?.[key] !== undefined) patch[key] = args[key]
      }
      if (Array.isArray(args?.addTags) || Array.isArray(args?.removeTags)) {
        const next = new Set(current.tags)
        for (const tag of args?.addTags ?? []) next.add(String(tag))
        for (const tag of args?.removeTags ?? []) next.delete(String(tag))
        patch.tags = [...next]
      } else if (args?.tags !== undefined) {
        patch.tags = args.tags
      }
      if (Object.keys(patch).length === 0) fail(new Error('没有提供任何要修改的字段'))
      const updated = await store.patch(current.id, patch)
      const now = new Date()
      return `已更新：${taskLine(updated, now)}\n（日历面板会自动刷新）`
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'calendar_delete_task',
    description: '删除一条任务日历。用 id（list 返回的 [tk_xxx]）或 match（标题唯一匹配）。删除不可撤销。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string' },
        match: { type: 'string' },
      },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const reference = args?.id ?? args?.match
      if (typeof reference !== 'string' || reference.trim() === '') {
        fail(new Error('需要提供 id 或 match 来定位任务'))
      }
      await store.load()
      const task = store.find(reference)
      if (task === null) fail(new Error(`没有找到唯一匹配的任务：${reference}`))
      await store.remove(task.id)
      return `已删除：[${task.id}] ${task.title}`
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'calendar_reminder_config',
    description: [
      '查看或修改任务日历的提醒规则。不带参数时只返回当前设置。',
      'leadDays：到期前多少天提醒（默认 [3,1]）；leadHours：到期前多少小时提醒（默认 [2]）；',
      'startLeadMinutes：任务开始前多少分钟提醒（默认 30）；overdueDailyHour：逾期后每天几点提醒（默认 9）；',
      'systemNotify：是否同时发系统通知；maxAlerts：一次最多弹出多少条提醒。',
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        leadDays: { type: 'array', items: { type: 'integer' }, description: '到期前提醒的天数列表' },
        leadHours: { type: 'array', items: { type: 'integer' }, description: '到期前提醒的小时列表' },
        startLeadMinutes: { type: 'integer' },
        overdueDailyHour: { type: 'integer' },
        systemNotify: { type: 'boolean' },
        maxAlerts: { type: 'integer' },
      },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const now = new Date()
      const patch = {}
      for (const key of ['leadDays', 'leadHours', 'startLeadMinutes', 'overdueDailyHour', 'systemNotify', 'maxAlerts']) {
        if (args?.[key] !== undefined) patch[key] = args[key]
      }
      const config = Object.keys(patch).length === 0 ? store.config : await store.setConfig(patch)
      return [
        `提醒规则（${formatMoment(now)}）：`,
        `- 到期前 ${config.leadDays.length === 0 ? '不提醒' : `${config.leadDays.join(' 天、')} 天`}${config.leadHours.length === 0 ? '' : `、${config.leadHours.join(' 小时、')} 小时`}`,
        `- 到点提醒：开启`,
        `- 逾期提醒：每天 ${String(config.overdueDailyHour).padStart(2, '0')}:00`,
        `- 开始提醒：开始前 ${config.startLeadMinutes} 分钟`,
        `- 系统通知：${config.systemNotify ? '开启' : '关闭'}`,
        `- 单次最多弹出 ${config.maxAlerts} 条`,
        Object.keys(patch).length > 0 ? '已保存。' : '',
      ].filter((line) => line !== '').join('\n')
    },
  }))

  return disposers
}
