import { Capacitor } from '@capacitor/core'
import { createClient } from '@supabase/supabase-js'

// Backend + WebAuthn helpers (ported from the vanilla app).
export const IS_APPLE = /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent)
export const IS_ANDROID = /Android/.test(navigator.userAgent)
export const BIO = IS_APPLE ? 'Face ID / Touch ID' : IS_ANDROID ? 'fingerprint or face unlock' : 'your fingerprint, face or PIN'
export const VAULT = IS_APPLE ? 'iCloud Keychain' : IS_ANDROID ? 'Google Password Manager' : 'your password manager'
export const webauthnOK = () => !!(window.PublicKeyCredential && navigator.credentials)
const MOBILE_BUILD = import.meta.env.VITE_MOBILE === '1'
// Detect the Capacitor shell at runtime as well as at build time. A native bundle made
// with plain `vite build` must still talk to the API instead of its local app shell.
const NATIVE = Capacitor.isNativePlatform()
const MOBILE_RUNTIME = MOBILE_BUILD || NATIVE
const API_BASE = (import.meta.env.VITE_API_BASE_URL || (MOBILE_RUNTIME ? 'https://gym.adrenocromo.com' : '')).replace(/\/$/, '')
const TOKEN_KEY = 'opengym-session-token'
let sessionToken = ''
let supabaseClient = null
let supabaseConfigKey = ''

export function configureSupabase(config) {
  if (!config?.supabase_enabled || !config.supabase_url || !config.supabase_anon_key) return null
  const key = config.supabase_url + '\n' + config.supabase_anon_key
  if (supabaseClient && supabaseConfigKey === key) return supabaseClient
  supabaseConfigKey = key
  supabaseClient = createClient(config.supabase_url, config.supabase_anon_key, {
    auth: { autoRefreshToken: true, persistSession: true, detectSessionInUrl: true, flowType: 'pkce' }
  })
  return supabaseClient
}
const getSupabase = () => supabaseClient
export const supabaseRecoveryCallback = () => new URLSearchParams(window.location.search).get('gym_action') === 'recover'

async function exchangeSupabaseSession(session, options = {}) {
  if (!session?.access_token) throw new Error('Supabase did not return a sign-in session')
  const code = options.code ?? localStorage.getItem('opengym-auth-invite') ?? ''
  const name = options.name ?? localStorage.getItem('opengym-auth-name') ?? ''
  const result = await api('/api/auth/supabase/exchange', {
    method: 'POST',
    body: JSON.stringify({ accessToken: session.access_token, code, name, client: authClientMode() })
  })
  localStorage.removeItem('opengym-auth-invite')
  localStorage.removeItem('opengym-auth-name')
  if (NATIVE && result.sessionToken) await saveSessionToken(result.sessionToken)
  return result.user
}

export async function restoreSupabaseSession() {
  const client = getSupabase()
  if (!client || supabaseRecoveryCallback()) return null
  const { data, error } = await client.auth.getSession()
  if (error) throw error
  if (!data.session) return null
  return exchangeSupabaseSession(data.session)
}

export async function completePendingSupabaseLink() {
  const provider = localStorage.getItem('opengym-supabase-link')
  if (!provider || !getSupabase()) return null
  const { data, error } = await getSupabase().auth.getSession()
  if (error) throw error
  if (!data.session) return null
  const result = await api('/api/auth/supabase/link', {
    method: 'POST',
    body: JSON.stringify({ accessToken: data.session.access_token })
  })
  localStorage.removeItem('opengym-supabase-link')
  return result.user
}
export async function signOutSupabase(scope = 'local') {
  const client = getSupabase()
  if (!client) return
  const { error } = await client.auth.signOut({ scope })
  if (error) throw error
}

