/* =====================================================================
   Science Bowl Tracker
   Data lives in Firestore:
     roster/{id}   { name, grade, active }
     matches/{id}  v2: { version: 2, date, group, setName, round, attendance,
                         tossups: [{ n, category, red, green, bench, buzzes, bonus, benchCorrect }],
                         adjustments, redScore, greenScore, savedAt }
                   v1 (older saves) are still read for stats.
   ===================================================================== */

// ---------- Firebase ----------
const firebaseConfig = {
  apiKey: "AIzaSyDiySqCc-ksWDVOJ277AuBL1wogw3fDd3g",
  authDomain: "science-bowl-tracker.firebaseapp.com",
  projectId: "science-bowl-tracker",
  storageBucket: "science-bowl-tracker.firebasestorage.app",
  messagingSenderId: "1027133622682",
  appId: "1:1027133622682:web:1cc5d35031ee8f74bb9223"
};
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
const auth = firebase.auth();

// ---------- Constants ----------
const CATS = ['Biology', 'Chemistry', 'Earth & Space', 'Energy', 'Math', 'Physics'];
const CAT_SHORT = { 'Biology': 'Bio', 'Chemistry': 'Chem', 'Earth & Space': 'E&S', 'Energy': 'Energy', 'Math': 'Math', 'Physics': 'Phys' };
const CAT_KEYS = { b: 'Biology', c: 'Chemistry', e: 'Earth & Space', n: 'Energy', m: 'Math', p: 'Physics' };
const LEGACY_CAT = { 'Earth & Space Science': 'Earth & Space', 'Earth and Space': 'Earth & Space', 'Mathematics': 'Math', 'General Science': 'General' };
const TEAMS = ['Red', 'Green'];
const OTHER = { Red: 'Green', Green: 'Red' };
const SEATS = 5;
const MIN_HEARD = 30;          // leaderboard: below this many tossups heard = early estimate
const SHRINK_PLAYER = 10;      // how strongly a player's overall rate is pulled toward the group average
const SHRINK_CATEGORY = 6;     // how strongly a category rate is pulled toward the player's overall rate
const LIVE_KEY = 'sbt-live-v2';

// ---------- Helpers ----------
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (v, d = 0) => (v === null || v === undefined || isNaN(v)) ? '—' : (v * 100).toFixed(d) + '%';
const num = (v, d = 1) => (v === null || v === undefined || isNaN(v)) ? '—' : v.toFixed(d);
const todayStr = () => { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const normCat = c => LEGACY_CAT[c] || c || 'General';
const byName = (a, b) => a.localeCompare(b);

let toastTimer = null;
function toast(msg, bad = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show' + (bad ? ' bad' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, 2600);
}

// ---------- App state ----------
let rosterDocs = [];   // [{ id, name, grade, active }]
let matches = [];      // [{ id, ...data }]
let signedIn = false;
const filters = { group: 'All', since: '' };

const activeRoster = () => rosterDocs.filter(r => r.active !== false).map(r => r.name).sort(byName);
const rosterByName = () => Object.fromEntries(rosterDocs.map(r => [r.name, r]));

/* =====================================================================
   AUTH + LIVE DATA
   ===================================================================== */
$('signInBtn').addEventListener('click', () => {
  if (auth.currentUser) auth.signOut();
  else auth.signInWithPopup(new firebase.auth.GoogleAuthProvider()).catch(e => toast(`Sign-in failed: ${e.code}`, true));
});

let unsubRoster = null, unsubMatches = null;
auth.onAuthStateChanged(user => {
  signedIn = !!user;
  $('signInBtn').textContent = user ? `Sign out (${user.email})` : 'Sign in';
  $('signedOutNotice').style.display = user ? 'none' : 'block';
  if (unsubRoster) { unsubRoster(); unsubRoster = null; }
  if (unsubMatches) { unsubMatches(); unsubMatches = null; }

  if (!user) { rosterDocs = []; matches = []; renderAll(); return; }

  unsubRoster = db.collection('roster').onSnapshot(snap => {
    rosterDocs = [];
    snap.forEach(doc => rosterDocs.push({ id: doc.id, ...doc.data() }));
    rosterDocs.sort((a, b) => byName(a.name, b.name));
    renderAll();
  }, err => toast(`Roster: ${err.code}`, true));

  unsubMatches = db.collection('matches').onSnapshot(snap => {
    matches = [];
    snap.forEach(doc => matches.push({ id: doc.id, ...doc.data() }));
    renderAll();
  }, err => toast(`Matches: ${err.code}`, true));
});

/* =====================================================================
   TABS
   ===================================================================== */
let currentTab = 'live';
function showTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${tab}`));
  try { history.replaceState(null, '', `#${tab}`); } catch (e) { /* ignore */ }
  renderTab(tab);
}
$('tabs').addEventListener('click', e => { const b = e.target.closest('.tab'); if (b) showTab(b.dataset.tab); });

function renderTab(tab) {
  if (tab === 'live') renderLive();
  if (tab === 'leaderboard') renderLeaderboard();
  if (tab === 'categories') renderHeatmap();
  if (tab === 'builder') renderBuilderPools();
  if (tab === 'history') renderHistory();
  if (tab === 'roster') renderRoster();
}
function renderAll() {
  renderFilters();
  renderSetList();
  renderTab(currentTab);
  if (currentTab !== 'live') renderAttendance();
}

/* =====================================================================
   LIVE MATCH
   ===================================================================== */
function newTossup(category) {
  return { category: category || 'Biology', buzzes: [], phase: 'open', bonusTeam: null, benchCorrect: [] };
}
function newLive(keep) {
  return {
    attendance: keep ? keep.attendance : [],
    seats: keep ? keep.seats : { Red: Array(SEATS).fill(''), Green: Array(SEATS).fill('') },
    meta: keep ? { ...keep.meta, round: '' } : { date: todayStr(), group: 'Wednesday', setName: '', round: '' },
    tossups: [],
    cur: newTossup(keep ? keep.cur.category : 'Biology'),
    adjustments: { Red: 0, Green: 0 }
  };
}

let resumedMsg = '';
let live = loadLive();
let undoStack = [];

function loadLive() {
  try {
    const saved = JSON.parse(localStorage.getItem(LIVE_KEY));
    if (saved && saved.seats && saved.cur) {
      if (saved.tossups.length || saved.cur.buzzes.length) resumedMsg = `Resumed match in progress (${saved.tossups.length} tossups)`;
      return saved;
    }
  } catch (e) { /* ignore */ }
  return newLive();
}
function persistLive() {
  try { localStorage.setItem(LIVE_KEY, JSON.stringify(live)); } catch (e) { /* ignore */ }
}

