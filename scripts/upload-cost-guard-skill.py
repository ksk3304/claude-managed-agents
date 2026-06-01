#!/usr/bin/env python3
"""Upload or version the MAKOTOくん Cost Guard Anthropic Skill.

Requires:
  ANTHROPIC_API_KEY=sk-ant-...

Output:
  COST_GUARD_SKILL_ID=...
  COST_GUARD_SKILL_VERSION=...
"""

from __future__ import annotations

import sys
from pathlib import Path

import anthropic
from anthropic.lib import files_from_dir


DISPLAY_TITLE = "MAKOTOくん Cost Guard"
SKILL_DIR = Path(__file__).resolve().parents[1] / "skills" / "cost-guard"
BETA_HEADER = "skills-2025-10-02"


def load_api_key() -> str:
    root = Path(__file__).resolve()
    candidates = [
        root.parents[2] / "makoto-prime" / "scripts",
        root.parents[3] / "makoto-prime" / "scripts",
    ]
    for sibling in candidates:
        if sibling.exists():
            sys.path.insert(0, str(sibling))
            import cma_lib  # type: ignore

            return cma_lib.load_api_key()

    import os

    key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if key:
        return key
    raise SystemExit("ANTHROPIC_API_KEY is required")


def main() -> int:
    if not (SKILL_DIR / "SKILL.md").exists():
        print(f"SKILL.md not found: {SKILL_DIR}", file=sys.stderr)
        return 2

    client = anthropic.Anthropic(api_key=load_api_key())
    files = files_from_dir(SKILL_DIR)

    existing_id: str | None = None
    skills_list = client.beta.skills.list(source="custom", betas=[BETA_HEADER])
    for skill in getattr(skills_list, "data", []):
        if getattr(skill, "display_title", None) == DISPLAY_TITLE:
            existing_id = skill.id
            break

    if existing_id:
        version = client.beta.skills.versions.create(
            skill_id=existing_id,
            files=files,
            betas=[BETA_HEADER],
        )
        skill_id = existing_id
    else:
        created = client.beta.skills.create(
            display_title=DISPLAY_TITLE,
            files=files,
            betas=[BETA_HEADER],
        )
        skill_id = created.id
        version = getattr(created, "latest_version", None)

    version_id = getattr(version, "version", None) or getattr(version, "id", None)
    if not version_id:
        versions = client.beta.skills.versions.list(skill_id, betas=[BETA_HEADER])
        version_id = getattr(versions.data[0], "version")

    print(f"COST_GUARD_SKILL_ID={skill_id}")
    print(f"COST_GUARD_SKILL_VERSION={version_id}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
