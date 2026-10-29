/* opengym-api — passkey (WebAuthn) auth + per-user state storage for openGym
   No framework, JSON-file storage, signed session cookies.               */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Algorithm, hash as hashPassword, verify as verifyPassword } from '@node-rs/argon2';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse
} from '@simplewebauthn/server';
import webpush from 'web-push';

const PORT = +(process.env.PORT || 3000);
const DATA = process.env.DATA_DIR || '/data';
const VIDEO_DIR = process.env.EXERCISE_VIDEO_DIR || '/videos';
const MAX_EXERCISE_VIDEO = 90 * 1024 * 1024;
const execFileAsync = promisify(execFile);
const RP_ID = process.env.RP_ID || 'localhost';
const ORIGIN = process.env.ORIGIN || 'http://localhost:8080';
const RP_NAME = process.env.RP_NAME || 'openGym';
// Admin dashboard (issue): admins are matched by uid; INVITE_ONLY gates new signups behind a
// code the admin generates. Both default off so a fresh self-hosted instance stays open.
const ADMIN_UIDS = (process.env.ADMIN_UIDS || '').split(',').map(s => s.trim()).filter(Boolean);
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const INVITE_ONLY = /^(1|true|yes|on)$/i.test(process.env.INVITE_ONLY || '');
// Guest mode ("Continue without account") keeps everything in the browser and never touches this
// server — but on an instance meant for a known set of people, an entrance nobody can walk back
// out of is still the wrong front door (#42). Default ON, so existing instances are unchanged;
// the polarity is inverted from INVITE_ONLY because the safe default here is the permissive one.
const ALLOW_GUEST = !/^(0|false|no|off)$/i.test(process.env.ALLOW_GUEST || '');
// 90 days keeps someone who trains a few times a week permanently signed in without a stolen
// cookie staying good for a year. Overridable because a family instance and one on the open
// internet don't want the same number. Only affects cookies minted from now on — the expiry is
// baked into each cookie when it's issued, so lowering this never cuts an existing session short.
const SESSION_DAYS = Math.max(1, +(process.env.SESSION_DAYS || 90) || 90);
const GOOGLE_CLIENT_IDS = (process.env.GOOGLE_CLIENT_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const APPLE_CLIENT_IDS = (process.env.APPLE_CLIENT_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const GOOGLE_WEB_CLIENT_ID = process.env.GOOGLE_WEB_CLIENT_ID || '';
const GOOGLE_IOS_CLIENT_ID = process.env.GOOGLE_IOS_CLIENT_ID || '';
const APPLE_IOS_CLIENT_ID = process.env.APPLE_IOS_CLIENT_ID || '';
const APPLE_TEAM_ID = process.env.APPLE_TEAM_ID || '';
const APPLE_WEB_CLIENT_ID = process.env.APPLE_WEB_CLIENT_ID || '';
const APPLE_REDIRECT_URL = process.env.APPLE_REDIRECT_URL || '';
const NATIVE_REDIRECT_URI = process.env.NATIVE_REDIRECT_URI || 'com.adrenocromo.gym://auth/callback';
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const APP_ORIGINS = new Set([ORIGIN, 'capacitor://localhost', 'http://localhost', 'https://localhost', ...(process.env.APP_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)]);
const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const appleKeys = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));
const MAX_BODY = 5 * 1024 * 1024;
// Secure cookies require HTTPS; over plain http://localhost the flag would drop the cookie
const SECURE = /^https:/i.test(ORIGIN) ? ' Secure;' : '';

fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(VIDEO_DIR, { recursive: true });

let foodCatalog = { source: 'USDA FoodData Central SR Legacy', version: '2018-04', foods: [] };
try { foodCatalog = JSON.parse(fs.readFileSync(new URL('./foods.json', import.meta.url), 'utf8')); }
catch (error) { console.error('food catalog unavailable:', error.message); }
const searchableFoods = (foodCatalog.foods || []).map(food => ({
  food,
  search: `${food.name || ''} ${food.category || ''}`.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
}));
const FOOD_EXAMPLE_IDS = ['usda-173944', 'usda-171675', 'usda-171477', 'usda-173424', 'usda-168878', 'usda-170886'];
const exampleFoods = FOOD_EXAMPLE_IDS.map(id => searchableFoods.find(item => item.food.id === id)?.food).filter(Boolean);