// Every change goes through here so it can be undone and survives a refresh
function commit(mutate, msg) {
  undoStack.push(JSON.stringify(live));
  if (undoStack.length > 300) undoStack.shift();
  mutate();
  persistLive();
  renderLive();
  if (msg) toast(msg);
}
function undo() {
  if (!undoStack.length) { toast('Nothing to undo', true); return; }
  live = JSON.parse(undoStack.pop());
  persistLive();
  renderLive();
  toast('Undone');
}

const seated = team => live.seats[team].filter(Boolean);
const allSeated = () => [...seated('Red'), ...seated('Green')];
const benchNames = () => live.attendance.filter(n => !allSeated().includes(n)).sort(byName);
const teamOf = name => TEAMS.find(t => live.seats[t].includes(name)) || null;

// ----- Setup fields -----
function bindMeta(id, key) {
  $(id).addEventListener('change', () => { live.meta[key] = $(id).value.trim(); persistLive(); renderSetupSummary(); });
}
bindMeta('matchDate', 'date'); bindMeta('matchGroup', 'group'); bindMeta('setName', 'setName'); bindMeta('roundName', 'round');

function renderSetupSummary() {
  const m = live.meta;
  $('setupSummary').textContent = [m.group, m.setName, m.round].filter(Boolean).join(' · ') + ` · ${live.attendance.length} present`;
}

function renderSetList() {
  const sets = [...new Set(matches.map(m => m.setName).filter(Boolean))].sort(byName);
  $('setList').innerHTML = sets.map(s => `<option value="${esc(s)}">`).join('');
}

// ----- Attendance -----
function renderAttendance() {
  const names = [...new Set([...activeRoster(), ...live.attendance])].sort(byName);
  $('attendanceChips').innerHTML = names.length
    ? names.map(n => `<button type="button" class="chip ${live.attendance.includes(n) ? 'on' : ''}" data-name="${esc(n)}">${esc(n)}</button>`).join('')
    : `<span class="muted">${signedIn ? 'No players yet. Add them in the Roster tab.' : 'Sign in to load your roster.'}</span>`;
  $('presentCount').textContent = `(${live.attendance.length})`;
  renderSetupSummary();
}
$('attendanceChips').addEventListener('click', e => {
  const chip = e.target.closest('.chip'); if (!chip) return;
  const name = chip.dataset.name;
  commit(() => {
    if (live.attendance.includes(name)) {
      live.attendance = live.attendance.filter(n => n !== name);
      TEAMS.forEach(t => { live.seats[t] = live.seats[t].map(s => s === name ? '' : s); });
      live.cur.benchCorrect = live.cur.benchCorrect.filter(n => n !== name);
    } else {
      live.attendance.push(name);
    }
  });
});
$('presentAllBtn').addEventListener('click', () => commit(() => { live.attendance = activeRoster(); }));
$('presentNoneBtn').addEventListener('click', () => commit(() => {
  live.attendance = []; live.seats = { Red: Array(SEATS).fill(''), Green: Array(SEATS).fill('') }; live.cur.benchCorrect = [];
}));

// ----- Seats -----
function renderSeats() {
  TEAMS.forEach(team => {
    $(`seats-${team}`).innerHTML = live.seats[team].map((name, i) => {
      const taken = allSeated().filter(n => n !== name);
      const opts = live.attendance.filter(n => !taken.includes(n)).sort(byName);
      return `<select class="seat" data-team="${team}" data-i="${i}">
        <option value="">— empty seat —</option>
        ${opts.map(n => `<option value="${esc(n)}" ${n === name ? 'selected' : ''}>${esc(n)}</option>`).join('')}
      </select>`;
    }).join('');
  });
  const bench = benchNames();
  $('benchList').textContent = bench.length ? bench.join(', ') : '—';
}
document.querySelector('.lineup').addEventListener('change', e => {
  const s = e.target.closest('.seat'); if (!s) return;
  const team = s.dataset.team, i = +s.dataset.i, name = s.value;
  commit(() => {
    if (name) TEAMS.forEach(t => { live.seats[t] = live.seats[t].map(x => x === name ? '' : x); });
    live.seats[team][i] = name;
    live.cur.benchCorrect = live.cur.benchCorrect.filter(n => n !== name);
  });
});
$('clearSeatsBtn').addEventListener('click', () => commit(() => { live.seats = { Red: Array(SEATS).fill(''), Green: Array(SEATS).fill('') }; }));

// Tossups each player has been seated for today (saved matches from today + this match)
function seatedToday(name) {
  let n = 0;
  matches.forEach(m => {
    if (m.date !== live.meta.date) return;
    normalizeMatch(m).tossups.forEach(t => { if (t.red.includes(name) || t.green.includes(name) || t.seatedAll.includes(name)) n++; });
  });
  live.tossups.forEach(t => { if (t.red.includes(name) || t.green.includes(name)) n++; });
  return n;
}
$('autoSeatBtn').addEventListener('click', () => {
  if (live.attendance.length === 0) { toast('Mark who is here first', true); return; }
  const order = live.attendance
    .map(n => ({ n, played: seatedToday(n), r: Math.random() }))
    .sort((a, b) => a.played - b.played || a.r - b.r)
    .slice(0, SEATS * 2)
    .map(x => x.n)
    .sort(() => Math.random() - 0.5);
  commit(() => {
    live.seats = { Red: Array(SEATS).fill(''), Green: Array(SEATS).fill('') };
    order.forEach((n, i) => { live.seats[i % 2 ? 'Green' : 'Red'][Math.floor(i / 2)] = n; });
    live.cur.benchCorrect = live.cur.benchCorrect.filter(n => !order.includes(n));
  }, 'Seated the players with the fewest tossups today');
});

// ----- Tossup flow -----
function setCategory(cat) {
  if (live.cur.category === cat) return;
  commit(() => { live.cur.category = cat; }, `Category: ${cat}`);
}

