/**
 * Smoke tests for the hand-written browser half.
 *
 * They load the real bundle through the same `window.__ModuleLoader__.load`
 * entry the shell uses, feed it a minimal React shim plus stubs for the frozen
 * platform modules, then:
 *   1. parse-check the file as a classic script (no import/export at all),
 *   2. apply it to a fake client context and assert the three slot seats,
 *   3. render every registered component (catching runtime errors),
 *   4. drive the host API through the bundle's own fetch path.
 *
 * Run: node --test test/
 *
 * @module dsh-plugin-task-calendar/test/client.test
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { test } from 'node:test'

const CLIENT_PATH = fileURLToPath(new URL('../lib/client.js', import.meta.url))

/** Known frozen platform module table of the shipped web shell. */
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit',
]

/** Minimal React that can render a function-component tree once. */
function reactShim() {
  const createElement = (type, props, ...children) => ({
    type,
    props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children },
  })
  return {
    createElement,
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useMemo: (factory) => factory(),
    useRef: (value) => ({ current: value }),
    useCallback: (fn) => fn,
    useLayoutEffect: () => {},
  }
}

/** Walk a createElement tree, invoking every function component. */
function renderTree(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map((child) => renderTree(child)).join('')
  if (typeof node.type === 'function') return renderTree(node.type(node.props))
  return renderTree(node.props?.children)
}

/** Collect the host element names in a createElement tree (function components resolved). */
function collectTypes(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) collectTypes(child, out)
    return out
  }
  if (typeof node.type === 'function') return collectTypes(node.type(node.props), out)
  out.push(node.type)
  collectTypes(node.props?.children, out)
  return out
}

/** Collect every className string in a createElement tree. */
function collectClasses(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) collectClasses(child, out)
    return out
  }
  if (typeof node.type === 'function') return collectClasses(node.type(node.props), out)
  if (typeof node.props?.className === 'string') out.push(node.props.className)
  collectClasses(node.props?.children, out)
  return out
}

/** The primitives the bundle is allowed to require, as inert components. */
function primitivesShim(React) {
  const h = React.createElement
  return {
    Modal: (props) => (props.open ? h('div', { 'data-modal': props.title }, props.children, props.footer) : null),
    Button: (props) => h('button', null, props.children),
    Pill: (props) => h('span', null, props.children),
    Tag: (props) => h('span', null, props.children),
    Input: () => h('input', null),
    Toast: () => h('div', null, 'toast'),
  }
}

/** Load the bundle the way the shell does and return its module exports. */
async function loadBundle() {
  const source = await readFile(CLIENT_PATH, 'utf8')
  const registered = []
  const globalWindow = {
    __ModuleLoader__: { load: (definition) => registered.push(definition) },
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: () => 1,
    clearTimeout: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    confirm: () => true,
  }
  const documentStub = {
    head: { appendChild: () => {} },
    querySelector: () => null,
    getElementById: () => null,
    createElement: () => ({ dataset: {}, textContent: '', style: {} }),
    addEventListener: () => {},
    removeEventListener: () => {},
    visibilityState: 'visible',
  }
  const sandbox = {
    window: globalWindow,
    document: documentStub,
    console,
    JSON,
    Math,
    Date,
    Set,
    Map,
    Number,
    String,
    Object,
    Array,
    Boolean,
    Symbol,
    Promise,
    Error,
    fetch: async () => { throw new Error('fetch not stubbed') },
  }
  sandbox.globalThis = sandbox
  // Classic-script parse check: imports/exports or a top-level `const` outside
  // the factory would throw here.
  new vm.Script(source, { filename: 'client.js' })
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client.js' })
  assert.equal(registered.length, 1, 'the bundle must call __ModuleLoader__.load exactly once')
  const definition = registered[0]
  assert.equal(definition.id, 'dsh-plugin-task-calendar')

  const React = reactShim()
  const primitives = primitivesShim(React)
  const requireShim = (specifier) => {
    if (specifier === 'react') return React
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`bundle asked for a non-baseline module: ${specifier}`)
  }
  const exports = definition.factory(requireShim)
  return { exports, sandbox, documentStub }
}

/** A fake client Cordis context that records slot registrations. */
function fakeClientContext() {
  const registrations = []
  return {
    registrations,
    ctx: {
      slots: {
        inject(key, callback) {
          callback()
          return () => {}
        },
        register(options, Component) {
          registrations.push({ options, Component })
          return () => {}
        },
      },
      effect(callback) {
        const dispose = callback()
        void dispose
        return () => {}
      },
    },
  }
}