function searchFoods(rawQuery) {
  const query = String(rawQuery || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (query.length < 2 || query.length > 80) return null;
  const words = query.split(/\s+/).filter(Boolean);
  return searchableFoods
    .filter(item => words.every(word => item.search.includes(word)))
    .map(item => {
      const name = item.food.name.toLowerCase();
      let score = name === query ? 0 : name.startsWith(query) ? 1 : name.split(/[, ]+/).some(word => word.startsWith(query)) ? 2 : 3;
      score += Math.min(name.length / 1000, .5);
      return { ...item.food, _score: score };
    })
    .sort((a, b) => a._score - b._score || a.name.localeCompare(b.name))
    .slice(0, 25)
    .map(({ _score, ...food }) => food);
}

/* ---------- secret + db ---------- */
const secretFile = path.join(DATA, 'secret');
if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
const SECRET = fs.readFileSync(secretFile, 'utf8').trim();

const dbFile = path.join(DATA, 'db.json');
let db = { users: [], creds: [], subs: [], invites: [] };
try { db = JSON.parse(fs.readFileSync(dbFile, 'utf8')); } catch {}
db.users = db.users || [];
db.creds = db.creds || [];
db.subs = db.subs || [];
db.invites = db.invites || [];
db.identities = db.identities || [];
db.passwords = db.passwords || [];
db.passwordResets = db.passwordResets || [];
db.supabaseIdentities = db.supabaseIdentities || [];
const isAdmin = user => !!user && (user.admin === true || ADMIN_UIDS.includes(user.id) ||
  (user.emailVerified !== false && ADMIN_EMAILS.includes(String(user.email || '').trim().toLowerCase())));
function saveDb() { atomicWrite(dbFile, JSON.stringify(db, null, 2)); }
function atomicWrite(file, content) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}
const stateFile = uid => path.join(DATA, 'state-' + uid.replace(/[^a-zA-Z0-9_-]/g, '') + '.json');
function readState(uid) {
  try { return JSON.parse(fs.readFileSync(stateFile(uid), 'utf8')); } catch { return null; }
}
const adminAuditFile = path.join(DATA, 'admin-audit.json');
const exerciseVideoIndexFile = path.join(DATA, 'exercise-videos.json');
const exerciseVideoJobsFile = path.join(DATA, 'exercise-video-jobs.json');
function readExerciseVideoIndex() {
  try {
    const index = JSON.parse(fs.readFileSync(exerciseVideoIndexFile, 'utf8'));
    return index && typeof index === 'object' && !Array.isArray(index) ? index : {};
  } catch { return {}; }
}
const validExerciseId = id => /^[A-Za-z0-9_-]{1,80}$/.test(String(id || ''));
const exerciseVideoKey = (id, ownerId) => ownerId ? `custom:${ownerId}:${id}` : id;
function exerciseVideoFile(filename) {
  return /^[A-Za-z0-9_-]{1,100}\.mp4$/.test(filename) ? path.join(VIDEO_DIR, filename) : null;
}
const videoJobs = (() => {
  try {
    const parsed = JSON.parse(fs.readFileSync(exerciseVideoJobsFile, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
})();
const videoQueue = [];
let processingVideoQueue = false;
function saveVideoJobs() { atomicWrite(exerciseVideoJobsFile, JSON.stringify(videoJobs, null, 2)); }
function publicVideoJob(job) {
  return { id: job.id, status: job.status, error: job.error || null, createdAt: job.createdAt, updatedAt: job.updatedAt };
}
function setVideoJob(job, patch) {
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  saveVideoJobs();
}
async function probeVideo(file) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error', '-show_entries', 'stream=codec_type,color_transfer', '-show_entries', 'format=duration', '-of', 'json', file
  ], { timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
  const info = JSON.parse(stdout);
  const video = (info.streams || []).find(stream => stream.codec_type === 'video');
  const duration = Number(info.format?.duration);
  if (!video || !Number.isFinite(duration) || duration <= 0) throw new Error('The file does not contain a playable video track.');
  return { hdr: ['smpte2084', 'arib-std-b67'].includes(video.color_transfer) };
}
async function transcodeVideo(source, output, hdr) {
  const normalize = 'scale=w=min(1920\\,iw):h=min(1080\\,ih):force_original_aspect_ratio=decrease:force_divisible_by=2,fps=30,format=yuv420p';
  const hdrFilter = 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable,zscale=t=bt709:m=bt709:r=tv,' + normalize;
  const args = ['-hide_banner', '-nostdin', '-y', '-i', source, '-map', '0:v:0', '-map', '0:a:0?', '-vf', hdr ? hdrFilter : normalize,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart', '-f', 'mp4', output];
  try {
    await execFileAsync('ffmpeg', args, { timeout: 10 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 });
  } catch (error) {
    if (!(hdr && /No such filter|filter not found/i.test(error.stderr || ''))) throw error;
    await execFileAsync('ffmpeg', [...args.slice(0, args.indexOf('-vf')), '-vf', normalize, ...args.slice(args.indexOf('-vf') + 2)],
      { timeout: 10 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 });
  }
}
async function processVideoJob(job) {
  const source = path.join(VIDEO_DIR, job.sourceFile);
  const outputTmp = path.join(VIDEO_DIR, `.${job.outputFile}.processing`);
  try {
    setVideoJob(job, { status: 'processing', error: null });
    const { hdr } = await probeVideo(source);
    await transcodeVideo(source, outputTmp, hdr);
    const outputStat = fs.statSync(outputTmp);
    if (outputStat.size < 1024) throw new Error('The converted video is empty or incomplete.');
    const outputProbe = await probeVideo(outputTmp);
    if (!outputProbe) throw new Error('The converted video failed validation.');
    fs.renameSync(outputTmp, path.join(VIDEO_DIR, job.outputFile));
    const videos = readExerciseVideoIndex();
    const previousEntry = videos[job.indexKey];
    videos[job.indexKey] = { exerciseId: job.exerciseId, ...(job.ownerId ? { ownerId: job.ownerId } : {}), name: job.name, file: job.outputFile, size: outputStat.size, updatedAt: new Date().toISOString() };
    atomicWrite(exerciseVideoIndexFile, JSON.stringify(videos, null, 2));
    if (previousEntry?.file && previousEntry.file !== job.outputFile) {
      const oldFile = exerciseVideoFile(previousEntry.file);
      if (oldFile) fs.rmSync(oldFile, { force: true });
    }
    fs.rmSync(source, { force: true });
    setVideoJob(job, { status: 'ready', sourceFile: null, error: null });
  } catch (error) {
    fs.rmSync(outputTmp, { force: true });
    fs.rmSync(source, { force: true });
    setVideoJob(job, { status: 'failed', sourceFile: null, error: String(error.stderr || error.message || 'Video conversion failed.').slice(-1200) });
  }
}
async function pumpVideoQueue() {
  if (processingVideoQueue) return;
  processingVideoQueue = true;
  try {
    while (videoQueue.length) {
      const job = videoJobs[videoQueue.shift()];
      if (job) await processVideoJob(job);
    }
  } finally { processingVideoQueue = false; }
}
function enqueueVideoJob(job) {
  const completed = Object.values(videoJobs).filter(item => ['ready', 'failed'].includes(item.status)).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  while (Object.keys(videoJobs).length >= 100 && completed.length) delete videoJobs[completed.shift().id];
  videoJobs[job.id] = job;
  videoQueue.push(job.id);
  saveVideoJobs();
  void pumpVideoQueue();
}
for (const job of Object.values(videoJobs)) {
  if (job.status === 'queued' || job.status === 'processing') {
    if (job.sourceFile && fs.existsSync(path.join(VIDEO_DIR, job.sourceFile))) {
      job.status = 'queued'; videoQueue.push(job.id);
    } else if (readExerciseVideoIndex()[job.indexKey]?.file === job.outputFile && fs.existsSync(path.join(VIDEO_DIR, job.outputFile))) {
      job.status = 'ready'; job.sourceFile = null; job.error = null;
    } else {
      job.status = 'failed'; job.sourceFile = null; job.error = 'The uploaded file was missing after the server restarted.';
    }
  }
}
saveVideoJobs();
if (videoQueue.length) void pumpVideoQueue();
function readAdminAudit() {
  try { const rows = JSON.parse(fs.readFileSync(adminAuditFile, 'utf8')); return Array.isArray(rows) ? rows : []; }
  catch { return []; }
}
function accountEmail(userId) {
  return db.users.find(item => item.id === userId)?.email ||
    db.passwords.find(item => item.userId === userId)?.email ||
    db.identities.find(item => item.userId === userId && item.email)?.email ||
    db.supabaseIdentities.find(item => item.userId === userId && item.email)?.email || null;
}

/* ---------- push notifications (Web Push / VAPID) ---------- */
const vapidFile = path.join(DATA, 'vapid.json');
let vapid;
try { vapid = JSON.parse(fs.readFileSync(vapidFile, 'utf8')); }
catch { vapid = webpush.generateVAPIDKeys(); fs.writeFileSync(vapidFile, JSON.stringify(vapid), { mode: 0o600 }); }
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || (SECURE ? ORIGIN : 'mailto:admin@localhost');
webpush.setVapidDetails(VAPID_SUBJECT, vapid.publicKey, vapid.privateKey);

async function sendPush(userId, payload) {
  const subs = db.subs.filter(s => s.userId === userId);
  if (!subs.length) return;
  const body = JSON.stringify(payload);
  let dirty = false;
  await Promise.all(subs.map(async sub => {
    // urgency 'high' is the one lever we have over delivery speed — iOS/Android throttle
    // low-urgency background push more aggressively under battery-saving modes. TTL is left
    // at the library default (long) so a briefly-offline device still gets it once reconnected,
    // rather than risking it being dropped for the sake of shaving off latency that TTL doesn't
    // actually control anyway.
    try { await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, body, { urgency: 'high' }); }
    catch (e) {
      console.error('push send failed', userId, e.statusCode, e.body || e.message);
      if (e.statusCode === 404 || e.statusCode === 410) {
        db.subs = db.subs.filter(s => s.endpoint !== sub.endpoint); dirty = true;
      }
    }
  }));
  if (dirty) saveDb();
}

// Rest-timer alerts: client schedules on start/extend, cancels on skip or on-screen completion —
// this only fires when the tab was backgrounded/suspended and never got to cancel it itself.
const restTimers = new Map(); // userId -> Timeout
function scheduleRestTimer(userId, sec) {
  const t = restTimers.get(userId);
  if (t) clearTimeout(t);
  restTimers.set(userId, setTimeout(() => {
    restTimers.delete(userId);
    sendPush(userId, { title: 'Rest over 💪', body: 'Time for your next set.', tag: 'rest-timer' });
  }, sec * 1000));
}
function cancelRestTimer(userId) {
  const t = restTimers.get(userId);
  if (t) { clearTimeout(t); restTimers.delete(userId); }
}

// "Workout planned today" reminder — one per user per day, at their chosen time.
// Duplicated (not imported) from frontend/src/lib/history.js effectiveRoutineId — tiny pure helper, not worth sharing across the two runtimes.
function effectiveRoutineId(S, iso) {
  const ov = S.dayPlan?.[iso];
  if (ov === 'rest') return null;
  if (ov && S.routines?.some(r => r.id === ov)) return ov;
  const wd = new Date(iso + 'T12:00:00').getDay();
  return S.week?.[wd] || null;
}
// Computes "now" in an arbitrary IANA zone (e.g. "Europe/Lisbon") instead of the server's own —
// each user's reminder fires by their own clock, wherever they and their phone actually are.
function userNow(tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    }).formatToParts(new Date());
    const g = t => parts.find(p => p.type === t)?.value;
    return { date: `${g('year')}-${g('month')}-${g('day')}`, hhmm: `${g('hour')}:${g('minute')}` };
  } catch { return null; } // unknown/invalid tz string — skip this user rather than guess
}
setInterval(() => {
  for (const user of db.users) {
    if (!db.subs.some(s => s.userId === user.id)) continue;
    const S = readState(user.id);
    if (!S?.reminder?.on) continue;
    const now = userNow(S.reminder.tz || 'UTC');
    if (!now || S.reminder.time !== now.hhmm) continue;
    if (user.lastReminder === now.date) continue;
    if ((S.workouts || []).some(w => w.d === now.date)) continue;
    const rid = effectiveRoutineId(S, now.date);
    if (!rid) continue; // rest day — nothing planned
    const routine = (S.routines || []).find(r => r.id === rid);
    console.log('reminder firing', user.id, rid);
    user.lastReminder = now.date;
    saveDb();
    sendPush(user.id, {
      title: routine ? `${routine.emoji || '🏋️'} ${routine.name} today` : 'Workout planned today',
      body: "It's on your plan — let's go 💪",
      tag: 'day-reminder'
    });
  }
// Checked every 10s (not 60s) — ticks aren't aligned to the top of the minute, so a 60s
// interval could sit on your target minute for up to 59s before noticing. 10s caps that at ~9s.
}, 10000).unref();

