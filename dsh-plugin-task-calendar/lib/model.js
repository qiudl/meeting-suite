/**
 * Task model, countdown projection, and reminder engine for the task-calendar
 * plugin. Everything here is pure: no filesystem, no Cordis, no clock reads
 * other than the explicit `now` argument, so the whole module is unit-testable
 * under plain Node.
 *
 * @module dsh-plugin-task-calendar/model
 */

import {
  addDays, addMinutes, dayOf, daysBetween, formatDay, formatMoment, hasTime,
  humanMoment, normalizeDate, parseLocal, timeOf,
} from './dates.js'

/** Stable status vocabulary. */
export const STATUSES = ['todo', 'doing', 'done']
/** Stable priority vocabulary, most urgent first. */
export const PRIORITIES = ['high', 'normal', 'low']

/** Reminder policy defaults, overridable through the client panel. */
export const DEFAULT_CONFIG = {
  /** Calendar days before the due date that raise a reminder. */
  leadDays: [3, 1],
  /** Hours before the due time that raise a reminder. */
  leadHours: [2],
  /** Minutes before a task's start time that raise a "starting soon" reminder. */
  startLeadMinutes: 30,
  /** Hour of day (local) for the daily overdue reminder. */
  overdueDailyHour: 9,
  /** Upper bound on pending alerts returned to the client. */
  maxAlerts: 6,
  /** Whether the browser half asks for a system notification as well. */
  systemNotify: true,
}

/** Clamp and repair a stored/partial config into a complete one. */
export function normalizeConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const numbers = (value, fallback, min, max) => {
    const list = Array.isArray(value) ? value : fallback
    const cleaned = list
      .map((entry) => Number(entry))
      .filter((entry) => Number.isFinite(entry) && entry >= min && entry <= max)
    return [...new Set(cleaned)].sort((a, b) => a - b)
  }
  return {
    leadDays: numbers(input.leadDays, DEFAULT_CONFIG.leadDays, 0, 365),
    leadHours: numbers(input.leadHours, DEFAULT_CONFIG.leadHours, 0, 720),
    startLeadMinutes: Number.isFinite(Number(input.startLeadMinutes))
      ? Math.max(0, Math.min(10_080, Number(input.startLeadMinutes)))
      : DEFAULT_CONFIG.startLeadMinutes,
    overdueDailyHour: Number.isFinite(Number(input.overdueDailyHour))
      ? Math.max(0, Math.min(23, Math.trunc(Number(input.overdueDailyHour))))
      : DEFAULT_CONFIG.overdueDailyHour,
    maxAlerts: Number.isFinite(Number(input.maxAlerts))
      ? Math.max(1, Math.min(50, Math.trunc(Number(input.maxAlerts))))
      : DEFAULT_CONFIG.maxAlerts,
    systemNotify: input.systemNotify === undefined ? DEFAULT_CONFIG.systemNotify : input.systemNotify !== false,
  }
}