test('the bundle is a classic script and only requires baseline modules', async () => {
  const source = await readFile(CLIENT_PATH, 'utf8')
  assert.equal(/^\s*import\s/m.test(source), false, 'no ESM import in a classic script')
  assert.equal(/^\s*export\s/m.test(source), false, 'no ESM export in a classic script')
  const loaderCalls = source.match(/window\.__ModuleLoader__\.load\(/g) ?? []
  assert.equal(loaderCalls.length, 1)
  const { exports, sandbox } = await loadBundle()
  assert.equal(typeof exports.apply, 'function')
  assert.equal(exports.inject.length, 1)
  assert.equal(exports.inject[0], 'slots')
  assert.equal(exports.default, undefined, 'a default export would shadow apply/inject')
  // Only the loader call may appear at the top level of the concatenated script.
  assert.equal(typeof sandbox.window.__DSH_LEAK__, 'undefined')
  void PLATFORM_MODULES
})

test('apply registers the calendar panel, its sidebar entry and the reminder overlay', async () => {
  const { exports } = await loadBundle()
  const fake = fakeClientContext()
  exports.apply(fake.ctx)
  assert.deepEqual(fake.registrations.map(({ options }) => `${options.name}:${options.id ?? options.key}`), [
    'sidebar.panellist:calendar',
    'main:calendar',
    'shell.overlay:calendar-reminders',
  ])
  for (const { options } of fake.registrations) {
    assert.equal(options.priority, undefined, 'priority must not be passed by a feature plugin')
    assert.equal(typeof options.label === 'string' || options.label === undefined, true)
  }
})

test('the colour guard maps done to green and overdue to red everywhere', async () => {
  const { exports } = await loadBundle()
  const { taskTone } = exports.__internals
  const done = projectedTask({ status: 'done', project: { phase: 'done', days: null, severity: 'idle', text: '已完成', detail: '' } })
  const overdue = projectedTask({ project: { phase: 'overdue', days: -2, severity: 'error', text: '逾期 2 天', detail: '' } })
  const dueToday = projectedTask({ project: { phase: 'today', days: 0, severity: 'warn', text: '今天到期', detail: '' } })
  const later = projectedTask({ project: { phase: 'upcoming', days: 9, severity: 'info', text: '还剩 9 天', detail: '' } })
  const bare = projectedTask({ project: { phase: 'pending', days: null, severity: 'idle', text: '未排期', detail: '' } })
  const unknown = projectedTask({ project: undefined })

  assert.equal(taskTone(done), 'success', 'completed is green even when the host calls it idle')
  assert.equal(taskTone(overdue), 'error')
  assert.equal(taskTone(dueToday), 'warn')
  assert.equal(taskTone(later), 'info')
  assert.equal(taskTone(bare), 'idle')
  assert.equal(taskTone(unknown), 'idle', 'a missing projection degrades to neutral, never to a status colour')
  // A finished task that is also late stays green: done wins.
  assert.equal(taskTone({ ...overdue, status: 'done' }), 'success')

  // …and the classes actually rendered follow that mapping. The user's real
  // case: a finished task and an overdue task that both carry only a deadline.
  const tasks = [
    {
      ...projectedTask({
        id: 'tk_done_ms', title: '已完成的里程碑', status: 'done', due: '2026-10-13 16:00',
        project: { phase: 'done', days: null, severity: 'idle', text: '已完成', detail: '' },
      }),
      day: '2026-10-13',
    },
    {
      ...projectedTask({
        id: 'tk_late_ms', title: '逾期的里程碑', due: '2026-10-12 14:00',
        project: { phase: 'overdue', days: -2, severity: 'error', text: '逾期 2 天', detail: '' },
      }),
      day: '2026-10-12',
    },
  ]
  const gantt = exports.__internals.ganttRows(tasks, exports.__internals.ganttAxis(tasks, '2026-10-14', 'fortnight'), new Date('2026-10-14T15:10:00'))
  assert.ok(gantt.every((row) => row.milestone), 'both carry only a timed deadline')
  assert.deepEqual(gantt.map((row) => row.severity).sort(), ['error', 'success'])
  const byId = new Map(gantt.map((row) => [row.task.id, row.severity]))
  assert.equal(byId.get('tk_done_ms'), 'success', 'a finished milestone is a green block')
  assert.equal(byId.get('tk_late_ms'), 'error', 'an overdue milestone is a red block')

  // The stylesheet must define a green fill/bar and a red one, and no amber
  // hard-code on the milestone shape.
  const source = await readFile(CLIENT_PATH, 'utf8')
  // The three element kinds share one grouped selector, which is what keeps the
  // month grid and the board from drifting apart.
  assert.match(source, /\.dsc-chip--success,\.dsc-band--success,\.dsc-gantt-bar--success\{background:color-mix\(in srgb,var\(--dsw-alias-state-success-primary\)/)
  assert.match(source, /\.dsc-chip-fill--error,\.dsc-band-fill--error,\.dsc-gantt-fill--error\{background:var\(--dsw-alias-state-error-primary\)\}/)
  assert.match(source, /\.dsc-chip-fill--success,\.dsc-band-fill--success,\.dsc-gantt-fill--success\{background:var\(--dsw-alias-state-success-primary\)\}/)
  assert.doesNotMatch(source, /dsc-gantt-bar--milestone\{[^}]*state-warn-primary/, 'the milestone shape must not be hard-coded amber')
  // The calendar chips lost their old left-accent look.
  assert.doesNotMatch(source, /\.dsc-chip\{[^}]*border-left:3px solid/)
})

test('every registered component renders without throwing', async () => {
  const { exports } = await loadBundle()
  const fake = fakeClientContext()
  exports.apply(fake.ctx)
  for (const { options, Component } of fake.registrations) {
    const tree = Component(options.name === 'sidebar.panellist' ? { size: 18, active: false } : {})
    const markup = renderTree(tree)
    assert.equal(typeof markup, 'string', `${options.name} must render a tree`)
    if (options.name === 'sidebar.panellist') assert.ok(collectTypes(tree).includes('svg'), 'the sidebar entry renders an svg glyph')
  }
})

test('the panel renders host state and acknowledges reminders through fetch', async () => {
  const { exports, sandbox } = await loadBundle()
  const calls = []
  // Dates are anchored to the real clock: the gantt's "now" marker is painted
  // from the actual time, so a fixture frozen to one calendar day goes stale.
  const today = new Date()
  const dayKeyOf = (offset) => {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset)
    const pad = (value) => String(value).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  }
  const noon = `${dayKeyOf(0)} ${String(today.getHours()).padStart(2, '0')}:${String(today.getMinutes()).padStart(2, '0')}`
  const state = {
    ok: true,
    now: today.toISOString(),
    today: dayKeyOf(0),
    clock: noon,
    config: { leadDays: [3, 1], leadHours: [2], startLeadMinutes: 30, overdueDailyHour: 9, maxAlerts: 6, systemNotify: false },
    updatedAt: '2026-10-09T02:00:00.000Z',
    storeFile: '/tmp/task-calendar.json',
    stats: { total: 2, today: 1, doing: 0, overdue: 1, done: 0, upcoming: 0 },
    tasks: [
      {
        id: 'tk_1', title: '输出 Q4 预算初稿', status: 'todo', priority: 'high',
        start: null, due: dayKeyOf(-4), allDay: true, owner: '张三', notes: '含三张表',
        tags: ['预算'], source: { kind: 'minutes', title: '周会', date: dayKeyOf(0), ref: '' },
        createdAt: '2026-10-01 09:00', updatedAt: '2026-10-01 09:00', completedAt: null, fired: [],
        day: dayKeyOf(-4), project: { phase: 'overdue', days: -4, severity: 'error', text: '逾期 4 天', detail: '' },
      },
      {
        id: 'tk_2', title: '评审会', status: 'todo', priority: 'normal',
        start: `${dayKeyOf(0)} 09:00`, due: `${dayKeyOf(0)} 23:00`, allDay: false, owner: '', notes: '',
        tags: [], source: null, createdAt: dayKeyOf(-1), updatedAt: dayKeyOf(-1),
        completedAt: null, fired: [], day: dayKeyOf(0),
        project: { phase: 'today', days: 0, severity: 'warn', text: '今天到期', detail: '' },
      },
    ],
    alerts: [{
      key: `@tk_1:overdue:${dayKeyOf(0)}`, taskId: 'tk_1', kind: 'overdue', level: 'error',
      at: `${dayKeyOf(0)} 09:00`, title: '输出 Q4 预算初稿', text: `「输出 Q4 预算初稿」已逾期（应收于 ${dayKeyOf(-4)}）`,
      countdown: '逾期 4 天', owner: '张三', due: dayKeyOf(-4), started: null,
    }],
    staleKeys: [],
  }
  sandbox.fetch = async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body === undefined ? null : JSON.parse(init.body) })
    if (String(url).endsWith('/ack')) return { ok: true, status: 200, json: async () => ({ ok: true, touched: 1 }) }
    return { ok: true, status: 200, json: async () => state }
  }
  // `globalThis.fetch` is what the bundle closes over at call time.
  const internals = exports.__internals
  await internals.refresh()
  assert.equal(calls[0].url, '/dsh-task-calendar/state')

  const fake = fakeClientContext()
  exports.apply(fake.ctx)
  const panel = fake.registrations.find(({ options }) => options.name === 'main')
  const markup = renderTree(panel.Component({}))
  assert.match(markup, /输出 Q4 预算初稿/)
  assert.match(markup, /逾期 4 天/)
  assert.match(markup, /评审会/)
  assert.match(markup, /任务日历/)
  assert.match(markup, /知道了/)

  const overlay = fake.registrations.find(({ options }) => options.name === 'shell.overlay')
  const overlayMarkup = renderTree(overlay.Component({}))
  assert.match(overlayMarkup, /已逾期/)

  await internals.ackKeys([`@tk_1:overdue:${dayKeyOf(0)}`])
  const ack = calls.find((call) => call.url === '/dsh-task-calendar/ack')
  assert.deepEqual(ack.body, { keys: [`@tk_1:overdue:${dayKeyOf(0)}`] })
  assert.ok(calls.filter((call) => call.url === '/dsh-task-calendar/state').length >= 2, 'ack refreshes state')

  assert.equal(internals.humanDay('2026-10-09', '2026-10-09'), '今天')
  assert.equal(internals.humanDay('2026-10-10', '2026-10-09'), '明天')
  assert.equal(internals.splitTags('预算, 财务 张总').join('|'), '预算|财务|张总')
  const cells = internals.monthMatrix(2026, 9)
  assert.equal(cells.length, 42)
  assert.equal(cells[0].date.getDay(), 1, 'the grid starts on Monday')
  assert.equal(cells.filter((cell) => cell.inMonth).length, 31)
  assert.equal(cells.find((cell) => cell.key === '2026-10-09').inMonth, true)

  // The gantt board is part of the same panel: title, preset switches, bars and
  // the today line must all be in the tree.
  const classes = collectClasses(panel.Component({}))
  assert.ok(classes.includes('dsc-gantt'), 'the panel renders the gantt container')
  assert.match(markup, /甘特图 · 任务进度/)
  assert.match(markup, /两周/)
  assert.ok(classes.some((name) => name.startsWith('dsc-gantt-bar')), 'at least one task bar is drawn')
  assert.ok(classes.includes('dsc-gantt-now'), 'the today line is drawn')
  assert.ok(classes.some((name) => name.includes('dsc-gantt-fill')), 'the elapsed progress fill is drawn')
  assert.match(markup, /竖线=现在/)
  assert.match(markup, /一天/)
})

