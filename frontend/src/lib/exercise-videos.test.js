import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./api.js', () => ({ api: vi.fn() }))
import { api } from './api.js'
import { exerciseVideoKey, waitForExerciseVideoJob } from './exercise-videos.js'

beforeEach(() => vi.resetAllMocks())

describe('exerciseVideoKey', () => {
  it('keeps catalogue videos on their shared exercise id', () => {
    expect(exerciseVideoKey('bench-press')).toBe('bench-press')
  })

  it('scopes custom exercise videos to the profile that owns them', () => {
    expect(exerciseVideoKey('c123', 'user-a')).toBe('custom:user-a:c123')
    expect(exerciseVideoKey('c123', 'user-b')).not.toBe(exerciseVideoKey('c123', 'user-a'))
  })

  it('waits for conversion and returns when the playback copy is ready', async () => {
    api.mockResolvedValue({ id: 'job-1', status: 'ready' })
    await expect(waitForExerciseVideoJob('job-1')).resolves.toMatchObject({ status: 'ready' })
    expect(api).toHaveBeenCalledWith('/api/admin/exercise-video/job?id=job-1')
  })

  it('shows a conversion error returned by the processing job', async () => {
    api.mockResolvedValue({ status: 'failed', error: 'Unsupported codec.' })
    await expect(waitForExerciseVideoJob('job-2')).rejects.toThrow('Unsupported codec.')
  })

  it('rejects an upload response without a job identifier', async () => {
    await expect(waitForExerciseVideoJob('')).rejects.toThrow('did not return a video processing job')
  })
})
