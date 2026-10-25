"""Outside calls. Only fixed destinations, never caller-supplied URLs:
- the existing yt-bias caption service on loopback (unchanged, shared with the Slant app),
- YouTube oEmbed and the watch page for a validated 11-character video ID (availability and length checks),
- Gemini and OpenAI through the Mana router: Mana's keys stay server-side and usage is billed to the owner's Mana credits.
The request bodies are built exactly as Slant's browser code builds them (tests/golden compares them)."""
import copy
import json
import math
import re
import threading

import requests

from . import jsport

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"


class JobError(Exception):
    def __init__(self, code, message, retryable=False):
        super().__init__(message)
        self.code, self.message, self.retryable = code, message, retryable


# ---- request builders and parsers (ports of Slant's geminiTranscript / runAnalysis) -------------------------
def build_gemini_body(spec, vid):
    body = copy.deepcopy(spec["GEMINI_REQUEST"])
    body["contents"][0]["parts"][0]["fileData"]["fileUri"] = "https://www.youtube.com/watch?v=" + vid
    return body


def parse_gemini(j):
    cands = j.get("candidates") if isinstance(j, dict) else None
    content = (cands[0] or {}).get("content") if isinstance(cands, list) and cands else None
    parts = (content or {}).get("parts") or []
    text = "".join(p["text"] for p in parts if isinstance(p, dict) and p.get("text") and not p.get("thought")).strip()
    text = re.sub(r"\A```(?:json)?", "", text, count=1, flags=re.I)
    text = re.sub(r"```\Z", "", text, count=1).strip()
    try:
        arr = json.loads(text)
    except ValueError:
        cut = text.rfind("},")
        try:
            arr = json.loads(text[: cut + 1] + "]")
        except ValueError:
            raise JobError("transcription_unreadable", "AI transcription returned unreadable output.", True)
    arr = arr if isinstance(arr, list) else []
    items = [x for x in arr if isinstance(x, dict) and isinstance(x.get("text"), str) and jsport.trim(x["text"])]
    out = []
    for i, x in enumerate(items):
        t = jsport.num_or0(x.get("t"))
        nxt = jsport.to_number(items[i + 1].get("t")) if i + 1 < len(items) else math.nan
        end = nxt if jsport.truthy(nxt) else t + 5
        out.append({"t": t, "d": max(0, end - t), "text": jsport.trim(x["text"])})
    return out


def normalize_snips(snips):
    """The app's snipsN: { t: Number(s.t) || 0, d: Number(s.d) || 0, text: String(s.text || '') }."""
    if isinstance(snips, dict):
        snips = [snips[k] for k in sorted(snips, key=lambda k: int(k) if str(k).isdigit() else 10 ** 9)]
    out = []
    for s in snips or []:
        s = s if isinstance(s, dict) else {}
        text = s.get("text")
        out.append({"t": jsport.num_or0(s.get("t")), "d": jsport.num_or0(s.get("d")), "text": jsport.js_string(text) if text else ""})
    return out


def build_analysis_body(spec, meta, snips):
    lines = []
    for i, s in enumerate(snips):
        text = s.get("text") if "text" in s else None
        ts = "undefined" if "text" not in s else jsport.js_string(text)
        lines.append("[" + str(i) + " " + jsport.fmt_t(s.get("t")) + "] " + jsport.trim(jsport.collapse_ws(ts)))
    tx = "\n".join(lines)
    truncated = False
    if jsport.utf16_len(tx) > spec["MAX_CHARS"]:
        tx = jsport.utf16_slice(tx, spec["MAX_CHARS"])
        truncated = True
    src = meta.get("source")
    label = spec["SRC_LABEL"].get(src) if isinstance(src, str) else None
    user = ("Video title: " + (meta.get("title") or "(unknown)") + "\nChannel: " + (meta.get("author") or "(unknown)")
            + "\nTranscript source: " + (label or ("undefined" if src is None else jsport.js_string(src)))
            + (spec["ANALYSIS_TRUNCATION_NOTE"] if truncated else "")
            + "\n\nTRANSCRIPT. Each line is [segment-number timestamp] text.\n" + tx)
    body = {"model": spec["MODEL"], "messages": [{"role": "system", "content": spec["SYSTEM"]}, {"role": "user", "content": user}],
            "response_format": {"type": "json_schema", "json_schema": {"name": "bias_report", "strict": True, "schema": spec["SCHEMA"]}}}
    return body, truncated