function buzz(team, name, result) {
  const cur = live.cur;
  if (cur.phase !== 'open') { toast('Finish the bonus first', true); return; }
  if (cur.buzzes.some(b => b.team === team)) { toast(`${team} already buzzed on this tossup`, true); return; }
  const label = { correct: 'correct', neg: 'neg (interrupt)', wrong: 'wrong' }[result];
  commit(() => {
    cur.buzzes.push({ name, team, result });
    if (result === 'correct') {
      cur.phase = 'bonus';
      cur.bonusTeam = team;
    } else if (cur.buzzes.length === 2) {
      finishTossup(null); // both teams missed
    }
  }, `${name}: ${label}`);
}

function finishTossup(bonus) {
  const cur = live.cur;
  live.tossups.push({
    n: live.tossups.length + 1,
    category: cur.category,
    red: seated('Red'),
    green: seated('Green'),
    bench: benchNames(),
    buzzes: cur.buzzes,
    bonus,
    benchCorrect: cur.benchCorrect
  });
  live.cur = newTossup(cur.category);
}

function bonusResult(correct) {
  if (live.cur.phase !== 'bonus') return;
  const team = live.cur.bonusTeam;
  commit(() => finishTossup({ team, correct }), correct ? `${team} bonus +10` : `${team} missed the bonus`);
}

function deadTossup() {
  if (live.cur.phase === 'bonus') { toast('Mark the bonus as correct or missed', true); return; }
  if (allSeated().length === 0) { toast('Seat players first', true); return; }
  commit(() => finishTossup(null), live.cur.buzzes.length ? 'Tossup closed' : 'Dead tossup');
}

function toggleBenchCredit(name) {
  commit(() => {
    const bc = live.cur.benchCorrect;
    live.cur.benchCorrect = bc.includes(name) ? bc.filter(n => n !== name) : [...bc, name];
  });
}

function scores(state = live) {
  const s = { Red: state.adjustments.Red, Green: state.adjustments.Green };
  const tally = t => {
    t.buzzes.forEach(b => {
      if (b.result === 'correct') s[b.team] += 4;
      if (b.result === 'neg') s[OTHER[b.team]] += 4;
    });
    if (t.bonus && t.bonus.correct) s[t.bonus.team] += 10;
  };
  state.tossups.forEach(tally);
  if (state.cur) tally(state.cur);
  return s;
}

// ----- Render console -----
function renderLive() {
  const m = live.meta;
  $('matchDate').value = m.date || todayStr();
  $('matchGroup').value = m.group || 'Wednesday';
  $('setName').value = m.setName || '';
  $('roundName').value = m.round || '';
  renderAttendance();
  renderSeats();

  const cur = live.cur;
  const sc = scores();
  $('scoreRed').textContent = sc.Red;
  $('scoreGreen').textContent = sc.Green;
  $('tuNum').textContent = `Tossup ${live.tossups.length + 1} · ${cur.category}`;
  const buzzed = cur.buzzes.map(b => b.team);
  $('tuPhase').textContent = cur.phase === 'bonus'
    ? `${cur.bonusTeam} bonus`
    : buzzed.length ? `Rebound: ${OTHER[buzzed[0]]} may buzz` : 'Read the tossup';

  $('catRow').innerHTML = CATS.map(c => {
    const key = Object.keys(CAT_KEYS).find(k => CAT_KEYS[k] === c).toUpperCase();
    return `<button type="button" class="cat ${c === cur.category ? 'on' : ''}" data-cat="${esc(c)}">${esc(c)} <kbd>${key}</kbd></button>`;
  }).join('');

  TEAMS.forEach(team => {
    const locked = cur.phase !== 'open' || buzzed.includes(team);
    const rows = seated(team).map(name => {
      const b = cur.buzzes.find(x => x.name === name);
      const tag = b ? `<span class="tag ${b.result}">${b.result === 'correct' ? '✓' : b.result === 'neg' ? 'NEG' : '✗'}</span>` : '';
      return `<div class="buzz-row">
        <span class="buzz-name">${esc(name)} ${tag}</span>
        <span class="buzz-btns">
          <button type="button" class="bz correct" data-team="${team}" data-name="${esc(name)}" data-r="correct" ${locked ? 'disabled' : ''} title="Correct (+4)">✓</button>
          <button type="button" class="bz neg" data-team="${team}" data-name="${esc(name)}" data-r="neg" ${locked ? 'disabled' : ''} title="Interrupted and wrong (other team +4)">Neg</button>
          <button type="button" class="bz wrong" data-team="${team}" data-name="${esc(name)}" data-r="wrong" ${locked ? 'disabled' : ''} title="Wrong after the question was finished (no penalty)">✗</button>
        </span>
      </div>`;
    });
    $(`buzz-${team}`).innerHTML = `<h3>${team}${locked && cur.phase === 'open' ? ' <span class="muted small">(buzzed)</span>' : ''}</h3>` +
      (rows.length ? rows.join('') : '<p class="muted small">No one seated</p>');
  });

  $('bonusPanel').classList.toggle('hidden', cur.phase !== 'bonus');
  if (cur.phase === 'bonus') {
    $('bonusLabel').textContent = `${cur.bonusTeam} bonus (${cur.category})`;
    $('bonusPanel').className = `bonus-panel ${cur.bonusTeam.toLowerCase()}`;
  }

  const bench = benchNames();
  $('benchChips').innerHTML = bench.length
    ? bench.map(n => `<button type="button" class="chip ${cur.benchCorrect.includes(n) ? 'on' : ''}" data-name="${esc(n)}">${esc(n)}</button>`).join('')
    : '<span class="muted small">No one on the bench</span>';

  $('deadBtn').disabled = cur.phase === 'bonus';
  $('undoBtn').disabled = undoStack.length === 0;
  renderLog();
}

function describeTossup(t, isCurrent) {
  const parts = t.buzzes.map(b => `${esc(b.name)} <span class="tag ${b.result}">${b.result === 'correct' ? '✓' : b.result === 'neg' ? 'NEG' : '✗'}</span>`);
  if (!parts.length && !isCurrent) parts.push('<span class="muted">dead</span>');
  if (t.bonus) parts.push(`bonus ${t.bonus.correct ? '<span class="tag correct">+10</span>' : '<span class="tag wrong">missed</span>'}`);
  if (t.benchCorrect && t.benchCorrect.length) parts.push(`<span class="muted">bench: ${t.benchCorrect.map(esc).join(', ')}</span>`);
  return parts.join(' · ');
}
function renderLog() {
  const rows = live.tossups.slice(-6).reverse().map(t =>
    `<div class="log-row"><b>TU ${t.n}</b> <span class="cat-pill">${esc(CAT_SHORT[t.category] || t.category)}</span> ${describeTossup(t)}</div>`);
  $('matchLog').innerHTML = rows.length ? `<h3>Recent tossups</h3>${rows.join('')}` : '';
}

