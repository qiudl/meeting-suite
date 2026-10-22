/**
 * Durable task store for the task-calendar plugin.
 *
 * One JSON document holds every task plus the reminder config:
 * `$DSH_HOME/storages/task-calendar.json` (the same directory the shipped
 * storage backend uses). Writes go through a single promise chain and land via
 * temp-file + rename, so a reader never observes a half-written document and a
 * crash cannot leave a torn file.
 *
 * A document written under the plugin's earlier name (`calendar-tasks.json`) is
 * read once and re-persisted under the current name, so the rename never loses
 * tasks.
 *
 * The store deliberately has no dependency on the harness storage service: the
 * plugin is installed as a local package and must load with zero bare imports.
 *
 * @module dsh-plugin-task-calendar/store
 */

import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { normalizeConfig, normalizeTask, newId, DEFAULT_CONFIG, reminderCandidates } from './model.js'

const EMPTY = { version: 1, updatedAt: null, config: { ...DEFAULT_CONFIG }, tasks: [] }

/** Current store file name. */
const STORE_FILE = 'task-calendar.json'
/** File name used before the plugin was renamed; read once, then re-written. */
const LEGACY_STORE_FILE = 'calendar-tasks.json'

/** The harness home directory. */
function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** Resolve the current store file path, honoring DSH_HOME. */
export function resolveStoreFile(home = dshHome()) {
  return join(home, 'storages', STORE_FILE)
}

/** Resolve the pre-rename store file path. */
export function resolveLegacyStoreFile(home = dshHome()) {
  return join(home, 'storages', LEGACY_STORE_FILE)
}

/**
 * Read+parse the document.
 * @param file - store path.
 * @param logger - optional logger for corruption warnings.
 * @returns the parsed document, or null when the file does not exist.
 */
async function readDocument(file, logger) {
  let raw
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
  try {
    const parsed = JSON.parse(raw)
    const tasks = Array.isArray(parsed?.tasks) ? parsed.tasks.map((task) => ({
      ...task,
      // A hand-edited or older document may omit these arrays; the panel and
      // the reminder engine both index them unconditionally.
      tags: Array.isArray(task.tags) ? task.tags.map(String) : [],
      fired: Array.isArray(task.fired) ? task.fired.map(String) : [],
    })) : []
    return {
      version: 1,
      updatedAt: typeof parsed?.updatedAt === 'string' ? parsed.updatedAt : null,
      config: normalizeConfig(parsed?.config),
      tasks,
    }
  } catch (error) {
    logger?.warn?.(`task-calendar: unreadable store ${file}, starting empty (${String(error?.message ?? error)})`)
    try {
      await rename(file, `${file}.corrupt-${Date.now()}`)
    } catch {
      // Best effort: the corrupt file is reported, not fatal.
    }
    return { ...EMPTY, tasks: [] }
  }
}

/** In-memory document + serialized durable writes. */
export class TaskStore {
  #file
  #legacyFile
  #logger
  #doc = { ...EMPTY, tasks: [] }
  #ready = null
  #chain = Promise.resolve()

  /**
   * @param options - `file` (store path), `legacyFile` (pre-rename path),
   * `logger` (optional `{info,warn,error}`).
   */
  constructor(options = {}) {
    this.#file = options.file ?? resolveStoreFile()
    this.#legacyFile = options.legacyFile ?? (options.file === undefined ? resolveLegacyStoreFile() : options.file)
    this.#logger = options.logger
  }

  /** Store file path (exposed for diagnostics and the panel). */
  get file() {
    return this.#file
  }

