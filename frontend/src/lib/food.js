export const MEALS = [
  { id: 'breakfast', label: 'Breakfast' },
  { id: 'lunch', label: 'Lunch' },
  { id: 'dinner', label: 'Dinner' },
  { id: 'snacks', label: 'Snacks' }
]

export const EMPTY_NUTRITION = Object.freeze({ kcal: 0, protein: 0, carbs: 0, fat: 0 })

const number = value => Number.isFinite(+value) ? +value : 0
const rounded = value => Math.round(value * 10) / 10

export function nutritionFor(food, grams) {
  const factor = Math.max(0, number(grams)) / 100
  const n = food?.n || EMPTY_NUTRITION
  return {
    kcal: Math.round(number(n.kcal) * factor),
    protein: rounded(number(n.protein) * factor),
    carbs: rounded(number(n.carbs) * factor),
    fat: rounded(number(n.fat) * factor)
  }
}

export function nutritionTotal(entries = []) {
  return entries.reduce((sum, entry) => ({
    kcal: sum.kcal + number(entry.n?.kcal),
    protein: rounded(sum.protein + number(entry.n?.protein)),
    carbs: rounded(sum.carbs + number(entry.n?.carbs)),
    fat: rounded(sum.fat + number(entry.n?.fat))
  }), { ...EMPTY_NUTRITION })
}

export const entriesForDate = (entries = [], date) => entries.filter(entry => entry.date === date)

export function foodSnapshot(food) {
  return {
    id: String(food?.id || ''),
    name: String(food?.name || '').trim().slice(0, 160),
    category: String(food?.category || '').trim().slice(0, 100),
    n: {
      kcal: Math.max(0, number(food?.n?.kcal)),
      protein: Math.max(0, number(food?.n?.protein)),
      carbs: Math.max(0, number(food?.n?.carbs)),
      fat: Math.max(0, number(food?.n?.fat))
    },
    portions: Array.isArray(food?.portions) ? food.portions.slice(0, 8).map(p => ({
      label: String(p.label || '').slice(0, 80), grams: Math.max(0, number(p.grams))
    })).filter(p => p.label && p.grams) : []
  }
}

export function makeFoodEntry({ id, food, grams, date, meal, sourcePlanId = null }) {
  const snapshot = foodSnapshot(food)
  const amount = Math.max(1, rounded(number(grams) || 100))
  return {
    id, date, meal, food: snapshot, grams: amount,
    n: nutritionFor(snapshot, amount),
    ...(sourcePlanId ? { sourcePlanId } : {}),
    createdAt: new Date().toISOString()
  }
}

export function consumePlannedEntry(diary, planned, id) {
  if ((diary || []).some(entry => entry.sourcePlanId === planned.id)) return diary
  return [...(diary || []), makeFoodEntry({
    id, food: planned.food, grams: planned.grams, date: planned.date,
    meal: planned.meal, sourcePlanId: planned.id
  })]
}
