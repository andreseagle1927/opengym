import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { api, apiBaseUrl } from '../lib/api.js'
import { todayISO, uid } from '../lib/format.js'
import { consumePlannedEntry, entriesForDate, MEALS } from '../lib/food.js'
import Icon from '../components/Icon.jsx'
import { Button } from '../components/ui.jsx'

const foodId = food => String(food?.id || '')
const imageSrc = url => url ? (/^https?:/i.test(url) ? url : `${apiBaseUrl}${url}`) : ''
const snapshot = food => ({ id: food.id, name: food.name, imageUrl: food.imageUrl || null })

function FoodPicker({ catalog, favorites, context, onAdd, onFavorite, onClose }) {
  const [query, setQuery] = useState(''), [selected, setSelected] = useState(null), [amount, setAmount] = useState('1')
  const rows = (context.tab === 'favorites' ? favorites : catalog).filter(food => food.name.toLowerCase().includes(query.trim().toLowerCase()))
  return <div className="food-dialog"><button className="food-dialog-backdrop" onClick={onClose} aria-label="Close"/><section className="food-dialog-card food-picker-card">
    <div className="row between"><div><h2>Add food</h2><div className="small muted">{MEALS.find(x => x.id === context.meal)?.label} · {context.mode === 'plan' ? 'Meal plan' : 'Food diary'}</div></div><button className="iconbtn" onClick={onClose}><Icon name="xmark"/></button></div>
    <div className="food-search"><Icon name="magnifier"/><input autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder="Search foods"/></div>
    {selected ? <div className="food-selected"><div className="row between"><div className="row">{selected.imageUrl && <img className="food-icon-preview" src={imageSrc(selected.imageUrl)} alt=""/>}<h3>{selected.name}</h3></div><button className="iconbtn" onClick={() => onFavorite(selected)} aria-label="Toggle favorite"><Icon name={favorites.some(x => foodId(x) === foodId(selected)) ? 'starFill' : 'star'}/></button></div>
      <label className="food-field"><span>Amount (optional)</span><input type="number" min="0" step="any" value={amount} onChange={e => setAmount(e.target.value)} placeholder="1"/></label><Button variant="primary" icon="plus" onClick={() => onAdd(selected, amount)}>Add food</Button><button className="food-back" onClick={() => setSelected(null)}>Back to foods</button>
    </div> : <div className="food-results">{rows.map(food => <button key={food.id} onClick={() => setSelected(food)}>{food.imageUrl ? <img className="food-icon-preview" src={imageSrc(food.imageUrl)} alt=""/> : <span className="food-icon-placeholder"><Icon name="plate"/></span>}<strong>{food.name}</strong></button>)}{!rows.length && <div className="food-status">No foods found. Ask an Admin to add it to the shared library.</div>}</div>}
    <div className="food-source">Food names and icons are managed by your Admin.</div>
  </section></div>
}

export default function Food() {
  const S = useStore(s => s.S), update = useStore(s => s.update), toast = useUI(s => s.toast)
  const [date, setDate] = useState(todayISO()), [mode, setMode] = useState('diary'), [picker, setPicker] = useState(null), [foods, setFoods] = useState([])
  const diary = S.foodDiary || [], plan = S.foodPlan || [], entries = entriesForDate(mode === 'diary' ? diary : plan, date)
  const grouped = useMemo(() => Object.fromEntries(MEALS.map(meal => [meal.id, entries.filter(entry => entry.meal === meal.id)])), [entries])
  useEffect(() => { let alive = true; api('/api/foods/catalog').then(r => { if (alive) setFoods(r.foods || []) }).catch(() => {}); return () => { alive = false } }, [])
  const favoriteList = S.favoriteFoods || []
  const add = (food, amount) => { update(s => { const key = picker.mode === 'plan' ? 'foodPlan' : 'foodDiary'; s[key] ||= []; s[key].push({ id: uid(), date: picker.date, meal: picker.meal, food: snapshot(food), amount: Number(amount) || null, grams: Number(amount) || null, createdAt: new Date().toISOString() }) }); setPicker(null); toast('Food saved') }
  const remove = entry => update(s => { const key = mode === 'plan' ? 'foodPlan' : 'foodDiary'; s[key] = (s[key] || []).filter(x => x.id !== entry.id) })
  const log = entry => { update(s => { s.foodDiary = consumePlannedEntry(s.foodDiary || [], entry, uid()).map(item => item.sourcePlanId === entry.id ? { ...item, date } : item) }); toast('Added to food diary') }
  const toggleFavorite = food => update(s => { s.favoriteFoods ||= []; const id = foodId(food); s.favoriteFoods = s.favoriteFoods.some(x => foodId(x) === id) ? s.favoriteFoods.filter(x => foodId(x) !== id) : [...s.favoriteFoods, snapshot(food)] })
  const moveDate = delta => { const d = new Date(`${date}T12:00:00`); d.setDate(d.getDate() + delta); setDate(d.toISOString().slice(0, 10)) }
  return <div className="food-view">
    <div className="hdr"><div><h1>Food</h1><div className="sub">Simple food diary and meal plan</div></div></div>
    <div className="food-mode"><button className={mode === 'diary' ? 'on' : ''} onClick={() => setMode('diary')}>Diary</button><button className={mode === 'plan' ? 'on' : ''} onClick={() => setMode('plan')}>Meal plan</button></div>
    <section className="card food-day-card"><div className="row between"><button className="iconbtn" onClick={() => moveDate(-1)}><Icon name="chevronLeft"/></button><div className="food-date"><strong>{date === todayISO() ? 'Today' : new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}</strong><small>{date}</small></div><button className="iconbtn" onClick={() => moveDate(1)}><Icon name="chevronRight"/></button></div><input aria-label="Select date" type="date" value={date} onChange={e => setDate(e.target.value)}/></section>
    {MEALS.map(meal => <section className="food-meal" key={meal.id}><div className="food-meal-head row between"><h2>{meal.label}</h2><Button size="sm" variant="tinted" icon="plus" onClick={() => setPicker({ mode, date, meal: meal.id })}>Add</Button></div><div className="food-entry-list">{grouped[meal.id].map(entry => <div className="food-entry" key={entry.id}>{entry.food?.imageUrl ? <img className="food-icon-preview" src={imageSrc(entry.food.imageUrl)} alt=""/> : <span className="food-icon-placeholder"><Icon name="plate"/></span>}<div className="grow"><strong>{entry.food?.name || 'Food'}</strong><small>{entry.amount || entry.grams ? `${entry.amount || entry.grams} · ` : ''}{mode === 'plan' ? 'Planned' : 'Logged'}</small></div>{mode === 'plan' && <button className="iconbtn" onClick={() => log(entry)} title="Log as eaten"><Icon name="check"/></button>}<button className="iconbtn" onClick={() => remove(entry)} aria-label="Remove"><Icon name="trash"/></button></div>)}{!grouped[meal.id].length && <div className="empty-meal">Nothing here yet</div>}</div></section>)}
    {picker && <FoodPicker catalog={foods} favorites={favoriteList} context={picker} onAdd={add} onFavorite={toggleFavorite} onClose={() => setPicker(null)}/>}
  </div>
}
