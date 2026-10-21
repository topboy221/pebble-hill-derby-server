// Soapcube Racing — multiplayer server
// One Node process: serves the game page, signs players in (as a guest, or with their Supabase account),
// lobbies (up to 12 racers, or 50 in Survival; public quick-join or password-protected private servers),
// relays car positions during races, collects results and runs the next-track vote.
// Accounts, emails, saved progress and money live in Supabase; purchases come in from RevenueCat (/hooks/revenuecat).
// After each online race this server pays the signed-in racers their cash prize (the game itself can't).
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = +process.env.PORT || 8080;
// the game page: public/pebble-hill-derby.html (an older public/index.html still works as a fallback)
const GAME_FILE = ['pebble-hill-derby.html', 'index.html'].map(f => path.join(__dirname, 'public', f)).find(f => fs.existsSync(f)) || path.join(__dirname, 'public', 'pebble-hill-derby.html');
const TRACK_IDS = ['pebble', 'city', 'nomahe', 'tokiyama', 'whitecow', 'aloma', 'mesozon'];           // keep in sync with TRACKS in the game
const MAX_PLAYERS = 12;                           // a normal race
const SURV_PLAYERS = 50;                          // Survival: 50 cars, AI fills whatever the humans don't
const SURV_MIN = 13;                              // ...and needs at least 13 cars (players + AI) to start: prizes are shared by the field size
const TIMES = {                                   // seconds
  readyWait: 15,         // countdown once more than half the players (or the host) are ready
  loadTimeout: 25,       // waiting for everyone to build the track
  countdown: 3.6,        // matches the in-game 3-2-1
  afterFirst: 60,        // others get this long after the winner crosses the line
  maxRace: 8 * 60,
  vote: 20,              // the next-track vote closes 20 s after the first vote (or as soon as everyone has voted)
  voteIdle: 60,          // nobody votes at all: a random one of the three after this long
  afterVote: 3,
};
if (process.env.PHD_FAST) Object.assign(TIMES, { readyWait: 3, vote: 20, voteIdle: 30, afterVote: 2, afterFirst: 15 });   // for automated tests
const SNAP_MS = 50;                               // 20 position updates a second
const RACE_IDLE_MS = 10000;                       // a racer whose car hasn't reported in this long (app switched away, phone locked, gone) is taken out of the race

/* ---------------- Supabase (accounts) ---------------- */
// The game signs players in with Supabase itself; this server only asks Supabase who a player is (their racer name).
// Settings (Render → Environment):
//   SUPABASE_URL              https://<project>.supabase.co
//   SUPABASE_PUBLISHABLE_KEY  the publishable (or legacy anon) key: the same one that's in the game
//   SUPABASE_SECRET_KEY       the secret (or legacy service_role) key: for recording purchases and paying online race prizes.
//                             Never put it in the game.
const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || '';
const SB_SECRET = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
async function sbWho(token) {   // a player's access token -> {id, name}, or null if it isn't valid (any more)
  const h = { apikey: SB_KEY, Authorization: 'Bearer ' + token };
  const u = await fetch(SB_URL + '/auth/v1/user', { headers: h, signal: AbortSignal.timeout(8000) });
  if (u.status === 401 || u.status === 403 || u.status === 404) return null;
  if (!u.ok) throw new Error('auth ' + u.status);
  const user = await u.json(); if (!user || !user.id) return null;
  const p = await fetch(SB_URL + '/rest/v1/rpc/get_profile', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, h), body: '{}', signal: AbortSignal.timeout(8000) });
  if (!p.ok) throw new Error('profile ' + p.status + ' ' + (await p.text()).slice(0, 200));
  const prof = await p.json();
  return prof && prof.racer_name ? { id: user.id, name: String(prof.racer_name), custom: Array.isArray(prof.perks) && prof.perks.includes('custom') } : null;
}
// private-server passwords
function hashPass(pass, salt) { return crypto.scryptSync(pass, salt, 64).toString('hex'); }
function checkPass(pass, salt, hash) {
  const a = Buffer.from(hashPass(pass, salt), 'hex'), b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ---------------- names ---------------- */
const ADJ = ['Zippy', 'Rusty', 'Turbo', 'Lucky', 'Swift', 'Mighty', 'Sneaky', 'Jolly', 'Brave', 'Sunny', 'Dusty', 'Nifty', 'Bouncy', 'Gritty', 'Plucky', 'Speedy'];
const ANIMAL = ['Otter', 'Badger', 'Falcon', 'Gecko', 'Panda', 'Moose', 'Ferret', 'Lynx', 'Koala', 'Beaver', 'Heron', 'Marmot', 'Puffin', 'Wombat', 'Yak', 'Hare'];
const online = new Map();                         // lower-case name -> client
function guestName() {
  for (let k = 0; k < 200; k++) {
    const n = ADJ[Math.random() * ADJ.length | 0] + ANIMAL[Math.random() * ANIMAL.length | 0] + (10 + (Math.random() * 90 | 0));
    const key = n.toLowerCase();
    if (!online.has(key)) return n;
  }
  return 'Racer' + crypto.randomBytes(3).toString('hex');
}
/* ---------------- rate limit (sign-in tries, private-server passwords) ---------------- */
const attempts = new Map();                       // ip -> [timestamps]
function limited(ip) {
  const now = Date.now(), arr = (attempts.get(ip) || []).filter(t => now - t < 5 * 60e3);
  attempts.set(ip, arr);
  return arr.length >= 12;
}
function failed(ip) { const arr = attempts.get(ip) || []; arr.push(Date.now()); attempts.set(ip, arr); }
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const sameHash = (a, b) => a && b && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

/* ---------------- lobbies ---------------- */
const lobbies = new Map();                        // id -> lobby
const code = () => { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s = ''; for (let i = 0; i < 5; i++) s += A[Math.random() * A.length | 0]; return lobbies.has(s) ? code() : s; };
const pick = (a) => a[Math.random() * a.length | 0];
function clean(str, max) { return String(str || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max); }

// AI fill: the host can let computer drivers take every free grid slot. Each lobby keeps its own set of 11 so they look the same race to race.
// They're driven by the host's game (sent to everyone like a player) and a human always takes priority: whoever joins bumps one off the grid.
const BOT_NAMES = ['Momo', 'Bram', 'Tilly', 'Kenji', 'Rosa', 'Lars', 'Ines', 'Dario', 'Yuki', 'Olek', 'Maya',
  ...'Nico Ada Theo Lina Otto Zara Finn Ivy Hugo Nora Axel Mila Remy Suki Joel Pia Ravi Elsa Tomas Wren Aiko Bo Cleo Diego Esme Felix Greta Hal Iris Jonah Kaia Leon Mira Nils Opal Pavel Quinn Rhea'.split(' ')];
const BOT_PAINTS = ['#f2c230', '#1f5fd6', '#f0f0ea', '#1f8a4c', '#ef6a1a', '#aeb5bf', '#0f2e5a', '#6a1b24', '#7fbf3a', '#3b3f47', '#c8231f'];
function hsl2hex(h, s, l) { const f = n => { const k = (n + h * 12) % 12, a = s * Math.min(l, 1 - l), c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); return Math.round(c * 255).toString(16).padStart(2, '0'); }; return '#' + f(0) + f(8) + f(4); }
function makeBots(n) { return BOT_NAMES.slice(0, n).map((nm, k) => ({ name: nm, car: { design: (k * 5 + 1) % 25, paint: k < BOT_PAINTS.length ? BOT_PAINTS[k] : hsl2hex((k * 0.61803) % 1, 0.6, 0.45), rim: (k * 7) % 6, fin: (k * 3) % 6, rs: 15 + (k * 3) % 6 } }   /* any of the 25 pack bodies */)); }
const botsFor = (L, humans) => L.bots ? L.botPool.slice(0, Math.max(0, L.max - humans)) : [];
// the tracks the player starting a lobby has unlocked in Career: the first race is one of these (later races: the vote, any track)
const validPool = p => { const a = Array.isArray(p) ? [...new Set(p.filter(t => TRACK_IDS.includes(t)))] : []; return a.length ? a : null; };
function makeLobby(opts) {
  const surv = opts.mode === 'survival', max = surv ? SURV_PLAYERS : MAX_PLAYERS;
  const L = {
    id: code(), name: opts.name, private: !!opts.pass, salt: null, hash: null,
    host: null, state: 'lobby', players: [], track: null, nextTrack: null, races: 0, pool: validPool(opts.pool) || TRACK_IDS.slice(),
    timer: null, timerEnds: 0, race: null, vote: null, created: Date.now(), mode: surv ? 'survival' : 'normal', max, bots: surv, botPool: makeBots(max - 1),
  };
  if (opts.pass) { L.salt = crypto.randomBytes(12).toString('hex'); L.hash = hashPass(opts.pass, L.salt); }
  lobbies.set(L.id, L);
  return L;
}
function lobbyInfo(L) {
  return {
    id: L.id, name: L.name, locked: L.private, host: L.host, state: L.state, track: L.nextTrack || null, first: !L.races,
    countdown: L.timer ? Math.max(0, Math.ceil((L.timerEnds - Date.now()) / 1000)) : null,
    players: L.players.map(c => ({ id: c.id, name: c.name, guest: c.guest, car: c.car, ready: !!c.ready, racing: !!(L.race && L.race.racers.has(c.id)), away: !!c.away })),
    running: (L.state === 'loading' || L.state === 'race') && L.race ? L.race.track : null,   // a race on now (track): who isn't in it waits for the next one
    max: L.max, mode: L.mode, min: L.mode === 'survival' ? SURV_MIN : 0, bots: !!L.bots, botList: botsFor(L, L.players.length).map(b => ({ name: b.name, paint: b.car.paint })),
  };
}
const LAG = +process.env.PHD_LAG || 0;            // test only: fake network delay (ms each way)
const wsend = (ws, str) => { if (LAG) setTimeout(() => { if (ws.readyState === 1) ws.send(str); }, LAG); else ws.send(str); };
function send(c, msg) { if (c.ws.readyState === 1) wsend(c.ws, JSON.stringify(msg)); }
function broadcast(L, msg, except) { const s = JSON.stringify(msg); for (const c of L.players) if (c !== except && c.ws.readyState === 1) wsend(c.ws, s); }
function pushLobby(L) { const info = lobbyInfo(L); for (const c of L.players) send(c, { t: 'lobby', lobby: info, you: c.id }); }
function setTimer(L, secs, fn) { clearTimeout(L.timer); L.timerEnds = Date.now() + secs * 1000; L.timer = setTimeout(() => { L.timer = null; fn(); }, secs * 1000); }
function clearTimer(L) { clearTimeout(L.timer); L.timer = null; }

