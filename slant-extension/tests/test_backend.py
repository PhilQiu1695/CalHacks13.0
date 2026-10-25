"""Backend tests with fakes: no network, no Firebase writes, no credits.  Run: python -m unittest tests/test_backend.py -v"""
import json
import os
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backend"))
sys.path.insert(0, os.path.join(ROOT, "tests"))
os.environ.setdefault("SLANT_EXT_OWNER", "OWNER_UID")

from slant_ext import config, jsport, ytid                          # noqa: E402
from slant_ext.auth import Auth, normalize_code                      # noqa: E402
from slant_ext.jobs import ApiError, JobManager                      # noqa: E402
from slant_ext import providers as P                                 # noqa: E402
from slant_ext.records import SlantRecords                           # noqa: E402
from slant_ext.store import Store                                    # noqa: E402
from fakes import SNIPS, FakeFirebase, FakeProviders, report, wait_for  # noqa: E402

SPEC = config.load_spec()
GOLDEN = json.load(open(os.path.join(ROOT, "spec", "golden.json")))
APP = "OWNER_UID/file-system/apps/slant/app"
LIMITS = dict(config.DEFAULT_LIMITS)


def fresh_env(tree=None, limits=None, clock=None):
    d = tempfile.mkdtemp()
    store = Store(os.path.join(d, "t.sqlite3"))
    fb = FakeFirebase(tree or {})
    records = SlantRecords(fb, APP, SPEC["FLAG_PERMS"], "OWNER_UID", ttl_ms=0)
    prov = FakeProviders(SPEC)
    lim = dict(LIMITS, **(limits or {}))
    jobs = JobManager(store, records, prov, SPEC, lim, sim_delay=0.01, **({"clock": clock} if clock else {}))
    auth = Auth(store, "pepper")
    return store, fb, records, prov, jobs, auth, d


def cred_of(auth, test=False, label="Test Chrome"):
    code, _ = auth.create_code(test=test)
    res = auth.redeem(code, label)
    return auth.check(res["credential"]), res["credential"]


def saved_tree(vid="lmjHE8CEhPM", packed=False, flags=None):
    res = report()
    if packed:
        for d in res["dimensions"]:
            d["quotesJson"] = json.dumps(d.pop("quotes"))
    rec = {"videoId": vid, "url": "https://www.youtube.com/watch?v=" + vid, "title": "Saved", "author": "Reuters", "language": "",
           "source": "auto-captions", "model": "gpt-6-astra", "segments": 3, "duration": 7, "truncated": False, "result": res,
           "flags": {"metadata": {"permissions": SPEC["FLAG_PERMS"]}, **(flags or {})},
           "metadata": {"type": "entry", "createdAt": 1000, "updatedAt": 1000}}
    return {"OWNER_UID": {"file-system": {"apps": {"slant": {"app": {
        "analyses": {"v1000": rec}, "transcripts": {"v1000": {"snippets": SNIPS, "metadata": {"type": "entry"}}}}}}}}}


class UrlParsing(unittest.TestCase):
    def test_shared_cases(self):
        for url, want, short in json.load(open(os.path.join(ROOT, "tests", "fixtures", "ytid_cases.json"))):
            got = ytid.parse(url)
            self.assertEqual(got and got["videoId"], want, url)
            if want:
                self.assertEqual(got["isShort"], short, url)
                self.assertTrue(got["canonicalUrl"].startswith("https://www.youtube.com/"), url)


class GoldenRequests(unittest.TestCase):
    """The Python port must send the model exactly what Slant's browser code sends."""

    def test_analysis_bodies(self):
        for fx, key in (("saudi.json", "analysisSaudi"), ("long.json", "analysisLong")):
            data = json.load(open(os.path.join(ROOT, "tests", "fixtures", fx)))
            body, truncated = P.build_analysis_body(SPEC, data["meta"], data["snips"])
            self.assertEqual(truncated, GOLDEN[key]["truncated"], fx)
            self.assertEqual(body, GOLDEN[key]["body"], fx)

    def test_gemini_body_and_parse(self):
        self.assertEqual(P.build_gemini_body(SPEC, "abcdefghijk"), SPEC["GEMINI_REQUEST"])
        for case in GOLDEN["gemini"]:
            j = {"candidates": [{"content": {"parts": case["parts"]}}]}
            if "error" in case:
                with self.assertRaises(P.JobError):
                    P.parse_gemini(j)
            else:
                self.assertEqual(P.parse_gemini(j), case["out"], case["name"])

    def test_fmt_t(self):
        for sec, want in GOLDEN["fmtT"]:
            self.assertEqual(jsport.fmt_t(sec), want)


