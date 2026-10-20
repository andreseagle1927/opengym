import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { webauthnOK, passkeyLogin, passkeyRegister, passwordLogin, passwordRegister, resetPassword, signInWithGoogle, signInWithApple, socialProviderEnabled, BIO } from '../lib/api.js'
import { hasData } from '../store/useStore.js'
import { t } from '../lib/i18n.js'
import { DEMO, REPO } from '../lib/demo.js'
import { guestAllowed } from '../lib/guest.js'
import { useState, useRef, useEffect } from 'react'
import Icon from '../components/Icon.jsx'
import { Button } from '../components/ui.jsx'

function RegisterSheet({ close }) {
  const { setUser, pushState, pullState, loadConfig } = useStore()
  const config = useStore(s => s.config)
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [forgot, setForgot] = useState(false)
  const inviteOnly = !!config?.invite_only
  const ref = useRef(null)
  useEffect(() => { setTimeout(() => ref.current?.focus(), 250) }, [])
  // Boot already fetched this; retry here only if that attempt failed, so the invite field still
  // appears on an instance whose config arrived late rather than never.
  useEffect(() => { loadConfig() }, [loadConfig])
  const go = async () => {
    const n = name.trim()
    if (!n) { useUI.getState().toast(t('Enter a name')); return }
    if (inviteOnly && !code.trim()) { useUI.getState().toast(t('An invite code is required')); return }
    try {
      const u = await passkeyRegister(n, code.trim())
      setUser(u); close()
      if (hasData(useStore.getState().S)) { await pushState(); useUI.getState().toast(t('Profile created — data from this device moved into it')) }
      else { await pullState(); useUI.getState().toast(t('Welcome, {0}', u.name)) }
    } catch (e) { if (e.name !== 'NotAllowedError' && e.name !== 'AbortError') useUI.getState().toast(e.message || t('Registration failed')) }
  }
  return <>
    <h3>{t('Create your profile')}</h3>
    <div className="muted small" style={{ marginBottom: 14 }}>{t('Pick a name, then confirm with {0}. The passkey is saved in your device — no password needed.', BIO)}</div>
    <input ref={ref} className="input" placeholder={t('Your name')} maxLength={40} value={name} onChange={e => setName(e.target.value)} />
    {inviteOnly && <>
      <div style={{ height: 10 }} />
      <input className="input" placeholder={t('Invite code')} maxLength={40} value={code}
        onChange={e => setCode(e.target.value.toUpperCase())} style={{ letterSpacing: '.14em', fontWeight: 600, textAlign: 'center' }} />
      <div className="dim small" style={{ marginTop: 6 }}>{t('This app is invite-only — enter the code you were given.')}</div>
    </>}
    <div style={{ height: 12 }} />
    <Button variant="primary" onClick={go}>{t('Create passkey')}</Button>
  </>
}

