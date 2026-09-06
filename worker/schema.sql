CREATE TABLE IF NOT EXISTS scores (
  day TEXT NOT NULL,
  player_id TEXT NOT NULL,
  name TEXT NOT NULL,
  total INTEGER NOT NULL,
  greens INTEGER NOT NULL,
  guesses TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (day, player_id)
);
CREATE INDEX IF NOT EXISTS idx_scores_day_total ON scores(day, total DESC);
CREATE INDEX IF NOT EXISTS idx_scores_player ON scores(player_id);
CREATE TABLE IF NOT EXISTS users (
  sub TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  picture TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  sub TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_sub ON sessions(sub);

-- Battle Royale rounds (10-minute rounds, everyone same unit)
CREATE TABLE IF NOT EXISTS br_scores (
  round INTEGER NOT NULL,
  player_id TEXT NOT NULL,
  name TEXT NOT NULL,
  idx INTEGER NOT NULL DEFAULT 0,        -- items completed (0..5)
  total INTEGER NOT NULL DEFAULT 0,
  greens INTEGER NOT NULL DEFAULT 0,
  guesses TEXT NOT NULL DEFAULT '[]',    -- JSON array of guesses so far
  updated_at INTEGER NOT NULL,           -- epoch ms, freshness signal
  PRIMARY KEY (round, player_id)
);
CREATE INDEX IF NOT EXISTS idx_br_round_total ON br_scores(round, total DESC);
