#!/usr/bin/env python3
"""Slant for Chrome: extension backend. Binds 127.0.0.1:<data/port>; exposed publicly only through Mana ingress (service slant-ext).

Auth model
- Browsers: X-Slant-Key: slk_... (from a single-use pairing code). Required for /v1/session and /v1/jobs*. A job is visible
  only to the browser that created it.
- Owner: X-Sender-Uid set by Mana ingress forward-auth from a verified Firebase ID token (Mana console), or X-Slant-Admin with
  the token in data/admin.token (sandbox CLI). Neither the ingress URL, a CORS origin nor any caller-supplied user id is identity.
"""
import collections
import hmac
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
if '/opt/sandbox_libs' not in sys.path:
    sys.path.append('/opt/sandbox_libs')
from slant_ext import config  # noqa: E402
from slant_ext.jobs import ApiError, JobManager  # noqa: E402

OWNER_ORIGINS = {"https://www.mana.space", "https://mana.space"}
EXTRACT = os.path.join(config.ROOT, "spec", "extract_spec.js")


def now_ms():
    return int(time.time() * 1000)


class RateLimiter:
    def __init__(self):
        self.hits, self.lock = collections.defaultdict(collections.deque), threading.Lock()

    def allow(self, key, limit, window_s):
        now = time.monotonic()
        with self.lock:
            dq = self.hits[key]
            while dq and dq[0] <= now - window_s:
                dq.popleft()
            if len(dq) >= limit:
                return False
            dq.append(now)
            return True


class App:
    def __init__(self, store, auth, records, jobs, providers, spec, limits, owner_uid, admin_token, trust_sender_uid=True):
        self.store, self.auth, self.records, self.jobs, self.providers = store, auth, records, jobs, providers
        self.spec, self.limits, self.owner_uid, self.admin_token = spec, limits, owner_uid, admin_token
        self.trust_sender_uid = trust_sender_uid
        self.rl = RateLimiter()
        self.started = now_ms()
        self._drift, self._drift_at, self._live_spec = None, 0, None

    def is_editor(self, sender):
        # Read current named write grants on the console and its ancestors. No
        # browser-supplied identity, cached allowlist, or read-only grant qualifies.
        if not isinstance(sender, str) or not sender or any(c in sender for c in ".#$[]/"):
            return False
        root = f"{self.owner_uid}/file-system"
        try:
            return any(self.records.fb.read(f"{path}/metadata/permissions/write/{sender}") is True
                       for path in (root, root + "/apps", root + "/apps/slant-extension"))
        except Exception:
            return False  # Fail closed if the permission store is unavailable.

    def set_spec(self, spec):
        self.spec = self.jobs.spec = self.providers.spec = spec

    def spec_check(self, force=False):
        if not force and self._drift and time.time() - self._drift_at < 300:
            return self._drift
        try:
            code = self.records.fb.read(f"{self.records.app}/code")
            with tempfile.TemporaryDirectory() as d:
                cp, op = os.path.join(d, "app.jsx"), os.path.join(d, "spec.json")
                with open(cp, "w") as f:
                    f.write(code or "")
                r = subprocess.run(["node", EXTRACT, "--code", cp, "--out-spec", op, "--no-golden"], capture_output=True, text=True, timeout=40)
                if r.returncode:
                    raise RuntimeError((r.stderr or r.stdout)[-200:])
                live = config.load_spec(op)
            self._live_spec = live
            self._drift = {"inUse": self.spec["HASH"], "live": live["HASH"], "matches": live["HASH"] == self.spec["HASH"], "checkedAt": now_ms()}
        except Exception as e:
            self._drift = {"inUse": self.spec["HASH"], "error": str(e)[:200], "checkedAt": now_ms()}
        self._drift_at = time.time()
        return self._drift

    def sync_spec(self):
        d = self.spec_check(force=True)
        if self._live_spec and not d.get("matches"):
            out = {k: v for k, v in self._live_spec.items() if k != "HASH"}
            tmp = config.SPEC_PATH + ".tmp"
            with open(tmp, "w") as f:
                json.dump(out, f, indent=1)
            shutil.move(tmp, config.SPEC_PATH)
            self.set_spec(self._live_spec)
            d = self.spec_check(force=True)
        return d


