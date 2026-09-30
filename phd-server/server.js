// Pebble Hill Derby — multiplayer server
// One Node process: serves the game page, handles accounts (guest / register / login),
// lobbies (up to 12 racers, public quick-join or password-protected private servers),
// relays car positions during races, collects results and runs the next-track vote.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = +process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
// the game page: public/pebble-hill-derby.html (an older public/index.html still works as a fallback)
const GAME_FILE = ['pebble-hill-derby.html', 'index.html'].map(f => path.join(__dirname, 'public', f)).find(f => fs.existsSync(f)) || path.join(__dirname, 'public', 'pebble-hill-derby.html');
const TRACK_IDS = ['pebble', 'city', 'nomahe', 'tokiyama', 'whitecow'];           // keep in sync with TRACKS in the game
const MAX_PLAYERS = 12;
const TIMES = {                                   // seconds
  publicWait: 20,        // quick-join lobby: countdown once 2+ racers are in
  publicFull: 5,         // ...shortened when the lobby fills up
  loadTimeout: 25,       // waiting for everyone to build the track
  countdown: 3.6,        // matches the in-game 3-2-1
  afterFirst: 60,        // others get this long after the winner crosses the line
  maxRace: 8 * 60,
  vote: 15,
  afterVote: 3,
};
if (process.env.PHD_FAST) Object.assign(TIMES, { publicWait: 3, publicFull: 2, vote: 30, afterVote: 2, afterFirst: 15 });   // for automated tests
const SNAP_MS = 50;                               // 20 position updates a second

