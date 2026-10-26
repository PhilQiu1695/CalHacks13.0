"""Owner-issued pairing codes -> revocable, narrowly scoped browser keys. Secrets are stored only as peppered hashes."""
import hashlib
import secrets
import time

ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"  # Crockford base32 (no I, L, O, U)
_CONFUSABLE = str.maketrans({"I": "1", "L": "1", "O": "0"})


def now_ms():
    return int(time.time() * 1000)


def normalize_code(code):
    if not isinstance(code, str):
        return None
    s = "".join(ch for ch in code.upper() if ch not in "- \t\r\n").translate(_CONFUSABLE)
    if len(s) != 8 or any(ch not in ALPHABET for ch in s):
        return None
    return s


class Auth:
    def __init__(self, store, pepper, clock=now_ms):
        self.store = store
        self.pepper = pepper
        self.clock = clock

    def _h(self, kind, value):
        return hashlib.sha256(f"{self.pepper}:{kind}:{value}".encode()).hexdigest()

    # ---- pairing codes -------------------------------------------------------------------------------------
    def create_code(self, label=None, test=False, ttl_s=600, max_active=5, uid=None, email=None):
        """Live codes are capped per account (or among account-less admin codes), so one person can't evict another's code."""
        now = self.clock()
        with self.store.lock:
            self.store.run("DELETE FROM pairing_codes WHERE used_at IS NULL AND expires_at<=?", (now,))
            if uid:
                active = self.store.all("SELECT code_hash FROM pairing_codes WHERE used_at IS NULL AND uid=? ORDER BY created_at", (uid,))
            else:
                active = self.store.all("SELECT code_hash FROM pairing_codes WHERE used_at IS NULL AND uid IS NULL ORDER BY created_at")
            for row in active[: max(0, len(active) - max_active + 1)]:      # keep at most max_active live codes
                self.store.run("DELETE FROM pairing_codes WHERE code_hash=?", (row["code_hash"],))
            raw = "".join(secrets.choice(ALPHABET) for _ in range(8))
            expires = now + ttl_s * 1000
            self.store.run("INSERT INTO pairing_codes(code_hash,label,test,created_at,expires_at,uid,email) VALUES(?,?,?,?,?,?,?)",
                           (self._h("code", raw), (label or None), 1 if test else 0, now, expires, uid or None, email or None))
        return raw[:4] + "-" + raw[4:], expires

    def outstanding(self):
        return self.store.one("SELECT COUNT(*) n FROM pairing_codes WHERE used_at IS NULL AND expires_at>?", (self.clock(),))["n"]

    def code_owner(self, code):
        """The account a live code belongs to (None for admin codes or unknown codes). Read-only."""
        norm = normalize_code(code)
        if not norm:
            return None
        row = self.store.one("SELECT uid FROM pairing_codes WHERE code_hash=? AND used_at IS NULL AND expires_at>?",
                             (self._h("code", norm), self.clock()))
        return row and row["uid"]

    def redeem(self, code, label, max_browsers=None):
        """Single use: returns {credential, credentialId, label, test}, None for a bad code, or "browser_limit" when the
        code's account already has max_browsers live browsers (the code stays usable after they revoke one)."""
        norm = normalize_code(code)
        if not norm:
            return None
        h = self._h("code", norm)
        with self.store.lock:
            now = self.clock()
            row = self.store.one("SELECT * FROM pairing_codes WHERE code_hash=? AND used_at IS NULL AND expires_at>?", (h, now))
            if not row:
                return None
            if row.get("uid") and max_browsers is not None and self.live_count(row["uid"]) >= max_browsers:
                return "browser_limit"
            cred_id = "brw_" + secrets.token_hex(6)
            if self.store.run("UPDATE pairing_codes SET used_at=?, credential_id=? WHERE code_hash=? AND used_at IS NULL",
                              (now, cred_id, h)) != 1:
                return None                                               # lost a race: already used
            token = "slk_" + secrets.token_urlsafe(32)
            label = (label or row.get("label") or "Chrome").strip()[:40] or "Chrome"
            # The browser belongs to whoever created the pairing code in Mana: its limits, its management and its feed.
            self.store.run("INSERT INTO credentials(id,token_hash,label,test,created_at,uid,email) VALUES(?,?,?,?,?,?,?)",
                           (cred_id, self._h("key", token), label, row["test"], now, row.get("uid"), row.get("email")))
        return {"credential": token, "credentialId": cred_id, "label": label, "test": bool(row["test"])}

    # ---- keys ----------------------------------------------------------------------------------------------
    def check(self, token):
        if not isinstance(token, str) or not token.startswith("slk_") or len(token) > 100:
            return None
        row = self.store.one("SELECT * FROM credentials WHERE token_hash=?", (self._h("key", token),))
        if not row or row["revoked_at"]:
            return None
        now = self.clock()
        if not row["last_used_at"] or now - row["last_used_at"] > 60_000:
            self.store.run("UPDATE credentials SET last_used_at=? WHERE id=?", (now, row["id"]))
        return row

    def revoke(self, cred_id):
        return self.store.run("UPDATE credentials SET revoked_at=? WHERE id=? AND revoked_at IS NULL", (self.clock(), cred_id)) > 0

    def claim(self, cred_id, uid):
        """Link a browser paired before feed history existed to a person. Only browsers with no person yet."""
        if not isinstance(uid, str) or not uid or any(c in uid for c in ".#$[]/"):
            return False
        return self.store.run("UPDATE credentials SET uid=? WHERE id=? AND uid IS NULL AND revoked_at IS NULL", (uid, cred_id)) > 0

    def list(self):
        return self.store.all("SELECT id,label,test,created_at,last_used_at,revoked_at,uid,email FROM credentials "
                              "WHERE id NOT LIKE 'web\\_%' ESCAPE '\\' ORDER BY created_at DESC")

    # ---- the Slant website ------------------------------------------------------------------------------------
    def web_credential(self, uid, email=None):
        """A per-person, keyless credential the Slant website's jobs run under (team only, checked by the server).
        It has no usable key and never appears as a browser."""
        cid = "web_" + hashlib.sha256(f"{self.pepper}:web:{uid}".encode()).hexdigest()[:12]
        with self.store.lock:
            row = self.store.one("SELECT * FROM credentials WHERE id=?", (cid,))
            if not row:
                self.store.run("INSERT INTO credentials(id,token_hash,label,test,created_at,uid,email) VALUES(?,?,?,?,?,?,?)",
                               (cid, self._h("web", secrets.token_hex(16)), "Slant website", 0, self.clock(), uid, email))
                row = self.store.one("SELECT * FROM credentials WHERE id=?", (cid,))
        return row

    # ---- one account's own browsers -------------------------------------------------------------------------
    def list_for(self, uid):
        return self.store.all("SELECT id,label,created_at,last_used_at,revoked_at FROM credentials WHERE uid=? AND test=0 "
                              "AND id NOT LIKE 'web\\_%' ESCAPE '\\' ORDER BY created_at DESC", (uid,))

    def live_count(self, uid):
        return self.store.one("SELECT COUNT(*) n FROM credentials WHERE uid=? AND revoked_at IS NULL "
                              "AND id NOT LIKE 'web\\_%' ESCAPE '\\'", (uid,))["n"]

    def revoke_for(self, cred_id, uid):
        """Revoke only if the browser belongs to uid. Returns True, False (already revoked) or None (not theirs / unknown)."""
        row = self.store.one("SELECT revoked_at FROM credentials WHERE id=? AND uid=?", (cred_id, uid))
        if not row:
            return None
        return self.store.run("UPDATE credentials SET revoked_at=? WHERE id=? AND uid=? AND revoked_at IS NULL",
                              (self.clock(), cred_id, uid)) > 0