class MalformedOutput(unittest.TestCase):
    def wrap(self, content):
        return {"choices": [{"message": {"content": content}}]}

    def test_rejects(self):
        bad = [None, "", "{not json", json.dumps({"headline": "only"}),
               json.dumps({**report(), "political": {**report()["political"], "confidence": "extreme"}}),
               json.dumps({**report(), "dimensions": [{"key": "made_up", "score": 1, "explanation": "", "quotes": []}]}),
               json.dumps({**report(), "extra": 1}), json.dumps({**report(), "overall": "high"}),
               json.dumps({**report(), "political": {**report()["political"], "quotes": [{"seg": "2", "quote": "x", "why": "y"}]}})]
        for c in bad:
            with self.assertRaises(P.JobError) as cm:
                P.parse_analysis_response(self.wrap(c), SPEC)
            self.assertEqual(cm.exception.code, "malformed_output")
        with self.assertRaises(P.JobError):
            P.parse_analysis_response({"choices": []}, SPEC)

    def test_accepts_valid(self):
        self.assertEqual(P.parse_analysis_response(self.wrap(json.dumps(report())), SPEC)["headline"], "H")


class ProviderErrors(unittest.TestCase):
    def test_status_mapping(self):
        class R:
            def __init__(self, status):
                self.status_code = status

        class Proxy:
            url, headers = "https://router", {"X": "y"}

        class Router:
            def provider(self, name):
                return Proxy()

        lp = P.LiveProviders(SPEC, 1, router=Router())
        orig = P.requests.post
        try:
            for status, code, retry in ((402, "insufficient_credits", False), (429, "rate_limited", True), (503, "provider_error", True)):
                P.requests.post = lambda *a, s=status, **k: R(s)
                with self.assertRaises(P.JobError) as cm:
                    lp._post("openai", "/chat/completions", {}, 5)
                self.assertEqual((cm.exception.code, cm.exception.retryable), (code, retry))

            def boom(*a, **k):
                raise P.requests.Timeout()
            P.requests.post = boom
            with self.assertRaises(P.JobError) as cm:
                lp._post("openai", "/x", {}, 5)
            self.assertEqual(cm.exception.code, "provider_timeout")
        finally:
            P.requests.post = orig


class AuthTests(unittest.TestCase):
    def test_pairing_single_use_expiry_revoke(self):
        t = [1_000_000]
        store = Store(os.path.join(tempfile.mkdtemp(), "a.sqlite3"))
        auth = Auth(store, "pep", clock=lambda: t[0])
        code, exp = auth.create_code(ttl_s=600)
        self.assertRegex(code, r"^[0-9A-Z]{4}-[0-9A-Z]{4}$")
        res = auth.redeem(code.lower().replace("-", " "), "My Chrome")
        self.assertTrue(res and res["credential"].startswith("slk_"))
        self.assertIsNone(auth.redeem(code, "again"), "codes are single-use")
        self.assertTrue(auth.check(res["credential"]))
        self.assertIsNone(auth.check(res["credential"] + "x"))
        self.assertIsNone(auth.check("Bearer " + res["credential"]))
        code2, _ = auth.create_code(ttl_s=600)
        t[0] += 601_000
        self.assertIsNone(auth.redeem(code2, "late"), "expired codes fail")
        self.assertTrue(auth.revoke(res["credentialId"]))
        self.assertIsNone(auth.check(res["credential"]), "revoked keys fail")
        raw = store.all("SELECT token_hash FROM credentials")[0]["token_hash"]
        self.assertNotIn(res["credential"], raw, "keys are stored hashed")

    def test_normalize(self):
        self.assertEqual(normalize_code("abcd-efgh"), "ABCDEFGH")
        self.assertEqual(normalize_code("o1il-0000"), "0111" + "0000")
        self.assertIsNone(normalize_code("ABCD-EFGU"))
        self.assertIsNone(normalize_code("ABC"))
        self.assertIsNone(normalize_code(None))


