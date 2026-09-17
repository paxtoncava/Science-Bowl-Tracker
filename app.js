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

// Global Variables
let roster = [];
let globalMatches = [];

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
const matchCatSelect = document.getElementById('matchCategory');

// Universal toggle handler for button groups
function setupButtonGroup(containerId, buttonClass, onSelectCallback) {
  const container = document.getElementById(containerId);
  if (!container) return;

  container.addEventListener('click', (e) => {
    const btn = e.target.closest(`.${buttonClass}`);
    if (!btn) return;

    // Remove active state from all sibling buttons in group
    container.querySelectorAll(`.${buttonClass}`).forEach(b => b.classList.remove('active-opt'));

    // Highlight clicked button
    btn.classList.add('active-opt');

    // Run callback with selected data value
    const val = btn.getAttribute('data-value');
    if (onSelectCallback) onSelectCallback(val);
  });
}

// Initialize Category buttons
setupButtonGroup('categoryBtnGroup', 'cat-btn', (selectedValue) => {
  if (matchCatSelect) {
    matchCatSelect.value = selectedValue;
  }
});

// Initialize Difficulty buttons
setupButtonGroup('difficultyBtnGroup', 'diff-btn', (selectedValue) => {
  console.log('Difficulty selected:', selectedValue);
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

// Render 5 slot dropdowns for Red and 5 for Green
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

  let optionsHtml = '<option value="">-- Select Player --</option>';
  roster.forEach(name => {
    optionsHtml += `<option value="${name}">${name}</option>`;
  });

  card.innerHTML = `
    <select class="${team.toLowerCase()}-player-name">
      ${optionsHtml}
    </select>
    <div class="stat-grid">
      <div>
        <label>Correct (+4):</label>
        <input type="number" class="${team.toLowerCase()}-correct" value="0" min="0" />
      </div>
      <div>
        <label>Neg/Interrupt (-4):</label>
        <input type="number" class="${team.toLowerCase()}-interrupt" value="0" min="0" />
      </div>
      <div>
        <label>Incorrect (0):</label>
        <input type="number" class="${team.toLowerCase()}-incorrect" value="0" min="0" />
      </div>
    </div>
  `;
  return card;
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

// Save Match Results
document.getElementById('matchForm').addEventListener('submit', async (e) => {
  e.preventDefault();

  const matchData = {
    date: document.getElementById('matchDate').value,
    setName: document.getElementById('setName').value.trim(),
    category: document.getElementById('matchCategory').value,
    players: []
  };

  const processTeam = (teamName) => {
    const cards = document.querySelectorAll(`.team-${teamName.toLowerCase()} .player-card`);
    cards.forEach(card => {
      const name = card.querySelector(`.${teamName.toLowerCase()}-player-name`).value;
      if (name) {
        const correct = parseInt(card.querySelector(`.${teamName.toLowerCase()}-correct`).value) || 0;
        const interrupts = parseInt(card.querySelector(`.${teamName.toLowerCase()}-interrupt`).value) || 0;
        const incorrects = parseInt(card.querySelector(`.${teamName.toLowerCase()}-incorrect`).value) || 0;

        matchData.players.push({
          name,
          team: teamName,
          correct,
          interrupts,
          incorrects
        });
      }
    });
  };

  processTeam('Red');
  processTeam('Green');

  if (matchData.players.length === 0) {
    alert('Please select at least one player in either team.');
    return;
  }

  await db.collection("matches").add(matchData);
  alert('Match saved successfully!');
  document.getElementById('matchForm').reset();
  renderPlayerDropdowns();
});

// Category Filter Listener
document.getElementById('categoryFilter').addEventListener('change', () => {
  renderCategoryBreakdown(globalMatches);
});

// Calculate Overall and Category Stats
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
    match.players.forEach(p => {
      if (!stats[p.name]) {
        stats[p.name] = { matches: 0, correct: 0, interrupts: 0, incorrects: 0 };
      }
      stats[p.name].matches += 1;
      stats[p.name].correct += p.correct;
      stats[p.name].interrupts += p.interrupts;
      stats[p.name].incorrects += p.incorrects;
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
    if (match.category === selectedCat) {
      match.players.forEach(p => {
        if (!stats[p.name]) {
          stats[p.name] = { correct: 0, interrupts: 0, incorrects: 0 };
        }
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
