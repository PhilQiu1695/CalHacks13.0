"""Jobs: submission (idempotency, cache reuse, coalescing, limits) and execution of Slant's pipeline on a small worker pool.
State lives in SQLite. On start, jobs that were running are failed as interrupted (never left 'running'); queued ones resume."""
import re
import secrets
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor

from . import ytid
from .providers import JobError, normalize_snips

STAGES = [("checking", "Checking the video"), ("captions", "Reading captions"), ("transcribing", "Transcribing with AI (no captions)"),
          ("analyzing", "Analyzing slant"), ("saving", "Saving to your Slant history")]
STAGE_LABEL = dict(STAGES, queued="Waiting to start", done="Done")
IDEM_RE = re.compile(r"^[A-Za-z0-9_-]{8,80}$")
SIMULATIONS = {"slow-success", "fail-credits", "fail-rate", "fail-provider", "fail-malformed", "fail-unavailable", "hang"}
INTERRUPTED = "The Slant backend restarted while this analysis was running. Nothing was saved. Try again."


def now_ms():
    return int(time.time() * 1000)


class ApiError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


class _Ctx:
    """Tracks the stage of one running job and writes progress as it goes."""

    def __init__(self, mgr, job):
        self.mgr, self.job, self.id = mgr, job, job["id"]
        self.t0 = self.cur_t = mgr.clock()
        self.cur = "checking"
        self.timings, self.skipped, self.usage_ = {}, [], {}

    def _t(self):
        return {**self.timings, "_skipped": self.skipped}

    def stage(self, name):
        now = self.mgr.clock()
        self.timings[self.cur] = now - self.cur_t
        self.cur, self.cur_t = name, now
        self.mgr.store.update_job(self.id, only_if_state="running", stage=name, timings=self._t(), updated_at=now)

    def skip(self, *names):
        self.skipped += [n for n in names if n not in self.skipped]

    def meta(self, **kw):
        self.mgr.store.update_job(self.id, only_if_state="running", updated_at=self.mgr.clock(),
                                  **{k: v for k, v in kw.items() if k in ("title", "author", "source") and v is not None})

    def usage(self, key, u):
        self.usage_[key] = u
        self.mgr.store.update_job(self.id, only_if_state="running", usage=self.usage_)

    def done(self, rid, payload):
        now = self.mgr.clock()
        self.timings[self.cur] = now - self.cur_t
        self.timings["total"] = now - self.t0
        import json
        n = self.mgr.store.run(
            "UPDATE jobs SET state='done', stage='done', record_id=?, payload=?, timings=?, error_code=NULL, error_message=NULL, "
            "retryable=NULL, finished_at=?, updated_at=? WHERE id=? AND (state='running' OR (state='failed' AND error_code='timeout'))",
            (rid, json.dumps(payload, ensure_ascii=False), json.dumps(self._t()), now, now, self.id))
        if n:
            self.mgr._settle_followers(self.id)
            self.mgr.feed_job(self.id)


