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
