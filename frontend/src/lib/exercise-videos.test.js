import { describe, expect, it } from 'vitest'
import { exerciseVideoKey } from './exercise-videos.js'

describe('exerciseVideoKey', () => {
  it('keeps catalogue videos on their shared exercise id', () => {
    expect(exerciseVideoKey('bench-press')).toBe('bench-press')
  })

  it('scopes custom exercise videos to the profile that owns them', () => {
    expect(exerciseVideoKey('c123', 'user-a')).toBe('custom:user-a:c123')
    expect(exerciseVideoKey('c123', 'user-b')).not.toBe(exerciseVideoKey('c123', 'user-a'))
  })
})
