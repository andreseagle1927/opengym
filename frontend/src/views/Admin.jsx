import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { api } from '../lib/api.js'
import { fmtDate, fmtNum, fmtVol, fmtDur } from '../lib/format.js'
import { workoutVolume, setsDone, exLine } from '../lib/history.js'
import { confirmSheet } from '../sheets.jsx'
import Icon from '../components/Icon.jsx'
import { Button } from '../components/ui.jsx'
import { allExercises, BODYPARTS } from '../lib/exercises.js'
import { uid, todayISO, DAYN } from '../lib/format.js'
import { DEFAULT_GLYPH } from '../lib/glyphs.js'
import { MEALS } from '../lib/food.js'
import { defaultConfig } from '../lib/history.js'
import BodyMap from '../components/BodyMap.jsx'
import { MUSCLES, MUSCLE_NAME } from '../lib/muscles.js'
import { registerAdminExercises } from '../lib/exercises.js'

// Admin-only operator dashboard (owner passkey + admin flag; guarded again server-side).
// Deliberately English-only — it isn't part of the translated end-user surface, so it stays
// out of the per-language string packs.

const rel = ts => {
  if (!ts) return 'never'
  const s = Math.max(0, (Date.now() - ts) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return Math.floor(s / 60) + 'm ago'
  if (s < 86400) return Math.floor(s / 3600) + 'h ago'
  return Math.floor(s / 86400) + 'd ago'
}
const dur = ms => { const m = Math.max(0, Math.floor(ms / 60000)); return m < 60 ? m + 'm' : Math.floor(m / 60) + 'h' + (m % 60) + 'm' }
const userActions = [
  { title: 'Create a plan', description: 'Add a routine and choose its training days.', icon: 'calendar', key: 'plan' },
  { title: 'Add an exercise', description: 'Save a custom exercise to this profile.', icon: 'dumbbell', key: 'exercise' },
  { title: 'Add food', description: 'Add food to this user’s diary or meal plan.', icon: 'plate', key: 'food' },
]

function CreateForUser({ user, state, savePatch }) {
  const [action, setAction] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [planName, setPlanName] = useState('')
  const [days, setDays] = useState([])
  const [exerciseQuery, setExerciseQuery] = useState('')
  const [selectedExercises, setSelectedExercises] = useState([])
  const [exerciseName, setExerciseName] = useState('')
  const [bodyPart, setBodyPart] = useState('')
  const [description, setDescription] = useState('')
  const [food, setFood] = useState({ foodId: '', grams: '1', date: todayISO(), meal: 'lunch', mode: 'plan' })
  const [sharedFoods, setSharedFoods] = useState([])
  useEffect(() => { api('/api/foods/catalog').then(d => setSharedFoods(d.foods || [])).catch(() => {}) }, [])
  const exerciseOptions = useMemo(() => allExercises({ customEx: state.customEx || [] })
    .filter(ex => ex.n.toLowerCase().includes(exerciseQuery.trim().toLowerCase()))
    .slice(0, 12), [state.customEx, exerciseQuery])

  const submit = async mutate => {
    setSaving(true); setError('')
    try { await savePatch(mutate); setAction('') }
    catch (e) { setError(e.message || 'Could not save this change.') }
    finally { setSaving(false) }
  }
  const createPlan = () => {
    const name = planName.trim()
    if (!name) return setError('Give the plan a name.')
    const routine = { id: uid(), name: name.slice(0, 80), emoji: DEFAULT_GLYPH, ex: selectedExercises.map(id => ({ id, ...defaultConfig(id) })) }
    submit(s => {
      s.routines ||= []; s.routines.push(routine); s.week ||= {}
      days.forEach(day => { s.week[day] = routine.id })
    })
  }
  const createExercise = () => {
    const name = exerciseName.trim()
    if (!name || !bodyPart) return setError('Enter a name and choose a body part.')
    if (allExercises({ customEx: state.customEx || [] }).some(ex => ex.n.toLowerCase() === name.toLowerCase())) return setError('An exercise with this name already exists in the user’s library.')
    const item = { id: 'c' + uid(), n: name.slice(0, 100), bp: bodyPart, desc: description.trim().slice(0, 1000), tg: '', eq: 'custom', custom: true }
    submit(s => { s.customEx ||= []; s.customEx.push(item) })
  }
  const addFood = () => {
    const catalogFood = sharedFoods.find(item => item.id === food.foodId)
    if (!catalogFood || !food.date || !food.meal) return setError('Choose a shared food, date, and meal.')
    const entry = { id: uid(), food: { id: catalogFood.id, name: catalogFood.name, imageUrl: catalogFood.imageUrl || null }, amount: Number(food.grams) || null, grams: Number(food.grams) || null, date: food.date, meal: food.meal }
    submit(s => { const key = food.mode === 'diary' ? 'foodDiary' : 'foodPlan'; s[key] ||= []; s[key].push(entry) })
  }

  return <section className="card admin-create" aria-labelledby="admin-create-title">
    <div className="admin-create-heading"><div>
      <h2 id="admin-create-title">Create for {user.name}</h2>
      <p className="small muted">Changes are saved to this user’s profile.</p>
    </div><span className="tag acc">User profile</span></div>
    <div className="admin-create-grid">
      {userActions.map(item => <button key={item.key} type="button" className="admin-create-action" onClick={() => { setAction(item.key); setError('') }}>
        <span className="admin-create-icon"><Icon name={item.icon} /></span>
        <span className="admin-create-copy"><strong>{item.title}</strong><small>{item.description}</small></span>
        <Icon name="chevronRight" className="admin-create-chevron" />
      </button>)}
    </div>
    {action && <div className="admin-create-form">
      <div className="row between"><h3>{action === 'plan' ? 'Create a plan' : action === 'exercise' ? 'Add an exercise' : 'Add food'}</h3><button className="btn plain" onClick={() => setAction('')}>Cancel</button></div>
      {action === 'plan' && <>
        <label className="admin-field"><span>Plan name</span><input className="input" maxLength={80} value={planName} onChange={e => setPlanName(e.target.value)} placeholder="e.g. Strength foundations" /></label>
        <div className="admin-field"><span>Training days <small>(optional)</small></span><div className="admin-day-grid">{[1, 2, 3, 4, 5, 6, 0].map(day => <button type="button" key={day} className={'chip' + (days.includes(day) ? ' on' : '')} onClick={() => setDays(prev => prev.includes(day) ? prev.filter(d => d !== day) : [...prev, day])}>{DAYN[day].slice(0, 3)}</button>)}</div></div>
        <p className="small muted">Selected days will be assigned to this new routine. Existing assignments on those days will be replaced.</p>
        <label className="admin-field"><span>Exercises <small>({selectedExercises.length} selected · defaults to 3 sets of 10 reps)</small></span><input className="input" value={exerciseQuery} onChange={e => setExerciseQuery(e.target.value)} placeholder="Search exercises" /></label>
        {selectedExercises.length > 0 && <div className="admin-selected-exercises">{selectedExercises.map(id => {
          const ex = allExercises({ customEx: state.customEx || [] }).find(item => item.id === id)
          return <button type="button" className="chip on" key={id} aria-label={'Remove ' + (ex?.n || id)} onClick={() => setSelectedExercises(prev => prev.filter(value => value !== id))}>{ex?.n || id} <span aria-hidden="true">×</span></button>
        })}</div>}
        <div className="admin-exercise-options">{exerciseOptions.map(ex => <button type="button" key={ex.id} aria-pressed={selectedExercises.includes(ex.id)} className={'admin-exercise-option' + (selectedExercises.includes(ex.id) ? ' selected' : '')} onClick={() => setSelectedExercises(prev => prev.includes(ex.id) ? prev.filter(id => id !== ex.id) : prev.length < 30 ? [...prev, ex.id] : prev)}>
          <span>{ex.n}</span><small>{selectedExercises.includes(ex.id) ? 'Added' : ex.bp}</small>
        </button>)}</div>
        <Button variant="primary" disabled={saving} onClick={createPlan} icon="plus">{saving ? 'Saving…' : 'Create plan'}</Button>
      </>}
      {action === 'exercise' && <>
        <label className="admin-field"><span>Exercise name</span><input className="input" maxLength={100} value={exerciseName} onChange={e => setExerciseName(e.target.value)} placeholder="e.g. Resistance band row" /></label>
        <div className="admin-field"><span>Body part</span><div className="chips">{BODYPARTS.map(part => <button type="button" key={part} className={'chip' + (bodyPart === part ? ' on' : '')} onClick={() => setBodyPart(part)}>{part}</button>)}</div></div>
        <label className="admin-field"><span>Description <small>(optional)</small></span><textarea className="input" rows={3} maxLength={1000} value={description} onChange={e => setDescription(e.target.value)} placeholder="Setup, cues, or notes" /></label>
        <Button variant="primary" disabled={saving} onClick={createExercise} icon="plus">{saving ? 'Saving…' : 'Add exercise'}</Button>
      </>}
      {action === 'food' && <>
        <label className="admin-field"><span>Shared food</span><select className="input" value={food.foodId} onChange={e => setFood({ ...food, foodId: e.target.value })}><option value="">Choose a food</option>{sharedFoods.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
        <div className="admin-food-grid">
          <label className="admin-field"><span>Amount <small>(optional)</small></span><input className="input" type="number" min="0" value={food.grams} onChange={e => setFood({ ...food, grams: e.target.value })} /></label>
          <label className="admin-field"><span>Date</span><input className="input" type="date" value={food.date} onChange={e => setFood({ ...food, date: e.target.value })} /></label>
          <label className="admin-field"><span>Meal</span><select className="input" value={food.meal} onChange={e => setFood({ ...food, meal: e.target.value })}>{MEALS.map(meal => <option key={meal.id} value={meal.id}>{meal.label}</option>)}</select></label>
          <label className="admin-field"><span>Save to</span><select className="input" value={food.mode} onChange={e => setFood({ ...food, mode: e.target.value })}><option value="plan">Meal plan</option><option value="diary">Food diary</option></select></label>
        </div>
        <Button variant="primary" disabled={saving} onClick={addFood} icon="plus">{saving ? 'Saving…' : 'Add food'}</Button>
      </>}
      {error && <p className="small" role="alert" style={{ color: 'var(--red)', marginBottom: 0 }}>{error}</p>}
    </div>}
  </section>
}

function ProfileSection({ title, icon, count, showCount = true, children }) {
  if (!count) return null
  return <details className="admin-data-section">
    <summary>
      <span className="admin-data-icon"><Icon name={icon} /></span>
      <span className="admin-data-title">{title}</span>
      {showCount && <span className="tag acc">{count}</span>}
      <Icon name="chevronDown" className="admin-data-chevron" />
    </summary>
    <div className="admin-data-content">{children}</div>
  </details>
}

function ProfileGroup({ title, icon, count, empty, children }) {
  return <section className="admin-profile-group">
    <div className="admin-profile-group-heading"><span className="admin-profile-group-icon"><Icon name={icon} /></span><h5>{title}</h5></div>
    {count ? <div className="admin-profile-group-list">{children}</div> : <div className="admin-profile-empty"><span className="admin-profile-empty-icon"><Icon name={icon} /></span><span>{empty}</span></div>}
  </section>
}

function SharedCatalogs() {
  const [tab, setTab] = useState('exercises'), [exercises, setExercises] = useState([]), [foods, setFoods] = useState([])
  const [name, setName] = useState(''), [bodyPart, setBodyPart] = useState('chest'), [equipment, setEquipment] = useState(''), [description, setDescription] = useState(''), [muscles, setMuscles] = useState([]), [image, setImage] = useState(''), [editId, setEditId] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [imagePreview, setImagePreview] = useState('')
  const imageInput = useRef(null)
  const reload = async () => { const [a, b] = await Promise.all([api('/api/exercises/catalog'), api('/api/foods/catalog')]); setExercises(a.exercises || []); registerAdminExercises(a.exercises || []); setFoods(b.foods || []) }
  useEffect(() => { reload().catch(e => setError(e.message)) }, [])
  const reset = () => { setName(''); setDescription(''); setEquipment(''); setImage(''); setImagePreview(''); setMuscles([]); setEditId(''); setError(''); if (imageInput.current) imageInput.current.value = '' }
  const chooseImage = file => {
    if (!file) return
    if (file.size > 5 * 1024 * 1024 || (file.type !== 'image/png' && !file.name.toLowerCase().endsWith('.png'))) {
      setError('Choose a PNG image no larger than 5 MB.')
      return
    }
    setError(''); setImage(file)
    const reader = new FileReader()
    reader.onload = () => setImagePreview(String(reader.result || ''))
    reader.onerror = () => setError('Could not preview this image. Try another PNG.')
    reader.readAsDataURL(file)
  }
  const clearImage = () => { setImage(''); setImagePreview(''); if (imageInput.current) imageInput.current.value = '' }
  const openImagePicker = () => { if (imageInput.current) { imageInput.current.value = ''; imageInput.current.click() } }
  const save = async () => {
    if (!name.trim()) return setError('Enter a name.')
    setBusy(true); setError('')
    try {
      if (tab === 'exercises') await api('/api/admin/catalog/exercises', { method: 'POST', body: JSON.stringify({ id: editId || undefined, name, bp: bodyPart, eq: equipment, description, muscleGroups: muscles, tg: muscles[0] || '', sm: muscles.slice(1) }) })
      else {
        let imageBase64 = ''
        if (image instanceof File) imageBase64 = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1] || ''); reader.onerror = reject; reader.readAsDataURL(image) })
        await api('/api/admin/catalog/foods', { method: 'POST', body: JSON.stringify({ id: editId || undefined, name, imageBase64: imageBase64 || undefined, imageUrl: typeof image === 'string' ? image : undefined }) })
      }
      await reload(); reset()
    } catch (e) { setError(e.message || 'Could not save catalog item.') } finally { setBusy(false) }
  }
  const remove = async (type, id) => { setBusy(true); try { await api(`/api/admin/catalog/${type}?id=${encodeURIComponent(id)}`, { method: 'DELETE' }); await reload() } catch (e) { setError(e.message) } finally { setBusy(false) } }
  return <section className="card shared-catalog"><div><h2>Shared libraries</h2><p className="small muted">Admin-managed exercises and foods are available to every user.</p></div>
    <div className="food-mode"><button className={tab === 'exercises' ? 'on' : ''} onClick={() => { setTab('exercises'); reset() }}>Exercises</button><button className={tab === 'foods' ? 'on' : ''} onClick={() => { setTab('foods'); reset() }}>Foods</button></div>
    <label className="admin-field"><span>{tab === 'exercises' ? 'Exercise name' : 'Food name'}</span><input className="input" value={name} maxLength={100} onChange={e => setName(e.target.value)} placeholder={tab === 'exercises' ? 'e.g. Band pull-apart' : 'e.g. Oatmeal'} /></label>
    {tab === 'exercises' ? <>
      <div className="admin-field"><span>Body part</span><div className="chips">{BODYPARTS.map(part => <button type="button" key={part} className={'chip' + (bodyPart === part ? ' on' : '')} onClick={() => setBodyPart(part)}>{part}</button>)}</div></div>
      <label className="admin-field"><span>Equipment</span><input className="input" value={equipment} onChange={e => setEquipment(e.target.value)} placeholder="Body weight, dumbbell…" /></label>
      <label className="admin-field"><span>Description</span><textarea className="input" rows={2} value={description} onChange={e => setDescription(e.target.value)} /></label>
      <div className="admin-field"><span>Tap muscles this exercise trains</span><BodyMap load={{}} selected={muscles} onMuscle={m => setMuscles(x => x.includes(m) ? x.filter(v => v !== m) : [...x, m])}/><div className="small muted">{muscles.length ? muscles.map(m => MUSCLE_NAME[m]).join(' · ') : 'Choose one or more muscles.'}</div></div>
    </> : <div className="admin-field food-image-field"><span>Food image <small>Optional · PNG, up to 5 MB</small></span>
      <input ref={imageInput} id="shared-food-image" className="food-file-input" type="file" accept="image/png,.png" aria-label="Choose a PNG food image" onChange={e => chooseImage(e.target.files?.[0])} />
      {imagePreview ? <div className="food-image-preview-card">
        <img src={imagePreview} alt="Food icon preview" />
        <div className="food-image-preview-copy"><strong>{image instanceof File ? image.name : 'Current food image'}</strong><small>{image instanceof File ? `${(image.size / 1024).toFixed(0)} KB · PNG` : 'Saved PNG image'}</small></div>
        <button type="button" className="food-image-change" onClick={openImagePicker}>Change</button>
        <button type="button" className="iconbtn food-image-remove" aria-label="Remove image" onClick={clearImage}><Icon name="trash" /></button>
      </div> : <button type="button" className="food-image-dropzone" onClick={openImagePicker} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); chooseImage(e.dataTransfer.files?.[0]) }}>
        <span className="food-image-upload-icon"><Icon name="upload" /></span>
        <strong>Choose a food image</strong><small>Tap to browse or drop a PNG here</small>
        <span className="food-image-format">PNG · MAX 5 MB</span>
      </button>}
    </div>}
    <Button variant="primary" icon={editId ? 'check' : 'plus'} disabled={busy} onClick={save}>{busy ? 'Saving…' : `${editId ? 'Save' : 'Add'} ${tab === 'exercises' ? 'exercise' : 'food'}`}</Button>{editId && <button className="btn plain" onClick={reset}>Cancel edit</button>}{error && <p role="alert" className="small" style={{ color: 'var(--red)' }}>{error}</p>}
    <div className="shared-catalog-list">{(tab === 'exercises' ? exercises : foods).map(item => <div className="row between" key={item.id}><span>{item.name || item.n}{item.archived ? ' · archived' : ''}</span><div className="row"><button className="btn plain" disabled={busy} onClick={() => { setEditId(item.id); setName(item.name || item.n || ''); setBodyPart(item.bp || 'chest'); setEquipment(item.eq || ''); setDescription(item.description || ''); setMuscles(item.muscleGroups || [item.tg,...(item.sm||[])].filter(Boolean)); setImage(item.imageUrl || ''); setImagePreview(item.imageUrl || ''); setError('') }}>Edit</button><button className="btn plain" disabled={busy} onClick={() => remove(tab, item.id)}>{tab === 'foods' ? 'Archive' : 'Remove'}</button></div></div>)}</div>
  </section>
}

