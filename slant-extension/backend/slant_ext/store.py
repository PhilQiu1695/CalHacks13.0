"""SQLite persistence: credentials, pairing codes and jobs. Survives restarts; WAL mode; one lock for writes."""
import json
import sqlite3
import threading

SCHEMA = """
CREATE TABLE IF NOT EXISTS credentials(
  id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, label TEXT NOT NULL, test INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER);
CREATE TABLE IF NOT EXISTS pairing_codes(
  code_hash TEXT PRIMARY KEY, label TEXT, test INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL, used_at INTEGER, credential_id TEXT);
CREATE TABLE IF NOT EXISTS jobs(
  id TEXT PRIMARY KEY, credential_id TEXT NOT NULL, idem_key TEXT NOT NULL, video_id TEXT NOT NULL,
  canonical_url TEXT NOT NULL, is_short INTEGER NOT NULL DEFAULT 0, mode TEXT NOT NULL, spec_hash TEXT NOT NULL,
  state TEXT NOT NULL, stage TEXT NOT NULL, title TEXT, author TEXT, source TEXT,
  error_code TEXT, error_message TEXT, retryable INTEGER, cached INTEGER NOT NULL DEFAULT 0,
  paid INTEGER NOT NULL DEFAULT 0, follows TEXT, record_id TEXT, payload TEXT, timings TEXT, usage TEXT,
  simulate TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER,
  UNIQUE(credential_id, idem_key));
CREATE INDEX IF NOT EXISTS jobs_video_state ON jobs(video_id, state);
CREATE INDEX IF NOT EXISTS jobs_created ON jobs(created_at);
"""

JSON_FIELDS = ("payload", "timings", "usage")


class Store:
    def __init__(self, path):
        self.path = path
        self.lock = threading.RLock()
        self.db = sqlite3.connect(path, check_same_thread=False, isolation_level=None, timeout=10)
        self.db.row_factory = sqlite3.Row
        with self.lock:
            self.db.execute("PRAGMA journal_mode=WAL")
            self.db.execute("PRAGMA busy_timeout=5000")
            self.db.executescript(SCHEMA)
            # Additive migrations: which Mana person a browser belongs to (feed history), and whether a job was recorded.
            # email: the verified address of the Mana account that created the pairing code (shown to the Slant team only).
            for table, col in (("credentials", "uid TEXT"), ("pairing_codes", "uid TEXT"), ("jobs", "fed INTEGER NOT NULL DEFAULT 0"),
                               ("credentials", "email TEXT"), ("pairing_codes", "email TEXT"),
                               ("jobs", "public INTEGER NOT NULL DEFAULT 0"),   # 1 = paid job from a non-team account
                               ("jobs", "target TEXT")):   # fresh mode: the record to re-analyze (website Re-analyze)
                cols = [r[1] for r in self.db.execute(f"PRAGMA table_info({table})").fetchall()]
                if col.split()[0] not in cols:
                    self.db.execute(f"ALTER TABLE {table} ADD COLUMN {col}")

    def all(self, sql, args=()):
        with self.lock:
            return [dict(r) for r in self.db.execute(sql, args).fetchall()]

    def one(self, sql, args=()):
        rows = self.all(sql, args)
        return rows[0] if rows else None

    def run(self, sql, args=()):
        with self.lock:
            return self.db.execute(sql, args).rowcount

    # ---- jobs -------------------------------------------------------------------------------------------
    @staticmethod
    def _decode(row):
        if row:
            for k in JSON_FIELDS:
                if row.get(k):
                    try:
                        row[k] = json.loads(row[k])
                    except Exception:
                        row[k] = None
        return row

    def job(self, job_id):
        return self._decode(self.one("SELECT * FROM jobs WHERE id=?", (job_id,)))

    def job_by_idem(self, cred_id, idem_key):
        return self._decode(self.one("SELECT * FROM jobs WHERE credential_id=? AND idem_key=?", (cred_id, idem_key)))

    def insert_job(self, row):
        row = dict(row)
        for k in JSON_FIELDS:
            if k in row and row[k] is not None and not isinstance(row[k], str):
                row[k] = json.dumps(row[k], ensure_ascii=False)
        cols = ",".join(row)
        with self.lock:
            self.db.execute(f"INSERT INTO jobs({cols}) VALUES({','.join('?' * len(row))})", tuple(row.values()))

    def update_job(self, job_id, only_if_state=None, **fields):
        """Update fields; with only_if_state, only while the job is still in one of those states. Returns True if updated."""
        for k in JSON_FIELDS:
            if k in fields and fields[k] is not None and not isinstance(fields[k], str):
                fields[k] = json.dumps(fields[k], ensure_ascii=False)
        sets = ",".join(f"{k}=?" for k in fields)
        args = list(fields.values()) + [job_id]
        sql = f"UPDATE jobs SET {sets} WHERE id=?"
        if only_if_state:
            states = (only_if_state,) if isinstance(only_if_state, str) else tuple(only_if_state)
            sql += f" AND state IN ({','.join('?' * len(states))})"
            args += list(states)
        return self.run(sql, args) > 0

    def inflight_leader(self, video_id, spec_hash):
        return self._decode(self.one(
            "SELECT * FROM jobs WHERE video_id=? AND spec_hash=? AND follows IS NULL AND cached=0 AND simulate IS NULL "
            "AND state IN ('queued','running') ORDER BY created_at LIMIT 1", (video_id, spec_hash)))

    def active_paid(self, cred_id=None):
        sql = "SELECT COUNT(*) n FROM jobs WHERE paid=1 AND state IN ('queued','running')"
        args = ()
        if cred_id:
            sql += " AND credential_id=?"
            args = (cred_id,)
        return self.one(sql, args)["n"]

    def paid_since(self, since_ms, cred_id=None, public_only=False):
        sql = "SELECT COUNT(*) n FROM jobs WHERE paid=1 AND created_at>=?" + (" AND public=1" if public_only else "")
        args = [since_ms]
        if cred_id:
            sql += " AND credential_id=?"
            args.append(cred_id)
        return self.one(sql, args)["n"]

    # ---- per Mana account (a browser belongs to the account that created its pairing code; revoked browsers still count) ----
    def active_paid_uid(self, uid):
        return self.one("SELECT COUNT(*) n FROM jobs j JOIN credentials c ON c.id=j.credential_id "
                        "WHERE j.paid=1 AND j.state IN ('queued','running') AND c.uid=?", (uid,))["n"]

    def paid_since_uid(self, since_ms, uid):
        return self.one("SELECT COUNT(*) n FROM jobs j JOIN credentials c ON c.id=j.credential_id "
                        "WHERE j.paid=1 AND j.created_at>=? AND c.uid=?", (since_ms, uid))["n"]

    def recent_jobs_for_uid(self, uid, limit=8):
        return [self._decode(r) for r in self.all(
            "SELECT j.id, j.video_id, j.state, j.title, j.error_code, j.cached, j.simulate, j.timings, j.created_at "
            "FROM jobs j JOIN credentials c ON c.id=j.credential_id WHERE c.uid=? ORDER BY j.created_at DESC LIMIT ?", (uid, limit))]

    def recent_jobs(self, limit=20):
        return [self._decode(r) for r in self.all(
            "SELECT id, credential_id, video_id, canonical_url, mode, state, stage, title, author, source, error_code, "
            "error_message, cached, paid, follows, record_id, timings, usage, simulate, created_at, finished_at "
            "FROM jobs ORDER BY created_at DESC LIMIT ?", (limit,))]