  /** Load once; concurrent callers share the same promise. */
  async load() {
    if (this.#ready === null) {
      this.#ready = (async () => {
        const current = await readDocument(this.#file, this.#logger)
        if (current !== null) {
          this.#doc = current
          return current
        }
        // First run after the rename: adopt the old document and persist it
        // under the current name.
        if (this.#legacyFile !== this.#file) {
          const legacy = await readDocument(this.#legacyFile, this.#logger)
          if (legacy !== null && legacy.tasks.length > 0) {
            this.#doc = legacy
            await this.#persist()
            this.#logger?.info?.(
              `task-calendar: migrated ${legacy.tasks.length} task(s) from ${this.#legacyFile}`,
            )
            return legacy
          }
        }
        this.#doc = { ...EMPTY, tasks: [] }
        return this.#doc
      })()
    }
    return this.#ready
  }

  /** Current in-memory document (a copy; callers cannot mutate the store). */
  snapshot() {
    return {
      version: 1,
      updatedAt: this.#doc.updatedAt,
      config: { ...this.#doc.config },
      tasks: this.#doc.tasks.map((task) => ({ ...task, tags: [...task.tags], fired: [...task.fired] })),
    }
  }

  /** Current tasks. */
  get tasks() {
    return this.#doc.tasks
  }

  /** Current normalized config. */
  get config() {
    return this.#doc.config
  }

  /** Persist the document through temp-file + rename. */
  async #persist() {
    const payload = JSON.stringify(this.#doc, null, 2)
    await mkdir(dirname(this.#file), { recursive: true })
    const tmp = `${this.#file}.tmp-${process.pid}`
    await writeFile(tmp, payload, 'utf8')
    try {
      await rename(tmp, this.#file)
    } catch (error) {
      try { await unlink(tmp) } catch { /* the rename failure is the real error */ }
      throw error
    }
  }

  /**
   * Serialize one mutation against the document and persist it.
   * @param mutate - receives the live document; return value is passed through.
   * @param options - `persist` (default true).
   * @returns the mutation's return value.
   */
  async update(mutate, options = {}) {
    await this.load()
    const run = this.#chain.then(async () => {
      const result = mutate(this.#doc)
      if (options.persist !== false) {
        this.#doc.updatedAt = new Date().toISOString()
        await this.#persist()
      }
      return result
    })
    // Keep the chain alive after a failed write so later mutations still run.
    this.#chain = run.then(() => undefined, () => undefined)
    return run
  }

  /** Insert one task (canonicalized). */
  async add(raw, options = {}) {
    const now = options.now ?? new Date()
    const task = normalizeTask({ ...raw, id: raw?.id ?? newId() }, { now })
    await this.update((doc) => { doc.tasks.push(task) })
    return task
  }

  /** Insert many tasks in one durable write. */
  async addMany(list, options = {}) {
    const now = options.now ?? new Date()
    const created = []
    for (const raw of list) {
      created.push(normalizeTask({ ...raw, id: raw?.id ?? newId() }, { now }))
    }
    await this.update((doc) => { doc.tasks.push(...created) })
    return created
  }

  /** Find a task by exact id, else by unique title match. */
  find(reference) {
    const needle = typeof reference === 'string' ? reference.trim() : ''
    if (needle === '') return null
    const byId = this.#doc.tasks.find((task) => task.id === needle)
    if (byId !== undefined) return byId
    const lowered = needle.toLowerCase()
    const exact = this.#doc.tasks.filter((task) => task.title.toLowerCase() === lowered)
    if (exact.length === 1) return exact[0]
    const partial = this.#doc.tasks.filter((task) => task.title.toLowerCase().includes(lowered))
    return partial.length === 1 ? partial[0] : null
  }

  /** Patch one task; `patch.fired` may be supplied directly. */
  async patch(id, patch, options = {}) {
    const now = options.now ?? new Date()
    let updated = null
    await this.update((doc) => {
      const index = doc.tasks.findIndex((task) => task.id === id)
      if (index === -1) throw new Error(`未找到任务：${id}`)
      const base = doc.tasks[index]
      const next = normalizeTask({ ...patch, id }, { now, base })
      // `normalizeTask` drops unknown keys by design; carry provenance across.
      doc.tasks[index] = next
      updated = next
    })
    return updated
  }

  /** Remove one task; returns the removed record or null. */
  async remove(id) {
    let removed = null
    await this.update((doc) => {
      const index = doc.tasks.findIndex((task) => task.id === id)
      if (index === -1) return
      removed = doc.tasks[index]
      doc.tasks.splice(index, 1)
    })
    return removed
  }

  /**
   * Mark reminder keys as already delivered. Acknowledging the newest pending
   * milestone of a task retires every older milestone of that task too, so a
   * neglected task cannot replay a backlog of stale reminders right after the
   * user dismisses the current one.
   * @param keys - full alert keys (`@<taskId>:<milestone>`).
   * @returns how many tasks were changed.
   */
  async ack(keys) {
    const wanted = [...new Set((Array.isArray(keys) ? keys : []).map(String))].filter((key) => key !== '')
    if (wanted.length === 0) return 0
    let touched = 0
    await this.update((doc) => {
      for (const task of doc.tasks) {
        const prefix = `@${task.id}:`
        const acked = wanted.filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length))
        if (acked.length === 0) continue
        const candidates = reminderCandidates(task, doc.config)
        const times = acked
          .map((key) => candidates.find((candidate) => candidate.key === key)?.at)
          .filter((value) => typeof value === 'string')
        const retire = new Set(acked)
        if (times.length > 0) {
          const newest = times.sort()[times.length - 1]
          for (const candidate of candidates) {
            if (candidate.at <= newest) retire.add(candidate.key)
          }
        }
        const before = task.fired.length
        task.fired = [...new Set([...task.fired, ...retire])]
        if (task.fired.length !== before) touched += 1
      }
    })
    return touched
  }

  /** Replace the reminder config. */
  async setConfig(config) {
    await this.update((doc) => { doc.config = normalizeConfig({ ...doc.config, ...config }) })
    return this.#doc.config
  }
}
