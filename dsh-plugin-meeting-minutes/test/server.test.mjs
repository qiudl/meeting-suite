/**
 * Route tests for the meeting-minutes host API.
 *
 * The real Cordis context is replaced by a minimal `webServer` double; the
 * store runs against a temporary file and speech/summary/calendar are fakes, so
 * the test exercises routing, validation, persistence, and response shapes
 * without a model, microphone, or the task-calendar plugin.
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { MeetingStore } from '../lib/store.js'
import { normalizeSummary } from '../lib/model.js'
import { registerRoutes } from '../lib/server.js'
import { concatWavPcm16, encodeWavPcm16 } from '../lib/audio.js'
import { resolveAudioDir, resolveAudioPartsDir, sha256Bytes } from '../lib/audio-store.js'

const SUMMARY_INPUT = {
  suggestedTitle: 'Q4预算评审会',
  oneLine: '一句话结论',
  overview: '概述',
  keyPoints: ['要点一'],
  decisions: [{ text: '决定 A', owner: '张三' }],
  risks: [{ text: '风险 B', level: 'medium' }],
  sections: [{ heading: '议题', bullets: ['内容'] }],
  attendees: ['张三', '李四'],
  todos: [{ title: '输出方案', owner: '李四', due: '2026-10-28', priority: 'high', notes: '验收' }],
}

/** Build one server + deps pair sharing one temporary store. */
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'meeting-server-test-'))
  // Keep every local write (store, exports, retained audio) inside the temp dir.
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  const store = new MeetingStore({ file: join(dir, 'meeting-minutes.json') })
  const calls = { transcribe: [], pushed: [] }
  const asr = {
    status: () => ({
      available: true,
      error: null,
      providers: [{ id: 'sensevoice-local', name: 'SenseVoice', location: 'host-local', languages: ['zh'], phase: 'ready', progress: null, message: '' }],
      selection: { providerId: 'sensevoice-local', language: 'zh' },
      maxAudioBytes: 4194304,
      maxDurationSeconds: 300,
    }),
    transcribeWav: async (bytes) => {
      calls.transcribe.push(bytes.length)
      // One-byte payloads stand in for a corrupt recording: ASR fails after the
      // audio copy has already been retained.
      if (bytes.length === 1) throw new Error('识别失败：音频损坏')
      return { text: '这是转写文本', audioSeconds: 12.5, inferenceSeconds: 1.5 }
    },
  }
  const summarizer = {
    describeRoute: () => ({ provider: 'test-provider', model: 'test-model' }),
    summarize: async (meeting) => normalizeSummary(SUMMARY_INPUT, { now: new Date(), previous: meeting.summary, model: 'test-provider/test-model' }),
  }
  const calendar = {
    status: async () => ({ available: true, route: '/dsh-task-calendar', error: null }),
    pushTodos: async (meeting, todoIds) => {
      const wanted = Array.isArray(todoIds) && todoIds.length > 0 ? new Set(todoIds) : null
      const targets = meeting.summary.todos.filter((todo) => (wanted === null ? todo.calendarTaskId === null : wanted.has(todo.id)))
      if (targets.length === 0) throw new Error('没有需要写入的待办：勾选至少一条未写入的待办。')
      const created = targets.map((todo, index) => ({ todoId: todo.id, calendarTaskId: `tk_${index + 1}`, title: todo.title }))
      calls.pushed.push(created)
      return { created }
    },
  }
  const autoState = {
    enabled: true,
    tencent: true,
    dirs: [],
    tencentAvailable: true,
    tencentDbPath: '/tmp/tencent.db',
    tencentRecords: 0,
    tencentError: null,
    scanning: false,
    pending: 0,
    lastScanAt: null,
    lastError: null,
    importedCount: 0,
    failedCount: 0,
    recent: [],
  }
  const autoIngest = {
    status: () => ({ ...autoState }),
    setConfig: async (patch) => {
      if (patch.enabled !== undefined) autoState.enabled = patch.enabled
      if (patch.tencent !== undefined) autoState.tencent = patch.tencent
      if (Array.isArray(patch.dirs)) autoState.dirs = [...patch.dirs]
      return autoIngest.status()
    },
    scanNow: async () => { autoState.scanning = true; return autoIngest.status() },
  }
  let handler = null
  const ctx = {
    webServer: {
      register(route) { handler = route.handler; return () => { handler = null } },
      getOrigin() { return 'http://127.0.0.1:50505' },
    },
  }
  const dispose = registerRoutes(ctx, { store, asr, summarizer, calendar, autoIngest, logger: { info() {}, warn() {}, error() {} } })
  const server = createServer((req, res) => { void handler(req, res) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const base = `http://127.0.0.1:${port}/dsh-meeting`

  /** One JSON request. */
  async function call(path, options = {}) {
    const init = { method: options.method ?? 'GET', headers: {} }
    if (options.body !== undefined) {
      init.headers['content-type'] = 'application/json'
      init.body = JSON.stringify(options.body)
    }
    if (options.raw !== undefined) {
      init.headers['content-type'] = 'audio/wav'
      init.body = options.raw
    }
    const response = await fetch(`${base}${path}`, init)
    const payload = await response.json()
    return { status: response.status, payload }
  }

  /** Tear everything down. */
  async function close() {
    dispose()
    await new Promise((resolve) => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }

  return { call, close, calls, store }
}

test('health 与 state 返回插件状态', async () => {
  const context = await setup()
  try {
    const health = await context.call('/health')
    assert.equal(health.status, 200)
    assert.equal(health.payload.plugin, 'dsh-plugin-meeting-minutes')
    const state = await context.call('/state')
    assert.equal(state.status, 200)
    assert.equal(state.payload.ok, true)
    assert.deepEqual(state.payload.meetings, [])
    assert.equal(state.payload.config.llm.model, 'test-model')
    assert.equal(state.payload.speech.available, true)
    assert.equal(state.payload.calendar.available, true)
    assert.equal(state.payload.autoIngest.enabled, true)
    assert.equal(state.payload.autoIngest.tencentAvailable, true)
    assert.equal(typeof state.payload.today, 'string')
  } finally {
    await context.close()
  }
})

test('会议增改查删与转写追加', async () => {
  const context = await setup()
  try {
    const created = await context.call('/meetings', {
      method: 'POST',
      body: { title: '周例会', date: '2026-10-21', attendees: ['张三'], transcript: '开头' },
    })
    assert.equal(created.status, 200)
    const id = created.payload.meeting.id
    assert.equal(created.payload.meeting.transcript, '开头')

    const patched = await context.call(`/meetings/${id}`, {
      method: 'PATCH',
      body: { title: '周例会（改）', appendTranscript: true, transcript: '追加' },
    })
    assert.equal(patched.payload.meeting.transcript, '开头\n追加')

    const transcribed = await context.call(`/meetings/${id}/transcribe?language=zh`, {
      method: 'POST',
      raw: Buffer.from('fake-wav-bytes'),
    })
    assert.equal(transcribed.status, 200)
    assert.equal(transcribed.payload.text, '这是转写文本')
    assert.equal(transcribed.payload.transcriptSeconds, 12.5)
    assert.equal(transcribed.payload.transcript, '开头\n追加\n这是转写文本')
    assert.deepEqual(context.calls.transcribe, [Buffer.byteLength('fake-wav-bytes')])
    // The blob was retained and fingerprinted before ASR ran.
    assert.match(transcribed.payload.audio.path, /^meeting-minutes\/audio\/.+\.wav$/)
    assert.match(transcribed.payload.audio.sha256, /^[a-f0-9]{64}$/)
    assert.equal(transcribed.payload.audio.bytes, Buffer.byteLength('fake-wav-bytes'))
    assert.equal(transcribed.payload.duplicate, null)

    const single = await context.call(`/meetings/${id}`)
    assert.equal(single.payload.meeting.title, '周例会（改）')
    assert.equal(single.payload.meeting.audioPath, transcribed.payload.audio.path)
    assert.equal(single.payload.meeting.audioSha256, transcribed.payload.audio.sha256)
    assert.equal(single.payload.meeting.audioSeconds, 12.5)

    // Same bytes on another meeting: prompt, but never block the write.
    const second = await context.call('/meetings', { method: 'POST', body: { title: '同一录音再传一次' } })
    const secondId = second.payload.meeting.id
    const repeated = await context.call(`/meetings/${secondId}/transcribe`, {
      method: 'POST',
      raw: Buffer.from('fake-wav-bytes'),
    })
    assert.equal(repeated.status, 200)
    assert.deepEqual(repeated.payload.duplicate, { id, title: '周例会（改）' })
    const secondMeeting = await context.call(`/meetings/${secondId}`)
    assert.equal(secondMeeting.payload.meeting.transcript, '这是转写文本')

    // Retry from the retained copy needs no upload at all.
    const retried = await context.call(`/meetings/${id}/transcribe?fromStored=1`, { method: 'POST', raw: Buffer.alloc(0) })
    assert.equal(retried.status, 200)
    assert.equal(retried.payload.transcriptSeconds, 25)

    // Provenance fields are writable through PATCH (pin/unpin, clear an error).
    const pinned = await context.call(`/meetings/${id}`, { method: 'PATCH', body: { audioPinned: true } })
    assert.equal(pinned.payload.meeting.audioPinned, true)
    assert.equal(pinned.payload.meeting.audioPath, transcribed.payload.audio.path)

    const state = await context.call('/state')
    assert.equal(state.payload.meetings.length, 2)
    const projected = state.payload.meetings.find((meeting) => meeting.id === id)
    assert.equal(projected.transcriptChars >= 12, true)
    assert.equal(projected.hasAudio, true)
    assert.equal(state.payload.meetings.some((meeting) => meeting.hasAudio === true), true)

    const deleted = await context.call(`/meetings/${id}`, { method: 'DELETE' })
    assert.equal(deleted.status, 200)
    const missing = await context.call(`/meetings/${id}`)
    assert.equal(missing.status, 404)
  } finally {
    await context.close()
  }
})

test('转写失败仍保留音频副本并落库失败原因', async () => {
  const context = await setup()
  try {
    const created = await context.call('/meetings', { method: 'POST', body: { title: '坏录音会' } })
    const id = created.payload.meeting.id
    const failed = await context.call(`/meetings/${id}/transcribe`, { method: 'POST', raw: Buffer.from('x') })
    assert.equal(failed.status, 400)
    assert.match(failed.payload.error, /识别失败：音频损坏/)
    assert.match(failed.payload.error, /音频副本已保留/)
    assert.match(failed.payload.audioPath, /^meeting-minutes\/audio\/.+\.wav$/)

    const meeting = await context.call(`/meetings/${id}`)
    assert.equal(meeting.payload.meeting.audioPath, failed.payload.audioPath)
    assert.equal(meeting.payload.meeting.audioError, '识别失败：音频损坏')
    assert.equal(meeting.payload.meeting.transcript, '')

    // The retained copy is on disk and can be retried without a re-upload.
    const retried = await context.call(`/meetings/${id}/transcribe?fromStored=1`, { method: 'POST', raw: Buffer.alloc(0) })
    assert.equal(retried.status, 400)
    assert.equal(context.calls.transcribe.includes(1), true)
  } finally {
    await context.close()
  }
})

test('导出后写入 exportedAt，作为保留策略的删除优先级依据', async () => {
  const context = await setup()
  try {
    const created = await context.call('/meetings', { method: 'POST', body: { title: '导出时间会', transcript: '内容' } })
    const id = created.payload.meeting.id
    const before = await context.call(`/meetings/${id}`)
    assert.equal(before.payload.meeting.exportedAt, '')
    const exported = await context.call(`/meetings/${id}/export?format=md`)
    assert.equal(exported.status, 200)
    const after = await context.call(`/meetings/${id}`)
    assert.match(after.payload.meeting.exportedAt, /^\d{4}-\d{2}-\d{2}T/)
  } finally {
    await context.close()
  }
})

test('总结生成纪要并补参会人', async () => {
  const context = await setup()
  try {
    const created = await context.call('/meetings', { method: 'POST', body: { title: '预算会', transcript: '讨论预算' } })
    const id = created.payload.meeting.id
    const summarized = await context.call(`/meetings/${id}/summarize`, { method: 'POST', body: {} })
    assert.equal(summarized.status, 200)
    const meeting = summarized.payload.meeting
    assert.equal(summarized.payload.renamedTo, null)
    assert.equal(meeting.title, '预算会')
    assert.equal(meeting.summary.oneLine, '一句话结论')
    assert.equal(meeting.summary.suggestedTitle, 'Q4预算评审会')
    assert.equal(meeting.summary.todos.length, 1)
    assert.deepEqual(meeting.attendees, ['张三', '李四'])
    assert.equal(meeting.summary.model, 'test-provider/test-model')
  } finally {
    await context.close()
  }
})

test('总结时自动把占位标题改成 AI 标题，用户标题不动', async () => {
  const context = await setup()
  try {
    const created = await context.call('/meetings', { method: 'POST', body: { title: '录音纪要 2026-10-21 10:00', transcript: '讨论预算' } })
    const id = created.payload.meeting.id
    const summarized = await context.call(`/meetings/${id}/summarize`, { method: 'POST', body: {} })
    assert.equal(summarized.status, 200)
    assert.equal(summarized.payload.renamedTo, 'Q4预算评审会')
    assert.equal(summarized.payload.meeting.title, 'Q4预算评审会')
    const custom = await context.call('/meetings', { method: 'POST', body: { title: '张三的会', transcript: '讨论预算' } })
    const customId = custom.payload.meeting.id
    const kept = await context.call(`/meetings/${customId}/summarize`, { method: 'POST', body: {} })
    assert.equal(kept.payload.renamedTo, null)
    assert.equal(kept.payload.meeting.title, '张三的会')
    const optOut = await context.call('/meetings', { method: 'POST', body: { title: '会议纪要 2026-10-22', transcript: '讨论预算' } })
    const optOutId = optOut.payload.meeting.id
    const skipped = await context.call(`/meetings/${optOutId}/summarize`, { method: 'POST', body: { autoTitle: false } })
    assert.equal(skipped.payload.renamedTo, null)
    assert.equal(skipped.payload.meeting.title, '会议纪要 2026-10-22')
  } finally {
    await context.close()
  }
})

test('待办编辑与写入日历', async () => {
  const context = await setup()
  try {
    const created = await context.call('/meetings', { method: 'POST', body: { title: '预算会', transcript: '讨论预算' } })
    const id = created.payload.meeting.id
    const summarized = await context.call(`/meetings/${id}/summarize`, { method: 'POST', body: {} })
    const todoId = summarized.payload.meeting.summary.todos[0].id

    const edited = await context.call(`/meetings/${id}/todos/${todoId}`, { method: 'PATCH', body: { owner: '王五', due: '2026-10-30' } })
    assert.equal(edited.payload.meeting.summary.todos[0].owner, '王五')

    const pushed = await context.call(`/meetings/${id}/todos/push`, { method: 'POST', body: {} })
    assert.equal(pushed.status, 200)
    assert.equal(pushed.payload.created.length, 1)
    assert.equal(pushed.payload.progress.pushed, 1)
    assert.equal(pushed.payload.meeting.summary.todos[0].calendarTaskId, 'tk_1')

    const again = await context.call(`/meetings/${id}/todos/push`, { method: 'POST', body: {} })
    assert.equal(again.status, 400)
    assert.match(again.payload.error, /没有需要写入的待办/)
  } finally {
    await context.close()
  }
})

test('自动入库开关、目录与立即扫描', async () => {
  const context = await setup()
  try {
    const scanned = await context.call('/auto-ingest/scan', { method: 'POST', body: {} })
    assert.equal(scanned.status, 200)
    assert.equal(scanned.payload.autoIngest.scanning, true)
    const updated = await context.call('/auto-ingest', {
      method: 'POST',
      body: { enabled: false, tencent: false, dirs: ['~/Documents/TencentMeeting', '/tmp/minutes'] },
    })
    assert.equal(updated.status, 200)
    assert.equal(updated.payload.autoIngest.enabled, false)
    assert.equal(updated.payload.autoIngest.tencent, false)
    assert.deepEqual(updated.payload.autoIngest.dirs, ['~/Documents/TencentMeeting', '/tmp/minutes'])
    const state = await context.call('/state')
    assert.equal(state.payload.autoIngest.enabled, false)
    assert.deepEqual(state.payload.autoIngest.dirs, ['~/Documents/TencentMeeting', '/tmp/minutes'])
  } finally {
    await context.close()
  }
})

test('导出返回内容并落盘', async () => {
  const context = await setup()
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'meeting-export-home-'))
  try {
    const created = await context.call('/meetings', { method: 'POST', body: { title: '导出会', transcript: '内容' } })
    const id = created.payload.meeting.id
    await context.call(`/meetings/${id}/summarize`, { method: 'POST', body: {} })
    const exported = await context.call(`/meetings/${id}/export?format=html`)
    assert.equal(exported.status, 200)
    assert.equal(exported.payload.format, 'html')
    assert.ok(exported.payload.content.includes('导出会'))
    assert.ok(exported.payload.path.endsWith('.html'))
    const markdown = await context.call(`/meetings/${id}/export?format=md`)
    assert.ok(markdown.payload.content.includes('## 一句话结论'))
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await context.close()
  }
})

