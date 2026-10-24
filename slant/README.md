# Slant source export

Files:
- Slant.jsx: current live React interface, analysis prompt, JSON schema, quote matching, AI calls, and persistence.
- server.py: YouTube caption and metadata service.
- requirements.txt: transcript-service dependency.

Canonical live frontend: apps/slant/app/code in your Mana workspace.
Canonical backend: /workspace/yt-bias/server.py in your Mana sandbox.

This is a source export, not a standalone application. Slant.jsx runs inside Mana and uses injected React, FS, useTheme, useManaRouter, useIngressUrl, and relPathAddress. Running outside Mana requires replacing these integrations with your own React setup, database, authentication, and server-side provider calls.

The backend reads its listening port from /workspace/yt-bias/port and binds to localhost. Its supervised service and ingress route are named yt-bias. To run elsewhere, adapt the port-file path or port configuration.

Saved analyses and transcripts, credentials, and access tokens are intentionally not included.
