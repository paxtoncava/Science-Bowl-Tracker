// 1. Firebase Credentials Setup
const firebaseConfig = {
  apiKey: "AIzaSyDiySqCc-ksWDVOJ277AuBL1wogw3fDd3g",
  authDomain: "science-bowl-tracker.firebaseapp.com",
  projectId: "science-bowl-tracker",
  storageBucket: "science-bowl-tracker.firebasestorage.app",
  messagingSenderId: "1027133622682",
  appId: "1:1027133622682:web:1cc5d35031ee8f74bb9223"
};

// Initialize Firebase & Database
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
const auth = firebase.auth();

// Players need at least this many matches to be ranked normally on the leaderboard
const MIN_MATCHES_FOR_RANKING = 3;

// Global State
let roster = [];
let globalMatches = [];
let actionHistory = []; // Stack for undo functionality
let liveStats = {}; // cardId -> list of tossup actions (each action keeps its own playerName)
let teamBonuses = { Red: 0, Green: 0 }; // Bonus counters (+10)
let teamPenalties = { Red: 0, Green: 0 }; // Score adjustment counters (+4 / -4)
let tossupLog = []; // One entry per completed tossup: { category, difficulty, players: [seated names] }
let seenPlayers = new Set(); // Everyone who sat in a slot at any point during the live match
let activeCategory = "General Science";
let activeDifficulty = "Easy";

// Escape text before inserting it into HTML
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// ---------- Sign-in & live data ----------
const signInBtn = document.getElementById('signInBtn');

signInBtn.addEventListener('click', () => {
  if (auth.currentUser) auth.signOut();
  else auth.signInWithPopup(new firebase.auth.GoogleAuthProvider());
});

let unsubRoster = null, unsubMatches = null;

auth.onAuthStateChanged(user => {
  signInBtn.textContent = user ? `Sign out (${user.email})` : 'Sign in';

  // stop old listeners
  if (unsubRoster) { unsubRoster(); unsubRoster = null; }
  if (unsubMatches) { unsubMatches(); unsubMatches = null; }

  if (!user) {
    roster = []; globalMatches = [];
    renderPlayerDropdowns(); renderLeaderboards([]);
    return;
  }

  unsubRoster = db.collection("roster").onSnapshot(snapshot => {
    roster = [];
    snapshot.forEach(doc => roster.push(doc.data().name));
    roster.sort();
    renderPlayerDropdowns();
  }, err => showToast(`Roster: ${err.code}`, true));

  unsubMatches = db.collection("matches").onSnapshot(snapshot => {
    globalMatches = [];
    snapshot.forEach(doc => globalMatches.push(doc.data()));
    renderLeaderboards(globalMatches);
  }, err => showToast(`Matches: ${err.code}`, true));
});

// Set default date to today (local time; valueAsDate would use UTC and show tomorrow in the evening)
function setDateToToday() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  document.getElementById('matchDate').value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
setDateToToday();

// Mode Selector Logic
const btnQBReader = document.getElementById('btnQBReader');
const btnCustomSet = document.getElementById('btnCustomSet');
const qbContainer = document.getElementById('qbReaderContainer');
const customContainer = document.getElementById('customSetContainer');
const undoBtn = document.getElementById('undoBtn');
const toast = document.getElementById('actionToast');

// Universal toggle handler for button groups
function setupButtonGroup(containerId, buttonClass, onSelectCallback) {
  const container = document.getElementById(containerId);
  if (!container) return;

  container.addEventListener('click', (e) => {
    const btn = e.target.closest(`.${buttonClass}`);
    if (!btn) return;

    container.querySelectorAll(`.${buttonClass}`).forEach(b => b.classList.remove('active-opt'));
    btn.classList.add('active-opt');

    const val = btn.getAttribute('data-value');
    if (onSelectCallback) onSelectCallback(val);
  });
}

// Initialize Active Category/Difficulty buttons
setupButtonGroup('categoryBtnGroup', 'cat-btn', (selectedValue) => {
  activeCategory = selectedValue;
  showToast(`Category set to: ${activeCategory}`);
});

