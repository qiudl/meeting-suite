import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SKILL_NAME,
  SKILL_DESCRIPTION,
  SKILL_WHEN_TO_USE,
  SKILL_CONTENT,
  registerMeetingSkill,
} from '../lib/skill.js'

test('skill metadata is model-facing and mentions both plugins', () => {
  assert.match(SKILL_NAME, /^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  assert.ok(SKILL_DESCRIPTION.includes('会议'))
  assert.ok(SKILL_WHEN_TO_USE.includes('待办'))
  for (const tool of [
    'meeting_create',
    'meeting_summarize',
    'meeting_push_todos',
    'calendar_add_tasks',
    'meeting_auto_ingest',
  ]) {
    assert.ok(SKILL_CONTENT.includes(tool), `skill body should mention ${tool}`)
  }
  assert.ok(SKILL_CONTENT.includes('绝不自动写入日历'))
})

test('registerMeetingSkill registers one bundled runtime skill and returns its disposer', () => {
  let registered
  const dispose = () => {}
  const ctx = {
    get: (name) => (name === 'skills' ? { register: (skill) => { registered = skill; return dispose } } : undefined),
  }
  assert.equal(registerMeetingSkill(ctx), dispose)
  assert.equal(registered.name, SKILL_NAME)
  assert.equal(registered.description, SKILL_DESCRIPTION)
  assert.equal(registered.whenToUse, SKILL_WHEN_TO_USE)
  assert.equal(registered.source, 'bundled')
  assert.equal(registered.content, SKILL_CONTENT)
  assert.equal(registered.invocation, undefined)
})

test('registerMeetingSkill is a no-op when the skills service is absent', () => {
  assert.equal(registerMeetingSkill({ get: () => undefined }), undefined)
})
