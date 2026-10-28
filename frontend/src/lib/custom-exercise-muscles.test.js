import { describe, expect, it } from 'vitest'
import { loadOfWorkouts, musclesOf } from './muscles.js'
import {
  customExerciseMusclePatch,
  hasRequiredMuscleSelection,
  selectedMusclesForExercise,
} from './custom-exercise-muscles.js'

describe('custom exercise muscle selection', () => {
  it('requires a muscle for non-cardio exercises but permits cardio without one', () => {
    expect(hasRequiredMuscleSelection('chest', [])).toBe(false)
    expect(hasRequiredMuscleSelection('chest', ['chest'])).toBe(true)
    expect(hasRequiredMuscleSelection('cardio', [])).toBe(true)
  })

  it('uses equal muscle contribution for newly selected targets', () => {
    const patch = customExerciseMusclePatch(null, ['chest', 'triceps'], [], 'chest')
    expect(patch).toEqual({ muscleGroups: ['chest', 'triceps'] })

    const custom = { id: 'custom-row', bp: 'chest', muscleGroups: patch.muscleGroups }
    expect(musclesOf(custom)).toEqual({ chest: 1, triceps: 1 })
    expect(loadOfWorkouts([{
      entries: [{ id: custom.id, exercise: custom, sets: [{ done: true }] }],
    }])).toEqual({ chest: 1, triceps: 1 })
  })

  it('prefills legacy exercise targets and preserves their weights until selection changes', () => {
    const legacy = { id: 'legacy-row', n: 'Legacy leg exercise', bp: 'upper legs' }
    const inferred = selectedMusclesForExercise(legacy)
    expect(inferred).toEqual(['gluteal', 'quadriceps', 'hamstring'])
    expect(customExerciseMusclePatch(legacy, inferred, inferred, 'upper legs')).toBeNull()
    expect(customExerciseMusclePatch(legacy, inferred, inferred, 'back')).toEqual({
      muscleWeights: { quadriceps: 0.4, hamstring: 0.35, gluteal: 0.25 },
    })

    const changed = customExerciseMusclePatch(legacy, ['quadriceps'], inferred, 'upper legs')
    expect(changed).toEqual({ muscleGroups: ['quadriceps'] })
    expect(musclesOf({ ...legacy, ...changed })).toEqual({ quadriceps: 1 })
  })
})
