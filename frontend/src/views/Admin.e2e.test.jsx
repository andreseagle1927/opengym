// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Admin from './Admin.jsx'

const mocks = vi.hoisted(() => ({ api: vi.fn(), toast: vi.fn(), enterAdminView: vi.fn(), state: null, rev: 1, writes: [], users: null, invites: [] }))

vi.mock('../lib/api.js', () => ({ api: (...args) => mocks.api(...args) }))
vi.mock('../store/useStore.js', () => ({ useStore: Object.assign(selector => selector({ user: { id: 'admin-test', name: 'Admin', admin: true } }), { getState: () => ({ enterAdminView: mocks.enterAdminView }) }) }))
vi.mock('../store/useUI.js', () => ({ useUI: selector => selector({ toast: mocks.toast }) }))
vi.mock('../sheets.jsx', () => ({ confirmSheet: vi.fn() }))

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const clone = value => JSON.parse(JSON.stringify(value))
let root, container
function LocationProbe() { return <output data-testid="current-path">{useLocation().pathname}</output> }

function profileReply() {
  return {
    user: { id: 'selected-user', name: 'Test Member', email: 'test-member@example.test', authMethods: ['password'], created: '2026-10-20T00:00:00Z' },
    state: clone(mocks.state), rev: mocks.rev, unit: 'kg', lastSync: Date.now(), audit: [],
    workouts: clone(mocks.state.workouts || []), bodyweight: clone(mocks.state.bodyweight || []),
    routines: (mocks.state.routines || []).map(r => ({ id: r.id, name: r.name, emoji: r.emoji, count: r.ex.length }))
  }
}

function click(el) {
  return act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}
function button(text, rootEl = container) {
  const buttons = [...rootEl.querySelectorAll('button')]
  return buttons.find(el => el.textContent.trim() === text) || buttons.reverse().find(el => el.textContent.trim().includes(text))
}
function fill(el, value) {
  return act(async () => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set
    if (setter) setter.call(el, value); else el.value = value
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}
async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }

beforeEach(() => {
  mocks.state = {
    unit: 'kg', lang: 'en', theme: 'dark', body: 'male', reminder: { on: false },
    routines: [], week: {}, dayPlan: {}, customEx: [], workouts: [], bodyweight: [],
    foodDiary: [], foodPlan: [], customFoods: [], favoriteFoods: [],
    nutritionTargets: { kcal: null, protein: null, carbs: null, fat: null }
  }
  mocks.rev = 1; mocks.writes = []; mocks.toast.mockClear(); mocks.enterAdminView.mockReset().mockResolvedValue(true)
  mocks.users = [{ id: 'selected-user', name: 'Test Member', email: 'test-member@example.test', authMethods: ['password'], workouts: 0, lastSync: Date.now(), disabled: false, admin: false }]
  mocks.invites = []
  mocks.api.mockReset().mockImplementation(async (path, options = {}) => {
    if (path === '/api/admin/users') return { users: clone(mocks.users), invite_only: false }
    if (path === '/api/admin/invites') return { invites: clone(mocks.invites) }
    if (path === '/api/admin/invites/new') { mocks.invites.push({ code: 'NEWCODE123' }); return { invite: { code: 'NEWCODE123' } } }
    if (path === '/api/admin/invites/revoke') { mocks.invites = mocks.invites.filter(invite => invite.code !== JSON.parse(options.body).code); return { ok: true } }
    if (path.startsWith('/api/admin/user?id=')) return profileReply()
    if (path === '/api/admin/user/data' && options.method === 'PUT') {
      const body = JSON.parse(options.body)
      mocks.writes.push(clone(body))
      if (body.id !== 'selected-user' || body.expectedRev !== mocks.rev) throw Object.assign(new Error('revision conflict'), { status: 409 })
      mocks.state = clone(body.state); mocks.rev += 1
      return { ok: true, rev: mocks.rev }
    }
    throw new Error(`Unexpected API call: ${path}`)
  })
  root = null; container = document.createElement('div'); document.body.appendChild(container)
})

afterEach(() => {
  if (root) act(() => root.unmount())
  container?.remove(); root = null; container = null
  vi.clearAllTimers()
})

