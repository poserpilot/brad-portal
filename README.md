# Brad's Working Portal

A persistent, cross-project command center for Brad's Claude work: one canonical to-do list, schedule/deadline awareness, a daily brief, and a running "recently shipped" log — reachable from **any** Claude session, project, or a browser.

This is the **standalone portal repo** (`poserpilot/brad-portal`). It is intentionally separate from `brad-claude-context` so portal changes can never affect Brad's canonical working-context repo. The context repo keeps only a one-line pointer to this one.

## Design (matches Brad's reliability doctrine)

- **Canonical + versioned store:** `data/tasks.json` in this repo. Full git history, archive-over-delete, audited by commit. If anything disagrees with this file, the repo wins.
- **Live access layer:** a Cloudflare Worker (`app/worker.js`) backed by KV serves the tasks over HTTPS and hosts the web UI. **The Worker writes through to git** — every change updates KV *and* commits `data/tasks.json` back to this repo — so the repo stays continuously canonical and versioned. (Same live-store + git-spine pattern as the monarch tribal-knowledge exporter, PR #29.)
- **Why both:** the repo gives durability + history; the Worker gives frictionless reach from every session/browser without pasting a token each time.

## Files

| Path | Role |
|------|------|
| `data/tasks.json` | **Canonical** task store (open + done). |
| `todo.md` | Human-readable rendered view (regenerate from JSON). |
| `data/activity-log.md` | Append-only "recently shipped" log; feeds the brief. |
| `app/worker.js` | Cloudflare Worker — KV API + web UI + git write-through. |
| `app/wrangler.toml` | Worker deploy config. |
| `app/DEPLOY.md` | Exact copy-paste deploy steps. |

## Task schema

```jsonc
{
  "id": "T-0001",              // stable id, never reused
  "title": "…",
  "status": "open|in_progress|blocked|done|archived",
  "priority": "high|med|low",
  "project": "monarch|halo-reg|portal|personal|…",
  "due": "2026-08-03" | null,  // ISO date
  "created": "2026-07-16",
  "completed": null,           // set when status→done
  "source": "brad|context-repo §6|…",
  "notes": "…"
}
```

## API (once the Worker is deployed)

Base URL: `https://<your-worker>.workers.dev`

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/api/tasks` | none | Full state (open + done). |
| `POST` | `/api/tasks` | Bearer WRITE_KEY | Add a task. Body: `{title, due?, priority?, project?, notes?, source?}` |
| `PATCH` | `/api/tasks/:id` | Bearer WRITE_KEY | Update fields (e.g. `{"status":"done"}` moves it to `done[]` with a date). |
| `GET` | `/` | none | Web portal UI. |

## How Claude sessions use it

- **Any session / project:** hit the Worker API — e.g. add a to-do with a single authenticated `POST /api/tasks`. The `brad-claude-context` README §0 pointer carries the endpoint so every project knows where the portal lives.
- **Direct edit fallback:** edit `data/tasks.json` in this repo (requires the portal PAT) and regenerate `todo.md`.
- **Standing rule (personal instance):** durable learnings are logged to `context/learned-log.md` in the context repo and rolled into that README at session end.
