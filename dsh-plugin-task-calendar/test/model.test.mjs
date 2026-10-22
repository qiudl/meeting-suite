/**
 * Pure-logic tests for the task-calendar host half.
 *
 * Run: node --test test/
 *
 * @module dsh-plugin-task-calendar/test/model.test
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { normalizeDate, dayOf, addDays, daysBetween, formatDay } from '../lib/dates.js'
import {
  DEFAULT_CONFIG, isRunning, liveReminder, normalizeConfig, normalizeTask, newId,
  projectTask, reminderCandidates, sortTasks, summarize, taskLine,
} from '../lib/model.js'
import { TaskStore } from '../lib/store.js'
import { registerTools } from '../lib/tools.js'
import { buildState, registerRoutes, ROUTE_PREFIX } from '../lib/server.js'

const at = (text) => new Date(text)

test('normalizeDate accepts the shapes a meeting note actually uses', () => {
  assert.equal(normalizeDate('2026-10-12'), '2026-10-12')
  assert.equal(normalizeDate('2026/10/12'), '2026-10-12')
  assert.equal(normalizeDate('2026-10-12 18:00'), '2026-10-12 18:00')
  assert.equal(normalizeDate('2026-10-12T18:00'), '2026-10-12 18:00')
  assert.equal(normalizeDate('2026-10-12T18:00:30'), '2026-10-12 18:00')
  // An explicit offset converts to the local wall clock of the same instant.
  const zoned = normalizeDate('2026-10-12T10:00:00Z')
  assert.match(zoned, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  assert.equal(new Date(zoned.replace(' ', 'T')).getTime(), new Date('2026-10-12T10:00:00Z').getTime())
  assert.equal(normalizeDate(''), null)
  assert.equal(normalizeDate(undefined), null)
})

test('normalizeDate understands relative phrases against the clock', () => {
  const now = at('2026-10-09T09:55:00')
  // Relative words resolve from `Date.now()`; assert the shape, then the offset
  // by comparing with the same computation the implementation documents.
  const today = normalizeDate('今天')
  assert.match(today, /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(normalizeDate('明天'), addDays(today, 1))
  assert.equal(normalizeDate('后天'), addDays(today, 2))
  assert.equal(normalizeDate('昨天'), addDays(today, -1))
  assert.equal(normalizeDate('明天 18:30'), `${addDays(today, 1)} 18:30`)
  assert.equal(normalizeDate('下周') === null, true)
  const weekday = normalizeDate('周五')
  assert.match(weekday, /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(new Date(`${weekday}T00:00:00`).getDay(), 5)
  assert.equal(normalizeDate('18:05'), `${normalizeDate('今天')} 18:05`)
  assert.equal(normalizeDate('18点'), `${normalizeDate('今天')} 18:00`)
  void now
})

test('projectTask classifies overdue, today, remaining and running', () => {
  const now = at('2026-10-09T09:55:00')
  const base = { status: 'todo', priority: 'normal', start: null, due: null, completedAt: null, owner: '', tags: [], fired: [] }
  assert.equal(projectTask({ ...base, due: '2026-10-06' }, now).phase, 'overdue')
  assert.equal(projectTask({ ...base, due: '2026-10-06' }, now).text, '逾期 3 天')
  assert.equal(projectTask({ ...base, due: '2026-10-09' }, now).phase, 'today')
  assert.equal(projectTask({ ...base, due: '2026-10-10' }, now).text, '还剩 1 天')
  assert.equal(projectTask({ ...base, due: '2026-10-12' }, now).text, '还剩 3 天')
  assert.equal(projectTask({ ...base, due: '2026-10-12' }, now).severity, 'warn')
  assert.equal(projectTask({ ...base, due: '2026-11-12' }, now).severity, 'info')
  assert.equal(projectTask({ ...base, due: '2026-10-09 08:00' }, now).phase, 'overdue')
  assert.equal(projectTask({ ...base, start: '2026-10-09 09:00' }, now).phase, 'running')
  assert.equal(projectTask({ ...base, start: '2026-10-11 09:00' }, now).text, '还有 2 天开始')
  assert.equal(projectTask({ ...base, status: 'done' }, now).text, '已完成')
  assert.equal(projectTask({ ...base }, now).text, '未排期')
})

test('reminder milestones fire once and retire superseded ones', () => {
  const config = normalizeConfig(DEFAULT_CONFIG)
  const task = normalizeTask({ title: '周报', due: '2026-10-12 18:00' }, { now: at('2026-10-01T09:00:00') })

  // Three days out (at the milestone's own time): the first milestone is live.
  const early = liveReminder(task, at('2026-10-09T18:05:00'), config)
  assert.equal(early.alert.kind, 'due-lead')
  assert.equal(early.alert.key, `@${task.id}:due-lead-3d:2026-10-12 18:00`)
  assert.equal(early.stale.length, 0)
  assert.equal(liveReminder(task, at('2026-10-09T10:00:00'), config).alert, null)

  // Two hours before the deadline the earlier milestones are superseded.
  const late = liveReminder(task, at('2026-10-12T16:30:00'), config)
  assert.equal(late.alert.kind, 'due-lead')
  assert.match(late.alert.text, /2 小时后到期/)
  assert.ok(late.stale.includes(`@${task.id}:due-lead-3d:2026-10-12 18:00`))
  assert.ok(late.stale.includes(`@${task.id}:due:2026-10-12 18:00`) === false)

  // At the deadline the due milestone wins.
  assert.equal(liveReminder(task, at('2026-10-12T18:00:00'), config).alert.kind, 'due')

  // The next day the daily overdue nudge takes over.
  const overdue = liveReminder(task, at('2026-10-13T09:05:00'), config)
  assert.equal(overdue.alert.kind, 'overdue')
  assert.match(overdue.alert.text, /已逾期/)

  // Acknowledging the newest milestone retires every older one (the store does
  // exactly this in `ack()`), so nothing keeps replaying afterwards.
  const acked = {
    ...task,
    fired: reminderCandidates(task, config)
      .filter((candidate) => candidate.at <= '2026-10-13 09:00')
      .map((candidate) => candidate.key),
  }
  assert.equal(liveReminder(acked, at('2026-10-13T09:05:00'), config).alert, null)

  // The same retirement rule runs through the store.
  const storeTask = { ...task, fired: [] }
  assert.equal(liveReminder(storeTask, at('2026-10-13T09:05:00'), config).alert.kind, 'overdue')

  // Done tasks never remind.
  assert.equal(liveReminder({ ...task, status: 'done' }, at('2026-10-13T09:05:00'), config).alert, null)
})

test('start reminders honour the lead window', () => {
  const config = normalizeConfig({ ...DEFAULT_CONFIG, startLeadMinutes: 30 })
  const task = normalizeTask({ title: '评审会', start: '2026-10-09 14:00' }, { now: at('2026-10-01T09:00:00') })
  assert.equal(liveReminder(task, at('2026-10-09T13:00:00'), config).alert, null)
  const alert = liveReminder(task, at('2026-10-09T13:35:00'), config).alert
  assert.equal(alert.kind, 'start-soon')
  assert.match(alert.text, /30 分钟后开始/)
})

test('reminderCandidates cover every configured milestone', () => {
  const config = normalizeConfig({ leadDays: [3, 1], leadHours: [2], startLeadMinutes: 30, overdueDailyHour: 9 })
  const task = normalizeTask({ title: 't', start: '2026-10-09 14:00', due: '2026-10-12 18:00' }, { now: at('2026-10-01T09:00:00') })
  const keys = reminderCandidates(task, config).map((candidate) => candidate.key)
  // `leadDays` normalizes to ascending order, so 1d precedes 3d.
  assert.deepEqual(keys.slice(0, 5), [
    'start-lead:2026-10-09 14:00',
    'due-lead-1d:2026-10-12 18:00',
    'due-lead-3d:2026-10-12 18:00',
    'due-lead-2h:2026-10-12 18:00',
    'due:2026-10-12 18:00',
  ])
  assert.ok(keys.includes('overdue:2026-10-13'))
})

test('normalizeConfig repairs nonsense', () => {
  const config = normalizeConfig({ leadDays: [3, 3, -1, 'x', 1], leadHours: 2, startLeadMinutes: -5, maxAlerts: 0, overdueDailyHour: 99 })
  assert.deepEqual(config.leadDays, [1, 3])
  assert.deepEqual(config.leadHours, DEFAULT_CONFIG.leadHours)
  assert.equal(config.startLeadMinutes, 0)
  assert.equal(config.maxAlerts, 1)
  assert.equal(config.overdueDailyHour, 23)
  assert.equal(config.systemNotify, true)
})

test('summarize counts a task that is under way, not a status field', () => {
  const now = new Date('2026-10-20T11:22:00')
  const make = (title, start, due, status = 'todo') => normalizeTask({ title, start, due, status }, { now })
  const tasks = [
    // Started yesterday, due tomorrow: this is the one that must count.
    make('进行中', '2026-10-19 09:00', '2026-10-21 18:00'),
    // Starts later: not under way yet.
    make('未开始', '2026-10-21 09:00', '2026-10-23 18:00'),
    // Deadline has passed: overdue, not "in progress".
    make('已逾期', '2026-10-18 09:00', '2026-10-19 09:00'),
    // Finished work never counts, even inside its own window.
    make('已完成', '2026-10-19 09:00', '2026-10-21 18:00', 'done'),
    // A deadline-only task is under way once its day arrives.
    make('今天截止', null, '2026-10-20 18:00'),
    // A future deadline-only task is not.
    make('明天截止', null, '2026-10-21 18:00'),
  ]
  const stats = summarize(tasks, now)
  assert.equal(stats.doing, 2, 'the started, not-overdue, unfinished tasks')
  assert.equal(stats.overdue, 1)
  assert.equal(stats.done, 1)
  assert.equal(stats.today, 1, 'counts what is due today')

  // Marking a running task done moves it out of the counter.
  const finished = tasks.map((task) => (task.title === '进行中' ? { ...task, status: 'done' } : task))
  assert.equal(summarize(finished, now).doing, 1)

  // isRunning is the single predicate behind the number.
  assert.equal(isRunning(tasks[0], now), true)
  assert.equal(isRunning(tasks[1], now), false)
  assert.equal(isRunning(tasks[2], now), false)
  assert.equal(isRunning(tasks[3], now), false)
})

test('summarize and sortTasks agree on severity order', () => {
  const now = at('2026-10-09T10:00:00')
  const tasks = [
    normalizeTask({ title: 'a', due: '2026-10-20' }, { now }),
    normalizeTask({ title: 'b', due: '2026-10-05' }, { now }),
    normalizeTask({ title: 'c', due: '2026-10-09 18:00' }, { now }),
    normalizeTask({ title: 'd', status: 'done' }, { now }),
  ]
  const stats = summarize(tasks, now)
  assert.equal(stats.total, 4)
  assert.equal(stats.overdue, 1)
  assert.equal(stats.today, 1)
  assert.equal(stats.done, 1)
  assert.deepEqual(sortTasks(tasks, now).map((task) => task.title), ['b', 'c', 'a', 'd'])
  assert.match(taskLine(tasks[1], now), /逾期 4 天/)
})

test('unknown task fields survive normalization only where declared', () => {
  const task = normalizeTask({ title: '  x  ', due: '2026-10-12', owner: ' 张三 ', tags: ['a', 'a', ' '], junk: 1 }, { now: at('2026-10-01T00:00:00') })
  assert.equal(task.title, 'x')
  assert.equal(task.owner, '张三')
  assert.deepEqual(task.tags, ['a'])
  assert.equal('junk' in task, false)
  assert.match(task.id, /^tk_/)
  assert.notEqual(newId(), newId())
})

test('TaskStore round-trips through disk and ack() retires reminder keys', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'task-calendar-'))
  const file = join(dir, 'nested', 'task-calendar.json')
  try {
    const store = new TaskStore({ file })
    const now = at('2026-10-01T09:00:00')
    const [task] = await store.addMany([{ title: '会议纪要任务', due: '2026-10-02 10:00' }], { now })
    assert.ok(task.id)
    await store.patch(task.id, { status: 'doing' })
    assert.equal(store.find(task.id).status, 'doing')
    assert.equal(store.find('会议纪要').id, task.id)

    const raw = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(raw.tasks.length, 1)
    assert.equal(raw.tasks[0].status, 'doing')

    const alert = liveReminder(store.find(task.id), at('2026-10-02T09:45:00'), store.config).alert
    assert.ok(alert !== null)
    assert.equal(await store.ack([alert.key]), 1)
    assert.equal(liveReminder(store.find(task.id), at('2026-10-02T09:45:00'), store.config).alert, null)

    await store.setConfig({ leadDays: [7] })
    assert.deepEqual(store.config.leadDays, [7])

    const reloaded = new TaskStore({ file })
    await reloaded.load()
    assert.equal(reloaded.snapshot().tasks.length, 1)
    assert.deepEqual(reloaded.config.leadDays, [7])

    assert.equal(await store.remove(task.id) !== null, true)
    assert.equal(store.snapshot().tasks.length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('buildState exposes tasks, countdown and pending reminders', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'task-calendar-state-'))
  try {
    const store = new TaskStore({ file: join(dir, 'store.json') })
    await store.addMany([
      { title: '逾期任务', due: '2026-10-05' },
      { title: '今天到点', due: '2026-10-09 11:00' },
      { title: '未来的事', due: '2026-10-30' },
    ], { now: at('2026-10-01T09:00:00') })
    const state = buildState(store, at('2026-10-09T09:55:00'))
    assert.equal(state.ok, true)
    assert.equal(state.today, '2026-10-09')
    assert.equal(state.tasks.length, 3)
    assert.equal(state.stats.overdue, 1)
    assert.ok(state.alerts.length >= 1)
    assert.match(state.alerts[0].text, /逾期/)
    const overdue = state.tasks.find((task) => task.title === '逾期任务')
    assert.equal(overdue.project.phase, 'overdue')
    assert.equal(overdue.day, '2026-10-05')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('TaskStore migrates a document written under the old plugin name', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'task-calendar-migrate-'))
  const legacy = join(dir, 'calendar-tasks.json')
  const current = join(dir, 'task-calendar.json')
  try {
    await writeFile(legacy, JSON.stringify({
      version: 1,
      updatedAt: '2026-10-01T00:00:00.000Z',
      config: { leadDays: [2], systemNotify: false },
      // Deliberately omits `tags`: an older/hand-edited document must not crash.
      tasks: [{
        id: 'tk_legacy', title: '改名前的任务', status: 'todo', priority: 'normal',
        start: null, due: '2026-10-20', allDay: true, owner: '', notes: '', source: null,
        createdAt: '2026-10-01 09:00', updatedAt: '2026-10-01 09:00', completedAt: null, fired: [],
      }],
    }), 'utf8')

    const store = new TaskStore({ file: current, legacyFile: legacy })
    await store.load()
    assert.equal(store.snapshot().tasks.length, 1)
    assert.equal(store.find('改名前的任务').title, '改名前的任务')
    assert.deepEqual(store.snapshot().tasks[0].tags, [])
    assert.deepEqual(store.config.leadDays, [2])
    assert.equal(store.config.systemNotify, false)

    // The migrated document is re-persisted under the current name.
    const written = JSON.parse(await readFile(current, 'utf8'))
    assert.equal(written.tasks.length, 1)
    assert.equal(written.tasks[0].id, 'tk_legacy')

    // A second store on the same directory reads the current file, not the old one.
    const again = new TaskStore({ file: current, legacyFile: legacy })
    await again.load()
    assert.equal(again.snapshot().tasks.length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/** A Cordis stand-in that records registrations and can drive the HTTP handler. */