/** Short, collision-resistant id. */
export function newId(prefix = 'tk') {
  const stamp = Date.now().toString(36)
  const random = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${stamp}${random}`
}

/** Trim a value into a string, or return the fallback. */
function asText(value, fallback = '') {
  if (value === undefined || value === null) return fallback
  const text = String(value).trim()
  return text === '' ? fallback : text
}

/** Normalize a tag list: trimmed, non-empty, de-duplicated, order preserved. */
export function normalizeTags(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const tags = []
  for (const entry of value) {
    const tag = asText(entry)
    if (tag === '' || seen.has(tag)) continue
    seen.add(tag)
    tags.push(tag)
  }
  return tags
}

/**
 * Normalize one raw task input (model tool arguments, HTTP body, or stored
 * record) into the canonical stored shape.
 * @param raw - partial task.
 * @param options - `now` (Date), `base` (existing record to patch onto).
 * @returns canonical task, or throws when the title is missing.
 */
export function normalizeTask(raw, options = {}) {
  const now = options.now ?? new Date()
  const base = options.base ?? {}
  const input = raw !== null && typeof raw === 'object' ? raw : {}

  const title = asText(input.title, asText(base.title))
  if (title === '') throw new Error('task.title is required (non-empty string)')

  const status = STATUSES.includes(input.status) ? input.status : (base.status ?? 'todo')
  const priority = PRIORITIES.includes(input.priority) ? input.priority : (base.priority ?? 'normal')

  const pickDate = (key, fallback) => {
    if (input[key] === undefined) return fallback
    if (input[key] === null || input[key] === '') return null
    const parsed = normalizeDate(input[key])
    if (parsed === null) throw new Error(`task.${key} is not a recognizable date: ${JSON.stringify(input[key])}`)
    return parsed
  }

  const start = pickDate('start', base.start ?? null)
  const due = pickDate('due', base.due ?? null)
  // All-day is derived from the dates unless the caller pins it explicitly.
  const allDay = input.allDay === true ? true : (input.allDay === false ? false : !(hasTime(start) || hasTime(due)))

  const sourceInput = input.source === undefined ? base.source ?? null : input.source
  let source = null
  if (sourceInput !== null && typeof sourceInput === 'object') {
    source = {
      kind: asText(sourceInput.kind, 'minutes'),
      title: asText(sourceInput.title, ''),
      date: normalizeDate(sourceInput.date) === null ? asText(sourceInput.date, '') : asText(sourceInput.date, ''),
      ref: asText(sourceInput.ref, ''),
    }
  }

  const completedAt = status === 'done'
    ? (base.status === 'done' && base.completedAt !== undefined ? base.completedAt : formatMoment(now))
    : null

  return {
    id: asText(input.id, asText(base.id, newId())),
    title,
    status,
    priority,
    start,
    due,
    allDay,
    owner: input.owner === undefined ? (base.owner ?? '') : asText(input.owner, ''),
    notes: input.notes === undefined ? (base.notes ?? '') : asText(input.notes, ''),
    tags: input.tags === undefined ? (base.tags ?? []) : normalizeTags(input.tags),
    source,
    createdAt: base.createdAt ?? formatMoment(now),
    updatedAt: formatMoment(now),
    completedAt,
    fired: input.fired === undefined ? (base.fired ?? []) : (Array.isArray(input.fired) ? input.fired.map(String) : []),
  }
}

/**
 * Project a task into its user-facing schedule state at `now`.
 * @param task - canonical task.
 * @param now - reference moment.
 * @returns `{ phase, days, severity, text, detail }` where phase is one of
 * `done | overdue | today | tomorrow | upcoming | running | pending`.
 */
export function projectTask(task, now = new Date()) {
  const today = formatDay(now)
  const nowIso = formatMoment(now)
  if (task.status === 'done') {
    return { phase: 'done', days: null, severity: 'idle', text: '已完成', detail: task.completedAt ?? '' }
  }

  if (task.due !== null) {
    const days = daysBetween(today, task.due)
    const dueText = humanMoment(task.due, now)
    if (days < 0) {
      return { phase: 'overdue', days, severity: 'error', text: `逾期 ${-days} 天`, detail: `应于 ${dueText} 完成` }
    }
    if (days === 0) {
      const overdueByTime = task.due <= nowIso && hasTime(task.due)
      return {
        phase: overdueByTime ? 'overdue' : 'today',
        days: 0,
        severity: 'warn',
        text: overdueByTime ? '已到期' : '今天到期',
        detail: `截止 ${dueText}`,
      }
    }
    return {
      phase: days === 1 ? 'tomorrow' : 'upcoming',
      days,
      severity: days <= 3 ? 'warn' : 'info',
      text: days === 1 ? '还剩 1 天' : `还剩 ${days} 天`,
      detail: `截止 ${dueText}`,
    }
  }

  if (task.start !== null) {
    const days = daysBetween(today, task.start)
    const startText = humanMoment(task.start, now)
    const started = task.start <= nowIso
    if (started) {
      return {
        phase: 'running',
        days: 0,
        severity: 'warn',
        text: task.status === 'doing' ? '进行中' : '已开始',
        detail: `始于 ${startText}`,
      }
    }
    if (days === 0) {
      return { phase: 'today', days: 0, severity: 'warn', text: '今天开始', detail: `开始 ${startText}` }
    }
    return {
      phase: days === 1 ? 'tomorrow' : 'upcoming',
      days,
      severity: days <= 3 ? 'warn' : 'info',
      text: days === 1 ? '还有 1 天开始' : `还有 ${days} 天开始`,
      detail: `开始 ${startText}`,
    }
  }

  return { phase: 'pending', days: null, severity: 'idle', text: '未排期', detail: '' }
}

/**
 * The moment a milestone key fires, plus its alert metadata.
 * @param task - canonical task.
 * @param config - normalized config.
 * @returns candidate reminders, each `{ key, at, kind, level, text }`.
 */
export function reminderCandidates(task, config) {
  const out = []
  if (task.status === 'done') return out

  if (task.start !== null && hasTime(task.start)) {
    const lead = addMinutes(task.start, -config.startLeadMinutes)
    out.push({
      key: `start-lead:${task.start}`,
      at: lead,
      kind: 'start-soon',
      level: 'info',
      text: config.startLeadMinutes > 0
        ? `「${task.title}」${config.startLeadMinutes} 分钟后开始`
        : `「${task.title}」现在开始`,
    })
  }

  if (task.due !== null) {
    for (const days of config.leadDays) {
      const at = addDays(task.due, -days)
      if (at === null) continue
      out.push({
        key: `due-lead-${days}d:${task.due}`,
        at,
        kind: 'due-lead',
        level: days <= 1 ? 'warn' : 'info',
        text: `「${task.title}」${days === 1 ? '明天到期' : `还剩 ${days} 天到期`}`,
      })
    }
    for (const hours of config.leadHours) {
      const at = addMinutes(task.due, -hours * 60)
      if (at === null) continue
      out.push({
        key: `due-lead-${hours}h:${task.due}`,
        at,
        kind: 'due-lead',
        level: 'warn',
        text: `「${task.title}」${hours} 小时后到期`,
      })
    }
    out.push({
      key: `due:${task.due}`,
      at: task.due,
      kind: 'due',
      level: 'warn',
      text: `「${task.title}」已到截止时间`,
    })

    // Daily overdue nudge: one candidate per day after the due day.
    const dueDay = dayOf(task.due)
    const first = addDays(dueDay, 1)
    const guard = 90
    for (let index = 0; index < guard; index += 1) {
      const day = addDays(first, index)
      if (day === null) break
      out.push({
        key: `overdue:${day}`,
        at: `${day} ${String(config.overdueDailyHour).padStart(2, '0')}:00`,
        kind: 'overdue',
        level: 'error',
        text: `「${task.title}」已逾期（应收于 ${dayOf(task.due)}）`,
      })
    }
  }
  return out
}

/**
 * The single live reminder for one task: the latest milestone whose moment has
 * passed and which has not been acknowledged. Older, superseded milestones are
 * silently retired so one neglected task cannot flood the notification stack.
 * @param task - canonical task.
 * @param now - reference moment.
 * @param config - normalized config.
 * @returns `{ alert, stale }` — `alert` may be null; `stale` lists keys that
 * passed but were superseded (the caller may persist them as fired).
 */
export function liveReminder(task, now, config) {
  const nowIso = formatMoment(now)
  const fired = new Set(Array.isArray(task.fired) ? task.fired : [])
  const due = reminderCandidates(task, config)
    .filter((candidate) => candidate.at <= nowIso)
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
  const pending = due.filter((candidate) => !fired.has(candidate.key))
  if (pending.length === 0) return { alert: null, stale: [] }
  const latest = pending[pending.length - 1]
  const stale = due
    .filter((candidate) => candidate.key !== latest.key && !fired.has(candidate.key))
    .map((candidate) => `@${task.id}:${candidate.key}`)
  const project = projectTask(task, now)
  return {
    alert: {
      key: `@${task.id}:${latest.key}`,
      taskId: task.id,
      kind: latest.kind,
      level: latest.level,
      at: latest.at,
      title: task.title,
      text: latest.text,
      countdown: project.text,
      owner: task.owner,
      due: task.due,
      started: task.start,
    },
    stale,
  }
}

/** Aggregate counters for the calendar header. */
export function summarize(tasks, now = new Date()) {
  const stats = { total: tasks.length, today: 0, doing: 0, overdue: 0, done: 0, upcoming: 0 }
  const todayKey = formatDay(now)
  for (const task of tasks) {
    if (task.status === 'done') { stats.done += 1; continue }
    const project = projectTask(task, now)
    if (project.phase === 'overdue') stats.overdue += 1
    // "Today" means the work is due today (or was due and is not finished).
    if (dueDay(task) === todayKey) stats.today += 1
    // "In progress" is a fact about the clock, not an extra status to maintain:
    // the window has opened and the deadline has not passed. A task that is
    // still `todo` but already under way must count here, otherwise the number
    // stays 0 for anyone who never flips a status by hand.
    if (isRunning(task, now)) stats.doing += 1
    if (project.phase === 'upcoming' || project.phase === 'tomorrow') stats.upcoming += 1
  }
  return stats
}

/** The day a task's deadline falls on, or null for an open-ended task. */
export function dueDay(task) {
  return task.due === null || task.due === undefined ? null : dayOf(task.due)
}

/**
 * Whether a task is under way right now: its start has arrived, the deadline
 * has not passed, and it is not finished.
 * @param task - canonical task.
 * @param now - reference moment.
 * @returns true when the task is in progress.
 */
export function isRunning(task, now = new Date()) {
  if (task.status === 'done') return false
  const nowIso = formatMoment(now)
  if (task.start !== null && task.start !== undefined) {
    if (task.start > nowIso) return false
  } else if (task.due === null || task.due === undefined) {
    return false
  } else {
    // No start time: the work can only be "running" once its day arrives.
    if ((dayOf(task.due) ?? '') > dayOf(nowIso)) return false
  }
  if (task.due !== null && task.due !== undefined && task.due < nowIso) return false
  return true
}

/** The day a task belongs to inside the calendar grid. */
export function taskDay(task) {
  return dayOf(task.start ?? task.due ?? '') ?? null
}

/** Sort: overdue first, then by due/start, then by priority. */
export function sortTasks(tasks, now = new Date()) {
  const weight = { error: 0, warn: 1, info: 2, idle: 3 }
  const priorityWeight = { high: 0, normal: 1, low: 2 }
  return [...tasks].sort((a, b) => {
    const pa = projectTask(a, now)
    const pb = projectTask(b, now)
    if (pa.severity !== pb.severity) return weight[pa.severity] - weight[pb.severity]
    const da = a.due ?? a.start ?? '9999'
    const db = b.due ?? b.start ?? '9999'
    if (da !== db) return da < db ? -1 : 1
    return (priorityWeight[a.priority] ?? 1) - (priorityWeight[b.priority] ?? 1)
  })
}

/** One-line status used by both the model tools and the panel. */
export function taskLine(task, now = new Date()) {
  const project = projectTask(task, now)
  const when = task.due !== null ? `截止 ${humanMoment(task.due, now)}` : task.start !== null ? `开始 ${humanMoment(task.start, now)}` : '未排期'
  const owner = task.owner === '' ? '' : ` · ${task.owner}`
  const flag = task.priority === 'high' ? ' · 高优先' : ''
  return `[${task.id}] ${task.title} — ${project.text}（${when}${owner}${flag}）`
}

/** Create a Date from a canonical string (exported for callers that need it). */
export function toDate(value) {
  return parseLocal(value)
}

export { formatDay, formatMoment, dayOf, timeOf, daysBetween, humanMoment }
