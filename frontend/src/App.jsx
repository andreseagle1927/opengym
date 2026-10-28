import { useEffect, useRef } from 'react'
import { HashRouter, Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom'
import { useStore } from './store/useStore.js'
import { useUI } from './store/useUI.js'
import { bindUI } from './components/ui.jsx'
import { ACCENTS } from './lib/format.js'
import { setLang, useLang } from './lib/i18n.js'
import { setNav } from './lib/nav.js'
import { useWakeLock } from './lib/wakelock.js'
import { startFlow } from './sheets.jsx'
import Icon from './components/Icon.jsx'
import TabBar from './components/TabBar.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import Modals from './components/Modals.jsx'
import Toast from './components/Toast.jsx'
import RestTimer from './components/RestTimer.jsx'
import Login from './views/Login.jsx'
import Home from './views/Home.jsx'
import Plan from './views/Plan.jsx'
import RoutineEdit from './views/RoutineEdit.jsx'
import Workout from './views/Workout.jsx'
import Stats from './views/Stats.jsx'
import History from './views/History.jsx'
import Library from './views/Library.jsx'
import Food from './views/Food.jsx'
import Settings from './views/Settings.jsx'
import Admin from './views/Admin.jsx'

bindUI(useUI)   // lets the shared controls open sheets without importing the store at module scope

function applyPrefs(theme, accent) {
  const de = document.documentElement
  de.dataset.theme = theme === 'light' ? 'light' : 'dark'
  de.dataset.accent = ACCENTS[accent] ? accent : 'lime'
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.content = de.dataset.theme === 'light' ? '#f2f2f7' : '#000000'
}

function Shell() {
  const navigate = useNavigate()
  const loc = useLocation()
  const { S, user, ready } = useStore()
  const adminView = useStore(s => s.adminView)
  const isGuest = useStore(s => s.isGuest())
  const toast = useUI(s => s.toast)
  const langV = useLang()   // re-renders the whole shell when the language (pack) changes
  const initialAdminLanding = useRef(null)
  const previousPath = useRef(loc.pathname)
  useEffect(() => { setNav(navigate) }, [navigate])
  useEffect(() => { applyPrefs(S.theme, S.accent) }, [S.theme, S.accent])
  useEffect(() => { setLang(S.lang || 'en') }, [S.lang])
  useEffect(() => {
    const onConflict = () => toast('Another save changed your profile. The latest version is loaded; your previous copy is saved in Settings.')
    window.addEventListener('gym-sync-conflict', onConflict)
    return () => window.removeEventListener('gym-sync-conflict', onConflict)
  }, [toast])
  useEffect(() => {
    const onAdminSaveError = event => toast(event.detail?.conflict
      ? 'This user profile changed elsewhere. Your changes are still here; reload the profile before saving again.'
      : event.detail?.message || 'Could not save this user profile.')
    const onAdminReadOnly = () => toast('Only plans, exercises, and food can be changed in a user profile view.')
    window.addEventListener('gym-admin-view-save-error', onAdminSaveError)
    window.addEventListener('gym-admin-view-readonly', onAdminReadOnly)
    return () => {
      window.removeEventListener('gym-admin-view-save-error', onAdminSaveError)
      window.removeEventListener('gym-admin-view-readonly', onAdminReadOnly)
    }
  }, [toast])
  useEffect(() => {
    if (!ready) return
    if (!user) { initialAdminLanding.current = null; return }
    if (initialAdminLanding.current === user.id) return
    initialAdminLanding.current = user.id
    if (user.admin && !adminView) navigate('/admin', { replace: true })
  }, [ready, user?.id, user?.admin, adminView?.id, navigate])
  useEffect(() => {
    const returningToAdmin = loc.pathname === '/admin' && previousPath.current !== '/admin'
    previousPath.current = loc.pathname
    if (!returningToAdmin || !adminView) return
    useStore.getState().exitAdminView().then(ok => {
      if (!ok) toast('Save the selected user profile before returning to Admin.')
    })
  }, [loc.pathname, adminView?.id, toast])
  useEffect(() => { document.documentElement.lang = S.lang || 'en' }, [langV, S.lang])
  // every tab/route change starts at the top of the page
  useEffect(() => { window.scrollTo(0, 0) }, [loc.pathname])
  // bound to the workout, not to the route — checking Stats mid-session keeps the screen on
  useWakeLock(!adminView && !!S.active && S.keepAwake !== false)
  const returnToAdmin = async () => {
    const exited = await useStore.getState().exitAdminView()
    if (exited) navigate('/admin')
  }

  const authed = user || isGuest
  if (!ready && !authed) return (
    <div id="app">
      <div style={{ paddingTop: '44vh', display: 'flex', justifyContent: 'center', fontSize: 34, color: 'var(--label-3)' }}>
        <Icon name="dumbbell" />
      </div>
    </div>
  )

  return (
    <>
      {/* keyed on the route: a view that throws is contained, and switching tabs
          re-mounts the boundary, so the tab bar is always a way out */}
      <div id="app" className="vfade" key={loc.pathname}>
        {adminView && <div className="admin-view-banner" role="status">
          <Icon name="personCircle" /><span>Viewing <strong>{adminView.user.name}</strong> as Admin</span>
        </div>}
        <ErrorBoundary>
          {!authed ? <Login /> : (
            <Routes>
              <Route path="/home" element={<Home />} />
              <Route path="/plan" element={<Plan />} />
              <Route path="/plan/r/:id" element={<RoutineEdit />} />
              <Route path="/workout" element={adminView ? <Navigate to="/home" replace /> : <Workout />} />
              <Route path="/stats" element={<Stats />} />
              <Route path="/history" element={<History />} />
              <Route path="/library" element={<Library />} />
              <Route path="/food" element={<Food />} />
              <Route path="/settings" element={adminView ? <Navigate to="/home" replace /> : <Settings />} />
              <Route path="/admin" element={user?.admin ? <Admin /> : <Navigate to="/home" replace />} />
              <Route path="*" element={<Navigate to="/home" replace />} />
            </Routes>
          )}
        </ErrorBoundary>
      </div>
      {loc.pathname !== '/admin' && <TabBar onStart={startFlow} onAdminReturn={returnToAdmin} />}
      {!adminView && <RestTimer />}
      <Modals />
      <Toast />
    </>
  )
}

export default function App() {
  const boot = useStore(s => s.boot)
  useEffect(() => { boot() }, [boot])
  return <HashRouter><Shell /></HashRouter>
}