class JobManager:
    def __init__(self, store, records, providers, spec, limits, clock=now_ms, sim_delay=1.0):
        self.store, self.records, self.providers, self.spec, self.limits, self.clock = store, records, providers, spec, limits, clock
        self.sim_delay = sim_delay
        self.feed = None                  # FeedWriter, set by the server; None in tests that don't need it
        self.account_exempt = None        # uid -> True for the Slant team (owner, Editors); set by the server
        self.pool = ThreadPoolExecutor(max_workers=int(limits["workers"]), thread_name_prefix="slant-job")
        self._stop = threading.Event()
        self._watchdog = None

    # ---- lifecycle --------------------------------------------------------------------------------------------
    def start(self):
        self.recover()
        self._watchdog = threading.Thread(target=self._watch, name="slant-watchdog", daemon=True)
        self._watchdog.start()

    def stop(self):
        self._stop.set()
        self.pool.shutdown(wait=False, cancel_futures=True)

    def recover(self):
        now = self.clock()
        self.store.run("UPDATE jobs SET state='failed', error_code='interrupted', error_message=?, retryable=1, finished_at=?, updated_at=? "
                       "WHERE state='running'", (INTERRUPTED, now, now))
        for row in self.store.all("SELECT id FROM jobs WHERE state IN ('failed','done') AND id IN "
                                  "(SELECT follows FROM jobs WHERE follows IS NOT NULL AND state IN ('queued','running'))"):
            self._settle_followers(row["id"])
        for row in self.store.all("SELECT id FROM jobs WHERE state='queued' AND follows IS NULL ORDER BY created_at"):
            self._enqueue(row["id"])

    def _watch(self):
        while not self._stop.wait(10):
            try:
                self.check_timeouts()
            except Exception:
                traceback.print_exc()

    def check_timeouts(self):
        cutoff = self.clock() - int(self.limits["job_timeout_seconds"]) * 1000
        for row in self.store.all("SELECT id FROM jobs WHERE state='running' AND started_at<?", (cutoff,)):
            self._fail(row["id"], "timeout", "This analysis took too long and was stopped. Try again.", True)

    # ---- submission -------------------------------------------------------------------------------------------
    def submit(self, cred, url, idem_key, mode="auto", simulate=None, target=None):
        """Returns (job_row, created)."""
        parsed = ytid.parse(url)
        if not parsed:
            raise ApiError(400, "unsupported_url", "Open a YouTube video to analyze it.")
        if not isinstance(idem_key, str) or not IDEM_RE.match(idem_key):
            raise ApiError(400, "bad_request", "Missing or invalid idempotency key.")
        if mode not in ("auto", "fresh"):
            raise ApiError(400, "bad_request", "Unknown mode.")
        if simulate is not None and (not cred.get("test") or simulate not in SIMULATIONS):
            raise ApiError(403, "forbidden", "Simulated jobs are only available to test browsers.")
        vid = parsed["videoId"]
        prior = self.store.job_by_idem(cred["id"], idem_key)
        if prior:
            return self._same_request(prior, vid, mode)
        acct = cred.get("uid")
        limited_acct = acct if acct and not (self.account_exempt and self.account_exempt(acct)) else None  # outside the lock
        cached_rid, cached_rec = (None, None)
        if mode == "auto" and not simulate:
            cached_rid, cached_rec = self.records.latest_for(vid)     # Firebase read happens outside the lock
        with self.store.lock:
            prior = self.store.job_by_idem(cred["id"], idem_key)
            if prior:
                return self._same_request(prior, vid, mode)
            now = self.clock()
            row = dict(id="job_" + secrets.token_urlsafe(12), credential_id=cred["id"], idem_key=idem_key, video_id=vid,
                       canonical_url=parsed["canonicalUrl"], is_short=1 if parsed["isShort"] else 0, mode=mode,
                       spec_hash=self.spec["HASH"], state="queued", stage="queued", created_at=now, updated_at=now)
            if target and mode == "fresh":
                row.update(target=target)
            if simulate:
                row.update(simulate=simulate)
                self.store.insert_job(row)
                self._enqueue(row["id"])
                return self.store.job(row["id"]), True
            if cached_rid:
                row.update(state="done", stage="done", cached=1, record_id=cached_rid, title=cached_rec.get("title"),
                           author=cached_rec.get("author"), source=cached_rec.get("source"), started_at=now, finished_at=now)
                self.store.insert_job(row)
                self.feed_job(row["id"])          # opening a saved analysis from the extension counts as choosing it
                return self.store.job(row["id"]), True
            leader = self.store.inflight_leader(vid, self.spec["HASH"])
            if leader:
                row.update(follows=leader["id"], title=leader.get("title"), author=leader.get("author"))
                self.store.insert_job(row)
                return self.store.job(row["id"]), True
            self._enforce_limits(cred, limited_acct)
            row.update(paid=1, public=1 if limited_acct else 0)
            self.store.insert_job(row)
        self._enqueue(row["id"])
        return self.store.job(row["id"]), True

    @staticmethod
    def _same_request(prior, vid, mode):
        if prior["video_id"] != vid or prior["mode"] != mode:
            raise ApiError(409, "idempotency_conflict", "This request ID was already used for a different request.")
        return prior, False

    def _enforce_limits(self, cred, limited_acct=None):
        L, day_ago = self.limits, self.clock() - 86_400_000
        if self.store.active_paid(cred["id"]) >= L["per_browser_active"]:
            raise ApiError(429, "busy", "This browser already has an analysis running. Wait for it to finish.")
        if limited_acct and self.store.active_paid_uid(limited_acct) >= L["account_active"]:
            raise ApiError(429, "busy", "Another of your browsers has an analysis running. Wait for it to finish.")
        if limited_acct and self.store.paid_since_uid(day_ago, limited_acct) >= L["account_daily"]:
            raise ApiError(429, "daily_limit", f"Your Mana account has used its {L['account_daily']} new analyses for the last 24 hours. Saved analyses still open.")
        if self.store.active_paid() >= L["queue_max"]:
            raise ApiError(429, "busy", "Slant is busy with other analyses right now. Try again in a minute.")
        if not cred["id"].startswith("web_") and self.store.paid_since(day_ago, cred["id"]) >= L["per_browser_daily"]:
            raise ApiError(429, "daily_limit", f"This browser has used its {L['per_browser_daily']} new analyses for the last 24 hours. Saved analyses still open.")
        # The overall daily cap counts and limits only public accounts; the Slant team (owner, Editors) is exempt.
        if limited_acct and self.store.paid_since(day_ago, public_only=True) >= L["global_daily"]:
            raise ApiError(429, "daily_limit", f"Slant has reached its {L['global_daily']} new analyses for public accounts in the last 24 hours. Saved analyses still open.")

    # ---- execution --------------------------------------------------------------------------------------------
    def _enqueue(self, job_id):
        self.pool.submit(self._run_safe, job_id)

    def _run_safe(self, job_id):
        try:
            self._run(job_id)
        except JobError as e:
            self._fail(job_id, e.code, e.message, e.retryable)
        except Exception:
            traceback.print_exc()
            self._fail(job_id, "internal", "Something went wrong on the Slant backend. Nothing was saved. Try again.", True)

    def _fail(self, job_id, code, message, retryable):
        now = self.clock()
        if self.store.update_job(job_id, only_if_state=("queued", "running"), state="failed", error_code=code,
                                 error_message=message, retryable=1 if retryable else 0, finished_at=now, updated_at=now):
            self._settle_followers(job_id)

    # ---- feed history -----------------------------------------------------------------------------------------
    def feed_job(self, job_id, sync=False):
        """Add a finished job's video to the browser owner's Slant feed, once per job. Runs in the background."""
        if not self.feed:
            return
        row = self.store.one("SELECT j.id, j.state, j.record_id, j.simulate, j.credential_id, c.uid FROM jobs j JOIN credentials c ON c.id=j.credential_id "
                             "WHERE j.id=?", (job_id,))
        if not row or row["state"] != "done" or not row["record_id"] or row["simulate"] or not row["uid"]:
            return
        if self.store.run("UPDATE jobs SET fed=1 WHERE id=? AND fed=0", (job_id,)) != 1:
            return

        def go():
            try:
                rec = self.records.get(row["record_id"])
                if isinstance(rec, dict):
                    from .records import unpack_result
                    self.feed.record(row["uid"], row["record_id"], {**rec, "result": unpack_result(rec.get("result"))},
                                     via="app" if row["credential_id"].startswith("web_") else "chrome-extension")
            except Exception:
                traceback.print_exc()
                self.store.run("UPDATE jobs SET fed=0 WHERE id=?", (job_id,))
        if sync:
            go()
        else:
            threading.Thread(target=go, name="slant-feed", daemon=True).start()

    def _settle_followers(self, leader_id):
        l = self.store.one("SELECT * FROM jobs WHERE id=?", (leader_id,))
        if not l or l["state"] not in ("done", "failed"):
            return
        self.store.run("UPDATE jobs SET state=?, stage=?, error_code=?, error_message=?, retryable=?, record_id=?, title=?, author=?, "
                       "source=?, finished_at=?, updated_at=? WHERE follows=? AND state IN ('queued','running')",
                       (l["state"], l["stage"], l["error_code"], l["error_message"], l["retryable"], l["record_id"], l["title"],
                        l["author"], l["source"], l["finished_at"], l["updated_at"], leader_id))
        if l["state"] == "done":
            for f in self.store.all("SELECT id FROM jobs WHERE follows=? AND state='done' AND fed=0", (leader_id,)):
                self.feed_job(f["id"])

    def _run(self, job_id):
        job = self.store.job(job_id)
        if not job or job["state"] != "queued":
            return
        now = self.clock()
        if not self.store.update_job(job_id, only_if_state="queued", state="running", stage="checking", started_at=now, updated_at=now):
            return
        ctx = _Ctx(self, job)
        if job["simulate"]:
            return self._simulate(ctx, job)
        vid, L = job["video_id"], self.limits

        if job["mode"] == "fresh":                 # like the app's Re-analyze: reuse the saved transcript
            rid, rec = self.records.latest_for(vid)
            if job.get("target"):                  # the website re-analyzes the exact report it shows
                trec = self.records.get(job["target"])
                if isinstance(trec, dict) and trec.get("videoId") == vid and trec.get("result"):
                    rid, rec = job["target"], trec
            snips = normalize_snips(self.records.transcript(rid)) if rid else []
            if rid and snips:
                meta = {"title": rec.get("title"), "author": rec.get("author"), "source": rec.get("source")}
                ctx.meta(**meta)
                ctx.skip("captions", "transcribing")
                ctx.stage("analyzing")
                result, truncated, usage = self.providers.analyze(meta, snips)
                ctx.usage("analysis", usage)
                ctx.stage("saving")
                self.records.update_reanalysis(rid, result, truncated, self.spec["MODEL"], {"analysisVersion": self.spec["HASH"]})
                return ctx.done(rid, self.records.payload(rid, snips=snips))

        # title and availability first (oEmbed, ~0.3 s): the panel can show the title, and private or removed videos stop here
        oe_status, oe = self.providers.oembed(vid)
        if oe_status in (401, 403):
            raise JobError("video_unavailable", "This video is private or doesn't allow embedding, so Slant can't read it.", False)
        if oe_status in (400, 404):
            raise JobError("video_unavailable", "This video doesn't exist or was removed.", False)
        if oe:
            ctx.meta(title=oe.get("title"), author=oe.get("author_name"))
        ctx.stage("captions")
        cap = self.providers.captions(vid)
        cj = cap.get("json") or {}
        if cap["ok"]:
            snips = normalize_snips(cj["snippets"])
            source = "auto-captions" if cj.get("isGenerated") else "captions"
            meta = {"title": cj.get("title"), "author": cj.get("author"), "language": cj.get("language")}
            if not meta["title"] and oe:
                meta.update(title=oe.get("title"), author=oe.get("author_name"))
            ctx.skip("transcribing")
            last = snips[-1] if snips else None
            dur = (last["t"] + last["d"]) if last else 0
            if dur > L["max_minutes_captions"] * 60:
                raise JobError("too_long", f"This video is {round(dur / 60)} minutes long. The extension analyzes videos up to {L['max_minutes_captions']} minutes.", False)
        else:
            kind = cj.get("kind")
            meta = {"title": cj.get("title"), "author": cj.get("author")}
            if kind == "VideoUnavailable":
                raise JobError("video_unavailable", "This video is unavailable (private, removed or blocked in this region).", False)
            if kind == "AgeRestricted":
                raise JobError("video_unavailable", "This video is age-restricted, so Slant can't read it.", False)
            if not meta.get("title") and oe:
                meta = {"title": oe.get("title"), "author": oe.get("author_name")}
            info = self.providers.watch_info(vid)
            reason = info.get("reason") or ""
            blocked = info.get("playability") == "LOGIN_REQUIRED" and "bot" in reason.lower()   # YouTube bot check on the sandbox
            if info.get("upcoming"):
                raise JobError("video_unavailable", "This video hasn't premiered yet.", False)
            if info.get("live"):
                raise JobError("video_unavailable", "This live stream is still going. Analyze it after it ends.", False)
            if info.get("playability") and info["playability"] != "OK" and not blocked:
                why = reason or info["playability"].replace("_", " ").lower()
                raise JobError("video_unavailable", f"YouTube won't play this video without signing in ({why}).", False)
            length = None if blocked else info.get("length")
            max_s = L["max_minutes_ai"] * 60
            if length is not None and length > max_s:
                raise JobError("too_long", f"This video has no captions and is {round(length / 60)} minutes long. The extension only sends videos up to {L['max_minutes_ai']} minutes to AI transcription.", False)
            if length is None:
                tokens = self.providers.gemini_count_tokens(vid)     # free count; Google reads the video, not the sandbox
                if tokens is None:
                    raise JobError("length_unknown", "This video has no captions and Slant couldn't confirm its length, so it didn't start a paid AI transcription. Try again in a minute.", True)
                ctx.usage("lengthCheck", {"promptTokens": tokens, "free": True})
                if tokens > max_s * L["ai_tokens_per_second"] * 1.1:
                    raise JobError("too_long", f"This video has no captions and is about {round(tokens / L['ai_tokens_per_second'] / 60)} minutes long. The extension only sends videos up to {L['max_minutes_ai']} minutes to AI transcription.", False)
            ctx.meta(title=meta.get("title"), author=meta.get("author"))
            ctx.stage("transcribing")
            raw, usage = self.providers.gemini_transcribe(vid)
            ctx.usage("transcription", usage)
            snips = normalize_snips(raw)
            if not snips:
                raise JobError("no_speech", "No speech was found in this video.", False)
            source = "ai-transcription"

        ctx.meta(title=meta.get("title"), author=meta.get("author"), source=source)
        ctx.stage("analyzing")
        result, truncated, usage = self.providers.analyze({**meta, "source": source}, snips)
        ctx.usage("analysis", usage)
        ctx.stage("saving")
        last = snips[-1] if snips else None
        fields = {"videoId": vid, "url": job["canonical_url"], "title": meta.get("title") or "", "author": meta.get("author") or "",
                  "language": meta.get("language") or "", "source": source, "model": self.spec["MODEL"], "segments": len(snips),
                  "duration": (last["t"] + last["d"]) if last else 0, "truncated": truncated, "result": result}
        via = "app" if job["credential_id"].startswith("web_") else "chrome-extension"
        rid, record = self.records.save_new(fields, snips, {"analysisVersion": self.spec["HASH"], "via": via})
        ctx.done(rid, self.records.payload(rid, record, snips))

    def _simulate(self, ctx, job):
        """Test browsers only: walks the stages with delays and no provider calls; nothing is written to Firebase."""
        sim, d = job["simulate"], self.sim_delay
        _, known = self.records.latest_for(job["video_id"])
        if known:
            ctx.meta(title=known.get("title"), author=known.get("author"))
        plan = [("checking", 1), ("captions", 2), ("analyzing", 5), ("saving", 1)]
        for i, (st, units) in enumerate(plan):
            if i:
                ctx.stage(st)
            if st == "analyzing":
                fail = {"fail-credits": ("insufficient_credits", "The Mana account behind Slant is out of credits, so nothing ran.", False),
                        "fail-rate": ("rate_limited", "The AI service is rate-limiting requests. Try again in a minute.", True),
                        "fail-provider": ("provider_error", "Mana's AI service had a temporary problem (503). Try again.", True),
                        "fail-malformed": ("malformed_output", "The model's report didn't match Slant's format, so nothing was saved.", True)}.get(sim)
                if fail:
                    time.sleep(d)
                    raise JobError(*fail)
            if st == "captions" and sim == "fail-unavailable":
                raise JobError("video_unavailable", "This video is private or doesn't allow embedding, so Slant can't read it.", False)
            if sim == "hang" and st == "analyzing":
                while not self._stop.wait(1):
                    if self.store.job(job["id"])["state"] != "running":
                        return
            if self._stop.wait(d * units):
                return
        ctx.skip("transcribing")
        rid, rec = self.records.latest_for(job["video_id"])
        if not rid:
            for k, v in (self.records.analyses() or {}).items():
                if isinstance(v, dict) and v.get("result"):
                    rid, rec = k, v
                    break
        payload = self.records.payload(rid, rec) if rid else None
        if payload:
            payload["simulated"] = True
        ctx.meta(title=(rec or {}).get("title"), author=(rec or {}).get("author"), source=(rec or {}).get("source"))
        ctx.done(rid, payload)

    # ---- views ------------------------------------------------------------------------------------------------
    def get_for(self, cred, job_id):
        job = self.store.job(job_id) if isinstance(job_id, str) and len(job_id) < 64 else None
        if not job or job["credential_id"] != cred["id"]:
            raise ApiError(404, "not_found", "This analysis job doesn't exist for this browser.")
        return job

    def view(self, job):
        src, coalesced = job, False
        if job.get("follows"):
            leader = self.store.job(job["follows"])
            if leader:
                src, coalesced = leader, True
        state = src["state"]
        payload = src.get("payload")
        if state == "done" and payload is None and src.get("record_id"):
            payload = self.records.payload(src["record_id"])
            if payload:
                self.store.update_job(src["id"], payload=payload)
            else:
                state = "failed"
        rec = (payload or {}).get("record") or {}
        err = None
        if state == "failed":
            err = {"code": src.get("error_code") or "record_missing",
                   "message": src.get("error_message") or "The saved analysis was deleted from Slant.",
                   "retryable": bool(src.get("retryable")) if src.get("error_code") else True}
        timings = src.get("timings") or {}
        return {
            "id": job["id"], "state": state, "stage": src["stage"], "stageLabel": STAGE_LABEL.get(src["stage"], src["stage"]),
            "mode": job["mode"], "cached": bool(src["cached"]), "coalesced": coalesced, "simulated": bool(src.get("simulate")),
            "video": {"id": job["video_id"], "url": job["canonical_url"], "isShort": bool(job["is_short"]),
                      "title": src.get("title") or rec.get("title"), "author": src.get("author") or rec.get("author")},
            "createdAt": job["created_at"], "startedAt": src.get("started_at"), "finishedAt": src.get("finished_at"),
            "serverNow": self.clock(), "timings": {k: v for k, v in timings.items() if not k.startswith("_")},
            "stages": [] if src["cached"] else self._stages(src, state, timings),
            "error": err,
            "analysis": None if not payload else {
                "createdAt": rec.get("createdAt"), "updatedAt": rec.get("updatedAt"), "version": rec.get("analysisVersion"),
                "currentVersion": self.spec["HASH"], "via": rec.get("via"), "source": rec.get("source")},
            "result": payload if state == "done" else None,
        }

    @staticmethod
    def _stages(src, state, timings):
        skipped = set(timings.get("_skipped") or [])
        out = []
        for key, label in STAGES:
            if key in skipped:
                status = "skipped"
            elif key == src["stage"] and state == "running":
                status = "active"
            elif key == src["stage"] and state == "failed":
                status = "failed"
            elif key in timings or state == "done":
                status = "done"
            else:
                status = "pending"
            out.append({"key": key, "label": label, "status": status, "ms": timings.get(key)})
        return out
