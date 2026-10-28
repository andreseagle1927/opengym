import { describe, expect, it } from 'vitest'
import { consumePlannedEntry, makeFoodEntry, nutritionFor, nutritionTotal } from './food.js'

const oats = { id: 'usda-1', name: 'Oats', n: { kcal: 389, protein: 16.9, carbs: 66.3, fat: 6.9 } }

describe('food diary nutrition', () => {
  it('scales nutrients from the per-100g catalog value', () => {
    expect(nutritionFor(oats, 50)).toEqual({ kcal: 195, protein: 8.5, carbs: 33.2, fat: 3.5 })
  })

  it('stores a stable nutrient snapshot and totals entries', () => {
    const entry = makeFoodEntry({ id: 'a', food: oats, grams: 50, date: '2026-10-21', meal: 'breakfast' })
    oats.n.kcal = 999
    expect(entry.n.kcal).toBe(195)
    expect(nutritionTotal([entry, entry])).toEqual({ kcal: 390, protein: 17, carbs: 66.4, fat: 7 })
  })

  it('logs a planned item only once', () => {
    const planned = makeFoodEntry({ id: 'plan-a', food: oats, grams: 100, date: '2026-10-21', meal: 'lunch' })
    const once = consumePlannedEntry([], planned, 'diary-a')
    const twice = consumePlannedEntry(once, planned, 'diary-b')
    expect(twice).toHaveLength(1)
    expect(twice[0].sourcePlanId).toBe('plan-a')
  })
})