// ready check: the countdown runs while more than half of the players in the lobby are ready, or the host is.
// Someone un-readying (or joining) so that's no longer true stops it. A quick-join lobby needs 2 people unless AI cars fill the grid.
const survShort = L => L.mode === 'survival' && L.players.length + botsFor(L, L.players.length).length < SURV_MIN;
function readyToGo(L) {
  const n = L.players.length; if (!n) return false;
  if (survShort(L)) return false;
  if (!L.private && !L.bots && n < 2) return false;
  const host = L.players.find(p => p.id === L.host), rdy = L.players.filter(p => p.ready).length;
  return !!(host && host.ready) || rdy * 2 > n;
}
function checkAutoStart(L) {
  if (L.state !== 'lobby') return;
  if (readyToGo(L)) { if (!L.timer) { setTimer(L, TIMES.readyWait, () => startRace(L)); pushLobby(L); } }
  else if (L.timer) { clearTimer(L); pushLobby(L); }
}

function joinLobby(c, L) {
  if (c.lobby === L) return;
  if (c.lobby) leaveLobby(c);
  if (L.players.length >= L.max) return send(c, { t: 'error', where: 'join', msg: 'That server is full (' + L.max + '/' + L.max + ').' });
  L.players.push(c); c.lobby = L; c.ready = false;
  if (!L.host) L.host = c.id;
  pushLobby(L);
  // (a race running: the lobby info says so, and the game shows "Race in progress … you'll be on the grid for the next one")
  if (L.state === 'results' && L.vote) send(c, { t: 'results', rows: L.lastRows || [], vote: voteInfo(L) });
  checkAutoStart(L);
}
function leaveLobby(c) {
  const L = c.lobby; if (!L) return;
  L.players = L.players.filter(p => p !== c); c.lobby = null; c.ready = false;
  if (L.race && L.race.racers.has(c.id)) {
    const r = L.race.racers.get(c.id);
    if (r.fin && L.state === 'race') r.left = true;                    // already over the line: stays in the results (and was paid)
    else L.race.racers.delete(c.id);
    L.race.states.delete(c.id); L.race.loaded.delete(c.id);
    broadcast(L, { t: 'gone', id: c.id });
    if (L.race.botHost === c.id && !handBots(L)) dropBots(L, true);    // their game was driving the AI cars: another racer's game takes them over
    if (L.state === 'loading') maybeGo(L); else if (L.state === 'race') maybeEnd(L);
  }
  if (L.vote) { L.vote.ballots.delete(c.id); voteDone(L); if (L.vote) broadcast(L, { t: 'votes', vote: voteInfo(L) }); }
  if (!L.players.length) { clearTimer(L); clearInterval(L.race && L.race.snapTimer); clearInterval(L.race && L.race.idleTimer); lobbies.delete(L.id); return; }
  if (L.host === c.id) L.host = L.players[0].id;
  if (L.state === 'lobby') checkAutoStart(L);
  pushLobby(L);
}