// ----- Console events -----
$('catRow').addEventListener('click', e => { const b = e.target.closest('.cat'); if (b) setCategory(b.dataset.cat); });
['buzz-Red', 'buzz-Green'].forEach(id => $(id).addEventListener('click', e => {
  const b = e.target.closest('.bz'); if (b && !b.disabled) buzz(b.dataset.team, b.dataset.name, b.dataset.r);
}));
$('bonusYes').addEventListener('click', () => bonusResult(true));
$('bonusNo').addEventListener('click', () => bonusResult(false));
$('deadBtn').addEventListener('click', deadTossup);
$('undoBtn').addEventListener('click', undo);
$('benchChips').addEventListener('click', e => { const c = e.target.closest('.chip'); if (c) toggleBenchCredit(c.dataset.name); });
document.querySelectorAll('[data-adj]').forEach(b => b.addEventListener('click', () => {
  const team = b.dataset.adj, d = +b.dataset.delta;
  commit(() => { live.adjustments[team] += d; }, `${team} ${d > 0 ? '+' : ''}${d}`);
}));

document.addEventListener('keydown', e => {
  if (currentTab !== 'live' || e.ctrlKey || e.metaKey || e.altKey) return;
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
  const k = e.key.toLowerCase();
  if (CAT_KEYS[k]) { setCategory(CAT_KEYS[k]); e.preventDefault(); }
  else if (k === 'd') { deadTossup(); e.preventDefault(); }
  else if (k === 'u') { undo(); e.preventDefault(); }
  else if (k === 'y') { bonusResult(true); e.preventDefault(); }
  else if (k === 'x') { bonusResult(false); e.preventDefault(); }
});

// ----- Save / discard -----
$('saveMatchBtn').addEventListener('click', async () => {
  if (!signedIn) { toast('Sign in to save', true); return; }
  const m = live.meta;
  if (!m.setName) { toast('Enter the question set first', true); $('setupCard').open = true; $('setName').focus(); return; }

  // Close out a tossup that's in progress
  const state = JSON.parse(JSON.stringify(live));
  if (state.cur.buzzes.length || state.cur.benchCorrect.length) {
    const saveLive = live; live = state; finishTossup(null); live = saveLive;
  }
  if (!state.tossups.length) { toast('No tossups recorded yet', true); return; }

  const sc = scores({ ...state, cur: null });
  const doc = {
    version: 2,
    date: m.date || todayStr(),
    group: m.group || 'Other',
    setName: m.setName,
    round: m.round || '',
    attendance: state.attendance,
    tossups: state.tossups,
    adjustments: state.adjustments,
    redScore: sc.Red,
    greenScore: sc.Green,
    savedAt: Date.now()
  };
  try {
    await db.collection('matches').add(doc);
  } catch (err) {
    toast(`NOT saved: ${err.code || err.message}`, true);
    return;
  }
  live = newLive(live);
  undoStack = [];
  persistLive();
  renderLive();
  toast(`Saved: ${doc.tossups.length} tossups, Red ${doc.redScore} – Green ${doc.greenScore}`);
});

$('discardMatchBtn').addEventListener('click', () => {
  if (!live.tossups.length && !live.cur.buzzes.length) { toast('Nothing to discard'); return; }
  if (!confirm(`Discard this match (${live.tossups.length} tossups)? This can't be undone.`)) return;
  live = newLive(live);
  undoStack = [];
  persistLive();
  renderLive();
  toast('Match discarded');
});

/* =====================================================================
   STATS
   ===================================================================== */

// Convert any saved match (v2, v1, or the oldest format) into one shape
function normalizeMatch(m) {
  const out = { id: m.id, date: m.date || '', group: m.group || 'Other', setName: m.setName || '', round: m.round || '',
    attendance: [], tossups: [], loose: [], version: m.version || 1, raw: m };

  if (m.version === 2) {
    out.attendance = m.attendance || [];
    out.tossups = (m.tossups || []).map(t => ({
      category: normCat(t.category), red: t.red || [], green: t.green || [], seatedAll: [...(t.red || []), ...(t.green || [])],
      bench: t.bench || [], buzzes: t.buzzes || [], bonus: t.bonus || null, benchCorrect: t.benchCorrect || []
    }));
    return out;
  }

  // v1: individual events + (sometimes) a log of who heard each tossup, no buzz order
  const resultOf = { correct: 'correct', interrupt: 'neg', incorrect: 'wrong' };
  if (Array.isArray(m.events)) {
    m.events.forEach(e => out.loose.push({ name: e.name, result: resultOf[e.type] || 'wrong', category: normCat(e.category) }));
  } else if (Array.isArray(m.players)) {
    m.players.forEach(p => {
      if (typeof p !== 'object') return;
      for (let i = 0; i < (p.correct || 0); i++) out.loose.push({ name: p.name, result: 'correct', category: normCat(m.category) });
      for (let i = 0; i < (p.interrupts || 0); i++) out.loose.push({ name: p.name, result: 'neg', category: normCat(m.category) });
      for (let i = 0; i < (p.incorrects || 0); i++) out.loose.push({ name: p.name, result: 'wrong', category: normCat(m.category) });
    });
  }
  if (Array.isArray(m.tossupLog)) {
    out.tossups = m.tossupLog.map(t => ({ category: normCat(t.category), red: [], green: [], seatedAll: t.players || [],
      bench: [], buzzes: [], bonus: null, benchCorrect: [] }));
  }
  const names = new Set(out.loose.map(l => l.name));
  if (Array.isArray(m.players)) m.players.forEach(p => names.add(typeof p === 'string' ? p : p.name));
  out.tossups.forEach(t => t.seatedAll.forEach(n => names.add(n)));
  out.attendance = [...names];
  return out;
}

function filteredMatches(f = filters) {
  return matches.map(normalizeMatch).filter(m =>
    (f.group === 'All' || m.group === f.group) && (!f.since || m.date >= f.since));
}

function blankCat() { return { heard: 0, correct: 0, neg: 0, wrong: 0, benchHeard: 0, benchCorrect: 0 }; }
function blankStats(name) {
  return { name, practices: new Set(), matches: 0, heard: 0, buzzes: 0, correct: 0, neg: 0, wrong: 0,
    trackedPts: 0, trackedBuzzes: 0, benchHeard: 0, benchCorrect: 0, bonusHeard: 0, bonusCorrect: 0,
    cat: Object.fromEntries(CATS.map(c => [c, blankCat()])) };
}

