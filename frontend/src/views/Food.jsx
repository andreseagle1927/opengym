import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { api } from '../lib/api.js'
import { dateLocale } from '../lib/i18n.js'
import { todayISO, uid } from '../lib/format.js'
import { consumePlannedEntry, entriesForDate, foodSnapshot, makeFoodEntry, MEALS, nutritionTotal } from '../lib/food.js'
import Icon from '../components/Icon.jsx'
import { Button } from '../components/ui.jsx'

const isoShift = (iso, days) => {
  const date = new Date(`${iso}T12:00:00`)
  date.setDate(date.getDate() + days)
  return date.toISOString().slice(0, 10)
}
const formatAmount = value => Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 1 })
const foodId = food => String(food?.id || '')
const MEAL_EXAMPLE_IDS = {
  breakfast: [['Banana', 'usda-173944'], ['Cooked oats', 'usda-171675'], ['Yogurt', 'usda-170886']],
  lunch: [['Chicken breast', 'usda-171477'], ['Cooked rice', 'usda-168878'], ['Hard-boiled egg', 'usda-173424']],
  dinner: [['Chicken breast', 'usda-171477'], ['Cooked rice', 'usda-168878'], ['Yogurt', 'usda-170886']],
  snacks: [['Banana', 'usda-173944'], ['Hard-boiled egg', 'usda-173424'], ['Yogurt', 'usda-170886']]
}

function MacroSummary({ total, targets }) {
  const macros = [
    ['kcal', 'Calories', 'kcal'], ['protein', 'Protein', 'g'], ['carbs', 'Carbs', 'g'], ['fat', 'Fat', 'g']
  ]
  return <div className="food-macros">{macros.map(([key, label, unit]) => {
    const target = Number(targets?.[key]) || 0
    const percent = target ? Math.min(100, total[key] / target * 100) : 0
    return <div className="food-macro" key={key}>
      <div className="food-macro-value">{formatAmount(total[key])}<small>{unit}</small></div>
      <div className="food-macro-label">{label}{target ? ` / ${formatAmount(target)}` : ''}</div>
      <div className="food-progress"><i style={{ width: `${percent}%` }} /></div>
    </div>
  })}</div>
}

function TargetsDialog({ targets, onSave, onClose }) {
  const [draft, setDraft] = useState({ ...targets })
  const field = (key, label, suffix) => <label className="food-field"><span>{label}</span><div className="food-input-unit">
    <input inputMode="decimal" type="number" min="0" value={draft[key] ?? ''} onChange={e => setDraft({ ...draft, [key]: e.target.value })} placeholder="Optional" />
    <small>{suffix}</small>
  </div></label>
  return <div className="food-dialog-card">
    <div className="row between"><h2>Daily targets</h2><button className="iconbtn" onClick={onClose}><Icon name="xmark" /></button></div>
    <p className="muted small">Set your own goals. OpenGym does not calculate a diet prescription.</p>
    <div className="food-form-grid">{field('kcal', 'Calories', 'kcal')}{field('protein', 'Protein', 'g')}{field('carbs', 'Carbs', 'g')}{field('fat', 'Fat', 'g')}</div>
    <Button variant="primary" onClick={() => onSave(Object.fromEntries(Object.entries(draft).map(([k, v]) => [k, v === '' || v == null ? null : Math.max(0, Number(v) || 0)])))}>Save targets</Button>
  </div>
}

