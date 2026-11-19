---
description: Open the live dashboard of Claude Code work on this computer
---

Open the dashboard:

1. Run `node ~/.claude/dashboard/launcher.mjs --open`. It starts the dashboard server if it isn't running and
   opens the page; it prints nothing and always succeeds.
2. Read the port from `~/.claude/dashboard/config.json` (its `port` field). If the file or the field is
   missing, the port is 47800.
3. Reply with one line: the URL `http://127.0.0.1:<port>/`, saying the page was opened there.
