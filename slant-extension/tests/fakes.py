"""In-memory stand-ins for Firebase and the outside providers (no network, no credits)."""
import copy
import threading
import time

from slant_ext.providers import JobError


class FakeFirebase:
    def __init__(self, tree=None):
        self.tree = copy.deepcopy(tree or {})
        self.lock = threading.Lock()
        self.updates = []

    def _node(self, path, create=False):
        cur = self.tree
        for seg in [p for p in path.split("/") if p]:
            if not isinstance(cur, dict):
                return None
            if seg not in cur:
                if not create:
                    return None
                cur[seg] = {}
            cur = cur[seg]
        return cur

    def read(self, path):
        with self.lock:
            return copy.deepcopy(self._node(path))

    def update(self, path, data):
        with self.lock:
            self.updates.append((path, copy.deepcopy(data)))
            for k, v in data.items():
                full = path.rstrip("/") + "/" + k
                parent_path, _, leaf = full.rpartition("/")
                parent = self._node(parent_path, create=True)
                if v is None:
                    parent.pop(leaf, None)
                else:
                    parent[leaf] = copy.deepcopy(v)


def report(score=-3, overall=4, quotes=True):
    q = [{"seg": 2, "quote": "Riyadh Airport is closed", "why": "context"}] if quotes else []
    return {"headline": "H", "summary": "S", "topic": "T", "contentType": "C", "overall": overall,
            "political": {"applicable": True, "score": score, "label": "L", "confidence": "medium", "explanation": "E", "quotes": q},
            "dimensions": [{"key": "one_sided", "score": 3, "explanation": "x", "quotes": q},
                           {"key": "loaded_language", "score": 1, "explanation": "y", "quotes": []}],
            "balance": ["b"], "caveats": ["c"]}


SNIPS = [{"t": 0, "d": 2, "text": "So, we are driving"}, {"t": 2, "d": 2, "text": "through the desert"},
         {"t": 4, "d": 3, "text": "Riyadh Airport is closed"}]


class FakeProviders:
    def __init__(self, spec):
        self.spec = spec
        self.calls = {"captions": 0, "oembed": 0, "watch": 0, "gemini": 0, "analyze": 0, "count": 0}
        self.count_result = 16663
        self.captions_result = {"ok": True, "offline": False, "status": 200,
                                "json": {"snippets": SNIPS, "isGenerated": True, "title": "Road to Bahrain", "author": "Reuters", "language": "English"}}
        self.oembed_result = (200, {"title": "Road to Bahrain", "author_name": "Reuters"})
        self.watch_result = {"length": 161, "playability": "OK", "reason": None, "live": False, "upcoming": False}
        self.gemini_result = ([{"t": 0, "d": 4, "text": "Transcribed line"}], {"promptTokens": 10, "outputTokens": 5})
        self.analyze_result = None
        self.analyze_error = None
        self.gemini_error = None
        self.block = None          # threading.Event: analyze waits until set
        self.last_meta = None

    def captions(self, vid):
        self.calls["captions"] += 1
        return copy.deepcopy(self.captions_result)

    def oembed(self, vid):
        self.calls["oembed"] += 1
        return self.oembed_result

    def watch_info(self, vid):
        self.calls["watch"] += 1
        return dict(self.watch_result)

    def gemini_count_tokens(self, vid):
        self.calls["count"] += 1
        if isinstance(self.count_result, Exception):
            raise self.count_result
        return self.count_result

    def gemini_transcribe(self, vid):
        self.calls["gemini"] += 1
        if self.gemini_error:
            raise self.gemini_error
        return copy.deepcopy(self.gemini_result)

    def analyze(self, meta, snips):
        self.calls["analyze"] += 1
        self.last_meta = dict(meta)
        if self.block:
            self.block.wait(10)
        if self.analyze_error:
            raise self.analyze_error
        return copy.deepcopy(self.analyze_result or report()), False, {"promptTokens": 100, "outputTokens": 50}

    def probe(self):
        return {"openai": {"status": 400, "authorized": True}}


def wait_for(fn, timeout=5.0):
    end = time.time() + timeout
    while time.time() < end:
        v = fn()
        if v:
            return v
        time.sleep(0.02)
    raise AssertionError("condition not met in time")