export async function saveSessionToken(token) {
  sessionToken = token || ''
  if (!NATIVE) return
  const { SecureStorage } = await import('@aparajita/capacitor-secure-storage')
  if (sessionToken) await SecureStorage.setItem(TOKEN_KEY, sessionToken)
  else await SecureStorage.removeItem(TOKEN_KEY)
}
export async function clearSessionToken() { await saveSessionToken('') }
async function currentSessionToken() {
  if (sessionToken || !NATIVE) return sessionToken
  try {
    const { SecureStorage } = await import('@aparajita/capacitor-secure-storage')
    sessionToken = await SecureStorage.getItem(TOKEN_KEY) || ''
  } catch { sessionToken = '' }
  return sessionToken
}
export const authClientMode = () => NATIVE ? 'native' : 'web'
let socialInitKey = ''
let socialInitPromise = null
export function socialProviderEnabled(provider, config) {
  if (!config) return false
  const platform = Capacitor.getPlatform()
  if (provider === 'google') {
    if (NATIVE && platform === 'ios') return !!config.google_ios_enabled
    if (NATIVE && platform === 'android') return !!config.google_android_enabled
    return !!config.google_enabled
  }
  if (provider === 'apple') {
    if (NATIVE && platform === 'ios') return !!config.apple_native_enabled
    if (NATIVE && platform === 'android') return !!config.apple_android_enabled
    return !!config.apple_enabled
  }
  return false
}
export async function prepareSocialLogin(config) {
  const platform = Capacitor.getPlatform()
  const google = socialProviderEnabled('google', config) ? {
    webClientId: config.google_client_id,
    iOSClientId: config.google_ios_client_id || undefined,
    iOSServerClientId: config.google_client_id || undefined,
    redirectUrl: config.google_redirect_url || (typeof window !== 'undefined' ? window.location.origin + '/' : undefined),
    mode: 'online'
  } : undefined
  const appleEnabled = NATIVE && socialProviderEnabled('apple', config)
  const apple = appleEnabled ? (platform === 'ios' ? {} : {
    clientId: config.apple_client_id || undefined,
    redirectUrl: config.apple_redirect_url || undefined
  }) : undefined
  if (!google && !apple) return null
  const key = JSON.stringify({ platform, google, apple })
  if (key === socialInitKey && socialInitPromise) return socialInitPromise
  socialInitKey = key
  socialInitPromise = (async () => {
    const { SocialLogin } = await import('@capgo/capacitor-social-login')
    await SocialLogin.initialize({ google, apple })
    return SocialLogin
  })()
  try { return await socialInitPromise }
  catch (error) { socialInitKey = ''; socialInitPromise = null; throw error }
}

export async function api(path, opts) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts?.headers || {})
  const token = await currentSessionToken()
  if (NATIVE && token) headers.Authorization = 'Bearer ' + token
  const r = await fetch(API_BASE + path, Object.assign({ headers, credentials: 'include' }, opts, { headers }))
  const contentType = r.headers.get('content-type') || ''
  const data = await r.json().catch(() => ({}))
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new Error('OpenGym returned an invalid response. Rebuild or update the app, then try again.')
  }
  if (!r.ok) { const e = new Error(data.error || ('HTTP ' + r.status)); e.status = r.status; throw e }
  return data
}

export async function apiUpload(path, file, { headers = {}, onProgress } = {}) {
  const token = await currentSessionToken()
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open('PUT', API_BASE + path)
    request.withCredentials = true
    request.setRequestHeader('Content-Type', 'video/mp4')
    Object.entries(headers).forEach(([name, value]) => request.setRequestHeader(name, value))
    if (NATIVE && token) request.setRequestHeader('Authorization', 'Bearer ' + token)
    request.upload.addEventListener('progress', event => {
      if (event.lengthComputable) onProgress?.(Math.round(event.loaded * 100 / event.total))
    })
    request.addEventListener('load', () => {
      let data = {}
      try { data = JSON.parse(request.responseText || '{}') } catch {}
      if (request.status < 200 || request.status >= 300) {
        const error = new Error(data.error || ('HTTP ' + request.status))
        error.status = request.status
        reject(error)
      } else resolve(data)
    })
    request.addEventListener('error', () => reject(new Error('Network error while uploading the video.')))
    request.addEventListener('abort', () => reject(new Error('Video upload was canceled.')))
    request.send(file)
  })
}

const bufToB64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const b64uToBuf = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)).buffer

