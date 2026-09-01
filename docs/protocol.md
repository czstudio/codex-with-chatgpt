# C2C Agent Protocol

Control plane: Computer Use (tiny structured messages typed into the ChatGPT UI).
Data plane: MCP (ChatGPT pulls files, diffs, search results itself).

Never mix the two: control messages carry bounded protocol fields and an
explicitly approved task payload, never diffs, logs, secrets or arbitrary
commands.

## States

```
INIT → PLAN → EXECUTING → EXECUTED → REVIEW → PLAN | DONE | BLOCKED | ERROR
```

| State | Sender | Meaning |
| --- | --- | --- |
| INIT | Codex | New task; asks ChatGPT to inspect + plan |
| PLAN | ChatGPT | Executable plan for the next iteration |
| EXECUTING | Codex | (optional) execution in progress |
| EXECUTED | Codex | Iteration finished; metadata only |
| REVIEW | ChatGPT | (implicit) ChatGPT is inspecting via MCP |
| DONE | ChatGPT | Success criteria met |
| BLOCKED | ChatGPT | Cannot proceed; contains reason |
| ERROR | either | Protocol/infrastructure failure |
| HANDOFF | Codex | Continuation brief sent to a replacement conversation |

## Message format

Every control message starts with `[C2C]` and key-value headers, then sections.
Keep messages < 1 KB. No diffs, no logs, no file bodies.

### INIT (Codex → ChatGPT)

```
[C2C]
STATE: INIT
TASK_ID: c2c_f81a
ITERATION: 0

GOAL:
Implement dark mode.

INSTRUCTION:
Inspect the connected workspace through Codex with ChatGPT MCP.
Create an implementation plan for Codex.
```

### PLAN (ChatGPT → Codex)

```
[C2C]
STATE: PLAN
TASK_ID: c2c_f81a
ITERATION: 1

GOAL:
...

RATIONALE:
...

ACTIONS:
1. ...
2. ...
3. ...

FILES_LIKELY_INVOLVED:
...

TESTS:
...

SUCCESS_CRITERIA:
...
```

Plans must be finite, concrete, executable. Not 40-step epics.

### EXECUTED (Codex → ChatGPT)

```
[C2C]
STATE: EXECUTED
TASK_ID: c2c_f81a
ITERATION: 1

RESULT:
Execution finished.

CHANGED_FILES:
4

TESTS:
27 passed

Please independently inspect the workspace and current git diff through MCP.
```

Before sending EXECUTED, Codex records the iteration:
`c2c record --task c2c_f81a --iteration 1 --changed-files ... --tests ... --exit-status ok`
so ChatGPT can read it via the `execution_summary` / `test_status` tools.

Before compaction, handoff, or switching conversations, Codex appends a bounded
task checkpoint with `c2c checkpoint`. It contains only the protocol cursor,
short summary, known issues, and next expected step. `execution_summary` can
filter these records by `task_id`, so a resumed reviewer does not mix tasks.
This append-only audit trail is a recovery hint, not a business state machine.

## Local task inbox and recovery

The local CLI is the only arming surface. Arming writes a durable, owner-only
envelope and does not dispatch work:

```
c2c task arm c2c_f81a --workspace /path/to/workspace --operation codex_turn \
  --attempt 1 --arm-id arm_001 --idempotency-key idem_001 \
  --task-summary "Repair the local task handoff" \
  --instruction "Forward the approved instruction to the local Codex invoker." \
  --json
```

The envelope is bound to the resolved workspace identity and to attempt `1`.
Only the fixed `codex_turn` operation is accepted. Arming requires a bounded
`TASK_SUMMARY` (at most 256 UTF-8 bytes) and `INSTRUCTION` (at most 1,024 UTF-8
bytes). Both reject surrounding whitespace, control characters, URLs,
credential-like material, shell control operators and a denylist of dangerous
commands; the envelope always stores their SHA-256 binding. The optional
`--approval-summary-hash` must match that binding when supplied. A repeated arm
with the same task, arm, idempotency key and approved fields is idempotent while
still `ARMED`; a conflicting arm or an arm after a transition is rejected.
Other CLI operations are limited to local status and cancellation of an
as-yet-unclaimed task. There is no CLI dispatch command.

The recoverable dispatcher is an internal seam. It claims an `ARMED` envelope
once, writes a bounded dispatch receipt, and invokes only the approved
`codex_turn` operation. It passes task/workspace/arm/attempt/idempotency metadata,
plus the exact locally armed summary, instruction and SHA-256 binding. It never
accepts arbitrary shell text, URLs, browser state or credentials, and the
instruction is not a free-form command or model override. A result receipt is
written before the envelope becomes terminal and is bound to the same task, arm,
attempt, idempotency key and dispatch id. Duplicate claims, stale attempts,
workspace mismatches, replayed keys and approval mismatches fail closed.

After a process restart, recovery reads durable envelopes and reports
`ARMED`/in-flight tasks for explicit reconciliation; it does not automatically
invoke or blindly rerun them. An in-flight task remains fenced until an
operator or trusted local Controller makes a deliberate decision. `task_status`
and `task_result` are read-only MCP observations of this local state and its
bounded receipt; they cannot arm, dispatch, cancel, write files or run commands.

## Local browser handoff (optional)

The browser path is a separate, local-only handoff for an already armed task. It
does not arm a task and it does not turn ChatGPT into an executor. Start the
bridge in the foreground (or through one of the supplied per-user startup
scripts):

```
c2c extension start --workspace /path/to/workspace
```