class JobTests(unittest.TestCase):
    def tearDown(self):
        if hasattr(self, "jobs"):
            self.jobs.stop()

    def env(self, **kw):
        self.store, self.fb, self.records, self.prov, self.jobs, self.auth, _ = fresh_env(**kw)
        self.jobs.start()
        self.cred, self.key = cred_of(self.auth)
        return self

    def done(self, job_id):
        return wait_for(lambda: (lambda j: j if j["state"] in ("done", "failed") else None)(self.store.job(job_id)))

    def test_cached_reuse_unpacks_editor_records(self):
        self.env(tree=saved_tree(packed=True))
        job, created = self.jobs.submit(self.cred, "https://youtu.be/lmjHE8CEhPM", "key-cached-1")
        v = self.jobs.view(job)
        self.assertEqual((v["state"], v["cached"]), ("done", True))
        self.assertEqual(self.prov.calls["analyze"] + self.prov.calls["captions"], 0, "no provider calls for cached results")
        self.assertEqual(v["result"]["recordId"], "v1000")
        self.assertEqual(v["result"]["record"]["result"]["dimensions"][0]["quotes"][0]["seg"], 2, "quotesJson unpacked")
        self.assertTrue(v["result"]["manaUrl"].endswith("apps/slant?slant=v1000"))
        self.assertEqual(self.store.paid_since(0), 0)

    def test_idempotency(self):
        self.env()
        a, c1 = self.jobs.submit(self.cred, "https://www.youtube.com/watch?v=lmjHE8CEhPM", "same-key-123")
        b, c2 = self.jobs.submit(self.cred, "https://www.youtube.com/watch?v=lmjHE8CEhPM", "same-key-123")
        self.assertEqual((a["id"], c1, c2), (b["id"], True, False))
        with self.assertRaises(ApiError) as cm:
            self.jobs.submit(self.cred, "https://www.youtube.com/watch?v=oAG7ekh3878", "same-key-123")
        self.assertEqual(cm.exception.status, 409)
        self.done(a["id"])
        self.assertEqual(self.prov.calls["analyze"], 1)

    def test_full_caption_path_saves_app_shape(self):
        self.env()
        job, _ = self.jobs.submit(self.cred, "https://www.youtube.com/shorts/oAG7ekh3878?si=x", "save-shape-1")
        j = self.done(job["id"])
        self.assertEqual(j["state"], "done", j.get("error_message"))
        app = self.fb.read(APP)
        rid = j["record_id"]
        rec = app["analyses"][rid]
        for k in ("videoId", "url", "title", "author", "language", "source", "model", "segments", "duration", "truncated", "result", "flags", "metadata"):
            self.assertIn(k, rec)
        self.assertEqual(rec["url"], "https://www.youtube.com/shorts/oAG7ekh3878", "Shorts keep /shorts/ so the app shows the 9:16 player")
        self.assertEqual(rec["source"], "auto-captions")
        self.assertEqual(rec["flags"]["metadata"]["permissions"], SPEC["FLAG_PERMS"])
        self.assertEqual(rec["metadata"]["type"], "entry")
        self.assertEqual((rec["via"], rec["analysisVersion"]), ("chrome-extension", SPEC["HASH"]))
        self.assertEqual(app["transcripts"][rid]["snippets"][2]["text"], "Riyadh Airport is closed")
        self.assertEqual(rec["duration"], 7)
        v = self.jobs.view(self.store.job(job["id"]))
        self.assertEqual([s["status"] for s in v["stages"]], ["done", "done", "skipped", "done", "done"])
        self.assertIn("total", v["timings"])

    def test_ai_path_with_length_check(self):
        self.env()
        self.prov.captions_result = {"ok": False, "offline": False, "status": 422, "json": {"kind": "TranscriptsDisabled", "error": "Captions are turned off."}}
        job, _ = self.jobs.submit(self.cred, "https://www.youtube.com/watch?v=lmjHE8CEhPM", "ai-path-1")
        j = self.done(job["id"])
        self.assertEqual((j["state"], j["source"]), ("done", "ai-transcription"))
        self.assertEqual(self.prov.calls["gemini"], 1)
        self.assertEqual(self.prov.last_meta["source"], "ai-transcription")

    def test_ai_path_refuses_long_or_unknown_length(self):
        self.env()
        self.prov.captions_result = {"ok": False, "offline": False, "status": 422, "json": {"kind": "NoTranscriptFound"}}
        self.prov.watch_result = dict(self.prov.watch_result, length=LIMITS["max_minutes_ai"] * 60 + 1)
        j = self.done(self.jobs.submit(self.cred, "https://youtu.be/m75pPeman4Q", "too-long-1")[0]["id"])
        self.assertEqual((j["state"], j["error_code"], j["retryable"]), ("failed", "too_long", 0))
        self.prov.watch_result = dict(self.prov.watch_result, length=None)
        self.prov.count_result = None                     # neither YouTube nor the token count can tell the length
        j = self.done(self.jobs.submit(self.cred, "https://youtu.be/g2APwypRIX0", "unknown-1")[0]["id"])
        self.assertEqual((j["error_code"], j["retryable"]), ("length_unknown", 1))
        self.assertEqual(self.prov.calls["count"], 1)
        self.assertEqual(self.prov.calls["gemini"] + self.prov.calls["analyze"], 0, "no paid calls")
        self.assertFalse(self.fb.read(APP + "/analyses"))

    def test_bot_blocked_length_check(self):
        self.env()
        self.prov.captions_result = {"ok": False, "offline": False, "status": 422, "json": {"kind": "RequestBlocked"}}
        bot = {"length": None, "playability": "LOGIN_REQUIRED", "reason": "Sign in to confirm you’re not a bot", "live": False, "upcoming": False}
        self.prov.watch_result = dict(bot)
        j = self.done(self.jobs.submit(self.cred, "https://youtu.be/m75pPeman4Q", "bot-ok-1")[0]["id"])
        self.assertEqual((j["state"], j["source"]), ("done", "ai-transcription"), j.get("error_message"))
        self.assertEqual((self.prov.calls["count"], self.prov.calls["gemini"]), (1, 1))
        self.prov.count_result = 20 * 60 * 104 * 2
        j = self.done(self.jobs.submit(self.cred, "https://youtu.be/g2APwypRIX0", "bot-long-1")[0]["id"])
        self.assertEqual(j["error_code"], "too_long")
        self.prov.count_result = None
        j = self.done(self.jobs.submit(self.cred, "https://youtu.be/oAG7ekh3878", "bot-unk-1")[0]["id"])
        self.assertEqual((j["error_code"], j["retryable"]), ("length_unknown", 1))
        self.prov.watch_result = dict(bot, reason="This video is private")
        j = self.done(self.jobs.submit(self.cred, "https://youtu.be/ArxR8mYOclo", "private-2-x")[0]["id"])
        self.assertEqual(j["error_code"], "video_unavailable")
        self.assertEqual(self.prov.calls["gemini"], 1, "no paid transcription after the first job")

    def test_captions_too_long(self):
        self.env()
        long = [{"t": i * 60.0, "d": 60.0, "text": "x"} for i in range(LIMITS["max_minutes_captions"] + 2)]
        self.prov.captions_result["json"]["snippets"] = long
        j = self.done(self.jobs.submit(self.cred, "https://youtu.be/m75pPeman4Q", "cap-long-1")[0]["id"])
        self.assertEqual(j["error_code"], "too_long")
        self.assertEqual(self.prov.calls["analyze"], 0)

    def test_private_and_age_restricted(self):
        self.env()
        self.prov.captions_result = {"ok": False, "offline": False, "status": 422, "json": {"kind": "RequestBlocked"}}
        self.prov.oembed_result = (401, {})
        j = self.done(self.jobs.submit(self.cred, "https://youtu.be/m75pPeman4Q", "private-1")[0]["id"])
        self.assertEqual(j["error_code"], "video_unavailable")
        self.prov.captions_result = {"ok": False, "offline": False, "status": 422, "json": {"kind": "AgeRestricted"}}
        j = self.done(self.jobs.submit(self.cred, "https://youtu.be/g2APwypRIX0", "age-1-abcd")[0]["id"])
        self.assertEqual(j["error_code"], "video_unavailable")
        self.assertEqual(self.prov.calls["gemini"] + self.prov.calls["analyze"], 0)

    def test_malformed_and_provider_failures_save_nothing(self):
        self.env()
        for i, err in enumerate((P.JobError("malformed_output", "bad", True), P.JobError("insufficient_credits", "out", False),
                                 P.JobError("rate_limited", "slow down", True))):
            self.prov.analyze_error = err
            j = self.done(self.jobs.submit(self.cred, "https://youtu.be/m75pPeman4Q", f"fail-{i}-abc")[0]["id"])
            self.assertEqual((j["state"], j["error_code"]), ("failed", err.code))
            v = self.jobs.view(j)
            self.assertEqual(v["error"]["retryable"], err.retryable)
            self.assertEqual([s["status"] for s in v["stages"]][3], "failed")
        self.assertFalse(self.fb.read(APP + "/analyses"), "nothing saved")

    def test_coalescing_duplicate_inflight(self):
        self.env()
        cred2, _ = cred_of(self.auth, label="Second")
        self.prov.block = threading.Event()
        a, _ = self.jobs.submit(self.cred, "https://youtu.be/m75pPeman4Q", "coalesce-a1")
        wait_for(lambda: self.store.job(a["id"])["stage"] == "analyzing")
        b, _ = self.jobs.submit(cred2, "https://www.youtube.com/watch?v=m75pPeman4Q", "coalesce-b1")
        self.assertEqual(b["follows"], a["id"])
        self.assertEqual(self.jobs.view(b)["stage"], "analyzing")
        self.prov.block.set()
        self.done(a["id"])
        jb = self.done(b["id"])
        self.assertEqual(jb["state"], "done")
        self.assertEqual(self.prov.calls["analyze"], 1, "one paid analysis for both requests")
        vb = self.jobs.view(jb)
        self.assertTrue(vb["coalesced"] and vb["result"]["recordId"] == self.store.job(a["id"])["record_id"])
        self.assertEqual(self.store.paid_since(0), 1)

    def test_fresh_reanalysis_preserves_feedback(self):
        flags = {"someUid": {"part": "political", "note": "I disagree", "at": 5}}
        self.env(tree=saved_tree(flags=flags))
        self.prov.analyze_result = report(score=5)
        j = self.done(self.jobs.submit(self.cred, "https://youtu.be/lmjHE8CEhPM", "fresh-1-abc", mode="fresh")[0]["id"])
        self.assertEqual((j["state"], j["record_id"]), ("done", "v1000"))
        rec = self.fb.read(APP + "/analyses/v1000")
        self.assertEqual(rec["flags"]["someUid"]["note"], "I disagree")
        self.assertEqual(rec["result"]["political"]["score"], 5)
        self.assertEqual(rec["metadata"]["createdAt"], 1000)
        self.assertGreater(rec["metadata"]["updatedAt"], 1000)
        self.assertEqual(self.prov.calls["captions"], 0, "reuses the saved transcript like the app's Re-analyze")

    def test_limits(self):
        self.env(limits={"per_browser_daily": 2})
        self.prov.block = threading.Event()
        a, _ = self.jobs.submit(self.cred, "https://youtu.be/m75pPeman4Q", "limit-a-123")
        with self.assertRaises(ApiError) as cm:
            self.jobs.submit(self.cred, "https://youtu.be/g2APwypRIX0", "limit-b-123")
        self.assertEqual((cm.exception.status, cm.exception.code), (429, "busy"))
        self.prov.block.set()
        self.done(a["id"])
        self.done(self.jobs.submit(self.cred, "https://youtu.be/g2APwypRIX0", "limit-c-123")[0]["id"])
        with self.assertRaises(ApiError) as cm:
            self.jobs.submit(self.cred, "https://youtu.be/oAG7ekh3878", "limit-d-123")
        self.assertEqual(cm.exception.code, "daily_limit")
        job, _ = self.jobs.submit(self.cred, "https://youtu.be/m75pPeman4Q", "limit-e-123")
        self.assertTrue(job["cached"], "saved analyses still open at the limit")

    def test_isolation_and_simulation_gate(self):
        self.env()
        other, _ = cred_of(self.auth, label="Other")
        job, _ = self.jobs.submit(self.cred, "https://youtu.be/m75pPeman4Q", "iso-1-abcd")
        with self.assertRaises(ApiError) as cm:
            self.jobs.get_for(other, job["id"])
        self.assertEqual(cm.exception.status, 404)
        with self.assertRaises(ApiError) as cm:
            self.jobs.submit(self.cred, "https://youtu.be/m75pPeman4Q", "sim-1-abcd", simulate="slow-success")
        self.assertEqual(cm.exception.status, 403)
        tcred, _ = cred_of(self.auth, test=True)
        self.assertTrue(tcred["test"])

    def test_bad_inputs(self):
        self.env()
        for url in ("https://example.com", "https://www.youtube.com/", "javascript:alert(1)"):
            with self.assertRaises(ApiError) as cm:
                self.jobs.submit(self.cred, url, "bad-input-1")
            self.assertEqual(cm.exception.code, "unsupported_url")
        with self.assertRaises(ApiError):
            self.jobs.submit(self.cred, "https://youtu.be/m75pPeman4Q", "short")
        with self.assertRaises(ApiError):
            self.jobs.submit(self.cred, "https://youtu.be/m75pPeman4Q", "mode-test-1", mode="turbo")


