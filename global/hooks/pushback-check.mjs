// UserPromptSubmit hook (Rigor component): sends rigor/pushback.md with every message, so the pushback check
// sits next to each prompt instead of only at session start. Installed to ~/.claude/hooks/; reads the check
// from ~/.claude/rigor/, found relative to this file.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

try {
  const file = join(dirname(fileURLToPath(import.meta.url)), "..", "rigor", "pushback.md");
  const text = readFileSync(file, "utf8").trim();
  if (text) {
    process.stdout.write(JSON.stringify({
      suppressOutput: true,
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: text },
    }));
  }
} catch {
  // No check file, or unreadable: stay silent rather than failing every message.
}
process.exit(0);
