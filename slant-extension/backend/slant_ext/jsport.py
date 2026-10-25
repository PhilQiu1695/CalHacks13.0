"""JavaScript-compatible string/number helpers so Python builds the exact request text Slant's browser code builds."""
import math
import re

JS_WS = "\t\n\x0b\x0c\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
_WS_RUN = re.compile("[" + JS_WS + "]+")
_TRIM = re.compile(r"\A[" + JS_WS + r"]+|[" + JS_WS + r"]+\Z")
_DEC = re.compile(r"[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?")


def collapse_ws(s):          # s.replace(/\s+/g, ' ')
    return _WS_RUN.sub(" ", s)


def trim(s):                 # s.trim()
    return _TRIM.sub("", s)


def to_number(v):            # Number(v)
    if isinstance(v, bool):
        return 1.0 if v else 0.0
    if isinstance(v, (int, float)):
        return float(v)
    if v is None:
        return 0.0
    if isinstance(v, str):
        s = trim(v)
        if s == "":
            return 0.0
        if s in ("Infinity", "+Infinity"):
            return math.inf
        if s == "-Infinity":
            return -math.inf
        if re.fullmatch(r"0[xX][0-9a-fA-F]+", s):
            return float(int(s, 16))
        if re.fullmatch(r"0[oO][0-7]+", s):
            return float(int(s[2:], 8))
        if re.fullmatch(r"0[bB][01]+", s):
            return float(int(s[2:], 2))
        if _DEC.fullmatch(s):
            return float(s)
        return math.nan
    return math.nan


def truthy(x):
    return not (isinstance(x, float) and math.isnan(x)) and x != 0


def num_or0(v):              # Number(v) || 0
    x = to_number(v)
    return x if truthy(x) else 0.0


def js_string(v):            # String(v)
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, float) and v.is_integer() and abs(v) < 1e21:
        return str(int(v))
    return str(v)


def utf16_len(s):
    return len(s.encode("utf-16-le", "surrogatepass")) // 2


def utf16_slice(s, n):       # s.slice(0, n) in UTF-16 code units
    return s.encode("utf-16-le", "surrogatepass")[: 2 * n].decode("utf-16-le", "surrogatepass")


def fmt_t(sec):              # Slant's fmtT
    x = num_or0(sec)
    if not math.isfinite(x):
        x = 0.0
    sec = max(0, math.floor(x))
    h, m, s = sec // 3600, (sec % 3600) // 60, str(sec % 60).zfill(2)
    return f"{h}:{str(m).zfill(2)}:{s}" if h else f"{m}:{s}"
