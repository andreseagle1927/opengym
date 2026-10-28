import { useLocation, useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { effectiveRoutine } from '../lib/history.js'
import { todayISO } from '../lib/format.js'
import { t } from '../lib/i18n.js'
import Icon from './Icon.jsx'

export default function TabBar({ onStart, onAdminReturn }) {
  const nav = useNavigate()
  const loc = useLocation()
  const S = useStore(s => s.S)
  const user = useStore(s => s.user)
  const adminView = useStore(s => s.adminView)
  const isGuest = useStore(s => s.isGuest())
  if (!user && !isGuest) return null
  const cur = loc.pathname.split('/')[1] || 'home'
  const on = k => cur === k || (cur === 'history' && k === 'stats') || (cur === 'settings' && k === 'home')

  const startWorkout = () => {
    if (!S.active) {
      const r = effectiveRoutine(S, todayISO())
      if (r && r.ex.length) { onStart(r.id); return }
    }
    nav('/workout')
  }
  const Tab = ({ k, icon, to, label }) => (
    <button className={on(k) ? 'on' : ''} onClick={() => nav(to)}>
      <Icon name={icon} /><span>{label}</span>
    </button>
  )

  return (
    <nav id="tabbar">
      <div className="tab-group">
        <Tab k="home" icon="house" to="/home" label={t('Home')} />
        <Tab k="plan" icon="calendar" to="/plan" label={t('Plan')} />
        <Tab k="library" icon="list" to="/library" label={t('Exercises')} />
      </div>
      <button className={'start' + (!adminView && S.active ? ' rec' : '') + (adminView ? ' admin-return' : '')} onClick={adminView ? onAdminReturn : startWorkout} aria-label={adminView ? 'Return to Admin panel' : undefined}>
        <span className="cir"><Icon name={adminView ? 'personCircle' : S.active ? 'play' : 'dumbbell'} /></span>
        <span>{adminView ? 'Admin' : S.active ? t('Resume') : t('Start')}</span>
      </button>
      <div className="tab-group">
        <Tab k="stats" icon="chart" to="/stats" label={t('Stats')} />
        <Tab k="food" icon="plate" to="/food" label="Food" />
      </div>
    </nav>
  )
}
