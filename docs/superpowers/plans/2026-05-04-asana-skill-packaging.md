# Asana Skill Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package the existing Asana skill into a standalone GitHub-ready repo (`claudeos-skills`) with proper Unix installation (binary in PATH via `install -m 755`).

**Architecture:** New git repo at `/root/claudeos-skills/` containing the `asana/` skill. SKILL.md and agent-guide.md are updated to call `asana` directly (no path variables). SETUP.md gains an install step. Source files are copied from `tmp/asana/`.

**Tech Stack:** Python 3.9+, Bash, Git

---

### Task 1: Create repo structure

**Files:**
- Create: `/root/claudeos-skills/asana/scripts/asana.py`
- Create: `/root/claudeos-skills/asana/references/agent-guide.md`
- Create: `/root/claudeos-skills/asana/references/api.md`

- [ ] **Step 1: Init git repo and directories**

```bash
mkdir -p /root/claudeos-skills/asana/scripts
mkdir -p /root/claudeos-skills/asana/references
cd /root/claudeos-skills
git init
```

Expected: `Initialized empty Git repository in /root/claudeos-skills/.git/`

- [ ] **Step 2: Copy Python script and reference files**

```bash
cp /root/claudeos-dev/tmp/asana/scripts/asana.py /root/claudeos-skills/asana/scripts/asana.py
cp /root/claudeos-dev/tmp/asana/references/agent-guide.md /root/claudeos-skills/asana/references/agent-guide.md
cp /root/claudeos-dev/tmp/asana/references/api.md /root/claudeos-skills/asana/references/api.md
```

- [ ] **Step 3: Verify files copied correctly**

```bash
ls -la /root/claudeos-skills/asana/scripts/asana.py
head -3 /root/claudeos-skills/asana/scripts/asana.py
```

Expected: file exists, first line is `#!/usr/bin/env python3`

---

### Task 2: Write SKILL.md

**Files:**
- Create: `/root/claudeos-skills/asana/SKILL.md`

Source: `/root/claudeos-dev/tmp/asana/SKILL.md` — modified to remove `SCRIPT=...` and replace `python3 $SCRIPT` with `asana`.

- [ ] **Step 1: Create SKILL.md with updated Quick Start**

The original Quick Start block used `SCRIPT="$(dirname "$0")/scripts/asana.py"` and `python3 $SCRIPT <cmd>`. Replace the entire Quick Start section:

```markdown
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
```

- [ ] **Step 2: Write full SKILL.md**

Write `/root/claudeos-skills/asana/SKILL.md` — take the original file verbatim and apply two changes:
1. Remove the `SCRIPT=...` line from Quick Start (line 16 of original)
2. Replace every `python3 $SCRIPT` with `asana`

```bash
sed 's|python3 \$SCRIPT|asana|g' /root/claudeos-dev/tmp/asana/SKILL.md | \
  grep -v 'SCRIPT="$(dirname' > /root/claudeos-skills/asana/SKILL.md
```

- [ ] **Step 3: Verify the replacements**

```bash
grep -n 'SCRIPT\|python3' /root/claudeos-skills/asana/SKILL.md
```

Expected: zero matches. Any hit means a replacement was missed.

- [ ] **Step 4: Spot-check Quick Start block looks right**

```bash
sed -n '12,40p' /root/claudeos-skills/asana/SKILL.md
```

Expected: Quick Start shows `asana auth`, `asana tasks ...`, no `$SCRIPT` or `python3` references.

---

### Task 3: Write SETUP.md

**Files:**
- Create: `/root/claudeos-skills/asana/SETUP.md`

Source: `/root/claudeos-dev/tmp/asana/SETUP.md` — add Step 2 (install binary to PATH), renumber following steps.

- [ ] **Step 1: Copy original SETUP.md as base**

```bash
cp /root/claudeos-dev/tmp/asana/SETUP.md /root/claudeos-skills/asana/SETUP.md
```

Then open `/root/claudeos-skills/asana/SETUP.md` and manually insert the new Step 2 block (below) after line `## 1. Register an Asana OAuth app` section ends, and renumber old Step 2 (pip install) → Step 3, old Step 3 (env vars) → Step 4, old Step 4 (auth) → Step 5, old Step 5 (verify) → Step 6.

New Step 2 content to insert between "Register app" and "Install dependencies":

```markdown
## 2. Install the CLI

From the repo root:

```bash
install -m 755 asana/scripts/asana.py ~/.local/bin/asana
```

This copies the script to `~/.local/bin/asana` and makes it executable. `~/.local/bin` is in PATH by default on Ubuntu/Debian. Verify with:

```bash
which asana   # should print ~/.local/bin/asana
asana --help  # should print usage
```

> **Not in PATH?** Add `export PATH="$HOME/.local/bin:$PATH"` to your `~/.bashrc` or `~/.zshrc`.
```

- [ ] **Step 2: Verify step numbering is correct**

```bash
grep '^## [0-9]' /root/claudeos-skills/asana/SETUP.md
```

Expected output:
```
## 1. Register an Asana OAuth app
## 2. Install the CLI
## 3. Install dependencies
## 4. Export env vars
## 5. Authenticate
## 6. Verify
```

---

### Task 4: Update agent-guide.md

**Files:**
- Modify: `/root/claudeos-skills/asana/references/agent-guide.md`