export default function Login() {
  const { setUser, pullState, setGuest } = useStore()
  const config = useStore(s => s.config)
  const googleEnabled = socialProviderEnabled('google', config)
  const appleEnabled = socialProviderEnabled('apple', config)
  const canGuest = guestAllowed(config)
  const [register, setRegister] = useState(false)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [forgot, setForgot] = useState(false)
  const [resetCode, setResetCode] = useState('')
  const [busy, setBusy] = useState(false)
  const finish = async (u, welcome = false) => {
    setUser(u)
    if (hasData(useStore.getState().S)) await useStore.getState().pushState()
    else await pullState()
    useUI.getState().toast(welcome ? t('Welcome, {0}', u.name) : t('Welcome back, {0}', u.name))
  }
  const passwordSubmit = async ev => {
    ev.preventDefault()
    setBusy(true)
    try {
      if (forgot) {
        await resetPassword({ code: resetCode, newPassword: password })
        setForgot(false); setPassword(''); setResetCode('')
        useUI.getState().toast(t('Password updated. Sign in with the new password.'))
        return
      }
      const u = register
        ? await passwordRegister({ name, email, password, code })
        : await passwordLogin({ email, password })
      await finish(u, register)
    } catch (e) { useUI.getState().toast(e.message || t('Sign-in failed')) }
    finally { setBusy(false) }
  }
  const providerSubmit = async provider => {
    setBusy(true)
    try {
      const options = { code: register ? code : '', name: register ? name : '' }
      const u = provider === 'google' ? await signInWithGoogle(config, options) : await signInWithApple(config, options)
      await finish(u, register)
    } catch (e) { if (e.name !== 'NotAllowedError' && e.name !== 'AbortError') useUI.getState().toast(e.message || t('Sign-in failed')) }
    finally { setBusy(false) }
  }
  const signIn = async () => {
    try { const u = await passkeyLogin(); setUser(u); await pullState(); useUI.getState().toast(t('Welcome back, {0}', u.name)) }
    catch (e) { if (e.name !== 'NotAllowedError' && e.name !== 'AbortError') useUI.getState().toast(e.message || t('Sign-in failed')) }
  }
  const head = <>
    <div style={{ fontSize: 54, display: 'flex', justifyContent: 'center', color: 'var(--acc)' }}><Icon name="dumbbell" /></div>
    <h1 style={{ fontSize: 34, fontWeight: 700, letterSpacing: '-.028em', margin: '10px 0 4px' }}>openGym</h1>
  </>
  const wrap = { display: 'flex', flexDirection: 'column', justifyContent: 'center', minHeight: '78vh', textAlign: 'center' }

  // Demo build: no backend to sign in against — the only way in is the local guest profile.
  if (DEMO) return (
    <div className="narrow" style={wrap}>
      {head}
      <div className="muted" style={{ marginBottom: 30 }}>{t('Live demo — everything stays in this browser.')}</div>
      <Button variant="primary" icon="sparkles" onClick={() => setGuest(true)}>{t('Start the demo')}</Button>
      <div className="card small muted" style={{ textAlign: 'left', marginTop: 16 }}>
        {t('This demo runs entirely in your browser on example data — nothing is sent anywhere. Passkey sign-in and sync across your devices come with the openGym server, which you get by self-hosting it.')}
      </div>
      <div className="dim small" style={{ marginTop: 22, lineHeight: 1.6 }}>
        <a href={REPO} target="_blank" rel="noopener">{t('Self-host it in a minute →')}</a>
      </div>
    </div>
  )

  return (
    <div className="narrow" style={wrap}>
      {head}
      <div className="muted" style={{ marginBottom: 34 }}>{t('Your workouts. Your weights. Your profile.')}</div>
      {webauthnOK() ? <>
        <Button variant="primary" icon="person" onClick={signIn}>{t('Sign in with passkey')}</Button>
        <div style={{ height: 10 }} />
        <Button icon="sparkles" onClick={() => useUI.getState().openSheet(close => <RegisterSheet close={close} />)}>{t('Create new profile')}</Button>
        {canGuest && <div style={{ height: 10 }} />}
      </> : <div className="card small muted" style={{ textAlign: 'left' }}>{canGuest
        ? t("This browser doesn't support passkeys — you can still use openGym locally on this device.")
        // Without passkeys and without the guest entrance there is no way in from this browser,
        // so say that plainly instead of offering a local profile that cannot be created.
        : t("This browser doesn't support passkeys, and this instance requires an account. Try a browser or device with passkey support.")}</div>}
      {(googleEnabled || appleEnabled) && <>
        {googleEnabled && <Button disabled={busy} icon="sparkles" onClick={() => providerSubmit('google')}>{t('Continue with Google')}</Button>}
        {appleEnabled && <Button disabled={busy} icon="person" onClick={() => providerSubmit('apple')}>{t('Continue with Apple')}</Button>}
        <div className="dim small" style={{ margin: '10px 0' }}>{t('or use email and password')}</div>
      </>}
      <form onSubmit={passwordSubmit} style={{ display: 'grid', gap: 9, marginTop: 12 }}>
        {forgot ? <>
          <div className="dim small">{t('Ask your OpenGym administrator for a one-time password reset code. It expires after 15 minutes.')}</div>
          <input className="input" placeholder={t('Reset code')} autoComplete="one-time-code" value={resetCode} onChange={e => setResetCode(e.target.value)} required />
          <input className="input" type="password" placeholder={t('New password (12 characters minimum)')} autoComplete="new-password" minLength={12} maxLength={128} value={password} onChange={e => setPassword(e.target.value)} required />
          <Button variant="primary" disabled={busy}>{t('Reset password')}</Button>
        </> : <>
          {register && <input className="input" placeholder={t('Your name')} autoComplete="name" maxLength={40} value={name} onChange={e => setName(e.target.value)} required />}
          <input className="input" type="email" placeholder={t('Email')} autoComplete="email" maxLength={254} value={email} onChange={e => setEmail(e.target.value)} required />
          <input className="input" type="password" placeholder={register ? t('Password (12 characters minimum)') : t('Password')} autoComplete={register ? 'new-password' : 'current-password'} minLength={register ? 12 : undefined} maxLength={128} value={password} onChange={e => setPassword(e.target.value)} required />
          {register && config?.invite_only && <input className="input" placeholder={t('Invite code')} maxLength={40} value={code} onChange={e => setCode(e.target.value.toUpperCase())} required />}
          {register && <div className="dim small">{t('Email addresses are not verified. Keep your password safe or add a passkey after signing in.')}</div>}
          <Button variant="primary" disabled={busy}>{register ? t('Create account') : t('Sign in with email')}</Button>
        </>}
      </form>
      {!forgot ? <button className="plainbtn dim small" style={{ marginTop: 12 }} onClick={() => setRegister(v => !v)}>
        {register ? t('Already have an account? Sign in') : t('New here? Create an account')}
      </button> : <button className="plainbtn dim small" style={{ marginTop: 12 }} onClick={() => setForgot(false)}>{t('Back to sign in')}</button>}
      {!register && !forgot && <button className="plainbtn dim small" style={{ marginTop: 8 }} onClick={() => setForgot(true)}>{t('Forgot password?')}</button>}
      {canGuest && <Button variant="ghost" className="dim" onClick={() => setGuest(true)}>{t('Continue without account')}</Button>}
      <div className="dim small" style={{ marginTop: 26, lineHeight: 1.5 }}>{t('Passkeys use {0} — no passwords.', BIO)}<br />{t('Each profile keeps its own plan, workouts & body weight.')}</div>
    </div>
  )
}