/** Build a projected task the way the host's /state payload shapes it. */
function projectedTask(overrides) {
  return {
    id: 'tk_x', title: 'task', status: 'todo', priority: 'normal',
    start: null, due: null, allDay: true, owner: '', notes: '', tags: [],
    source: null, createdAt: '2026-10-01 09:00', updatedAt: '2026-10-01 09:00',
    completedAt: null, fired: [], day: null,
    project: { phase: 'upcoming', days: 1, severity: 'info', text: '还剩 1 天', detail: '' },
    ...overrides,
  }
}

test('ganttAxis builds the four windows from the today key', async () => {
  const { exports } = await loadBundle()
  const { ganttAxis } = exports.__internals
  const tasks = [
    projectedTask({ start: '2026-10-02 09:00', due: '2026-10-03 18:00' }),
    projectedTask({ due: '2026-10-20' }),
  ]

  // 2026-10-14 is a Wednesday.
  const week = ganttAxis(tasks, '2026-10-14', 'week')
  assert.equal(week.days, 7)
  assert.equal(week.start.getDay(), 1, 'the week window starts on Monday')
  assert.equal(week.start.getDate(), 12)

  const fortnight = ganttAxis(tasks, '2026-10-14', 'fortnight')
  assert.equal(fortnight.days, 14)
  assert.equal(fortnight.start.getDate(), 11, 'three days back')
  assert.equal(new Date(fortnight.end.getTime() - 86_400_000).getDate(), 24, 'ten days ahead')

  const month = ganttAxis(tasks, '2026-10-14', 'month')
  assert.equal(month.start.getDate(), 1)
  assert.equal(month.days, 31)
  assert.equal(month.end.getMonth(), 10, 'the month window ends on 1 November')

  const all = ganttAxis(tasks, '2026-10-14', 'all')
  assert.equal(all.start.getDate(), 1, 'one day of padding before the earliest task')
  assert.equal(all.days, 21, '2026-10-01 .. 2026-10-21 is 20 days plus the closing day')

  // A window always covers today, even with no tasks at all.
  const empty = ganttAxis([], '2026-10-14', 'all')
  assert.ok(empty.start.getTime() <= new Date('2026-10-14T00:00:00').getTime())
  assert.ok(empty.end.getTime() > new Date('2026-10-14T00:00:00').getTime())
})

