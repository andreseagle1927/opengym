import { create } from 'zustand'
import { api, clearSessionToken, prepareSocialLogin, configureSupabase, restoreSupabaseSession, completePendingSupabaseLink, signOutSupabase } from '../lib/api.js'
import { localTZ } from '../lib/format.js'
import { registerCustom } from '../lib/exercises.js'
import { DEMO, DEMO_SEEDED } from '../lib/demo.js'
import { guestAllowed } from '../lib/guest.js'
import { MOBILE, nativeLoad, nativeSave, syncReminder, withTimeout } from '../lib/mobile.js'

const KEY = 'gym_state_v1'
const ADMIN_VIEW_KEY = 'gym_admin_view_id'
const ADMIN_VIEW_FIELDS = new Set([
  'routines', 'week', 'dayPlan', 'customEx',
  'foodDiary', 'foodPlan', 'customFoods', 'favoriteFoods', 'nutritionTargets'
])
export const DEF = {
  unit: 'kg', restSec: 90, sound: true, keepAwake: true, lang: 'en',
  theme: 'dark', accent: 'lime', body: 'male', targetW: null,
  bodyweight: [], routines: [], week: {}, dayPlan: {},
  exWeights: {}, workouts: [], active: null, customEx: [], gifSize: 'full',
  foodDiary: [], foodPlan: [], customFoods: [], favoriteFoods: [],
  nutritionTargets: { kcal: null, protein: null, carbs: null, fat: null },
  // effort: which per-set effort scale is logged — 'none' | 'rir' | 'rpe'. null, not 'none', so
  // that a profile which never chose (loaded state is overlaid on DEF, on every path: local,
  // server pull, backup import) still falls back to the `showRir` boolean this replaced and
  // keeps the column it had. See effortOf.
  reminder: { on: false, time: '08:00', tz: null }, effort: null
}
const clone = o => JSON.parse(JSON.stringify(o))

function loadState() {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return Object.assign(clone(DEF), JSON.parse(raw))
  } catch (e) { /* ignore */ }
  return clone(DEF)
}

const hasData = st => !!((st.workouts || []).length || (st.routines || []).length || (st.bodyweight || []).length ||
  (st.foodDiary || []).length || (st.foodPlan || []).length || (st.customFoods || []).length || (st.favoriteFoods || []).length ||
  Object.values(st.nutritionTargets || {}).some(Boolean))