/* ---------------- storage (JSON files; swap for a database when you outgrow it) ---------------- */
fs.mkdirSync(DATA_DIR, { recursive: true });
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESS_FILE = path.join(DATA_DIR, 'sessions.json');
const readJSON = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return {}; } };
let users = readJSON(USERS_FILE);                 // lower-case name -> {name, salt, hash, created}
let sessions = readJSON(SESS_FILE);               // token -> {key, exp}
const saveTimers = {};
function save(file, obj) {
  clearTimeout(saveTimers[file]);
  saveTimers[file] = setTimeout(() => {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, file);
  }, 200);
}
const SESSION_DAYS = 30;
function newSession(key) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions[token] = { key, exp: Date.now() + SESSION_DAYS * 864e5 };
  save(SESS_FILE, sessions);
  return token;
}
function hashPass(pass, salt) { return crypto.scryptSync(pass, salt, 64).toString('hex'); }
function checkPass(pass, salt, hash) {
  const a = Buffer.from(hashPass(pass, salt), 'hex'), b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ---------------- names ---------------- */
const NAME_RE = /^[A-Za-z0-9_]{3,16}$/;
const ADJ = ['Zippy', 'Rusty', 'Turbo', 'Lucky', 'Swift', 'Mighty', 'Sneaky', 'Jolly', 'Brave', 'Sunny', 'Dusty', 'Nifty', 'Bouncy', 'Gritty', 'Plucky', 'Speedy'];
const ANIMAL = ['Otter', 'Badger', 'Falcon', 'Gecko', 'Panda', 'Moose', 'Ferret', 'Lynx', 'Koala', 'Beaver', 'Heron', 'Marmot', 'Puffin', 'Wombat', 'Yak', 'Hare'];
const online = new Map();                         // lower-case name -> client
function guestName() {
  for (let k = 0; k < 200; k++) {
    const n = ADJ[Math.random() * ADJ.length | 0] + ANIMAL[Math.random() * ANIMAL.length | 0] + (10 + (Math.random() * 90 | 0));
    const key = n.toLowerCase();
    if (!users[key] && !online.has(key)) return n;
  }
  return 'Racer' + crypto.randomBytes(3).toString('hex');
}
const isGuestLike = (n) => ADJ.some(a => n.toLowerCase().startsWith(a.toLowerCase())) && ANIMAL.some(a => n.toLowerCase().includes(a.toLowerCase()));

/* ---------------- login rate limit ---------------- */
const attempts = new Map();                       // ip -> [timestamps]
function limited(ip) {
  const now = Date.now(), arr = (attempts.get(ip) || []).filter(t => now - t < 5 * 60e3);
  attempts.set(ip, arr);
  return arr.length >= 12;
}
function failed(ip) { const arr = attempts.get(ip) || []; arr.push(Date.now()); attempts.set(ip, arr); }

/* ---------------- lobbies ---------------- */
const lobbies = new Map();                        // id -> lobby
const code = () => { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s = ''; for (let i = 0; i < 5; i++) s += A[Math.random() * A.length | 0]; return lobbies.has(s) ? code() : s; };
const pick = (a) => a[Math.random() * a.length | 0];
function clean(str, max) { return String(str || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max); }

function makeLobby(opts) {
  const L = {
    id: code(), name: opts.name, private: !!opts.pass, salt: null, hash: null,
    host: null, state: 'lobby', players: [], track: pick(TRACK_IDS), nextTrack: null,
    timer: null, timerEnds: 0, race: null, vote: null, created: Date.now(),
  };
  if (opts.pass) { L.salt = crypto.randomBytes(12).toString('hex'); L.hash = hashPass(opts.pass, L.salt); }
  lobbies.set(L.id, L);
  return L;
}
function lobbyInfo(L) {
  return {
    id: L.id, name: L.name, locked: L.private, host: L.host, state: L.state, track: L.nextTrack || null,
    countdown: L.timer ? Math.max(0, Math.ceil((L.timerEnds - Date.now()) / 1000)) : null,
    players: L.players.map(c => ({ id: c.id, name: c.name, guest: c.guest, car: c.car, racing: !!(L.race && L.race.racers.has(c.id)) })),
    max: MAX_PLAYERS,
  };
}
const LAG = +process.env.PHD_LAG || 0;            // test only: fake network delay (ms each way)
const wsend = (ws, str) => { if (LAG) setTimeout(() => { if (ws.readyState === 1) ws.send(str); }, LAG); else ws.send(str); };
function send(c, msg) { if (c.ws.readyState === 1) wsend(c.ws, JSON.stringify(msg)); }
function broadcast(L, msg, except) { const s = JSON.stringify(msg); for (const c of L.players) if (c !== except && c.ws.readyState === 1) wsend(c.ws, s); }
function pushLobby(L) { const info = lobbyInfo(L); for (const c of L.players) send(c, { t: 'lobby', lobby: info, you: c.id }); }
function setTimer(L, secs, fn) { clearTimeout(L.timer); L.timerEnds = Date.now() + secs * 1000; L.timer = setTimeout(() => { L.timer = null; fn(); }, secs * 1000); }
function clearTimer(L) { clearTimeout(L.timer); L.timer = null; }

// quick-join lobbies start by themselves once there are 2+ racers; private ones wait for the host
function checkAutoStart(L) {
  if (L.private || L.state !== 'lobby') return;
  const n = L.players.length;
  if (n < 2) { if (L.timer) { clearTimer(L); pushLobby(L); } return; }
  const want = n >= MAX_PLAYERS ? TIMES.publicFull : TIMES.publicWait;
  if (!L.timer || (L.timerEnds - Date.now()) / 1000 > want + 0.5) { setTimer(L, want, () => startRace(L)); pushLobby(L); }
}

function joinLobby(c, L) {
  if (c.lobby === L) return;
  if (c.lobby) leaveLobby(c);
  if (L.players.length >= MAX_PLAYERS) return send(c, { t: 'error', where: 'join', msg: 'That server is full (12/12).' });
  L.players.push(c); c.lobby = L;
  if (!L.host) L.host = c.id;
  pushLobby(L);
  if (L.state === 'loading' || L.state === 'race') send(c, { t: 'info', msg: 'A race is running. You\'ll be on the grid for the next one.' });
  if (L.state === 'results' && L.vote) send(c, { t: 'results', rows: L.lastRows || [], vote: voteInfo(L) });
  checkAutoStart(L);
}
function leaveLobby(c) {
  const L = c.lobby; if (!L) return;
  L.players = L.players.filter(p => p !== c); c.lobby = null;
  if (L.race && L.race.racers.has(c.id)) {
    L.race.racers.delete(c.id); L.race.states.delete(c.id); L.race.loaded.delete(c.id);
    broadcast(L, { t: 'gone', id: c.id });
    if (L.state === 'loading') maybeGo(L); else if (L.state === 'race') maybeEnd(L);
  }
  if (L.vote) { L.vote.ballots.delete(c.id); }
  if (!L.players.length) { clearTimer(L); clearInterval(L.race && L.race.snapTimer); lobbies.delete(L.id); return; }
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
  const racers = L.players.slice(0, MAX_PLAYERS);
  const slots = [...Array(MAX_PLAYERS).keys()].sort(() => Math.random() - 0.5);   // random grid
  const grid = {}; racers.forEach((c, i) => { grid[c.id] = slots[i]; });
  L.race = {
    track, grid, racers: new Map(racers.map(c => [c.id, { id: c.id, name: c.name, guest: c.guest, car: c.car, fin: null, lastS: 0 }])),
    loaded: new Set(), states: new Map(), start: 0, firstFin: 0, snapTimer: null, endTimer: null,
  };
  L.state = 'loading';
  const roster = [...L.race.racers.values()].map(r => ({ id: r.id, name: r.name, guest: r.guest, car: r.car, slot: grid[r.id] }));
  for (const c of racers) send(c, { t: 'race', track, roster, you: c.id });
  setTimer(L, TIMES.loadTimeout, () => go(L));
  const chk = setInterval(() => { if (L.state !== 'loading') return clearInterval(chk); maybeGo(L); }, 1000);
  pushLobby(L);
}
function maybeGo(L) {
  if (L.state !== 'loading') return;
  if (!L.race.racers.size) return backToLobby(L);
  const now = Date.now();
  for (const id of L.race.racers.keys()) {
    if (L.race.loaded.has(id)) continue;
    const p = L.players.find(x => x.id === id);
    if (p && now - p.lastSeen < STALE_MS) return;          // still loading: wait for them (a silent connection isn't waited for)
  }
  go(L);
}
function go(L) {
  if (L.state !== 'loading') return;
  clearTimer(L);
  for (const id of [...L.race.racers.keys()]) if (!L.race.loaded.has(id)) L.race.racers.get(id).dnf = true;   // never loaded: sits this one out
  // everyone gets the same start moment on the server clock (plus a little slack for delivery), so all countdowns hit GO together
  const now = Date.now();
  L.state = 'race'; L.race.start = now + TIMES.countdown * 1000 + 700;
  for (const c of L.players) if (L.race.racers.has(c.id)) send(c, { t: 'go', countdown: TIMES.countdown, startAt: L.race.start, now });
  L.race.snapTimer = setInterval(() => snap(L), SNAP_MS);
  L.race.endTimer = setTimeout(() => endRace(L), (TIMES.countdown + TIMES.maxRace) * 1000);
  pushLobby(L);
}
function snap(L) {
  if (!L.race || !L.race.states.size) return;
  const cars = []; for (const [id, s] of L.race.states) cars.push([id, ...s]);
  const msg = JSON.stringify({ t: 'snap', cars });
  for (const c of L.players) if (L.race.racers.has(c.id) && c.ws.readyState === 1) wsend(c.ws, msg);
}
function onState(c, a) {
  const L = c.lobby; if (!L || L.state !== 'race' || !L.race.racers.has(c.id)) return;
  if (!Array.isArray(a) || (a.length !== 13 && a.length !== 14) || !a.every(v => typeof v === 'number' && isFinite(v))) return;
  const r = L.race.racers.get(c.id); if (r.fin) { L.race.states.set(c.id, a); return; }
  r.lastS = a[7];
  L.race.states.set(c.id, a);
}
function onFinish(c, time) {
  const L = c.lobby; if (!L || L.state !== 'race') return;
  const r = L.race.racers.get(c.id); if (!r || r.fin || r.dnf) return;
  const elapsed = (Date.now() - L.race.start) / 1000;
  let t = +time;
  if (!process.env.PHD_FAST) {                                                   // (automated tests fast-forward the clock)
    if (!isFinite(t) || Math.abs(t - elapsed) > 3) t = elapsed;                  // trust the client's clock only within 3 s of ours
    if (t < 20) return;                                                          // impossible time: ignore
  } else if (!isFinite(t)) t = elapsed;
  r.fin = t;
  if (!L.race.firstFin) { L.race.firstFin = Date.now(); clearTimeout(L.race.endTimer); L.race.endTimer = setTimeout(() => endRace(L), TIMES.afterFirst * 1000); }
  const place = [...L.race.racers.values()].filter(x => x.fin).length;
  broadcast(L, { t: 'fin', id: c.id, time: t, place });
  maybeEnd(L);
}
function maybeEnd(L) {
  if (L.state !== 'race') return;
  const left = [...L.race.racers.values()].filter(r => !r.fin && !r.dnf);
  if (!left.length) endRace(L);
}
function endRace(L) {
  if (L.state !== 'race') return;
  clearInterval(L.race.snapTimer); clearTimeout(L.race.endTimer);
  const rows = [...L.race.racers.values()]
    .sort((a, b) => (a.fin && b.fin) ? a.fin - b.fin : a.fin ? -1 : b.fin ? 1 : b.lastS - a.lastS)
    .map((r, i) => ({ id: r.id, name: r.name, guest: r.guest, paint: r.car && r.car.paint, time: r.fin || null, place: i + 1 }));
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
  if (L.private || L.players.length >= 2) setTimer(L, TIMES.afterVote, () => { L.state = 'lobby'; startRace(L); });
  else checkAutoStart(L);
  pushLobby(L);
}
function backToLobby(L) { clearTimer(L); if (L.race) { clearInterval(L.race.snapTimer); clearTimeout(L.race.endTimer); } L.race = null; L.state = 'lobby'; checkAutoStart(L); pushLobby(L); }

/* ---------------- messages ---------------- */
function validCar(o) {
  if (!o || typeof o !== 'object') return null;
  const i = (v, m) => Number.isInteger(v) && v >= 0 && v < m ? v : 0;
  return { design: i(o.design, 32), paint: /^#[0-9a-f]{6}$/i.test(o.paint) ? o.paint : '#c8231f', rim: i(o.rim, 32), fin: i(o.fin, 32) };
}
function authed(c, name, guest, token) {
  const key = name.toLowerCase();
  const prev = online.get(key);
  if (prev && prev !== c) { send(prev, { t: 'kicked', msg: 'Signed in somewhere else.' }); leaveLobby(prev); prev.name = null; prev.ws.close(); }
  if (c.name) online.delete(c.name.toLowerCase());
  c.name = name; c.guest = guest; online.set(key, c);
  if (!c.sid) c.sid = crypto.randomBytes(12).toString('hex');       // lets this player take their seat back after a dropped connection
  send(c, { t: 'auth', name, guest, token: token || null, sid: c.sid });
}
// players whose connection dropped (phone locked, network switch): their name + lobby are kept for a while so they can rejoin
const parked = new Map();                          // sid -> {name, guest, car, lobbyId, until}
const PARK_MS = 3 * 60e3;
function rejoin(c, sid) {
  sid = String(sid || '');
  // the old connection may still look alive here (it died silently): take the seat over from it right away
  for (const o of clients) if (o !== c && o.sid === sid && o.name) {
    parked.set(sid, { name: o.name, guest: o.guest, car: o.car, lobbyId: o.lobby && o.lobby.id, until: Date.now() + PARK_MS });
    leaveLobby(o); if (online.get(o.name.toLowerCase()) === o) online.delete(o.name.toLowerCase());
    o.sid = null; o.name = null; try { o.ws.terminate(); } catch (e) {}
  }
  const P = parked.get(sid); parked.delete(sid);
  if (!P || P.until < Date.now()) return send(c, { t: 'error', where: 'rejoin', msg: 'Session over.' });
  if (!P.guest && !users[P.name.toLowerCase()]) return send(c, { t: 'error', where: 'rejoin', msg: 'Session over.' });
  c.sid = sid; c.car = P.car || c.car;
  if (P.guest && online.has(P.name.toLowerCase())) return send(c, { t: 'error', where: 'rejoin', msg: 'Name in use.' });
  authed(c, P.name, P.guest, null);
  const L = P.lobbyId && lobbies.get(P.lobbyId);
  if (L && L.players.length < MAX_PLAYERS) joinLobby(c, L);
}
function handle(c, m) {
  switch (m.t) {
    case 'hello': return send(c, { t: 'welcome', tracks: TRACK_IDS, max: MAX_PLAYERS });
    case 'ping': return send(c, { t: 'pong', c: +m.c || 0, s: Date.now() });   // round-trip time + server clock, for syncing
    case 'guest': if (c.lobby) return; return authed(c, guestName(), true);
    case 'rejoin': if (c.name) return; return rejoin(c, m.sid);
    case 'register': {
      if (limited(c.ip)) return send(c, { t: 'error', where: 'auth', msg: 'Too many tries. Wait a few minutes.' });
      const name = String(m.name || '').trim(), pass = String(m.pass || '');
      if (!NAME_RE.test(name)) return send(c, { t: 'error', where: 'auth', msg: 'Username: 3–16 letters, numbers or _' });
      if (isGuestLike(name)) return send(c, { t: 'error', where: 'auth', msg: 'That looks like a guest name. Pick another.' });
      if (pass.length < 6 || pass.length > 72) return send(c, { t: 'error', where: 'auth', msg: 'Password: at least 6 characters.' });
      const key = name.toLowerCase();
      if (users[key] || online.has(key)) { failed(c.ip); return send(c, { t: 'error', where: 'auth', msg: 'That username is taken.' }); }
      const salt = crypto.randomBytes(16).toString('hex');
      users[key] = { name, salt, hash: hashPass(pass, salt), created: Date.now() }; save(USERS_FILE, users);
      return authed(c, name, false, newSession(key));
    }
    case 'login': {
      if (limited(c.ip)) return send(c, { t: 'error', where: 'auth', msg: 'Too many tries. Wait a few minutes.' });
      const key = String(m.name || '').trim().toLowerCase(), u = users[key];
      if (!u || !checkPass(String(m.pass || ''), u.salt, u.hash)) { failed(c.ip); return send(c, { t: 'error', where: 'auth', msg: 'Wrong username or password.' }); }
      return authed(c, u.name, false, newSession(key));
    }
    case 'resume': {
      const s = sessions[String(m.token || '')];
      if (!s || s.exp < Date.now() || !users[s.key]) return send(c, { t: 'error', where: 'resume', msg: 'Session expired. Log in again.' });
      return authed(c, users[s.key].name, false, m.token);
    }
    case 'logout': {
      if (m.token && sessions[m.token]) { delete sessions[m.token]; save(SESS_FILE, sessions); }
      leaveLobby(c); if (c.name) online.delete(c.name.toLowerCase()); c.name = null;
      return send(c, { t: 'loggedout' });
    }
  }
  if (!c.name) return send(c, { t: 'error', where: 'auth', msg: 'Sign in first.' });
  switch (m.t) {
    case 'car': c.car = validCar(m.car); if (c.lobby) pushLobby(c.lobby); return;
    case 'list': return send(c, { t: 'lobbies', list: [...lobbies.values()].filter(L => L.private).map(L => ({ id: L.id, name: L.name, players: L.players.length, max: MAX_PLAYERS, state: L.state, locked: true })) });
    case 'quick': {
      c.car = validCar(m.car) || c.car;
      const open = [...lobbies.values()].filter(L => !L.private && (L.state === 'lobby' || L.state === 'results') && L.players.length < MAX_PLAYERS)
        .sort((a, b) => b.players.length - a.players.length || a.created - b.created);
      return joinLobby(c, open[0] || makeLobby({ name: 'Open lobby' }));
    }
    case 'create': {
      c.car = validCar(m.car) || c.car;
      const name = clean(m.name, 24) || (c.name + '\'s server'), pass = String(m.pass || '');
      if (pass.length < 3 || pass.length > 32) return send(c, { t: 'error', where: 'create', msg: 'Password: 3–32 characters.' });
      return joinLobby(c, makeLobby({ name, pass }));
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
    case 'start': { const L = c.lobby; if (L && L.private && L.host === c.id && L.state === 'lobby') startRace(L); return; }
    case 'loaded': { const L = c.lobby; if (L && L.state === 'loading' && L.race.racers.has(c.id)) { L.race.loaded.add(c.id); maybeGo(L); } return; }
    case 'st': return onState(c, m.s);
    case 'fin': return onFinish(c, m.time);
    case 'vote': return onVote(c, m.track);
    case 'hit': {                                           // a bump: pass the push on to the car that was hit
      const L = c.lobby; if (!L || L.state !== 'race' || !L.race.racers.has(c.id)) return;
      const t = L.players.find(p => p.id === m.to); if (!t || t === c || !L.race.racers.has(t.id)) return;
      const j = Array.isArray(m.j) ? m.j : [], jx = +j[0], jz = +j[1], r = +m.r;
      if (!isFinite(jx) || !isFinite(jz) || Math.hypot(jx, jz) > 30000) return;
      return send(t, { t: 'hit', from: c.id, j: [Math.round(jx), Math.round(jz)], r: isFinite(r) ? Math.max(-0.35, Math.min(0.35, r)) : 0 });
    }
  }
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
  if (url === '/health') { res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); return res.end(JSON.stringify({ ok: true, online: online.size, lobbies: lobbies.size })); }
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
    if (c.sid && c.name) parked.set(c.sid, { name: c.name, guest: c.guest, car: c.car, lobbyId: c.lobby && c.lobby.id, until: Date.now() + PARK_MS });
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
setInterval(() => { const now = Date.now(); let ch = false; for (const t in sessions) if (sessions[t].exp < now) { delete sessions[t]; ch = true; } if (ch) save(SESS_FILE, sessions); }, 3600e3);

server.listen(PORT, () => console.log('Pebble Hill Derby server on http://localhost:' + PORT));
