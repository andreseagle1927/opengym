import { Capacitor } from '@capacitor/core'

// Backend + WebAuthn helpers (ported from the vanilla app).
export const IS_APPLE = /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent)
export const IS_ANDROID = /Android/.test(navigator.userAgent)
export const BIO = IS_APPLE ? 'Face ID / Touch ID' : IS_ANDROID ? 'fingerprint or face unlock' : 'your fingerprint, face or PIN'
export const VAULT = IS_APPLE ? 'iCloud Keychain' : IS_ANDROID ? 'Google Password Manager' : 'your password manager'
export const webauthnOK = () => !!(window.PublicKeyCredential && navigator.credentials)
const MOBILE_BUILD = import.meta.env.VITE_MOBILE === '1'
const NATIVE = MOBILE_BUILD && Capacitor.isNativePlatform()
const API_BASE = (import.meta.env.VITE_API_BASE_URL || (MOBILE_BUILD ? 'https://gym.adrenocromo.com' : '')).replace(/\/$/, '')
const TOKEN_KEY = 'opengym-session-token'
let sessionToken = ''

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
  const iosNative = NATIVE && Capacitor.getPlatform() === 'ios'
  if (provider === 'google') return iosNative ? !!config.google_ios_enabled : !!config.google_enabled
  if (provider === 'apple') return iosNative ? !!config.apple_native_enabled : !!config.apple_enabled
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
  const data = await r.json().catch(() => ({}))
  if (!r.ok) { const e = new Error(data.error || ('HTTP ' + r.status)); e.status = r.status; throw e }
  return data
}

const bufToB64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const b64uToBuf = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)).buffer

function toCreationOptions(o) {
  o.challenge = b64uToBuf(o.challenge)
  o.user.id = b64uToBuf(o.user.id)
  ;(o.excludeCredentials || []).forEach(c => { c.id = b64uToBuf(c.id) })
  return o
}
function toRequestOptions(o) {
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
  const data = await api('/api/auth/password/register', { method: 'POST', body: JSON.stringify({ name, email, password, code, client: authClientMode() }) })
  return saveAuthResponse(data)
}
export async function passwordLogin({ email, password }) {
  const data = await api('/api/auth/password/login', { method: 'POST', body: JSON.stringify({ email, password, client: authClientMode() }) })
  return saveAuthResponse(data)
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
async function loadAppleJS() {
  if (window.AppleID?.auth) return
  await new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = 'https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js'
    script.onload = resolve; script.onerror = () => reject(new Error('Apple sign-in could not load'))
    document.head.appendChild(script)
  })
}
async function appleWebLogin(config, { code = '', name = '' } = {}) {
  const challenge = await providerChallenge('apple')
  await loadAppleJS()
  window.AppleID.auth.init({
    clientId: config.apple_client_id,
    scope: 'name email',
    redirectURI: config.apple_redirect_url,
    usePopup: true,
    nonce: await appleNonce(challenge.nonce)
  })
  const response = await window.AppleID.auth.signIn()
  const idToken = response.authorization?.id_token
  if (!idToken) throw new Error('Apple did not return an identity token')
  const n = response.user?.name
  const providerName = [n?.firstName, n?.lastName].filter(Boolean).join(' ') || name
  const data = await api('/api/auth/provider/apple', { method: 'POST', body: JSON.stringify({ cid: challenge.cid, idToken, name: providerName, code, client: 'web' }) })
  return saveAuthResponse(data)
}
async function socialLogin(provider, config, { code = '', name = '' } = {}) {
  if (!socialProviderEnabled(provider, config)) throw new Error(provider + ' sign-in is not configured for this app')
  if (provider === 'apple' && !NATIVE) return appleWebLogin(config, { code, name })
  const challenge = await providerChallenge(provider)
  const SocialLogin = await prepareSocialLogin(config)
  if (!SocialLogin) throw new Error('Social sign-in is not configured for this app')
  const nonce = provider === 'apple' ? await appleNonce(challenge.nonce) : challenge.nonce
  const result = await SocialLogin.login({
    provider,
    options: { nonce, scopes: provider === 'apple' ? ['email', 'name'] : ['profile', 'email'] }
  })
  const idToken = result.result?.idToken
  if (!idToken) throw new Error(provider + ' did not return an identity token')
  const profile = result.result?.profile || {}
  const providerName = provider === 'apple'
    ? [profile.givenName, profile.familyName].filter(Boolean).join(' ')
    : profile.name || ''
  const body = { cid: challenge.cid, idToken, name: name || providerName, code }
  const data = await api('/api/auth/provider/' + provider, { method: 'POST', body: JSON.stringify({ ...body, client: authClientMode() }) })
  return saveAuthResponse(data)
}
export const signInWithGoogle = (config, options) => socialLogin('google', config, options)
export const signInWithApple = (config, options) => socialLogin('apple', config, options)
export async function linkProvider(provider, config) {
  if (!socialProviderEnabled(provider, config)) throw new Error(provider + ' sign-in is not configured for this app')
  if (provider === 'apple' && !NATIVE) {
    const challenge = await providerChallenge(provider)
    await loadAppleJS()
    window.AppleID.auth.init({ clientId: config.apple_client_id, scope: 'name email', redirectURI: config.apple_redirect_url, usePopup: true, nonce: await appleNonce(challenge.nonce) })
    const response = await window.AppleID.auth.signIn()
    const idToken = response.authorization?.id_token
    if (!idToken) throw new Error('Apple did not return an identity token')
    return api('/api/auth/provider/link/apple', { method: 'POST', body: JSON.stringify({ cid: challenge.cid, idToken }) })
  }
  const challenge = await providerChallenge(provider)
  const SocialLogin = await prepareSocialLogin(config)
  if (!SocialLogin) throw new Error('Social sign-in is not configured for this app')
  const nonce = provider === 'apple' ? await appleNonce(challenge.nonce) : challenge.nonce
  const result = await SocialLogin.login({ provider, options: { nonce, scopes: provider === 'apple' ? ['email', 'name'] : ['profile', 'email'] } })
  const idToken = result.result?.idToken
  if (!idToken) throw new Error(provider + ' did not return an identity token')
  return api('/api/auth/provider/link/' + provider, { method: 'POST', body: JSON.stringify({ cid: challenge.cid, idToken }) })
}
export async function changePassword({ password, newPassword }) {
  const data = await api('/api/auth/password/change', { method: 'POST', body: JSON.stringify({ password, newPassword, client: authClientMode() }) })
  return saveAuthResponse(data)
}
export async function linkPassword({ email, password }) {
  return api('/api/auth/password/link', { method: 'POST', body: JSON.stringify({ email, password }) })
}
export async function resetPassword({ code, newPassword }) {
  return api('/api/auth/password/reset', { method: 'POST', body: JSON.stringify({ code, newPassword }) })
}