function aggregate(ms) {
  const S = {};
  const get = n => (S[n] = S[n] || blankStats(n));
  const catOf = (s, c) => s.cat[c] || (s.cat[c] = blankCat());

  ms.forEach(m => {
    const inMatch = new Set();
    m.attendance.forEach(n => get(n).practices.add(m.date));

    m.tossups.forEach(t => {
      t.seatedAll.forEach(n => { const s = get(n); s.heard++; catOf(s, t.category).heard++; inMatch.add(n); });
      t.bench.forEach(n => { const s = get(n); s.benchHeard++; catOf(s, t.category).benchHeard++; });
      t.benchCorrect.forEach(n => { const s = get(n); s.benchCorrect++; catOf(s, t.category).benchCorrect++; });
      t.buzzes.forEach(b => {
        const s = get(b.name), c = catOf(s, t.category);
        s.buzzes++; s.trackedBuzzes++; s[b.result]++; c[b.result]++;
        if (b.result === 'correct') s.trackedPts += 4;
        if (b.result === 'neg') s.trackedPts -= 4;
      });
      if (t.bonus && typeof t.bonus.correct === 'boolean') {
        (t.bonus.team === 'Red' ? t.red : t.green).forEach(n => { const s = get(n); s.bonusHeard++; if (t.bonus.correct) s.bonusCorrect++; });
      }
    });

    m.loose.forEach(l => { const s = get(l.name); s.buzzes++; s[l.result]++; catOf(s, l.category)[l.result]++; inMatch.add(l.name); });
    inMatch.forEach(n => get(n).matches++);
  });

  // Knowledge model: "knew it" = seated correct + bench written correct, out of tossups seen
  let gKnown = 0, gSeen = 0;
  Object.values(S).forEach(s => {
    s.known = 0; s.seen = 0;
    CATS.forEach(c => { const x = s.cat[c]; s.known += x.correct + x.benchCorrect; s.seen += x.heard + x.benchHeard; });
    gKnown += s.known; gSeen += s.seen;
  });
  const groupRate = gSeen ? gKnown / gSeen : 0.25;

  Object.values(S).forEach(s => {
    s.pp10 = s.heard ? 10 * s.trackedPts / s.heard : null;
    s.accuracy = s.buzzes ? s.correct / s.buzzes : null;
    s.negRate = s.buzzes ? s.neg / s.buzzes : null;
    s.buzzRate = s.heard ? s.trackedBuzzes / s.heard : null;
    s.benchRate = s.benchHeard ? s.benchCorrect / s.benchHeard : null;
    s.overall = (s.known + SHRINK_PLAYER * groupRate) / (s.seen + SHRINK_PLAYER);
    s.q = {}; s.raw = {};
    CATS.forEach(c => {
      const x = s.cat[c], k = x.correct + x.benchCorrect, n = x.heard + x.benchHeard;
      s.raw[c] = { k, n };
      s.q[c] = (k + SHRINK_CATEGORY * s.overall) / (n + SHRINK_CATEGORY);
    });
    const best = CATS.filter(c => s.raw[c].n >= 3).sort((a, b) => s.q[b] - s.q[a])[0];
    s.bestCat = best || null;
  });
  return S;
}

// Stats object for a roster player with no data yet
function emptyDerived(n) {
  return Object.assign(blankStats(n), { known: 0, seen: 0, pp10: null, accuracy: null, negRate: null, buzzRate: null, benchRate: null,
    overall: null, bestCat: null, q: {}, raw: Object.fromEntries(CATS.map(c => [c, { k: 0, n: 0 }])) });
}

/* ---------- Filters (shared by all stats tabs) ---------- */
function renderFilters() {
  const groups = ['All', ...new Set(['Wednesday', 'Thursday', 'Other', ...matches.map(m => m.group).filter(Boolean)])];
  document.querySelectorAll('.groupFilter').forEach(sel => {
    sel.innerHTML = groups.map(g => `<option value="${esc(g)}" ${g === filters.group ? 'selected' : ''}>${g === 'All' ? 'All groups' : esc(g)}</option>`).join('');
  });
  document.querySelectorAll('.sinceFilter').forEach(inp => { inp.value = filters.since; });
  document.querySelectorAll('.minHeardLabel').forEach(s => { s.textContent = MIN_HEARD; });
}
document.addEventListener('change', e => {
  if (e.target.classList.contains('groupFilter')) { filters.group = e.target.value; renderFilters(); renderTab(currentTab); }
  if (e.target.classList.contains('sinceFilter')) { filters.since = e.target.value; renderFilters(); renderTab(currentTab); }
});

/* ---------- Leaderboard ---------- */
const LB_COLS = [
  { key: 'name', label: 'Player', get: s => s.name, fmt: (v, s) => `<b>${esc(v)}</b>${s.inactive ? ' <span class="muted small">(inactive)</span>' : ''}` },
  { key: 'grade', label: 'Gr', get: s => s.grade || '', fmt: v => esc(v) },
  { key: 'practices', label: 'Days', get: s => s.practices.size, title: 'Practices attended' },
  { key: 'heard', label: 'TU heard', get: s => s.heard, title: 'Tossups heard while seated' },
  { key: 'correct', label: 'Correct', get: s => s.correct },
  { key: 'neg', label: 'Negs', get: s => s.neg, title: 'Interrupted and wrong (other team +4)' },
  { key: 'wrong', label: 'Wrong', get: s => s.wrong, title: 'Wrong after the question was read (no penalty)' },
  { key: 'pp10', label: 'Pts / 10 TU', get: s => s.pp10, fmt: v => `<b>${num(v)}</b>`, title: 'Tossup points per 10 tossups heard while seated' },
  { key: 'accuracy', label: 'Accuracy', get: s => s.accuracy, fmt: v => pct(v), title: 'Correct / buzzes' },
  { key: 'negRate', label: 'Neg %', get: s => s.negRate, fmt: v => pct(v), title: 'Negs / buzzes. High = buzzing too early' },
  { key: 'buzzRate', label: 'Buzz %', get: s => s.buzzRate, fmt: v => pct(v), title: 'Share of tossups heard that they buzzed on' },
  { key: 'benchRate', label: 'Bench', get: s => s.benchRate, fmt: (v, s) => s.benchHeard ? `${pct(v)} <span class="muted small">${s.benchCorrect}/${s.benchHeard}</span>` : '—', title: 'Written answers correct while on the bench' },
  { key: 'bestCat', label: 'Best category', get: s => s.bestCat || '', fmt: v => v ? esc(v) : '—' }
];
let lbSort = { key: 'pp10', dir: -1 };

