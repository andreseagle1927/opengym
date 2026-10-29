// Capacitor native shell support. Signed-in profiles sync with the OpenGym API; this
// private file copy also protects local state from WebView storage eviction. Native
// notifications are scheduled for the weekly workout plan.
import { t } from './i18n-core.js'
import { Capacitor } from '@capacitor/core'

export const MOBILE = import.meta.env.VITE_MOBILE === '1' || Capacitor.isNativePlatform()

export function withTimeout(promise, ms, fallback = null) {
  let timer
  return Promise.race([
    Promise.resolve(promise),
    new Promise(resolve => { timer = setTimeout(() => resolve(fallback), ms) })
  ]).finally(() => clearTimeout(timer))
}

const FILE = 'opengym-state.json'

export async function nativeLoad() {
  try {
    const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem')
    const r = await Filesystem.readFile({ path: FILE, directory: Directory.Data, encoding: Encoding.UTF8 })
    return JSON.parse(r.data)
  } catch (e) { return null }   // first launch, or unreadable — localStorage copy takes over
}

export async function nativeSave(state) {
  try {
    const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem')
    await Filesystem.writeFile({ path: FILE, directory: Directory.Data, data: JSON.stringify(state), encoding: Encoding.UTF8 })
  } catch (e) { /* keep the localStorage copy */ }
}

// (Re)schedule the workout-day reminder: one repeating notification per weekday that has a
// routine in the weekly plan. Cheap enough to run after any state change — the plan or the
// reminder time may just have been edited. `interactive` gates the OS permission prompt to
// the Settings toggle; a background resync never pops a dialog.
export async function syncReminder(S, interactive = false) {
  try {
    const { LocalNotifications } = await import('@capacitor/local-notifications')
    await LocalNotifications.cancel({ notifications: [0, 1, 2, 3, 4, 5, 6].map(d => ({ id: 100 + d })) }).catch(() => {})
    const r = S.reminder
    if (!r?.on) return true
    let perm = await LocalNotifications.checkPermissions()
    if (perm.display !== 'granted' && interactive) perm = await LocalNotifications.requestPermissions()
    if (perm.display !== 'granted') return false
    const [hour, minute] = (r.time || '08:00').split(':').map(Number)
    const notifications = Object.entries(S.week || {})
      .filter(([, rid]) => rid && (S.routines || []).some(x => x.id === rid))
      .map(([day, rid]) => ({
        id: 100 + Number(day),
        title: t('Workout day'),
        body: t('{0} is on the plan today — let’s go!', S.routines.find(x => x.id === rid).name),
        // Capacitor weekdays are 1 (Sunday) … 7 (Saturday); S.week uses getDay() 0…6.
        schedule: { on: { weekday: Number(day) + 1, hour, minute }, allowWhileIdle: true },
      }))
    if (notifications.length) await LocalNotifications.schedule({ notifications })
    return true
  } catch (e) { return false }
}

// WKWebView can't do blob-URL downloads, so the backup goes out through the OS share sheet
// (Files, AirDrop, mail, …) from a temp file instead.
export async function shareExport(json, filename) {
  const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem')
  const { Share } = await import('@capacitor/share')
  const w = await Filesystem.writeFile({ path: filename, directory: Directory.Cache, data: json, encoding: Encoding.UTF8 })
  await Share.share({ title: filename, url: w.uri })
}
