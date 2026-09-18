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

// Global State
let roster = [];
let globalMatches = [];
let actionHistory = []; // Stack for undo functionality
let liveStats = {}; // Player actions tracker
let teamBonuses = { Red: 0, Green: 0 }; // Bonus counters
let activeCategory = "General Science";
let activeDifficulty = "Easy";

// Set default date to today
document.getElementById('matchDate').valueAsDate = new Date();

// Load Roster & Matches live from Firebase
db.collection("roster").onSnapshot(snapshot => {
  roster = [];
  snapshot.forEach(doc => roster.push(doc.data().name));
  roster.sort();
  renderPlayerDropdowns();
});

db.collection("matches").onSnapshot(snapshot => {
  globalMatches = [];
  snapshot.forEach(doc => globalMatches.push(doc.data()));
  renderLeaderboards(globalMatches);
});

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

// Render 5 slot dropdowns for Red and 5 for Green with Action Buttons
function renderPlayerDropdowns() {
  const redContainer = document.getElementById('redPlayers');
  const greenContainer = document.getElementById('greenPlayers');

  redContainer.innerHTML = '';
  greenContainer.innerHTML = '';

  for (let i = 1; i <= 5; i++) {
    redContainer.appendChild(createPlayerCard('Red', i));
    greenContainer.appendChild(createPlayerCard('Green', i));
  }
}

function createPlayerCard(team, index) {
  const card = document.createElement('div');
  card.className = 'player-card';
  const cardId = `${team.toLowerCase()}-slot-${index}`;
  card.setAttribute('id', cardId);

  let optionsHtml = '<option value="">-- Select Player --</option>';
  roster.forEach(name => {
    optionsHtml += `<option value="${name}">${name}</option>`;
  });

  card.innerHTML = `
    <select class="player-select ${team.toLowerCase()}-player-name" onchange="resetSlotStats('${cardId}')">
      ${optionsHtml}
    </select>
    <div class="action-btn-group">
      <button type="button" class="act-btn btn-correct" onclick="recordAction('${cardId}', 'correct')">+4 Tossup</button>
      <button type="button" class="act-btn btn-interrupt" onclick="recordAction('${cardId}', 'interrupt')">-4 Neg</button>
      <button type="button" class="act-btn btn-incorrect" onclick="recordAction('${cardId}', 'incorrect')">0 Inc</button>
    </div>
    <div class="slot-summary" id="summary-${cardId}">
      Correct: 0 | Negs: 0 | Inc: 0
    </div>
  `;
  return card;
}

// Reset stats for a slot if user changes selected player
function resetSlotStats(cardId) {
  liveStats[cardId] = [];
  updateSlotDisplay(cardId);
  recalculateScoreboard();
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
    timestamp: Date.now()
  };

  liveStats[cardId].push(entry);
  actionHistory.push(entry);

  undoBtn.disabled = false;
  updateSlotDisplay(cardId);
  recalculateScoreboard();

  const typeLabels = { correct: '+4 Tossup Correct', interrupt: '-4 Interrupt Neg', incorrect: '0 Incorrect' };
  showToast(`${typeLabels[type]} for ${playerName} (${activeCategory})`);
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