setupButtonGroup('difficultyBtnGroup', 'diff-btn', (selectedValue) => {
  activeDifficulty = selectedValue;
  showToast(`Difficulty set to: ${activeDifficulty}`);
});

btnQBReader.addEventListener('click', () => {
  btnQBReader.className = 'btn btn-primary';
  btnCustomSet.className = 'btn btn-secondary';
  qbContainer.style.display = 'block';
  customContainer.style.display = 'none';
});

btnCustomSet.addEventListener('click', () => {
  btnCustomSet.className = 'btn btn-primary';
  btnQBReader.className = 'btn btn-secondary';
  qbContainer.style.display = 'none';
  customContainer.style.display = 'block';
});

// Toast notification trigger
function showToast(message, isUndo = false) {
  toast.textContent = message;
  toast.classList.add('show');
  toast.style.borderColor = isUndo ? '#ef4444' : '#2563eb';
  setTimeout(() => {
    toast.classList.remove('show');
  }, 2500);
}

// ---------- Live match console ----------

// Names currently selected in the 10 slots
function getSeatedPlayers() {
  return [...document.querySelectorAll('.player-select')]
    .map(s => s.value)
    .filter(Boolean);
}

// Render 5 slot dropdowns for Red and 5 for Green, keeping any current selections
function renderPlayerDropdowns() {
  const redContainer = document.getElementById('redPlayers');
  const greenContainer = document.getElementById('greenPlayers');

  // Remember who is seated so a roster update mid-match doesn't clear the lineup
  const previous = {};
  document.querySelectorAll('.player-card').forEach(card => {
    previous[card.id] = card.querySelector('.player-select').value;
  });

  redContainer.innerHTML = '';
  greenContainer.innerHTML = '';

  for (let i = 1; i <= 5; i++) {
    redContainer.appendChild(createPlayerCard('Red', i, previous));
    greenContainer.appendChild(createPlayerCard('Green', i, previous));
  }
}

function createPlayerCard(team, index, previous = {}) {
  const card = document.createElement('div');
  card.className = 'player-card';
  const cardId = `${team.toLowerCase()}-slot-${index}`;
  card.setAttribute('id', cardId);

  const selected = previous[cardId] || '';
  let optionsHtml = '<option value="">-- Select Player --</option>';
  roster.forEach(name => {
    const sel = name === selected ? ' selected' : '';
    optionsHtml += `<option value="${escapeHtml(name)}"${sel}>${escapeHtml(name)}</option>`;
  });

  // Swapping players does NOT erase stats: each action stores the player's name,
  // so a subbed-out player's points stay in the match.
  card.innerHTML = `
    <select class="player-select ${team.toLowerCase()}-player-name" onchange="onSlotChange('${cardId}')">
      ${optionsHtml}
    </select>
    <div class="action-btn-group">
      <button type="button" class="act-btn btn-correct" onclick="recordAction('${cardId}', 'correct')">+4 Tossup</button>
      <button type="button" class="act-btn btn-interrupt" onclick="recordAction('${cardId}', 'interrupt')">Neg (-4 Player / +4 Opp)</button>
      <button type="button" class="act-btn btn-incorrect" onclick="recordAction('${cardId}', 'incorrect')">0 Inc</button>
    </div>
    <div class="slot-summary" id="summary-${cardId}"></div>
  `;

  // Fill in the summary after the card is built
  setTimeout(() => updateSlotDisplay(cardId), 0);
  return card;
}

// Player in a slot changed (substitution): just refresh that slot's summary
function onSlotChange(cardId) {
  const name = document.querySelector(`#${cardId} .player-select`).value;
  if (name) seenPlayers.add(name);
  updateSlotDisplay(cardId);
}

