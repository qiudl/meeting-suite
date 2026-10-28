#!/usr/bin/env node
/**
 * 无人值守本地录音：一条命令完成「建会议 → 抓麦克风 → 5 秒切片走 live 转写 → 停录合并」。
 *
 * 这样 agent 用一次工具调用就能开会录音，不需要在面板里点按钮，也不依赖系统默认
 * 输入设备（显式指定 avfoundation 音频设备序号）。
 *
 * 用法：
 *   node scripts/live-record.mjs --url http://127.0.0.1:52353 --device 2 \
 *     --title "演示：会议纪要与任务日历（真实录音）" --seconds 60
 *
 * 停止：SIGINT/SIGTERM（或到 --seconds 自动停）→ 触发 /audio/finalize 落整场副本。
 * 输出：每行一条 JSON 事件（created / recording / finalized），便于上层解析。
 */

import { spawn } from 'node:child_process'

import { encodeWavPcm16 } from '../lib/audio.js'

const SAMPLE_RATE = 16000
const SLICE_SECONDS = 5

/** 极简 `--key value` 参数解析。 */
function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      out[key] = true
    } else {
      out[key] = next
      i += 1
    }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const base = String(args.url ?? 'http://127.0.0.1:52353').replace(/\/+$/, '')
const device = String(args.device ?? '2')
const seconds = Number(args.seconds ?? 0)
const sliceBytes = SAMPLE_RATE * 2 * SLICE_SECONDS

const now = new Date()
const pad = (value) => String(value).padStart(2, '0')
const title = String(
  args.title ?? `录音纪要 ${now.getMonth() + 1}-${now.getDate()} ${pad(now.getHours())}:${pad(now.getMinutes())}`,
)
const date = String(args.date ?? `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`)

/** 调用本机会议插件接口。 */
async function api(path, options = {}) {
  const response = await fetch(`${base}/dsh-meeting${path}`, options)
  const payload = await response.json().catch(() => null)
  if (!response.ok || payload?.ok === false) {
    throw new Error(`${path} 失败（HTTP ${response.status}）：${payload?.error ?? '无响应体'}`)
  }
  return payload
}

const created = await api('/meetings', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ title, date, sourceType: 'recording' }),
})
const id = created?.meeting?.id
if (!id) throw new Error('创建会议失败：接口没有返回会议 id')
console.log(JSON.stringify({ event: 'created', id, title, date }))

const ffmpeg = spawn(
  'ffmpeg',
  [
    '-loglevel', 'error',
    '-f', 'avfoundation',
    '-i', `:${device}`,
    '-ac', '1', '-ar', String(SAMPLE_RATE),
    '-f', 's16le', '-',
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
)

let index = 0
let pending = Buffer.alloc(0)
let posting = Promise.resolve()
let finalized = false
let stopTimer = null

/** 把一片 PCM 编码成 WAV 并按 live 模式上传（该模式只暂存，不落副本）。 */
function postSlice(buffer) {
  const even = buffer.length - (buffer.length % 2)
  if (even === 0) return
  const samples = new Int16Array(buffer.buffer, buffer.byteOffset, even / 2)
  const wav = encodeWavPcm16(samples, SAMPLE_RATE)
  const slice = index
  index += 1
  posting = posting
    .then(() => api(`/meetings/${id}/transcribe?live=1&index=${slice}&language=zh`, {
      method: 'POST',
      headers: { 'content-type': 'audio/wav' },
      body: wav,
    }))
    .catch((error) => {
      console.error(JSON.stringify({ event: 'slice-error', index: slice, error: String(error?.message ?? error) }))
    })
}

ffmpeg.stdout.on('data', (chunk) => {
  pending = Buffer.concat([pending, chunk])
  while (pending.length >= sliceBytes) {
    postSlice(pending.subarray(0, sliceBytes))
    pending = pending.subarray(sliceBytes)
  }
})
ffmpeg.stderr.on('data', (chunk) => {
  const text = String(chunk).trim()
  if (text !== '') console.error(JSON.stringify({ event: 'ffmpeg', text }))
})
ffmpeg.on('error', (error) => {
  console.error(JSON.stringify({ event: 'ffmpeg-error', error: String(error?.message ?? error) }))
})

/** 停录：收尾最后一片 → 合并整场 → 打印结果。 */
async function stop(reason) {
  if (finalized) return
  finalized = true
  if (stopTimer !== null) clearInterval(stopTimer)
  try {
    ffmpeg.kill('SIGINT')
  } catch {
    // ffmpeg 可能已经退出
  }
  if (pending.length > 0) postSlice(pending)
  pending = Buffer.alloc(0)
  await posting
  try {
    const result = await api(`/meetings/${id}/audio/finalize`, { method: 'POST' })
    console.log(JSON.stringify({
      event: 'finalized',
      reason,
      id,
      slices: index,
      audio: result?.audio ?? null,
    }))
  } catch (error) {
    console.error(JSON.stringify({ event: 'finalize-error', id, error: String(error?.message ?? error) }))
  }
  process.exit(0)
}

process.on('SIGINT', () => { void stop('SIGINT') })
process.on('SIGTERM', () => { void stop('SIGTERM') })
if (Number.isFinite(seconds) && seconds > 0) setTimeout(() => { void stop('timeout') }, seconds * 1000)
/**
 * Poll `/state` for an operator stop request: the page's 「停止录音」 button POSTs
 * `/meetings/:id/audio/stop`, and this is what turns that click into a finalize —
 * the recorder owns the microphone, so the server can only flag the intent.
 */
function watchStopRequests() {
  stopTimer = setInterval(async () => {
    try {
      const response = await fetch(`${base}/dsh-meeting/state`)
      const data = await response.json()
      const requested = Array.isArray(data?.stopRequested) && data.stopRequested.includes(id)
      if (requested) {
        clearInterval(stopTimer)
        await stop('requested')
      }
    } catch {
      // a transient host hiccup just means we try again on the next tick
    }
  }, 2000)
}
watchStopRequests()

console.log(JSON.stringify({ event: 'recording', id, device, sliceSeconds: SLICE_SECONDS, seconds }))
