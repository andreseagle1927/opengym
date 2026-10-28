// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ api: vi.fn(), targetWrites: [], conflict: false }))
vi.mock('../lib/api.js', () => ({
  api: (...args) => mocks.api(...args), clearSessionToken: vi.fn(), prepareSocialLogin: vi.fn(),
  configureSupabase: vi.fn(), restoreSupabaseSession: vi.fn(), completePendingSupabaseLink: vi.fn(),
  signOutSupabase: vi.fn()
}))
vi.mock('../lib/format.js', () => ({ localTZ: () => 'UTC' }))
vi.mock('../lib/exercises.js', () => ({ registerCustom: vi.fn() }))
vi.mock('../lib/demo.js', () => ({ DEMO: false, DEMO_SEEDED: 'demo-seeded' }))
vi.mock('../lib/guest.js', () => ({ guestAllowed: () => true }))
vi.mock('../lib/mobile.js', () => ({ MOBILE: false, nativeLoad: vi.fn(), nativeSave: vi.fn(), syncReminder: vi.fn() }))

import { DEF, useStore } from './useStore.js'

const clone = value => JSON.parse(JSON.stringify(value))
const adminState = () => Object.assign(clone(DEF), { routines: [{ id: 'admin-plan', name: 'Admin plan', ex: [] }], customEx: [], workouts: [] })
const targetState = () => Object.assign(clone(DEF), {
  routines: [{ id: 'target-plan', name: 'Target plan', ex: [] }],
  bodyweight: [{ d: '2026-10-20', w: 70 }], workouts: []
})

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  mocks.targetWrites = []
  mocks.conflict = false
  const ownState = adminState()
  localStorage.setItem('gym_state_v1', JSON.stringify(ownState))
  localStorage.setItem('gym_user', JSON.stringify({ id: 'admin-id', name: 'Admin', admin: true }))
  useStore.setState({ S: clone(ownState), user: { id: 'admin-id', name: 'Admin', admin: true }, adminView: null, ready: true })
  mocks.api.mockReset().mockImplementation(async (path, options = {}) => {
    if (path === '/api/data' && options.method === 'PUT') return { rev: 4 }
    if (path === '/api/admin/user?id=target-id') return {
      user: { id: 'target-id', name: 'Target Member' }, state: targetState(), rev: 7, lastSync: 1234
    }
    if (path === '/api/admin/user/data' && options.method === 'PUT') {
      const body = JSON.parse(options.body)
      mocks.targetWrites.push(clone(body))
      if (mocks.conflict) throw Object.assign(new Error('profile conflict'), { status: 409 })
      return { rev: 8, lastSync: 5678 }
    }
    throw new Error(`Unexpected API call: ${path}`)
  })
})

afterEach(() => {
  vi.clearAllTimers()
  useStore.setState({ adminView: null })
  localStorage.clear()
  sessionStorage.clear()
})

describe('Admin-selected profile context', () => {
  it('keeps Admin signed in, saves allowed changes only to the selected profile, and restores Admin state', async () => {
    const adminOwnPlan = useStore.getState().S.routines[0].id
    await useStore.getState().enterAdminView('target-id')
    expect(useStore.getState().user.id).toBe('admin-id')
    expect(useStore.getState().adminView.user.name).toBe('Target Member')
    expect(useStore.getState().S.routines[0].id).toBe('target-plan')
    expect(sessionStorage.getItem('gym_admin_view_id')).toBe('target-id')

    useStore.getState().update(state => {
      state.routines.push({ id: 'new-plan', name: 'New plan', ex: [] })
      state.foodPlan.push({ id: 'meal-1', food: { name: 'Oats' }, grams: 100 })
      state.bodyweight.push({ d: '2026-10-23', w: 71 })
    })
    expect(useStore.getState().S.bodyweight).toEqual([{ d: '2026-10-20', w: 70 }])
    await expect(useStore.getState().pushAdminView()).resolves.toBe(true)

    expect(mocks.targetWrites).toHaveLength(1)
    expect(mocks.targetWrites[0].id).toBe('target-id')
    expect(mocks.targetWrites[0].expectedRev).toBe(7)
    expect(mocks.targetWrites[0].state.routines.map(r => r.id)).toContain('new-plan')
    expect(mocks.targetWrites[0].state.foodPlan).toHaveLength(1)
    expect(mocks.targetWrites[0].state.bodyweight).toEqual([{ d: '2026-10-20', w: 70 }])
    expect(JSON.parse(localStorage.getItem('gym_state_v1')).routines[0].id).toBe(adminOwnPlan)

    await expect(useStore.getState().exitAdminView()).resolves.toBe(true)
    expect(useStore.getState().adminView).toBeNull()
    expect(useStore.getState().S.routines[0].id).toBe(adminOwnPlan)
    expect(sessionStorage.getItem('gym_admin_view_id')).toBeNull()
  })

  it('retains the selected profile and blocks return to Admin when a revision conflict prevents saving', async () => {
    await useStore.getState().enterAdminView('target-id')
    useStore.getState().update(state => { state.foodDiary.push({ id: 'diary-1', food: { name: 'Apple' }, grams: 100 }) })
    mocks.conflict = true

    await expect(useStore.getState().pushAdminView()).resolves.toBe(false)
    await expect(useStore.getState().exitAdminView()).resolves.toBe(false)
    expect(useStore.getState().adminView.id).toBe('target-id')
    expect(useStore.getState().S.foodDiary).toHaveLength(1)
    expect(useStore.getState().adminView.status).toBe('error')
  })
})
