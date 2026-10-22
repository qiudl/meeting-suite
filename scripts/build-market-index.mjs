#!/usr/bin/env node
/**
 * Build the format-1 plugin market index from the two packages in this repo.
 *
 * Usage:
 *   node scripts/build-market-index.mjs \
 *     --repo https://github.com/ZhangGuitao/dsh-plugins \
 *     --commit <40-hex-commit-that-contains-the-packages> \
 *     [--timestamp <unix-seconds>] [--out market/index.json]
 *
 * The index pins every version to an exact Git commit (DSH installs market
 * entries as `git+<repo>.git#<commit>&path:/<package-directory>`), so run this
 * AFTER committing the packages and use that commit's SHA. Commit the generated
 * index afterwards; updating a plugin means: commit packages → rerun with the
 * new SHA → commit index → push.
 */

import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
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
]

/** Read one required CLI option. */
function option(name) {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1 || process.argv[index + 1] === undefined) {
    throw new Error(`missing --${name}`)
  }
  return process.argv[index + 1]
}

/** Optional CLI option. */
function optional(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

const repo = option('repo').replace(/\.git$/, '').replace(/\/$/, '')
const commit = option('commit')
if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error('--commit must be a lowercase 40-hex-digit Git SHA')

const timestamp = Number(optional('timestamp') ?? execFileSync('git', ['show', '-s', '--format=%ct', commit], { cwd: ROOT, encoding: 'utf8' }).trim())
if (!Number.isInteger(timestamp) || timestamp <= 0) throw new Error('could not determine a publish timestamp')

const outPath = resolve(ROOT, optional('out') ?? 'market/index.json')

const plugins = []
for (const meta of PLUGINS) {
  const dir = join(ROOT, meta.dir)
  const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
  const icon = await readFile(join(dir, 'icon.svg'))
  plugins.push({
    name: manifest.name,
    title: meta.title,
    description: meta.description,
    icon: `data:image/svg+xml;base64,${icon.toString('base64')}`,
    author: 'ZhangGuitao',
    homepage: `${repo}/tree/main/${meta.dir}`,
    repository: { url: repo, directory: meta.dir },
    metadata: {
      category: meta.category,
      keywords: meta.keywords,
      labels: meta.labels,
    },
    versions: [
      {
        version: manifest.version,
        publishTimestamp: timestamp,
        source: { type: 'git', url: repo, commit, path: meta.dir },
        engines: { dsh: '>=0.2.1-rc.2 <0.3.0' },
      },
    ],
  })
}

const index = {
  format: 1,
  title: { zh: '张桂涛的 DSH 插件', en: 'ZhangGuitao DSH Plugins' },
  description: {
    zh: '任务日历与会议纪要：会议结束后自动留存、AI 生成可视化纪要，待办一键写入日历。',
    en: 'Task calendar and meeting minutes: automatic post-meeting ingest, AI-written visual minutes, confirmed action items written to the calendar.',
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
console.log(`wrote ${outPath} (${plugins.length} plugins, commit ${commit})`)
