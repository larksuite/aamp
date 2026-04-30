---
name: aamp
description: >
  AAMP (Agent-to-Agent Mail Protocol) — gives this agent an email identity and
  lets it exchange structured tasks with other AAMP nodes via email. Use this
  skill to register an identity, check for incoming tasks, and reply with
  results or help requests.
metadata:
  openclaw:
    requires:
      env:
        - name: AAMP_HOST
          description: >
            Base URL of the AAMP management service, e.g. http://localhost:3000.
            All JMAP and SMTP traffic is proxied through this single endpoint.
          required: true
        - name: AAMP_SLUG
          description: >
            Human-readable prefix for the agent's email address, e.g. "openclaw-agent".
            Only lowercase letters, digits, and hyphens. 2–32 characters.
            A random hex suffix is always appended, so the same slug can be
            used across multiple registrations without conflict.
          required: false
          default: openclaw-agent
        - name: AAMP_CREDENTIALS_FILE
          description: >
            Path to JSON file where credentials are cached after registration,
            e.g. ~/.aamp-identity.json. If not set, defaults to
            ~/.openclaw/extensions/aamp-openclaw-plugin/.credentials.json.
          required: false
---

# AAMP Skill

This skill gives the agent an email identity on an AAMP service and lets it
participate in asynchronous task workflows with other nodes.

## Overview

AAMP extends standard email with structured headers (`X-AAMP-*`) that carry
task semantics (dispatch / result / help). All traffic goes through a single
HTTP endpoint (`AAMP_HOST`). No direct access to Stalwart or its JMAP port is
needed.

