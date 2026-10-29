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

export async function waitForExerciseVideoJob(jobId, onStatus) {
  if (!jobId) throw new Error('The server did not return a video processing job.')
  const deadline = Date.now() + 4 * 60 * 60 * 1000
  while (true) {
    let job
    try {
      job = await api('/api/admin/exercise-video/job?id=' + encodeURIComponent(jobId))
    } catch (error) {
      if (error.status || Date.now() >= deadline) throw error
    }
    if (job) {
      onStatus?.(job)
      if (job.status === 'ready') return job
      if (job.status === 'failed') throw new Error(job.error || 'Video conversion failed.')
    }
    if (Date.now() >= deadline) throw new Error('Video processing is taking too long. Reopen the exercise to check its status.')
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
}

export const exerciseVideoUrl = entry => entry?.url ? new URL(entry.url, API_BASE || window.location.origin).href : ''
export const exerciseVideoKey = (exerciseId, ownerId) => ownerId ? `custom:${ownerId}:${exerciseId}` : exerciseId