function ProfileOverview({ state, unit }) {
  const routines = Array.isArray(state.routines) ? state.routines : []
  const customs = Array.isArray(state.customEx) ? state.customEx : []
  const diary = Array.isArray(state.foodDiary) ? [...state.foodDiary].sort((a,b)=>(b.date||'').localeCompare(a.date||'')) : []
  const meals = Array.isArray(state.foodPlan) ? [...state.foodPlan].sort((a,b)=>(b.date||'').localeCompare(a.date||'')) : []
  const favorites = Array.isArray(state.favoriteFoods) ? state.favoriteFoods : []
  const weights = Array.isArray(state.bodyweight) ? [...state.bodyweight].sort((a,b)=>(b.d||'').localeCompare(a.d||'')) : []
  const index = new Map(allExercises({ customEx: customs }).map(ex => [ex.id, ex]))
  const daysFor = id => [1,2,3,4,5,6,0].filter(day => state.week?.[day] === id).map(day => DAYN[day].slice(0,3))
  const foodRows = (entries, prefix) => entries.map((entry,i) => <div className="admin-data-item" key={entry.id || `${prefix}-${i}`}><div className="row between"><strong>{entry.food?.name || 'Unnamed food'}</strong><span className="tag">{MEALS.find(m=>m.id===entry.meal)?.label || entry.meal || 'Meal'}</span></div><div className="small muted">{entry.date ? fmtDate(entry.date,true) : 'Date unavailable'}{entry.amount || entry.grams ? ` · ${fmtNum(Number(entry.amount||entry.grams))}` : ''}</div></div>)
  const profile=state.profile||{}, health=profile.health||{}
  return <div className="admin-profile-overview"><h4 className="sec">Profile details</h4>
    <ProfileGroup title="Training" icon="figureStrength" count={routines.length+customs.length+weights.length} empty="No training data saved yet.">
      <ProfileSection title="Plans and weekly schedule" icon="calendar" count={routines.length}>{routines.map((routine,i)=><div className="admin-data-item" key={routine.id||i}><div className="row between"><strong>{routine.name||'Untitled plan'}</strong><span className="tag">{daysFor(routine.id).join(' · ')||'Unscheduled'}</span></div>{(routine.ex||[]).map((cfg,j)=><div className="admin-data-subitem" key={`${cfg.id}-${j}`}><span>{index.get(cfg.id)?.n||'Unknown exercise'}</span><small>{exLine(cfg,unit||'kg')}</small></div>)}</div>)}</ProfileSection>
      <ProfileSection title="Custom exercises" icon="dumbbell" count={customs.length}>{customs.map((ex,i)=><div className="admin-data-item" key={ex.id||i}><strong>{ex.n}</strong><div className="small muted">{ex.bp}{ex.eq?` · ${ex.eq}`:''}</div></div>)}</ProfileSection>
      <ProfileSection title="Weight history" icon="scale" count={weights.length}>{weights.map((item,i)=><div className="admin-data-item row between" key={`${item.d}-${i}`}><span>{fmtDate(item.d,true)}</span><strong>{fmtNum(Number(item.w)||0)} {unit||'kg'}</strong></div>)}</ProfileSection>
    </ProfileGroup>
    <ProfileGroup title="Food" icon="plate" count={diary.length+meals.length+favorites.length} empty="No food data saved yet.">
      <ProfileSection title="Food diary" icon="plate" count={diary.length}>{foodRows(diary,'diary')}</ProfileSection><ProfileSection title="Meal plan" icon="clipboard" count={meals.length}>{foodRows(meals,'plan')}</ProfileSection>
      <ProfileSection title="Favorite foods" icon="starFill" count={favorites.length}>{favorites.map((food,i)=><div className="admin-data-item" key={food.id||i}>{food.name}</div>)}</ProfileSection>
    </ProfileGroup>
    <ProfileGroup title="Health and profile" icon="personCircle" count={1} empty="No profile details saved.">
      <ProfileSection title="Health answers" icon="heart" count={health.conditions?.length||(health.notes?1:0)}><div className="admin-data-item"><strong>{health.conditions?.length?health.conditions.join(' · '):'No conditions selected'}</strong>{health.notes&&<p className="small muted">{health.notes}</p>}</div></ProfileSection>
      <ProfileSection title="Measurements and availability" icon="calendar" count={1}><div className="admin-data-item">Height: {profile.heightCm?`${profile.heightCm} cm`:'—'} · Waist: {profile.waistCm?`${profile.waistCm} cm`:'—'}</div><div className="admin-data-item">Available: {Object.entries(profile.availability||{}).filter(([,v])=>(typeof v==='string'?v:v?.status)==='free').map(([d,v])=>`${DAYN[Number(d)]}${typeof v==='object'&&v.start&&v.end?` ${v.start}–${v.end}`:''}`).join(', ')||'Not provided'}</div><div className="admin-data-item">Safety acknowledgment: {profile.consent?.acceptedAt?`accepted ${fmtDate(profile.consent.acceptedAt.slice(0,10),true)}`:'not completed'}</div></ProfileSection>
    </ProfileGroup>
  </div>
}

