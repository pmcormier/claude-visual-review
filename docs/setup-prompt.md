# Setup prompt

Paste everything below the line into Claude Code (in a VS Code terminal). Your agent sets up
claude-visual-review with you, from nothing. Paste it again later to update.

---

Set up claude-visual-review for me: https://github.com/pmcormier/claude-visual-review. It makes you bring
decisions, sign-offs and reports to the Plannotator Inbox instead of the terminal. Read its `README.md` and
`docs/setup-guide.html` first; they are the source of truth, and this prompt only says how to walk me through
them. Ask before anything that changes my machine beyond what's listed here, and never edit
`~/.claude/rules/plannotator-inbox.md` (Plannotator owns it).

1. **Check the basics.** This needs Windows with PowerShell 7, VS Code, Claude Code, git and Python, plus
   `uv` for BMAD projects. Tell me what's missing and how to get it; stop if it isn't Windows.
2. **Ask me what I want**, in one go:
   - Which components: Review (always), Methods, Bmad, Fable, Rigor, Dashboard. Explain each in a line, from the README.
   - For Rigor and Dashboard: whether Node.js is installed (they run on `node`). Dashboard is opt-in: it wraps
     the status line (saved and restored on removal) and adds a Start menu shortcut, so say so when I choose it.
     Plans already in my repos fold as "Before the dashboard"; `/dashboard catch-up` in a project marks the
     finished ones, so mention it when I choose Dashboard.
   - Whether I have access to the Fable model (Fable is pointless without it).
   - Whether I want superpowers and/or BMAD. Methods is written for them; skip it if I want neither.
3. **Install superpowers and BMAD if I said yes**, from their official instructions: look them up now (the
   superpowers plugin in Claude Code's plugin marketplace; BMAD from its own repo or docs). Don't install
   from memory. BMAD is set up per project; ask which projects.
4. **Get the repo.** Ask where to keep it (suggest a folder next to my other projects). If it's already
   there, `git pull` instead.
5. **Run the installer** from the repo folder. Tell me first that `-InstallTools` runs Plannotator's official
   install script (`irm https://plannotator.ai/install.ps1 | iex`) if Plannotator is missing, and get my OK:
   `./install.ps1 -InstallTools -Components <my components>`, adding `-BmadProject <project>, ...` for BMAD
   projects. It ends with a **Summary**: exit code 0 means done; 3 means installed, but the Summary lists
   what's left. Relay the Summary to me, then:
   - For each `skip ... kept as yours` line, show me the difference it printed and ask whether to replace my
     file. Rerun with `-Replace <path>` for the ones I say yes to; the old file is kept as a timestamped
     `.bak-…` copy.
   - Any `MISS` line is something to fix; do what it says or tell me what I need to do.
6. **The steps only I can do.** Tell me, in order: close every VS Code window and reopen VS Code (a new
   terminal isn't enough), then start a new Claude Code session in its terminal; open the Inbox
   (`plannotator inbox --open`), turn on Board and Steps under Settings > Capabilities, and allow
   notifications. Then rerun `./install.ps1` (it reuses my components) to confirm Board and Steps are on.
7. **Check it works**, in the new session, using the setup guide's last two steps: a review tab opens in VS
   Code, and a sign-off goes to the Inbox and my answer comes back. When I first click a VS Code link in the
   Inbox, the browser asks once; I tick "Always allow".
8. **Tell me how to keep it current:** paste this prompt again, or `git pull` and rerun the installer. My own
   tweaks belong in a rule file of my own (for example `~/.claude/rules/my-review-tweaks.md`), which updates
   never touch.