describe('Admin selected-user profile and app flow', () => {
  it('shows readable saved data and opens the selected profile in the normal app', async () => {
    root = createRoot(container)
    await act(async () => { root.render(<MemoryRouter><Admin /><LocationProbe /></MemoryRouter>); await flush() })
    await click(container.querySelector('[aria-label="Account tools for Test Member"]'))
    await flush()
    expect(container.textContent).not.toContain('Create for Test Member')
    expect(container.querySelectorAll('.admin-create-action')).toHaveLength(0)
    expect(container.querySelector('[aria-label="User saved data JSON"]')).toBeNull()
    expect([...container.querySelectorAll('.admin-saved-group h5')].map(el => el.textContent.trim())).toEqual(['Training', 'Nutrition', 'Progress'])
    expect(container.textContent).not.toContain('Preferences')
    expect(container.querySelectorAll('.admin-saved-card')).toHaveLength(10)

    await click(button('Open app'))
    await flush()
    expect(mocks.enterAdminView).toHaveBeenCalledWith('selected-user')
    expect(container.querySelector('[data-testid="current-path"]').textContent).toBe('/home')
  })

  it('filters users and prioritizes training and recently active accounts', async () => {
    const now = Date.now()
    mocks.users = [
      { id: 'old', name: 'Carla Old', email: 'carla@example.test', authMethods: ['password'], workouts: 2, lastSync: now - 10 * 86400000, disabled: false },
      { id: 'training', name: 'Alice Training', email: 'alice@example.test', authMethods: ['google'], workouts: 4, lastSync: now - 20 * 86400000, disabled: false, live: { name: 'Leg day', startedAt: now - 60000, setsDone: 2, setsTotal: 6 } },
      { id: 'active', name: 'Ben Active', email: 'ben@example.test', authMethods: ['apple'], workouts: 8, lastSync: now - 60000, disabled: false },
      { id: 'disabled', name: 'Dana Disabled', email: 'dana@example.test', authMethods: ['password'], workouts: 0, lastSync: now - 20 * 86400000, disabled: true }
    ]
    root = createRoot(container)
    await act(async () => { root.render(<MemoryRouter><Admin /></MemoryRouter>); await flush() })

    const names = () => [...container.querySelectorAll('.admin-users-section .item .admin-user-name')].map(el => el.textContent.trim())
    expect(names()).toEqual(['Alice Training', 'Ben Active', 'Carla Old', 'Dana Disabled'])
    expect(container.querySelectorAll('.admin-users-section .item .admin-user-avatar .icn')).toHaveLength(4)
    expect(container.querySelector('.admin-create-prompt')).toBeNull()
    expect(container.querySelector('.admin-invites-details').open).toBe(false)

    await click(button('Active 7d'))
    expect(names()).toEqual(['Ben Active'])
    await click(button('Training now'))
    expect(names()).toEqual(['Alice Training'])
    await click(button('Disabled'))
    expect(names()).toEqual(['Dana Disabled'])
    await click(button('All'))
    await fill(container.querySelector('[aria-label="Search users"]'), 'carla@')
    expect(names()).toEqual(['Carla Old'])
    await fill(container.querySelector('[aria-label="Search users"]'), 'no-match')
    expect(container.textContent).toContain('No users match this search and filter.')
  })

  it('keeps invite codes collapsed and exposes generate, copy, and revoke controls', async () => {
    root = createRoot(container)
    await act(async () => { root.render(<MemoryRouter><Admin /></MemoryRouter>); await flush() })
    const details = container.querySelector('.admin-invites-details')
    expect(details.open).toBe(false)
    await click(button('Generate'))
    expect(mocks.invites.map(invite => invite.code)).toEqual(['NEWCODE123'])
    await flush()
    expect(container.querySelector('.admin-invites-details').textContent).toContain('1 unused')
    await click(container.querySelector('.admin-invites-details summary'))
    expect(container.querySelector('.admin-invites-details').open).toBe(true)
    expect(container.querySelector('[aria-label="Copy invite code NEWCODE123"]')).toBeTruthy()
    await click(container.querySelector('[aria-label="Revoke invite code NEWCODE123"]'))
    expect(mocks.invites).toHaveLength(0)
  })
})