function fakeContext() {
  const tools = []
  const routes = []
  const effects = []
  return {
    ctx: {
      logger: { info() {}, warn() {}, error() {} },
      effect(callback) { effects.push(callback()); return () => {} },
      tools: { register(definition) { tools.push(definition); return () => {} } },
      webServer: { register(route) { routes.push(route); return () => {} } },
    },
    tools,
    routes,
    effects,
  }
}

test('registerTools declares the five agent tools with JSON-Schema parameters', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'task-calendar-tools-'))
  try {
    const store = new TaskStore({ file: join(dir, 'store.json') })
    const fake = fakeContext()
    registerTools(fake.ctx, store)
    assert.deepEqual(fake.tools.map((tool) => tool.name), [
      'calendar_add_tasks', 'calendar_list_tasks', 'calendar_update_task',
      'calendar_delete_task', 'calendar_reminder_config',
    ])
    for (const tool of fake.tools) {
      assert.equal(typeof tool.description, 'string')
      assert.equal(typeof tool.execute, 'function')
      assert.equal(tool.output.schema.type, 'string')
      assert.equal(typeof tool.output.render, 'function')
    }
    const add = fake.tools[0]
    assert.equal(add.parameters.type, 'object')
    assert.deepEqual(add.parameters.required, ['tasks'])

    const created = await add.execute({
      tasks: [{ title: '输出 Q4 预算初稿', due: '下周三', owner: '张三' }],
      source: { kind: 'minutes', title: '周会', date: '2026-10-09' },
    })
    assert.match(created, /已创建 1 条任务日历/)
    assert.match(created, /张三/)
    const listed = await fake.tools[1].execute({ range: 'all' })
    assert.match(listed, /输出 Q4 预算初稿/)

    const first = store.snapshot().tasks[0]
    const updated = await fake.tools[2].execute({ id: first.id, status: 'done' })
    assert.match(updated, /已完成/)
    assert.equal(store.snapshot().tasks[0].status, 'done')
    assert.equal(store.snapshot().tasks[0].source.title, '周会')

    const configured = await fake.tools[4].execute({ leadDays: [7, 3] })
    assert.match(configured, /7 天/)
    assert.deepEqual(store.config.leadDays, [3, 7])

    await assert.rejects(() => add.execute({ tasks: [] }), /tasks 必须是非空数组/)
    await assert.rejects(() => fake.tools[3].execute({ id: 'nope' }), /没有找到/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('registerRoutes serves state, mutations and acknowledgement over HTTP', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'task-calendar-http-'))
  try {
    const store = new TaskStore({ file: join(dir, 'store.json') })
    const fake = fakeContext()
    registerRoutes(fake.ctx, store)
    assert.equal(fake.routes.length, 1)
    assert.equal(fake.routes[0].kind, 'prefix')
    assert.equal(fake.routes[0].path, ROUTE_PREFIX)

    /** Minimal Node request/response stand-ins. */
    const run = async (method, path, body) => {
      const req = {
        method,
        url: `${ROUTE_PREFIX}${path}`,
        socket: { remoteAddress: '127.0.0.1' },
        async *[Symbol.asyncIterator]() {
          if (body !== undefined) yield Buffer.from(JSON.stringify(body))
        },
      }
      let status = 0
      let payload = ''
      const res = {
        writeHead(code) { status = code },
        end(text) { payload = text ?? '' },
      }
      await fake.routes[0].handler(req, res)
      return { status, json: payload === '' ? null : JSON.parse(payload) }
    }

    const health = await run('GET', '/health')
    assert.equal(health.status, 200)
    assert.equal(health.json.ok, true)

    // Relative to the real clock, so this test does not rot as days pass.
    const dueDay = addDays(formatDay(new Date()), 3)
    const due = `${dueDay} 18:00`
    const created = await run('POST', '/tasks', { title: '从纪要来', due })
    assert.equal(created.status, 200)
    assert.equal(created.json.task.title, '从纪要来')
    const id = created.json.task.id

    const state = await run('GET', '/state')
    assert.equal(state.status, 200)
    assert.equal(state.json.tasks.length, 1)
    assert.equal(state.json.tasks[0].project.text, '还剩 3 天')

    const patched = await run('PATCH', `/tasks/${id}`, { status: 'done' })
    assert.equal(patched.json.task.status, 'done')

    const acked = await run('POST', '/ack', { keys: [`@${id}:due:${due}`] })
    assert.equal(acked.json.ok, true)

    const configured = await run('POST', '/config', { leadDays: [5] })
    assert.deepEqual(configured.json.config.leadDays, [5])

    const removed = await run('DELETE', `/tasks/${id}`)
    assert.equal(removed.json.ok, true)

    const missing = await run('GET', '/nope')
    assert.equal(missing.status, 404)

    const remote = await (async () => {
      const req = {
        method: 'GET',
        url: `${ROUTE_PREFIX}/state`,
        socket: { remoteAddress: '10.0.0.9' },
        async *[Symbol.asyncIterator]() {},
      }
      let status = 0
      const res = { writeHead(code) { status = code }, end() {} }
      await fake.routes[0].handler(req, res)
      return status
    })()
    assert.equal(remote, 403)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('date helpers agree with each other', () => {
  assert.equal(dayOf('2026-10-12 18:00'), '2026-10-12')
  assert.equal(addDays('2026-10-12 18:00', 3), '2026-10-15 18:00')
  assert.equal(addDays('2026-12-31', 1), '2027-01-01')
  assert.equal(daysBetween('2026-10-09', '2026-10-12'), 3)
  assert.equal(daysBetween('2026-10-12', '2026-10-09'), -3)
})