function UserDetail({ id, onChanged, close, openApp }) {
  const [d, setD] = useState(null)
  const [resetCode, setResetCode] = useState('')
  const toast = useUI(s => s.toast)
  const load = () => api('/api/admin/user?id=' + encodeURIComponent(id)).then(data => {
    setD(data)
  }).catch(e => toast(e.message))
  useEffect(() => { load() }, [id])
  if (!d) return <div className="muted small">Loading…</div>
  const u = d.user
  const state = d.state || {}
  const savedGroups = [
    { key: 'training', title: 'Training', icon: 'figureStrength', items: [
      { label: 'Routines', icon: 'calendar', value: state.routines?.length || 0 },
      { label: 'Custom exercises', icon: 'dumbbell', value: state.customEx?.length || 0 },
      { label: 'Workout history', icon: 'clock', value: state.workouts?.length || 0 },
      { label: 'Scheduled days', icon: 'calendar', value: Object.values(state.week || {}).filter(Boolean).length }
    ] },
    { key: 'food', title: 'Food', icon: 'plate', items: [
      { label: 'Food diary entries', icon: 'plate', value: state.foodDiary?.length || 0 },
      { label: 'Planned meals', icon: 'clipboard', value: state.foodPlan?.length || 0 },
      { label: 'Favorite foods', icon: 'starFill', value: state.favoriteFoods?.length || 0 },
    ] },
    { key: 'progress', title: 'Progress', icon: 'scale', items: [
      { label: 'Weigh-ins', icon: 'scale', value: state.bodyweight?.length || 0 }
    ] }
  ]
  const savedCategoryCount = savedGroups.filter(group => group.items.some(item => item.isConfigured ?? (item.status === 'Set' || Number(item.value) > 0))).length
  const savePatch = async mutate => {
    // Read the latest revision first, then patch only the fields this action owns.
    // This preserves profile changes made while the admin was viewing this page.
    const latest = await api('/api/admin/user?id=' + encodeURIComponent(u.id))
    const next = JSON.parse(JSON.stringify(latest.state || {}))
    mutate(next)
    await api('/api/admin/user/data', { method: 'PUT', body: JSON.stringify({ id: u.id, expectedRev: latest.rev, state: next }) })
    toast('Saved to ' + u.name + '’s profile')
    await load(); onChanged()
  }
  const setDisabled = disabled => {
    api('/api/admin/user/disable', { method: 'POST', body: JSON.stringify({ id: u.id, disabled }) })
      .then(() => { toast(disabled ? 'User disabled' : 'User enabled'); onChanged(); close() })
      .catch(e => toast(e.message))
  }
  const issuePasswordReset = async () => {
    try {
      const { code } = await api('/api/admin/user/password-reset', { method: 'POST', body: JSON.stringify({ id: u.id }) })
      setResetCode(code)
    } catch (e) { toast(e.message || 'Could not issue reset code') }
  }
  return <>
    <div className="row between" style={{ alignItems: 'center' }}>
      <h2 className="capitalize" style={{ margin: 0 }}>{u.name}</h2>
      <div className="row" style={{ gap: 6 }}>
        <button className="btn plain" onClick={close}>Back to users</button>
        <button className="btn primary" onClick={() => openApp(id)}>Open app</button>
      </div>
    </div>
    <div className="row" style={{ gap: 6, flexWrap: 'wrap', margin: '8px 0 12px' }}>
      {u.admin && <span className="tag acc">admin</span>}
      {u.disabled && <span className="tag" style={{ color: 'var(--red)' }}>disabled</span>}
      {u.invitedBy && <span className="tag">invite {u.invitedBy}</span>}
      <span className="tag">joined {u.created ? fmtDate(u.created.slice(0, 10)) : '—'}</span>
      <span className="tag">{u.email || 'email unavailable'}</span>
      {(u.authMethods || []).map(method => <span className="tag" key={method}>{method}</span>)}
    </div>
    <div className="tiles" style={{ textAlign: 'left' }}>
      <div className="tile"><div className="l">Workouts</div><div className="v" style={{ fontSize: '1.1rem' }}>{d.workouts.length}</div></div>
      <div className="tile"><div className="l">Weigh-ins</div><div className="v" style={{ fontSize: '1.1rem' }}>{d.bodyweight.length}</div></div>
      <div className="tile"><div className="l">Routines</div><div className="v" style={{ fontSize: '1.1rem' }}>{d.routines.length}</div></div>
      <div className="tile"><div className="l">Last sync</div><div className="v" style={{ fontSize: '.95rem' }}>{rel(d.lastSync)}</div></div>
    </div>
    {!u.admin && <button className={'btn ' + (u.disabled ? 'primary' : 'danger')} style={{ margin: '12px 0 4px' }}
      onClick={() => u.disabled ? setDisabled(false)
        : confirmSheet({ title: 'Disable ' + u.name + '?', message: 'They are signed out everywhere and can no longer sync or log in until re-enabled.', confirmText: 'Disable', danger: true, onConfirm: () => setDisabled(true) })}>
      {u.disabled ? 'Enable account' : 'Disable account'}</button>}
    {u.authMethods?.includes('password') && <>
      <button className="btn plain" style={{ margin: '8px 0 4px' }} onClick={issuePasswordReset}>Issue password reset code</button>
      {resetCode && <div className="card small" style={{ marginTop: 8 }}>
        <div className="muted">Share this one-time code with the account owner. It expires in 15 minutes.</div>
        <code style={{ display: 'block', overflowWrap: 'anywhere', margin: '8px 0' }}>{resetCode}</code>
        <button className="btn plain" onClick={() => navigator.clipboard?.writeText(resetCode).then(() => toast('Reset code copied'))}>Copy code</button>
      </div>}
    </>}
    <section className="admin-saved-data" aria-labelledby="admin-saved-data-title">
      <div className="admin-saved-heading"><div><h4 className="sec" id="admin-saved-data-title">Saved data</h4><p>Profile records grouped by category</p></div><span className="admin-saved-summary"><Icon name="chartLine" />{savedCategoryCount} {savedCategoryCount === 1 ? 'category' : 'categories'} with data</span></div>
      <div className="admin-saved-groups">{savedGroups.map(group => <section className={'admin-saved-group admin-saved-' + group.key} key={group.key}>
        <h5><span><Icon name={group.icon} /></span>{group.title}</h5>
        <div className="admin-saved-grid">{group.items.map(item => {
          const hasData = item.isConfigured ?? (item.status === 'Set' || Number(item.value) > 0)
          return <div className={'admin-saved-card' + (hasData ? ' has-data' : '')} key={item.label}>
            <span className="admin-saved-icon"><Icon name={item.icon} /></span>
            <span className="admin-saved-label">{item.label}</span>
            <strong>{item.status || item.value}</strong>
            <span className={'admin-saved-state' + (hasData ? ' saved' : '')}>{item.stateText || (item.status ? (hasData ? 'Configured' : 'Needs setup') : (hasData ? 'Saved' : 'No records'))}</span>
          </div>
        })}</div>
      </section>)}</div>
    </section>
    <h4 className="sec">Workout history</h4>
    {d.workouts.length ? <div className="list" style={{ gap: 0 }}>
      {d.workouts.slice(0, 60).map(w => <div key={w.id} className="row between" style={{ padding: '9px 2px', borderBottom: '1px solid var(--sep)' }}>
        <div><div className="small" style={{ fontWeight: 600 }}>{w.name}</div>
          <div className="dim" style={{ fontSize: '.72rem' }}>{fmtDate(w.d, true)} · {fmtDur((w.end || w.start) - w.start)} · {setsDone(w)} sets{w.prs?.length ? ' · ' + w.prs.length + ' PR' : ''}</div></div>
        <span className="small muted">{fmtVol(w.vol ?? workoutVolume(w), d.unit)}</span>
      </div>)}
    </div> : <div className="empty small">No workouts logged.</div>}
    <ProfileOverview state={state} unit={d.unit} />
    <h4 className="sec">Admin change history</h4>
    {d.audit?.length ? <div className="list" style={{ gap: 0 }}>{d.audit.map((row, i) => <div key={row.at + i} className="small" style={{ padding: '8px 2px', borderBottom: '1px solid var(--sep)' }}>
      <strong>{row.actorName || 'Admin'}</strong> changed {row.changed.join(', ') || 'profile data'} · {fmtDate(row.at.slice(0, 10))}
    </div>)}</div> : <div className="empty small">No admin changes recorded.</div>}
  </>
}