/* ---------------- race flow ---------------- */
function startRace(L) {
  if (L.state !== 'lobby' && L.state !== 'results') return;
  if (!L.players.length) return;
  clearTimer(L); L.vote = null;
  if (survShort(L)) { L.state = 'lobby'; pushLobby(L); return; }   // too few cars for Survival (AI switched off): wait in the lobby
  const track = L.nextTrack || pick(L.races ? TRACK_IDS : L.pool); L.nextTrack = null; L.track = track; L.races++;
  // someone's connection has gone quiet (phone locked, network switch): drop them if it's been long,
  // otherwise hold the start a moment so their phone can reconnect and keep its seat
  const now0 = Date.now();
  for (const p of L.players.slice()) if (now0 - p.lastSeen > STALE_MS) { try { p.ws.terminate(); } catch (e) {} leaveLobby(p); }
  if (!L.players.length) return;
  if (L.players.some(p => now0 - p.lastSeen > 4500) && (L.holds = (L.holds || 0) + 1) <= 6) { setTimer(L, 1.5, () => startRace(L)); pushLobby(L); return; }
  L.holds = 0;
  // a player watching an ad (or with the app in the background) sits this race out: they stay in the lobby and race the next one
  // (an "away" older than 90 s is ignored, in case the game never said it was back)
  const away = p => p.away && Date.now() - p.awayAt < 90e3;
  const racers = L.players.filter(p => !away(p)).slice(0, L.max);
  if (!racers.length) { L.state = 'lobby'; setTimer(L, 3, () => startRace(L)); pushLobby(L); return; }   // everyone's away: try again in a moment
  for (const c of racers) c.ready = false;
  const bots = botsFor(L, racers.length).map((b, k) => ({ id: -(k + 1), name: b.name, car: b.car, bot: true }));
  const grid = {}, shuffle = a => a.sort(() => Math.random() - 0.5);
  if (L.mode === 'survival') {                         // Survival: the humans start at the very back, behind every AI car
    const n = racers.length + bots.length, back = shuffle([...Array(racers.length).keys()].map(i => n - 1 - i)), front = shuffle([...Array(bots.length).keys()]);
    racers.forEach((c, i) => { grid[c.id] = back[i]; }); bots.forEach((b, k) => { grid[b.id] = front[k]; });
  } else {
    const slots = shuffle([...Array(L.max).keys()]);   // random grid
    racers.forEach((c, i) => { grid[c.id] = slots[i]; }); bots.forEach((b, k) => { grid[b.id] = slots[racers.length + k]; });
  }
  L.race = {
    track, grid, racers: new Map(racers.map(c => [c.id, { id: c.id, name: c.name, guest: c.guest, key: c.key, car: c.car, fin: null, lastS: 0 }])),
    rid: L.id + '-' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'),   // names this race when paying prizes (each one is paid once)
    loaded: new Set(), states: new Map(), dirty: new Set(), start: 0, firstFin: 0, snapTimer: null, endTimer: null, botHost: bots.length ? L.host : null,
  };
  for (const b of bots) L.race.racers.set(b.id, { id: b.id, name: b.name, guest: false, bot: true, car: b.car, fin: null, lastS: 0 });
  L.state = 'loading';
  const roster = [...L.race.racers.values()].map(r => ({ id: r.id, name: r.name, guest: r.guest, car: r.car, slot: grid[r.id], bot: !!r.bot }));
  L.race.obs = Math.round((300 + Math.random() * 3300) * 1000) / 1000;   // where the obstacles start their cycles: the same for everyone, new each race
  for (const c of racers) send(c, { t: 'race', track, roster, you: c.id, botHost: L.race.botHost, mode: L.mode, obs: L.race.obs });
  setTimer(L, TIMES.loadTimeout, () => go(L));
  const chk = setInterval(() => { if (L.state !== 'loading') return clearInterval(chk); maybeGo(L); }, 1000);
  pushLobby(L);
}
function maybeGo(L) {
  if (L.state !== 'loading') return;
  if (!L.race.racers.size) return backToLobby(L);
  const now = Date.now();
  for (const [id, r] of L.race.racers) {
    if (r.bot || L.race.loaded.has(id)) continue;
    const p = L.players.find(x => x.id === id);
    if (p && now - p.lastSeen < STALE_MS) return;          // still loading: wait for them (a silent connection isn't waited for)
  }
  go(L);
}
function go(L) {
  if (L.state !== 'loading') return;
  clearTimer(L);
  for (const [id, r] of L.race.racers) if (!r.bot && !L.race.loaded.has(id)) r.dnf = true;   // never loaded: sits this one out
  if (L.race.botHost != null && !L.race.loaded.has(L.race.botHost)) dropBots(L);              // the AI drivers' host never made it: no AI this race
  // everyone gets the same start moment on the server clock (plus a little slack for delivery), so all countdowns hit GO together
  const now = Date.now();
  L.state = 'race'; L.race.start = now + TIMES.countdown * 1000 + 700;
  L.race.field = L.race.racers.size;                                // the field size prizes are worked out for (fixed at the start)
  for (const c of L.players) if (L.race.racers.has(c.id)) send(c, { t: 'go', countdown: TIMES.countdown, startAt: L.race.start, now });
  L.race.snapTimer = setInterval(() => snap(L), SNAP_MS);
  L.race.idleTimer = setInterval(() => checkIdle(L), 1000);
  L.race.endTimer = setTimeout(() => endRace(L), (TIMES.countdown + TIMES.maxRace) * 1000);
  pushLobby(L);
}
function snap(L) {
  if (!L.race || !L.race.dirty.size) return;
  // only cars with a new update since the last snap (an unchanged one would be skipped by every game anyway): halves the AI traffic in Survival
  const cars = []; for (const id of L.race.dirty) { const s = L.race.states.get(id); if (s) cars.push([id, ...s]); } L.race.dirty.clear();
  if (!cars.length) return;
  const msg = JSON.stringify({ t: 'snap', cars });
  for (const c of L.players) if (L.race.racers.has(c.id) && c.ws.readyState === 1) wsend(c.ws, msg);
}
// inactivity kick: no position from a racer for RACE_IDLE_MS (counted from GO) -> out of this race (DNF). They stay in the
// lobby for the next race; everyone else's game removes the car, and the race no longer waits for them to finish
function checkIdle(L) {
  if (L.state !== 'race' || !L.race) return clearInterval(L.race && L.race.idleTimer);
  const now = Date.now(); if (now < L.race.start) return;
  if (L.race.botHost != null) { const h = L.players.find(p => p.id === L.race.botHost);   // the AI cars' driver has gone quiet: someone else drives them
    if (h && now - h.lastSeen > 5000) handBots(L); }
  for (const r of L.race.racers.values()) {
    if (r.fin || r.dnf) continue;
    if (now - Math.max(r.lastSt || 0, L.race.start) < RACE_IDLE_MS) continue;
    r.dnf = true; r.idle = true; L.race.states.delete(r.id);
    if (process.env.PHD_DEBUG) console.log('idle kick', r.name);
    broadcast(L, { t: 'gone', id: r.id });
    const p = L.players.find(x => x.id === r.id); if (p) send(p, { t: 'out', msg: 'You were taken out of the race: no signal from your game for ' + Math.round(RACE_IDLE_MS / 1000) + ' s.' });
  }
  maybeEnd(L);
}
// the AI cars are driven by one racer's game (the "bot host"). If that racer leaves, goes silent, or goes away (an ad, the app in
// the background), another racer's game takes them over where they are, so they don't vanish: someone still out on the course
// first (their game is surely running), then someone who has finished. No one left to drive them: they're dropped.
function handBots(L, not) {
  if (!L.race || L.race.botHost == null) return false;
  const now = Date.now(), r = L.race;
  const ok = p => p.id !== not && p.id !== r.botHost && r.racers.has(p.id) && !r.racers.get(p.id).dnf && (L.state !== 'race' || r.loaded.has(p.id))
    && now - p.lastSeen < 5000 && !(p.away && now - p.awayAt < 90e3);
  const c = L.players.filter(ok).sort((a, b) => (r.racers.get(a.id).fin ? 1 : 0) - (r.racers.get(b.id).fin ? 1 : 0))[0];
  if (!c) return false;
  r.botHost = c.id;
  for (const b of r.racers.values()) if (b.bot && !b.fin && !b.dnf) b.lastSt = now;   // (a moment for the new host to pick them up)
  broadcast(L, { t: 'bothost', id: c.id });
  return true;
}
function dropBots(L, tell) {
  if (!L.race) return;
  for (const r of L.race.racers.values()) if (r.bot && !r.fin && !r.dnf) { r.dnf = true; L.race.states.delete(r.id); if (tell) broadcast(L, { t: 'gone', id: r.id }); }
}
function onBotStates(c, list) {
  const L = c.lobby; if (!L || L.state !== 'race' || L.race.botHost !== c.id || !Array.isArray(list) || list.length > L.max) return;
  const now = Date.now();
  for (const e of list) {
    if (!Array.isArray(e) || e.length !== 15) continue;
    const r = L.race.racers.get(e[0]); if (!r || !r.bot || r.dnf) continue;
    const a = e.slice(1); if (!a.every(v => typeof v === 'number' && isFinite(v))) continue;
    r.lastSt = now; if (!r.fin) r.lastS = a[7];
    L.race.states.set(r.id, a); L.race.dirty.add(r.id);
  }
}
function onState(c, a) {
  const L = c.lobby; if (!L || L.state !== 'race' || !L.race.racers.has(c.id)) return;
  if (!Array.isArray(a) || (a.length !== 13 && a.length !== 14) || !a.every(v => typeof v === 'number' && isFinite(v))) return;
  const r = L.race.racers.get(c.id); if (r.dnf) return;                 // taken out of this race: no longer shown to anyone
  r.lastSt = Date.now();
  L.race.dirty.add(c.id);
  if (r.fin) { L.race.states.set(c.id, a); return; }
  r.lastS = a[7];
  L.race.states.set(c.id, a);
}
function onFinish(c, time, bot) {
  const L = c.lobby; if (!L || L.state !== 'race') return;
  if (bot != null && L.race.botHost !== c.id) return;                        // only the host's game reports its AI drivers
  const r = L.race.racers.get(bot != null ? bot : c.id); if (!r || r.fin || r.dnf || (bot != null && !r.bot)) return;
  const elapsed = (Date.now() - L.race.start) / 1000;
  let t = +time;
  if (!process.env.PHD_FAST) {                                                   // (automated tests fast-forward the clock)
    if (!isFinite(t) || Math.abs(t - elapsed) > 3) t = elapsed;                  // trust the client's clock only within 3 s of ours
    if (t < 20) return;                                                          // impossible time: ignore
  } else if (!isFinite(t)) t = elapsed;
  // finishing order is the order the server hears about it; a time can't come out faster than someone who crossed earlier
  const prev = [...L.race.racers.values()].filter(x => x.fin);
  t = Math.max(t, ...prev.map(x => x.fin));
  r.fin = t; r.ord = prev.length + 1;
  if (!L.race.firstFin) { L.race.firstFin = Date.now(); clearTimeout(L.race.endTimer); L.race.endTimer = setTimeout(() => endRace(L), TIMES.afterFirst * 1000); }
  const place = r.ord;
  broadcast(L, { t: 'fin', id: r.id, time: t, place });
  payPrize(L, r, place, true);                                   // your place can't change any more: you're paid right away
  maybeEnd(L);
}
function maybeEnd(L) {
  if (L.state !== 'race') return;
  const left = [...L.race.racers.values()].filter(r => !r.fin && !r.dnf && !r.bot);
  if (!left.length) endRace(L);
}
function endRace(L) {
  if (L.state !== 'race') return;
  clearInterval(L.race.snapTimer); clearInterval(L.race.idleTimer); clearTimeout(L.race.endTimer);
  const rows = [...L.race.racers.values()]
    .sort((a, b) => (a.fin && b.fin) ? a.ord - b.ord : a.fin ? -1 : b.fin ? 1 : b.lastS - a.lastS)
    .map((r, i) => ({ id: r.id, name: r.name, guest: r.guest, bot: !!r.bot, paint: r.car && r.car.paint, time: r.fin || null, place: i + 1 }));
  L.lastRows = rows;
  L.state = 'results';
  const opts = TRACK_IDS.slice().sort(() => Math.random() - 0.5).slice(0, Math.min(3, TRACK_IDS.length));   // three tracks to vote on
  L.vote = { options: opts, ballots: new Map(), ends: 0 };          // the 20 s clock starts with the first vote
  setTimer(L, TIMES.voteIdle, () => closeVote(L));
  broadcast(L, { t: 'results', rows, vote: voteInfo(L) });
  payPrizes(L, rows);
  pushLobby(L);
}
// cash prizes: every signed-in racer who took part (not guests, AI, or anyone taken out for going silent) gets paid by the
// database for their place in a field of this many cars, and is told their winnings and new balance. Finishers are paid the
// moment they cross the line (so leaving early loses nothing); anyone still out on the course when the race ends, then.
function payPrizes(L, rows) {
  if (!L.race) return;
  for (const row of rows) { const r = L.race.racers.get(row.id); if (r && !r.paid) payPrize(L, r, row.place, !!r.fin); }
}
function payPrize(L, r, place, finished) {
  const race = L.race; if (!SB_URL || !SB_SECRET || !race || r.paid || r.bot || r.guest || !r.key || r.dnf) return;
  const cars = Math.max(race.field || race.racers.size, place); if (cars < 2) return;
  r.paid = true;
  fetch(SB_URL + '/rest/v1/rpc/award_online_race', { method: 'POST', signal: AbortSignal.timeout(15000),
    headers: { apikey: SB_SECRET, Authorization: 'Bearer ' + SB_SECRET, 'Content-Type': 'application/json' },
    body: JSON.stringify({ player: r.key, race: race.rid, place, cars, finished, track: race.track, mode: L.mode }) })
    .then(async res => {
      const txt = await res.text(); if (!res.ok) throw new Error(res.status + ' ' + txt.slice(0, 200));
      const out = JSON.parse(txt || '{}');
      // tell the player, wherever they are now (still in the race, in the lobby, or back in the menus on a new connection)
      const c = [...clients].find(o => o.key === r.key && o.ws.readyState === 1);
      if (c) send(c, { t: 'wallet', earned: out.earned || 0, cash: out.cash, gold: out.gold, place, cars, race: race.rid });
    })
    .catch(e => console.error('[prizes] ' + r.name + ': ' + e.message));
}
function voteInfo(L) {
  const V = L.vote; if (!V) return null;
  const counts = V.options.map(o => [...V.ballots.values()].filter(b => b === o).length);
  return { options: V.options, counts, started: !!V.ends, secs: V.ends ? Math.max(0, Math.ceil((V.ends - Date.now()) / 1000)) : null };
}
// a vote for one of the three tracks, or track null to take your vote back
function onVote(c, track) {
  const L = c.lobby; if (!L || L.state !== 'results' || !L.vote) return;
  const V = L.vote;
  if (track == null) V.ballots.delete(c.id);
  else if (V.options.includes(track)) V.ballots.set(c.id, track);
  else return;
  if (!V.ends && V.ballots.size) { V.ends = Date.now() + TIMES.vote * 1000; setTimer(L, TIMES.vote, () => closeVote(L)); }
  broadcast(L, { t: 'votes', vote: voteInfo(L) });
  voteDone(L);
}
function voteDone(L) {   // everyone in the lobby has voted: no need to wait
  if (L.state === 'results' && L.vote && L.vote.ballots.size && L.players.every(p => L.vote.ballots.has(p.id))) closeVote(L);
}
function closeVote(L) {
  if (L.state !== 'results' || !L.vote) return;
  clearTimer(L);
  const vi = voteInfo(L), best = Math.max(...vi.counts);
  const winners = vi.options.filter((o, i) => vi.counts[i] === best);
  const winner = pick(winners);                                         // tie: coin flip
  L.nextTrack = winner; L.vote = null;
  broadcast(L, { t: 'voted', track: winner, counts: vi.counts, options: vi.options });
  L.state = 'lobby'; L.race = null;
  checkAutoStart(L);                                                    // everyone readies up again for the next race
  pushLobby(L);
}
function backToLobby(L) { clearTimer(L); if (L.race) { clearInterval(L.race.snapTimer); clearInterval(L.race.idleTimer); clearTimeout(L.race.endTimer); } L.race = null; L.state = 'lobby'; checkAutoStart(L); pushLobby(L); }

