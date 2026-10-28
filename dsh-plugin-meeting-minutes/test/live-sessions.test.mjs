/**
 * Live-session registry tests: the page learns about recordings started outside
 * the browser through `/state.activeRecording`, so the registry must be simple
 * and predictable.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { clearLiveSession, listLiveSessions, resetLiveSessions, touchLiveSession } from '../lib/live-sessions.js'

test('touchLiveSession creates an entry on the first slice and counts slices', () => {
  resetLiveSessions()
  const first = touchLiveSession({ meetingId: 'mt_a', title: '演示会', date: '2026-10-28' })
  assert.equal(first.meetingId, 'mt_a')
  assert.equal(first.title, '演示会')
  assert.equal(first.date, '2026-10-28')
  assert.equal(first.slices, 1)
  assert.match(first.startedAt, /^\d{4}-\d{2}-\d{2}T/)
  const second = touchLiveSession({ meetingId: 'mt_a' })
  assert.equal(second.slices, 2)
  assert.equal(second.startedAt, first.startedAt)
  assert.equal(second.title, '演示会')
  assert.equal(listLiveSessions().length, 1)
})

test('touchLiveSession ignores an empty meeting id', () => {
  resetLiveSessions()
  assert.equal(touchLiveSession({ meetingId: '' }), null)
  assert.equal(touchLiveSession({}), null)
  assert.deepEqual(listLiveSessions(), [])
})

test('clearLiveSession drops one meeting only', () => {
  resetLiveSessions()
  touchLiveSession({ meetingId: 'mt_a', title: 'A' })
  touchLiveSession({ meetingId: 'mt_b', title: 'B' })
  assert.equal(listLiveSessions().length, 2)
  assert.equal(clearLiveSession('mt_a'), true)
  assert.equal(clearLiveSession('mt_a'), false)
  assert.deepEqual(listLiveSessions().map((entry) => entry.meetingId), ['mt_b'])
})

test('listLiveSessions returns copies, newest start first', async () => {
  resetLiveSessions()
  touchLiveSession({ meetingId: 'mt_old', title: 'old' })
  await new Promise((resolve) => setTimeout(resolve, 5))
  touchLiveSession({ meetingId: 'mt_new', title: 'new' })
  const sessions = listLiveSessions()
  assert.equal(sessions.length, 2)
  sessions[0].title = 'mutated'
  assert.notEqual(listLiveSessions()[0].title, 'mutated')
  const order = listLiveSessions().map((entry) => entry.meetingId)
  assert.deepEqual(order, ['mt_new', 'mt_old'])
})
