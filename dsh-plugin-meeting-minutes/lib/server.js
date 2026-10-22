/**
 * Local HTTP surface for the meeting-minutes plugin's browser half.
 *
 * The panel is a hand-written client bundle: it cannot use the generated Typert
 * Remote channel (that assembly is fixed at build time), so the host half claims
 * one prefix route on `ctx.webServer` and the bundle talks to it with plain
 * `fetch`. Everything is loopback-only, same-origin, and JSON in/JSON out — the
 * transcription route is the single binary exception (canonical 16kHz WAV).
 *
 * @module dsh-plugin-meeting-minutes/server
 */

import { formatMoment, isGenericTitle, localDay, projectMeeting, todoProgress } from './model.js'
import { sortMeetings } from './store.js'
import { exportMeeting } from './export.js'

/** Registered prefix; the client builds its URLs from the same constant. */
export const ROUTE_PREFIX = '/dsh-meeting'

/** JSON response helper. */
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

/** Read a raw binary body (bounded). */
async function readRawBody(req, limit = 16 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error(`音频片段过大（超过 ${Math.round(limit / 1024 / 1024)}MB），请缩短切片长度。`)
    chunks.push(chunk)
  }
  return new Uint8Array(Buffer.concat(chunks))
}

/** Only the loopback interface may reach these routes. */
function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** Build the `/state` payload the panel renders. */
export async function buildState(deps) {
  const { store, asr, summarizer, calendar, autoIngest } = deps
  await store.load()
  const [speech, calendarStatus] = await Promise.all([
    Promise.resolve().then(() => asr.status()),
    calendar.status(),
  ])
  const meetings = sortMeetings(store.snapshot().meetings).map((meeting) => projectMeeting(meeting))
  const auto = autoIngest?.status?.() ?? null
  const totals = meetings.reduce((acc, meeting) => {
    acc.meetings += 1
    acc.todos += meeting.todoCount
    acc.pendingTodos += meeting.pendingTodoCount
    acc.summarized += meeting.hasSummary ? 1 : 0
    return acc
  }, { meetings: 0, todos: 0, pendingTodos: 0, summarized: 0 })
  return {
    ok: true,
    now: new Date().toISOString(),
    today: localDay(),
    clock: formatMoment(),
    autoIngest: auto,
    config: {
      llm: summarizer.describeRoute(),
      asr: {
        mode: speech.available ? 'local' : 'unavailable',
        providerId: speech.selection?.providerId ?? null,
        language: speech.selection?.language ?? 'zh',
      },
    },
    speech,
    calendar: calendarStatus,
    totals,
    meetings,
    storeFile: store.file,
  }
}

/** Resolve one meeting id from route segments, or throw a 404-shaped error. */
function requireMeeting(store, id) {
  const meeting = store.get(id)
  if (meeting === null) {
    const error = new Error(`未找到会议：${id}`)
    error.status = 404
    throw error
  }
  return meeting
}

/**
 * Register the plugin's routes.
 * @param ctx - Cordis context carrying `webServer`.
 * @param deps - `store`, `asr`, `summarizer`, `calendar`, `autoIngest`, `logger`.
 * @returns a disposer removing the route.
 */