function toCreationOptions(o) {
  if (!o || typeof o.challenge !== 'string' || !o.user?.id) {
    throw new Error('Could not start passkey setup. Try again or use email and password.')
  }
  o.challenge = b64uToBuf(o.challenge)
  o.user.id = b64uToBuf(o.user.id)
  ;(o.excludeCredentials || []).forEach(c => { c.id = b64uToBuf(c.id) })
  return o
}
function toRequestOptions(o) {
  if (!o || typeof o.challenge !== 'string') {
    throw new Error('Could not start passkey sign-in. Try again or use email and password.')
  }
  o.challenge = b64uToBuf(o.challenge)
  ;(o.allowCredentials || []).forEach(c => { c.id = b64uToBuf(c.id) })
  return o
}
function credToJSON(cred) {
  const r = cred.response
  const out = {
    id: cred.id, rawId: bufToB64u(cred.rawId), type: cred.type,
    clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
    authenticatorAttachment: cred.authenticatorAttachment || null,
    response: { clientDataJSON: bufToB64u(r.clientDataJSON) }
  }
  if (r.attestationObject) {
    out.response.attestationObject = bufToB64u(r.attestationObject)
    out.response.transports = r.getTransports ? r.getTransports() : ['internal']
  }
  if (r.authenticatorData) {
    out.response.authenticatorData = bufToB64u(r.authenticatorData)
    out.response.signature = bufToB64u(r.signature)
    out.response.userHandle = r.userHandle ? bufToB64u(r.userHandle) : null
  }
  return out
}
export async function passkeyRegister(name, code) {
  const { cid, options } = await api('/api/register/options', { method: 'POST', body: JSON.stringify({ name, code: code || '' }) })
  const cred = await navigator.credentials.create({ publicKey: toCreationOptions(options) })
  const res = await api('/api/register/verify', { method: 'POST', body: JSON.stringify({ cid, credential: credToJSON(cred), client: authClientMode() }) })
  return saveAuthResponse(res)
}
export async function passkeyLogin() {
  const { cid, options } = await api('/api/login/options', { method: 'POST', body: '{}' })
  const cred = await navigator.credentials.get({ publicKey: toRequestOptions(options) })
  const res = await api('/api/login/verify', { method: 'POST', body: JSON.stringify({ cid, credential: credToJSON(cred), client: authClientMode() }) })
  return saveAuthResponse(res)
}