/* ---------------- messages ---------------- */
// without the garage's custom unlock (150 gold) a car only gets the standard paints, rim finishes, rim size and stance
const STD_PAINTS = ['#f0f0ea', '#aeb5bf', '#1d1e24', '#c8231f', '#1f5fd6'];
const RIM_FIN_HEX = ['#c4c9d0', '#4b5059', '#1d1e23', '#c9a24a', '#eeeeea', '#8a5a33'];
function hexDist(a, b) { const x = parseInt(a.slice(1), 16), y = parseInt(b.slice(1), 16); return ((x >> 16 & 255) - (y >> 16 & 255)) ** 2 + ((x >> 8 & 255) - (y >> 8 & 255)) ** 2 + ((x & 255) - (y & 255)) ** 2; }
const nearest = (hex, list) => list.reduce((bi, h, i) => hexDist(h, hex) < hexDist(list[bi], hex) ? i : bi, 0);
function validCar(o, custom) {
  if (!o || typeof o !== 'object') return null;
  const car = validCarAny(o);
  if (custom) return car;
  if (!STD_PAINTS.includes(car.paint.toLowerCase())) car.paint = STD_PAINTS[nearest(car.paint, STD_PAINTS)];
  if (typeof car.fin === 'string') car.fin = nearest(car.fin, RIM_FIN_HEX);
  car.rs = 18; car.off = 0; car.rh = 0; car.acc = null; if (car.rim >= 4) car.rim = 0;   // (wheel designs 5+ come with the unlock too)
  return car;
}
function validCarAny(o) {
  const i = (v, m) => Number.isInteger(v) && v >= 0 && v < m ? v : 0;
  // fin: a standard rim finish (index) or, for players, any rim colour ('#rrggbb'); AI cars only ever get the standard ones
  return { design: i(o.design, 32), paint: /^#[0-9a-f]{6}$/i.test(o.paint) ? o.paint : '#c8231f', rim: i(o.rim, 32), fin: /^#[0-9a-f]{6}$/i.test(o.fin) ? o.fin.toLowerCase() : i(o.fin, 32), rs: Number.isInteger(o.rs) && o.rs >= 13 && o.rs <= 22 ? o.rs : 18, off: Number.isInteger(o.off) && o.off >= 0 && o.off <= 16 ? o.off : 0, rh: Number.isInteger(o.rh) && Math.abs(o.rh) <= 3 ? o.rh : 0, acc: /^#[0-9a-f]{6}$/i.test(o.acc) ? o.acc.toLowerCase() : null };   // acc: graphics colour (null = the car's own)   // rs: rim size in inches
}
function authed(c, name, guest, uid) {
  const key = name.toLowerCase();
  c.key = guest ? null : (uid || null);            // the Supabase user id of a signed-in player
  const prev = online.get(key);
  if (prev && prev !== c) { send(prev, { t: 'kicked', msg: 'Signed in somewhere else.' }); leaveLobby(prev); prev.name = null; prev.ws.close(); }
  if (c.name && online.get(c.name.toLowerCase()) === c) online.delete(c.name.toLowerCase());
  c.name = name; c.guest = guest; online.set(key, c);
  if (!c.sid) c.sid = crypto.randomBytes(12).toString('hex');       // lets this player take their seat back after a dropped connection
  send(c, { t: 'auth', name, guest, sid: c.sid, uid: c.key });
  if (c.lobby) pushLobby(c.lobby);                  // (a new racer name shows up in the lobby straight away)
}
// players whose connection dropped (phone locked, network switch): their name + lobby are kept for a while so they can rejoin
const parked = new Map();                          // sid -> {name, guest, car, lobbyId, until}
const PARK_MS = 3 * 60e3;
function rejoin(c, sid) {
  sid = String(sid || '');
  // the old connection may still look alive here (it died silently): take the seat over from it right away
  for (const o of clients) if (o !== c && o.sid === sid && o.name) {
    parked.set(sid, { name: o.name, key: o.key, guest: o.guest, custom: o.custom, car: o.car, lobbyId: o.lobby && o.lobby.id, until: Date.now() + PARK_MS });
    leaveLobby(o); if (online.get(o.name.toLowerCase()) === o) online.delete(o.name.toLowerCase());
    o.sid = null; o.name = null; try { o.ws.terminate(); } catch (e) {}
  }
  const P = parked.get(sid); parked.delete(sid);
  if (!P || P.until < Date.now()) return send(c, { t: 'error', where: 'rejoin', msg: 'Session over.' });
  c.sid = sid; c.custom = !!P.custom; c.car = P.car || c.car;
  if (P.guest && online.has(P.name.toLowerCase())) return send(c, { t: 'error', where: 'rejoin', msg: 'Name in use.' });
  authed(c, P.name, P.guest, P.key);
  const L = P.lobbyId && lobbies.get(P.lobbyId);
  if (L && L.players.length < L.max) joinLobby(c, L);
}
function handle(c, m) {
  switch (m.t) {
    case 'hello': return send(c, { t: 'welcome', tracks: TRACK_IDS, max: MAX_PLAYERS });
    case 'ping': return send(c, { t: 'pong', c: +m.c || 0, s: Date.now() });   // round-trip time + server clock, for syncing
    case 'guest': if (c.lobby) return; return authed(c, guestName(), true);
    case 'rejoin': if (c.name) return; return rejoin(c, m.sid);
    case 'sb': {   // sign in with a Supabase account: the game sends its access token, Supabase tells us who that is
      if (!SB_URL || !SB_KEY) return send(c, { t: 'error', where: 'auth', msg: 'Accounts aren\'t switched on for this server yet. Race as a guest for now.' });
      if (limited(c.ip)) return send(c, { t: 'error', where: 'auth', msg: 'Too many tries. Wait a few minutes.' });
      const token = String(m.token || ''); if (!token || token.length > 8192) return;
      sbWho(token).then(who => {
        if (c.ws.readyState !== 1) return;
        if (!who) { failed(c.ip); return send(c, { t: 'error', where: 'sb', msg: 'Your sign-in has expired. Sign in again.' }); }
        c.custom = !!who.custom; c.car = validCar(c.car, c.custom);
        authed(c, who.name, false, who.id);
      }).catch(e => {
        console.error('[supabase] ' + e.message);
        send(c, { t: 'error', where: 'auth', msg: 'The account server didn\'t answer. Try again, or race as a guest.' });
      });
      return;
    }
    case 'perks': {   // the player just unlocked something in the garage: check it with the database, then take their new car look
      const token = String(m.token || ''); if (!c.key || !token || token.length > 8192 || !SB_URL || !SB_KEY) return;
      sbWho(token).then(who => {
        if (!who || who.id !== c.key) return;
        c.custom = !!who.custom; c.car = validCar(m.car || c.car, c.custom); if (c.lobby) pushLobby(c.lobby);
      }).catch(e => console.error('[supabase] ' + e.message));
      return;
    }
    case 'logout': {
      leaveLobby(c); if (c.name && online.get(c.name.toLowerCase()) === c) online.delete(c.name.toLowerCase()); c.name = null; c.key = null; c.custom = false; c.car = validCar(c.car, false);
      return send(c, { t: 'loggedout' });
    }
  }
  if (!c.name) return send(c, { t: 'error', where: 'auth', msg: 'Sign in first.' });
  switch (m.t) {
    case 'car': c.car = validCar(m.car, c.custom); if (c.lobby) pushLobby(c.lobby); return;
    case 'list': return send(c, { t: 'lobbies', list: [...lobbies.values()].filter(L => L.private).map(L => ({ id: L.id, name: L.name, players: L.players.length, max: L.max, mode: L.mode, state: L.state, locked: true })) });
    case 'quick': {
      c.car = validCar(m.car, c.custom) || c.car;
      const mode = m.mode === 'survival' ? 'survival' : 'normal';
      // any open lobby with a free place counts, also one whose race is running: you wait in its lobby and take an AI car's place on
      // the grid of the next race. The fullest lobby first (so they fill up); between equals, one that isn't mid-race (you race sooner).
      const waiting = L => (L.state === 'lobby' || L.state === 'results') ? 0 : 1;
      const open = [...lobbies.values()].filter(L => !L.private && L.mode === mode && L.players.length < L.max)
        .sort((a, b) => b.players.length - a.players.length || waiting(a) - waiting(b) || a.created - b.created);
      return joinLobby(c, open[0] || makeLobby({ name: mode === 'survival' ? 'Survival lobby' : 'Open lobby', mode, pool: m.pool }));
    }
    case 'create': {
      c.car = validCar(m.car, c.custom) || c.car;
      const name = clean(m.name, 24) || (c.name + '\'s server'), pass = String(m.pass || '');
      if (nameBad(name)) return send(c, { t: 'error', where: 'create', msg: 'That server name isn\'t allowed. Pick another one.' });
      if (pass.length < 3 || pass.length > 32) return send(c, { t: 'error', where: 'create', msg: 'Password: 3–32 characters.' });
      return joinLobby(c, makeLobby({ name, pass, mode: m.mode === 'survival' ? 'survival' : 'normal', pool: m.pool }));
    }
    case 'join': {
      c.car = validCar(m.car, c.custom) || c.car;
      const L = lobbies.get(String(m.id || '').toUpperCase());
      if (!L) return send(c, { t: 'error', where: 'join', msg: 'Server not found.' });
      if (L.private) {
        if (limited(c.ip)) return send(c, { t: 'error', where: 'join', msg: 'Too many tries. Wait a few minutes.' });
        if (!checkPass(String(m.pass || ''), L.salt, L.hash)) { failed(c.ip); return send(c, { t: 'error', where: 'join', msg: 'Wrong password.' }); }
      }
      return joinLobby(c, L);
    }
    case 'leave': leaveLobby(c); return send(c, { t: 'left' });
    case 'start': { const L = c.lobby; if (L && L.private && L.host === c.id && L.state === 'lobby') startRace(L); return; }   // (older game versions)
    case 'away': {   // an ad on screen / the app in the background, and back
      c.away = !!m.on; c.awayAt = Date.now(); const L = c.lobby; if (!L) return;
      if (c.away) c.ready = false;
      if (c.away && (L.state === 'race' || L.state === 'loading') && L.race && L.race.botHost === c.id) handBots(L);   // can't drive the AI cars from behind an ad
      if (L.state === 'lobby') checkAutoStart(L);
      pushLobby(L); return; }
    case 'ready': { const L = c.lobby; if (!L) return; c.ready = !!m.on; checkAutoStart(L); pushLobby(L); return; }
    case 'loaded': { const L = c.lobby; if (L && L.state === 'loading' && L.race.racers.has(c.id)) { L.race.loaded.add(c.id); maybeGo(L); } return; }
    case 'st': return onState(c, m.s);
    case 'fin': return onFinish(c, m.time, Number.isInteger(m.bot) && m.bot < 0 ? m.bot : null);
    case 'bst': return onBotStates(c, m.s);
    case 'bots': { const L = c.lobby; if (!L || L.host !== c.id) return; L.bots = !!m.on; checkAutoStart(L); pushLobby(L); return; }   // Survival starts with AI on, but the host can race friends only
    case 'vote': return onVote(c, m.track);
    case 'pick': {                                          // the host picks the track for the lobby's first race (null = random)
      const L = c.lobby; if (!L || L.host !== c.id || L.state !== 'lobby' || L.races) return;
      if (m.track != null && !TRACK_IDS.includes(m.track)) return;
      const pool = validPool(m.pool); if (pool) L.pool = pool;                 // (the host's own unlocked tracks: Random picks from these)
      if (m.track && pool && !pool.includes(m.track)) return;
      L.nextTrack = m.track || null; pushLobby(L); return; }
    case 'hit': {                                           // a bump: pass the push on to the car that was hit
      const L = c.lobby; if (!L || L.state !== 'race' || !L.race.racers.has(c.id)) return;
      const j = Array.isArray(m.j) ? m.j : [], jx = +j[0], jz = +j[1], r = +m.r;
      if (!isFinite(jx) || !isFinite(jz) || Math.hypot(jx, jz) > 30000) return;
      const rr = isFinite(r) ? Math.max(-0.35, Math.min(0.35, r)) : 0;
      // who did the bumping: the sender's own car, or one of the AI cars their game drives
      const as = Number.isInteger(m.as) && m.as < 0 && L.race.botHost === c.id && L.race.racers.has(m.as) ? m.as : c.id;
      const tb = L.race.racers.get(m.to);
      if (tb && tb.bot) {                                    // an AI car was hit: tell the game that drives it
        if (tb.dnf || L.race.botHost === c.id) return; const h = L.players.find(p => p.id === L.race.botHost); if (!h) return;
        return send(h, { t: 'hit', from: as, bot: tb.id, j: [Math.round(jx), Math.round(jz)], r: rr });
      }
      const t = L.players.find(p => p.id === m.to); if (!t || t === c || !L.race.racers.has(t.id)) return;
      return send(t, { t: 'hit', from: as, j: [Math.round(jx), Math.round(jz)], r: rr });
    }
  }
}

/* ---------------- purchases: RevenueCat webhook -> Supabase ---------------- */
// In RevenueCat → Integrations → Webhooks: URL https://<this server>/hooks/revenuecat, and an Authorization header
// with the same value as the REVENUECAT_WEBHOOK_AUTH setting here. Every event goes to the database function rc_event
// (supabase/schema.sql), which logs it and updates the player's purchases. Needs SUPABASE_URL and SUPABASE_SECRET_KEY.
const RC_AUTH = process.env.REVENUECAT_WEBHOOK_AUTH || '';
function revenuecatHook(req, res) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const reply = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (req.method !== 'POST') return reply(405, { error: 'POST only' });
  if (!RC_AUTH || !SB_URL || !SB_SECRET) return reply(503, { error: 'Purchases aren\'t set up on this server (REVENUECAT_WEBHOOK_AUTH, SUPABASE_URL, SUPABASE_SECRET_KEY).' });
  if (limited('rc:' + ip)) return reply(429, { error: 'Too many tries' });
  const got = sha(String(req.headers.authorization || ''));
  if (!sameHash(got, sha(RC_AUTH)) && !sameHash(got, sha('Bearer ' + RC_AUTH))) { failed('rc:' + ip); return reply(401, { error: 'Wrong authorization' }); }
  let body = '', size = 0;
  req.on('data', d => { size += d.length; if (size > 512 * 1024) req.destroy(); else body += d; });
  req.on('end', async () => {
    let ev; try { ev = JSON.parse(body); } catch (e) { return reply(400, { error: 'Bad JSON' }); }
    try {
      const r = await fetch(SB_URL + '/rest/v1/rpc/rc_event', { method: 'POST', signal: AbortSignal.timeout(20000),
        headers: { apikey: SB_SECRET, Authorization: 'Bearer ' + SB_SECRET, 'Content-Type': 'application/json' }, body: JSON.stringify({ body: ev }) });
      const txt = await r.text();
      if (!r.ok) { console.error('[revenuecat] database said ' + r.status + ': ' + txt.slice(0, 300)); return reply(r.status === 400 ? 400 : 502, { error: 'Could not record the event' }); }
      const out = JSON.parse(txt || 'null');
      console.log('[revenuecat] ' + ((ev && ev.event && ev.event.type) || '?') + ' -> ' + out);
      return reply(200, { ok: true, result: out });   // anything but 200 and RevenueCat tries again later
    } catch (e) { console.error('[revenuecat] ' + e.message); return reply(502, { error: 'Could not reach the database' }); }
  });
}

