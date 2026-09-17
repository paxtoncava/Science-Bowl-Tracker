// Load existing data from browser storage or start empty
let sessions = JSON.parse(localStorage.getItem('sb_sessions')) || [];

const form = document.getElementById('sessionForm');
const leaderboardBody = document.getElementById('leaderboardBody');
const setsList = document.getElementById('setsList');

// Firebase configuration (get this from Firebase Console > Project Settings)
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "your-app.firebaseapp.com",
  projectId: "your-app-id",
  storageBucket: "your-app.appspot.com",
  messagingSenderId: "123456789",
  appId: "YOUR_APP_ID"
};

// Initialize Firebase
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();

// Real-time listener: Updates your site automatically whenever ANY device adds a practice session
db.collection("sessions").onSnapshot((snapshot) => {
  const sessions = [];
  snapshot.forEach((doc) => sessions.push(doc.data()));
  renderApp(sessions);
});

// Save & render on page load
renderApp();

form.addEventListener('submit', (e) => {
  e.preventDefault();

  const setDate = document.getElementById('setDate').value;
  const setName = document.getElementById('setName').value.trim();
  const teamName = document.getElementById('teamName').value.trim();

  const playerInputs = document.querySelectorAll('.player-input');
  const players = [];

  playerInputs.forEach(inputRow => {
    const name = inputRow.querySelector('.player-name').value.trim();
    const tossups = parseInt(inputRow.querySelector('.player-score').value) || 0;

    if (name) {
      players.push({ name, tossups });
    }
  });

  if (players.length === 0) {
    alert('Please enter at least one player name.');
    return;
  }

  const newSession = {
    date: setDate,
    setName,
    teamName,
    players
  };

  sessions.push(newSession);
  localStorage.setItem('sb_sessions', JSON.stringify(sessions));

  form.reset();
  renderApp();
});

function renderApp() {
  renderLeaderboard();
  renderSetsLog();
}

function renderLeaderboard() {
  const stats = {};

  sessions.forEach(session => {
    session.players.forEach(p => {
      if (!stats[p.name]) {
        stats[p.name] = { sessions: 0, tossups: 0 };
      }
      stats[p.name].sessions += 1;
      stats[p.name].tossups += p.tossups;
    });
  });

  leaderboardBody.innerHTML = '';

  const sortedPlayers = Object.keys(stats).sort((a, b) => stats[b].tossups - stats[a].tossups);

  sortedPlayers.forEach(name => {
    const p = stats[name];
    const avg = (p.tossups / p.sessions).toFixed(1);

    const row = document.createElement('tr');
    row.innerHTML = `
      <td><strong>${name}</strong></td>
      <td>${p.sessions}</td>
      <td>${p.tossups}</td>
      <td>${avg}</td>
    `;
    leaderboardBody.appendChild(row);
  });
}

function renderSetsLog() {
  setsList.innerHTML = '';
  const uniqueSets = [...new Set(sessions.map(s => `${s.setName} (${s.date})`))];

  uniqueSets.forEach(setInfo => {
    const li = document.createElement('li');
    li.textContent = setInfo;
    setsList.appendChild(li);
  });
}