class FeedTests(unittest.TestCase):
    """Feed history: a paired browser's analyses go to the person who created its pairing code."""
    FEED = "OWNER_UID/file-system/slant-feeds"

    def env(self, tree=None):
        from slant_ext.feed import FeedWriter
        store, fb, records, prov, jobs, auth, d = fresh_env(tree)
        jobs.feed = FeedWriter(fb, "OWNER_UID", clock=lambda: 5000)
        return store, fb, jobs, auth

    def pair(self, auth, uid):
        code, _ = auth.create_code(uid=uid)
        res = auth.redeem(code, "Chrome")
        return auth.check(res["credential"])

    def test_cached_open_records_once_per_job_and_counts_views(self):
        store, fb, jobs, auth = self.env(saved_tree(packed=True))
        cred = self.pair(auth, "alice")
        jobs.submit(cred, "https://youtu.be/lmjHE8CEhPM", "idem-feed-1")
        wait_for(lambda: fb.read(self.FEED + "/alice/videos/lmjHE8CEhPM"))
        e = fb.read(self.FEED + "/alice/videos/lmjHE8CEhPM")
        self.assertEqual((e["count"], e["analysisId"], e["s"]["lean"], e["s"]["political"]), (1, "v1000", -3.0, True))
        self.assertEqual(e["s"]["dims"]["one_sided"], 3.0)            # packed quotesJson record still yields scores
        self.assertEqual(fb.read(self.FEED + "/alice/metadata/type"), "entry")
        jobs.submit(cred, "https://youtu.be/lmjHE8CEhPM", "idem-feed-1")   # same request again: no second view
        jobs.submit(cred, "https://youtu.be/lmjHE8CEhPM", "idem-feed-2")
        wait_for(lambda: (fb.read(self.FEED + "/alice/videos/lmjHE8CEhPM") or {}).get("count") == 2)
        time.sleep(0.1)
        self.assertEqual(fb.read(self.FEED + "/alice/videos/lmjHE8CEhPM")["count"], 2)

    def test_new_analysis_records_for_owner_of_browser(self):
        store, fb, jobs, auth = self.env()
        jobs.start()
        try:
            cred = self.pair(auth, "bob")
            job, _ = jobs.submit(cred, "https://www.youtube.com/watch?v=lmjHE8CEhPM", "idem-feed-3")
            wait_for(lambda: fb.read(self.FEED + "/bob/videos/lmjHE8CEhPM"), timeout=5)
            self.assertTrue(fb.read(self.FEED + "/bob/videos/lmjHE8CEhPM")["vias"]["chrome-extension"])
        finally:
            jobs.stop()

    def test_unlinked_browser_records_nothing_until_claimed(self):
        store, fb, jobs, auth = self.env(saved_tree())
        cred = self.pair(auth, None)
        jobs.submit(cred, "https://youtu.be/lmjHE8CEhPM", "idem-feed-4")
        time.sleep(0.2)
        self.assertIsNone(fb.read(self.FEED))
        self.assertTrue(auth.claim(cred["id"], "carol"))
        self.assertFalse(auth.claim(cred["id"], "mallory"))            # already linked: can't be taken over
        cred = auth.check(store.one("SELECT 1")) or store.one("SELECT * FROM credentials WHERE id=?", (cred["id"],))
        jobs.submit(cred, "https://youtu.be/lmjHE8CEhPM", "idem-feed-5")
        wait_for(lambda: fb.read(self.FEED + "/carol/videos/lmjHE8CEhPM"))