async function saveAuthResponse(data) {
  if (NATIVE && data.sessionToken) await saveSessionToken(data.sessionToken)
  return data.user
}
export async function passwordRegister({ name, email, password, code = '' }) {
  const client = getSupabase()
  if (!client) throw new Error('Account service is not available')
  const { data, error } = await client.auth.signUp({
    email, password,
    options: {
      emailRedirectTo: `${window.location.origin}/?gym_action=confirm`,
      data: { full_name: String(name || '').trim().slice(0, 40), invite_code: code }
    }
  })
  if (error) throw error
  if (!data.session) return { needsEmailConfirmation: true, email }
  return exchangeSupabaseSession(data.session, { name, code })
}
export async function passwordLogin({ email, password }) {
  const client = getSupabase()
  if (!client) throw new Error('Account service is not available')
  const { data, error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw error
  return exchangeSupabaseSession(data.session)
}
export async function providerChallenge(provider) {
  return api('/api/auth/provider/challenge', { method: 'POST', body: JSON.stringify({ provider }) })
}
export async function providerLogin(provider, { cid, idToken, name = '', code = '' }) {
  const data = await api('/api/auth/provider/' + provider, { method: 'POST', body: JSON.stringify({ cid, idToken, name, code, client: authClientMode() }) })
  return saveAuthResponse(data)
}
async function appleNonce(nonce) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(nonce))
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')
}
async function nativeSupabaseLogin(provider, config, { code = '', name = '' } = {}, link = false) {
  if (!socialProviderEnabled(provider, config)) throw new Error(provider + ' sign-in is not configured for this app')
  const SocialLogin = await prepareSocialLogin(config)
  if (!SocialLogin) throw new Error('Social sign-in is not configured for this app')
  const nonce = crypto.randomUUID()
  const hashedNonce = await appleNonce(nonce)
  const result = await SocialLogin.login({
    provider,
    options: { nonce: hashedNonce, scopes: provider === 'apple' ? ['email', 'name'] : ['profile', 'email'] }
  })
  const idToken = result.result?.idToken
  if (!idToken) throw new Error(provider + ' did not return an identity token')
  const profile = result.result?.profile || {}
  const providerName = provider === 'apple'
    ? [profile.givenName, profile.familyName].filter(Boolean).join(' ')
    : profile.name || ''
  const { data: authData, error } = await getSupabase().auth.signInWithIdToken({ provider, token: idToken, nonce })
  if (error) throw error
  if (name || providerName) await getSupabase().auth.updateUser({ data: { full_name: name || providerName } })
  if (link) {
    const linked = await api('/api/auth/supabase/link', { method: 'POST', body: JSON.stringify({ accessToken: authData.session.access_token }) })
    return linked.user
  }
  return exchangeSupabaseSession(authData.session, { name: name || providerName, code })
}
async function socialLogin(provider, config, { code = '', name = '' } = {}) {
  if (!socialProviderEnabled(provider, config)) throw new Error(provider + ' sign-in is not configured for this app')
  const client = getSupabase()
  if (!client) throw new Error('Account service is not available')
  if (NATIVE) return nativeSupabaseLogin(provider, config, { code, name })
  if (code) localStorage.setItem('opengym-auth-invite', code)
  if (name) localStorage.setItem('opengym-auth-name', name)
  const { error } = await client.auth.signInWithOAuth({
    provider,
    options: {
      redirectTo: `${window.location.origin}/`,
      scopes: provider === 'apple' ? 'name email' : 'openid email profile'
    }
  })
  if (error) throw error
  return null // The browser is redirecting to the provider.
}
export const signInWithGoogle = (config, options) => socialLogin('google', config, options)
export const signInWithApple = (config, options) => socialLogin('apple', config, options)
export async function linkProvider(provider, config) {
  if (!socialProviderEnabled(provider, config)) throw new Error(provider + ' sign-in is not configured for this app')
  if (NATIVE) return { user: await nativeSupabaseLogin(provider, config, {}, true) }
  const client = getSupabase()
  if (!client) throw new Error('Account service is not available')
  localStorage.setItem('opengym-supabase-link', provider)
  const { error } = await client.auth.signInWithOAuth({
    provider,
    options: { redirectTo: `${window.location.origin}/`, scopes: provider === 'apple' ? 'name email' : 'openid email profile' }
  })
  if (error) { localStorage.removeItem('opengym-supabase-link'); throw error }
  return { redirecting: true }
}
export async function changePassword({ password, newPassword }) {
  const client = getSupabase()
  if (client) {
    const { data } = await client.auth.getSession()
    if (data.session) {
      const { error } = await client.auth.updateUser({ password: newPassword })
      if (error) throw error
      return { user: await exchangeSupabaseSession((await client.auth.getSession()).data.session) }
    }
  }
  const data = await api('/api/auth/password/change', { method: 'POST', body: JSON.stringify({ password, newPassword, client: authClientMode() }) })
  return saveAuthResponse(data)
}
export async function linkPassword({ email, password }) {
  const client = getSupabase()
  if (client) {
    const { data } = await client.auth.getSession()
    if (data.session) {
      const { error } = await client.auth.updateUser({ email, password })
      if (error) throw error
      return { user: await exchangeSupabaseSession((await client.auth.getSession()).data.session) }
    }
  }
  return api('/api/auth/password/link', { method: 'POST', body: JSON.stringify({ email, password }) })
}
export async function requestPasswordReset({ email }) {
  const client = getSupabase()
  if (!client) throw new Error('Account service is not available')
  const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/?gym_action=recover` })
  if (error) throw error
}
export async function completePasswordReset({ newPassword }) {
  const client = getSupabase()
  if (!client) throw new Error('Account service is not available')
  const { error } = await client.auth.updateUser({ password: newPassword })
  if (error) throw error
  const { data } = await client.auth.getSession()
  return exchangeSupabaseSession(data.session)
}
export async function resetPassword({ code, newPassword }) {
  return api('/api/auth/password/reset', { method: 'POST', body: JSON.stringify({ code, newPassword }) })
}
