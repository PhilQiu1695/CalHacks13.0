"""Per-person Slant feed: every video a person analyzes (in the app or with Slant for Chrome) is kept at
<owner>/file-system/slant-feeds/<uid>/videos/<videoId>, in the same shape the Slant app writes (feedSnap / recordFeed
in apps/slant/app/code). The app prunes entries older than the person's retention and builds the feed report."""
import threading
import time

DIM_KEYS = ("one_sided", "loaded_language", "sensationalism", "unsupported_claims", "ad_hominem")
LEAN_MAX = 6


def now_ms():
    return int(time.time() * 1000)


def _num(v, lo, hi):
    try:
        x = float(v)
    except (TypeError, ValueError):
        x = 0.0
    return min(hi, max(lo, x))


def snapshot(result):
    """Port of the app's feedSnap: the scores the feed report needs, kept even if the analysis is later deleted."""
    from .records import as_arr
    r = result if isinstance(result, dict) else {}
    pol = r.get("political") if isinstance(r.get("political"), dict) else {}
    dims = {}
    for d in as_arr(r.get("dimensions")):
        if isinstance(d, dict) and d.get("key") in DIM_KEYS:
            dims[d["key"]] = round(_num(d.get("score"), 0, 10), 1)
    applicable = bool(pol.get("applicable"))
    out = {"political": applicable, "overall": round(_num(r.get("overall"), 0, 10), 1), "dims": dims,
           "contentType": str(r.get("contentType") or "")[:120], "topic": str(r.get("topic") or "")[:240],
           "headline": str(r.get("headline") or "")[:160]}
    if applicable:
        out["lean"] = round(_num(pol.get("score"), -LEAN_MAX, LEAN_MAX), 1)
    return out


class FeedWriter:
    def __init__(self, fb, owner_uid, clock=now_ms):
        self.fb, self.root, self.clock = fb, f"{owner_uid}/file-system/slant-feeds", clock
        self._lock = threading.Lock()

    def record(self, uid, rid, record, via="chrome-extension"):
        if not uid or not isinstance(record, dict) or not record.get("videoId") or not record.get("result"):
            return False
        if any(c in uid for c in ".#$[]/"):
            return False
        vid = record["videoId"]
        base = f"{self.root}/{uid}"
        with self._lock:
            prev = self.fb.read(f"{base}/videos/{vid}") or {}
            has_meta = self.fb.read(f"{base}/metadata/type") is not None
            t = self.clock()
            meta = prev.get("metadata") if isinstance(prev.get("metadata"), dict) else {}
            vias = prev.get("vias") if isinstance(prev.get("vias"), dict) else {}
            entry = {"videoId": vid, "analysisId": rid, "url": record.get("url") or f"https://www.youtube.com/watch?v={vid}",
                     "title": str(record.get("title") or "")[:300], "author": str(record.get("author") or "")[:120],
                     "short": "/shorts/" in str(record.get("url") or "").lower(),
                     "firstAt": prev.get("firstAt") or t, "lastAt": t, "count": int(prev.get("count") or 0) + 1,
                     "vias": {**vias, via: True}, "s": snapshot(record.get("result")),
                     "metadata": {"type": "entry", "createdAt": meta.get("createdAt") or t, "updatedAt": t}}
            upd = {f"videos/{vid}": entry}
            if not has_meta:
                upd["metadata"] = {"type": "entry", "createdAt": t, "updatedAt": t}
            self.fb.update(base, upd)
        return True