test('ganttRows lays spans, milestones and progress onto the axis', async () => {
  const { exports } = await loadBundle()
  const { ganttAxis, ganttRows } = exports.__internals
  const axis = ganttAxis([], '2026-10-14', 'fortnight') // 10-11 .. 10-25, 14 days
  const now = new Date('2026-10-14T14:36:00')

  const span = projectedTask({
    id: 'tk_span', title: '跨度任务', start: '2026-10-14 14:00', due: '2026-10-15 12:00',
    project: { phase: 'today', days: 0, severity: 'warn', text: '今天到期', detail: '' },
  })
  const late = projectedTask({
    id: 'tk_late', title: '逾期任务', due: '2026-10-05 10:00',
    project: { phase: 'overdue', days: -9, severity: 'error', text: '逾期 9 天', detail: '' },
  })
  const done = projectedTask({
    id: 'tk_done', title: '已完成', status: 'done', start: '2026-10-12 09:00', due: '2026-10-13 18:00',
    project: { phase: 'done', days: null, severity: 'idle', text: '已完成', detail: '' },
  })
  const floating = projectedTask({ id: 'tk_none', title: '未排期' })

  const rows = ganttRows([span, late, done, floating], axis, now)
  assert.equal(rows.length, 3, 'unscheduled tasks are left out of the chart')
  assert.deepEqual(rows.map((row) => row.task.id), ['tk_late', 'tk_span', 'tk_done'], 'most urgent first, then by time')

  const spanRow = rows.find((row) => row.task.id === 'tk_span')
  assert.equal(spanRow.milestone, false)
  // 10-14 14:00 is 3d14h into the window: 3.5833/14.
  assert.ok(Math.abs(spanRow.left - 0.25595) < 0.001, `left was ${spanRow.left}`)
  // …and it lasts 22h: 0.9167/14.
  assert.ok(Math.abs(spanRow.width - 0.06548) < 0.001, `width was ${spanRow.width}`)
  // At 14:36, 36 minutes of a 22h bar have elapsed.
  assert.ok(spanRow.progress > 0 && spanRow.progress < 0.03, `progress was ${spanRow.progress}`)
  assert.equal(spanRow.severity, 'warn')

  const lateRow = rows.find((row) => row.task.id === 'tk_late')
  assert.equal(lateRow.milestone, true, 'a timed deadline with no start is a milestone, not an invented span')
  assert.equal(lateRow.width, 0)
  assert.ok(lateRow.left < 0, 'the milestone sits before the window')
  assert.equal(lateRow.severity, 'error')
  // …and it sits on the deadline instant, not on the midnight that opens the day.
  const axisStart = axis.start.getTime()
  const expected = (new Date('2026-10-05T10:00:00').getTime() - axisStart) / (14 * 86_400_000)
  assert.ok(Math.abs(lateRow.left - expected) < 1e-9, `milestone left was ${lateRow.left}, expected ${expected}`)

  const doneRow = rows.find((row) => row.task.id === 'tk_done')
  assert.equal(doneRow.progress, 1, 'a finished task is fully filled')
  assert.equal(doneRow.done, true)
  assert.equal(doneRow.severity, 'success', 'a finished task is green, whatever its deadline says')

  // Colour contract: completed = green, overdue = red, at stake = amber.
  assert.equal(rows.find((row) => row.task.id === 'tk_late').severity, 'error', 'overdue is red')
  assert.equal(rows.find((row) => row.task.id === 'tk_span').severity, 'warn', 'due today is amber')
  const later = projectedTask({
    id: 'tk_later', due: '2026-10-30',
    project: { phase: 'upcoming', days: 16, severity: 'info', text: '还剩 16 天', detail: '' },
  })
  assert.equal(ganttRows([later], axis, now)[0].severity, 'info')

  // A task that has not started yet shows no progress.
  const future = projectedTask({ id: 'tk_future', start: '2026-10-20 09:00', due: '2026-10-21 18:00' })
  const futureRow = ganttRows([future], axis, now)[0]
  assert.equal(futureRow.progress, 0)

  // An overdue task with a span is fully filled (now is past its end).
  const past = projectedTask({ id: 'tk_past', start: '2026-10-11 09:00', due: '2026-10-12 09:00', status: 'doing' })
  assert.equal(ganttRows([past], axis, now)[0].progress, 1)
})

test('a day cell only renders chips that actually fit, so text is never sliced', async () => {
  const { exports } = await loadBundle()
  const { chipSlots, chipWindow } = exports.__internals

  // Row heights from "very short window" to "tall window", plus band space.
  // With CELL_TOP 19 / CELL_BOTTOM 3 / CHIP 16 / GAP 3 / LANE 17:
  // usable = h - 22 - bands, and L lines need L * 16 + (L - 1) * 3.
  assert.equal(chipSlots(20, 0), 0, 'a row with no usable height shows nothing')
  assert.equal(chipSlots(40, 0), 1)
  assert.equal(chipSlots(66, 0), 2, 'the minimum row still shows two lines')
  assert.equal(chipSlots(66, 17), 1, 'one band lane leaves a line')
  assert.equal(chipSlots(72, 34), 1, 'two band lanes leave a line — the case that used to drop tasks')
  assert.equal(chipSlots(100, 34), 2)
  assert.equal(chipSlots(120, 0), 5)
  assert.equal(chipSlots(400, 0), 6, 'the slot count is capped')
  assert.equal(chipSlots(Number.NaN, 0), 0, 'an unmeasured row degrades to no chips')

  // The rendered content must never exceed the room available, at any height.
  const CHIP = 16
  const GAP = 3
  const MORE = 16
  // The counter is its own line, so `show` chips plus a counter occupy
  // `show + 1` lines in the flex column.
  const need = (show, more) => (show + (more ? 1 : 0)) * CHIP + Math.max(0, show + (more ? 1 : 0) - 1) * GAP
  for (let rowHeight = 30; rowHeight <= 260; rowHeight += 1) {
    for (const bandSpace of [0, 17, 34, 51]) {
      const slots = chipSlots(rowHeight, bandSpace)
      const available = Math.max(0, rowHeight - 19 - bandSpace - 3)
      for (let count = 0; count <= 10; count += 1) {
        const window = chipWindow(count, slots)
        assert.ok(
          need(window.show, window.more) <= available,
          `row ${rowHeight} band ${bandSpace} count ${count}: needs ${need(window.show, window.more)} but has ${available}`,
        )
        assert.ok(window.show <= count, 'never invents chips')
        assert.ok(window.show + window.hidden === count, 'every task is either shown or counted')
      }
    }
  }

  // Behaviours worth naming explicitly (the bundle's objects live in another
  // realm, so compare a plain projection rather than the object itself).
  const w = (count, slots) => {
    const value = chipWindow(count, slots)
    return `${value.show}/${value.hidden}/${value.more}`
  }
  assert.equal(w(2, 3), '2/0/false')
  assert.equal(w(6, 3), '2/4/true', 'the counter line costs a chip slot')
  // One slot names the first task and folds the backlog onto its own line.
  const one = chipWindow(6, 1)
  assert.equal(`${one.show}/${one.hidden}/${one.more}/${one.inline === true}`, '1/5/false/true')
  assert.equal(chipWindow(1, 1).inline, undefined, 'nothing to fold when the day fits')
  assert.equal(w(6, 0), '0/6/false', 'with no room nothing is drawn')
})