test('参数校验：空标题/未知会议/空音频', async () => {
  const context = await setup()
  try {
    const empty = await context.call('/meetings', { method: 'POST', body: {} })
    assert.equal(empty.status, 400)
    assert.match(empty.payload.error, /title/)
    const missing = await context.call('/meetings/mt_nope')
    assert.equal(missing.status, 404)
    const created = await context.call('/meetings', { method: 'POST', body: { title: '空音频会' } })
    const id = created.payload.meeting.id
    const nothing = await context.call(`/meetings/${id}/transcribe`, { method: 'POST', raw: Buffer.alloc(0) })
    assert.equal(nothing.status, 400)
    assert.match(nothing.payload.error, /音频为空/)
  } finally {
    await context.close()
  }
})

test('实时录音切片只暂存，停录合并为一份整场录音', async () => {
  const context = await setup()
  try {
    const created = await context.call('/meetings', { method: 'POST', body: { title: '面对面会议', date: '2026-10-27' } })
    const id = created.payload.meeting.id
    const sliceA = encodeWavPcm16(new Int16Array(16000).fill(10))
    const sliceB = encodeWavPcm16(new Int16Array(16000).fill(20))

    const first = await context.call(`/meetings/${id}/transcribe?live=1&index=1`, { method: 'POST', raw: Buffer.from(sliceA) })
    assert.equal(first.status, 200)
    const second = await context.call(`/meetings/${id}/transcribe?live=1&index=2`, { method: 'POST', raw: Buffer.from(sliceB) })
    assert.equal(second.status, 200)

    // Slices are temporary parts: no retained copy exists while recording.
    assert.deepEqual((await readdir(resolveAudioDir())).filter((name) => !name.startsWith('.')), [])
    assert.equal((await readdir(resolveAudioPartsDir(id))).length, 2)
    const during = await context.call(`/meetings/${id}`)
    assert.equal(during.payload.meeting.audioPath, '')
    assert.equal(during.payload.meeting.transcript, '这是转写文本\n这是转写文本')

    const finalized = await context.call(`/meetings/${id}/audio/finalize`, { method: 'POST', body: {} })
    assert.equal(finalized.status, 200)
    assert.match(finalized.payload.audio.path, /^meeting-minutes\/audio\/.+\.wav$/)
    assert.equal(finalized.payload.audio.seconds, 2)
    assert.equal(finalized.payload.audio.parts, 2)
    assert.equal(finalized.payload.audio.sha256, sha256Bytes(Buffer.from(concatWavPcm16([sliceA, sliceB]))))

    const meeting = await context.call(`/meetings/${id}`)
    assert.equal(meeting.payload.meeting.audioPath, finalized.payload.audio.path)
    assert.equal(meeting.payload.meeting.audioSha256, finalized.payload.audio.sha256)
    assert.equal(meeting.payload.meeting.audioSeconds, 2)
    assert.equal((await readdir(resolveAudioDir())).filter((name) => !name.startsWith('.')).length, 1)
    await assert.rejects(stat(resolveAudioPartsDir(id)), /ENOENT/)

    const again = await context.call(`/meetings/${id}/audio/finalize`, { method: 'POST', body: {} })
    assert.equal(again.status, 400)
    assert.match(again.payload.error, /没有待合并的录音片段/)

    // Deleting a half-recorded meeting clears its temporary slices too.
    const discarded = await context.call('/meetings', { method: 'POST', body: { title: '取消的会议' } })
    const discardedId = discarded.payload.meeting.id
    await context.call(`/meetings/${discardedId}/transcribe?live=1&index=1`, { method: 'POST', raw: Buffer.from(sliceA) })
    assert.equal((await readdir(resolveAudioPartsDir(discardedId))).length, 1)
    const deleted = await context.call(`/meetings/${discardedId}`, { method: 'DELETE' })
    assert.equal(deleted.status, 200)
    await assert.rejects(stat(resolveAudioPartsDir(discardedId)), /ENOENT/)
  } finally {
    await context.close()
  }
})

