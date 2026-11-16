"""Write per-skill BMAD .user.toml overrides for interactive review and the Fable final review.
Refuses to overwrite."""
import json
import sys
from pathlib import Path

POLICY = "file:" + (Path.home() / ".claude" / "bmad" / "interactive-review.md").as_posix()
# The Fable final review, kept personal (decision 21): loaded from the user layer, so a shared repo's
# teammates never get it. BMAD appends persistent_facts across layers, so a project that still commits the
# old team overrides loads it twice, which is harmless.
FABLE_FILE = Path.home() / ".claude" / "bmad" / "fable-final-review.md"
FABLE = "file:" + FABLE_FILE.as_posix()
FABLE_SKILLS = {
    "bmad-architecture", "bmad-spec", "bmad-prd", "bmad-ux",
    "bmad-correct-course", "bmad-ticket", "bmad-forge-idea", "bmad-deep-recon",
}

POINTS = {
    "bmad-architecture": "Options for each architecture decision, compared side by side; the spine draft and finalize, with a component and boundary diagram (.mmd).",
    "bmad-spec": "Scope and approach alternatives; the kernel draft and finalize, with a diagram of the parts and flows it defines.",
    "bmad-prd": "Requirement scope and trade-off choices; the PRD draft and finalize together with its validation report, plus a requirements-to-features map.",
    "bmad-ux": "Theme and design-direction choices (Visualizer, using the HTML the creative tools produce); DESIGN.md, EXPERIENCE.md and the key-screen mockups at finalize, in one review.",
    "bmad-code-review": "The diff under review (plannotator review); the triaged findings, as a list the owner ticks to choose what gets fixed, with a findings-by-severity chart.",
    "bmad-review": "When the findings go to a person (not a calling skill), the report in Plannotator with a list to tick for which findings to act on.",
    "bmad-build": "Any plan approval the build asks for; its review findings before stopping at built, as a list to tick for which to fix. Offer the finished diff in plannotator review; open it only if asked or if the change is risky.",
    "bmad-ticket": "The initiative-to-epic and epic-to-story slicing, with an epic/story map; ordering choices; publish.",
    "bmad-correct-course": "The sprint change proposal, with an impact map of the affected documents, epics and stories; the choice between recovery paths.",
    "bmad-forge-idea": "The brief at the end, and any fork where the owner has to pick a direction.",
    "bmad-product-brief": "The brief draft and finalize; positioning or scope alternatives.",
    "bmad-prfaq": "The press release and FAQ draft and finalize; alternative framings of the concept.",
    "bmad-deep-recon": "Choosing between candidates (a comparison view and a trade-off chart); the finished briefing, opened in Plannotator.",
    "bmad-retrospective": "The retrospective with its findings and action items, and the acceptance decision.",
    "bmad-walkthrough": "The walkthrough itself: plannotator review for a commit or PR, plannotator annotate for a file or folder.",
    "bmad-brainstorming": "Convergence: which ideas to keep, as a list to tick, with a map of how the ideas cluster.",
    "bmad-project-context": "The proposed AGENTS.md block and any pitfalls recorded, before they are written.",
}


def toml_str(s: str) -> str:
    return json.dumps(s, ensure_ascii=False)  # JSON string escaping is valid TOML basic-string escaping


def add_fable(target: Path) -> bool:
    """Insert the Fable entry before the closing ] of persistent_facts. False if present or no list found."""
    text = target.read_text(encoding="utf-8", newline="")
    if toml_str(FABLE) in text:
        return False
    nl = "\r\n" if "\r\n" in text else "\n"
    close = text.rfind(nl + "]")
    if "persistent_facts" not in text or close < 0:
        return False
    head = text[:close]
    if not head.rstrip().endswith((",", "[")):
        head = head.rstrip() + ","
    text = head + nl + f"  {toml_str(FABLE)}," + text[close:]
    target.write_text(text, encoding="utf-8", newline="")
    return True


def main(projects: list[str]) -> int:
    written, updated, skipped = 0, 0, []
    use_fable = FABLE_FILE.is_file()  # the Fable component is optional
    for proj in projects:
        custom = Path(proj) / "_bmad" / "custom"
        if not custom.is_dir():
            skipped.append(f"{proj}: no _bmad/custom")
            continue
        for skill, point in POINTS.items():
            target = custom / f"{skill}.user.toml"
            if target.exists():
                # Never rewrite an existing override; only add the Fable line a planning skill lacks
                # (overrides written before decision 21 don't have it).
                if use_fable and skill in FABLE_SKILLS and add_fable(target):
                    updated += 1
                else:
                    skipped.append(f"{target}: exists")
                continue
            fable = f"  {toml_str(FABLE)},\n" if use_fable and skill in FABLE_SKILLS else ""
            target.write_text(
                "# Personal (gitignored): interactive review with Plannotator / Visualizer"
                + (", and the Fable final review" if fable else "") + ".\n"
                "# The policies live in global files under ~/.claude/bmad; edit them there, not here.\n"
                "[workflow]\n"
                "persistent_facts = [\n"
                f"  {toml_str(POLICY)},\n"
                f"  {toml_str('Decision points in this workflow for the interactive review policy: ' + point)},\n"
                + fable +
                "]\n",
                encoding="utf-8",
            )
            written += 1
    print(f"written {written}, Fable line added to {updated}")
    for s in skipped:
        print("skipped", s)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