function leaderboardRows() {
  const S = aggregate(filteredMatches());
  const R = rosterByName();
  activeRoster().forEach(n => { if (!S[n]) S[n] = emptyDerived(n); });
  return Object.values(S).map(s => Object.assign(s, { grade: R[s.name]?.grade || '', inactive: R[s.name]?.active === false }))
    .filter(s => !s.inactive || s.heard || s.buzzes);
}

function renderLeaderboard() {
  const rows = leaderboardRows();
  const col = LB_COLS.find(c => c.key === lbSort.key);
  rows.sort((a, b) => {
    if (lbSort.key === 'pp10') {
      const qa = a.heard >= MIN_HEARD, qb = b.heard >= MIN_HEARD;
      if (qa !== qb) return qa ? -1 : 1;
    }
    const va = col.get(a), vb = col.get(b);
    if (va === null && vb === null) return byName(a.name, b.name);
    if (va === null) return 1;
    if (vb === null) return -1;
    if (typeof va === 'string') return lbSort.dir * va.localeCompare(vb) || byName(a.name, b.name);
    return lbSort.dir * (va - vb) || byName(a.name, b.name);
  });

  const head = `<tr><th>#</th>${LB_COLS.map(c =>
    `<th data-key="${c.key}" title="${esc(c.title || '')}" class="sortable ${c.key === lbSort.key ? 'sorted' : ''}">${c.label}${c.key === lbSort.key ? (lbSort.dir < 0 ? ' ▾' : ' ▴') : ''}</th>`).join('')}</tr>`;
  const body = rows.map((s, i) => `<tr class="${s.heard < MIN_HEARD ? 'low-sample' : ''}"><td>${i + 1}</td>${LB_COLS.map(c => {
    const v = c.get(s);
    return `<td>${c.fmt ? c.fmt(v, s) : (v ?? '—')}</td>`;
  }).join('')}</tr>`).join('');
  $('lbTable').innerHTML = `<thead>${head}</thead><tbody>${body || `<tr><td colspan="${LB_COLS.length + 1}" class="muted">No data yet</td></tr>`}</tbody>`;
}
$('lbTable').addEventListener('click', e => {
  const th = e.target.closest('th.sortable'); if (!th) return;
  const key = th.dataset.key;
  lbSort = { key, dir: lbSort.key === key ? -lbSort.dir : (key === 'name' || key === 'grade' || key === 'negRate' || key === 'wrong' || key === 'neg' ? 1 : -1) };
  renderLeaderboard();
});

