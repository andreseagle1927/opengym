import { useEffect, useState } from 'react'
import { imgSrc, gifSrc } from '../lib/exercises.js'
import { exerciseVideoKey, exerciseVideoPosterUrl, exerciseVideoUrl, loadExerciseVideos } from '../lib/exercise-videos.js'
import { useStore } from '../store/useStore.js'
import { t } from '../lib/i18n.js'
import Icon from './Icon.jsx'

// Big autoplaying animation; tap toggles to the still frame. `compact` shrinks it (superset cards).
// Custom exercises have no catalogue animation; an uploaded shared video can still play.
// `minimizable` (workout view) adds a persistent minimize/expand control so the animation stops
// eating the screen; the chosen size is saved to settings and carries across exercises and
// future workouts (issue #12).
export default function Media({ ex, id, compact, minimizable, videoRefreshKey = 0 }) {
  const [playing, setPlaying] = useState(true)
  const [video, setVideo] = useState(null)
  const gifSize = useStore(s => s.S.gifSize)
  const videoOwnerId = useStore(s => s.adminView?.id || s.user?.id)
  const update = useStore(s => s.update)
  useEffect(() => {
    let active = true
    setVideo(null)
    const key = ex.custom ? exerciseVideoKey(ex.id, videoOwnerId) : ex.id
    loadExerciseVideos(Boolean(ex.custom)).then(index => {
      if (active) setVideo(index[key] || null)
    }).catch(() => {})
    return () => { active = false }
  }, [ex.id, ex.custom, videoOwnerId, videoRefreshKey])
  const videoUrl = exerciseVideoUrl(video)
  const posterUrl = exerciseVideoPosterUrl(video) || (ex.img ? imgSrc(ex) : '')
  if (!ex.gif && !videoUrl) return null
  const mini = minimizable && gifSize === 'mini'
  const toggleSize = e => { e.stopPropagation(); update(s => { s.gifSize = mini ? 'full' : 'mini' }) }
  return (
    <div className={'exmedia' + (compact ? ' compact' : '') + (mini ? ' mini' : '')} id={id} onClick={videoUrl ? undefined : () => setPlaying(p => !p)}>
      {videoUrl
        ? <video controls preload="none" playsInline poster={posterUrl || undefined} aria-label={ex.n} src={videoUrl} />
        : ex.gif && <img decoding="async" src={playing ? gifSrc(ex) : imgSrc(ex)} alt={ex.n} />}
      {minimizable && (
        <button className="giftoggle" onClick={toggleSize}>
          <Icon name={mini ? 'expand' : 'minimize'} />{mini ? t('Expand') : t('Minimize')}
        </button>
      )}
      {!videoUrl && !mini && (
        <span className="gifhint">
          <Icon name={playing ? 'pause' : 'play'} />{playing ? t('tap to pause') : t('tap to play')}
        </span>
      )}
    </div>
  )
}

export function Thumb({ ex }) {
  if (!ex.img) return <div className="thumb thumb-x"><Icon name="dumbbell" /></div>
  return <img className="thumb" loading="lazy" decoding="async" src={imgSrc(ex)} alt="" />
}
