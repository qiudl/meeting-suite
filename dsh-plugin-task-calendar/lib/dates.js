/**
 * Local wall-clock date helpers for the task-calendar plugin.
 *
 * The whole plugin stores dates as local wall-clock strings, never as UTC
 * instants: a task due "2026-10-12 18:00" must mean 18:00 on the user's
 * machine, and a day cell in the calendar must never drift because of a
 * timezone offset. Two canonical forms exist:
 *
 * - `YYYY-MM-DD`            — an all-day date
 * - `YYYY-MM-DD HH:mm`      — a date with a local time of day
 *
 * @module dsh-plugin-task-calendar/dates
 */

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/

/** Pad a number to two digits. */
function p2(n) {
  return String(n).padStart(2, '0')
}

/** Format a Date as `YYYY-MM-DD` in local time. */
export function formatDay(date) {
  return `${date.getFullYear()}-${p2(date.getMonth() + 1)}-${p2(date.getDate())}`
}

/** Format a Date as `YYYY-MM-DD HH:mm` in local time. */
export function formatMoment(date) {
  return `${formatDay(date)} ${p2(date.getHours())}:${p2(date.getMinutes())}`
}

/**
 * Parse a canonical local string into a Date, or return null.
 * `YYYY-MM-DD` becomes local midnight.
 * @param value - canonical `YYYY-MM-DD` or `YYYY-MM-DD HH:mm`.
 */
export function parseLocal(value) {
  if (typeof value !== 'string') return null
  const day = DATE_RE.exec(value)
  if (day !== null) {
    return new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]), 0, 0, 0, 0)
  }
  const moment = DATETIME_RE.exec(value)
  if (moment !== null) {
    return new Date(
      Number(moment[1]), Number(moment[2]) - 1, Number(moment[3]),
      Number(moment[4]), Number(moment[5]), 0, 0,
    )
  }
  return null
}

/**
 * Normalize loose model/user input into a canonical local string.
 *
 * Accepted: `YYYY-MM-DD`, `YYYY/MM/DD`, `YYYY-MM-DD HH:mm`, `YYYY-MM-DDTHH:mm`,
 * `YYYY-MM-DDTHH:mm:ss`, ISO strings carrying an explicit offset (converted to
 * the local wall clock), and a date-only string with `HH:mm` appended via
 * `HH:mm` / `HH:mm:ss`. Returns null when nothing parses.
 * @param value - raw input.
 * @returns canonical `YYYY-MM-DD` / `YYYY-MM-DD HH:mm`, or null.
 */
export function normalizeDate(value) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Epoch milliseconds or epoch seconds.
    const ms = value > 1e12 ? value : value * 1000
    return formatMoment(new Date(ms))
  }
  if (typeof value !== 'string') return null
  const raw = value.trim()
  if (raw === '') return null

  // Canonical forms first (fast path, no timezone surprises).
  const directDay = DATE_RE.exec(raw)
  if (directDay !== null) return parseLocal(raw) === null ? null : raw
  const directMoment = DATETIME_RE.exec(raw)
  if (directMoment !== null) {
    // `T` is accepted as a separator but never stored.
    const canonical = raw.replace('T', ' ')
    return parseLocal(canonical) === null ? null : canonical
  }

  // Slash-separated Chinese-style dates.
  const slashed = /^(\d{4})[/.](\d{1,2})[/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::\d{2})?)?$/.exec(raw)
  if (slashed !== null) {
    const day = `${slashed[1]}-${p2(slashed[2])}-${p2(slashed[3])}`
    return slashed[4] === undefined ? day : `${day} ${p2(slashed[4])}:${slashed[5]}`
  }

  // 20261012 / 2026年10月12日
  const compact = /^(\d{4})\D{0,1}(\d{1,2})\D{0,1}(\d{1,2})\D{0,1}(?:[ T]?(\d{1,2}):?(\d{2}))?$/.exec(raw)
  if (compact !== null) {
    const day = `${compact[1]}-${p2(compact[2])}-${p2(compact[3])}`
    return compact[4] === undefined ? day : `${day} ${p2(compact[4])}:${compact[5]}`
  }

  // 10-12 / 10月12日 — assume the current year.
  const shortDate = /^(?:(\d{4})[-/.])?(\d{1,2})[-/.月](\d{1,2})日?(?:[ T](\d{1,2}):(\d{2}))?$/.exec(raw)
  if (shortDate !== null) {
    const year = shortDate[1] ?? String(new Date().getFullYear())
    const day = `${year}-${p2(shortDate[2])}-${p2(shortDate[3])}`
    return shortDate[4] === undefined ? day : `${day} ${p2(shortDate[4])}:${shortDate[5]}`
  }

  // Explicit offset / ISO with seconds: only trust it when it carries a zone,
  // otherwise the wall clock is already the answer.
  const iso = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.exec(raw)
  if (iso !== null) {
    const parsed = new Date(raw)
    return Number.isNaN(parsed.getTime()) ? null : formatMoment(parsed)
  }
  const isoNoZone = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/.exec(raw)
  if (isoNoZone !== null) {
    return `${isoNoZone[1]}-${isoNoZone[2]}-${isoNoZone[3]} ${isoNoZone[4]}:${isoNoZone[5]}`
  }

  const relative = parseRelative(raw)
  if (relative !== null) return relative

  const fallback = new Date(raw)
  return Number.isNaN(fallback.getTime()) ? null : formatMoment(fallback)
}