test('the header counts what is actually under way', async () => {
  const { exports } = await loadBundle()
  const { liveStats } = exports.__internals
  const now = new Date(2026, 9, 20, 11, 22)
  const make = (overrides) => projectedTask({ due: null, start: null, ...overrides })

  const tasks = [
    // Started yesterday, due tomorrow — the number that used to always read 0.
    make({ id: 'a', title: '进行中', start: '2026-10-19 09:00', due: '2026-10-21 18:00' }),
    make({ id: 'b', title: '未开始', start: '2026-10-21 09:00', due: '2026-10-23 18:00' }),
    make({ id: 'c', title: '已逾期', start: '2026-10-18 09:00', due: '2026-10-19 09:00' }),
    make({ id: 'd', title: '已完成', status: 'done', start: '2026-10-19 09:00', due: '2026-10-21 18:00' }),
    make({ id: 'e', title: '今天截止', due: '2026-10-20 18:00' }),
    make({ id: 'f', title: '明天截止', due: '2026-10-21 18:00' }),
  ]
  const stats = liveStats(tasks, now)
  assert.equal(stats.total, 6)
  assert.equal(stats.doing, 2, 'running work + the deadline-only task whose day has arrived')
  assert.equal(stats.overdue, 1)
  assert.equal(stats.done, 1)
  assert.equal(stats.today, 1)

  // The counter tracks the clock, so the same list reads differently two days
  // later: b is now the running one, and four of the six have gone late.
  const later = liveStats(tasks, new Date(2026, 9, 22, 9, 0))
  assert.equal(later.doing, 1, 'b (10-21 → 10-23) is the one under way')
  assert.equal(later.overdue, 4, 'a, c, e and f are past their deadlines')
})

