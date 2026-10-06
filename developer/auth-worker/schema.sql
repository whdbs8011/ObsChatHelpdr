CREATE TABLE IF NOT EXISTS login_requests (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  local_state TEXT NOT NULL,
  browser_hash TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  token_blob TEXT,
  expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT UNIQUE NOT NULL,
  token_blob TEXT NOT NULL,
  expires INTEGER NOT NULL,
  refresh_lock TEXT,
  lock_until INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS login_expiry ON login_requests(expires);
CREATE INDEX IF NOT EXISTS session_expiry ON sessions(expires);