// Record individual question outcome
function recordAction(cardId, type) {
  const card = document.getElementById(cardId);
  const nameSelect = card.querySelector('.player-select');
  const playerName = nameSelect.value;

  if (!playerName) {
    alert('Please select a player name first!');
    return;
  }

  if (!liveStats[cardId]) liveStats[cardId] = [];

  const entry = {
    kind: 'tossup',
    cardId,
    playerName,
    type,
    category: activeCategory,
    difficulty: activeDifficulty,
    tossupIndex: tossupLog.length, // which tossup this happened on
    timestamp: Date.now()
  };

  liveStats[cardId].push(entry);
  actionHistory.push(entry);
  seenPlayers.add(playerName);

  undoBtn.disabled = false;
  updateSlotDisplay(cardId);
  recalculateScoreboard();

  const typeLabels = {
    correct: '+4 Tossup Correct',
    interrupt: 'Interrupt Neg (-4 Player / +4 Opponent)',
    incorrect: '0 Incorrect'
  };
  showToast(`${typeLabels[type]} for ${playerName} (${activeCategory})`);
}

// Close out the current tossup: everyone seated right now "heard" it.
// Use this after every tossup, including dead ones nobody answered.
function nextTossup() {
  const players = getSeatedPlayers();
  if (players.length === 0) {
    alert('Seat at least one player before counting tossups.');
    return;
  }
  players.forEach(n => seenPlayers.add(n));

  tossupLog.push({ category: activeCategory, difficulty: activeDifficulty, players });
  actionHistory.push({ kind: 'nextTossup', timestamp: Date.now() });

  undoBtn.disabled = false;
  updateTossupCounter();
  document.querySelectorAll('.player-card').forEach(c => updateSlotDisplay(c.id));
  showToast(`Tossup ${tossupLog.length} done (${activeCategory}). Ready for tossup ${tossupLog.length + 1}.`);
}

function updateTossupCounter() {
  const el = document.getElementById('tossupCounter');
  if (el) el.textContent = `Tossups completed: ${tossupLog.length}`;
}

// Record Team Bonus (+10)
function recordBonus(team) {
  teamBonuses[team] = (teamBonuses[team] || 0) + 1;

  const entry = {
    kind: 'bonus',
    team: team,
    category: activeCategory,
    difficulty: activeDifficulty,
    timestamp: Date.now()
  };

  actionHistory.push(entry);
  undoBtn.disabled = false;

  recalculateScoreboard();
  showToast(`+10 Bonus Point added to ${team} Team!`);
}

// Record Standalone Team Score Adjustment (+4 or -4 penalty pts)
function recordTeamPenalty(team, delta) {
  teamPenalties[team] = (teamPenalties[team] || 0) + delta;

  const entry = {
    kind: 'teamPenalty',
    team: team,
    delta: delta,
    timestamp: Date.now()
  };

  actionHistory.push(entry);
  undoBtn.disabled = false;

  recalculateScoreboard();
  const label = delta > 0 ? `+${delta} Penalty Points` : `${delta} Score Adjustment`;
  showToast(`${label} assigned to ${team} Team`);
}

// Undo last entry
undoBtn.addEventListener('click', () => {
  if (actionHistory.length === 0) return;

  const lastAction = actionHistory.pop();

  if (lastAction.kind === 'bonus') {
    teamBonuses[lastAction.team] = Math.max(0, teamBonuses[lastAction.team] - 1);
    showToast(`Undid +10 Bonus for ${lastAction.team} Team`, true);
  } else if (lastAction.kind === 'teamPenalty') {
    teamPenalties[lastAction.team] = (teamPenalties[lastAction.team] || 0) - lastAction.delta;
    showToast(`Undid penalty adjustment for ${lastAction.team} Team`, true);
  } else if (lastAction.kind === 'nextTossup') {
    tossupLog.pop();
    updateTossupCounter();
    document.querySelectorAll('.player-card').forEach(c => updateSlotDisplay(c.id));
    showToast(`Undid "Next Tossup" (back to tossup ${tossupLog.length + 1})`, true);
  } else {
    const slotActions = liveStats[lastAction.cardId];
    if (slotActions) {
      const idx = slotActions.lastIndexOf(lastAction);
      if (idx !== -1) slotActions.splice(idx, 1);
    }
    updateSlotDisplay(lastAction.cardId);
    showToast(`Undid last tossup for ${lastAction.playerName}`, true);
  }

  recalculateScoreboard();

  if (actionHistory.length === 0) {
    undoBtn.disabled = true;
  }
});