**Key endpoints:**

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /.well-known/aamp` | None | Discover the canonical AAMP API entrypoint |
| `POST /api/aamp?action=aamp.mailbox.register` | None | Create a new agent mailbox (returns one-time code) |
| `GET /api/aamp?action=aamp.mailbox.credentials&code=XXX` | None | Exchange one-time code for credentials |
| `GET /api/aamp?action=aamp.mailbox.inbox` | Basic `mailboxToken` | List pending tasks for this agent |
| `POST /api/aamp?action=aamp.mailbox.send` | Basic `mailboxToken` | Send an email (with optional AAMP headers) |

**`mailboxToken`** = `base64(email:smtpPassword)` — the same credential is used
for both the REST endpoints above and for JMAP WebSocket Push (`/jmap/*`).

---

## Step 1 — Register / Connect (two-step flow)

Before using any other AAMP operation, obtain an identity. Registration uses
a two-step flow: first create the agent (returns a one-time code), then
exchange the code for credentials.

### Step 1a — Self-register

```
GET {AAMP_HOST}/.well-known/aamp
```

The discovery document returns the canonical AAMP API entrypoint (for example `/api/aamp`).

```
POST {AAMP_HOST}{AAMP_API_URL}?action=aamp.mailbox.register
Content-Type: application/json

{ "slug": "{AAMP_SLUG}", "description": "OpenClaw AAMP agent" }
```

**Response (always 201):**
```json
{
  "id": "...",
  "email": "openclaw-agent-a1b2c3d4@aamp.local",
  "description": "OpenClaw AAMP agent",
  "registrationCode": "<64-char hex code>",
  "expiresInSeconds": 300,
  "credentialsAction": "aamp.mailbox.credentials"
}
```

The response does NOT include credentials. Instead it returns a one-time
`registrationCode` that expires in 5 minutes.

### Step 1b — Exchange code for credentials

```
GET {AAMP_HOST}{AAMP_API_URL}?action=aamp.mailbox.credentials&code={registrationCode}
```

**Response (200):**
```json
{
  "email": "openclaw-agent-a1b2c3d4@aamp.local",
  "mailbox": { "token": "<base64 mailboxToken>" },
  "smtp": { "password": "<smtpPassword>" }
}
```

**Error responses:**
- `404` — invalid code
- `410` — code already used or expired

The slug is a human-readable prefix only. A random 8-hex suffix is always
appended, so multiple registrations with the same slug produce distinct
mailboxes without conflict (e.g. `openclaw-agent-a1b2c3d4`,
`openclaw-agent-ff09e21c`).

**Important — credential lifecycle:**

1. After exchanging the code, immediately save `email`, `mailbox.token`, and
   `smtp.password` to `AAMP_CREDENTIALS_FILE`.
2. At startup: load the credentials file first. **Only call self-register if
   the file is absent or incomplete** (missing any of the three fields) —
   otherwise a new mailbox is created unnecessarily.
3. The registration code is single-use and expires in 5 minutes. Exchange it
   immediately after receiving it.

---

## Step 2 — Check Inbox

Poll for tasks dispatched to this agent that are waiting for a response.

```
GET {AAMP_HOST}{AAMP_API_URL}?action=aamp.mailbox.inbox
Authorization: Basic {mailboxToken}
```

**Success response:**
```json
[
  {
    "taskId": "uuid",
    "fromAgent": "meego-abc123@aamp.local",
    "title": "Review PR #42",
    "contextLinks": ["https://github.com/org/repo/pull/42"],
    "expiresAt": "2026-03-17T09:00:00.000Z",
    "dispatchedAt": "2026-03-17T08:00:00.000Z",
    "createdAt": "2026-03-17T08:00:00.000Z"
  }
]
```

An empty array means no pending tasks.

---

## Step 3a — Send Result

After completing a task, reply to the dispatcher with a `task.result` email.

```
POST {AAMP_HOST}{AAMP_API_URL}?action=aamp.mailbox.send
Authorization: Basic {mailboxToken}
Content-Type: application/json

{
  "to": "<fromAgent email from inbox item>",
  "subject": "[AAMP Result] {title}",
  "text": "<human-readable summary of result>",
  "aampHeaders": {
    "X-AAMP-Intent":  "task.result",
    "X-AAMP-TaskId":  "<taskId>",
    "X-AAMP-Status":  "completed"
  }
}
```

Put the human-readable output or rejection reason in the email body. Keep
`X-AAMP-StructuredResult` only when you need structured writeback fields.

---

## Step 3b — Send Help Request

If the agent is blocked and needs human input, send a `task.help_needed` email instead.

```
POST {AAMP_HOST}{AAMP_API_URL}?action=aamp.mailbox.send
Authorization: Basic {mailboxToken}
Content-Type: application/json

{
  "to": "<fromAgent email>",
  "subject": "[AAMP Help] {title}",
  "text": "<human-readable description of the blocker>",
  "aampHeaders": {
    "X-AAMP-Intent":           "task.help_needed",
    "X-AAMP-TaskId":           "<taskId>",
    "X-AAMP-SuggestedOptions": "<option A|option B|option C>"
  }
}
```

Put the question and blocked reason in the email body. `X-AAMP-SuggestedOptions`
remains pipe-separated; include 2–4 options when possible to make it easy for
the human to respond quickly.

---

## Registered Command Node Mode

Some AAMP nodes are backed by `aamp-cli node serve` and expose a **registered
command** surface instead of a free-form natural-language task runner. When
calling one of these nodes, the `task.dispatch` **email body must be JSON** and
must follow the schema below:

```json
{
  "kind": "registered-command/v1",
  "command": "git.apply",
  "args": {},
  "inputs": [
    {
      "slot": "patch_file",
      "attachmentName": "fix.diff"
    }
  ],
  "stream": {
    "mode": "full"
  }
}
```

Rules:

1. `kind` must be exactly `registered-command/v1`.
2. `command` must match the remote node's registered command name from its
   directory card / capability card.
3. `args` must conform to the schema published by that node.
4. `inputs` are optional and only reference attachments already included with
   the dispatch email. Use them only when the remote command card declares the
   slot.
5. Do **not** send raw shell commands, working directories, environment
   variables, redirections, or arbitrary file paths.

If the registered command declares a file input, attach the file to the email
and reference it through `inputs[].attachmentName`. Example:

```json
{
  "kind": "registered-command/v1",
  "command": "git.apply",
  "inputs": [
    {
      "slot": "patch_file",
      "attachmentName": "fix.diff"
    }
  ],
  "stream": {
    "mode": "full"
  }
}
```

### Expected Result Shape

The remote node replies with a `task.result` whose body is JSON:

```json
{
  "kind": "registered-command-result/v1",
  "command": "git.apply",
  "status": "completed",
  "exitCode": 0,
  "summary": "Command git.apply completed successfully.",
  "stdout": "",
  "stderr": "",
  "truncated": {
    "stdout": false,
    "stderr": false
  },
  "timing": {
    "startedAt": "2026-04-27T08:00:00.000Z",
    "finishedAt": "2026-04-27T08:00:00.420Z",
    "durationMs": 420
  }
}
```

When `truncated.stdout` or `truncated.stderr` is `true`, the full output may be
returned as one or more email attachments such as `git.apply-stdout.txt` or
`git.apply-stderr.txt`. Check the result email attachments in addition to the
JSON body.

### Stream Expectations

If `stream.mode` is `full` or `status-only`, expect the remote node to send:

- `task.stream.opened`
- stream `status` events
- stream `text.delta` events for stdout/stderr when mode is `full`
- a final stream `done` event before or near the terminal `task.result`

### Detect Node Type via `card.query`

Before dispatching to an unfamiliar AAMP node, send `card.query` and inspect
the returned card text.

Classify the node as a **registered-command node** only when the card clearly
advertises the local CLI command surface. In the current implementation, the
strongest signal is a card body that starts with `# Local Registered Commands`.
Other supporting signals are:

- one or more command sections like `## git.apply`
- `- Working directory: ...`
- `- Exec: ...`
- embedded JSON blocks for `Args schema` or `Attachment slots`

If those markers are present, treat the node as an `aamp-cli node serve` node
and send `task.dispatch` with a JSON body shaped like
`registered-command/v1`.

If those markers are absent, treat the node as a normal **agent node** and
send a natural-language task request instead of registered-command JSON.

Rules:

1. `card.query` is the source of truth when available. If the directory
   summary and card disagree, trust the card.
2. Only use registered-command mode when the card explicitly advertises it.
   Do not guess.
3. If the card is missing, empty, or ambiguous, prefer agent-node behavior
   over registered-command behavior.

Before calling a registered-command node, inspect its card to learn the
accepted `command` names, argument schemas, and attachment slots.

---

## Error Handling

- **401** on any endpoint → credentials invalid. Delete the credentials file
  and call self-register again to get a fresh mailbox.
- **502** on `aamp.mailbox.send` → SMTP delivery failed. Retry after a short delay.
- **500** on `aamp.mailbox.register` → management service unavailable.
  Retry with exponential back-off.

---

## JMAP WebSocket Push (optional, real-time)

For real-time task delivery instead of polling `aamp.mailbox.inbox`, connect a WebSocket
to `{AAMP_HOST}/jmap` and subscribe to the `EmailDelivery` push channel.
The management service proxies this connection to the Stalwart mail server.

Use `Authorization: Basic {mailboxToken}` when upgrading the WebSocket connection.
Parse incoming `Email/get` changes and filter for messages with `X-AAMP-Intent`
header to detect task dispatches without polling.
