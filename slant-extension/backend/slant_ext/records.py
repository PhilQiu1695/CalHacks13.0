"""Slant's own records, read and written in the app's exact shape so they appear in its Mana history:
apps/slant/app/analyses/<id> and apps/slant/app/transcripts/<id>/snippets. Feedback (flags) is never touched."""
import threading
import time


def now_ms():
    return int(time.time() * 1000)


def as_arr(v):
    if isinstance(v, list):
        return [x for x in v if x is not None]
    if isinstance(v, dict):
        return [v[k] for k in sorted(v, key=lambda k: int(k) if str(k).lstrip("-").isdigit() else 0)]
    return []


def unpack_result(res):
    """Port of the app's unpackResult: editor-saved records keep dimension quotes as a JSON string (quotesJson)."""
    import json
    if not isinstance(res, dict) or not res.get("dimensions"):
        return res
    dims = []
    for d in as_arr(res.get("dimensions")):
        if isinstance(d, dict) and d.get("quotes") is None and isinstance(d.get("quotesJson"), str):
            try:
                q = json.loads(d["quotesJson"])
            except ValueError:
                q = []
            d = {k: v for k, v in d.items() if k != "quotesJson"}
            d["quotes"] = q if isinstance(q, list) else []
        dims.append(d)
    return {**res, "dimensions": dims}


RECORD_KEYS = ("videoId", "url", "title", "author", "language", "source", "model", "segments", "duration", "truncated",
               "analysisVersion", "via")


class SlantRecords:
    def __init__(self, fb, app_path, flag_perms, owner_uid, clock=now_ms, ttl_ms=15000):
        self.fb, self.app, self.flag_perms, self.owner = fb, app_path, flag_perms, owner_uid
        self.clock, self.ttl = clock, ttl_ms
        self._cache, self._cache_at = None, 0
        self._lock = threading.Lock()

    def analyses(self, force=False):
        with self._lock:
            if force or self._cache is None or self.clock() - self._cache_at > self.ttl:
                self._cache = self.fb.read(f"{self.app}/analyses") or {}
                self._cache_at = self.clock()
            return self._cache

    def invalidate(self):
        with self._lock:
            self._cache = None

    def latest_for(self, vid):
        """Newest saved analysis of this video (the one the Slant app opens), or None."""
        best = None
        for rid, rec in (self.analyses() or {}).items():
            if not isinstance(rec, dict) or rid == "metadata" or rid.startswith("_") or rec.get("videoId") != vid or not rec.get("result"):
                continue
            created = ((rec.get("metadata") or {}).get("createdAt")) or 0
            if best is None or created > best[0]:
                best = (created, rid, rec)
        return (best[1], best[2]) if best else (None, None)

    def get(self, rid):
        return self.fb.read(f"{self.app}/analyses/{rid}")

    def transcript(self, rid):
        return as_arr(self.fb.read(f"{self.app}/transcripts/{rid}/snippets"))

    def save_new(self, fields, snips, extra=None):
        rid = "v" + str(self.clock())
        while self.fb.read(f"{self.app}/analyses/{rid}/metadata") is not None:
            rid = "v" + str(int(rid[1:]) + 1)
        t = int(rid[1:])
        record = {**fields, **(extra or {}), "flags": {"metadata": {"permissions": dict(self.flag_perms)}},
                  "metadata": {"type": "entry", "createdAt": t, "updatedAt": t}}
        self.fb.update(self.app, {f"analyses/{rid}": record,
                                  f"transcripts/{rid}": {"snippets": snips, "metadata": {"type": "entry", "createdAt": t, "updatedAt": t}}})
        self.invalidate()
        return rid, record

    def update_reanalysis(self, rid, result, truncated, model, extra=None):
        """Same fields the app's Re-analyze writes; flags (Disagree? notes) and everything else are preserved."""
        self.fb.update(f"{self.app}/analyses/{rid}", {"result": result, "truncated": truncated, "model": model,
                                                      "metadata/updatedAt": self.clock(), **(extra or {})})
        self.invalidate()

    def mana_url(self, rid):
        return f"https://www.mana.space/home/{self.owner}/apps/slant?slant={rid}"

    def payload(self, rid, record=None, snips=None):
        record = record if record is not None else self.get(rid)
        if not isinstance(record, dict) or not record.get("result"):
            return None
        snips = snips if snips is not None else self.transcript(rid)
        meta = record.get("metadata") or {}
        return {"recordId": rid, "manaUrl": self.mana_url(rid),
                "record": {**{k: record.get(k) for k in RECORD_KEYS}, "result": unpack_result(record["result"]),
                           "createdAt": meta.get("createdAt"), "updatedAt": meta.get("updatedAt")},
                "snippets": [{"t": s.get("t", 0), "d": s.get("d", 0), "text": s.get("text", "")} for s in snips if isinstance(s, dict)]}
