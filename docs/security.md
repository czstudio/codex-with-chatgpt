# Security Model

## Trust boundaries

1. **Workspace root** is the smallest authorization boundary. One bridge serves
   exactly one workspace; every token is bound to `workspace_id`; a token for
   project A returns 403 on project B's bridge.
2. **Workspace content is untrusted.** README, comments, diffs may contain
   prompt injection. Every MCP tool description carries an explicit warning and
   tools never grant capabilities based on file content.
3. **The model never sees long-lived credentials.** Computer Use only ever
   handles the one-time pairing code. Access/refresh tokens travel only inside
   the OAuth redirect/token endpoints between ChatGPT's client and the bridge.

## Threat model → mitigations

| Threat | Mitigation |
| --- | --- |
| MCP URL leaks | URL alone is useless: every `/mcp` request requires a valid bearer token (401 without, 403 wrong workspace) |
| Pairing code brute force | 8 chars from a 31-char CSPRNG alphabet (~40 bits), 5 attempts per session, per-IP rate limit (10/min), 5-minute TTL, one-time use, session destroyed on limit |
| OAuth CSRF | `state` round-tripped verbatim; authorization requests are server-side records keyed by random ids |
| Code interception | PKCE S256 mandatory (plain rejected); authorization codes are one-time, 5-minute TTL, bound to client + redirect URI |
| Token theft | Opaque high-entropy tokens; stored only as SHA-256 hashes; access tokens live 1 h; refresh tokens rotate on every use (replay of the old one fails); revocation endpoint + `c2c unpair` |
| Workspace traversal | `realpath` canonicalization of the deepest existing ancestor; containment check against the canonical root; case-insensitive comparison on macOS/Windows; rejects `..`, absolute escapes, backslash tricks, null bytes |
| Symlink escape | Canonicalization resolves symlinks before the containment check (file and directory symlinks both covered by tests) |
| Sensitive files | Deny-by-default patterns (.env*, keys, SSH, cloud creds, keychains…) enforced at resolve time — reads, listings, and search all pass through the same gate; `git diff` adds pathspec excludes; `.env.example` allowed |
| Oversized file / diff DoS | read_file caps lines and bytes per response; git_diff paginates by byte offset with hard caps; search caps matches and file sizes |
| Tunnel exposure | Bridge binds 127.0.0.1 only (refuses 0.0.0.0); the only public surface is HTTPS via the tunnel, protected by OAuth; `/health` reveals only a salted workspace hash |
| Admin API abuse | Loopback-only + random admin token (0600 runtime file) + requests with proxy headers (`cf-connecting-ip`, `x-forwarded-for`) rejected; unauthenticated probes get 404 |
| Log credential leakage | Logger redacts token prefixes, bearer headers, token-like parameters, and pairing-code-shaped strings before writing |
| Prompt injection via repo | Tool descriptions state content is untrusted data; the bridge grants no additional authority regardless of content; ChatGPT has zero write/exec capability |
| Unintended task dispatch | Arming is local CLI-only and explicit; the durable envelope accepts only `codex_turn`, attempt `1`, a workspace fence and an idempotency key; MCP exposes observation only |
| Replay or stale recovery | Per-task atomic envelopes and exclusive locks allow one claim; dispatch/result receipts share task, workspace, arm, attempt and idempotency fences; restart discovery never auto-runs pending work |
| Receipt or prompt leakage | Receipts contain bounded status/test metadata and changed-file counts only; URLs, file paths, prompts, browser state, credentials and raw invoker errors are rejected or omitted |

## Token & scope design

Scopes: `workspace.read`, `workspace.search`, `git.read`, `execution.read`,
`offline_access`. Tools enforce scopes individually (`INSUFFICIENT_SCOPE`).
Access tokens: 1 hour. Refresh tokens: 30 days, rotated. All tokens bound to
`workspace_id` and `client_id`.

## Storage

State lives under the OS-convention app dir
(`~/Library/Application Support/codex-with-chatgpt` on macOS), directories 0700,
files 0600. Named-hostname preference and tunnel metadata live there too
(`tunnels/<workspaceId>.json`) — never in the project. Only SHA-256 hashes of
tokens are persisted — a stolen state file does not yield usable bearer tokens.

**V1 limitation**: client registrations and token hashes are file-based rather
than OS-keychain-based. Raw tokens are never written anywhere. Keychain
integration is a V2 item.

## What ChatGPT can never do (V1)

Write files, delete files, run shell commands, commit, install packages —
these tools do not exist on the server, so no prompt injection, scope bug, or
UI confusion can enable them.

## Local task inbox boundary

The task inbox is a local recovery primitive, not a second business state
machine. `c2c task arm` resolves a real workspace and persists an owner-only
envelope under the application state directory. The envelope contains only a
fixed operation (`codex_turn`) and bounded correlation metadata. It does not
contain a ChatGPT conversation URL, prompt, browser session, credential or
arbitrary command. A task may be armed once and claimed once for attempt `1`.

The dispatcher is not exposed as a generic MCP or shell interface. Its allowlist
has one operation, and its invoker receives metadata rather than user-supplied
code or a command string. Atomic writes, an exclusive per-task lock and
idempotent receipts prevent a concurrent or replayed claim from becoming a
second dispatch. If a process stops after claiming, startup can observe the
durable `DISPATCHING`/`RUNNING` envelope but must not infer that it is safe to
rerun. The existing receipt or an explicit, fenced recovery action is required.

MCP `task_status` and `task_result` are read-only, scope-protected views. They
validate workspace and receipt fences and return only bounded metadata. They do
not expose an arming, dispatch, cancellation, file-write, shell or session
operation, and they never read or modify Codex sessions or credentials.