// Show the stats of whoever is currently in this slot (this match only)
function updateSlotDisplay(cardId) {
  const summary = document.getElementById(`summary-${cardId}`);
  if (!summary) return;

  const select = document.querySelector(`#${cardId} .player-select`);
  const name = select ? select.value : '';
  if (!name) {
    summary.textContent = 'No player selected';
    return;
  }

  let correct = 0, interrupts = 0, incorrects = 0;
  Object.values(liveStats).flat().forEach(a => {
    if (a.playerName !== name) return;
    if (a.type === 'correct') correct++;
    if (a.type === 'interrupt') interrupts++;
    if (a.type === 'incorrect') incorrects++;
  });
  const heard = tossupLog.filter(t => t.players.includes(name)).length;

  summary.textContent = `Correct: ${correct} | Negs: ${interrupts} | Inc: ${incorrects} | Heard: ${heard}`;
}

// Calculate and Update Realtime Live Scores
function recalculateScoreboard() {
  let redScore = (teamBonuses.Red || 0) * 10 + (teamPenalties.Red || 0);
  let greenScore = (teamBonuses.Green || 0) * 10 + (teamPenalties.Green || 0);

  // Process player slot actions
  Object.keys(liveStats).forEach(cardId => {
    const isRed = cardId.startsWith('red');
    const actions = liveStats[cardId] || [];

    actions.forEach(a => {
      if (a.type === 'correct') {
        if (isRed) redScore += 4;
        else greenScore += 4;
      } else if (a.type === 'interrupt') {
        // Official NSB Rule: Neg on Red awards +4 points to Green, and vice-versa
        if (isRed) greenScore += 4;
        else redScore += 4;
      }
    });
  });

  document.getElementById('redTotalScore').textContent = redScore;
  document.getElementById('greenTotalScore').textContent = greenScore;
}

// Add New Player to Firebase Roster
document.getElementById('addPlayerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const nameInput = document.getElementById('newPlayerName');
  const name = nameInput.value.trim();

  if (name && !roster.includes(name)) {
    await db.collection("roster").add({ name: name });
    nameInput.value = '';
  } else if (roster.includes(name)) {
    alert("Player already exists!");
  }
});

// Fetch Live Question via QB Reader API
document.getElementById('fetchQuestionsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const box = document.getElementById('questionBox');
  box.innerHTML = '<p>Loading Science Bowl question...</p>';

  try {
    const res = await fetch(`https://www.qbreader.org/api/random-tossup?setName=National%20Science%20Bowl`);
    const data = await res.json();

    if (data.tossups && data.tossups.length > 0) {
      const q = data.tossups[0];
      box.innerHTML = `
        <p><strong>Set:</strong> ${escapeHtml(q.setName || 'National Science Bowl')}</p>
        <p><strong>Category:</strong> ${escapeHtml(q.category || 'Science')}</p>
        <hr />
        <p><strong>Question:</strong> ${escapeHtml(q.question_sanitized || q.question)}</p>
        <p><strong>Answer:</strong> <b>${escapeHtml(q.answer_sanitized || q.answer)}</b></p>
      `;
    } else {
      box.innerHTML = '<p>No tossups found.</p>';
    }
  } catch (err) {
    box.innerHTML = '<p>Error fetching question.</p>';
  }
});