$('exportCsvBtn').addEventListener('click', () => {
  const rows = leaderboardRows();
  const header = ['Player', 'Grade', 'Days', 'TU heard', 'Buzzes', 'Correct', 'Negs', 'Wrong', 'Pts/10 TU', 'Accuracy', 'Neg %', 'Buzz %',
    'Bench correct', 'Bench heard', 'Team bonus correct', 'Team bonus heard', ...CATS.map(c => `${c} known`), ...CATS.map(c => `${c} seen`), ...CATS.map(c => `${c} est %`)];
  const r = v => (v === null || v === undefined) ? '' : (typeof v === 'number' ? +v.toFixed(4) : v);
  const lines = rows.map(s => [s.name, s.grade, s.practices.size, s.heard, s.buzzes, s.correct, s.neg, s.wrong, r(s.pp10), r(s.accuracy), r(s.negRate), r(s.buzzRate),
    s.benchCorrect, s.benchHeard, s.bonusCorrect, s.bonusHeard, ...CATS.map(c => s.raw[c].k), ...CATS.map(c => s.raw[c].n), ...CATS.map(c => r(s.q[c]))]);
  const csv = [header, ...lines].map(row => row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `science-bowl-stats-${todayStr()}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
});

/* ---------- Category heatmap ---------- */
function heatColor(v) {
  // 0% -> light, 60%+ -> strong blue
  const t = Math.max(0, Math.min(1, v / 0.6));
  return `hsl(214, 85%, ${96 - t * 50}%)`;
}
function renderHeatmap() {
  const S = aggregate(filteredMatches());
  const R = rosterByName();
  const rows = Object.values(S).filter(s => s.seen > 0 && R[s.name]?.active !== false).sort((a, b) => b.overall - a.overall);
  const head = `<tr><th>Player</th><th title="Estimated across all categories">Overall</th>${CATS.map(c => `<th>${esc(c)}</th>`).join('')}</tr>`;
  const body = rows.map(s => `<tr><td><b>${esc(s.name)}</b></td>
    <td class="cell" style="background:${heatColor(s.overall)}">${pct(s.overall)}<span>${s.known}/${s.seen}</span></td>
    ${CATS.map(c => {
      const v = s.q[c], raw = s.raw[c];
      return `<td class="cell ${raw.n === 0 ? 'nodata' : ''}" style="background:${heatColor(v)}" title="${esc(s.name)} · ${esc(c)}: knew ${raw.k} of ${raw.n}">${pct(v)}<span>${raw.k}/${raw.n}</span></td>`;
    }).join('')}</tr>`).join('');
  $('heatTable').innerHTML = `<thead>${head}</thead><tbody>${body || `<tr><td colspan="8" class="muted">No data yet</td></tr>`}</tbody>`;
}

/* ---------- Team Builder ---------- */
const builderState = {}; // name -> 'lock' | 'exclude'
const customPick = new Set();

function coverage(team, S) {
  const perCat = {};
  CATS.forEach(c => { perCat[c] = 1 - team.reduce((p, n) => p * (1 - S[n].q[c]), 1); });
  return { perCat, avg: CATS.reduce((a, c) => a + perCat[c], 0) / CATS.length };
}

function renderBuilderPools() {
  const S = aggregate(filteredMatches());
  const names = activeRoster().filter(n => S[n] && S[n].seen > 0);
  $('builderPool').innerHTML = names.length ? names.map(n => {
    const st = builderState[n] || '';
    return `<button type="button" class="chip ${st}" data-name="${esc(n)}" title="${st === 'lock' ? 'Locked in' : st === 'exclude' ? 'Excluded' : 'Available'}">${st === 'lock' ? '🔒 ' : st === 'exclude' ? '⨯ ' : ''}${esc(n)} <span class="muted small">${S[n].seen}</span></button>`;
  }).join('') : '<span class="muted">No practice data yet.</span>';
  $('customPool').innerHTML = names.map(n => `<button type="button" class="chip ${customPick.has(n) ? 'on' : ''}" data-name="${esc(n)}">${esc(n)}</button>`).join('');
  renderCustom(S);
}
$('builderPool').addEventListener('click', e => {
  const c = e.target.closest('.chip'); if (!c) return;
  const n = c.dataset.name, st = builderState[n];
  builderState[n] = !st ? 'lock' : st === 'lock' ? 'exclude' : undefined;
  if (!builderState[n]) delete builderState[n];
  renderBuilderPools();
});
$('customPool').addEventListener('click', e => {
  const c = e.target.closest('.chip'); if (!c) return;
  const n = c.dataset.name;
  if (customPick.has(n)) customPick.delete(n);
  else if (customPick.size < 5) customPick.add(n);
  else toast('Up to 5 players', true);
  renderBuilderPools();
});

function coverageBars(cov, S, team) {
  return `<div class="bars">${CATS.map(c => {
    const best = team.slice().sort((a, b) => S[b].q[c] - S[a].q[c])[0];
    return `<div class="bar-row"><span class="bar-label">${esc(c)}</span>
      <span class="bar"><span style="width:${(cov.perCat[c] * 100).toFixed(0)}%"></span></span>
      <span class="bar-val">${pct(cov.perCat[c])}</span><span class="muted small">top: ${esc(best)}</span></div>`;
  }).join('')}</div>`;
}

function renderCustom(S) {
  const team = [...customPick].filter(n => S[n]);
  if (!team.length) { $('customResult').innerHTML = ''; return; }
  const cov = coverage(team, S);
  $('customResult').innerHTML = `<p><b>Coverage: ${pct(cov.avg)}</b></p>${coverageBars(cov, S, team)}`;
}

function* combos(arr, k, start = 0, acc = []) {
  if (acc.length === k) { yield acc.slice(); return; }
  for (let i = start; i <= arr.length - (k - acc.length); i++) { acc.push(arr[i]); yield* combos(arr, k, i + 1, acc); acc.pop(); }
}

$('runBuilderBtn').addEventListener('click', () => {
  const S = aggregate(filteredMatches());
  const minSeen = Math.max(0, +$('builderMinHeard').value || 0);
  const locked = Object.keys(builderState).filter(n => builderState[n] === 'lock' && S[n]);
  const pool = activeRoster().filter(n => S[n] && S[n].seen >= minSeen && builderState[n] !== 'exclude' && !locked.includes(n));
  const need = 4 - locked.length;
  if (need < 0) { $('builderResults').innerHTML = '<p class="bad-text">Lock at most 4 players.</p>'; return; }
  if (pool.length < need) { $('builderResults').innerHTML = `<p class="bad-text">Only ${pool.length + locked.length} eligible players. Lower "Min tossups heard" or collect more data.</p>`; return; }

  const top = [];
  for (const pick of combos(pool, need)) {
    const team = [...locked, ...pick];
    const avg = coverage(team, S).avg;
    if (top.length < 5 || avg > top[top.length - 1].avg) {
      top.push({ team, avg });
      top.sort((a, b) => b.avg - a.avg);
      if (top.length > 5) top.pop();
    }
  }

  const altPool = activeRoster().filter(n => S[n] && S[n].seen >= minSeen && builderState[n] !== 'exclude');
  const html = top.map((t, i) => {
    // Alternate: the player whose best single swap into the lineup keeps coverage highest
    let alt = null;
    altPool.filter(n => !t.team.includes(n)).forEach(x => {
      t.team.filter(n => !locked.includes(n)).forEach(out => {
        const v = coverage(t.team.map(n => n === out ? x : n), S).avg;
        if (!alt || v > alt.v) alt = { x, out, v };
      });
    });
    const cov = coverage(t.team, S);
    const sorted = t.team.slice().sort((a, b) => S[b].overall - S[a].overall);
    return `<div class="lineup-card ${i === 0 ? 'best' : ''}">
      <div class="row-between wrap"><h3>${i === 0 ? 'Best lineup' : `Option ${i + 1}`} · coverage ${pct(t.avg, 1)}</h3></div>
      <div class="chips">${sorted.map(n => `<span class="chip on static">${locked.includes(n) ? '🔒 ' : ''}${esc(n)} <span class="small">${num(S[n].pp10)} pts/10</span></span>`).join('')}
        ${alt ? `<span class="chip static alt">Alternate: ${esc(alt.x)} <span class="small">(best swap: for ${esc(alt.out)} → ${pct(alt.v, 1)})</span></span>` : ''}</div>
      ${i === 0 ? coverageBars(cov, S, t.team) : ''}
    </div>`;
  }).join('');
  $('builderResults').innerHTML = html + `<p class="muted small">Considered ${pool.length + locked.length} players with at least ${minSeen} tossups seen. Estimates get more reliable with more practices; keep reshuffling teams so no one's numbers depend on their teammates.</p>`;
});

/* =====================================================================
   HISTORY
   ===================================================================== */
const openHistory = new Set();
function fmtDate(d) {
  if (!d) return 'No date';
  const [y, m, day] = d.split('-').map(Number);
  return new Date(y, m - 1, day).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}
function renderHistory() {
  const ms = filteredMatches({ group: filters.group, since: '' })
    .sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.raw.savedAt || 0) - (a.raw.savedAt || 0));
  if (!ms.length) { $('historyList').innerHTML = '<p class="muted">No matches saved yet.</p>'; return; }

  $('historyList').innerHTML = ms.map(m => {
    const r = m.raw;
    const title = [m.setName || '(no set)', m.round].filter(Boolean).join(' · ');
    const score = (r.redScore !== undefined) ? `Red ${r.redScore} – Green ${r.greenScore}` : '';
    const tuCount = m.tossups.length ? `${m.tossups.length} TU` : `${m.loose.length} buzzes`;
    const isOpen = openHistory.has(m.id);
    let detail = '';
    if (isOpen) {
      if (m.version === 2) {
        detail = `<div class="table-scroll"><table class="small-table"><thead><tr><th>#</th><th>Category</th><th>What happened</th><th>Red</th><th>Green</th></tr></thead><tbody>
          ${m.tossups.map((t, i) => `<tr><td>${i + 1}</td><td>${esc(t.category)}</td><td>${describeTossup(t)}</td>
            <td class="small">${t.red.map(esc).join(', ')}</td><td class="small">${t.green.map(esc).join(', ')}</td></tr>`).join('')}
        </tbody></table></div>
        <p class="small muted">Present: ${m.attendance.map(esc).join(', ') || '—'}</p>`;
      } else {
        detail = `<p class="small muted">Saved with an older version of the tracker: individual answers were recorded, but not buzz order or bonuses.</p>`;
      }
    }
    return `<div class="hist-item">
      <div class="row-between wrap">
        <button type="button" class="hist-toggle" data-id="${esc(m.id)}">${isOpen ? '▾' : '▸'} <b>${esc(fmtDate(m.date))}</b> · ${esc(m.group)} · ${esc(title)}</button>
        <span class="muted small">${tuCount}${score ? ' · ' + score : ''}
          <button type="button" class="btn btn-small btn-ghost danger" data-del="${esc(m.id)}">Delete</button></span>
      </div>${detail}</div>`;
  }).join('');
}
$('historyList').addEventListener('click', async e => {
  const t = e.target.closest('.hist-toggle');
  if (t) { openHistory.has(t.dataset.id) ? openHistory.delete(t.dataset.id) : openHistory.add(t.dataset.id); renderHistory(); return; }
  const d = e.target.closest('[data-del]');
  if (d) {
    const m = matches.find(x => x.id === d.dataset.del);
    if (!confirm(`Delete the ${m?.date || ''} match "${m?.setName || ''} ${m?.round || ''}"? Its stats will be removed. This can't be undone.`)) return;
    try { await db.collection('matches').doc(d.dataset.del).delete(); toast('Match deleted'); }
    catch (err) { toast(`Delete failed: ${err.code}`, true); }
  }
});