class RestartTests(unittest.TestCase):
    def test_interrupted_and_resumed(self):
        store, fb, records, prov, jobs, auth, d = fresh_env()
        cred, _ = cred_of(auth)
        now = int(time.time() * 1000)
        base = dict(credential_id=cred["id"], video_id="m75pPeman4Q", canonical_url="https://www.youtube.com/watch?v=m75pPeman4Q",
                    mode="auto", spec_hash=SPEC["HASH"], created_at=now, updated_at=now, paid=1)
        store.insert_job(dict(base, id="job_running", idem_key="k-running-1", state="running", stage="analyzing", started_at=now))
        store.insert_job(dict(base, id="job_follower", idem_key="k-follow-1", state="queued", stage="queued", follows="job_running", paid=0))
        store.insert_job(dict(base, id="job_queued", idem_key="k-queued-1", video_id="g2APwypRIX0",
                              canonical_url="https://www.youtube.com/watch?v=g2APwypRIX0", state="queued", stage="queued"))
        jobs.start()
        try:
            r = store.job("job_running")
            self.assertEqual((r["state"], r["error_code"], r["retryable"]), ("failed", "interrupted", 1))
            self.assertEqual(store.job("job_follower")["state"], "failed")
            q = wait_for(lambda: (lambda j: j if j["state"] == "done" else None)(store.job("job_queued")))
            self.assertEqual(q["state"], "done")
        finally:
            jobs.stop()

    def test_timeout(self):
        store, fb, records, prov, jobs, auth, d = fresh_env(limits={"job_timeout_seconds": 1})
        cred, _ = cred_of(auth)
        now = int(time.time() * 1000)
        store.insert_job(dict(id="job_slow", credential_id=cred["id"], idem_key="k-slow-1", video_id="m75pPeman4Q",
                              canonical_url="u", mode="auto", spec_hash="x", state="running", stage="analyzing",
                              created_at=now - 5000, updated_at=now, started_at=now - 5000, paid=1))
        jobs.check_timeouts()
        self.assertEqual(store.job("job_slow")["error_code"], "timeout")
        jobs.stop()


class HttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import server
        from http.server import ThreadingHTTPServer
        cls.store, cls.fb, cls.records, cls.prov, cls.jobs, cls.auth, _ = fresh_env(tree=saved_tree(), limits={"pair_attempts_per_10min": 3})
        cls.jobs.start()
        cls.app = server.App(cls.store, cls.auth, cls.records, cls.jobs, cls.prov, SPEC, dict(LIMITS, pair_attempts_per_10min=3),
                             "OWNER_UID", "ADMIN_SECRET", trust_sender_uid=True)
        cls.srv = ThreadingHTTPServer(("127.0.0.1", 0), server.make_handler(cls.app))
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.srv.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.jobs.stop()

    def call(self, method, path, body=None, headers=None, raw=None):
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        req = urllib.request.Request(self.base + path, data=data, method=method, headers={"Content-Type": "application/json", **(headers or {})})
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}")

    def pair(self, label="HTTP test"):
        s, b = self.call("POST", "/v1/owner/pairing-codes", {}, {"X-Slant-Admin": "ADMIN_SECRET"})
        self.assertEqual(s, 200)
        s, b = self.call("POST", "/v1/pair", {"code": b["code"], "label": label}, {"X-Forwarded-For": "10.0.0.%d" % (sum(map(ord, label)) % 200)})
        self.assertEqual(s, 200, b)
        return b["credential"], b["credentialId"]

    def test_health_and_auth(self):
        self.assertEqual(self.call("GET", "/healthz")[0], 200)
        self.assertEqual(self.call("GET", "/v1/session")[0], 401)
        self.assertEqual(self.call("GET", "/v1/session", headers={"X-Slant-Key": "slk_nope"})[0], 401)
        self.assertEqual(self.call("GET", "/v1/session", headers={"Authorization": "Bearer slk_nope"})[0], 401)
        key, cid = self.pair("health")
        s, b = self.call("GET", "/v1/session", headers={"X-Slant-Key": key})
        self.assertEqual((s, b["credentialId"]), (200, cid))

    def test_editor_console_access(self):
        from unittest.mock import patch
        grant = "OWNER_UID/file-system/apps/slant-extension/metadata/permissions/write/editor-uid"
        with patch.object(self.fb, "read", side_effect=lambda path: True if path == grant else None):
            self.assertEqual(self.call("GET", "/v1/owner/status", headers={"X-Sender-Uid": "editor-uid"})[0], 200)
            code_status, code = self.call("POST", "/v1/owner/pairing-codes", {"test": True}, {"X-Sender-Uid": "editor-uid"})
            self.assertEqual(code_status, 200)
            self.assertFalse(code["test"])
            self.assertEqual(self.call("GET", "/v1/owner/status", headers={"X-Sender-Uid": "reader-uid"})[0], 403)
            self.app.trust_sender_uid = False
            try:
                self.assertEqual(self.call("GET", "/v1/owner/status", headers={"X-Sender-Uid": "editor-uid"})[0], 403)
            finally:
                self.app.trust_sender_uid = True
        with patch.object(self.fb, "read", return_value=None):
            self.assertEqual(self.call("GET", "/v1/owner/status", headers={"X-Sender-Uid": "editor-uid"})[0], 403)
        with patch.object(self.fb, "read", side_effect=RuntimeError("offline")):
            self.assertFalse(self.app.is_editor("editor-uid"))

    def test_owner_routes_need_owner(self):
        self.assertEqual(self.call("GET", "/v1/owner/status")[0], 403)
        self.assertEqual(self.call("GET", "/v1/owner/status", headers={"X-Sender-Uid": "someone-else"})[0], 403)
        self.assertEqual(self.call("GET", "/v1/owner/status", headers={"X-Slant-Admin": "wrong"})[0], 403)
        self.assertEqual(self.call("POST", "/v1/owner/pairing-codes", {"test": True}, {"X-Sender-Uid": "OWNER_UID"})[1]["test"], False,
                         "only the sandbox admin token can mint test codes")
        self.app.trust_sender_uid = False
        try:
            self.assertEqual(self.call("GET", "/v1/owner/status", headers={"X-Sender-Uid": "OWNER_UID"})[0], 403)
        finally:
            self.app.trust_sender_uid = True

    def test_jobs_over_http(self):
        key, _ = self.pair("jobs")
        h = {"X-Slant-Key": key}
        s, b = self.call("POST", "/v1/jobs", {"url": "https://example.com/watch?v=lmjHE8CEhPM", "idempotencyKey": "http-bad-1"}, h)
        self.assertEqual((s, b["error"]["code"]), (400, "unsupported_url"))
        s, b = self.call("POST", "/v1/jobs", {"url": "https://www.youtube.com/watch?v=lmjHE8CEhPM", "idempotencyKey": "http-cache-1"}, h)
        self.assertEqual((s, b["job"]["state"], b["job"]["cached"]), (200, "done", True))
        s, b2 = self.call("GET", "/v1/jobs/" + b["job"]["id"], headers=h)
        self.assertEqual((s, b2["job"]["result"]["recordId"]), (200, "v1000"))
        key2, _ = self.pair("intruder")
        self.assertEqual(self.call("GET", "/v1/jobs/" + b["job"]["id"], headers={"X-Slant-Key": key2})[0], 404)
        s, b = self.call("POST", "/v1/jobs", raw=b"x" * 5000, headers=h)
        self.assertEqual(s, 413)
        s, b = self.call("POST", "/v1/jobs", raw=b"[1,2]", headers=h)
        self.assertEqual(s, 400)

    def test_revoke_and_pair_rate_limit(self):
        key, cid = self.pair("revoke-me")
        s, b = self.call("POST", f"/v1/owner/credentials/{cid}/revoke", {}, {"X-Slant-Admin": "ADMIN_SECRET"})
        self.assertTrue(b["revoked"])
        self.assertEqual(self.call("GET", "/v1/session", headers={"X-Slant-Key": key})[0], 401)
        codes = [self.call("POST", "/v1/pair", {"code": "ZZZZ-ZZZZ"}, {"X-Forwarded-For": "203.0.113.9"})[0] for _ in range(5)]
        self.assertEqual(codes[:3], [400, 400, 400])
        self.assertEqual(codes[3:], [429, 429])


if __name__ == "__main__":
    unittest.main(verbosity=2)
