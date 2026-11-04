import { useState } from 'react'
import { useStore } from '../store/useStore.js'
import { Button } from '../components/ui.jsx'
import Icon from '../components/Icon.jsx'

const CONSENT = 'exercise-safety-v1'
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const CONDITIONS = ['Heart or blood pressure condition', 'Diabetes', 'Injury or movement limitation', 'Pregnancy', 'Other', 'None / prefer not to say']

export default function Onboarding() {
  const S = useStore(s => s.S), user = useStore(s => s.user), update = useStore(s => s.update), consentVersion = useStore(s => s.config?.exercise_consent_version) || CONSENT
  const [weight, setWeight] = useState(''), [height, setHeight] = useState(''), [waist, setWaist] = useState('')
  const [conditions, setConditions] = useState([]), [notes, setNotes] = useState(''), [availability, setAvailability] = useState({})
  const [accepted, setAccepted] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState('')
  const toggle = value => setConditions(c => c.includes(value) ? c.filter(x => x !== value) : value === 'None / prefer not to say' ? [value] : [...c.filter(x => x !== 'None / prefer not to say'), value])
  const save = async () => {
    if (!accepted) return setError('Please read and accept the exercise safety acknowledgment to continue.')
    setSaving(true); setError('')
    update(s => {
      s.profile = { ...(s.profile || {}), heightCm: Number(height) || null, waistCm: Number(waist) || null,
        health: { conditions, notes: notes.trim() }, availability,
        consent: { version: consentVersion, acceptedAt: new Date().toISOString() }, onboardingCompletedAt: new Date().toISOString() }
      if (Number(weight) > 0) { s.bodyweight ||= []; s.bodyweight.push({ d: new Date().toISOString().slice(0, 10), w: Number(weight) }) }
    })
    const ok = await useStore.getState().pushState()
    if (!ok) { setSaving(false); return setError('Could not save your profile yet. Check your connection and try again.') }
    useStore.getState().setUser({ ...user, onboardingRequired: false })
    setSaving(false)
  }
  return <main className="onboarding-wrap">
    <div className="onboarding-card">
      <div className="onboarding-mark"><Icon name="dumbbell" /></div>
      <p className="eyebrow">WELCOME TO OPENGYM</p><h1>Set up your profile</h1>
      <p className="muted">Share only what you want. You can skip optional questions and edit these details later in your profile.</p>
      <section><h2>Measurements <small>Optional</small></h2><div className="onboard-grid">
        <label>Weight ({S.unit || 'kg'})<input type="number" min="1" value={weight} onChange={e => setWeight(e.target.value)} placeholder="e.g. 70" /></label>
        <label>Height (cm)<input type="number" min="1" value={height} onChange={e => setHeight(e.target.value)} placeholder="e.g. 175" /></label>
        <label>Waist (cm)<input type="number" min="1" value={waist} onChange={e => setWaist(e.target.value)} placeholder="Optional" /></label>
      </div></section>
      <section><h2>Health information <small>Optional</small></h2><p className="muted small">This helps you and your coach keep relevant limitations in view. It does not diagnose or prescribe.</p>
        <div className="onboard-checks">{CONDITIONS.map(x => <label key={x}><input type="checkbox" checked={conditions.includes(x)} onChange={() => toggle(x)} />{x}</label>)}</div>
        <label className="onboard-notes">Notes<textarea rows="2" maxLength="500" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Optional details" /></label>
      </section>
      <section><h2>When are you available? <small>Optional</small></h2><div className="onboard-days">{DAYS.map((day, i) => { const entry = typeof availability[i] === 'string' ? { status: availability[i] } : (availability[i] || {}); return <div className="onboard-day" key={day}><span>{day}</span><select value={entry.status || ''} onChange={e => setAvailability(a => ({ ...a, [i]: { ...(typeof a[i] === 'object' ? a[i] : {}), status: e.target.value } }))}><option value="">Skip</option><option value="free">Available</option><option value="busy">Busy</option></select>{entry.status && <div className="onboard-time"><small>Optional time</small><input aria-label={`${day} start time`} type="time" value={entry.start || ''} onChange={e => setAvailability(a => ({ ...a, [i]: { ...(typeof a[i] === 'object' ? a[i] : { status: entry.status }), start: e.target.value } }))}/><span>to</span><input aria-label={`${day} end time`} type="time" value={entry.end || ''} onChange={e => setAvailability(a => ({ ...a, [i]: { ...(typeof a[i] === 'object' ? a[i] : { status: entry.status }), end: e.target.value } }))}/></div>}</div> })}</div></section>
      <section className="consent-box"><h2>Exercise safety acknowledgment</h2><p>Exercise can cause injury. Choose activities appropriate to your abilities, stop if you feel pain or unwell, and seek qualified medical advice when needed. OpenGym provides tracking and general exercise information; it does not replace professional care. Your health answers are saved to your profile and visible to Admin.</p>
        <label><input type="checkbox" checked={accepted} onChange={e => setAccepted(e.target.checked)} /> I have read this acknowledgment and want to continue.</label>
      </section>
      {error && <p className="onboard-error" role="alert">{error}</p>}
      <Button variant="primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save profile and continue'}</Button>
    </div>
  </main>
}
