"""Paths, limits and the Slant spec (prompt, schema, model settings extracted from the live app)."""
import hashlib
import json
import os
import secrets

ROOT = os.environ.get("SLANT_EXT_ROOT", "/workspace/slant-extension")
DATA_DIR = os.environ.get("SLANT_EXT_DATA", os.path.join(ROOT, "backend", "data"))
SPEC_PATH = os.environ.get("SLANT_EXT_SPEC", os.path.join(ROOT, "spec", "slant_spec.json"))
VERSION = "1.0.0"
SERVICE = "slant-ext"

# Conservative demo limits. Override any of them in data/limits.json (owner-side file).
DEFAULT_LIMITS = {
    "workers": 2,                    # analyses running at once (whole backend)
    "queue_max": 6,                  # queued + running paid jobs (whole backend)
    "per_browser_active": 1,         # paid jobs one paired browser may have queued/running
    "per_browser_daily": 20,         # new (non-cached) analyses per paired browser per rolling 24 h
    "global_daily": 40,              # new analyses for the whole backend per rolling 24 h
    "max_minutes_captions": 90,      # longest video analyzed from captions
    "max_minutes_ai": 20,            # longest video sent to paid AI transcription
    "ai_tokens_per_second": 104,     # Gemini input tokens per second of video at low media resolution (measured: 16,663 for 161 s)
    "job_timeout_seconds": 660,      # a job still running after this is failed as timed out
    "submit_per_minute": 12,         # POST /v1/jobs per browser
    "poll_per_minute": 150,          # GET /v1/jobs/<id> per browser
    "pair_attempts_per_10min": 10,   # POST /v1/pair per client IP
    "body_max_bytes": 4096,
    "pairing_code_ttl_seconds": 600,
    "max_active_pairing_codes": 5,
}

SPEC_HASH_KEYS = ("MODEL", "GEM_MODEL", "MAX_CHARS", "SYSTEM", "SCHEMA", "GEMINI_REQUEST", "SRC_LABEL", "DIMS")


def spec_hash(spec):
    key = {k: spec.get(k) for k in SPEC_HASH_KEYS}
    return hashlib.sha256(json.dumps(key, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:12]


def load_spec(path=SPEC_PATH):
    with open(path) as f:
        spec = json.load(f)
    spec["HASH"] = spec_hash(spec)
    return spec


def load_limits():
    limits = dict(DEFAULT_LIMITS)
    p = os.path.join(DATA_DIR, "limits.json")
    if os.path.exists(p):
        try:
            with open(p) as f:
                over = json.load(f)
            limits.update({k: v for k, v in over.items() if k in DEFAULT_LIMITS and isinstance(v, (int, float))})
        except Exception:
            pass
    return limits


def owner_uid():
    uid = os.environ.get("SLANT_EXT_OWNER")
    if uid:
        return uid
    import env  # noqa: F401  (loads /opt/sandbox_env/.env)
    return os.environ["SANDBOX_USER_ID"]


def secret_file(name, nbytes=32):
    """A random secret kept in DATA_DIR with mode 600 (pepper, admin token)."""
    os.makedirs(DATA_DIR, exist_ok=True)
    p = os.path.join(DATA_DIR, name)
    if not os.path.exists(p):
        fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(secrets.token_urlsafe(nbytes))
    with open(p) as f:
        return f.read().strip()