// Undo last entry
undoBtn.addEventListener('click', () => {
  if (actionHistory.length === 0) return;

  const lastAction = actionHistory.pop();

  if (lastAction.kind === 'bonus') {
    teamBonuses[lastAction.team] = Math.max(0, teamBonuses[lastAction.team] - 1);
    showToast(`Undid +10 Bonus for ${lastAction.team} Team`, true);
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

function updateSlotDisplay(cardId) {
  const actions = liveStats[cardId] || [];
  let correct = 0, interrupts = 0, incorrects = 0;

  actions.forEach(a => {
    if (a.type === 'correct') correct++;
    if (a.type === 'interrupt') interrupts++;
    if (a.type === 'incorrect') incorrects++;
  });

  const summary = document.getElementById(`summary-${cardId}`);
  if (summary) {
    summary.textContent = `Correct: ${correct} | Negs: ${interrupts} | Inc: ${incorrects}`;
  }
}

// Calculate and Update Realtime Live Scores
function recalculateScoreboard() {
  let redScore = (teamBonuses.Red || 0) * 10;
  let greenScore = (teamBonuses.Green || 0) * 10;

  // Process player slot actions
  Object.keys(liveStats).forEach(cardId => {
    const isRed = cardId.startsWith('red');
    const actions = liveStats[cardId] || [];

    actions.forEach(a => {
      let points = 0;
      if (a.type === 'correct') points = 4;
      if (a.type === 'interrupt') points = -4;

      if (isRed) {
        redScore += points;
      } else {
        greenScore += points;
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
        <p><strong>Set:</strong> ${q.setName || 'National Science Bowl'}</p>
        <p><strong>Category:</strong> ${q.category || 'Science'}</p>
        <hr />
        <p><strong>Question:</strong> ${q.question_sanitized || q.question}</p>
        <p><strong>Answer:</strong> <b>${q.answer_sanitized || q.answer}</b></p>
      `;
    }
  } catch (err) {
    box.innerHTML = '<p>Error fetching question.</p>';
  }
});

// Save Full Match Results
document.getElementById('matchForm').addEventListener('submit', async (e) => {
  e.preventDefault();

  const matchData = {
    date: document.getElementById('matchDate').value,
    setName: document.getElementById('setName').value.trim(),
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

  if (matchData.events.length === 0 && teamBonuses.Red === 0 && teamBonuses.Green === 0) {
    alert('No question actions recorded yet. Track questions or bonus points before saving.');
    return;
  }

  await db.collection("matches").add(matchData);
  alert('Match saved successfully!');
  
  // Reset live state
  liveStats = {};
  teamBonuses = { Red: 0, Green: 0 };
  actionHistory = [];
  undoBtn.disabled = true;
  recalculateScoreboard();
  document.getElementById('matchForm').reset();
  renderPlayerDropdowns();
});

// Category Filter Listener
document.getElementById('categoryFilter').addEventListener('change', () => {
  renderCategoryBreakdown(globalMatches);
});

// Leaderboards calculation logic
function renderLeaderboards(matches) {
  renderOverallLeaderboard(matches);
  renderCategoryBreakdown(matches);
}

function renderOverallLeaderboard(matches) {
  const stats = {};

  roster.forEach(name => {
    stats[name] = { matches: 0, correct: 0, interrupts: 0, incorrects: 0 };
  });

  matches.forEach(match => {
    const playersInMatch = new Set();

    if (match.events) {
      match.events.forEach(e => {
        playersInMatch.add(e.name);
        if (!stats[e.name]) stats[e.name] = { matches: 0, correct: 0, interrupts: 0, incorrects: 0 };
        if (e.type === 'correct') stats[e.name].correct++;
        if (e.type === 'interrupt') stats[e.name].interrupts++;
        if (e.type === 'incorrect') stats[e.name].incorrects++;
      });
    } else if (match.players) { // Fallback for legacy format
      match.players.forEach(p => {
        playersInMatch.add(p.name);
        if (!stats[p.name]) stats[p.name] = { matches: 0, correct: 0, interrupts: 0, incorrects: 0 };
        stats[p.name].correct += p.correct;
        stats[p.name].interrupts += p.interrupts;
        stats[p.name].incorrects += p.incorrects;
      });
    }

    playersInMatch.forEach(name => {
      if (stats[name]) stats[name].matches += 1;
    });
  });

  const tbody = document.getElementById('leaderboardBody');
  tbody.innerHTML = '';

  const playerNames = Object.keys(stats);
  playerNames.sort((a, b) => {
    const netA = (stats[a].correct * 4) - (stats[a].interrupts * 4);
    const netB = (stats[b].correct * 4) - (stats[b].interrupts * 4);
    return netB - netA;
  });

  playerNames.forEach(name => {
    const p = stats[name];
    const netPoints = (p.correct * 4) - (p.interrupts * 4);
    const totalAttempts = p.correct + p.interrupts + p.incorrects;
    const accuracy = totalAttempts > 0 ? ((p.correct / totalAttempts) * 100).toFixed(1) + '%' : '0.0%';

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${name}</strong></td>
      <td>${p.matches}</td>
      <td style="color: green;">+${p.correct} (${p.correct * 4} pts)</td>
      <td style="color: red;">${p.interrupts} (-${p.interrupts * 4} pts)</td>
      <td>${p.incorrects} (0 pts)</td>
      <td><strong>${netPoints} pts</strong></td>
      <td>${accuracy}</td>
    `;
    tbody.appendChild(tr);
  });
}

function renderCategoryBreakdown(matches) {
  const selectedCat = document.getElementById('categoryFilter').value;
  const stats = {};

  roster.forEach(name => {
    stats[name] = { correct: 0, interrupts: 0, incorrects: 0 };
  });

  matches.forEach(match => {
    if (match.events) {
      match.events.forEach(e => {
        if (e.category === selectedCat) {
          if (!stats[e.name]) stats[e.name] = { correct: 0, interrupts: 0, incorrects: 0 };
          if (e.type === 'correct') stats[e.name].correct++;
          if (e.type === 'interrupt') stats[e.name].interrupts++;
          if (e.type === 'incorrect') stats[e.name].incorrects++;
        }
      });
    } else if (match.players && match.category === selectedCat) { // Legacy match support
      match.players.forEach(p => {
        if (!stats[p.name]) stats[p.name] = { correct: 0, interrupts: 0, incorrects: 0 };
        stats[p.name].correct += p.correct;
        stats[p.name].interrupts += p.interrupts;
        stats[p.name].incorrects += p.incorrects;
      });
    }
  });

  const tbody = document.getElementById('categoryLeaderboardBody');
  tbody.innerHTML = '';

  const playerNames = Object.keys(stats);
  playerNames.sort((a, b) => {
    const netA = (stats[a].correct * 4) - (stats[a].interrupts * 4);
    const netB = (stats[b].correct * 4) - (stats[b].interrupts * 4);
    return netB - netA;
  });

  playerNames.forEach(name => {
    const p = stats[name];
    const netPoints = (p.correct * 4) - (p.interrupts * 4);
    const totalAttempts = p.correct + p.interrupts + p.incorrects;
    const accuracy = totalAttempts > 0 ? ((p.correct / totalAttempts) * 100).toFixed(1) + '%' : '0.0%';

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${name}</strong></td>
      <td style="color: green;">+${p.correct}</td>
      <td style="color: red;">${p.interrupts}</td>
      <td>${p.incorrects}</td>
      <td><strong>${netPoints} pts</strong></td>
      <td>${accuracy}</td>
    `;
    tbody.appendChild(tr);
  });
}