test('gantt bars stay labelled and also explain themselves in a hover card', async () => {
  const { exports } = await loadBundle()
  const { ganttCard, ganttAxis, ganttRows, taskTone } = exports.__internals

  const axis = ganttAxis([], '2026-10-14', 'all')
  const span = projectedTask({
    id: 'tk_span', title: '跨天改造', status: 'doing', priority: 'high', owner: '张三',
    start: '2026-10-19 09:00', due: '2026-10-21 18:00', tags: ['Redis'],
    notes: '先改 key 归口再联调',
    source: { kind: 'minutes', title: '下周开发任务', date: '2026-10-16', ref: '' },
    project: { phase: 'upcoming', days: 3, severity: 'warn', text: '还剩 3 天', detail: '' },
  })
  const card = ganttCard(span, ganttRows([span], axis)[0])
  assert.equal(card.title, '跨天改造')
  assert.equal(card.countdown, '还剩 3 天')
  assert.equal(card.tone, taskTone(span))
  const fact = (label) => card.facts.find((entry) => entry.label === label)?.value
  assert.equal(fact('状态'), '进行中')
  assert.equal(fact('开始'), '2026-10-19 09:00')
  assert.equal(fact('截止'), '2026-10-21 18:00')
  assert.equal(fact('时长'), '2 天 9 小时', 'the card spells out how long the bar is')
  assert.equal(fact('负责'), '张三')
  assert.equal(fact('优先级'), '高')
  assert.equal(fact('来源'), '下周开发任务 · 2026-10-16')
  assert.equal(fact('标签'), 'Redis')
  assert.equal(card.notes, '先改 key 归口再联调')

  // A deadline-only task says so, and an all-day one is named as such.
  const milestoneCard = ganttCard(
    projectedTask({ id: 'tk_ms', title: '截止点', due: '2026-10-14 18:00' }),
    ganttRows([projectedTask({ id: 'tk_ms', title: '截止点', due: '2026-10-14 18:00' })], axis)[0],
  )
  assert.equal(milestoneCard.facts.find((entry) => entry.label === '类型')?.value, '只有截止时刻')
  const allDay = projectedTask({ id: 'tk_ad', title: '全天事', due: '2026-10-14' })
  assert.equal(ganttCard(allDay, ganttRows([allDay], axis)[0]).facts.find((entry) => entry.label === '类型')?.value, '全天')

  // Sub-hour durations stay readable.
  const short = projectedTask({ id: 'tk_short', title: '短会', start: '2026-10-14 16:00', due: '2026-10-14 16:45' })
  assert.equal(ganttCard(short, ganttRows([short], axis)[0]).facts.find((entry) => entry.label === '时长')?.value, '45 分钟')

  // A wide bar still labels itself (the text the user asked back), the card is
  // additive detail on hover, and every bar keeps a readable name.
  const source = await readFile(CLIENT_PATH, 'utf8')
  assert.match(source, /dsc-gantt-label\{/, 'the in-bar label is back')
  assert.match(source, /className: 'dsc-gantt-label' \}, isDayView \? span : \(task\.project\?\.text \?\? ''\)/)
  assert.match(source, /dsc-hover-card\{/, 'the hover card is styled')
  assert.match(source, /onMouseEnter: \(event\) => \{ showCard\(task, event\) \}/)
})

test('a week with two bands still shows its day tasks', async () => {
  const { exports } = await loadBundle()
  const { weekLayout, chipSlots, chipWindow, monthMatrix } = exports.__internals

  // Recreates the reported case: 10-19..10-25 held two overlapping multi-day
  // tasks AND a single-day task on 10-23. An earlier fix reserved a chip line by
  // dropping a band lane, so only one band showed; a later one sized the row to
  // its content instead, so nothing has to be dropped at all.
  const TOP = 19
  const BOTTOM = 3
  const CHIP = 16
  const GAP = 3
  const LANE = 17
  const CAP = 3
  const ROW_MIN = 66
  const ROW_MAX = 216
  const MAX_LANES = 3

  const cells = monthMatrix(2026, 9)
  const week = cells
    .slice(cells.findIndex((cell) => cell.key === '2026-10-19'), cells.findIndex((cell) => cell.key === '2026-10-19') + 7)
    .map((cell) => cell.key)
  const tasks = [
    projectedTask({ id: 'tk_hangup', title: '改造 A', start: '2026-10-19', due: '2026-10-21' }),
    projectedTask({ id: 'tk_health', title: '改造 B', start: '2026-10-21', due: '2026-10-23' }),
    projectedTask({ id: 'tk_redis', title: 'Redis 自查', start: '2026-10-23 09:00', due: '2026-10-23 18:00' }),
  ]

  const layout = weekLayout(week, tasks, MAX_LANES)
  assert.equal(layout.lanes, 2, 'the two overlapping spans genuinely need two lanes')
  assert.equal(layout.hiddenBands, 0, 'and both are drawn')
  const busiest = Math.max(0, ...[...layout.singles.values()].map((list) => list.length))
  const chipLines = Math.min(busiest, CAP)
  const bandSpace = layout.lanes * LANE
  const contentBox = TOP + BOTTOM + bandSpace + chipLines * CHIP + (chipLines - 1) * GAP
  const rowBox = Math.max(ROW_MIN, Math.min(ROW_MAX, contentBox))
  const slots = chipSlots(rowBox, bandSpace)

  assert.equal(busiest, 1, 'one single-day task on 10-23')
  assert.ok(slots >= 1, `the row must still afford a chip line (got ${slots} at ${rowBox}px)`)
  assert.equal(chipWindow(1, slots).show, 1, 'so the Redis task is visible next to both bands')

  // The row is never taller than its content demands, and never shorter than the
  // floor — that is what keeps the month from silently dropping work.
  assert.ok(rowBox >= ROW_MIN && rowBox <= ROW_MAX)
  assert.ok(rowBox >= contentBox - 0.001, 'growth covers the content')
})

test('bands never squeeze a day task out of sight on a short row', async () => {
  const { exports } = await loadBundle()
  const { weekLayout, chipSlots, chipWindow, monthMatrix } = exports.__internals

  const CELL_TOP = 22
  const CELL_BOTTOM = 4
  const CHIP = 21
  const CHIP_GAP = 4
  const LANE = 16
  const MAX_LANES = 3

  const cells = monthMatrix(2026, 9)
  const week = cells.slice(cells.findIndex((cell) => cell.key === '2026-10-19'), cells.findIndex((cell) => cell.key === '2026-10-19') + 7).map((cell) => cell.key)

  // The real regression: 10-23 held a single-day task while the row also had two
  // multi-day bands. Reserving nothing let the bands eat the whole cell, so the
  // task rendered nowhere at all.
  const tasks = [
    projectedTask({ id: 'tk_band_a', title: '跨天A', start: '2026-10-19', due: '2026-10-21' }),
    projectedTask({ id: 'tk_band_b', title: '跨天B', start: '2026-10-21', due: '2026-10-23' }),
    projectedTask({ id: 'tk_single', title: 'Redis 自查', start: '2026-10-23 09:00', due: '2026-10-23 18:00' }),
  ]

  for (let rowHeight = 56; rowHeight <= 200; rowHeight += 1) {
    const hasSingles = weekLayout(week, tasks).singles.size > 0
    const budget = hasSingles
      ? Math.floor((rowHeight - CELL_TOP - CHIP - CHIP_GAP - CELL_BOTTOM) / LANE)
      : MAX_LANES
    const layout = weekLayout(week, tasks, Math.max(0, Math.min(MAX_LANES, budget)))
    const slots = chipSlots(rowHeight, layout.lanes * LANE)
    const singles = layout.singles.get('2026-10-23') ?? []
    assert.equal(singles.length, 1, 'the single-day task belongs to 10-23')
    const window = chipWindow(singles.length, slots)
    assert.ok(
      window.show >= 1,
      `row ${rowHeight}px: the day task disappeared (lanes ${layout.lanes}, slots ${slots})`,
    )
    // Nothing may be dropped without a marker: bands over the budget and chips
    // over the slots both have to be countable in the UI.
    assert.equal(layout.bands.length + layout.hiddenBands, 2, 'every band is either drawn or counted')
  }

  // Below the budget the excess is reported instead of silently dropped.
  const tight = weekLayout(week, tasks, 1)
  assert.equal(tight.lanes, 1)
  assert.equal(tight.hiddenBands, 1, 'the second band is counted, not lost')
  assert.ok(tight.bands[0].endCol >= tight.bands[0].col)

  // An ample budget keeps both lanes, as the taller window does.
  const roomy = weekLayout(week, tasks, 3)
  assert.equal(roomy.lanes, 2)
  assert.equal(roomy.hiddenBands, 0)

  // With no single-day work the row may spend every lane it wants.
  const bandsOnly = weekLayout(week, tasks.slice(0, 2), 3)
  assert.equal(chipSlots(68, bandsOnly.lanes * LANE) >= 0, true)
})

test('calendar blocks carry no text and share the hover card with the gantt', async () => {
  const { exports, sandbox } = await loadBundle()
  const { taskTone, placeCard, ganttCard } = exports.__internals
  // The month grid only draws chips once it has a projection to draw.
  sandbox.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true, today: '2026-10-14', clock: '2026-10-14 10:00', storeFile: '/tmp/x.json',
      config: { leadDays: [3], leadHours: [2], startLeadMinutes: 30, overdueDailyHour: 9, maxAlerts: 6, systemNotify: false },
      stats: { total: 3, today: 1, doing: 0, overdue: 0, done: 0, upcoming: 1 },
      alerts: [], staleKeys: [],
      tasks: [
        { ...projectedTask({ id: 'tk_a', title: '任务甲', start: '2026-10-14 09:00', due: '2026-10-14 10:00' }), day: '2026-10-14' },
        { ...projectedTask({ id: 'tk_b', title: '任务乙', start: '2026-10-19', due: '2026-10-21' }), day: '2026-10-19' },
      ],
    }),
  })
  await exports.__internals.refresh()

  const source = await readFile(CLIENT_PATH, 'utf8')
  // The month grid draws tasks as unlabelled colour: the chip renders only a
  // folded "+N", and the spanning band renders nothing at all.
  // The rendered calendar blocks must contain no visible text. Assert on the
  // real element tree: the chip's children are only a folded counter, and the
  // spanning band has no children at all.
  const fake = fakeClientContext()
  exports.apply(fake.ctx)
  const panel = fake.registrations.find(({ options }) => options.name === 'main')
  const tree = panel.Component({ dayTasksSeed: true })
  const chips = collectClasses(tree).filter((name) => name.startsWith('dsc-chip '))
  assert.ok(chips.length > 0, 'the month grid draws chips')
  const chipNodes = []
  ;(function walk(node) {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) { for (const child of node) walk(child); return }
    if (typeof node.type === 'function') { walk(node.type(node.props)); return }
    if (typeof node.props?.className === 'string' && node.props.className.startsWith('dsc-chip ')) chipNodes.push(node)
    walk(node.props?.children)
  })(tree)
  for (const chip of chipNodes) {
    const visible = renderTree(chip.props.children).trim()
    assert.match(visible, /^(\+\d+)?$/, `a chip must show no title, got ${JSON.stringify(visible)}`)
    assert.equal(typeof chip.props['aria-label'], 'string', 'but it keeps a readable name')
    assert.equal(chip.props.title, undefined, 'the native tooltip is gone in favour of the card')
    assert.equal(typeof chip.props.onMouseEnter, 'function')
  }

  // The card content is shared, so a calendar hover shows the same detail the
  // gantt board does — including data the calendar itself never rendered.
  const task = projectedTask({
    id: 'tk_shared', title: '改造 HangupReasonController', status: 'doing', priority: 'high', owner: '张三',
    start: '2026-10-19 09:00', due: '2026-10-21 18:00', tags: ['开发', 'Redis'],
    notes: '先改 key 归口',
    source: { kind: 'minutes', title: '下周开发任务', date: '2026-10-16', ref: '' },
    project: { phase: 'upcoming', days: 3, severity: 'warn', text: '还剩 3 天', detail: '' },
  })
  const card = ganttCard(task)
  assert.equal(card.title, '改造 HangupReasonController')
  assert.equal(card.countdown, '还剩 3 天')
  assert.equal(card.tone, taskTone(task))
  assert.deepEqual([...card.facts].map((entry) => entry.label), ['状态', '开始', '截止', '时长', '负责', '优先级', '来源', '标签'])

  // Placement keeps the card inside the panel, flipping near either edge.
  const box = { left: 300, top: 100, width: 900, height: 500 }
  const middle = placeCard(box, { clientX: 700, clientY: 300 })
  assert.deepEqual([middle.x, middle.y], [414, 214], 'offset from the pointer')
  const corner = placeCard(box, { clientX: 1180, clientY: 580 })
  assert.ok(corner.x <= box.width - 300 - 4 && corner.y <= box.height - 170 - 4, 'clamped inside the panel')
  assert.ok(corner.x >= 4 && corner.y >= 4)
})