The agent-guide uses `SCRIPT=/abs/path/to/scripts/asana.py` and `python3 $SCRIPT` in examples. Update to use `asana` directly.

- [ ] **Step 1: Replace script references in agent-guide.md**

```bash
sed -i \
  -e 's|python3 \$SCRIPT|asana|g' \
  -e 's|> All examples below assume.*||' \
  -e '/^SCRIPT=/d' \
  /root/claudeos-skills/asana/references/agent-guide.md
```

- [ ] **Step 2: Verify no references remain**

```bash
grep -n 'SCRIPT\|python3' /root/claudeos-skills/asana/references/agent-guide.md
```

Expected: zero matches.

- [ ] **Step 3: Spot-check recipes section still reads correctly**

```bash
grep -A3 '### 3.1' /root/claudeos-skills/asana/references/agent-guide.md
```

Expected: recipe uses `asana find-user 'Alice'`, `asana create ...`

---

### Task 5: Create README.md

**Files:**
- Create: `/root/claudeos-skills/README.md`
- Create: `/root/claudeos-skills/asana/README.md` (short redirect)

- [ ] **Step 1: Write repo-level README.md**

```markdown
# claudeos-skills

Optional skills for [ClaudeOS](https://github.com/ruslanshakirzhanovich/claudeos) and any Claude Code setup.

Skills here are NOT bundled with ClaudeOS by default. Install only what you need.

## Available skills

| Skill | Description | Requires |
|-------|-------------|---------|
| [asana](asana/) | Manage Asana tasks, projects, sections, subtasks, comments, tags and more | Python 3.9+, Asana OAuth app |

## How skills work

Each skill is a `.md` file you place in `.claude/skills/` inside your project (or globally in `~/.claude/skills/`). Claude Code picks it up automatically on the next session.

## Installation

Each skill has its own `SETUP.md`. Start there.
```

- [ ] **Step 2: Write asana/README.md**

```markdown
# Asana Skill

Manage any Asana workspace from Claude Code (or ClaudeOS) via a Python CLI.

50+ commands: tasks, subtasks, sections, assignees, comments, tags, followers, dependencies, attachments, portfolios, goals, webhooks.

## Setup

Read [SETUP.md](SETUP.md) — takes ~5 minutes. You'll need an Asana OAuth app and Python 3.9+.

## Usage

After setup, Claude responds to natural language: "create a task for Alice in project X", "move task to Done", "delete all test tasks".

See [SKILL.md](SKILL.md) for the full command reference, or [references/agent-guide.md](references/agent-guide.md) for the agent decision guide.
```

- [ ] **Step 3: Verify README files exist**

```bash
ls /root/claudeos-skills/README.md /root/claudeos-skills/asana/README.md
```

---

### Task 6: Local install and smoke test

- [ ] **Step 1: Install the binary locally**

```bash
install -m 755 /root/claudeos-skills/asana/scripts/asana.py ~/.local/bin/asana
```

- [ ] **Step 2: Verify binary is in PATH and executable**

```bash
which asana
asana status
```

Expected: `which asana` prints `~/.local/bin/asana`. `asana status` prints env var check (will show missing `ASANA_CLIENT_ID` if not set — that's fine, it means the binary works).

- [ ] **Step 3: Install skill in dev project**

```bash
cp /root/claudeos-skills/asana/SKILL.md /root/claudeos-dev/.claude/skills/asana.md
```

- [ ] **Step 4: Verify skill file has no SCRIPT references**

```bash
grep 'SCRIPT\|python3' /root/claudeos-dev/.claude/skills/asana.md
```

Expected: zero matches.

---

### Task 7: Initial git commit and .gitignore

**Files:**
- Create: `/root/claudeos-skills/.gitignore`

- [ ] **Step 1: Create .gitignore**

```bash
cat > /root/claudeos-skills/.gitignore << 'EOF'
__pycache__/
*.pyc
*.pyo
.env
.DS_Store
EOF
```

- [ ] **Step 2: Stage and commit everything**

```bash
cd /root/claudeos-skills
git add .
git status
```

Expected: all files staged, nothing unexpected (no `.env`, no `__pycache__`).

- [ ] **Step 3: Initial commit**

```bash
cd /root/claudeos-skills
git commit -m "feat(asana): initial skill — 50+ commands, OAuth, Unix install"
```

- [ ] **Step 4: Verify clean tree**

```bash
cd /root/claudeos-skills && git status
```

Expected: `nothing to commit, working tree clean`

---

### Task 8: Create GitHub repo and push

- [ ] **Step 1: Create GitHub repo via gh CLI**

```bash
cd /root/claudeos-skills
gh repo create claudeos-skills \
  --public \
  --description "Optional skills for ClaudeOS and Claude Code" \
  --source . \
  --remote origin \
  --push
```

Expected: repo created, branch pushed, URL printed.

- [ ] **Step 2: Verify repo is live**

```bash
gh repo view claudeos-skills --web
```

Or check: `https://github.com/<твой-аккаунт>/claudeos-skills`

- [ ] **Step 3: Commit updated SKILL.md in claudeos-dev (skill installed there)**

```bash
cd /root/claudeos-dev
git add .claude/skills/asana.md
git commit -m "feat(skills): add Asana skill"
```