export const useStore = create((set, get) => {
  let pushTm = null
  let saveTm = null
  let adminPushTm = null
  let adminPushPromise = null
  let adminPushQueued = false

  const changedAdminFields = (before, after) => [...ADMIN_VIEW_FIELDS].filter(key => JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key]))
  const dispatchAdminEvent = (name, detail = {}) => {
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(name, { detail }))
  }
  const scheduleAdminPush = () => {
    clearTimeout(adminPushTm)
    adminPushTm = setTimeout(() => { adminPushTm = null; get().pushAdminView() }, 700)
  }

  // Mobile build: mirror the state into a file in the app's data directory (survives WebView
  // storage eviction) and keep the native reminder schedule in step with the weekly plan.
  const nativePersist = () => {
    clearTimeout(saveTm)
    saveTm = setTimeout(() => { saveTm = null; nativeSave(get().S); syncReminder(get().S) }, 800)
  }

  const persist = (S, push = true) => {
    const adminView = get().adminView
    if (adminView) {
      const previous = get().S
      const next = clone(S)
      const blocked = []
      for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
        if (ADMIN_VIEW_FIELDS.has(key) || JSON.stringify(previous[key]) === JSON.stringify(next[key])) continue
        blocked.push(key)
        if (Object.prototype.hasOwnProperty.call(previous, key)) next[key] = clone(previous[key])
        else delete next[key]
      }
      next._rev = adminView.rev
      next._ts = Date.now()
      registerCustom(next.customEx)
      const dirty = changedAdminFields(adminView.savedState, next).length > 0
      set({ S: next, adminView: { ...adminView, dirty, status: dirty ? 'pending' : 'saved', error: '' } })
      if (blocked.length) dispatchAdminEvent('gym-admin-view-readonly', { fields: blocked })
      if (dirty && push !== false) scheduleAdminPush()
      return
    }
    S._ts = Date.now()
    registerCustom(S.customEx)
    localStorage.setItem(KEY, JSON.stringify(S))
    set({ S })
    if (MOBILE) nativePersist()
    if (push && get().user) {
      clearTimeout(pushTm)
      pushTm = setTimeout(() => get().pushState(), 1500)
    }
  }

  // A setting changed right before switching away/closing the tab must not get lost mid-debounce
  // (e.g. setting the reminder time then immediately backgrounding to test it). On mobile the
  // same applies to the file mirror — backgrounding is often the last thing before the OS
  // kills the app.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') return
    if (MOBILE && saveTm) {
      clearTimeout(saveTm)
      saveTm = null
      nativeSave(get().S)
    }
    if (pushTm) {
      clearTimeout(pushTm)
      pushTm = null
      get().pushState()
    }
  })

  // Everything a sign-out leaves behind on this device, whichever way it was triggered.
  const clearLocalSession = () => {
    clearTimeout(adminPushTm)
    adminPushTm = null
    try { sessionStorage.removeItem(ADMIN_VIEW_KEY) } catch {}
    set({ adminView: null })
    get().setUser(null)
    clearSessionToken().catch(() => {})
    localStorage.removeItem('gym_guest')
    localStorage.removeItem('gym_dirty')
    localStorage.removeItem(KEY)
    persist(clone(DEF), false)
  }

  return {
    S: (() => { const s = loadState(); registerCustom(s.customEx); return s })(),
    user: (() => { try { return JSON.parse(localStorage.getItem('gym_user')) || null } catch { return null } })(),
    adminView: null,
    ready: false,

    // Mutate a draft of S via producer fn, then persist + schedule sync.
    update(mut, push = true) {
      const S = clone(get().S)
      mut(S)
      persist(S, push)
    },
    replaceState(S, push = false) { persist(clone(S), push) },

    isGuest: () => localStorage.getItem('gym_guest') === '1',
    setGuest(v) { if (v) localStorage.setItem('gym_guest', '1'); else localStorage.removeItem('gym_guest'); set({}) },

    // Public config from /api/config (invite_only, allow_guest). null until the first successful
    // fetch — the login screen and boot both read it, so it is fetched once and cached here
    // rather than by each screen that happens to need it.
    config: null,
    async loadConfig() {
      if (get().config) return get().config
      try {
        const c = await api('/api/config')
        set({ config: c })
        configureSupabase(c)
        try { await prepareSocialLogin(c) } catch {}
        return c
      }
      catch { return null }
    },

    setUser(u) {
      if (!u || u.id !== get().user?.id) {
        clearTimeout(adminPushTm)
        adminPushTm = null
        try { sessionStorage.removeItem(ADMIN_VIEW_KEY) } catch {}
        set({ adminView: null })
      }
      if (u) { localStorage.setItem('gym_user', JSON.stringify(u)); localStorage.removeItem('gym_guest') }
      else localStorage.removeItem('gym_user')
      set({ user: u })
    },

    async enterAdminView(id) {
      const targetId = String(id || '')
      if (!targetId || !get().user?.admin) throw new Error('Admin access is required to open this profile.')
      if (get().adminView?.id === targetId) return get().adminView.user
      if (get().adminView && !(await get().exitAdminView())) throw new Error('Save the current profile changes before switching users.')

      clearTimeout(pushTm)
      pushTm = null
      if (saveTm) {
        clearTimeout(saveTm)
        saveTm = null
        if (MOBILE) nativeSave(get().S)
      }
      await get().pushState()
      const adminState = clone(get().S)
      const profile = await api('/api/admin/user?id=' + encodeURIComponent(targetId))
      const targetState = Object.assign(clone(DEF), profile.state || {})
      targetState._rev = Number.isSafeInteger(profile.rev) ? profile.rev : 0
      targetState._ts = profile.lastSync || targetState._ts || 0
      registerCustom(targetState.customEx)
      try { sessionStorage.setItem(ADMIN_VIEW_KEY, targetId) } catch {}
      const userProfile = profile.user || { id: targetId, name: 'User' }
      set({ S: targetState, adminView: {
        id: targetId, user: userProfile, rev: targetState._rev,
        savedState: clone(targetState), adminState, dirty: false, status: 'saved', error: ''
      } })
      return userProfile
    },

    async pushAdminView() {
      clearTimeout(adminPushTm)
      adminPushTm = null
      if (adminPushPromise) {
        adminPushQueued = true
        const ok = await adminPushPromise
        if (!ok) return false
        if (adminPushQueued) {
          adminPushQueued = false
          return get().pushAdminView()
        }
        return !get().adminView?.dirty
      }
      const context = get().adminView
      if (!context || !context.dirty) return true
      const sent = clone(get().S)
      const targetId = context.id
      set({ adminView: { ...context, status: 'saving', error: '' } })
      adminPushPromise = (async () => {
        try {
          const result = await api('/api/admin/user/data', {
            method: 'PUT',
            body: JSON.stringify({ id: targetId, expectedRev: context.rev, state: sent })
          })
          const currentContext = get().adminView
          if (!currentContext || currentContext.id !== targetId) return true
          const savedState = { ...sent, _rev: result.rev, _ts: result.lastSync || Date.now() }
          const liveState = get().S
          const stillDirty = changedAdminFields(savedState, liveState).length > 0
          set({
            S: { ...liveState, _rev: result.rev },
            adminView: { ...currentContext, rev: result.rev, savedState, dirty: stillDirty, status: stillDirty ? 'pending' : 'saved', error: '' }
          })
          return true
        } catch (error) {
          const currentContext = get().adminView
          if (currentContext?.id === targetId) set({ adminView: { ...currentContext, dirty: true, status: 'error', error: error.message || 'Could not save this profile.' } })
          dispatchAdminEvent('gym-admin-view-save-error', { message: error.message || 'Could not save this profile.', conflict: error.status === 409 })
          return false
        }
      })()
      const ok = await adminPushPromise
      adminPushPromise = null
      if (!ok) return false
      if (adminPushQueued && get().adminView?.dirty) {
        adminPushQueued = false
        return get().pushAdminView()
      }
      adminPushQueued = false
      return !get().adminView?.dirty
    },

    async exitAdminView() {
      const context = get().adminView
      if (!context) return true
      if (context.dirty && !(await get().pushAdminView())) return false
      clearTimeout(adminPushTm)
      adminPushTm = null
      try { sessionStorage.removeItem(ADMIN_VIEW_KEY) } catch {}
      registerCustom(context.adminState.customEx)
      set({ S: clone(context.adminState), adminView: null })
      return true
    },

    async pushState() {
      if (get().adminView) return get().pushAdminView()
      if (!get().user) return false
      clearTimeout(pushTm)
      const sent = clone(get().S)
      try {
        const result = await api('/api/data', { method: 'PUT', body: JSON.stringify({ state: sent }) })
        const current = get().S
        const synced = { ...current, _rev: result.rev }
        localStorage.setItem(KEY, JSON.stringify(synced))
        set({ S: synced })
        if (MOBILE) nativeSave(synced)
        localStorage.removeItem('gym_dirty')
        return true
      } catch (e) {
        if (e.status === 409) {
          localStorage.setItem('gym_conflict_v1', JSON.stringify(get().S))
          try {
            const { state } = await api('/api/data')
            if (state) {
              const latest = Object.assign(clone(DEF), state)
              persist(latest, false)
              if (MOBILE) nativeSave(latest)
              localStorage.removeItem('gym_dirty')
              window.dispatchEvent(new CustomEvent('gym-sync-conflict'))
              return false
            }
          } catch { /* retain the local draft and retry when online */ }
        }
        localStorage.setItem('gym_dirty', '1')
        return false
      }
    },
    async pullState() {
      if (get().adminView) return
      try {
        const { state } = await api('/api/data')
        const S = get().S
        const dirty = localStorage.getItem('gym_dirty') === '1'
        if (state && (!hasData(S) || ((state._ts || 0) >= (S._ts || 0) && !dirty))) {
          const active = S.active
          const next = Object.assign(clone(DEF), state)
          if (active) next.active = active
          persist(next, false)
        } else if (hasData(S)) { await get().pushState() }
      } catch (e) { /* offline — keep local */ }
    },

    restoreConflictSnapshot() {
      let snapshot
      try { snapshot = JSON.parse(localStorage.getItem('gym_conflict_v1') || 'null') } catch { snapshot = null }
      if (!snapshot) return false
      snapshot._rev = Number.isSafeInteger(get().S._rev) ? get().S._rev : 0
      localStorage.removeItem('gym_conflict_v1')
      persist(Object.assign(clone(DEF), snapshot), true)
      return true
    },

    async signOut() {
      if (get().adminView && !(await get().exitAdminView())) return false
      try { await get().pushState(); await api('/api/logout', { method: 'POST', body: '{}' }) } catch (e) { /* */ }
      try { await signOutSupabase('local') } catch (e) { /* */ }
      clearLocalSession()
      return true
    },

    // "Sign out everywhere": the server bumps this profile's session version, which kills every
    // session it has on any device — this browser included, so the app has to end up exactly
    // where a normal signOut leaves it. Unlike signOut the request is NOT swallowed: if it fails
    // the sessions elsewhere are all still valid, and wiping this device's copy of the data
    // would sign the user out of the one place the bump didn't reach. Caller reports the error.
    async signOutAll() {
      if (get().adminView && !(await get().exitAdminView())) throw new Error('Save the selected profile before signing out.')
      await get().pushState()   // never throws — stores gym_dirty and moves on when offline
      await api('/api/logout/all', { method: 'POST', body: '{}' })
      try { await signOutSupabase('global') } catch (e) { /* OpenGym session has already been revoked */ }
      clearLocalSession()
    },

    // Demo build only: drop the seeded example profile back in (Settings → "Reset demo data").
    // Dynamic import so the generator never ships in a self-hosted bundle.
    async resetDemo() {
      const { buildDemoState } = await import('../lib/demoSeed.js')
      localStorage.removeItem('gym_dirty')
      persist(Object.assign(clone(DEF), buildDemoState()), false)
    },

    // Boot: ask the server who we are, then pull.
    async boot() {
      // Restore the durable native copy first. When the self-hosted API is reachable, use the
      // same account/sync flow as the web app; if it is offline, keep the app usable locally.
      if (MOBILE) {
        try {
          const saved = await withTimeout(nativeLoad(), 3000)
          const S = get().S
          if (saved && (!hasData(S) || (saved._ts || 0) >= (S._ts || 0))) {
            persist(Object.assign(clone(DEF), saved), false)
          } else if (hasData(S)) {
            nativeSave(S)   // first run after an update from a file-less version: seed the mirror
          }
          syncReminder(get().S)
          const cfg = await withTimeout(get().loadConfig(), 15000)
          if (cfg) {
            try {
              const me = await withTimeout(api('/api/me'), 15000)
              if (!me?.user) throw new Error('OpenGym session could not be restored.')
              get().setUser(me.user)
              const linked = await withTimeout(completePendingSupabaseLink(), 8000)
              if (linked) get().setUser(linked)
              await withTimeout(get().pullState(), 15000)
              const adminViewId = get().user?.admin ? sessionStorage.getItem(ADMIN_VIEW_KEY) : null
              if (adminViewId) await get().enterAdminView(adminViewId)
            } catch (e) {
              if (e.status === 401) {
                try {
                  const restored = await withTimeout(restoreSupabaseSession(), 8000)
                  if (restored) { get().setUser(restored); await get().pullState(); const adminViewId = restored.admin ? sessionStorage.getItem(ADMIN_VIEW_KEY) : null; if (adminViewId) await get().enterAdminView(adminViewId); return }
                } catch { /* stale or unconfirmed Supabase session */ }
                get().setUser(null); await clearSessionToken(); get().setGuest(false)
              }
            }
          } else if (!get().user) get().setGuest(true)
        } catch {
          if (!get().user) get().setGuest(true)
        } finally {
          set({ ready: true })
        }
        return
      }
      // Demo build (GitHub Pages): no backend at all — seed once, stay in guest mode.
      if (DEMO) {
        if (!localStorage.getItem(DEMO_SEEDED)) {
          localStorage.setItem(DEMO_SEEDED, '1')
          await get().resetDemo()
        }
        get().setGuest(true)
        set({ ready: true })
        return
      }
      // Guests never authenticate, so an instance that turned guest mode off has no request to
      // refuse — the only way the switch reaches someone already inside is here, on their next
      // boot. Ending the session needs a positive `allow_guest: false`; see lib/guest.js for why
      // an unreachable server must not be allowed to lock anyone out (#42).
      const cfg = await get().loadConfig()
      if (!guestAllowed(cfg)) get().setGuest(false)
      try {
        const me = await api('/api/me')
        get().setUser(me.user)
        const linked = await completePendingSupabaseLink()
        if (linked) get().setUser(linked)
        await get().pullState()
        const adminViewId = get().user?.admin ? sessionStorage.getItem(ADMIN_VIEW_KEY) : null
        if (adminViewId) await get().enterAdminView(adminViewId)
        // Re-stamp the reminder's timezone on every load — keeps it correct if you're travelling,
        // without needing to revisit Settings.
        const tz = localTZ()
        if (get().S.reminder?.on && get().S.reminder.tz !== tz) {
          get().update(s => { s.reminder = { ...s.reminder, tz } })
        }
      } catch (e) {
        if (e.status === 401) {
          get().setUser(null)
          try {
            const restored = await restoreSupabaseSession()
            if (restored) {
              get().setUser(restored)
              await get().pullState()
              const adminViewId = restored.admin ? sessionStorage.getItem(ADMIN_VIEW_KEY) : null
              if (adminViewId) await get().enterAdminView(adminViewId)
            }
          } catch { /* stale or unconfirmed Supabase session */ }
        }
      }
      set({ ready: true })
    }
  }
})

export { hasData }