function FoodPicker({ context, favorites, customFoods, examples, onToggleFavorite, onSaveCustom, onAdd, onClose }) {
  const [tab, setTab] = useState('search')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState(context.initialFood || null)
  const [grams, setGrams] = useState(context.initialFood?.portions?.[0]?.grams || 100)
  const [custom, setCustom] = useState({ name: '', kcal: '', protein: '', carbs: '', fat: '' })

  useEffect(() => {
    if (tab !== 'search') { setResults([]); setLoading(false); return }
    const search = query.trim()
    if (!search) {
      setResults(examples); setLoading(false); setError(''); return
    }
    if (search.length < 2) { setResults([]); setLoading(false); setError(''); return }
    setResults([])
    const timer = setTimeout(async () => {
      setLoading(true); setError('')
      try { setResults((await api(`/api/foods/search?q=${encodeURIComponent(search)}`)).foods || []) }
      catch (e) { setError(e.message || 'Food search is unavailable') }
      finally { setLoading(false) }
    }, 250)
    return () => clearTimeout(timer)
  }, [query, tab, examples])

  const choose = food => {
    setSelected(food)
    setGrams(food.portions?.[0]?.grams || 100)
  }
  const isFavorite = selected && favorites.some(food => foodId(food) === foodId(selected))
  const makeCustom = () => {
    if (!custom.name.trim()) return setError('Enter a food name')
    const food = foodSnapshot({
      id: `custom-${uid()}`, name: custom.name.trim(), category: 'Custom food',
      n: { kcal: custom.kcal, protein: custom.protein, carbs: custom.carbs, fat: custom.fat }
    })
    onSaveCustom(food); choose(food); setError('')
  }
  const list = tab === 'favorites' ? favorites : tab === 'custom' ? customFoods : results

  return <div className="food-dialog-card food-picker-card">
    <div className="row between"><div><h2>Add to {MEALS.find(m => m.id === context.meal)?.label}</h2><div className="small muted">{context.mode === 'plan' ? 'Meal plan' : 'Food diary'} · {context.date}</div></div><button className="iconbtn" onClick={onClose}><Icon name="xmark" /></button></div>
    {!selected ? <>
      <div className="food-tabs"><button className={tab === 'search' ? 'on' : ''} onClick={() => setTab('search')}>Search</button><button className={tab === 'favorites' ? 'on' : ''} onClick={() => setTab('favorites')}>Favorites</button><button className={tab === 'custom' ? 'on' : ''} onClick={() => setTab('custom')}>My foods</button></div>
      {tab === 'search' && <div className="food-search"><Icon name="magnifier" /><input autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder="Search chicken, rice, banana…" /></div>}
      {tab === 'search' && !query.trim() && <div className="food-example-label">Example foods · tap one to add it</div>}
      {tab === 'custom' && <div className="food-custom-form">
        <label className="food-field wide"><span>Name</span><input value={custom.name} onChange={e => setCustom({ ...custom, name: e.target.value })} placeholder="Homemade granola" /></label>
        {['kcal', 'protein', 'carbs', 'fat'].map(key => <label className="food-field" key={key}><span>{key === 'kcal' ? 'Calories' : key[0].toUpperCase() + key.slice(1)} / 100g</span><input type="number" min="0" inputMode="decimal" value={custom[key]} onChange={e => setCustom({ ...custom, [key]: e.target.value })} /></label>)}
        <Button className="wide" icon="plus" onClick={makeCustom}>Save custom food</Button>
      </div>}
      {loading && <div className="food-status">Searching…</div>}
      {error && <div className="food-status error">{error}</div>}
      {!loading && !error && tab !== 'search' && !list.length && <div className="food-status">Nothing saved here yet.</div>}
      {!loading && !error && tab === 'search' && query.length >= 2 && !list.length && <div className="food-status">No foods found.</div>}
      <div className="food-results">{list.map(food => <button key={foodId(food)} onClick={() => choose(food)}>
        <div><strong>{food.name}</strong><small>{food.category || 'Food'}</small></div>
        <span>{formatAmount(food.n.kcal)} kcal<small>{formatAmount(food.n.protein)}g protein</small></span>
      </button>)}</div>
    </> : <>
      <button className="food-back" onClick={() => setSelected(null)}><Icon name="chevronLeft" /> Back to foods</button>
      <div className="food-selected">
        <div className="row between"><div><h3>{selected.name}</h3><div className="small muted">Per 100g: {formatAmount(selected.n.kcal)} kcal · P {formatAmount(selected.n.protein)}g · C {formatAmount(selected.n.carbs)}g · F {formatAmount(selected.n.fat)}g</div></div>
          <button className="iconbtn" onClick={() => onToggleFavorite(selected)} aria-label="Toggle favorite"><Icon name={isFavorite ? 'starFill' : 'star'} /></button></div>
        {!!selected.portions?.length && <div className="food-portions">{selected.portions.map((portion, index) => <button key={index} onClick={() => setGrams(portion.grams)}>{portion.label}<small>{formatAmount(portion.grams)}g</small></button>)}</div>}
        <label className="food-field"><span>Amount</span><div className="food-input-unit"><input type="number" min="1" inputMode="decimal" value={grams} onChange={e => setGrams(e.target.value)} /><small>g</small></div></label>
        <Button variant="primary" icon="plus" onClick={() => onAdd(selected, Math.max(1, Number(grams) || 100))}>{context.mode === 'plan' ? 'Add to plan' : 'Add to diary'}</Button>
      </div>
    </>}
    <div className="food-source">Food data: USDA FoodData Central SR Legacy · nutrients per 100g</div>
  </div>
}