def validate_result(node, schema, path="result", errs=None):
    """Checks a parsed report against Slant's JSON schema (types, required keys, enums, no extra keys)."""
    errs = [] if errs is None else errs
    t = schema.get("type")
    if t == "object":
        if not isinstance(node, dict):
            errs.append(path + ": not an object")
            return errs
        for k in schema.get("required", []):
            if k not in node:
                errs.append(f"{path}.{k}: missing")
        props = schema.get("properties", {})
        for k, v in node.items():
            if k in props:
                validate_result(v, props[k], f"{path}.{k}", errs)
            elif schema.get("additionalProperties") is False:
                errs.append(f"{path}.{k}: unexpected")
    elif t == "array":
        if not isinstance(node, list):
            errs.append(path + ": not an array")
        else:
            for i, item in enumerate(node):
                validate_result(item, schema.get("items", {}), f"{path}[{i}]", errs)
    elif t == "string":
        if not isinstance(node, str):
            errs.append(path + ": not a string")
        elif "enum" in schema and node not in schema["enum"]:
            errs.append(f"{path}: {node!r} not allowed")
    elif t == "number":
        if isinstance(node, bool) or not isinstance(node, (int, float)) or not math.isfinite(node):
            errs.append(path + ": not a number")
    elif t == "integer":
        if isinstance(node, bool) or not isinstance(node, int):
            errs.append(path + ": not an integer")
    elif t == "boolean":
        if not isinstance(node, bool):
            errs.append(path + ": not a boolean")
    return errs


def parse_analysis_response(j, spec):
    choices = j.get("choices") if isinstance(j, dict) else None
    msg = (choices[0] or {}).get("message") if isinstance(choices, list) and choices else None
    content = (msg or {}).get("content")
    if not content:
        raise JobError("malformed_output", "The model returned an empty report, so nothing was saved.", True)
    try:
        result = json.loads(content)
    except ValueError:
        raise JobError("malformed_output", "The model's report wasn't valid JSON, so nothing was saved.", True)
    errs = validate_result(result, spec["SCHEMA"])
    if not errs and len(json.dumps(result)) > 250_000:
        errs.append("report too large")
    if errs:
        raise JobError("malformed_output", "The model's report didn't match Slant's format, so nothing was saved.", True)
    return result