// names that aren't allowed (swearing, slurs, sexual, hateful), in the languages of the game. The same list is in the
// Supabase database (which has the final say) and the game server. Leetspeak (0=o, 1=i, 3=e…) and doubled letters don't get round it.
const BAD_ROOTS=["f+u+c+k", "fuk(?![uoa])", "fvck", "fcuk", "phuck", "motherf", "sh+i+t(?!a)", "cunt", "n+i+g+g", "n+i+g+(a+h?|u+h)$", "n+i+g+e+r(?!ia)", "nigr", "f+a+g+o+t", "kike", "chink", "wetback", "raghead", "towelhead", "zipperhead", "beaner", "r+e+t+a+r+d", "tranny", "whore", "slut", "bitch", "bastard", "asshole", "dickhead", "pussy", "penis", "vagina", "dildo", "porn", "(^|[^e])rapist", "pa?edophil", "molest", "hitler", "siegheil", "heilhit", "whitepower", "whitepride", "nazi$", "nazis$", "kkk", "killyourself", "wanker", "cazzo", "minchia", "stronz", "puttan(?!esc)", "vaffancul", "fancul", "culattone", "frocio", "ricchion", "(^|[^e])negro(?!n)", "terrone", "zoccola", "coglion", "porcodio", "porcamadonna", "dioporco", "diocane", "mignotta", "bastardo", "pendejo", "cabron", "maricon", "gilipollas", "mierda", "culero", "chinga", "sudaca", "hijodeputa", "putain", "salope", "connard", "connasse", "encule", "bougnoul", "salaud", "(^|[^e])negre", "niquetamere", "scheiss", "ficken", "fotze", "hurensohn", "wichser", "schwuchtel", "neger", "spast", "missgeburt", "arschloch", "kanake", "caralho", "buceta", "viado", "merda", "cuzao", "filhodaputa"].map(p=>new RegExp(p)),BAD_EXACT=new Set(["ass", "arse", "cum", "fag", "fags", "coon", "dyke", "cock", "rape", "pedo", "paedo", "spic", "puta", "puto", "marica", "figa", "pede", "nique", "foda", "tits", "dick", "anal", "anus", "nazi", "nazis", "sex", "wank", "twat", "piss", "jap", "gook", "paki", "nig", "negr", "porra", "troia", "culo", "kys", "fdp", "putas", "putos"]);
function nameBad(n){
  const raw=String(n||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();if(/1488/.test(raw))return true;
  const leet=s=>s.replace(/[0134578]/g,d=>'oieastb'['0134578'.indexOf(d)]).replace(/[^a-z]/g,''),sq=s=>s.replace(/(.)\1+/g,'$1');
  const t=leet(raw),c=sq(t);if(BAD_ROOTS.some(r=>r.test(t)||r.test(c)))return true;
  if(BAD_EXACT.has(t)||BAD_EXACT.has(c))return true;
  return (String(n||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').match(/[A-Z]?[a-z0-9]+|[A-Z0-9]+(?![a-z])/g)||[]).some(w=>{const x=leet(w.toLowerCase());return BAD_EXACT.has(x)||BAD_EXACT.has(sq(x));});
}

/* ---------------- app-ads.txt ----------------
   The ad networks read https://<developer website>/app-ads.txt. Yodo1 MAS publishes the list of its ad sellers and
   changes it from time to time, so the server fetches it (APP_ADS_URL, default yodo1.com) and refreshes it every 6 hours.
   A file at public/app-ads.txt, if you add one, takes priority. */
const APP_ADS_DEFAULT = 'https://yodo1.com/app-ads.txt';
function appAdsUrl(s) {   // accepts "2v37.ads-txt.site", "https://2v37.ads-txt.site" or the full …/app-ads.txt address
  s = String(s || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try { const u = new URL(s); if (u.pathname === '/' || u.pathname === '') u.pathname = '/app-ads.txt'; return u.href; } catch (e) { return ''; }
}
const APP_ADS_URLS = [appAdsUrl(process.env.APP_ADS_URL), APP_ADS_DEFAULT].filter((u, i, a) => u && a.indexOf(u) === i);
const appAds = { text: '', at: 0, busy: null, from: '' };
async function appAdsGet(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'soapcube-racing-server' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const t = await r.text();
  if (!/,\s*(DIRECT|RESELLER)/i.test(t)) throw new Error('not an app-ads.txt');
  return t;
}
function appAdsFetch() {   // your game's own MAS link first (APP_ADS_URL), then the general MAS list
  if (appAds.busy) return appAds.busy;
  appAds.busy = (async () => {
    for (const url of APP_ADS_URLS) {
      try { appAds.text = await appAdsGet(url); appAds.at = Date.now(); appAds.from = url; return; }
      catch (e) { console.log('app-ads.txt fetch failed (' + url + '):', e.message); }
    }
  })().finally(() => { appAds.busy = null; });
  return appAds.busy;
}
async function appAdsTxt(res) {
  if (!appAds.text || Date.now() - appAds.at > 6 * 3600e3) await appAdsFetch();
  if (!appAds.text) { res.writeHead(503, { 'Content-Type': 'text/plain' }); return res.end('app-ads.txt is not available right now'); }
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' }); res.end(appAds.text);
}

/* ---------------- http + websocket ---------------- */
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/' || url === '/index.html' || url === '/pebble-hill-derby.html') {
    fs.readFile(GAME_FILE, (err, buf) => {
      if (err) { res.writeHead(500); return res.end('Game file missing: put the game HTML at public/pebble-hill-derby.html'); }
      let html = buf.toString('utf8');
      if (!/^\s*<!doctype/i.test(html))   // the game file is a page body: give it a proper document head (mobile viewport, full screen)
        html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="theme-color" content="#8ec2e6"></head><body>' + html + '</body></html>';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }); res.end(html);
    });
    return;
  }
  if (url === '/hooks/revenuecat') return revenuecatHook(req, res);
  // plain pages next to the game: the privacy policy (needed by the ad network and the app stores), the account deletion page
  // (Google Play's "delete account" link) and the ads' app-ads.txt
  const PAGES = { '/privacy': ['privacy.html', 'text/html; charset=utf-8'], '/privacy.html': ['privacy.html', 'text/html; charset=utf-8'], '/delete-account': ['delete-account.html', 'text/html; charset=utf-8'], '/delete-account.html': ['delete-account.html', 'text/html; charset=utf-8'], '/app-ads.txt': ['app-ads.txt', 'text/plain; charset=utf-8'] };
  if (PAGES[url]) {
    return fs.readFile(path.join(__dirname, 'public', PAGES[url][0]), (err, buf) => {
      if (err && url === '/app-ads.txt') return appAdsTxt(res);   // no own copy: serve MAS's list, kept up to date automatically
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': PAGES[url][1], 'Cache-Control': 'public, max-age=300' }); res.end(buf);
    });
  }
  // the How to play clips
  const clip = /^\/howto\/([a-z]{3,12})\.webp$/.exec(url);
  if (clip) {
    return fs.readFile(path.join(__dirname, 'public', 'howto', clip[1] + '.webp'), (err, buf) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=86400' }); res.end(buf);
    });
  }
  // the music (public/music/<name>.mp4: AAC audio). Byte ranges, so a track can start part-way through
  const tune = /^\/music\/([a-z0-9-]{3,40})\.mp4$/.exec(url);
  if (tune) {
    const file = path.join(__dirname, 'public', 'music', tune[1] + '.mp4');
    return fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404); return res.end('Not found'); }
      const size = st.size, h = { 'Content-Type': 'audio/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=86400' };
      const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
      if (m && (m[1] || m[2])) {
        let a = m[1] ? +m[1] : size - +m[2], b = m[1] && m[2] ? +m[2] : size - 1;
        if (a < 0) a = 0; b = Math.min(b, size - 1);
        if (a > b || a >= size) { res.writeHead(416, { 'Content-Range': 'bytes */' + size }); return res.end(); }
        res.writeHead(206, Object.assign(h, { 'Content-Range': 'bytes ' + a + '-' + b + '/' + size, 'Content-Length': b - a + 1 }));
        if (req.method === 'HEAD') return res.end();
        return fs.createReadStream(file, { start: a, end: b }).pipe(res);
      }
      res.writeHead(200, Object.assign(h, { 'Content-Length': size }));
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    });
  }
  if (url === '/health') { res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); return res.end(JSON.stringify({ ok: true, online: online.size, lobbies: lobbies.size, accounts: !!(SB_URL && SB_KEY), purchases: !!(RC_AUTH && SB_URL && SB_SECRET), appAds: appAds.from || null })); }
  res.writeHead(404); res.end('Not found');
});
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
const STALE_MS = 9000;                             // players ping every 2 s; this long without a word means the connection is gone
const clients = new Set();
let nextId = 1;
wss.on('connection', (ws, req) => {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const c = { id: nextId++, ws, ip, name: null, guest: true, car: validCar({}), lobby: null, msgs: 0, since: Date.now(), lastSeen: Date.now(), sid: null };
  clients.add(c);
  ws.on('pong', () => { ws._dead = false; });
  ws.on('message', (data) => {
    const now = Date.now(); c.lastSeen = now; if (now - c.since > 1000) { c.since = now; c.msgs = 0; }
    const over = ++c.msgs > 60;                                  // flood guard: past 60 a second, position/bump spam is dropped
    if (c.msgs > 200) return;                                     // (but finishing, votes and leaving always get through)
    let m; try { m = JSON.parse(data); } catch (e) { return; }
    if (over && m && (m.t === 'st' || m.t === 'hit' || m.t === 'ping')) return;
    if (m && typeof m.t === 'string') { const run = () => { try { handle(c, m); } catch (e) { console.error(e); } }; if (LAG) setTimeout(run, LAG); else run(); }
  });
  ws.on('close', (code, reason) => {
    if (process.env.PHD_DEBUG) console.log('close', c.name, code, String(reason || ''), c.lobby && c.lobby.state);
    clients.delete(c);
    if (c.sid && c.name) parked.set(c.sid, { name: c.name, key: c.key, guest: c.guest, custom: c.custom, car: c.car, lobbyId: c.lobby && c.lobby.id, until: Date.now() + PARK_MS });
    leaveLobby(c); if (c.name && online.get(c.name.toLowerCase()) === c) online.delete(c.name.toLowerCase());
  });
});
// heartbeat: drop connections that go quiet (phone went to sleep, network died) so they don't sit in lobbies as ghosts
setInterval(() => {
  const now = Date.now();
  for (const c of clients) if (now - c.lastSeen > 20000) { if (process.env.PHD_DEBUG) console.log('drop silent', c.name, now - c.lastSeen); try { c.ws.terminate(); } catch (e) {} }
  for (const ws of wss.clients) { try { ws.ping(); } catch (e) {} }        // keep-alive for proxies (a slow reply is not a reason to drop anyone)
  for (const [k, P] of parked) if (P.until < now) parked.delete(k);
}, 5000);

server.listen(PORT, () => console.log('Soapcube Racing server on http://localhost:' + PORT));
