---
name: asana
description: "Manage Asana projects, tasks, sections, assignees, comments, custom fields, tags, followers, dependencies, attachments, portfolios, goals and webhooks via a single Python CLI. Use when any agent needs to: create/update/complete/delete/search tasks; list or filter by assignee, tag, due date; manage subtasks; assign people; move between sections; set custom fields; add/remove followers; link dependencies; add comments; tag tasks; attach URLs; list workspace users/teams/portfolios/goals; manage webhooks; bulk-delete. Triggers on: создать задачу, удалить задачи, назначить на, переместить в, закрыть задачу, подзадача, подписать, зависимость, тег, вложение, портфолио, цель, создать секцию, create task, delete all tasks, assign, move to section, follow, dependency, tag, attachment, portfolio, goal, webhook."
---

# Asana Skill (standalone)

Manage any Asana workspace via a single Python CLI (`asana.py`, 50+ commands).
One bash command = one complete action; agent reads plain-text output and reports to user — no multi-turn chains.

**First time?** Read `SETUP.md` first — you need to register an Asana app and run `asana.py auth` once.

## Quick Start

```bash
# One-time login (opens browser, runs local callback server)
asana auth

# Check auth status
asana status

# All projects
asana projects

# Tasks in a project
asana tasks 1214072670665925

# Create task
asana create 1214072670665925 'Finish visualizations by 2026-04-25' 'A3, 12 sheets'

# Delete ALL tasks in project (single batch command)
asana delete-all 1214072670665925

# Delete by regex pattern
asana delete-pattern 1214072670665925 '🧪'
```

## Architecture (one-line summary)

`asana.py <command> [args]` → reads OAuth token from `$ASANA_SKILL_HOME/tokens.json` (default `~/.config/asana-skill/`) → calls Asana REST API → prints plain text. Auto-refresh on 401, exponential backoff on 429, transparent pagination on list endpoints.

## Auth model

- **Token file:** `$ASANA_SKILL_HOME/tokens.json` (chmod 600). Path overridable via env.
- **OAuth client:** `ASANA_CLIENT_ID` + `ASANA_CLIENT_SECRET` env vars (NOT a `.env` file — set them in your shell or system).
- **Redirect:** defaults to `http://localhost:8765/callback`. Override with `ASANA_REDIRECT_URI` (must match what's registered in your Asana app).
- **Refresh:** automatic on every API call when access token has < 59s remaining.
- **Re-login:** `asana.py logout` then `asana.py auth`.

## All commands

```
auth | logout | status                               OAuth lifecycle
me | projects | all-projects | tasks <project_id>    Discovery

— Tasks —
create <project> 'title' [notes]
update <task> 'title' [notes]
complete <task>
delete <task>
delete-all <project>
delete-pattern <project> 'regex'
duplicate <task> [new_title]
set-parent <task> <parent>
task-projects <task>
task-add-project <task> <project>
task-remove-project <task> <project>

— Subtasks —
subtasks <task>
subtask-create <task> 'title'

— Search —
search <project> 'query'              substring (local filter)
ftsearch 'query' [project]            full-text (Asana premium)
find-user 'name'

— Assign / move / fields —
assign <task> <user_name>
move <task> <section_name>
setfield <task> <field_name> <value>

— Comments / stories —
comment <task> 'text'
stories <task>
story-edit <story> 'text'
story-delete <story>

— Followers / dependencies —
follow <task> <user> | unfollow <task> <user>
deps <task>
dep-add <task> <dep_task> | dep-remove <task> <dep_task>

— Tags —
tags
tag-create 'name'
tag-add <task> <tag_name> | tag-remove <task> <tag_name>
tag-tasks <tag_name>

— Sections —
sections <project>
section-create <project> 'name'
section-delete <section>

— Attachments —
attachments <task>
attach-url <task> <url> [name]
attach-delete <attachment_id>

— Users / teams —
users | user <name> | teams

— Project extras —
project-update <project> 'name'
project-counts <project>
project-members <project>

— Portfolios (premium) —
portfolios | portfolio-items <portfolio>
portfolio-add <portfolio> <project>
portfolio-remove <portfolio> <project>

— Goals (premium) —
goals
goal-create 'title' [workspace_gid]
goal-stories <goal>

— Webhooks —
webhooks | webhook-delete <webhook_id>
```

## Rules for the agent

1. **Never invent GIDs.** If you need a user gid → `find-user 'Name'` first. If you need a custom-field option gid → list the field options first.
2. **Enum custom field = option GID, not text.** `setfield <task> Priority 'High'` will fail; pass the GID.
3. **After create — use the returned GID** in subsequent commands. Don't guess.
4. **Before delete — confirm with the user** (`delete`, `delete-all`, `delete-pattern`, `section-delete`, `attach-delete`, `webhook-delete`).
5. **Dates are ISO `YYYY-MM-DD`.** Resolve "tomorrow"/"next Friday" yourself before passing.
6. **Premium features (`ftsearch`, `portfolios`, `goals`)** return 402 on free workspaces — fall back to non-premium alternatives (`search`).
7. **Output is plain text** — re-phrase it to the user, don't paste raw "Task 12345 updated".
8. **401 means token expired** beyond refresh — tell user to run `asana.py auth`.

**For full agent guidance** — Asana data model, decision guide ("user said X → run Y"), 10 worked recipes, hard rules, and error catalog — see [`references/agent-guide.md`](references/agent-guide.md).
**For low-level command → REST endpoint mapping**, see [`references/api.md`](references/api.md).

## Environment variables

| Var | Purpose | Default |
|-----|---------|---------|
| `ASANA_CLIENT_ID` | OAuth client id from Asana app | (required) |
| `ASANA_CLIENT_SECRET` | OAuth client secret | (required) |
| `ASANA_REDIRECT_URI` | OAuth callback URL | `http://localhost:8765/callback` |
| `ASANA_SKILL_HOME` | Where tokens.json lives | `$XDG_CONFIG_HOME/asana-skill` or `~/.config/asana-skill` |

## Dependencies

Python 3.9+ and `requests`. Install: `pip install requests` (or `pipx install requests` in a venv).
