#!/usr/bin/env node
/**
 * Build the format-1 plugin market index for the meeting-suite packages.
 *
 * The three packages are published to npm, so every entry uses an npm source
 * (`name@version`); install targets are resolved with the default registry.
 *
 * Usage:
 *   node scripts/build-market-index.mjs \
 *     --repo https://github.com/zhangguitao666/meeting-suite \
 *     [--timestamp <unix-seconds>] [--out market/index.json]
 *
 * `--timestamp` defaults to now; it is display/sort metadata only and does not
 * affect installation.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** One published plugin and its market metadata. */
const PLUGINS = [
  {
    dir: 'dsh-plugin-task-calendar',
    category: 'productivity',
    labels: ['calendar', 'chinese'],
    keywords: ['task', 'calendar', '会议', '待办', '日历', '提醒', 'gantt', 'reminder'],
    title: { zh: '任务日历', en: 'Task Calendar' },
    description: {
      zh: '把会议纪要确认过的事项变成日历任务，按开始/截止时间提醒，并提供月历与甘特图推进度。',
      en: 'Turns confirmed action items into calendar tasks with start/due reminders plus month-grid and Gantt progress views.',
    },
  },
  {
    dir: 'dsh-plugin-meeting-minutes',
    category: 'meetings',
    labels: ['meetings', 'chinese', 'automation'],
    keywords: ['meeting', 'minutes', '转录', '会议纪要', '录音', '腾讯会议', 'summary', 'todo', 'asr'],
    title: { zh: '会议纪要', en: 'Meeting Minutes' },
    description: {
      zh: '实时录音转文字、导入腾讯会议纪要，AI 生成可视化纪要，确认待办后写入任务日历；支持会议结束后自动入库。',
      en: 'Live local transcription, Tencent Meeting notes import, AI-written visual minutes, confirmed tasks written to the task calendar, and automatic ingest after meetings.',
    },
  },
  {
    dir: 'meeting-suite',
    category: 'meetings',
    labels: ['meetings', 'calendar', 'chinese', 'automation'],
    keywords: ['meeting', 'minutes', 'calendar', '会议套件', '一键安装', 'suite'],
    title: { zh: '会议套件（一键装两个）', en: 'Meeting Suite (both plugins)' },
    description: {
      zh: '一个包同时安装「会议纪要」和「任务日历」：录音/腾讯会议纪要 → AI 可视化纪要 → 待办写入日历。',
      en: 'Installs both Meeting Minutes and Task Calendar in one step: recordings or Tencent Meeting notes → AI-written minutes → action items in the calendar.',
    },
  },
]

/** Read one required CLI option. */
function option(name) {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1 || process.argv[index + 1] === undefined) throw new Error(`missing --${name}`)
  return process.argv[index + 1]
}

/** Optional CLI option. */
function optional(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

const repo = option('repo').replace(/\.git$/, '').replace(/\/$/, '')
const timestamp = Number(optional('timestamp') ?? Math.floor(Date.now() / 1000))
if (!Number.isInteger(timestamp) || timestamp <= 0) throw new Error('--timestamp must be a positive integer')
const outPath = resolve(ROOT, optional('out') ?? 'market/index.json')

const plugins = []
for (const meta of PLUGINS) {
  const manifest = JSON.parse(await readFile(join(ROOT, meta.dir, 'package.json'), 'utf8'))
  const icon = (await readFile(join(ROOT, meta.dir, 'icon.svg'))).toString('base64')
  plugins.push({
    name: manifest.name,
    title: meta.title,
    description: meta.description,
    icon: `data:image/svg+xml;base64,${icon}`,
    author: 'zhangguitao666',
    homepage: `${repo}/tree/main/${meta.dir}`,
    repository: { url: repo, directory: meta.dir },
    metadata: { category: meta.category, keywords: meta.keywords, labels: meta.labels },
    versions: [
      {
        version: manifest.version,
        publishTimestamp: timestamp,
        source: { type: 'npm' },
        engines: { dsh: '>=0.2.1-rc.2 <0.3.0' },
      },
    ],
  })
}

const index = {
  format: 1,
  title: { zh: '会议套件 · DSH 插件', en: 'Meeting Suite · DSH Plugins' },
  description: {
    zh: '会议纪要与任务日历两个插件，以及一次安装两个的会议套件伞包。',
    en: 'Meeting Minutes and Task Calendar plugins, plus a one-install umbrella bundle.',
  },
  metadata: {
    categories: {
      productivity: { title: { zh: '效率工具', en: 'Productivity' } },
      meetings: { title: { zh: '会议协作', en: 'Meetings' } },
    },
    labels: {
      calendar: { title: { zh: '日历', en: 'Calendar' } },
      meetings: { title: { zh: '会议', en: 'Meetings' } },
      chinese: { title: { zh: '中文', en: 'Chinese' } },
      automation: { title: { zh: '自动化', en: 'Automation' } },
    },
    sortKeys: {},
  },
  plugins,
}

await writeFile(outPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
console.log(`wrote ${outPath} (${plugins.length} plugins)`)