export function registerRoutes(ctx, deps) {
  const { store, asr, summarizer, calendar, autoIngest, logger } = deps

  const handler = async (req, res) => {
    try {
      if (!isLoopback(req)) {
        sendJson(res, 403, { ok: false, error: '仅允许本机访问' })
        return
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const path = url.pathname
      const rest = path.slice(ROUTE_PREFIX.length).replace(/^\/+/, '')
      const segments = rest === '' ? [] : rest.split('/').map((segment) => decodeURIComponent(segment))
      const method = req.method ?? 'GET'
      await store.load()

      if (segments.length === 1 && segments[0] === 'health') {
        sendJson(res, 200, { ok: true, plugin: 'dsh-plugin-meeting-minutes', file: store.file })
        return
      }

      if (segments.length === 1 && segments[0] === 'state' && method === 'GET') {
        sendJson(res, 200, await buildState(deps))
        return
      }

      if (segments.length === 2 && segments[0] === 'speech' && segments[1] === 'status' && method === 'GET') {
        sendJson(res, 200, { ok: true, speech: asr.status() })
        return
      }

      if (segments.length === 2 && segments[0] === 'speech' && segments[1] === 'prepare' && method === 'POST') {
        const body = await readJsonBody(req)
        asr.prepare(body.providerId)
        sendJson(res, 200, { ok: true, speech: asr.status() })
        return
      }

      if (segments.length === 2 && segments[0] === 'auto-ingest' && segments[1] === 'status' && method === 'GET') {
        sendJson(res, 200, { ok: true, autoIngest: autoIngest === undefined ? null : autoIngest.status() })
        return
      }

      if (segments.length === 2 && segments[0] === 'auto-ingest' && segments[1] === 'scan' && method === 'POST') {
        if (autoIngest === undefined) throw new Error('自动入库不可用')
        void autoIngest.scanNow().catch((error) => logger?.warn?.(error))
        sendJson(res, 200, { ok: true, autoIngest: autoIngest.status() })
        return
      }

      if (segments.length === 1 && segments[0] === 'auto-ingest' && method === 'POST') {
        if (autoIngest === undefined) throw new Error('自动入库不可用')
        const body = await readJsonBody(req)
        const autoIngestStatus = await autoIngest.setConfig({
          ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
          ...(body.tencent === undefined ? {} : { tencent: body.tencent }),
          ...(Array.isArray(body.dirs) ? { dirs: body.dirs } : {}),
        })
        sendJson(res, 200, { ok: true, autoIngest: autoIngestStatus })
        return
      }

      if (segments.length === 1 && segments[0] === 'meetings' && method === 'POST') {
        const body = await readJsonBody(req)
        const meeting = await store.add({
          title: body.title,
          date: body.date,
          attendees: body.attendees,
          sourceType: body.sourceType,
          transcript: body.transcript,
          notes: body.notes,
        })
        sendJson(res, 200, { ok: true, meeting })
        return
      }

      if (segments[0] !== 'meetings' || segments.length < 2) {
        sendJson(res, 404, { ok: false, error: `未知接口：${method} ${path}` })
        return
      }

      const id = segments[1]

      if (segments.length === 2) {
        if (method === 'GET') {
          sendJson(res, 200, { ok: true, meeting: requireMeeting(store, id) })
          return
        }
        if (method === 'PATCH' || method === 'POST') {
          requireMeeting(store, id)
          const body = await readJsonBody(req)
          const patch = {}
          for (const key of ['title', 'date', 'attendees', 'transcript', 'notes', 'sourceType', 'transcriptSeconds']) {
            if (body[key] !== undefined) patch[key] = body[key]
          }
          if (body.appendTranscript === true) {
            const current = requireMeeting(store, id)
            patch.transcript = current.transcript === '' ? String(body.transcript ?? '') : `${current.transcript}\n${String(body.transcript ?? '')}`
          }
          if (Object.keys(patch).length === 0) throw new Error('没有提供任何要修改的字段')
          const updated = await store.patch(id, patch)
          sendJson(res, 200, { ok: true, meeting: updated })
          return
        }
        if (method === 'DELETE') {
          const removed = await store.remove(id)
          sendJson(res, removed === null ? 404 : 200, removed === null ? { ok: false, error: '未找到会议' } : { ok: true })
          return
        }
      }

      if (segments.length === 3 && segments[2] === 'summarize' && method === 'POST') {
        const meeting = requireMeeting(store, id)
        const body = await readJsonBody(req)
        logger?.info?.(`meeting-minutes: summarizing ${id} (${meeting.transcript.length} chars)`)
        const summary = await summarizer.summarize(meeting)
        const patch = {}
        if (meeting.attendees.length === 0 && summary.attendees.length > 0) {
          patch.attendees = summary.attendees
        }
        // An automatic placeholder title ("录音纪要 10-21 17:30", "会议纪要 2026-10-21")
        // is exactly what the user did not have time to name. The summary model now
        // proposes a real title; adopt it unless the user explicitly opted out or
        // already typed a title of their own.
        let renamedTo = null
        if (body.autoTitle !== false
          && summary.suggestedTitle !== ''
          && summary.suggestedTitle !== meeting.title
          && isGenericTitle(meeting.title)) {
          patch.title = summary.suggestedTitle
          renamedTo = summary.suggestedTitle
        }
        if (Object.keys(patch).length > 0) await store.patch(id, patch)
        const updated = await store.setSummary(id, summary)
        sendJson(res, 200, { ok: true, meeting: updated, renamedTo })
        return
      }

      if (segments.length === 3 && segments[2] === 'transcribe' && method === 'POST') {
        requireMeeting(store, id)
        const language = url.searchParams.get('language') ?? undefined
        const providerId = url.searchParams.get('provider') ?? undefined
        const bytes = await readRawBody(req)
        if (bytes.length === 0) throw new Error('音频为空：没有收到可识别的数据。')
        const result = await asr.transcribeWav(bytes, { language, providerId })
        const updated = await store.appendTranscript(id, result.text, result.audioSeconds)
        sendJson(res, 200, {
          ok: true,
          text: result.text,
          audioSeconds: result.audioSeconds,
          inferenceSeconds: result.inferenceSeconds,
          transcript: updated?.transcript ?? '',
          transcriptSeconds: updated?.transcriptSeconds ?? 0,
        })
        return
      }

      if (segments.length === 4 && segments[2] === 'todos' && method === 'PATCH') {
        const body = await readJsonBody(req)
        const updated = await store.patchTodo(id, segments[3], body)
        sendJson(res, 200, { ok: true, meeting: updated })
        return
      }

      if (segments.length === 4 && segments[2] === 'todos' && segments[3] === 'push' && method === 'POST') {
        const meeting = requireMeeting(store, id)
        const body = await readJsonBody(req)
        const todoIds = Array.isArray(body.todoIds) ? body.todoIds.map(String) : undefined
        let result = { created: [] }
        let failure = null
        try {
          result = await calendar.pushTodos(meeting, todoIds)
        } catch (error) {
          failure = error
          result = { created: Array.isArray(error?.created) ? error.created : [] }
        }
        for (const entry of result.created) {
          await store.markTodoPushed(id, entry.todoId, entry.calendarTaskId)
        }
        const updated = requireMeeting(store, id)
        const calendarStatus = await calendar.status(true)
        if (failure !== null) {
          sendJson(res, 400, {
            ok: false,
            error: failure.message,
            created: result.created,
            failed: failure.failed ?? [],
            meeting: updated,
            calendar: calendarStatus,
            progress: todoProgress(updated),
          })
          return
        }
        sendJson(res, 200, {
          ok: true,
          created: result.created,
          meeting: updated,
          calendar: calendarStatus,
          progress: todoProgress(updated),
        })
        return
      }

      if (segments.length === 3 && segments[2] === 'export' && method === 'GET') {
        const meeting = requireMeeting(store, id)
        const format = url.searchParams.get('format') === 'md' ? 'md' : 'html'
        const exported = await exportMeeting(meeting, format)
        sendJson(res, 200, { ok: true, ...exported })
        return
      }

      sendJson(res, 404, { ok: false, error: `未知接口：${method} ${path}` })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const status = typeof error?.status === 'number' ? error.status : 400
      sendJson(res, status, { ok: false, error: message })
    }
  }

  return ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler })
}