/* ---------- sessions (signed cookie) ---------- */
function sign(payload) {
  const mac = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return payload + '.' + mac;
}
function verifySig(token) {
  const i = token.lastIndexOf('.');
  if (i < 0) return null;
  const payload = token.slice(0, i), mac = token.slice(i + 1);
  const expect = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  try {
    if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
  } catch { return null; }
  return payload;
}
// Session payload is `<uid>:<expiry>:<version>`, where the version is the user's `sv` counter.
// Bumping `sv` (POST /api/logout/all) makes every cookie ever handed out for that account stop
// verifying, which is the only revocation there was before short of deleting ./data/secret and
// signing out the whole instance. Cookies minted before `sv` existed have no third field and are
// read as version 0, matching a user who has never bumped — they stay valid until they expire.
const sessionVersion = user => user.sv || 0;
function makeSession(user) {
  const exp = Date.now() + SESSION_DAYS * 86400000;
  return sign(user.id + ':' + exp + ':' + sessionVersion(user));
}
function readSession(req) {
  const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(c => {
    const i = c.indexOf('='); return i < 0 ? ['', ''] : [c.slice(0, i).trim(), c.slice(i + 1).trim()];
  }));
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  const tok = bearer?.[1] || cookies.gymsid;
  if (!tok) return null;
  const payload = verifySig(tok);
  if (!payload) return null;
  const [uid, exp, ver] = payload.split(':');
  if (!uid || +exp < Date.now()) return null;
  const user = db.users.find(u => u.id === uid) || null;
  if (!user) return null;
  if (user.disabled) return null;           // disabled accounts are locked out everywhere
  // Missing third field = pre-versioning cookie = version 0. Anything non-numeric is a malformed
  // payload (it still had to pass the HMAC, so this is belt-and-braces) and is refused outright.
  const claimed = ver === undefined ? 0 : Number(ver);
  if (!Number.isInteger(claimed) || claimed !== sessionVersion(user)) return null;
  return user;
}
// Guard for /api/admin/* — resolves the caller and 401/403s if they aren't an admin.
function requireAdmin(req, res) {
  const user = readSession(req);
  if (!user) { json(res, 401, { error: 'not signed in' }); return null; }
  if (!isAdmin(user)) { json(res, 403, { error: 'forbidden' }); return null; }
  return user;
}
function sessionCookie(user) {
  return `gymsid=${makeSession(user)}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly;${SECURE} SameSite=Lax`;
}
const clearCookie = `gymsid=; Path=/; Max-Age=0; HttpOnly;${SECURE} SameSite=Lax`;

function publicUser(user) {
  const methods = new Set();
  if (db.creds.some(c => c.userId === user.id)) methods.add('passkey');
  if (db.passwords.some(p => p.userId === user.id)) methods.add('password');
  for (const identity of db.identities.filter(i => i.userId === user.id)) methods.add(identity.provider);
  for (const identity of db.supabaseIdentities.filter(i => i.userId === user.id)) {
    for (const provider of identity.providers || []) methods.add(provider === 'email' ? 'password' : provider);
  }
  return { id: user.id, name: user.name, admin: isAdmin(user), authMethods: [...methods], managedAuth: db.supabaseIdentities.some(i => i.userId === user.id) };
}
function authReply(req, res, user, body = {}) {
  if (body.client === 'native') {
    return json(res, 200, { user: publicUser(user), sessionToken: makeSession(user), expiresIn: SESSION_DAYS * 86400 });
  }
  return json(res, 200, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(user) });
}
function newUser(name) {
  const user = { id: crypto.randomBytes(12).toString('base64url'), name: String(name || '').trim().slice(0, 40) || 'Athlete', created: new Date().toISOString() };
  db.users.push(user);
  return user;
}
function consumeInvite(code, user) {
  if (!INVITE_ONLY) return true;
  const invite = db.invites.find(i => i.code === String(code || '').trim().toUpperCase() && !i.usedBy && !i.revoked);
  if (!invite) return false;
  invite.usedBy = user.id; invite.usedAt = user.created; user.invitedBy = invite.code;
  return true;
}
const normalizeEmail = value => String(value || '').trim().toLowerCase();
const emailOk = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
const passwordOk = value => typeof value === 'string' && value.length >= 12 && value.length <= 128;
const pendingPasswordEmails = new Set();
async function idTokenClaims(provider, token, expectedNonce) {
  if (provider === 'google') {
    if (!GOOGLE_CLIENT_IDS.length) throw Object.assign(new Error('Google sign-in is not configured'), { status: 503 });
    const { payload } = await jwtVerify(token, googleKeys, { issuer: ['https://accounts.google.com', 'accounts.google.com'], audience: GOOGLE_CLIENT_IDS });
    if (expectedNonce && payload.nonce !== expectedNonce) throw Object.assign(new Error('sign-in challenge did not match'), { status: 401 });
    if (!payload.sub) throw Object.assign(new Error('Google identity is missing'), { status: 401 });
    return { sub: String(payload.sub), email: normalizeEmail(payload.email), emailVerified: payload.email_verified === true, name: payload.name };
  }
  if (provider === 'apple') {
    if (!APPLE_CLIENT_IDS.length) throw Object.assign(new Error('Apple sign-in is not configured'), { status: 503 });
    const { payload } = await jwtVerify(token, appleKeys, { issuer: 'https://appleid.apple.com', audience: APPLE_CLIENT_IDS });
    if (expectedNonce && payload.nonce !== crypto.createHash('sha256').update(expectedNonce).digest('hex')) throw Object.assign(new Error('sign-in challenge did not match'), { status: 401 });
    if (!payload.sub) throw Object.assign(new Error('Apple identity is missing'), { status: 401 });
    return { sub: String(payload.sub), email: normalizeEmail(payload.email), emailVerified: payload.email_verified === true || payload.email_verified === 'true', name: '' };
  }
  throw Object.assign(new Error('unsupported identity provider'), { status: 400 });
}
async function finishProviderAuth(req, res, provider, body, link = false) {
  const config = provider === 'google' ? GOOGLE_CLIENT_IDS : APPLE_CLIENT_IDS;
  if (!config.length) return json(res, 503, { error: provider[0].toUpperCase() + provider.slice(1) + ' sign-in is not configured' });
  const challenge = takeChallenge(body.cid);
  if (!challenge || challenge.provider !== provider) return json(res, 400, { error: 'sign-in challenge expired — try again' });
  let claims;
  try { claims = await idTokenClaims(provider, String(body.idToken || ''), challenge.nonce); }
  catch (e) { return json(res, e.status || 401, { error: e.message || 'identity token could not be verified' }); }
  const identity = db.identities.find(x => x.provider === provider && x.sub === claims.sub);
  if (link) {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'sign in before linking an account' });
    if (identity && identity.userId !== user.id) return json(res, 409, { error: 'this provider account belongs to another profile' });
    if (!identity) db.identities.push({ provider, sub: claims.sub, userId: user.id, email: claims.email || null, emailVerified: claims.emailVerified, linkedAt: new Date().toISOString() });
    if (claims.email && claims.emailVerified && !user.email) user.email = claims.email;
    saveDb();
    return json(res, 200, { user: publicUser(user) });
  }
  let user = identity ? db.users.find(u => u.id === identity.userId) : null;
  if (identity && !user) return json(res, 500, { error: 'linked profile is missing' });
  if (!user) {
    user = newUser(String(body.name || claims.name || 'Athlete'));
    if (!consumeInvite(body.code, user)) { db.users.pop(); return json(res, 403, { error: 'a valid invite code is required' }); }
    if (claims.email && claims.emailVerified) user.email = claims.email;
    db.identities.push({ provider, sub: claims.sub, userId: user.id, email: claims.email || null, emailVerified: claims.emailVerified, linkedAt: new Date().toISOString() });
  }
  if (user.disabled) return json(res, 403, { error: 'this account has been disabled' });
  saveDb();
  return authReply(req, res, user, body);
}