test('every block drawn as a button resets the native border', async () => {
  const { exports, sandbox } = await loadBundle()
  // The panel only draws its blocks once it has a projection.
  sandbox.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true, today: '2026-10-14', clock: '2026-10-14 10:00', storeFile: '/tmp/x.json',
      config: { leadDays: [3], leadHours: [2], startLeadMinutes: 30, overdueDailyHour: 9, maxAlerts: 6, systemNotify: false },
      stats: { total: 2, today: 1, doing: 0, overdue: 0, done: 0, upcoming: 1 },
      alerts: [], staleKeys: [],
      tasks: [
        { ...projectedTask({ id: 'tk_a', title: '任务甲', start: '2026-10-14 09:00', due: '2026-10-14 10:00' }), day: '2026-10-14' },
        { ...projectedTask({ id: 'tk_b', title: '任务乙', start: '2026-10-19', due: '2026-10-21' }), day: '2026-10-19' },
      ],
    }),
  })
  await exports.__internals.refresh()

  const fake = fakeClientContext()
  exports.apply(fake.ctx)
  const panel = fake.registrations.find(({ options }) => options.name === 'main')
  const tree = panel.Component({})

  // Collect every class name that ends up on a <button> in the month panel.
  const buttonClasses = new Set()
  const scan = (node) => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) { for (const child of node) scan(child); return }
    if (typeof node.type === 'function') {
      if (node.type.name !== 'CalendarPanel') return
      scan(node.type(node.props))
      return
    }
    if (node.type === 'button' && typeof node.props?.className === 'string') {
      for (const cls of node.props.className.split(' ')) buttonClasses.add(cls)
    }
    scan(node.props?.children)
  }
  scan(tree)
  assert.ok(buttonClasses.size > 0, 'the panel draws buttons')

  // Parse the stylesheet into class -> declarations.
  const source = await readFile(CLIENT_PATH, 'utf8')
  const css = source.slice(source.indexOf('const CSS = `') + 'const CSS = `'.length)
  const sheet = css.slice(0, css.indexOf('\n`'))
  const rules = new Map()
  for (const line of sheet.split('\n')) {
    if (!line.includes('{')) continue
    const [selectors, rest] = line.split('{')
    for (const selector of selectors.split(',')) {
      const key = selector.trim()
      rules.set(key, (rules.get(key) ?? '') + rest)
    }
  }

  // A <button> without a border reset makes the browser paint its own edge —
  // that is what left the spanning bands outlined while the equally styled
  // gantt <div>s looked clean.
  // A modifier class (`dsc-band--info`) inherits from its base (`dsc-band`), so
  // resolve the cascade for the border reset instead of demanding it per class.
  const declarationsFor = (cls) => {
    const base = cls.replace(/--.*$/, '')
    return (rules.get('.' + base) ?? '') + (rules.get('.' + cls) ?? '')
  }
  for (const cls of buttonClasses) {
    const base = cls.replace(/--.*$/, '')
    const own = rules.get('.' + base) ?? rules.get('.' + cls)
    if (own === undefined) continue
    const paintsItself = /background:color-mix|background:var\(--dsw-alias-state/.test(declarationsFor(cls))
    if (!paintsItself) continue // plain toolbar buttons keep the user-agent edge
    assert.match(
      declarationsFor(cls),
      /(^|;)\s*(border:0|border:none)/,
      `${cls} is a <button> that paints its own background and must reset the native border in .${base}`,
    )
  }
  assert.match(rules.get('.dsc-band'), /border:0/)
  assert.match(rules.get('.dsc-chip'), /border:0/)
})

test('multi-day tasks span the month grid as one continuous band', async () => {
  const { exports } = await loadBundle()
  const { taskDayRange, weekLayout, monthMatrix } = exports.__internals

  // The bundle lives in its own vm realm, so compare the two fields by value.
  const rangeOf = (task) => {
    const range = taskDayRange(task)
    return range === null ? null : `${range.from}..${range.to}`
  }
  // A range is inclusive, and a deadline landing exactly at midnight does not
  // invent a second day.
  assert.equal(rangeOf(projectedTask({ start: '2026-10-14 14:30', due: '2026-10-15 12:00' })), '2026-10-14..2026-10-15')
  assert.equal(rangeOf(projectedTask({ due: '2026-10-05' })), '2026-10-05..2026-10-05')
  assert.equal(rangeOf(projectedTask({ start: '2026-10-14 09:00' })), '2026-10-14..2026-10-14')
  assert.equal(rangeOf(projectedTask({ start: '2026-10-16 20:00', due: '2026-10-17 00:00' })), '2026-10-16..2026-10-16')
  assert.equal(rangeOf(projectedTask({})), null)

  const cells = monthMatrix(2026, 9)
  const weekOf = (monday) => {
    const index = cells.findIndex((cell) => cell.key === monday)
    return cells.slice(index, index + 7).map((cell) => cell.key)
  }

  // A task covering 10-14 and 10-15 is ONE band across two columns, and it is
  // no longer repeated as a chip on its first day.
  const spanning = projectedTask({ id: 'tk_span', title: '跨天任务', start: '2026-10-14 14:30', due: '2026-10-15 12:00' })
  const single = projectedTask({ id: 'tk_single', title: '单日任务', start: '2026-10-14 16:00', due: '2026-10-14 17:00' })
  const layout = weekLayout(weekOf('2026-10-12'), [spanning, single])
  assert.equal(layout.lanes, 1)
  assert.equal(layout.bands.length, 1)
  const band = layout.bands[0]
  assert.equal(band.task.id, 'tk_span')
  assert.equal(band.col, 2, '10-14 is the third column of a Monday-first week')
  assert.equal(band.endCol, 3, 'and it runs through 10-15')
  assert.equal(band.lane, 0)
  assert.equal(band.roundLeft, true)
  assert.equal(band.roundRight, true)
  assert.deepEqual([...layout.singles.get('2026-10-14')].map((task) => task.id), ['tk_single'], 'the spanning task is not repeated as a chip')
  assert.equal(layout.singles.get('2026-10-15'), undefined)

  // A task crossing a week boundary stays open on that edge, so the two rows
  // read as one bar.
  const across = projectedTask({ id: 'tk_across', title: '跨周', start: '2026-10-16 09:00', due: '2026-10-20 18:00' })
  const first = weekLayout(weekOf('2026-10-12'), [across]).bands[0]
  const second = weekLayout(weekOf('2026-10-19'), [across]).bands[0]
  assert.equal(first.col, 4)
  assert.equal(first.endCol, 6, 'clamped to the end of the row')
  assert.equal(first.roundLeft, true, 'the real start keeps its round cap')
  assert.equal(first.roundRight, false, 'the row boundary stays open')
  assert.equal(second.col, 0)
  assert.equal(second.endCol, 1)
  assert.equal(second.roundLeft, false, 'the continuation keeps a flat edge')
  assert.equal(second.roundRight, true)

  // Overlapping bands take separate lanes; a band that starts after another one
  // ended reuses that lane.
  const overlapping = [
    projectedTask({ id: 'a', start: '2026-10-19', due: '2026-10-21' }),
    projectedTask({ id: 'b', start: '2026-10-19', due: '2026-10-20' }),
    projectedTask({ id: 'c', start: '2026-10-22', due: '2026-10-23' }),
  ]
  const packed = weekLayout(weekOf('2026-10-19'), overlapping)
  const laneOf = (id) => packed.bands.find((entry) => entry.task.id === id).lane
  assert.equal(laneOf('a'), 0)
  assert.equal(laneOf('b'), 1, 'b overlaps a and needs its own lane')
  assert.equal(laneOf('c'), 0, 'c starts after a ended and reuses lane 0')
  assert.equal(packed.lanes, 2)

  // A task outside this row contributes nothing to it.
  const far = projectedTask({ id: 'tk_far', title: '别的周', start: '2026-11-10', due: '2026-11-12' })
  const empty = weekLayout(weekOf('2026-10-12'), [far])
  assert.equal(empty.bands.length, 0)
  assert.equal(empty.singles.size, 0)
})

