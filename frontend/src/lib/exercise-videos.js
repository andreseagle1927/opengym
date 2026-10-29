import { api } from './api.js'
import { Capacitor } from '@capacitor/core'

const ENV = import.meta.env || {}
const MOBILE_RUNTIME = ENV.VITE_MOBILE === '1' || Capacitor.isNativePlatform()
const API_BASE = (ENV.VITE_API_BASE_URL || (MOBILE_RUNTIME ? 'https://gym.adrenocromo.com' : '')).replace(/\/$/, '')

let cachedIndex = null
let cachedAt = 0
let pending

export async function loadExerciseVideos(force = false) {
  if (!force && cachedIndex && Date.now() - cachedAt < 60000) return cachedIndex
  if (!force && pending) return pending
  pending = api('/api/exercise-videos', { headers: { Accept: 'application/json' } })
    .then(result => {
      cachedIndex = result.videos && typeof result.videos === 'object' ? result.videos : {}
      cachedAt = Date.now()
      return cachedIndex
    })
    .finally(() => { pending = null })
  return pending
}

export const exerciseVideoUrl = entry => entry?.url ? new URL(entry.url, API_BASE || window.location.origin).href : ''
export const exerciseVideoKey = (exerciseId, ownerId) => ownerId ? `custom:${ownerId}:${exerciseId}` : exerciseId
