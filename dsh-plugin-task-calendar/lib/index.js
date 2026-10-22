/**
 * Host half of the task-calendar plugin.
 *
 * Responsibilities:
 * - own the durable task document (`$DSH_HOME/storages/task-calendar.json`),
 * - expose the model-facing calendar tools so an agent can turn meeting minutes
 *   into scheduled tasks,
 * - and serve the panel's local JSON API on `ctx.webServer`.
 *
 * The browser half (`./client`) renders the calendar panel, the reminder
 * overlays, and the system notifications. It is discovered by the client
 * module system from this package's `dsh.client` declaration — no second
 * loader entry is needed.
 *
 * @module dsh-plugin-task-calendar
 */

import { ROUTE_PREFIX, buildState, registerRoutes } from './server.js'
import { TaskStore } from './store.js'
import { registerTools } from './tools.js'

/** Loader-facing plugin name. */
export const name = 'task-calendar'

/** Services this plugin needs before it can start. */
export const inject = ['tools', 'webServer']

/**
 * Plugin body.
 * @param ctx - host Cordis context.
 */
export function apply(ctx) {
  const store = new TaskStore({ logger: ctx.logger })

  ctx.effect(() => registerRoutes(ctx, store), 'task-calendar: http route')
  ctx.effect(() => {
    const disposers = registerTools(ctx, store)
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'task-calendar: agent tools')

  store.load().then(
    (document) => {
      ctx.logger?.info?.(
        `task-calendar: ready — ${document.tasks.length} task(s) at ${store.file} (api ${ROUTE_PREFIX})`,
      )
    },
    (error) => {
      ctx.logger?.error?.(error)
    },
  )
}

export { buildState, ROUTE_PREFIX }