test('the one-day window is minute-accurate and handles all-day tasks', async () => {
  const { exports } = await loadBundle()
  const { ganttAxis, ganttRows } = exports.__internals

  const axis = ganttAxis([], '2026-10-14', 'day', '2026-10-14')
  assert.equal(axis.granularity, 'hour', 'the day window is hour-granular')
  assert.equal(axis.days, 1)
  assert.equal(axis.pxPerGrid, 52, 'one grid line per hour')
  assert.equal(axis.pxPerDay, 24 * 52, 'a full day is 24 hourly slots')
  assert.equal(axis.start.getHours(), 0)
  assert.equal(axis.end.getTime() - axis.start.getTime(), 86_400_000)
  // The window follows the anchor day, defaulting to today.
  assert.equal(axis.start.getDate(), 14)
  assert.equal(ganttAxis([], '2026-10-14', 'day', '2026-10-16').start.getDate(), 16)
  assert.equal(ganttAxis([], '2026-10-14', 'day').start.getDate(), 14)

  const now = new Date('2026-10-14T15:53:00')
  const tasks = [
    // 09:15 → 10:45 is 1h30m of a 24h day: the whole point of this view.
    projectedTask({ id: 'tk_a', title: '早会', start: '2026-10-14 09:15', due: '2026-10-14 10:45' }),
    // A timed deadline with no start: a milestone on that minute.
    projectedTask({ id: 'tk_b', title: '截止点', due: '2026-10-14 18:00' }),
    // A date with no time: an all-day commitment covering the whole day.
    projectedTask({ id: 'tk_c', title: '全天事', due: '2026-10-14' }),
    // A span that runs past midnight is clamped by the renderer, flagged here.
    projectedTask({ id: 'tk_d', title: '跨夜', start: '2026-10-14 22:00', due: '2026-10-15 08:00' }),
    // Yesterday's task must not claim a row in today's window.
    projectedTask({ id: 'tk_e', title: '昨天的事', start: '2026-10-13 09:00', due: '2026-10-13 10:00' }),
    // Unscheduled work has no position here either.
    projectedTask({ id: 'tk_f', title: '未排期' }),
  ]
  const rows = ganttRows(tasks, axis, now)
  const byId = new Map(rows.map((row) => [row.task.id, row]))
  assert.equal(rows.length, 5, 'the unscheduled task is left out')

  const quarterPastNine = (9.25 / 24)
  const a = byId.get('tk_a')
  assert.ok(Math.abs(a.left - quarterPastNine) < 1e-9, `09:15 lands at ${a.left}`)
  assert.ok(Math.abs(a.width - (1.5 / 24)) < 1e-9, 'a 90-minute task is 1.5/24 of the day')
  assert.equal(a.milestone, false)
  assert.ok(Math.abs(a.progress - 1) < 1e-9, 'by 15:53 the 09:15–10:45 slot is fully elapsed')

  const b = byId.get('tk_b')
  assert.equal(b.milestone, true)
  assert.equal(b.width, 0)
  assert.ok(Math.abs(b.left - (18 / 24)) < 1e-9, 'the milestone sits on 18:00, not on midnight')

  const c = byId.get('tk_c')
  assert.equal(c.allDay, true, 'a date without a time is all-day')
  assert.equal(c.milestone, false, 'all-day work is a block, not a point')
  assert.equal(c.left, 0)
  assert.equal(c.width, 1, 'all-day covers the entire window')

  const d = byId.get('tk_d')
  assert.equal(d.offscreen, false)
  assert.ok(Math.abs(d.left - (22 / 24)) < 1e-9)
  assert.ok(Math.abs(d.left + d.width - 1 - (8 / 24)) > 0, 'the tail extends past this window')
  assert.ok(d.left + d.width > 1, 'the renderer clamps it to the right edge')

  const e = byId.get('tk_e')
  assert.equal(e.offscreen, true, "yesterday's task is outside today's window")
  assert.equal(byId.get('tk_f'), undefined)

  // The minute that matters: a one-minute task still gets a positive offset.
  const tiny = projectedTask({ id: 'tk_tiny', start: '2026-10-14 14:37', due: '2026-10-14 14:38' })
  const tinyRow = ganttRows([tiny], axis, now)[0]
  assert.ok(Math.abs(tinyRow.left - ((14 * 60 + 37) / 1440)) < 1e-9, 'minute-level start')
  assert.ok(tinyRow.width > 0 && tinyRow.width < 1 / 1000, 'a one-minute bar keeps a tiny non-zero width')
})
