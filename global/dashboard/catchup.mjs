// /dashboard catch-up helper (decision 32): prints, as JSON, the project's superpowers plans that were added before
// the Dashboard's install date and carry no `Status:` line, oldest first. Claude asks the person which are still
// open and writes `Status: done` or `Status: dropped` into the rest. With no install date, every plan without a
// `Status:` line is listed. Reads only; always exits 0; an error prints {error}.
// Usage: node catchup.mjs [<folder in the project>]   (default: the current folder)
// Child processes (R9): git runs from lib/git.mjs with its own folder as cwd, never the project's.
import { readPlans } from './lib/sources/plans.mjs';
import { readCommits } from './lib/git.mjs';
import { planDates, cleanCommits } from './lib/tree-match.mjs';
import { readInstalledAt } from './lib/config.mjs';
import { projectRoot } from './lib/sessions.mjs';

async function main() {
  const root = projectRoot(process.argv[2] || process.cwd());
  const installedAt = readInstalledAt();
  const plans = readPlans(root).filter((p) => !p.planStatus);
  const dates = planDates(root, plans, cleanCommits(await readCommits(root)));
  const list = [];
  for (const p of plans) {
    const d = dates.get(p);
    if (installedAt !== null && !(Number.isFinite(d.addedMs) && d.addedMs < installedAt)) continue;
    const ticked = p.tasks.reduce((a, t) => ({ done: a.done + (t.ticked?.done ?? 0), total: a.total + (t.ticked?.total ?? 0) }), { done: 0, total: 0 });
    list.push({ file: p.file, title: p.title, ticked, addedMs: d.addedMs, changedMs: d.changedMs });
  }
  list.sort((a, b) => (a.addedMs ?? 0) - (b.addedMs ?? 0));
  return { root, installedAt: installedAt === null ? null : new Date(installedAt).toISOString(), plans: list };
}

main()
  .then((out) => process.stdout.write(JSON.stringify(out, null, 2) + '\n'))
  .catch((e) => process.stdout.write(JSON.stringify({ error: String(e?.message ?? e) }) + '\n'))
  .finally(() => { process.exitCode = 0; });