function InvitesCard({ invites, reload }) {
  const toast = useUI(s => s.toast)
  const gen = () => api('/api/admin/invites/new', { method: 'POST', body: '{}' })
    .then(({ invite }) => { navigator.clipboard?.writeText(invite.code).catch(() => {}); toast('Code ' + invite.code + ' created & copied'); reload() })
    .catch(e => toast(e.message))
  const revoke = code => api('/api/admin/invites/revoke', { method: 'POST', body: JSON.stringify({ code }) })
    .then(() => { toast('Code revoked'); reload() }).catch(e => toast(e.message))
  const open = (invites || []).filter(i => !i.usedBy)
  const used = (invites || []).filter(i => i.usedBy)
  return <section className="card admin-invites">
    <div className="row between admin-invites-heading"><div><h2>Invite codes</h2>
      <p className="small muted">Create a code to let someone register.</p></div>
      <Button variant="primary" size="sm" onClick={gen} icon="plus">Generate</Button></div>
    <details className="admin-invites-details">
      <summary><span>Manage codes</span><span className="tag">{open.length} unused · {used.length} redeemed</span></summary>
      <div className="admin-invites-list">
        {open.map(i => <div key={i.code} className="row between admin-invite-code">
          <button className="admin-invite-copy" onClick={() => { navigator.clipboard?.writeText(i.code).catch(() => {}); toast('Copied ' + i.code) }} aria-label={'Copy invite code ' + i.code}>{i.code}</button>
          <button className="iconbtn" style={{ width: 32, height: 30, borderRadius: 8, fontSize: 15, color: 'var(--red)' }} onClick={() => revoke(i.code)} aria-label={'Revoke invite code ' + i.code}><Icon name="trash" /></button>
        </div>)}
        {used.map(i => <div key={i.code} className="row between admin-invite-code dim">
          <span className="admin-invite-copy">{i.code}</span><span>Used by {i.usedByName || 'a user'}</span>
        </div>)}
        {!open.length && !used.length && <div className="dim small">No codes yet. Generate one to invite someone.</div>}
      </div>
    </details>
  </section>
}

