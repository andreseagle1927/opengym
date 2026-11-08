import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { api, apiBaseUrl } from '../lib/api.js'
import { dateLocale } from '../lib/i18n.js'
import { todayISO, uid } from '../lib/format.js'
import { entriesForDate, MEALS } from '../lib/food.js'
import Icon from '../components/Icon.jsx'
import { Button } from '../components/ui.jsx'

const shiftDate = (iso, days) => { const d = new Date(`${iso}T12:00:00`); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10) }
const idOf = food => String(food?.id || '')
const imageSrc = url => url ? (/^https?:/i.test(url) ? url : `${apiBaseUrl}${url}`) : ''
const snapshot = food => ({ id: food.id, name: food.name, imageUrl: food.imageUrl || null })
const MEAL_EXAMPLE_IDS = {
  breakfast: ['food-banana', 'food-oats', 'food-yogurt'], lunch: ['food-chicken', 'food-rice', 'food-eggs'],
  dinner: ['food-chicken', 'food-rice', 'food-yogurt'], snacks: ['food-banana', 'food-eggs', 'food-yogurt']
}

function FoodPicker({ context, foods, favorites, onAdd, onFavorite, onClose }) {
  const [tab, setTab] = useState('search'), [query, setQuery] = useState(''), [selected, setSelected] = useState(null), [amount, setAmount] = useState('')
  const source = tab === 'favorites' ? favorites : foods
  const results = source.filter(food => String(food.name || '').toLowerCase().includes(query.trim().toLowerCase()))
  const favorite = selected && favorites.some(food => idOf(food) === idOf(selected))
  return <div className="food-dialog">
    <button className="food-dialog-backdrop" onClick={onClose} aria-label="Close food picker" />
    <section className="food-dialog-card food-picker-card">
      <div className="row between"><div><h2>Add to {MEALS.find(m => m.id === context.meal)?.label}</h2><div className="small muted">{context.mode === 'plan' ? 'Meal plan' : 'Food diary'} · {context.date}</div></div><button className="iconbtn" onClick={onClose} aria-label="Close"><Icon name="xmark" /></button></div>
      {!selected ? <>
        <div className="food-tabs"><button className={tab === 'search' ? 'on' : ''} onClick={() => setTab('search')}>Foods</button><button className={tab === 'favorites' ? 'on' : ''} onClick={() => setTab('favorites')}>Favorites</button></div>
        <div className="food-search"><Icon name="magnifier" /><input autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder="Search foods…" /></div>
        {tab === 'search' && !query.trim() && <div className="food-example-label">Shared foods · choose one to add</div>}
        {!results.length ? <div className="food-status">{tab === 'favorites' && !favorites.length ? 'No favorites saved yet.' : 'No foods found. Ask an Admin to add it to the shared library.'}</div> : <div className="food-results">{results.map(food => <button key={idOf(food)} onClick={() => setSelected(food)}>
          {food.imageUrl ? <img className="food-icon-preview" src={imageSrc(food.imageUrl)} alt="" /> : <span className="food-icon-placeholder"><Icon name="plate" /></span>}
          <div className="grow"><strong>{food.name}</strong><small>{tab === 'favorites' ? 'Favorite' : 'Shared food'}</small></div><Icon name="chevronRight" className="chev" />
        </button>)}</div>}
      </> : <>
        <button className="food-back" onClick={() => setSelected(null)}><Icon name="chevronLeft" /> Back to foods</button>
        <div className="food-selected">
          <div className="row between"><div className="row" style={{ gap: 10 }}>{selected.imageUrl ? <img className="food-icon-preview" src={imageSrc(selected.imageUrl)} alt="" /> : <span className="food-icon-placeholder"><Icon name="plate" /></span>}<h3>{selected.name}</h3></div>
            <button className="iconbtn" onClick={() => onFavorite(selected)} aria-label="Toggle favorite"><Icon name={favorite ? 'starFill' : 'star'} /></button></div>
          <label className="food-field" style={{ margin: '15px 0 12px' }}><span>Amount <small>(optional)</small></span><div className="food-input-unit"><input type="number" min="0" step="any" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} placeholder="Optional" /><small>g</small></div></label>
          <Button variant="primary" icon="plus" onClick={() => onAdd(selected, amount === '' ? null : Math.max(0, Number(amount) || 0))}>{context.mode === 'plan' ? 'Add to plan' : 'Add to diary'}</Button>
        </div>
      </>}
      <div className="food-source">Food names and icons are managed by your Admin.</div>
    </section>
  </div>
}