// Save Full Match Results
document.getElementById('matchForm').addEventListener('submit', async (e) => {
  e.preventDefault();

  const allActions = Object.values(liveStats).flat();

  // If the last tossup had activity but "Next Tossup" wasn't clicked, count it now
  if (allActions.some(a => a.tossupIndex === tossupLog.length) && getSeatedPlayers().length > 0) {
    tossupLog.push({ category: activeCategory, difficulty: activeDifficulty, players: getSeatedPlayers() });
  }

  const players = new Set(seenPlayers);
  getSeatedPlayers().forEach(n => players.add(n));
  allActions.forEach(a => players.add(a.playerName));

  const matchData = {
    date: document.getElementById('matchDate').value,
    setName: document.getElementById('setName').value.trim(),
    group: document.getElementById('matchGroup').value,
    players: [...players],   // everyone who sat in a slot this match (counts toward Matches)
    tossupLog: tossupLog,    // who heard each tossup (counts toward Tossups Heard)
    events: [],
    redScore: parseInt(document.getElementById('redTotalScore').textContent) || 0,
    greenScore: parseInt(document.getElementById('greenTotalScore').textContent) || 0
  };

  Object.keys(liveStats).forEach(cardId => {
    const team = cardId.startsWith('red') ? 'Red' : 'Green';
    liveStats[cardId].forEach(evt => {
      matchData.events.push({
        name: evt.playerName,
        team: team,
        type: evt.type,
        category: evt.category,
        difficulty: evt.difficulty
      });
    });
  });

  if (matchData.events.length === 0 && tossupLog.length === 0 && teamBonuses.Red === 0 && teamBonuses.Green === 0 && teamPenalties.Red === 0 && teamPenalties.Green === 0) {
    alert('No question actions recorded yet. Track questions or score adjustments before saving.');
    return;
  }

  try {
    await db.collection("matches").add(matchData);
  } catch (err) {
    alert(`Match NOT saved (${err.code || err.message}). Make sure you're signed in.`);
    return;
  }
  alert('Match saved successfully!');

  // Reset live state (keep the group selection and lineup for the next match)
  const keepGroup = document.getElementById('matchGroup').value;
  liveStats = {};
  teamBonuses = { Red: 0, Green: 0 };
  teamPenalties = { Red: 0, Green: 0 };
  actionHistory = [];
  tossupLog = [];
  seenPlayers = new Set();
  undoBtn.disabled = true;
  recalculateScoreboard();
  updateTossupCounter();
  document.getElementById('setName').value = '';
  setDateToToday();
  document.getElementById('matchGroup').value = keepGroup;
  document.querySelectorAll('.player-card').forEach(c => updateSlotDisplay(c.id));
});

// ---------- Leaderboards ----------

// Group filter + category filter listeners
document.getElementById('groupFilter').addEventListener('change', () => {
  renderLeaderboards(globalMatches);
});
document.getElementById('categoryFilter').addEventListener('change', () => {
  renderCategoryBreakdown(filterByGroup(globalMatches));
});

function filterByGroup(matches) {
  const g = document.getElementById('groupFilter').value;
  if (g === 'All') return matches;
  return matches.filter(m => (m.group || 'Other') === g);
}

// Leaderboards calculation logic
function renderLeaderboards(matches) {
  const filtered = filterByGroup(matches);
  renderOverallLeaderboard(filtered);
  renderCategoryBreakdown(filtered);
}

function emptyStats() {
  // tracked* = only from matches that logged tossups heard, so the rate compares like with like
  return { matches: 0, correct: 0, interrupts: 0, incorrects: 0, heard: 0, trackedNet: 0 };
}

// Build per-player stats. If category is given, only count that category.
function buildStats(matches, category = null) {
  const stats = {};
  roster.forEach(name => { stats[name] = emptyStats(); });
  const get = name => (stats[name] = stats[name] || emptyStats());

  matches.forEach(match => {
    const hasTossupLog = Array.isArray(match.tossupLog);
    const playersInMatch = new Set(Array.isArray(match.players) && typeof match.players[0] === 'string' ? match.players : []);

    if (match.events) {
      match.events.forEach(e => {
        playersInMatch.add(e.name);
        if (category && e.category !== category) return;
        const s = get(e.name);
        if (e.type === 'correct') { s.correct++; if (hasTossupLog) s.trackedNet += 4; }
        if (e.type === 'interrupt') { s.interrupts++; if (hasTossupLog) s.trackedNet -= 4; }
        if (e.type === 'incorrect') s.incorrects++;
      });
    } else if (Array.isArray(match.players)) { // Legacy format
      match.players.forEach(p => {
        if (typeof p !== 'object') return;
        playersInMatch.add(p.name);
        if (category && match.category !== category) return;
        const s = get(p.name);
        s.correct += p.correct || 0;
        s.interrupts += p.interrupts || 0;
        s.incorrects += p.incorrects || 0;
      });
    }

    if (hasTossupLog) {
      match.tossupLog.forEach(t => {
        if (category && t.category !== category) return;
        (t.players || []).forEach(n => get(n).heard++);
      });
    }

    playersInMatch.forEach(name => { get(name).matches += 1; });
  });

  return stats;
}