# ---- live providers ---------------------------------------------------------------------------------------
class LiveProviders:
    def __init__(self, spec, yt_bias_port, router=None):
        self.spec = spec
        self.port = yt_bias_port
        self._router = router
        self._lock = threading.Lock()

    def _proxy(self, provider):
        if self._router is None:
            import mana_router
            self._router = mana_router
        return self._router.provider(provider)

    def _post(self, provider, path, body, timeout):
        r = None
        for attempt in (1, 2):
            with self._lock:
                p = self._proxy(provider)
                if attempt == 2:
                    try:
                        p._url = ""          # force a fresh mint after a 401
                    except Exception:
                        pass
                url, headers = p.url, dict(p.headers)
            try:
                r = requests.post(url + path, headers=headers, json=body, timeout=timeout, allow_redirects=False)
            except requests.Timeout:
                raise JobError("provider_timeout", "The AI service took too long to answer. Try again.", True)
            except requests.RequestException:
                raise JobError("provider_error", "Couldn't reach Mana's AI service. Try again.", True)
            if r.status_code != 401:
                break
        if r.status_code == 402:
            raise JobError("insufficient_credits", "The Mana account behind Slant is out of credits, so nothing ran.", False)
        if r.status_code == 429:
            raise JobError("rate_limited", "The AI service is rate-limiting requests. Try again in a minute.", True)
        if r.status_code in (500, 502, 503, 504):
            raise JobError("provider_error", f"Mana's AI service had a temporary problem ({r.status_code}). Try again.", True)
        if r.status_code == 410:
            raise JobError("provider_error", "This AI model is no longer offered.", False)
        return r

    def captions(self, vid):
        try:
            r = requests.get(f"http://127.0.0.1:{self.port}/transcript", params={"url": vid}, timeout=45)
        except requests.RequestException:
            return {"ok": False, "offline": True, "status": None, "json": {}}
        try:
            j = r.json()
        except ValueError:
            j = {}
        ok = r.status_code == 200 and isinstance(j.get("snippets"), list) and len(j["snippets"]) > 0
        return {"ok": ok, "offline": False, "status": r.status_code, "json": j if isinstance(j, dict) else {}}

    def oembed(self, vid):
        try:
            r = requests.get("https://www.youtube.com/oembed", headers={"User-Agent": UA}, timeout=10,
                             params={"format": "json", "url": "https://www.youtube.com/watch?v=" + vid})
        except requests.RequestException:
            return None, {}
        try:
            j = r.json() if r.status_code == 200 else {}
        except ValueError:
            j = {}
        return r.status_code, j

    def watch_info(self, vid):
        info = {"length": None, "playability": None, "reason": None, "live": False, "upcoming": False}
        try:
            r = requests.get("https://www.youtube.com/watch", params={"v": vid}, timeout=15, stream=True,
                             headers={"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"})
            body = r.raw.read(4_000_000, decode_content=True).decode("utf-8", "replace")
            r.close()
        except Exception:
            return info
        i = body.find("ytInitialPlayerResponse = ")
        if i >= 0:
            try:
                obj, _ = json.JSONDecoder().raw_decode(body, body.find("{", i))
                vd, ps = obj.get("videoDetails") or {}, obj.get("playabilityStatus") or {}
                ln = str(vd.get("lengthSeconds") or "")
                info.update(length=int(ln) if ln.isdigit() else None, playability=ps.get("status"), reason=ps.get("reason"),
                            live=bool(vd.get("isLive")), upcoming=bool(vd.get("isUpcoming")))
                return info
            except Exception:
                pass
        m = re.search(r'"lengthSeconds":"(\d+)"', body)
        p = re.search(r'"playabilityStatus":\{"status":"([A-Z_]+)"', body)
        info.update(length=int(m.group(1)) if m else None, playability=p.group(1) if p else None)
        return info

    def gemini_count_tokens(self, vid):
        """Input tokens Gemini would bill for this video (Google reads it, so this works even when YouTube blocks the sandbox).
        Counting generates nothing. Returns an int, None if unknown; raises if Google can't read the video at all."""
        body = {"generateContentRequest": {"model": "models/" + self.spec["GEM_MODEL"],
                                           "contents": [{"parts": [{"fileData": {"fileUri": "https://www.youtube.com/watch?v=" + vid}}]}],
                                           "generationConfig": {"mediaResolution": self.spec["GEMINI_REQUEST"].get("generationConfig", {}).get("mediaResolution", "MEDIA_RESOLUTION_LOW")}}}
        try:
            r = self._post("gemini", self.spec["GEMINI_PATH"].replace(":generateContent", ":countTokens"), body, timeout=60)
        except JobError as e:
            if e.code in ("insufficient_credits", "rate_limited"):
                raise
            return None
        if r.status_code in (400, 403, 404):
            raise JobError("video_unavailable", "Google couldn't read this video (it may be private, age-restricted or removed).", False)
        if r.status_code != 200:
            return None
        try:
            n = r.json().get("totalTokens")
        except ValueError:
            return None
        return int(n) if isinstance(n, (int, float)) else None

    def gemini_transcribe(self, vid):
        r = self._post("gemini", self.spec["GEMINI_PATH"], build_gemini_body(self.spec, vid), timeout=300)
        if r.status_code >= 400:
            raise JobError("transcription_failed", f"AI transcription failed ({r.status_code}). The video may be private or too long.", False)
        try:
            j = r.json()
        except ValueError:
            raise JobError("transcription_unreadable", "AI transcription returned unreadable output.", True)
        u = j.get("usageMetadata") or {}
        return parse_gemini(j), {"promptTokens": u.get("promptTokenCount"), "outputTokens": u.get("candidatesTokenCount")}

    def analyze(self, meta, snips):
        body, truncated = build_analysis_body(self.spec, meta, snips)
        r = self._post("openai", "/chat/completions", body, timeout=300)
        if r.status_code >= 400:
            raise JobError("analysis_failed", f"The analysis request was refused ({r.status_code}).", False)
        try:
            j = r.json()
        except ValueError:
            raise JobError("malformed_output", "The AI service returned an unreadable response.", True)
        u = j.get("usage") or {}
        return parse_analysis_response(j, self.spec), truncated, {"promptTokens": u.get("prompt_tokens"), "outputTokens": u.get("completion_tokens")}

    def probe(self):
        """Free auth check: a deliberately invalid request is refused by the provider and not billed."""
        out = {}
        for prov, path, body in (("openai", "/chat/completions", {"model": self.spec["MODEL"], "messages": []}),
                                 ("gemini", self.spec["GEMINI_PATH"].replace(":generateContent", ":countTokens"), {})):
            try:
                r = self._post(prov, path, body, timeout=20)
                out[prov] = {"status": r.status_code, "authorized": r.status_code not in (401, 403)}
            except JobError as e:
                out[prov] = {"error": e.code}
        return out