/**
 * Parse the relative day phrases a Chinese meeting note actually uses:
 * `今天`, `明天`, `后天`, `大后天`, `昨天`, `下周三`, `周五`, `本周五`,
 * `10月12日`, each optionally followed by `18:00` / `18:00:00`.
 * A bare `周五` means the next such weekday on or after today; `下周五` means
 * the one in the following calendar week.
 * @param raw - trimmed input.
 * @returns canonical string or null.
 */
function parseRelative(raw) {
  const now = new Date()
  const withTime = (day, hour, minute) => (hour === undefined
    ? day
    : `${day} ${p2(hour)}:${minute ?? '00'}`)

  const named = /^(今天|今日|明天|明日|后天|大后天|昨天|昨日)[\s,，]*(?:(\d{1,2})[:：点时](\d{2})?)?$/.exec(raw)
  if (named !== null) {
    const offset = { 今天: 0, 今日: 0, 明天: 1, 明日: 1, 后天: 2, 大后天: 3, 昨天: -1, 昨日: -1 }[named[1]]
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset)
    return withTime(formatDay(date), named[2] === undefined ? undefined : Number(named[2]), named[3])
  }

  const weekday = /^(下|下个|本|这)?\s*(?:周|星期|礼拜)\s*([一二三四五六日天])(?:[\s,，]*(?:(\d{1,2})[:：点时](\d{2})?))?$/.exec(raw)
  if (weekday !== null) {
    const target = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 }[weekday[2]]
    const current = now.getDay()
    let delta = (target - current + 7) % 7
    const nextWeek = weekday[1] === '下' || weekday[1] === '下个'
    if (nextWeek) delta += 7
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + delta)
    return withTime(formatDay(date), weekday[3] === undefined ? undefined : Number(weekday[3]), weekday[4])
  }

  const clockOnly = /^(?:(\d{1,2})[:：点时](\d{2})?|(\d{1,2})点(半)?)$/.exec(raw)
  if (clockOnly !== null) {
    const hour = clockOnly[1] !== undefined ? Number(clockOnly[1]) : Number(clockOnly[3])
    const minute = clockOnly[1] !== undefined
      ? (clockOnly[2] ?? '00')
      : (clockOnly[4] === '半' ? '30' : '00')
    if (hour >= 0 && hour <= 23) return `${formatDay(now)} ${p2(hour)}:${minute}`
  }

  return null
}

/** True when the canonical string carries an explicit time of day. */
export function hasTime(value) {
  return typeof value === 'string' && DATETIME_RE.test(value)
}

/** The `YYYY-MM-DD` part of a canonical string. */
export function dayOf(value) {
  return typeof value === 'string' ? value.slice(0, 10) : null
}

/** The `HH:mm` part of a canonical string, or null for an all-day value. */
export function timeOf(value) {
  return hasTime(value) ? value.slice(11, 16) : null
}

/** Local midnight of the day a canonical string names. */
export function startOfDay(value) {
  const date = parseLocal(dayOf(value) ?? '')
  return date ?? new Date(NaN)
}

/** Add whole days to a canonical string, preserving its time of day. */
export function addDays(value, days) {
  const date = parseLocal(value)
  if (date === null) return null
  date.setDate(date.getDate() + days)
  return hasTime(value) ? formatMoment(date) : formatDay(date)
}

/** Add whole minutes to a canonical string. */
export function addMinutes(value, minutes) {
  const date = parseLocal(value)
  if (date === null) return null
  date.setMinutes(date.getMinutes() + minutes)
  return hasTime(value) ? formatMoment(date) : formatDay(date)
}

/** Whole calendar days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from, to) {
  const a = parseLocal(dayOf(from) ?? '')
  const b = parseLocal(dayOf(to) ?? '')
  if (a === null || b === null) return null
  return Math.round((b.getTime() - a.getTime()) / 86_400_000)
}

/** `周一`…`周日` for a canonical date. */
export function weekdayLabel(value) {
  const date = parseLocal(dayOf(value) ?? '')
  if (date === null) return ''
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][date.getDay()]
}

/** Human phrase for a canonical moment relative to `now`: `今天 18:00`, `明天`, `10-12 周一 18:00`. */
export function humanMoment(value, now = new Date()) {
  if (typeof value !== 'string') return ''
  const day = dayOf(value)
  const time = timeOf(value)
  const delta = daysBetween(formatDay(now), value)
  let phrase
  if (delta === 0) phrase = '今天'
  else if (delta === 1) phrase = '明天'
  else if (delta === 2) phrase = '后天'
  else if (delta === -1) phrase = '昨天'
  else {
    const sameYear = day.slice(0, 4) === String(now.getFullYear())
    phrase = sameYear ? `${day.slice(5, 7)}-${day.slice(8, 10)} ${weekdayLabel(value)}` : `${day} ${weekdayLabel(value)}`
  }
  return time === null ? phrase : `${phrase} ${time}`
}