let supabaseSettingsCache = { expires: 0, providers: {} };
async function supabaseProviders() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return {};
  if (supabaseSettingsCache.expires > Date.now()) return supabaseSettingsCache.providers;
  try {
    const response = await fetch(`${SUPABASE_URL}/auth/v1/settings`, {
      headers: { apikey: SUPABASE_ANON_KEY },
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) throw new Error(`Supabase settings returned ${response.status}`);
    const settings = await response.json();
    supabaseSettingsCache = { expires: Date.now() + 60000, providers: settings.external || {} };
    return supabaseSettingsCache.providers;
  } catch (error) {
    console.error('Supabase auth settings unavailable:', error.message);
    return supabaseSettingsCache.providers;
  }
}

async function verifiedSupabaseUser(accessToken) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) throw Object.assign(new Error('Supabase Auth is not configured'), { status: 503 });
  if (typeof accessToken !== 'string' || accessToken.length < 20 || accessToken.length > 8192)
    throw Object.assign(new Error('a valid Supabase access token is required'), { status: 400 });
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(7000)
  });
  if (!response.ok) throw Object.assign(new Error('Supabase session is invalid or expired'), { status: 401 });
  const user = await response.json();
  if (!user?.id) throw Object.assign(new Error('Supabase returned an invalid user'), { status: 401 });
  return user;
}

function supabaseProviderNames(user) {
  const providers = new Set([...(user.app_metadata?.providers || []), ...(user.identities || []).map(identity => identity.provider).filter(Boolean)]);
  return [...providers].filter(provider => provider === 'email' || ['google', 'apple'].includes(provider));
}

async function finishSupabaseAuth(req, res, body, link = false) {
  if (!limitAuth(req, res, link ? 'supabase-link' : 'supabase-exchange', 30, 5 * 60 * 1000)) return;
  let supaUser;
  try { supaUser = await verifiedSupabaseUser(String(body.accessToken || '')); }
  catch (error) { return json(res, error.status || 502, { error: error.message || 'Supabase session could not be verified' }); }

  const providers = supabaseProviderNames(supaUser);
  const email = normalizeEmail(supaUser.email);
  const verifiedEmail = !!(supaUser.email_confirmed_at || supaUser.confirmed_at);
  let identity = db.supabaseIdentities.find(item => item.sub === String(supaUser.id));

  if (link) {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'sign in before linking an account' });
    if (identity && identity.userId !== user.id) return json(res, 409, { error: 'this Supabase account belongs to another profile' });
    if (!identity) {
      identity = { sub: String(supaUser.id), userId: user.id, providers, linkedAt: new Date().toISOString() };
      db.supabaseIdentities.push(identity);
    } else identity.providers = providers;
    if (verifiedEmail && email && !user.email) user.email = email;
    saveDb();
    return json(res, 200, { user: publicUser(user) });
  }

  let user = identity ? db.users.find(item => item.id === identity.userId) : null;
  if (identity && !user) return json(res, 500, { error: 'linked OpenGym profile is missing' });
  if (!user) {
    const meta = supaUser.user_metadata || {};
    user = newUser(String(body.name || meta.full_name || meta.name || email.split('@')[0] || 'Athlete'));
    const inviteCode = body.code || meta.invite_code || '';
    if (!consumeInvite(inviteCode, user)) {
      db.users = db.users.filter(item => item.id !== user.id);
      return json(res, 403, { error: 'a valid invite code is required' });
    }
    if (verifiedEmail && email) user.email = email;
    identity = { sub: String(supaUser.id), userId: user.id, providers, linkedAt: new Date().toISOString() };
    db.supabaseIdentities.push(identity);
  } else identity.providers = providers;
  if (user.disabled) return json(res, 403, { error: 'this account has been disabled' });
  saveDb();
  return authReply(req, res, user, body);
}

/* ---------- challenge store (in-memory, 5 min TTL) ---------- */
const challenges = new Map(); // cid -> {challenge, name?, uid?, exp}
const appleOAuthStates = new Map();
const nativeAuthCodes = new Map();
const authBuckets = new Map();
function limitAuth(req, res, action, max, windowMs) {
  const ip = String(req.headers['x-real-ip'] || req.socket.remoteAddress || 'unknown').slice(0, 80);
  const key = action + ':' + ip, now = Date.now();
  let bucket = authBuckets.get(key);
  if (!bucket || now - bucket.start >= windowMs) bucket = { start: now, count: 0 };
  bucket.count++;
  authBuckets.set(key, bucket);
  if (bucket.count <= max) return true;
  const retry = Math.max(1, Math.ceil((bucket.start + windowMs - now) / 1000));
  json(res, 429, { error: 'too many attempts; try again shortly' }, { 'Retry-After': String(retry) });
  return false;
}
setInterval(() => { const cutoff = Date.now() - 3600000; for (const [k, v] of authBuckets) if (v.start < cutoff) authBuckets.delete(k); }, 60000).unref();
function putChallenge(data) {
  const cid = crypto.randomBytes(16).toString('base64url');
  challenges.set(cid, { ...data, exp: Date.now() + 5 * 60000 });
  return cid;
}
function takeChallenge(cid) {
  const c = challenges.get(cid);
  challenges.delete(cid);
  if (!c || c.exp < Date.now()) return null;
  return c;
}
setInterval(() => { for (const [k, v] of challenges) if (v.exp < Date.now()) challenges.delete(k); }, 60000).unref();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of appleOAuthStates) if (v.expires < now) appleOAuthStates.delete(k);
  for (const [k, v] of nativeAuthCodes) if (v.expires < now) nativeAuthCodes.delete(k);
}, 60000).unref();

/* ---------- helpers ---------- */
function json(res, code, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(extraHeaders || {}) });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', d => {
      size += d.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(d);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}
async function readFormBody(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw Object.assign(new Error('form too large'), { status: 413 });
    chunks.push(chunk);
  }
  return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
}
const b64uToBuf = s => Buffer.from(s, 'base64url');

/* ---------- live presence (in-memory) ---------- */
// Clients heartbeat /api/activity while a workout is on screen; the admin dashboard reads who's
// live. Purely ephemeral — never persisted. Expires shortly after the last ping.
const presence = new Map();               // uid -> { name, exIdx, exTotal, setsDone, setsTotal, startedAt, updatedAt }
const PRESENCE_TTL = 70000;               // ~3.5× the 20s client heartbeat
function livePresence(uid) {
  const p = presence.get(uid);
  if (!p) return null;
  if (Date.now() - p.updatedAt > PRESENCE_TTL) { presence.delete(uid); return null; }
  return p;
}
setInterval(() => { for (const [k, v] of presence) if (Date.now() - v.updatedAt > PRESENCE_TTL) presence.delete(k); }, 30000).unref();