// Derived numbers for one player
function summarize(p) {
  const net = p.correct * 4 - p.interrupts * 4;
  const attempts = p.correct + p.interrupts + p.incorrects;
  return {
    net,
    accuracy: attempts > 0 ? (p.correct / attempts) * 100 : null,
    perTossup: p.heard > 0 ? p.trackedNet / p.heard : null,
    perMatch: p.matches > 0 ? net / p.matches : null
  };
}

// Sort: enough matches first, then points per tossup heard, then points per match, then net
function sortPlayers(stats, useMatchThreshold) {
  return Object.keys(stats).sort((a, b) => {
    const A = stats[a], B = stats[b];
    if (useMatchThreshold) {
      const qa = A.matches >= MIN_MATCHES_FOR_RANKING, qb = B.matches >= MIN_MATCHES_FOR_RANKING;
      if (qa !== qb) return qa ? -1 : 1;
    }
    const sa = summarize(A), sb = summarize(B);
    const ra = sa.perTossup ?? -Infinity, rb = sb.perTossup ?? -Infinity;
    if (ra !== rb) return rb - ra;
    const ma = sa.perMatch ?? -Infinity, mb = sb.perMatch ?? -Infinity;
    if (ma !== mb) return mb - ma;
    return sb.net - sa.net;
  });
}

const fmt = (v, digits = 2) => (v === null ? '—' : v.toFixed(digits));

function renderOverallLeaderboard(matches) {
  const stats = buildStats(matches);
  const tbody = document.getElementById('leaderboardBody');
  tbody.innerHTML = '';

  sortPlayers(stats, true).forEach(name => {
    const p = stats[name];
    const s = summarize(p);
    const tr = document.createElement('tr');
    if (p.matches < MIN_MATCHES_FOR_RANKING) {
      tr.className = 'low-sample';
      tr.title = `Fewer than ${MIN_MATCHES_FOR_RANKING} matches: not enough data to rank yet`;
    }
    tr.innerHTML = `
      <td><strong>${escapeHtml(name)}</strong></td>
      <td>${p.matches}</td>
      <td>${p.heard}</td>
      <td style="color: green;">+${p.correct}</td>
      <td style="color: red;">${p.interrupts}</td>
      <td>${p.incorrects}</td>
      <td><strong>${s.net}</strong></td>
      <td><strong>${fmt(s.perTossup)}</strong></td>
      <td>${fmt(s.perMatch, 1)}</td>
      <td>${s.accuracy === null ? '—' : s.accuracy.toFixed(1) + '%'}</td>
    `;
    tbody.appendChild(tr);
  });
}

function renderCategoryBreakdown(matches) {
  const selectedCat = document.getElementById('categoryFilter').value;
  const stats = buildStats(matches, selectedCat);
  const tbody = document.getElementById('categoryLeaderboardBody');
  tbody.innerHTML = '';

  sortPlayers(stats, false).forEach(name => {
    const p = stats[name];
    const s = summarize(p);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${escapeHtml(name)}</strong></td>
      <td>${p.heard}</td>
      <td style="color: green;">+${p.correct}</td>
      <td style="color: red;">${p.interrupts}</td>
      <td>${p.incorrects}</td>
      <td><strong>${s.net}</strong></td>
      <td><strong>${fmt(s.perTossup)}</strong></td>
      <td>${s.accuracy === null ? '—' : s.accuracy.toFixed(1) + '%'}</td>
    `;
    tbody.appendChild(tr);
  });
}

updateTossupCounter();
