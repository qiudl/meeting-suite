/**
 * Local HTTP surface for the task-calendar plugin's browser half.
 *
 * The panel is a hand-written client bundle: it cannot use the generated Typert
 * Remote channel (that assembly is fixed at build time), so the host half claims
 * one prefix route on `ctx.webServer` and the bundle talks to it with plain
 * `fetch`. Everything is loopback-only, same-origin, and JSON in/JSON out.
 *
 * Routes (all under the registered prefix):
 *   GET    {prefix}/health          — liveness probe
 *   GET    {prefix}/state           — the whole projection the panel renders
 *   POST   {prefix}/tasks           — create one task
 *   PATCH  {prefix}/tasks/{id}      — patch one task (POST also accepted)
 *   DELETE {prefix}/tasks/{id}      — delete one task
 *   POST   {prefix}/ack             — acknowledge delivered reminder keys
 *   POST   {prefix}/config          — update the reminder policy
 *
 * @module dsh-plugin-task-calendar/server
 */

import { formatDay, formatMoment } from './dates.js'
import { liveReminder, newId, projectTask, summarize } from './model.js'

/** Registered prefix; the client builds its URLs from the same constant. */
export const ROUTE_PREFIX = '/dsh-task-calendar'

/** One JSON response. */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** Read a JSON request body (bounded). */
async function readJsonBody(req, limit = 2 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('body must be an object')
    return parsed
  } catch (error) {
    throw new Error(`请求体不是合法 JSON：${String(error?.message ?? error)}`)
  }
}

/** Only the loopback interface may reach these routes. */
function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** Project one stored task for the panel. */
export function projectForPanel(task, now) {
  const project = projectTask(task, now)
  return {
    ...task,
    day: (task.start ?? task.due ?? '').slice(0, 10) || null,
    project,
  }
}

/**
 * Build the full state payload: tasks with their live countdown, pending
 * reminders, and the aggregate counters.
 * @param store - the plugin's TaskStore.
 * @param now - reference moment.
 * @returns the `/state` payload.
 */
export function buildState(store, now = new Date()) {
  const snapshot = store.snapshot()
  const tasks = snapshot.tasks.map((task) => projectForPanel(task, now))
  const alerts = []
  const staleKeys = []
  for (const task of snapshot.tasks) {
    const { alert, stale } = liveReminder(task, now, snapshot.config)
    staleKeys.push(...stale)
    if (alert !== null) alerts.push(alert)
  }
  const weight = { error: 0, warn: 1, info: 2 }
  alerts.sort((a, b) => {
    const delta = (weight[a.level] ?? 3) - (weight[b.level] ?? 3)
    return delta !== 0 ? delta : (a.at < b.at ? -1 : 1)
  })
  return {
    ok: true,
    now: now.toISOString(),
    today: formatDay(now),
    clock: formatMoment(now),
    config: snapshot.config,
    updatedAt: snapshot.updatedAt,
    storeFile: store.file,
    stats: summarize(snapshot.tasks, now),
    tasks,
    alerts: alerts.slice(0, snapshot.config.maxAlerts),
    deferredAlerts: Math.max(0, alerts.length - snapshot.config.maxAlerts),
    staleKeys,
  }
}

/**
 * Register the plugin's routes.
 * @param ctx - Cordis context carrying `webServer`.
 * @param store - the plugin's TaskStore.
 * @returns a disposer removing the route.
 */
export function registerRoutes(ctx, store) {
  const handler = async (req, res) => {
    try {
      if (!isLoopback(req)) {
        sendJson(res, 403, { ok: false, error: '仅允许本机访问' })
        return
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const path = url.pathname
      const rest = path.slice(ROUTE_PREFIX.length).replace(/^\/+/, '')
      const segments = rest === '' ? [] : rest.split('/')
      const method = req.method ?? 'GET'
      await store.load()

      if (segments.length === 1 && segments[0] === 'health') {
        sendJson(res, 200, { ok: true, plugin: 'dsh-plugin-task-calendar', file: store.file })
        return
      }

      if (segments.length === 1 && segments[0] === 'state' && method === 'GET') {
        sendJson(res, 200, buildState(store))
        return
      }

      if (segments.length === 1 && segments[0] === 'tasks' && method === 'POST') {
        const body = await readJsonBody(req)
        if (body.task === undefined && body.title === undefined) throw new Error('缺少 task 或 title')
        const raw = body.task ?? body
        const task = await store.add({ ...raw, id: raw.id ?? newId() })
        sendJson(res, 200, { ok: true, task: projectForPanel(task, new Date()) })
        return
      }

      if (segments[0] === 'tasks' && segments.length === 2) {
        const id = decodeURIComponent(segments[1])
        if (method === 'PATCH' || method === 'POST' || method === 'PUT') {
          const body = await readJsonBody(req)
          const updated = await store.patch(id, body.task ?? body)
          sendJson(res, 200, { ok: true, task: projectForPanel(updated, new Date()) })
          return
        }
        if (method === 'DELETE') {
          const removed = await store.remove(id)
          sendJson(res, removed === null ? 404 : 200, removed === null ? { ok: false, error: '未找到任务' } : { ok: true, id })
          return
        }
      }

      if (segments.length === 1 && segments[0] === 'ack' && method === 'POST') {
        const body = await readJsonBody(req)
        const keys = Array.isArray(body.keys) ? body.keys : []
        const touched = await store.ack(keys)
        sendJson(res, 200, { ok: true, touched })
        return
      }

      if (segments.length === 1 && segments[0] === 'config' && method === 'POST') {
        const body = await readJsonBody(req)
        const config = await store.setConfig(body.config ?? body)
        sendJson(res, 200, { ok: true, config })
        return
      }

      sendJson(res, 404, { ok: false, error: `未知接口：${method} ${path}` })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      sendJson(res, 400, { ok: false, error: message })
    }
  }

  return ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler })
}
