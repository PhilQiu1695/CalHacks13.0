"""Verify Mana (Firebase Auth) ID tokens: RS256 signature against Google's published keys, audience, issuer, expiry.

The console sends the signed-in person's ID token in X-Slant-Id-Token. This is what lets ordinary Mana accounts use personal
routes: identity comes from a token Google signed, never from a caller-supplied user id. Guest (anonymous) sessions are refused.
"""
import json
import re
import threading
import time
import urllib.request

import jwt
from cryptography.x509 import load_pem_x509_certificate

CERTS_URL = "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com"
UID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")      # safe as a Firebase path segment


class TokenError(Exception):
    """The token is missing, malformed, expired, forged or for another project."""


class VerifierUnavailable(Exception):
    """Google's keys couldn't be fetched; fail closed."""


class Identity:
    __slots__ = ("uid", "email", "provider", "anonymous")

    def __init__(self, uid, email, provider):
        self.uid, self.email, self.provider = uid, email, provider
        self.anonymous = provider == "anonymous"


class GoogleCerts:
    """kid -> public key, cached for the max-age Google sends (refetched on an unknown kid, at most once a minute)."""

    def __init__(self, url=CERTS_URL):
        self.url, self.keys, self.expires, self.fetched, self.lock = url, {}, 0, 0, threading.Lock()

    def _fetch(self):
        try:
            with urllib.request.urlopen(self.url, timeout=10) as r:
                data = json.loads(r.read())
                cc = r.headers.get("Cache-Control") or ""
        except Exception as e:
            raise VerifierUnavailable(type(e).__name__)
        m = re.search(r"max-age=(\d+)", cc)
        self.keys = {kid: load_pem_x509_certificate(pem.encode()).public_key() for kid, pem in data.items()}
        self.fetched = time.time()
        self.expires = self.fetched + (int(m.group(1)) if m else 3600)

    def __call__(self, kid):
        with self.lock:
            if time.time() >= self.expires or (kid not in self.keys and time.time() - self.fetched > 60):
                self._fetch()
            return self.keys.get(kid)


class FirebaseVerifier:
    def __init__(self, project_id, key_for=None, leeway=30):
        self.project_id, self.key_for, self.leeway = project_id, key_for or GoogleCerts(), leeway

    def verify(self, token):
        if not isinstance(token, str) or len(token) > 4096 or token.count(".") != 2:
            raise TokenError("malformed")
        try:
            header = jwt.get_unverified_header(token)
        except jwt.PyJWTError:
            raise TokenError("malformed")
        if header.get("alg") != "RS256" or not isinstance(header.get("kid"), str):
            raise TokenError("bad header")
        key = self.key_for(header["kid"])
        if key is None:
            raise TokenError("unknown key")
        try:
            claims = jwt.decode(token, key, algorithms=["RS256"], audience=self.project_id,
                                issuer="https://securetoken.google.com/" + self.project_id, leeway=self.leeway,
                                options={"require": ["exp", "iat", "sub", "aud", "iss"]})
        except jwt.PyJWTError as e:
            raise TokenError(type(e).__name__)
        uid = claims.get("sub")
        if not isinstance(uid, str) or not UID_RE.match(uid):
            raise TokenError("bad subject")
        if isinstance(claims.get("auth_time"), (int, float)) and claims["auth_time"] > time.time() + self.leeway:
            raise TokenError("auth_time in the future")
        fb = claims.get("firebase") if isinstance(claims.get("firebase"), dict) else {}
        provider = fb.get("sign_in_provider") if isinstance(fb.get("sign_in_provider"), str) else "unknown"
        email = claims.get("email") if isinstance(claims.get("email"), str) and claims.get("email_verified") else None
        return Identity(uid, email, provider)