/* ---------- routes ---------- */
const routes = {
  'GET /api/health': async (req, res) => json(res, 200, { ok: true, users: db.users.length }),
  'GET /api/foods/search': async (req, res) => {
    const query = new URL(req.url, 'http://x').searchParams.get('q');
    const foods = searchFoods(query);
    if (!foods) return json(res, 400, { error: 'search must contain 2–80 characters' });
    json(res, 200, {
      foods,
      source: foodCatalog.source,
      version: foodCatalog.version,
      basis: foodCatalog.basis || 'Nutrients per 100 g edible portion'
    }, { 'Cache-Control': 'public, max-age=300' });
  },
  'GET /api/foods/examples': async (req, res) => json(res, 200, {
    foods: exampleFoods,
    source: foodCatalog.source,
    version: foodCatalog.version
  }, { 'Cache-Control': 'public, max-age=3600' }),

  'GET /.well-known/apple-app-site-association': async (req, res) => {
    if (!/^[A-Z0-9]{10}$/.test(APPLE_TEAM_ID) || !APPLE_IOS_CLIENT_ID) return json(res, 404, { error: 'Apple passkey association is not configured' });
    json(res, 200, { webcredentials: { apps: [`${APPLE_TEAM_ID}.${APPLE_IOS_CLIENT_ID}`] } }, { 'Cache-Control': 'public, max-age=300' });
  },

  // Public config the login screen needs before anyone is signed in.
  'GET /api/config': async (req, res) => {
    const providers = await supabaseProviders();
    const googleEnabled = providers.google === true;
    const appleEnabled = providers.apple === true;
    return json(res, 200, {
      invite_only: INVITE_ONLY, allow_guest: ALLOW_GUEST,
      rp_id: RP_ID,
      password_enabled: true,
      supabase_enabled: !!(SUPABASE_URL && SUPABASE_ANON_KEY),
      supabase_url: SUPABASE_URL || null,
      supabase_anon_key: SUPABASE_ANON_KEY || null,
      google_enabled: googleEnabled,
      google_android_enabled: googleEnabled && !!GOOGLE_WEB_CLIENT_ID,
      google_ios_enabled: googleEnabled && !!GOOGLE_WEB_CLIENT_ID && !!GOOGLE_IOS_CLIENT_ID,
      apple_enabled: appleEnabled,
      apple_android_enabled: appleEnabled && !!APPLE_WEB_CLIENT_ID,
      apple_native_enabled: appleEnabled && !!APPLE_IOS_CLIENT_ID,
      google_client_id: GOOGLE_WEB_CLIENT_ID || null,
      google_ios_client_id: GOOGLE_IOS_CLIENT_ID || null,
      apple_ios_client_id: APPLE_IOS_CLIENT_ID || null,
      apple_client_id: APPLE_WEB_CLIENT_ID || null,
      apple_redirect_url: SUPABASE_URL ? `${SUPABASE_URL}/auth/v1/callback` : (APPLE_REDIRECT_URL || null),
      google_redirect_url: SUPABASE_URL ? `${SUPABASE_URL}/auth/v1/callback` : null
    });
  },

  'POST /api/auth/supabase/exchange': async (req, res) => finishSupabaseAuth(req, res, await readBody(req)),
  'POST /api/auth/supabase/link': async (req, res) => finishSupabaseAuth(req, res, await readBody(req), true),

  'POST /api/auth/password/register': async (req, res) => {
    if (!limitAuth(req, res, 'password-register', 8, 60 * 60 * 1000)) return;
    const body = await readBody(req);
    const email = normalizeEmail(body.email), password = body.password;
    const name = String(body.name || '').trim().slice(0, 40);
    if (!emailOk(email)) return json(res, 400, { error: 'enter a valid email address' });
    if (!passwordOk(password)) return json(res, 400, { error: 'password must be 12–128 characters' });
    if (!name) return json(res, 400, { error: 'name required' });
    if (db.passwords.some(p => p.email === email) || pendingPasswordEmails.has(email)) return json(res, 409, { error: 'an account already uses that email; sign in and add another sign-in method in settings' });
    pendingPasswordEmails.add(email);
    const user = newUser(name);
    if (!consumeInvite(body.code, user)) { db.users.pop(); pendingPasswordEmails.delete(email); return json(res, 403, { error: 'a valid invite code is required' }); }
    try {
      const encoded = await hashPassword(password, { algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
      user.email = email; user.emailVerified = false;
      db.passwords.push({ userId: user.id, email, hash: encoded, created: new Date().toISOString() });
      saveDb();
      return authReply(req, res, user, body);
    } catch (e) {
      db.users = db.users.filter(u => u.id !== user.id);
      if (user.invitedBy) { const inv = db.invites.find(i => i.code === user.invitedBy); if (inv) { delete inv.usedBy; delete inv.usedAt; } }
      throw e;
    } finally {
      pendingPasswordEmails.delete(email);
    }
  },

  'POST /api/auth/password/login': async (req, res) => {
    if (!limitAuth(req, res, 'password-login', 10, 5 * 60 * 1000)) return;
    const body = await readBody(req);
    const email = normalizeEmail(body.email);
    const credential = db.passwords.find(p => p.email === email);
    if (!credential) return json(res, 401, { error: 'email or password is incorrect' });
    let valid = false;
    try { valid = await verifyPassword(credential.hash, String(body.password || '')); } catch {}
    if (!valid) return json(res, 401, { error: 'email or password is incorrect' });
    const user = db.users.find(u => u.id === credential.userId);
    if (!user || user.disabled) return json(res, 403, { error: 'this account is unavailable' });
    return authReply(req, res, user, body);
  },

  'POST /api/auth/password/link': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'sign in before adding a password' });
    const body = await readBody(req);
    const email = normalizeEmail(body.email), password = body.password;
    if (!emailOk(email)) return json(res, 400, { error: 'enter a valid email address' });
    if (!passwordOk(password)) return json(res, 400, { error: 'password must be 12–128 characters' });
    const existing = db.passwords.find(p => p.email === email);
    if ((existing && existing.userId !== user.id) || pendingPasswordEmails.has(email)) return json(res, 409, { error: 'that email is already used by another account' });
    if (existing) return json(res, 409, { error: 'this profile already has a password; use change password' });
    pendingPasswordEmails.add(email);
    try {
      const encoded = await hashPassword(password, { algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
      user.email = email; user.emailVerified = false;
      db.passwords.push({ userId: user.id, email, hash: encoded, created: new Date().toISOString() });
      saveDb();
    } finally { pendingPasswordEmails.delete(email); }
    return json(res, 200, { user: publicUser(user) });
  },

  'POST /api/auth/password/change': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    const credential = db.passwords.find(p => p.userId === user.id);
    if (!credential) return json(res, 404, { error: 'this profile has no password yet' });
    if (String(body.password || '').length < 1 || !await verifyPassword(credential.hash, String(body.password))) return json(res, 401, { error: 'current password is incorrect' });
    if (!passwordOk(body.newPassword)) return json(res, 400, { error: 'new password must be 12–128 characters' });
    credential.hash = await hashPassword(body.newPassword, { algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
    user.sv = sessionVersion(user) + 1;
    saveDb();
    return authReply(req, res, user, body);
  },

  'POST /api/auth/provider/challenge': async (req, res) => {
    if (!limitAuth(req, res, 'provider-challenge', 30, 5 * 60 * 1000)) return;
    const body = await readBody(req), provider = String(body.provider || '').toLowerCase();
    if (!['google', 'apple'].includes(provider)) return json(res, 400, { error: 'unsupported identity provider' });
    if (!(provider === 'google' ? GOOGLE_CLIENT_IDS.length : APPLE_CLIENT_IDS.length)) return json(res, 503, { error: provider + ' sign-in is not configured' });
    const nonce = crypto.randomBytes(24).toString('base64url');
    const cid = putChallenge({ provider, nonce });
    json(res, 200, { cid, nonce });
  },
  'POST /api/auth/provider/google': async (req, res) => finishProviderAuth(req, res, 'google', await readBody(req)),
  'POST /api/auth/provider/apple': async (req, res) => finishProviderAuth(req, res, 'apple', await readBody(req)),
  'POST /api/auth/provider/link/google': async (req, res) => finishProviderAuth(req, res, 'google', await readBody(req), true),
  'POST /api/auth/provider/link/apple': async (req, res) => finishProviderAuth(req, res, 'apple', await readBody(req), true),

  // Android native apps use Apple's HTTPS web authorization, then exchange a PKCE-bound,
  // one-time callback code for the same bearer session returned to other native clients.
  'POST /api/auth/provider/apple/start': async (req, res) => {
    if (!limitAuth(req, res, 'apple-native-start', 20, 5 * 60 * 1000)) return;
    if (!APPLE_CLIENT_IDS.length || !APPLE_WEB_CLIENT_ID || !APPLE_REDIRECT_URL) return json(res, 503, { error: 'Apple web sign-in is not configured' });
    const body = await readBody(req);
    const verifierChallenge = String(body.codeChallenge || '');
    if (!/^[A-Za-z0-9_-]{43}$/.test(verifierChallenge)) return json(res, 400, { error: 'a valid PKCE challenge is required' });
    const state = crypto.randomBytes(24).toString('base64url');
    const nonce = crypto.randomBytes(24).toString('base64url');
    appleOAuthStates.set(state, {
      state, nonce, verifierChallenge,
      name: String(body.name || '').trim().slice(0, 40),
      inviteCode: String(body.code || '').trim().toUpperCase(),
      expires: Date.now() + 5 * 60 * 1000
    });
    const authorize = new URL('https://appleid.apple.com/auth/authorize');
    authorize.searchParams.set('client_id', APPLE_WEB_CLIENT_ID);
    authorize.searchParams.set('redirect_uri', APPLE_REDIRECT_URL);
    authorize.searchParams.set('response_type', 'code id_token');
    authorize.searchParams.set('response_mode', 'form_post');
    authorize.searchParams.set('scope', 'email name');
    authorize.searchParams.set('state', state);
    authorize.searchParams.set('nonce', crypto.createHash('sha256').update(nonce).digest('hex'));
    json(res, 200, { authorizationUrl: authorize.toString(), state });
  },
  'POST /api/auth/apple/callback': async (req, res) => {
    const body = await readFormBody(req);
    const state = String(body.state || ''), flow = appleOAuthStates.get(state);
    appleOAuthStates.delete(state);
    const redirectError = error => {
      const target = new URL(NATIVE_REDIRECT_URI);
      target.searchParams.set('state', state);
      target.searchParams.set('error', error);
      res.writeHead(302, { Location: target.toString(), 'Cache-Control': 'no-store' }); res.end();
    };
    if (!flow || flow.expires < Date.now()) return redirectError('expired');
    if (body.error || !body.id_token) return redirectError('cancelled');
    let claims;
    try { claims = await idTokenClaims('apple', body.id_token, flow.nonce); }
    catch (e) { console.error('Apple callback token verification failed:', e.message); return redirectError('invalid_identity'); }
    let identity = db.identities.find(i => i.provider === 'apple' && i.sub === claims.sub);
    let user = identity ? db.users.find(u => u.id === identity.userId) : null;
    if (identity && (!user || user.disabled)) return redirectError('account_unavailable');
    if (!user) {
      let appleName = '';
      try {
        const profile = JSON.parse(body.user || '{}');
        appleName = [profile.name?.firstName, profile.name?.lastName].filter(Boolean).join(' ');
      } catch {}
      user = newUser(flow.name || appleName || claims.name || 'Athlete');
      if (!consumeInvite(flow.inviteCode, user)) { db.users.pop(); return redirectError('invite_required'); }
      if (claims.email && claims.emailVerified) user.email = claims.email;
      identity = { provider: 'apple', sub: claims.sub, userId: user.id, email: claims.email || null, emailVerified: claims.emailVerified, linkedAt: new Date().toISOString() };
      db.identities.push(identity);
      saveDb();
    }
    const code = crypto.randomBytes(32).toString('base64url');
    nativeAuthCodes.set(code, { userId: user.id, verifierChallenge: flow.verifierChallenge, expires: Date.now() + 2 * 60 * 1000 });
    const target = new URL(NATIVE_REDIRECT_URI);
    target.searchParams.set('code', code);
    target.searchParams.set('state', state);
    res.writeHead(302, { Location: target.toString(), 'Cache-Control': 'no-store' }); res.end();
  },
  'POST /api/auth/native/exchange': async (req, res) => {
    const body = await readBody(req);
    const code = String(body.code || ''), verifier = String(body.codeVerifier || '');
    const grant = nativeAuthCodes.get(code);
    nativeAuthCodes.delete(code);
    if (!grant || grant.expires < Date.now()) return json(res, 400, { error: 'native sign-in code is invalid or expired' });
    if (verifier.length < 43 || verifier.length > 128 || crypto.createHash('sha256').update(verifier).digest('base64url') !== grant.verifierChallenge) return json(res, 401, { error: 'native sign-in verifier did not match' });
    const user = db.users.find(u => u.id === grant.userId);
    if (!user || user.disabled) return json(res, 403, { error: 'this account is unavailable' });
    json(res, 200, { user: publicUser(user), sessionToken: makeSession(user), expiresIn: SESSION_DAYS * 86400 });
  },

  'POST /api/auth/password/reset': async (req, res) => {
    if (!limitAuth(req, res, 'password-reset', 5, 15 * 60 * 1000)) return;
    const body = await readBody(req);
    const rawCode = String(body.code || '');
    const codeHash = crypto.createHash('sha256').update(rawCode).digest('hex');
    const reset = db.passwordResets.find(r => r.codeHash === codeHash && r.expires > Date.now());
    if (!reset) return json(res, 400, { error: 'reset code is invalid or expired' });
    if (!passwordOk(body.newPassword)) return json(res, 400, { error: 'new password must be 12–128 characters' });
    const credential = db.passwords.find(p => p.userId === reset.userId);
    const user = db.users.find(u => u.id === reset.userId);
    if (!credential || !user || user.disabled) return json(res, 400, { error: 'password reset is unavailable for this profile' });
    credential.hash = await hashPassword(body.newPassword, { algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
    user.sv = sessionVersion(user) + 1;
    db.passwordResets = db.passwordResets.filter(r => r !== reset);
    saveDb();
    json(res, 200, { ok: true });
  },

  'GET /api/me': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    json(res, 200, { user: publicUser(user) });
  },

  'POST /api/register/options': async (req, res) => {
    const body = await readBody(req);
    const name = String(body.name || '').trim().slice(0, 40);
    if (!name) return json(res, 400, { error: 'name required' });
    const code = String(body.code || '').trim().toUpperCase();
    if (INVITE_ONLY && !db.invites.some(i => i.code === code && !i.usedBy && !i.revoked))
      return json(res, 403, { error: 'a valid invite code is required' });
    const uid = crypto.randomBytes(12).toString('base64url');
    const options = await generateRegistrationOptions({
      rpName: RP_NAME, rpID: RP_ID,
      userID: Buffer.from(uid), userName: name, userDisplayName: name,
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
      excludeCredentials: []
    });
    const cid = putChallenge({ challenge: options.challenge, name, uid, code });
    json(res, 200, { cid, options });
  },

  'POST /api/register/verify': async (req, res) => {
    const body = await readBody(req);
    const c = takeChallenge(body.cid);
    if (!c || !c.uid) return json(res, 400, { error: 'challenge expired — try again' });
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: body.credential,
        expectedChallenge: c.challenge,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
        requireUserVerification: false
      });
    } catch (e) { return json(res, 400, { error: 'verification failed: ' + e.message }); }
    if (!verification.verified) return json(res, 400, { error: 'not verified' });
    const { credential } = verification.registrationInfo;
    if (db.creds.find(x => x.id === credential.id)) return json(res, 409, { error: 'credential already registered' });
    // Re-check the invite at the last moment (it may have been used/revoked since options), then burn it.
    let invite = null;
    if (INVITE_ONLY) {
      invite = db.invites.find(i => i.code === c.code && !i.usedBy && !i.revoked);
      if (!invite) return json(res, 403, { error: 'invite code is no longer valid — ask for a new one' });
    }
    const user = { id: c.uid, name: c.name, created: new Date().toISOString() };
    if (invite) { user.invitedBy = invite.code; invite.usedBy = user.id; invite.usedAt = user.created; }
    db.users.push(user);
    db.creds.push({
      id: credential.id, userId: user.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter || 0,
      transports: body.credential?.response?.transports || []
    });
    saveDb();
    return authReply(req, res, user, body);
  },

  'POST /api/login/options': async (req, res) => {
    const options = await generateAuthenticationOptions({
      rpID: RP_ID, userVerification: 'preferred', allowCredentials: []
    });
    const cid = putChallenge({ challenge: options.challenge });
    json(res, 200, { cid, options });
  },

  'POST /api/login/verify': async (req, res) => {
    const body = await readBody(req);
    const c = takeChallenge(body.cid);
    if (!c) return json(res, 400, { error: 'challenge expired — try again' });
    const cred = db.creds.find(x => x.id === body.credential?.id);
    if (!cred) return json(res, 404, { error: 'unknown passkey — create a profile first' });
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: body.credential,
        expectedChallenge: c.challenge,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
        requireUserVerification: false,
        credential: {
          id: cred.id,
          publicKey: b64uToBuf(cred.publicKey),
          counter: cred.counter,
          transports: cred.transports
        }
      });
    } catch (e) { return json(res, 400, { error: 'verification failed: ' + e.message }); }
    if (!verification.verified) return json(res, 400, { error: 'not verified' });
    cred.counter = verification.authenticationInfo.newCounter;
    saveDb();
    const user = db.users.find(u => u.id === cred.userId);
    if (!user) return json(res, 500, { error: 'user missing' });
    if (user.disabled) return json(res, 403, { error: 'this account has been disabled' });
    return authReply(req, res, user, body);
  },

  'POST /api/logout': async (req, res) => json(res, 200, { ok: true }, { 'Set-Cookie': clearCookie }),

  // "Sign out everywhere" — bumps this user's session version, which invalidates every cookie
  // ever issued for the account, on every device, including a copy someone else walked off with.
  // The caller's own cookie is cleared here too, so the browser doing it doesn't sit on a token
  // it no longer accepts. Passkeys are untouched: signing back in works immediately.
  'POST /api/logout/all': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    user.sv = sessionVersion(user) + 1;
    saveDb();
    json(res, 200, { ok: true }, { 'Set-Cookie': clearCookie });
  },

  'GET /api/data': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    try {
      const state = JSON.parse(fs.readFileSync(stateFile(user.id), 'utf8'));
      json(res, 200, { state });
    } catch { json(res, 200, { state: null }); }
  },

  'PUT /api/data': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    if (!body.state || typeof body.state !== 'object') return json(res, 400, { error: 'state required' });
    const file = stateFile(user.id);
    const current = readState(user.id) || {};
    const currentRev = Number.isSafeInteger(current._rev) ? current._rev : 0;
    const clientRev = Number.isSafeInteger(body.state._rev) ? body.state._rev : 0;
    if (clientRev !== currentRev) return json(res, 409, { error: 'This profile changed on another device. The latest saved data was loaded; your previous copy is available in Settings.', conflict: true, rev: currentRev });
    delete body.state.active;              // in-progress workouts stay device-local
    body.state._rev = currentRev + 1;
    body.state._ts = Date.now();
    atomicWrite(file, JSON.stringify(body.state));
    json(res, 200, { ok: true, ts: body.state._ts, rev: body.state._rev });
  },

  'GET /api/push/public-key': async (req, res) => json(res, 200, { key: vapid.publicKey }),

  // Catalogue clips are shared; custom-exercise clips are visible to their owner and Admin.
  'GET /api/exercise-videos': async (_req, res) => {
    const viewer = readSession(_req);
    const videos = Object.fromEntries(Object.entries(readExerciseVideoIndex())
      .filter(([key, entry]) => {
        const id = entry?.exerciseId || key;
        if (!validExerciseId(id) || !entry || !exerciseVideoFile(entry.file) || !fs.existsSync(exerciseVideoFile(entry.file))) return false;
        return !entry.ownerId || (viewer && (isAdmin(viewer) || viewer.id === entry.ownerId));
      })
      .map(([key, entry]) => {
        const id = entry.exerciseId || key;
        return [exerciseVideoKey(id, entry.ownerId), { name: entry.name, url: `/exercise-videos/${entry.file}`, size: entry.size, updatedAt: entry.updatedAt }];
      }));
    json(res, 200, { videos }, { 'Cache-Control': 'no-store' });
  },

  'GET /api/admin/exercise-video/job': async (req, res) => {
    const actor = readSession(req);
    if (!actor) return json(res, 401, { error: 'not signed in' });
    const id = new URL(req.url, 'http://x').searchParams.get('id') || '';
    const job = videoJobs[id];
    if (!job) return json(res, 404, { error: 'video job not found' });
    if (job.actorId !== actor.id && !isAdmin(actor)) return json(res, 403, { error: 'forbidden' });
    json(res, 200, publicVideoJob(job), { 'Cache-Control': 'no-store' });
  },

  'PUT /api/admin/exercise-video': async (req, res) => {
    const actor = readSession(req);
    if (!actor) return json(res, 401, { error: 'not signed in' });
    const admin = isAdmin(actor);
    const id = String(req.headers['x-exercise-id'] || '');
    let requestedName;
    try { requestedName = decodeURIComponent(String(req.headers['x-exercise-name'] || '')).slice(0, 160); }
    catch { return json(res, 400, { error: 'valid exercise name required' }); }
    if (!validExerciseId(id) || !requestedName.trim()) return json(res, 400, { error: 'valid exercise id and name required' });
    const requestedOwnerId = String(req.headers['x-exercise-owner'] || '');
    let ownerId = null;
    let name = requestedName;
    if (requestedOwnerId || !admin) {
      ownerId = requestedOwnerId || actor.id;
      if (!admin && (ownerId !== actor.id || !id.startsWith('c'))) return json(res, 403, { error: 'you can only upload videos for your own custom exercises' });
      if (!db.users.some(user => user.id === ownerId)) return json(res, 404, { error: 'exercise owner not found' });
      const ownerState = readState(ownerId) || {};
      const custom = (ownerState.customEx || []).find(exercise => exercise.id === id && exercise.custom);
      if (!custom) return json(res, 404, { error: 'save this custom exercise before uploading its video' });
      name = String(custom.n || requestedName).slice(0, 160);
    }
    const indexKey = exerciseVideoKey(id, ownerId);
    const contentType = String(req.headers['content-type'] || '');
    if (!/^video\//i.test(contentType) && !/^application\/octet-stream(?:\s*;|$)/i.test(contentType)) return json(res, 415, { error: 'Choose a video file.' });
    if (videoQueue.length >= 20) return json(res, 503, { error: 'The video processing queue is full. Try again in a few minutes.' });
    if (Object.values(videoJobs).some(job => job.indexKey === indexKey && ['queued', 'processing'].includes(job.status))) {
      return json(res, 409, { error: 'A video for this exercise is already being processed.' });
    }
    const jobId = crypto.randomUUID();
    const sourceFile = `${id}-${crypto.randomBytes(8).toString('hex')}.source`;
    const outputFile = `${id}-${crypto.randomBytes(8).toString('hex')}.mp4`;
    const tmp = path.join(VIDEO_DIR, `.${sourceFile}.upload`);
    let size = 0;
    let prefix = Buffer.alloc(0);
    let validationError = null;
    const validate = new Transform({ transform(chunk, _encoding, callback) {
      if (validationError) return callback();
      size += chunk.length;
      if (size > MAX_EXERCISE_VIDEO) {
        validationError = Object.assign(new Error('Video exceeds the 90 MB upload limit.'), { status: 413 });
        return callback();
      }
      if (prefix.length < 64) prefix = Buffer.concat([prefix, chunk.subarray(0, 64 - prefix.length)]);
      callback(null, chunk);
    }});
    try {
      await pipeline(req, validate, fs.createWriteStream(tmp, { flags: 'wx', mode: 0o640 }));
      if (validationError) throw validationError;
      if (prefix.length < 12 || size < 12) throw Object.assign(new Error('The selected file is too small to be a video.'), { status: 415 });
      fs.renameSync(tmp, path.join(VIDEO_DIR, sourceFile));
      const job = { id: jobId, exerciseId: id, ...(ownerId ? { ownerId } : {}), actorId: actor.id, indexKey,
        name: name.trim(), sourceFile, outputFile, status: 'queued', error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      enqueueVideoJob(job);
      json(res, 202, { jobId, status: 'queued' });
    } catch (error) {
      fs.rmSync(tmp, { force: true });
      if (!res.headersSent) json(res, error.status || 400, { error: error.message || 'Could not save video.' });
    }
  },

  'DELETE /api/admin/exercise-video': async (req, res) => {
    const actor = readSession(req);
    if (!actor) return json(res, 401, { error: 'not signed in' });
    const admin = isAdmin(actor);
    const params = new URL(req.url, 'http://x').searchParams;
    const id = params.get('id') || '';
    if (!validExerciseId(id)) return json(res, 400, { error: 'valid exercise id required' });
    const requestedOwnerId = params.get('ownerId') || '';
    let ownerId = null;
    if (requestedOwnerId || !admin) {
      ownerId = requestedOwnerId || actor.id;
      if (!admin && (ownerId !== actor.id || !id.startsWith('c'))) return json(res, 403, { error: 'you can only remove videos from your own custom exercises' });
    }
    const videos = readExerciseVideoIndex();
    const indexKey = exerciseVideoKey(id, ownerId);
    const entry = videos[indexKey];
    if (!entry) return json(res, 404, { error: 'no video for this exercise' });
    if (entry.ownerId && !admin && entry.ownerId !== actor.id) return json(res, 403, { error: 'forbidden' });
    if (!entry.ownerId && !admin) return json(res, 403, { error: 'forbidden' });
    delete videos[indexKey];
    atomicWrite(exerciseVideoIndexFile, JSON.stringify(videos, null, 2));
    const file = exerciseVideoFile(entry.file);
    if (file) fs.rmSync(file, { force: true });
    json(res, 200, { ok: true });
  },

  'POST /api/push/subscribe': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    const sub = body.subscription;
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) return json(res, 400, { error: 'invalid subscription' });
    db.subs = db.subs.filter(s => s.endpoint !== sub.endpoint);
    db.subs.push({ userId: user.id, endpoint: sub.endpoint, keys: sub.keys, created: new Date().toISOString() });
    saveDb();
    json(res, 200, { ok: true });
  },

  'POST /api/push/unsubscribe': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    db.subs = db.subs.filter(s => !(s.userId === user.id && s.endpoint === body.endpoint));
    saveDb();
    json(res, 200, { ok: true });
  },

  'POST /api/push/test': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    await sendPush(user.id, { title: 'openGym', body: 'Test notification ✅ — this is what alerts look like.', tag: 'test' });
    json(res, 200, { ok: true });
  },

  'POST /api/push/rest-timer': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    const sec = Math.max(1, Math.min(3600, Math.round(+body.seconds || 0)));
    if (!sec) return json(res, 400, { error: 'seconds required' });
    scheduleRestTimer(user.id, sec);
    json(res, 200, { ok: true });
  },

  'POST /api/push/rest-timer/cancel': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    cancelRestTimer(user.id);
    json(res, 200, { ok: true });
  },

  // Live-workout heartbeat: client pings while a workout is on screen; { active:false } drops it.
  'POST /api/activity': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    if (body.active) {
      presence.set(user.id, {
        name: String(body.name || '').slice(0, 60),
        exIdx: +body.exIdx || 0, exTotal: +body.exTotal || 0,
        setsDone: +body.setsDone || 0, setsTotal: +body.setsTotal || 0,
        startedAt: +body.startedAt || Date.now(),
        updatedAt: Date.now()
      });
    } else presence.delete(user.id);
    json(res, 200, { ok: true });
  },

  /* ---------- admin dashboard ---------- */
  // One row per user, cheap enough for a personal instance (reads each state file once).
  'GET /api/admin/users': async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const users = db.users.map(u => {
      const S = readState(u.id) || {};
      const workouts = S.workouts || [];
      const last = workouts[workouts.length - 1];
      return {
        id: u.id, name: u.name, email: accountEmail(u.id), created: u.created || null,
        disabled: !!u.disabled, admin: isAdmin(u), invitedBy: u.invitedBy || null,
        authMethods: publicUser(u).authMethods,
        workouts: workouts.length,
        lastWorkout: last ? last.d : null,
        lastSync: S._ts || null,
        hasPush: db.subs.some(s => s.userId === u.id),
        live: livePresence(u.id)
      };
    });
    json(res, 200, { users, invite_only: INVITE_ONLY, now: Date.now() });
  },

  // Drill-down: full workout history + body-weight log for one user.
  'GET /api/admin/user': async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const id = new URL(req.url, 'http://x').searchParams.get('id');
    const u = db.users.find(x => x.id === id);
    if (!u) return json(res, 404, { error: 'no such user' });
    const S = readState(u.id) || {};
    const history = readAdminAudit().filter(row => row.targetUserId === u.id).slice(-30).reverse();
    json(res, 200, {
      user: { id: u.id, name: u.name, email: accountEmail(u.id), created: u.created || null, disabled: !!u.disabled, admin: isAdmin(u), invitedBy: u.invitedBy || null, authMethods: publicUser(u).authMethods },
      unit: S.unit || 'kg',
      lastSync: S._ts || null,
      rev: Number.isSafeInteger(S._rev) ? S._rev : 0,
      routines: (S.routines || []).map(r => ({ id: r.id, name: r.name, emoji: r.emoji, count: (r.ex || []).length })),
      bodyweight: S.bodyweight || [],
      workouts: (S.workouts || []).slice().reverse(),   // newest first for display
      state: S,
      audit: history
    });
  },

  'PUT /api/admin/user/data': async (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    const body = await readBody(req);
    const target = db.users.find(user => user.id === String(body.id || ''));
    if (!target) return json(res, 404, { error: 'no such user' });
    if (!body.state || typeof body.state !== 'object' || Array.isArray(body.state)) return json(res, 400, { error: 'state object required' });
    const file = stateFile(target.id);
    const current = readState(target.id) || {};
    const currentRev = Number.isSafeInteger(current._rev) ? current._rev : 0;
    if (body.expectedRev !== currentRev) return json(res, 409, { error: 'This profile changed after you opened it. Reload it and review the latest data before saving.', conflict: true, rev: currentRev });
    const next = body.state;
    delete next.active;                    // never expose or replace an in-progress workout
    next._rev = currentRev + 1;
    next._ts = Date.now();
    const changed = [...new Set([...Object.keys(current), ...Object.keys(next)])]
      .filter(key => key !== '_rev' && key !== '_ts' && JSON.stringify(current[key]) !== JSON.stringify(next[key]));
    atomicWrite(file, JSON.stringify(next));
    const audit = readAdminAudit();
    audit.push({ actorId: admin.id, actorName: admin.name, targetUserId: target.id, targetName: target.name, changed, at: new Date().toISOString() });
    atomicWrite(adminAuditFile, JSON.stringify(audit.slice(-5000)));
    json(res, 200, { ok: true, rev: next._rev, lastSync: next._ts, changed });
  },

  'POST /api/admin/user/disable': async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const body = await readBody(req);
    const u = db.users.find(x => x.id === body.id);
    if (!u) return json(res, 404, { error: 'no such user' });
    if (isAdmin(u)) return json(res, 400, { error: 'cannot disable an admin' });
    u.disabled = !!body.disabled;
    if (u.disabled) presence.delete(u.id);   // drop them off "training now" at once
    saveDb();
    json(res, 200, { ok: true, id: u.id, disabled: u.disabled });
  },

  'POST /api/admin/user/password-reset': async (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    if (!limitAuth(req, res, 'admin-password-reset', 5, 15 * 60 * 1000)) return;
    const body = await readBody(req);
    const user = db.users.find(u => u.id === body.id);
    if (!user) return json(res, 404, { error: 'no such user' });
    if (!db.passwords.some(p => p.userId === user.id)) return json(res, 400, { error: 'this profile has no password account' });
    const code = crypto.randomBytes(24).toString('base64url');
    db.passwordResets = db.passwordResets.filter(r => r.userId !== user.id);
    db.passwordResets.push({ userId: user.id, codeHash: crypto.createHash('sha256').update(code).digest('hex'), expires: Date.now() + 15 * 60 * 1000, createdBy: admin.id });
    saveDb();
    json(res, 200, { code, expiresIn: 900 });
  },

  'GET /api/admin/invites': async (req, res) => {
    if (!requireAdmin(req, res)) return;
    // resolve usedBy uid → name for display
    const invites = db.invites.map(i => ({
      ...i, usedByName: i.usedBy ? (db.users.find(u => u.id === i.usedBy) || {}).name || null : null
    }));
    json(res, 200, { invites, invite_only: INVITE_ONLY });
  },

  'POST /api/admin/invites/new': async (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    const body = await readBody(req);
    let code;
    // 16 hex chars = 64 bits, up from 8 chars / 32 bits. The app has no rate limiting by design
    // (that's the reverse proxy's job) and /api/register/options tells a caller whether a code is
    // good, so the code itself has to be the thing that isn't worth guessing. Codes already in
    // db.json keep working — validation is an exact string compare, never a length or format check.
    do { code = crypto.randomBytes(8).toString('hex').toUpperCase(); } while (db.invites.some(i => i.code === code));
    const invite = { code, note: String(body.note || '').slice(0, 60), createdBy: admin.id, created: new Date().toISOString() };
    db.invites.push(invite);
    saveDb();
    json(res, 200, { invite });
  },

  'POST /api/admin/invites/revoke': async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const body = await readBody(req);
    const inv = db.invites.find(i => i.code === String(body.code || '').toUpperCase());
    if (!inv) return json(res, 404, { error: 'no such code' });
    if (inv.usedBy) return json(res, 400, { error: 'already used — cannot revoke' });
    db.invites = db.invites.filter(i => i.code !== inv.code);
    saveDb();
    json(res, 200, { ok: true });
  }
};

http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (origin && APP_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Exercise-Id, X-Exercise-Name, X-Exercise-Owner');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, 'http://x');
  const key = req.method + ' ' + url.pathname;
  const handler = routes[key];
  if (!handler) return json(res, 404, { error: 'not found' });
  try { await handler(req, res); }
  catch (e) {
    console.error(key, e);
    if (!res.headersSent) json(res, 500, { error: 'server error' });
  }
}).listen(PORT, () => console.log(`gym-api on :${PORT} (rpID=${RP_ID}, origin=${ORIGIN})`));