test('手工编辑转写：原文保留、计数累加、追加不算修订、导出标注', async () => {
  const context = await setup()
  try {
    const created = await context.call('/meetings', { method: 'POST', body: { title: '手工编辑会', transcript: '原始识别的错别字' } })
    const id = created.payload.meeting.id
    assert.equal(created.payload.meeting.transcriptRaw, '原始识别的错别字')
    assert.equal(created.payload.meeting.transcriptEdits, 0)

    const edited = await context.call(`/meetings/${id}`, { method: 'PATCH', body: { transcript: '修正后的文本' } })
    assert.equal(edited.payload.meeting.transcript, '修正后的文本')
    assert.equal(edited.payload.meeting.transcriptRaw, '原始识别的错别字')
    assert.equal(edited.payload.meeting.transcriptEdits, 1)
    assert.match(edited.payload.meeting.transcriptEditedAt, /^\d{4}-\d{2}-\d{2}T/)

    const again = await context.call(`/meetings/${id}`, { method: 'PATCH', body: { transcript: '再修一次' } })
    assert.equal(again.payload.meeting.transcriptEdits, 2)
    assert.equal(again.payload.meeting.transcriptRaw, '原始识别的错别字')

    // The import path (appendTranscript) is not a manual edit.
    const appended = await context.call(`/meetings/${id}`, { method: 'PATCH', body: { appendTranscript: true, transcript: '追加段' } })
    assert.equal(appended.payload.meeting.transcriptEdits, 2)
    assert.equal(appended.payload.meeting.transcript, '再修一次\n追加段')

    const state = await context.call('/state')
    assert.equal(state.payload.meetings.find((meeting) => meeting.id === id).transcriptEdits, 2)

    const md = await context.call(`/meetings/${id}/export?format=md`)
    assert.ok(md.payload.content.includes('- 转写：经人工修订（2 次）'))
    assert.ok(md.payload.content.includes('再修一次'))
    const html = await context.call(`/meetings/${id}/export?format=html`)
    assert.ok(html.payload.content.includes('经人工修订（2 次）'))

    // Re-summarizing uses the edited text, and the audio sha256 is untouched.
    const summarized = await context.call(`/meetings/${id}/summarize`, { method: 'POST', body: {} })
    assert.equal(summarized.status, 200)
    const meeting = await context.call(`/meetings/${id}`)
    assert.equal(meeting.payload.meeting.transcript, '再修一次\n追加段')
    assert.equal(meeting.payload.meeting.transcriptRaw, '原始识别的错别字')
  } finally {
    await context.close()
  }
})
