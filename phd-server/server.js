// Pebble Hill Derby — multiplayer server
// One Node process: serves the game page, signs players in (as a guest, or with their Supabase account),
// lobbies (up to 12 racers, or 50 in Survival; public quick-join or password-protected private servers),
// relays car positions during races, collects results and runs the next-track vote.
// Accounts, emails and saved progress live in Supabase; purchases come in from RevenueCat (/hooks/revenuecat).
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
const TIMES = {                                   // seconds
  readyWait: 15,         // countdown once more than half the players (or the host) are ready
  loadTimeout: 25,       // waiting for everyone to build the track
  countdown: 3.6,        // matches the in-game 3-2-1
  afterFirst: 60,        // others get this long after the winner crosses the line
  maxRace: 8 * 60,
  vote: 15,
  afterVote: 3,
};
if (process.env.PHD_FAST) Object.assign(TIMES, { readyWait: 3, vote: 30, afterVote: 2, afterFirst: 15 });   // for automated tests
const SNAP_MS = 50;                               // 20 position updates a second
const RACE_IDLE_MS = 10000;                       // a racer whose car hasn't reported in this long (app switched away, phone locked, gone) is taken out of the race

/* ---------------- Supabase (accounts) ---------------- */
// The game signs players in with Supabase itself; this server only asks Supabase who a player is (their racer name).
// Settings (Render → Environment):
//   SUPABASE_URL              https://<project>.supabase.co
//   SUPABASE_PUBLISHABLE_KEY  the publishable (or legacy anon) key: the same one that's in the game
//   SUPABASE_SECRET_KEY       the secret (or legacy service_role) key: only for recording purchases. Never put it in the game.
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
  return prof && prof.racer_name ? { id: user.id, name: String(prof.racer_name) } : null;
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
function makeLobby(opts) {
  const surv = opts.mode === 'survival', max = surv ? SURV_PLAYERS : MAX_PLAYERS;
  const L = {
    id: code(), name: opts.name, private: !!opts.pass, salt: null, hash: null,
    host: null, state: 'lobby', players: [], track: pick(TRACK_IDS), nextTrack: null,
    timer: null, timerEnds: 0, race: null, vote: null, created: Date.now(), mode: surv ? 'survival' : 'normal', max, bots: surv, botPool: makeBots(max - 1),
  };
  if (opts.pass) { L.salt = crypto.randomBytes(12).toString('hex'); L.hash = hashPass(opts.pass, L.salt); }
  lobbies.set(L.id, L);
  return L;
}
function lobbyInfo(L) {
  return {
    id: L.id, name: L.name, locked: L.private, host: L.host, state: L.state, track: L.nextTrack || null,
    countdown: L.timer ? Math.max(0, Math.ceil((L.timerEnds - Date.now()) / 1000)) : null,
    players: L.players.map(c => ({ id: c.id, name: c.name, guest: c.guest, car: c.car, ready: !!c.ready, racing: !!(L.race && L.race.racers.has(c.id)) })),
    max: L.max, mode: L.mode, bots: !!L.bots, botList: botsFor(L, L.players.length).map(b => ({ name: b.name, paint: b.car.paint })),
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
function readyToGo(L) {
  const n = L.players.length; if (!n) return false;
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
  if (L.state === 'loading' || L.state === 'race') send(c, { t: 'info', msg: 'A race is running. You\'ll be on the grid for the next one.' });
  if (L.state === 'results' && L.vote) send(c, { t: 'results', rows: L.lastRows || [], vote: voteInfo(L) });
  checkAutoStart(L);
}
function leaveLobby(c) {
  const L = c.lobby; if (!L) return;
  L.players = L.players.filter(p => p !== c); c.lobby = null; c.ready = false;
  if (L.race && L.race.racers.has(c.id)) {
    L.race.racers.delete(c.id); L.race.states.delete(c.id); L.race.loaded.delete(c.id);
    broadcast(L, { t: 'gone', id: c.id });
    if (L.race.botHost === c.id) dropBots(L, true);                    // their game was driving the AI cars
    if (L.state === 'loading') maybeGo(L); else if (L.state === 'race') maybeEnd(L);
  }
  if (L.vote) { L.vote.ballots.delete(c.id); }
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
  const track = L.nextTrack || pick(TRACK_IDS); L.nextTrack = null; L.track = track;
  // someone's connection has gone quiet (phone locked, network switch): drop them if it's been long,
  // otherwise hold the start a moment so their phone can reconnect and keep its seat
  const now0 = Date.now();
  for (const p of L.players.slice()) if (now0 - p.lastSeen > STALE_MS) { try { p.ws.terminate(); } catch (e) {} leaveLobby(p); }
  if (!L.players.length) return;
  if (L.players.some(p => now0 - p.lastSeen > 4500) && (L.holds = (L.holds || 0) + 1) <= 6) { setTimer(L, 1.5, () => startRace(L)); pushLobby(L); return; }
  L.holds = 0;
  const racers = L.players.slice(0, L.max);
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
    track, grid, racers: new Map(racers.map(c => [c.id, { id: c.id, name: c.name, guest: c.guest, car: c.car, fin: null, lastS: 0 }])),
    loaded: new Set(), states: new Map(), dirty: new Set(), start: 0, firstFin: 0, snapTimer: null, endTimer: null, botHost: bots.length ? L.host : null,
  };
  for (const b of bots) L.race.racers.set(b.id, { id: b.id, name: b.name, guest: false, bot: true, car: b.car, fin: null, lastS: 0 });
  L.state = 'loading';
  const roster = [...L.race.racers.values()].map(r => ({ id: r.id, name: r.name, guest: r.guest, car: r.car, slot: grid[r.id], bot: !!r.bot }));
  for (const c of racers) send(c, { t: 'race', track, roster, you: c.id, botHost: L.race.botHost, mode: L.mode });
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
  r.fin = t;
  if (!L.race.firstFin) { L.race.firstFin = Date.now(); clearTimeout(L.race.endTimer); L.race.endTimer = setTimeout(() => endRace(L), TIMES.afterFirst * 1000); }
  const place = [...L.race.racers.values()].filter(x => x.fin).length;
  broadcast(L, { t: 'fin', id: r.id, time: t, place });
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
    .sort((a, b) => (a.fin && b.fin) ? a.fin - b.fin : a.fin ? -1 : b.fin ? 1 : b.lastS - a.lastS)
    .map((r, i) => ({ id: r.id, name: r.name, guest: r.guest, bot: !!r.bot, paint: r.car && r.car.paint, time: r.fin || null, place: i + 1 }));
  L.lastRows = rows;
  L.state = 'results';
  const opts = TRACK_IDS.length >= 2 ? TRACK_IDS.slice().sort(() => Math.random() - 0.5).slice(0, 2) : [TRACK_IDS[0], TRACK_IDS[0]];
  L.vote = { options: opts, ballots: new Map(), ends: Date.now() + TIMES.vote * 1000 };
  broadcast(L, { t: 'results', rows, vote: voteInfo(L) });
  setTimer(L, TIMES.vote, () => closeVote(L));
  pushLobby(L);
}
function voteInfo(L) {
  const V = L.vote; if (!V) return null;
  const counts = V.options.map(o => [...V.ballots.values()].filter(b => b === o).length);
  return { options: V.options, counts, secs: Math.max(0, Math.ceil((V.ends - Date.now()) / 1000)) };
}
function onVote(c, track) {
  const L = c.lobby; if (!L || L.state !== 'results' || !L.vote || !L.vote.options.includes(track)) return;
  L.vote.ballots.set(c.id, track);
  broadcast(L, { t: 'votes', vote: voteInfo(L) });
  if (L.vote.ballots.size >= L.players.length) closeVote(L);
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
function validCar(o) {
  if (!o || typeof o !== 'object') return null;
  const i = (v, m) => Number.isInteger(v) && v >= 0 && v < m ? v : 0;
  return { design: i(o.design, 32), paint: /^#[0-9a-f]{6}$/i.test(o.paint) ? o.paint : '#c8231f', rim: i(o.rim, 32), fin: i(o.fin, 32), rs: Number.isInteger(o.rs) && o.rs >= 13 && o.rs <= 22 ? o.rs : 18, off: Number.isInteger(o.off) && o.off >= 0 && o.off <= 16 ? o.off : 0, rh: Number.isInteger(o.rh) && Math.abs(o.rh) <= 3 ? o.rh : 0 };   // rs: rim size in inches
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
    parked.set(sid, { name: o.name, key: o.key, guest: o.guest, car: o.car, lobbyId: o.lobby && o.lobby.id, until: Date.now() + PARK_MS });
    leaveLobby(o); if (online.get(o.name.toLowerCase()) === o) online.delete(o.name.toLowerCase());
    o.sid = null; o.name = null; try { o.ws.terminate(); } catch (e) {}
  }
  const P = parked.get(sid); parked.delete(sid);
  if (!P || P.until < Date.now()) return send(c, { t: 'error', where: 'rejoin', msg: 'Session over.' });
  c.sid = sid; c.car = P.car || c.car;
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
        authed(c, who.name, false, who.id);
      }).catch(e => {
        console.error('[supabase] ' + e.message);
        send(c, { t: 'error', where: 'auth', msg: 'The account server didn\'t answer. Try again, or race as a guest.' });
      });
      return;
    }
    case 'logout': {
      leaveLobby(c); if (c.name && online.get(c.name.toLowerCase()) === c) online.delete(c.name.toLowerCase()); c.name = null; c.key = null;
      return send(c, { t: 'loggedout' });
    }
  }
  if (!c.name) return send(c, { t: 'error', where: 'auth', msg: 'Sign in first.' });
  switch (m.t) {
    case 'car': c.car = validCar(m.car); if (c.lobby) pushLobby(c.lobby); return;
    case 'list': return send(c, { t: 'lobbies', list: [...lobbies.values()].filter(L => L.private).map(L => ({ id: L.id, name: L.name, players: L.players.length, max: L.max, mode: L.mode, state: L.state, locked: true })) });
    case 'quick': {
      c.car = validCar(m.car) || c.car;
      const mode = m.mode === 'survival' ? 'survival' : 'normal';
      const open = [...lobbies.values()].filter(L => !L.private && L.mode === mode && (L.state === 'lobby' || L.state === 'results') && L.players.length < L.max)
        .sort((a, b) => b.players.length - a.players.length || a.created - b.created);
      return joinLobby(c, open[0] || makeLobby({ name: mode === 'survival' ? 'Survival lobby' : 'Open lobby', mode }));
    }
    case 'create': {
      c.car = validCar(m.car) || c.car;
      const name = clean(m.name, 24) || (c.name + '\'s server'), pass = String(m.pass || '');
      if (pass.length < 3 || pass.length > 32) return send(c, { t: 'error', where: 'create', msg: 'Password: 3–32 characters.' });
      return joinLobby(c, makeLobby({ name, pass, mode: m.mode === 'survival' ? 'survival' : 'normal' }));
    }
    case 'join': {
      c.car = validCar(m.car) || c.car;
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
    case 'ready': { const L = c.lobby; if (!L) return; c.ready = !!m.on; checkAutoStart(L); pushLobby(L); return; }
    case 'loaded': { const L = c.lobby; if (L && L.state === 'loading' && L.race.racers.has(c.id)) { L.race.loaded.add(c.id); maybeGo(L); } return; }
    case 'st': return onState(c, m.s);
    case 'fin': return onFinish(c, m.time, Number.isInteger(m.bot) && m.bot < 0 ? m.bot : null);
    case 'bst': return onBotStates(c, m.s);
    case 'bots': { const L = c.lobby; if (!L || L.host !== c.id) return; L.bots = !!m.on; checkAutoStart(L); pushLobby(L); return; }   // Survival starts with AI on, but the host can race friends only
    case 'vote': return onVote(c, m.track);
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
  if (url === '/health') { res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); return res.end(JSON.stringify({ ok: true, online: online.size, lobbies: lobbies.size, accounts: !!(SB_URL && SB_KEY), purchases: !!(RC_AUTH && SB_URL && SB_SECRET) })); }
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
    if (c.sid && c.name) parked.set(c.sid, { name: c.name, key: c.key, guest: c.guest, car: c.car, lobbyId: c.lobby && c.lobby.id, until: Date.now() + PARK_MS });
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

server.listen(PORT, () => console.log('Pebble Hill Derby server on http://localhost:' + PORT));