/* =====================================================================
   ROSTER
   ===================================================================== */
const GRADE_WORDS = { freshman: '9', sophomore: '10', junior: '11', senior: '12', '9th': '9', '10th': '10', '11th': '11', '12th': '12' };
function parseGrade(s) {
  const t = String(s || '').trim().toLowerCase();
  if (GRADE_WORDS[t]) return GRADE_WORDS[t];
  return /^(9|10|11|12)$/.test(t) ? t : null;
}
function parseLine(line) {
  const parts = line.split(',').map(x => x.trim()).filter(Boolean);
  if (!parts.length) return null;
  let grade = '';
  if (parts.length > 1 && parseGrade(parts[parts.length - 1]) !== null) grade = parseGrade(parts.pop());
  const name = parts.length >= 2 ? `${parts[1]} ${parts[0]}` : parts[0]; // "Last, First" -> "First Last"
  return { name: name.replace(/\s+/g, ' ').trim(), grade };
}

$('bulkAddBtn').addEventListener('click', async () => {
  if (!signedIn) { toast('Sign in first', true); return; }
  const existing = new Set(rosterDocs.map(r => r.name.toLowerCase()));
  const toAdd = [], skipped = [];
  $('bulkAdd').value.split('\n').map(parseLine).filter(Boolean).forEach(p => {
    if (existing.has(p.name.toLowerCase())) skipped.push(p.name);
    else { existing.add(p.name.toLowerCase()); toAdd.push(p); }
  });
  if (!toAdd.length) { toast(skipped.length ? 'Those players are already on the roster' : 'Nothing to add', true); return; }
  try {
    const batch = db.batch();
    toAdd.forEach(p => batch.set(db.collection('roster').doc(), { name: p.name, grade: p.grade, active: true }));
    await batch.commit();
    $('bulkAdd').value = '';
    toast(`Added ${toAdd.length} player${toAdd.length > 1 ? 's' : ''}${skipped.length ? ` (skipped ${skipped.length} already on roster)` : ''}`);
  } catch (err) { toast(`Add failed: ${err.code}`, true); }
});

function renderRoster() {
  const S = aggregate(matches.map(normalizeMatch));
  if (!rosterDocs.length) { $('rosterTable').innerHTML = `<tbody><tr><td class="muted">${signedIn ? 'No players yet.' : 'Sign in to see the roster.'}</td></tr></tbody>`; return; }
  const rows = rosterDocs.map(r => {
    const s = S[r.name];
    const hasData = s && (s.heard || s.buzzes || s.benchHeard);
    return `<tr class="${r.active === false ? 'low-sample' : ''}">
      <td><b>${esc(r.name)}</b></td>
      <td><select data-grade="${esc(r.id)}">${['', '9', '10', '11', '12'].map(g => `<option value="${g}" ${String(r.grade || '') === g ? 'selected' : ''}>${g || '—'}</option>`).join('')}</select></td>
      <td><label class="inline"><input type="checkbox" data-active="${esc(r.id)}" ${r.active !== false ? 'checked' : ''}/> Active</label></td>
      <td>${s ? s.practices.size : 0} days · ${s ? s.heard : 0} TU</td>
      <td>${hasData ? '' : `<button type="button" class="btn btn-small btn-ghost danger" data-remove="${esc(r.id)}">Remove</button>`}</td>
    </tr>`;
  }).join('');
  $('rosterTable').innerHTML = `<thead><tr><th>Name</th><th>Grade</th><th>Status</th><th>Data</th><th></th></tr></thead><tbody>${rows}</tbody>`;
}
$('rosterTable').addEventListener('change', async e => {
  try {
    if (e.target.dataset.grade) await db.collection('roster').doc(e.target.dataset.grade).update({ grade: e.target.value });
    if (e.target.dataset.active) await db.collection('roster').doc(e.target.dataset.active).update({ active: e.target.checked });
  } catch (err) { toast(`Update failed: ${err.code}`, true); }
});
$('rosterTable').addEventListener('click', async e => {
  const b = e.target.closest('[data-remove]'); if (!b) return;
  const r = rosterDocs.find(x => x.id === b.dataset.remove);
  if (!confirm(`Remove ${r?.name} from the roster?`)) return;
  try { await db.collection('roster').doc(b.dataset.remove).delete(); toast('Removed'); }
  catch (err) { toast(`Remove failed: ${err.code}`, true); }
});

/* =====================================================================
   START
   ===================================================================== */
renderFilters();
if (resumedMsg) toast(resumedMsg);
showTab(['live', 'leaderboard', 'categories', 'builder', 'history', 'roster'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'live');