def make_handler(app):
    L = app.limits

    class Handler(BaseHTTPRequestHandler):
        server_version = "slant-ext"
        sys_version = ""

        def log_message(self, fmt, *args):
            sys.stdout.write("%s %s\n" % (time.strftime("%H:%M:%S"), fmt % args))

        # ---- plumbing -----------------------------------------------------------------------------------------
        def _cors(self):
            origin = self.headers.get("Origin")
            if origin in OWNER_ORIGINS:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
                self.send_header("Access-Control-Allow-Headers", "authorization, content-type")
                self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

        def _send(self, status, obj):
            body = json.dumps(obj, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self._cors()
            self.end_headers()
            self.wfile.write(body)

        def _err(self, status, code, message):
            self._send(status, {"error": {"code": code, "message": message}})

        def _body(self):
            n = int(self.headers.get("Content-Length") or 0)
            if n > L["body_max_bytes"]:
                raise ApiError(413, "too_large", "Request body too large.")
            raw = self.rfile.read(n) if n else b""
            try:
                obj = json.loads(raw or b"{}")
            except ValueError:
                raise ApiError(400, "bad_json", "Request body must be JSON.")
            if not isinstance(obj, dict):
                raise ApiError(400, "bad_json", "Request body must be a JSON object.")
            return obj

        def _ip(self):
            xff = self.headers.get("X-Forwarded-For")
            return (xff.split(",")[0].strip() if xff else self.client_address[0])[:64]

        def _cred(self):
            cred = app.auth.check(self.headers.get("X-Slant-Key"))
            if not cred:
                raise ApiError(401, "unauthorized", "This browser isn't connected to Slant, or its connection was removed. Pair it again.")
            return cred

        def _owner(self):
            adm = self.headers.get("X-Slant-Admin")
            if adm and hmac.compare_digest(adm, app.admin_token):
                return "admin"
            sender = self.headers.get("X-Sender-Uid") if app.trust_sender_uid else None
            if sender == app.owner_uid:
                return "owner"
            if sender and app.is_editor(sender):
                return "editor"
            raise ApiError(403, "forbidden", "Only the owner or an editor of Slant for Chrome can do that.")

        def _route(self, method):
            path = urlsplit(self.path).path.rstrip("/") or "/"
            try:
                return self._dispatch(method, path)
            except ApiError as e:
                return self._err(e.status, e.code, e.message)
            except Exception as e:
                import traceback
                traceback.print_exc()
                return self._err(500, "internal", "Internal error: " + type(e).__name__)

        def do_GET(self):
            self._route("GET")

        def do_POST(self):
            self._route("POST")

        def do_OPTIONS(self):
            self.send_response(204)
            self._cors()
            self.send_header("Content-Length", "0")
            self.end_headers()

        # ---- routes -------------------------------------------------------------------------------------------
        def _dispatch(self, method, path):
            if method == "GET" and path in ("/", "/healthz"):
                return self._send(200, {"ok": True, "service": config.SERVICE, "version": config.VERSION, "spec": app.spec["HASH"]})

            if method == "POST" and path == "/v1/pair":
                if not app.rl.allow("pair:" + self._ip(), L["pair_attempts_per_10min"], 600) or not app.rl.allow("pair:*", 60, 3600):
                    raise ApiError(429, "rate_limited", "Too many pairing attempts. Wait a few minutes and try again.")
                b = self._body()
                label = b.get("label") if isinstance(b.get("label"), str) else None
                res = app.auth.redeem(b.get("code"), "".join(ch for ch in (label or "") if ch.isprintable())[:40])
                if not res:
                    raise ApiError(400, "invalid_code", "That pairing code is invalid, expired or already used. Create a new one in Slant for Chrome in Mana.")
                return self._send(200, {"credential": res["credential"], "credentialId": res["credentialId"], "label": res["label"],
                                        "test": res["test"], "version": config.VERSION})

            if method == "GET" and path == "/v1/session":
                cred = self._cred()
                day = now_ms() - 86_400_000
                return self._send(200, {"credentialId": cred["id"], "label": cred["label"], "test": bool(cred["test"]),
                                        "pairedAt": cred["created_at"], "version": config.VERSION, "spec": app.spec["HASH"],
                                        "appUrl": f"https://www.mana.space/home/{app.owner_uid}/apps/slant",
                                        "usage": {"newAnalysesLast24h": app.store.paid_since(day, cred["id"]), "limit": L["per_browser_daily"]},
                                        "limits": {k: L[k] for k in ("max_minutes_captions", "max_minutes_ai", "per_browser_daily")}})

            if method == "POST" and path == "/v1/jobs":
                cred = self._cred()
                if not app.rl.allow("submit:" + cred["id"], L["submit_per_minute"], 60):
                    raise ApiError(429, "rate_limited", "Too many requests from this browser. Wait a minute.")
                b = self._body()
                url = b.get("url")
                if not isinstance(url, str) or len(url) > 2048:
                    raise ApiError(400, "unsupported_url", "Open a YouTube video to analyze it.")
                job, created = app.jobs.submit(cred, url, b.get("idempotencyKey"), b.get("mode") or "auto", b.get("simulate"))
                return self._send(202 if created and job["state"] != "done" else 200, {"job": app.jobs.view(job), "created": created})

            if method == "GET" and path.startswith("/v1/jobs/"):
                cred = self._cred()
                if not app.rl.allow("poll:" + cred["id"], L["poll_per_minute"], 60):
                    raise ApiError(429, "rate_limited", "Polling too fast.")
                job = app.jobs.get_for(cred, path.split("/")[-1])
                return self._send(200, {"job": app.jobs.view(job)})

            if path.startswith("/v1/owner/"):
                who = self._owner()
                if method == "GET" and path == "/v1/owner/status":
                    day = now_ms() - 86_400_000
                    creds = app.auth.list()
                    me = self.headers.get("X-Sender-Uid") if app.trust_sender_uid else None
                    for c in creds:
                        c["newAnalysesLast24h"] = app.store.paid_since(day, c["id"])
                        uid = c.pop("uid", None)          # don't expose other people's ids; say whose feed it fills
                        c["feed"] = "none" if not uid else ("mine" if me and uid == me else ("owner" if uid == app.owner_uid else "other"))
                    jobs = app.store.recent_jobs(15)
                    return self._send(200, {
                        "service": config.SERVICE, "version": config.VERSION, "startedAt": app.started, "who": who,
                        "spec": app.spec_check(), "limits": L, "credentials": creds,
                        "usage": {"newAnalysesLast24h": app.store.paid_since(day), "globalDaily": L["global_daily"],
                                  "activePaid": app.store.active_paid()},
                        "jobs": [{k: j.get(k) for k in ("id", "credential_id", "video_id", "mode", "state", "stage", "title", "author",
                                                         "source", "error_code", "cached", "paid", "follows", "record_id", "simulate",
                                                         "created_at", "finished_at")} | {"total_ms": (j.get("timings") or {}).get("total")}
                                 for j in jobs]})
                if method == "POST" and path == "/v1/owner/pairing-codes":
                    b = self._body()
                    test = bool(b.get("test")) and who == "admin"
                    sender = self.headers.get("X-Sender-Uid") if (app.trust_sender_uid and who != "admin") else None
                    code, exp = app.auth.create_code(b.get("label") if isinstance(b.get("label"), str) else None, test,
                                                     L["pairing_code_ttl_seconds"], L["max_active_pairing_codes"], uid=sender)
                    return self._send(200, {"code": code, "expiresAt": exp, "ttlSeconds": L["pairing_code_ttl_seconds"], "test": test})
                if method == "POST" and path.startswith("/v1/owner/credentials/") and path.endswith("/revoke"):
                    cid = path.split("/")[4]
                    return self._send(200, {"revoked": app.auth.revoke(cid), "credentialId": cid})
                if method == "POST" and path.startswith("/v1/owner/credentials/") and path.endswith("/claim"):
                    # "This is my browser": link a browser paired before feed history existed to the signed-in person.
                    if who == "admin":
                        raise ApiError(400, "bad_request", "Sign in to Mana to link a browser to your feed.")
                    cid = path.split("/")[4]
                    return self._send(200, {"claimed": app.auth.claim(cid, self.headers.get("X-Sender-Uid")), "credentialId": cid})
                if method == "POST" and path == "/v1/owner/spec/sync":
                    return self._send(200, {"spec": app.sync_spec()})
                if method == "GET" and path == "/v1/owner/health":
                    out = {"spec": app.spec["HASH"]}
                    try:
                        out["firebase"] = {"ok": True, "analyses": len([k for k in app.records.analyses(force=True) or {} if k.startswith("v")])}
                    except Exception as e:
                        out["firebase"] = {"ok": False, "error": type(e).__name__}
                    cap = app.providers.captions("lmjHE8CEhPM") if self.headers.get("X-Probe-Captions") else None
                    out["captions"] = None if cap is None else {"ok": cap["ok"], "status": cap["status"], "offline": cap["offline"]}
                    out["router"] = app.providers.probe()
                    return self._send(200, out)
            raise ApiError(404, "not_found", "Not found.")

    return Handler


def build_app(trust_sender_uid=True):
    from firebase_helper import firebase
    from slant_ext.auth import Auth
    from slant_ext.providers import LiveProviders
    from slant_ext.records import SlantRecords
    from slant_ext.store import Store
    os.makedirs(config.DATA_DIR, exist_ok=True)
    spec, limits, owner = config.load_spec(), config.load_limits(), config.owner_uid()
    store = Store(os.path.join(config.DATA_DIR, "slant_ext.sqlite3"))
    auth = Auth(store, config.secret_file("pepper"))
    records = SlantRecords(firebase, f"{owner}/file-system/apps/slant/app", spec["FLAG_PERMS"], owner)
    with open("/workspace/yt-bias/port") as f:
        providers = LiveProviders(spec, int(f.read().strip()))
    jobs = JobManager(store, records, providers, spec, limits)
    from slant_ext.feed import FeedWriter
    jobs.feed = FeedWriter(firebase, owner)
    return App(store, auth, records, jobs, providers, spec, limits, owner, config.secret_file("admin.token"), trust_sender_uid)


def main():
    app = build_app(trust_sender_uid=os.environ.get("SLANT_EXT_TRUST_SENDER_UID", "1") == "1")
    app.jobs.start()
    with open(os.path.join(config.DATA_DIR, "port")) as f:
        port = int(f.read().strip())
    srv = ThreadingHTTPServer(("127.0.0.1", port), make_handler(app))
    srv.daemon_threads = True
    print(f"slant-ext {config.VERSION} listening on 127.0.0.1:{port} spec={app.spec['HASH']} owner={app.owner_uid[:6]}…", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
