const express = require('express');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { customAlphabet } = require('nanoid');

const roomCode = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 4);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const dataDir = process.env.DATA_DIR || __dirname;
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'gpd.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS profiles (
  name TEXT PRIMARY KEY,
  avatar TEXT NOT NULL,
  lifetime_points REAL NOT NULL DEFAULT 0,
  nights_played INTEGER NOT NULL DEFAULT 0,
  best_night REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rooms (
  code TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  closed_at INTEGER
);

CREATE TABLE IF NOT EXISTS participants (
  room_code TEXT NOT NULL,
  name TEXT NOT NULL,
  avatar TEXT NOT NULL,
  points REAL NOT NULL DEFAULT 0,
  shots INTEGER NOT NULL DEFAULT 0,
  beers INTEGER NOT NULL DEFAULT 0,
  wines INTEGER NOT NULL DEFAULT 0,
  cocktails INTEGER NOT NULL DEFAULT 0,
  drink_units REAL NOT NULL DEFAULT 0,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (room_code, name)
);

CREATE TABLE IF NOT EXISTS nights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_code TEXT NOT NULL,
  date INTEGER NOT NULL,
  gpd REAL NOT NULL,
  owner TEXT NOT NULL,
  mvp TEXT,
  giggle_score REAL NOT NULL,
  drink_units REAL NOT NULL
);
`);

// migrate participants table for pre-existing databases that predate per-person drink tracking
const participantCols = new Set(db.prepare('PRAGMA table_info(participants)').all().map(c => c.name));
for (const [name, def] of [
  ['shots', 'INTEGER NOT NULL DEFAULT 0'],
  ['beers', 'INTEGER NOT NULL DEFAULT 0'],
  ['wines', 'INTEGER NOT NULL DEFAULT 0'],
  ['cocktails', 'INTEGER NOT NULL DEFAULT 0'],
  ['drink_units', 'REAL NOT NULL DEFAULT 0']
]) {
  if (!participantCols.has(name)) db.exec(`ALTER TABLE participants ADD COLUMN ${name} ${def}`);
}

// ---------- helpers ----------

const AVATARS = ['🦊','🐸','🦄','🐙','🦉','🐯','🐨','🦁','🐵','🐺','🐰','🐧','🦖','🐢','🦋','🐝','🦩','🐳','🦀','🐼'];

function avatarFor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return AVATARS[hash % AVATARS.length];
}

function getOrCreateProfile(name) {
  const clean = String(name || '').trim().slice(0, 24);
  if (!clean) return null;
  let profile = db.prepare('SELECT * FROM profiles WHERE name = ?').get(clean);
  if (!profile) {
    const avatar = avatarFor(clean);
    db.prepare('INSERT INTO profiles (name, avatar, lifetime_points, nights_played, best_night, created_at) VALUES (?,?,0,0,0,?)')
      .run(clean, avatar, Date.now());
    profile = db.prepare('SELECT * FROM profiles WHERE name = ?').get(clean);
  }
  return profile;
}

function roomState(code) {
  const room = db.prepare('SELECT * FROM rooms WHERE code = ?').get(code);
  if (!room) return null;
  const participants = db.prepare('SELECT name, avatar, points, shots, beers, wines, cocktails, drink_units FROM participants WHERE room_code = ? ORDER BY points DESC').all(code)
    .map(p => ({ ...p, gpd: Math.round((p.drink_units > 0 ? p.points / p.drink_units : 0) * 100) / 100 }));

  const totals = participants.reduce((t, p) => {
    t.giggle_score += p.points;
    t.drink_units += p.drink_units;
    t.shots += p.shots;
    t.beers += p.beers;
    t.wines += p.wines;
    t.cocktails += p.cocktails;
    return t;
  }, { giggle_score: 0, drink_units: 0, shots: 0, beers: 0, wines: 0, cocktails: 0 });

  const gpd = totals.drink_units > 0 ? totals.giggle_score / totals.drink_units : 0;
  const ageMs = Date.now() - room.created_at;
  const hours = Math.max(ageMs / 3600000, 1 / 60);
  const giggles_per_hour = totals.giggle_score / hours;
  return {
    code: room.code,
    owner: room.owner,
    status: room.status,
    giggle_score: totals.giggle_score,
    drink_units: totals.drink_units,
    shots: totals.shots,
    beers: totals.beers,
    wines: totals.wines,
    cocktails: totals.cocktails,
    gpd: Math.round(gpd * 100) / 100,
    giggles_per_hour: Math.round(giggles_per_hour * 10) / 10,
    created_at: room.created_at,
    participants
  };
}

// ---------- profile ----------

app.post('/api/profile', (req, res) => {
  const profile = getOrCreateProfile(req.body.name);
  if (!profile) return res.status(400).json({ error: 'Name required' });
  res.json(profile);
});

// ---------- rooms ----------

app.post('/api/rooms', (req, res) => {
  const owner = String(req.body.owner || '').trim().slice(0, 24);
  if (!owner) return res.status(400).json({ error: 'Owner name required' });
  const profile = getOrCreateProfile(owner);

  let code;
  for (let i = 0; i < 8; i++) {
    const candidate = roomCode();
    const exists = db.prepare('SELECT 1 FROM rooms WHERE code = ?').get(candidate);
    if (!exists) { code = candidate; break; }
  }
  if (!code) return res.status(500).json({ error: 'Could not allocate room code' });

  db.prepare('INSERT INTO rooms (code, owner, status, created_at) VALUES (?,?,\'active\',?)')
    .run(code, owner, Date.now());
  db.prepare('INSERT INTO participants (room_code, name, avatar, joined_at) VALUES (?,?,?,?)')
    .run(code, owner, profile.avatar, Date.now());

  res.json(roomState(code));
});

app.get('/api/rooms/:code', (req, res) => {
  const state = roomState(req.params.code.toUpperCase());
  if (!state) return res.status(404).json({ error: 'Room not found' });
  res.json(state);
});

app.post('/api/rooms/:code/join', (req, res) => {
  const code = req.params.code.toUpperCase();
  const room = db.prepare('SELECT * FROM rooms WHERE code = ?').get(code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.status !== 'active') return res.status(400).json({ error: 'This tab has been closed out' });

  const name = String(req.body.name || '').trim().slice(0, 24);
  if (!name) return res.status(400).json({ error: 'Name required' });
  const profile = getOrCreateProfile(name);

  const existing = db.prepare('SELECT * FROM participants WHERE room_code = ? AND name = ?').get(code, name);
  if (!existing) {
    db.prepare('INSERT INTO participants (room_code, name, avatar, points, joined_at) VALUES (?,?,?,0,?)')
      .run(code, name, profile.avatar, Date.now());
  }
  res.json({ ...roomState(code), is_owner: room.owner === name });
});

app.post('/api/rooms/:code/drink', (req, res) => {
  const code = req.params.code.toUpperCase();
  const room = db.prepare('SELECT * FROM rooms WHERE code = ?').get(code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.status !== 'active') return res.status(400).json({ error: 'This tab has been closed out' });

  const name = String(req.body.name || '').trim().slice(0, 24);
  const participant = db.prepare('SELECT * FROM participants WHERE room_code = ? AND name = ?').get(code, name);
  if (!participant) return res.status(400).json({ error: 'Join the tab before logging your drinks' });

  const kinds = {
    beer: { units: 1, col: 'beers' },
    wine: { units: 1, col: 'wines' },
    shot: { units: 1, col: 'shots' },
    cocktail: { units: 1.5, col: 'cocktails' }
  };
  const kind = kinds[req.body.type];
  if (!kind) return res.status(400).json({ error: 'Unknown drink type' });

  db.prepare(`UPDATE participants SET drink_units = drink_units + ?, ${kind.col} = ${kind.col} + 1 WHERE room_code = ? AND name = ?`)
    .run(kind.units, code, name);

  res.json(roomState(code));
});

app.post('/api/rooms/:code/giggle', (req, res) => {
  const code = req.params.code.toUpperCase();
  const room = db.prepare('SELECT * FROM rooms WHERE code = ?').get(code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.status !== 'active') return res.status(400).json({ error: 'This tab has been closed out' });

  const tiers = { chuckle: 0.5, giggle: 1.0, cackle: 2.0, honkd: 3.0, legendary: 5.0 };
  const points = tiers[req.body.tier];
  if (points === undefined) return res.status(400).json({ error: 'Unknown giggle tier' });

  const from = String(req.body.name || '').trim().slice(0, 24);
  const to = String(req.body.target || '').trim().slice(0, 24);
  if (!to) return res.status(400).json({ error: 'Pick who made you laugh' });
  if (from === to) return res.status(400).json({ error: "You can't rate your own giggles — let a friend do it" });

  const sender = db.prepare('SELECT * FROM participants WHERE room_code = ? AND name = ?').get(code, from);
  if (!sender) return res.status(400).json({ error: 'Join the tab before rating giggles' });
  const target = db.prepare('SELECT * FROM participants WHERE room_code = ? AND name = ?').get(code, to);
  if (!target) return res.status(400).json({ error: 'That person is not in this tab' });

  db.prepare('UPDATE participants SET points = points + ? WHERE room_code = ? AND name = ?').run(points, code, to);

  res.json(roomState(code));
});

app.post('/api/rooms/:code/close', (req, res) => {
  const code = req.params.code.toUpperCase();
  const room = db.prepare('SELECT * FROM rooms WHERE code = ?').get(code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (req.body.name !== room.owner) return res.status(403).json({ error: 'Only the owner can close the tab' });
  if (room.status !== 'active') return res.json(roomState(code));

  const participants = db.prepare('SELECT * FROM participants WHERE room_code = ? ORDER BY points DESC').all(code);
  const mvp = participants.length ? participants[0].name : null;
  const giggle_score = participants.reduce((s, p) => s + p.points, 0);
  const drink_units = participants.reduce((s, p) => s + p.drink_units, 0);
  const gpd = drink_units > 0 ? giggle_score / drink_units : 0;

  db.prepare('UPDATE rooms SET status = \'closed\', closed_at = ? WHERE code = ?').run(Date.now(), code);
  db.prepare('INSERT INTO nights (room_code, date, gpd, owner, mvp, giggle_score, drink_units) VALUES (?,?,?,?,?,?,?)')
    .run(code, Date.now(), gpd, room.owner, mvp, giggle_score, drink_units);

  const bump = db.prepare('UPDATE profiles SET lifetime_points = lifetime_points + ?, nights_played = nights_played + 1, best_night = MAX(best_night, ?) WHERE name = ?');
  for (const p of participants) {
    getOrCreateProfile(p.name);
    bump.run(p.points, p.points, p.name);
  }

  res.json(roomState(code));
});

// ---------- past tabs ----------

app.get('/api/profile/:name/tabs', (req, res) => {
  const name = String(req.params.name || '').trim().slice(0, 24);
  if (!name) return res.status(400).json({ error: 'Name required' });

  const rows = db.prepare(`
    SELECT n.room_code, n.date, n.gpd, n.owner, n.mvp, n.giggle_score, n.drink_units,
      (SELECT p.points FROM participants p WHERE p.room_code = n.room_code AND p.name = ?) AS my_points
    FROM nights n
    WHERE n.owner = ? OR n.room_code IN (SELECT room_code FROM participants WHERE name = ?)
    ORDER BY n.date DESC
    LIMIT 50
  `).all(name, name, name);

  res.json(rows);
});

app.get('/api/profile/:name/open-tabs', (req, res) => {
  const name = String(req.params.name || '').trim().slice(0, 24);
  if (!name) return res.status(400).json({ error: 'Name required' });

  const rows = db.prepare(`
    SELECT code, owner, created_at
    FROM rooms
    WHERE status = 'active' AND code IN (SELECT room_code FROM participants WHERE name = ?)
    ORDER BY created_at DESC
  `).all(name);

  res.json(rows);
});

// ---------- leaderboard ----------

app.get('/api/leaderboard/nights', (req, res) => {
  const rows = db.prepare('SELECT * FROM nights ORDER BY gpd DESC LIMIT 50').all();
  res.json(rows);
});

app.get('/api/leaderboard/friends', (req, res) => {
  const rows = db.prepare('SELECT * FROM profiles ORDER BY lifetime_points DESC LIMIT 50').all();
  res.json(rows);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`GPD listening on port ${PORT}`));
