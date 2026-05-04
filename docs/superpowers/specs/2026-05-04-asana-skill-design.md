# Asana Skill — Design

Date: 2026-05-04

## Goal

Package the existing Asana skill as a standalone, optionally installable skill for ClaudeOS and the wider Claude Code community. Ship it as a GitHub repository (`claudeos-skills`) that users can clone and install manually.

## Repository structure

```
claudeos-skills/
└── asana/
    ├── SKILL.md              # user copies to .claude/skills/asana.md
    ├── SETUP.md              # one-time setup guide
    ├── scripts/
    │   └── asana.py          # Python CLI — installed to ~/.local/bin/asana
    └── references/
        ├── agent-guide.md    # agent decision guide, recipes, hard rules
        └── api.md            # command → REST endpoint mapping
```

## Installation flow (end user)

```bash
git clone https://github.com/<user>/claudeos-skills
cd claudeos-skills/asana
# follow SETUP.md:
install -m 755 scripts/asana.py ~/.local/bin/asana   # Unix install
pip install requests                                   # dependency
asana auth                                             # OAuth once
# then:
cp SKILL.md ~/.claude/skills/asana.md                 # or project .claude/skills/
```

## Script distribution

- `asana.py` has `#!/usr/bin/env python3` shebang — already present
- Installed via `install -m 755` to `~/.local/bin/asana` (user-local, no sudo)
- `~/.local/bin` is in PATH by default on modern Linux (Ubuntu/Debian XDG standard)
- Command name: `asana` (no `.py` extension)

## Changes to existing files

### SKILL.md
- Remove `SCRIPT="$(dirname "$0")/scripts/asana.py"` variable
- Replace all `python3 $SCRIPT <cmd>` with `asana <cmd>`
- Keep all rules, commands, references intact

### SETUP.md
- Add Step 2: `install -m 755 scripts/asana.py ~/.local/bin/asana`
- Reorder steps: install deps → install binary → export env vars → auth → verify
- Keep all troubleshooting and re-auth sections

## Local dev layout

```
/root/claudeos-skills/asana/   # git repo — source of truth
~/.local/bin/asana             # installed binary (dev + prod)
.claude/skills/asana.md        # skill loaded by Claude Code
```

## What is NOT in scope

- Plugin system (`/plugin install`) — out of scope for now, plain files only
- Other skills beyond Asana — future additions to the same repo
- Automated install script — manual copy per SETUP.md is sufficient
