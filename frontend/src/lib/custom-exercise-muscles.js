import { MUSCLES, musclesOf } from './muscles.js'

export function selectedMusclesForExercise(exercise) {
  const weights = musclesOf(exercise)
  return MUSCLES.filter(muscle => weights[muscle] > 0)
}

export function hasRequiredMuscleSelection(bodyPart, selected) {
  return bodyPart === 'cardio' || selected.length > 0
}

export function customExerciseMusclePatch(existing, selected, initial, bodyPart) {
  const changed = selected.length !== initial.length || selected.some(muscle => !initial.includes(muscle))
  if (!existing || changed) return { muscleGroups: [...selected] }
  if (bodyPart !== existing.bp) {
    const weights = musclesOf(existing)
    if (Object.keys(weights).length) return { muscleWeights: { ...weights } }
  }
  return null
}