export default function Food() {
  const S = useStore(s => s.S), update = useStore(s => s.update), toast = useUI(s => s.toast)
  const [date, setDate] = useState(todayISO()), [mode, setMode] = useState('diary'), [picker, setPicker] = useState(null), [foods, setFoods] = useState([])
  const diary = S.foodDiary || [], plan = S.foodPlan || [], favorites = S.favoriteFoods || []
  const entries = entriesForDate(mode === 'plan' ? plan : diary, date)
  const monday = new Date(`${date}T12:00:00`); monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7))
  const week = Array.from({ length: 7 }, (_, i) => { const d = new Date(monday); d.setDate(monday.getDate() + i); return d.toISOString().slice(0, 10) })
  const grouped = useMemo(() => Object.fromEntries(MEALS.map(meal => [meal.id, entries.filter(entry => entry.meal === meal.id)])), [entries])
  useEffect(() => { let alive = true; api('/api/foods/catalog').then(data => { if (alive) setFoods(data.foods || []) }).catch(() => {}); return () => { alive = false } }, [])
  const dateLabel = date === todayISO() ? 'Today' : new Date(`${date}T12:00:00`).toLocaleDateString(dateLocale(), { weekday: 'long', month: 'short', day: 'numeric' })
  const add = (food, amount) => {
    update(s => { const key = picker.mode === 'plan' ? 'foodPlan' : 'foodDiary'; s[key] ||= []; s[key].push({ id: uid(), date: picker.date, meal: picker.meal, food: snapshot(food), amount, grams: amount, createdAt: new Date().toISOString() }) })
    setPicker(null); toast(picker.mode === 'plan' ? 'Added to meal plan' : 'Added to food diary')
  }
  const remove = entry => update(s => { const key = mode === 'plan' ? 'foodPlan' : 'foodDiary'; s[key] = (s[key] || []).filter(item => item.id !== entry.id) })
  const logPlanned = entry => {
    if (diary.some(item => item.sourcePlanId === entry.id)) return toast('Already logged')
    update(s => { s.foodDiary ||= []; s.foodDiary.push({ ...entry, id: uid(), date, sourcePlanId: entry.id, createdAt: new Date().toISOString() }) })
    toast('Logged as eaten')
  }
  const copyTomorrow = () => {
    if (!entries.length) return toast('Nothing to copy')
    const tomorrow = shiftDate(date, 1)
    update(s => { s.foodPlan ||= []; s.foodPlan.push(...entries.map(entry => ({ ...entry, id: uid(), date: tomorrow, createdAt: new Date().toISOString() }))) })
    setDate(tomorrow); toast('Plan copied to tomorrow')
  }
  const toggleFavorite = food => update(s => { s.favoriteFoods ||= []; const id = idOf(food); s.favoriteFoods = s.favoriteFoods.some(item => idOf(item) === id) ? s.favoriteFoods.filter(item => idOf(item) !== id) : [...s.favoriteFoods, snapshot(food)] })
  const quickAdd = (food, meal) => {
    update(s => { const key = mode === 'plan' ? 'foodPlan' : 'foodDiary'; s[key] ||= []; s[key].push({ id: uid(), date, meal, food: snapshot(food), amount: null, grams: null, createdAt: new Date().toISOString() }) })
    toast(mode === 'plan' ? 'Added to meal plan' : 'Added to food diary')
  }

  return <div className="narrow food-view">
    <div className="hdr"><div><h1>Food</h1><div className="sub">Diary and weekly meal plan</div></div></div>
    <div className="food-mode"><button className={mode === 'diary' ? 'on' : ''} onClick={() => setMode('diary')}>Diary</button><button className={mode === 'plan' ? 'on' : ''} onClick={() => setMode('plan')}>Meal plan</button></div>
    <div className="card food-day-card">
      <div className="row between"><button className="iconbtn" onClick={() => setDate(shiftDate(date, -1))} aria-label="Previous day"><Icon name="chevronLeft" /></button><div className="food-date"><strong>{dateLabel}</strong><small>{date}</small></div><button className="iconbtn" onClick={() => setDate(shiftDate(date, 1))} aria-label="Next day"><Icon name="chevronRight" /></button></div>
      {mode === 'plan' && <div className="food-week">{week.map(iso => <button key={iso} className={iso === date ? 'on' : ''} onClick={() => setDate(iso)}><small>{new Date(`${iso}T12:00:00`).toLocaleDateString(dateLocale(), { weekday: 'narrow' })}</small><span>{Number(iso.slice(-2))}</span><i className={plan.some(entry => entry.date === iso) ? 'has' : ''} /></button>)}</div>}
      <div className="row between food-summary-caption"><span>{mode === 'plan' ? `${entries.length} planned ${entries.length === 1 ? 'item' : 'items'}` : `${entries.length} ${entries.length === 1 ? 'item' : 'items'} logged`}</span>{mode === 'plan' && <button onClick={copyTomorrow}><Icon name="copy" /> Copy to tomorrow</button>}</div>
    </div>
    {MEALS.map(meal => <section className="food-meal" key={meal.id}>
      <div className="row between food-meal-head"><div><h2>{meal.label}</h2><span>{grouped[meal.id].length} {grouped[meal.id].length === 1 ? 'food' : 'foods'}</span></div><button className="iconbtn" onClick={() => setPicker({ mode, meal: meal.id, date })} aria-label={`Add to ${meal.label}`}><Icon name="plus" /></button></div>
      {grouped[meal.id].length ? <div className="food-entry-list">{grouped[meal.id].map(entry => {
        const eaten = mode === 'plan' && diary.some(item => item.sourcePlanId === entry.id)
        return <div className="food-entry" key={entry.id}>{entry.food?.imageUrl ? <img className="food-icon-preview" src={imageSrc(entry.food.imageUrl)} alt="" /> : <span className="food-icon-placeholder"><Icon name="plate" /></span>}
          <div className="grow"><strong>{entry.food?.name || 'Food'}</strong><small>{entry.amount || entry.grams ? `${entry.amount || entry.grams}g · ` : ''}{mode === 'plan' ? 'Planned' : 'Logged'}</small></div>
          {mode === 'plan' && <button className={`food-eaten ${eaten ? 'on' : ''}`} onClick={() => logPlanned(entry)}><Icon name={eaten ? 'checkCircle' : 'check'} /><span>{eaten ? 'Eaten' : 'Log'}</span></button>}
          <button className="food-remove" onClick={() => remove(entry)} aria-label="Remove"><Icon name="trash" /></button>
        </div>
      })}</div> : <>
        <button className="food-empty-meal" onClick={() => setPicker({ mode, meal: meal.id, date })}><Icon name="plus" /> Add food</button>
        {foods.length > 0 && <div className="food-example-picks"><span>Examples</span>{(MEAL_EXAMPLE_IDS[meal.id] || []).map(id => { const food = foods.find(item => idOf(item) === id); return food && <button key={id} onClick={() => quickAdd(food, meal.id)}>{food.name}</button> })}</div>}
      </>}
    </section>)}
    {picker && <FoodPicker context={picker} foods={foods} favorites={favorites} onFavorite={toggleFavorite} onAdd={add} onClose={() => setPicker(null)} />}
  </div>
}