export default function Admin() {
  const nav = useNavigate()
  const user = useStore(s => s.user)
  const toast = useUI(s => s.toast)
  const [users, setUsers] = useState(null)
  const [invites, setInvites] = useState(null)
  const [inviteOnly, setInviteOnly] = useState(false)
  const [selectedUser, setSelectedUser] = useState(null)
  const [query, setQuery] = useState('')
  const [userFilter, setUserFilter] = useState('all')
  const [openingUser, setOpeningUser] = useState('')

  const loadUsers = () => api('/api/admin/users').then(d => { setUsers(d.users); setInviteOnly(d.invite_only) }).catch(e => toast(e.message || 'Failed to load'))
  const loadInvites = () => api('/api/admin/invites').then(d => setInvites(d.invites)).catch(() => {})
  // poll every 15s so the "training now" section stays live without a manual refresh
  useEffect(() => { if (!user?.admin) return; loadUsers(); loadInvites(); const iv = setInterval(loadUsers, 15000); return () => clearInterval(iv) }, [])
  if (!user?.admin) return null

  const openUserDetails = id => setSelectedUser(id)
  const openUserApp = async id => {
    setOpeningUser(id)
    try {
      await useStore.getState().enterAdminView(id)
      nav('/home')
    } catch (e) { toast(e.message || 'Could not open this user profile') }
    finally { setOpeningUser('') }
  }
  const liveUsers = (users || []).filter(u => u.live)
  const isRecentlyActive = u => !u.disabled && Boolean(u.lastSync && Date.now() - u.lastSync < 7 * 86400000)
  const activeCount = (users || []).filter(isRecentlyActive).length
  const disabledCount = (users || []).filter(u => u.disabled).length
  const filterCounts = { all: users?.length || 0, active: activeCount, training: liveUsers.length, disabled: disabledCount }
  const filteredUsers = (users || [])
    .filter(u => `${u.name} ${u.email || ''} ${u.id}`.toLowerCase().includes(query.trim().toLowerCase()))
    .filter(u => userFilter === 'all' || (userFilter === 'active' && isRecentlyActive(u)) || (userFilter === 'training' && Boolean(u.live)) || (userFilter === 'disabled' && u.disabled))
    .sort((a, b) => Number(Boolean(b.live)) - Number(Boolean(a.live)) || Number(isRecentlyActive(b)) - Number(isRecentlyActive(a)) || (b.lastSync || 0) - (a.lastSync || 0) || a.name.localeCompare(b.name))

  if (selectedUser) return <div className="narrow">
    <UserDetail id={selectedUser} onChanged={loadUsers} close={() => setSelectedUser(null)} openApp={openUserApp} />
  </div>

  return <div className="narrow">
    <div className="hdr">
      <button className="iconbtn" onClick={() => nav('/settings')} aria-label="Back"><Icon name="chevronLeft" /></button>
      <div style={{ flex: 1, marginLeft: 8 }}><h1 style={{ margin: 0 }}>Admin</h1>
        <div className="sub">Manage users and their profiles</div></div>
      <button className="iconbtn" onClick={() => { loadUsers(); loadInvites() }} aria-label="refresh">↻</button>
    </div>

    <div className="tiles admin-overview-stats" aria-label="User overview">
      {[
        { key: 'users', label: 'Users', icon: 'personCircle', value: users ? users.length : '—', note: 'Registered accounts' },
        { key: 'training', label: 'Training now', icon: 'figureStrength', value: users ? liveUsers.length : '—', note: liveUsers.length === 1 ? 'Live session' : 'Live sessions' },
        { key: 'active', label: 'Active 7d', icon: 'clock', value: users ? activeCount : '—', note: 'Seen this week' },
        { key: 'disabled', label: 'Disabled', icon: 'shield', value: users ? disabledCount : '—', note: 'Access paused' }
      ].map(card => <article className={'admin-stat-card admin-stat-' + card.key} key={card.key}>
        <div className="admin-stat-heading"><span className="admin-stat-icon"><Icon name={card.icon} /></span><span>{card.label}</span></div>
        <div className="admin-stat-reading"><strong>{card.value}</strong><small>{users ? card.note : 'Loading accounts…'}</small></div>
      </article>)}
    </div>

    <SharedCatalogs />

    <section className="admin-users-section">
      <div className="admin-users-heading"><div><h2>Users</h2><p className="small muted">Select a user to view their profile or create content for them.</p></div><span className="tag">{filteredUsers.length} shown</span></div>
      <label className="admin-user-search"><Icon name="magnifier" /><input className="input" type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search name, email, or ID" aria-label="Search users" /></label>
      <div className="admin-user-filters chips" role="group" aria-label="Filter users">
        {[['all', 'All'], ['active', 'Active 7d'], ['training', 'Training now'], ['disabled', 'Disabled']].map(([key, label]) =>
          <button key={key} type="button" className={'chip admin-user-filter admin-filter-' + key + (userFilter === key ? ' on' : '')} aria-pressed={userFilter === key} onClick={() => setUserFilter(key)}>
            {label}<span className="admin-filter-count">{filterCounts[key]}</span>
          </button>)}
      </div>
    <div className="list">
      {filteredUsers.map(u => <div key={u.id} className="item" onClick={() => openUserApp(u.id)} style={u.disabled ? { opacity: .55 } : null} aria-busy={openingUser === u.id}>
        <span className="admin-user-avatar" aria-hidden="true"><Icon name="personCircle" /></span>
        <div className="grow"><div className="tt admin-user-name-row"><span className="admin-user-name">{u.name}</span><span className="admin-user-badges">
          {u.admin && <span className="tag admin-user-role">Admin</span>}
          {!u.disabled && isRecentlyActive(u) && <span className="tag admin-user-active">Active 7d</span>}
          {u.disabled && <span className="tag admin-user-disabled">Disabled</span>}
        </span></div>
          <div className="ss">{openingUser === u.id ? 'Loading profile…' : `${u.email || 'email unavailable'} · ${(u.authMethods || []).join(', ') || 'sign-in method unavailable'}`}</div>
          <div className="admin-user-meta">{u.live ? <span className="admin-user-live"><Icon name="dot" />Training now · {u.live.name} · {u.live.setsDone}/{u.live.setsTotal} sets</span> : <span>{u.workouts} workouts{u.lastWorkout ? ' · last ' + fmtDate(u.lastWorkout) : ''}</span>}<span>Synced {rel(u.lastSync)}</span></div></div>
        {u.hasPush && <Icon name="bell" title="push enabled" style={{ fontSize: 15, color: 'var(--label-3)' }} />}
        <button type="button" className="iconbtn admin-user-manage" aria-label={'Account tools for ' + u.name} title="Account tools" onClick={event => { event.stopPropagation(); openUserDetails(u.id) }}><Icon name="gear" /></button>
        <Icon name="chevronRight" className="chev" />
      </div>)}
      {users && !filteredUsers.length && <div className="empty">{users.length ? 'No users match this search and filter.' : 'No users yet.'}</div>}
    </div>
    </section>
    <InvitesCard invites={invites} reload={loadInvites} />
  </div>
}