export default function Food() {
  const S = useStore(s => s.S)
  const update = useStore(s => s.update)
  const toast = useUI(s => s.toast)
  const [date, setDate] = useState(todayISO())
  const [mode, setMode] = useState('diary')
  const [picker, setPicker] = useState(null)
  const [targetsOpen, setTargetsOpen] = useState(false)
  const [exampleFoods, setExampleFoods] = useState([])
  const diary = S.foodDiary || [], plan = S.foodPlan || []
  const entries = entriesForDate(mode === 'diary' ? diary : plan, date)
  const total = nutritionTotal(entries)
  const selectedDate = new Date(`${date}T12:00:00`)
  const monday = new Date(selectedDate); monday.setDate(selectedDate.getDate() - ((selectedDate.getDay() + 6) % 7))
  const week = Array.from({ length: 7 }, (_, i) => { const d = new Date(monday); d.setDate(monday.getDate() + i); return d.toISOString().slice(0, 10) })
  const targets = S.nutritionTargets || {}

  useEffect(() => {
    let active = true
    api('/api/foods/examples').then(data => { if (active) setExampleFoods(data.foods || []) }).catch(() => {})
    return () => { active = false }
  }, [])

  const grouped = useMemo(() => Object.fromEntries(MEALS.map(meal => [meal.id, entries.filter(entry => entry.meal === meal.id)])), [entries])
  const add = (food, grams) => {
    update(s => {
      const key = picker.mode === 'plan' ? 'foodPlan' : 'foodDiary'
      s[key] ||= []
      s[key].push(makeFoodEntry({ id: uid(), food, grams, date: picker.date, meal: picker.meal }))
    })
    setPicker(null); toast(mode === 'plan' ? 'Added to meal plan' : 'Added to food diary')
  }
  const remove = entry => update(s => {
    const key = mode === 'plan' ? 'foodPlan' : 'foodDiary'
    s[key] = (s[key] || []).filter(item => item.id !== entry.id)
  })
  const logPlanned = entry => {
    update(s => { s.foodDiary = consumePlannedEntry(s.foodDiary || [], entry, uid()) })
    toast(diary.some(item => item.sourcePlanId === entry.id) ? 'Already logged' : 'Logged as eaten')
  }
  const copyTomorrow = () => {
    if (!entries.length) return toast('Nothing to copy')
    const tomorrow = isoShift(date, 1)
    update(s => {
      s.foodPlan ||= []
      s.foodPlan.push(...entries.map(entry => makeFoodEntry({ id: uid(), food: entry.food, grams: entry.grams, date: tomorrow, meal: entry.meal })))
    })
    setDate(tomorrow); toast('Plan copied to tomorrow')
  }
  const toggleFavorite = food => update(s => {
    s.favoriteFoods ||= []
    const id = foodId(food), exists = s.favoriteFoods.some(item => foodId(item) === id)
    s.favoriteFoods = exists ? s.favoriteFoods.filter(item => foodId(item) !== id) : [...s.favoriteFoods, foodSnapshot(food)]
  })
  const saveCustom = food => update(s => { s.customFoods ||= []; s.customFoods.push(food) })
  const dateLabel = date === todayISO() ? 'Today' : selectedDate.toLocaleDateString(dateLocale(), { weekday: 'long', month: 'short', day: 'numeric' })

  return <div className="narrow food-view">
    <div className="hdr"><div><h1>Food</h1><div className="sub">Diary and weekly meal plan</div></div><button className="iconbtn" onClick={() => setTargetsOpen(true)} aria-label="Nutrition targets"><Icon name="target" /></button></div>
    <div className="food-mode"><button className={mode === 'diary' ? 'on' : ''} onClick={() => setMode('diary')}>Diary</button><button className={mode === 'plan' ? 'on' : ''} onClick={() => setMode('plan')}>Meal plan</button></div>
    <div className="card food-day-card">
      <div className="row between"><button className="iconbtn" onClick={() => setDate(isoShift(date, -1))}><Icon name="chevronLeft" /></button><div className="food-date"><strong>{dateLabel}</strong><small>{date}</small></div><button className="iconbtn" onClick={() => setDate(isoShift(date, 1))}><Icon name="chevronRight" /></button></div>
      {mode === 'plan' && <div className="food-week">{week.map(iso => <button key={iso} className={iso === date ? 'on' : ''} onClick={() => setDate(iso)}><small>{new Date(`${iso}T12:00:00`).toLocaleDateString(dateLocale(), { weekday: 'narrow' })}</small><span>{Number(iso.slice(-2))}</span><i className={plan.some(entry => entry.date === iso) ? 'has' : ''} /></button>)}</div>}
      <MacroSummary total={total} targets={targets} />
      <div className="row between food-summary-caption"><span>{mode === 'plan' ? 'Planned nutrition' : `${entries.length} ${entries.length === 1 ? 'item' : 'items'} logged`}</span>{mode === 'plan' && <button onClick={copyTomorrow}><Icon name="copy" /> Copy to tomorrow</button>}</div>
    </div>

    {MEALS.map(meal => <section className="food-meal" key={meal.id}>
      <div className="row between food-meal-head"><div><h2>{meal.label}</h2><span>{formatAmount(nutritionTotal(grouped[meal.id]).kcal)} kcal</span></div><button className="iconbtn" onClick={() => setPicker({ mode, meal: meal.id, date })}><Icon name="plus" /></button></div>
      {grouped[meal.id].length ? <div className="food-entry-list">{grouped[meal.id].map(entry => {
        const eaten = mode === 'plan' && diary.some(item => item.sourcePlanId === entry.id)
        return <div className="food-entry" key={entry.id}><div className="grow"><strong>{entry.food.name}</strong><small>{formatAmount(entry.grams)}g · {formatAmount(entry.n.kcal)} kcal · P {formatAmount(entry.n.protein)}g · C {formatAmount(entry.n.carbs)}g · F {formatAmount(entry.n.fat)}g</small></div>
          {mode === 'plan' && <button className={`food-eaten ${eaten ? 'on' : ''}`} onClick={() => logPlanned(entry)}><Icon name={eaten ? 'checkCircle' : 'check'} /><span>{eaten ? 'Eaten' : 'Log'}</span></button>}
          <button className="food-remove" onClick={() => remove(entry)} aria-label="Remove"><Icon name="trash" /></button></div>
      })}</div> : <>
        <button className="food-empty-meal" onClick={() => setPicker({ mode, meal: meal.id, date })}><Icon name="plus" /> Add food</button>
        {!!exampleFoods.length && <div className="food-example-picks"><span>Examples</span>{(MEAL_EXAMPLE_IDS[meal.id] || []).map(([label, id]) => {
          const food = exampleFoods.find(item => foodId(item) === id)
          return food && <button key={id} onClick={() => setPicker({ mode, meal: meal.id, date, initialFood: food })}>{label}</button>
        })}</div>}
      </>}
    </section>)}

    <div className="food-attribution">Nutrition data comes from USDA FoodData Central SR Legacy (2018). Values are estimates and may differ by preparation.</div>
    {picker && <div className="food-dialog"><div className="food-dialog-backdrop" onClick={() => setPicker(null)} />
      <FoodPicker context={picker} favorites={S.favoriteFoods || []} customFoods={S.customFoods || []} examples={exampleFoods} onToggleFavorite={toggleFavorite} onSaveCustom={saveCustom} onAdd={add} onClose={() => setPicker(null)} /></div>}
    {targetsOpen && <div className="food-dialog"><div className="food-dialog-backdrop" onClick={() => setTargetsOpen(false)} />
      <TargetsDialog targets={targets} onClose={() => setTargetsOpen(false)} onSave={next => { update(s => { s.nutritionTargets = next }); setTargetsOpen(false); toast('Nutrition targets saved') }} /></div>}
  </div>
}