The bridge always binds to loopback port `62141`; a collision fails closed and
never selects another port. The minimal Chromium extension has no port or nonce
input. It only scans `pre code` elements on `chatgpt.com` and
`chat.openai.com` for this exact shape; no free-form prompt, URL, command,
conversation id, cookie or token field is accepted:

````
```c2c-task
[C2C_TASK]
VERSION: 1
TASK_ID: c2c_f81a
WORKSPACE_ID: 0123456789ab
OPERATION: codex_turn
ATTEMPT: 1
ARM_ID: arm_001
IDEMPOTENCY_KEY: idem_001
TASK_SUMMARY: Repair the local task handoff
INSTRUCTION: Forward the approved instruction to the local Codex invoker.
APPROVAL_SUMMARY_HASH: be9086bb9f7ee43ac244a87053346f45f68fdf1329ca4fd9fa59aaeb65d24364
[/C2C_TASK]
```
````

The user must click the injected button. On that click, the extension verifies a
trusted user activation and sends one origin-bound pairing request to
`http://127.0.0.1:62141/v1/task/pair`, then immediately sends one dispatch POST
with the returned one-time nonce and block. Pairing requires the extension
origin, a matching extension-id header and the activation marker; a second
pairing is rejected. The bridge then checks loopback origin, workspace, arm,
operation, attempt and approval summary/hash fences, and invokes the same fixed
`codex exec --ephemeral --json --sandbox workspace-write --cd <workspace> -`
command. The invoker receives the durable locally armed summary and instruction
(plus a fixed safety suffix), never an unapproved or browser-supplied free-form
prompt. It never uses `resume`, reads or writes Codex session data, enables an
approval bypass, or accepts arbitrary shell input. The nonce is memory-only and
is consumed before task validation; malformed authenticated input therefore
also cannot be retried. The extension keeps no nonce or port state and never
automatically retries an ambiguous network result.

Only a bounded structured result (status, receipt ids, test summary and changed
file count) is returned to the page. Raw CLI output, prompts, paths, credentials
and session data stay local. Restarting the bridge exposes no recovery action to
the browser: durable pending tasks remain for explicit local reconciliation and
are never blindly rerun.

### DONE / BLOCKED (ChatGPT → Codex)

```
[C2C]
STATE: DONE
TASK_ID: c2c_f81a
ITERATION: 3

SUMMARY:
...
```

```
[C2C]
STATE: BLOCKED
TASK_ID: c2c_f81a
ITERATION: 3

REASON:
...

NEEDS:
...
```

After ChatGPT returns DONE, Codex records the DONE checkpoint and runs
`c2c gate --task ... --iteration ... --json`. The gate requires a successful
execution record, a non-empty test summary, and the matching DONE checkpoint.
Records carry an explicit local-audit-only authority marker and schema version.
Malformed, unknown-schema, conflicting, oversized, or credential-like records
make integrity false and keep the gate BLOCKED; valid lines may still be shown
for recovery, but corruption is never silently promoted to completion.
It is a mandatory fail-closed C2C protocol guard: missing evidence returns a
non-zero exit and Codex must report BLOCKED. It still cannot change Controller
state or substitute for deployment, billing, provider, or production acceptance
gates; it controls only whether C2C may claim DONE.

### HANDOFF (Codex → new ChatGPT conversation)

One workspace keeps one long-lived C2C conversation (`c2c session get/set`).
Codex switches to a new chat only when the user asks for it or the old chat has
grown long enough to lag. Right after the boot prompt, Codex sends a HANDOFF so
the new chat can continue seamlessly — a brief, never a data dump (the new chat
re-reads code via MCP):

```
[C2C]
STATE: HANDOFF
TASK_ID: c2c_f81a
ITERATION: 4

ORIGINAL_GOAL:
Implement dark mode with a persisted user preference.

PROGRESS:
- Iter 1-2: theme context + toggle implemented, reviewed OK.
- Iter 3: persistence added; review found the toggle flashes on load.

CURRENT_STATE:
EXECUTED (iteration 4 fix applied, not yet reviewed).

KNOWN_ISSUES:
Flash-on-load fix needs verification in src/theme/ThemeProvider.tsx.

NEXT_EXPECTED_STEP:
Independently review iteration 4 via git_diff and reply PLAN or DONE.
```

## Loop limits

`maxIterations` (default 12, configurable in `.c2c.json`). When reached, Codex
pauses and asks the user whether to continue.

## Boot Prompt

Send once at the start of every new C2C conversation:

```
You are the planning and review layer of a Codex coding session.

Codex owns execution.
You own high-level reasoning, planning and review.

You have access to the current local workspace through the
"Codex with ChatGPT" MCP connector.

Rules:

1. Do not ask Codex to paste files that are available through MCP.
2. Inspect only the files needed for the task.
3. Use MCP to inspect current code, git status and diff.
4. Produce concise executable plans.
5. Codex will execute your plan using its own harness.
6. After Codex reports EXECUTED, independently inspect the diff.
7. Do not assume an implementation succeeded just because Codex says so.
8. Continue until the implementation satisfies the success criteria.
9. Avoid unnecessary rewrites.
10. Return C2C structured control messages.
11. Be substantive. PLAN and review replies must carry enough signal for
    Codex to act on: rationale, per-file natural-language suggestions
    (which file, what to change and why), risks worth checking, and test
    advice. Never reply with a bare one-liner. Substance over length —
    but do not generate 40-step epics either.
12. If you receive a HANDOFF message, this conversation continues an
    existing task. Trust the handoff brief for history, re-read any code
    you need through MCP, and resume from NEXT_EXPECTED_STEP.
```
