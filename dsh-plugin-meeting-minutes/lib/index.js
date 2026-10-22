/**
 * Host half of the meeting-minutes plugin.
 *
 * Responsibilities:
 * - own the durable meeting document (`$DSH_HOME/storages/meeting-minutes.json`),
 * - transcribe recordings through the Harness speech-to-text service (local
 *   SenseVoice by default),
 * - summarize transcripts through the current default LLM route,
 * - push confirmed action items into the task-calendar plugin's loopback API,
 * - expose model-facing tools so the agent can do the same work from chat,
 * - and serve the panel's local JSON API on `ctx.webServer`.
 *
 * The browser half (`./client`) renders the minutes panel. It is discovered by
 * the client module system from this package's `dsh.client` declaration — no
 * second loader entry is needed.
 *
 * @module dsh-plugin-meeting-minutes
 */

import { ROUTE_PREFIX, buildState, registerRoutes } from './server.js'
import { MeetingStore } from './store.js'
import { registerTools } from './tools.js'
import { createAsr } from './asr.js'
import { createSummarizer } from './summarize.js'
import { createCalendar } from './calendar.js'
import { createAutoIngest } from './autoingest.js'
import { registerMeetingSkill } from './skill.js'

/** Loader-facing plugin name. */
export const name = 'meeting-minutes'

/** Services this plugin needs before it can start. */
export const inject = ['tools', 'webServer']

/**
 * Plugin body.
 * @param ctx - host Cordis context.
 */
export function apply(ctx) {
  const store = new MeetingStore({ logger: ctx.logger })
  const asr = createAsr({ ctx, config: {} })
  const summarizer = createSummarizer({ ctx, logger: ctx.logger })
  const calendar = createCalendar({ ctx, logger: ctx.logger })
  const autoIngest = createAutoIngest({ store, asr, logger: ctx.logger })
  const deps = { store, asr, summarizer, calendar, autoIngest, logger: ctx.logger }

  ctx.effect(() => registerRoutes(ctx, deps), 'meeting-minutes: http routes')
  ctx.effect(() => autoIngest.start(), 'meeting-minutes: auto ingest poll')
  ctx.effect(() => {
    const disposers = registerTools(ctx, deps)
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'meeting-minutes: agent tools')
  ctx.effect(() => registerMeetingSkill(ctx), 'meeting-minutes: companion skill')

  store.load().then(
    (document) => {
      ctx.logger?.info?.(
        `meeting-minutes: ready — ${document.meetings.length} meeting(s) at ${store.file} (api ${ROUTE_PREFIX})`,
      )
    },
    (error) => {
      ctx.logger?.error?.(error)
    },
  )
}

export { buildState, ROUTE_PREFIX }
