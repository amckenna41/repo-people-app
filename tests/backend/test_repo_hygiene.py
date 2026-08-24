"""
Repo hygiene checks.

Lives under tests/backend/ because that is the path CI runs (`pytest tests/backend`),
even though the checks are repo-wide rather than backend-specific.
"""
from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]

# Only the angle-bracket markers are checked, and only at the start of a line.
# They are unambiguous — nothing legitimate opens a line with seven of these —
# whereas a bare `=======` is a normal RST/Markdown underline. Built from
# repetition so this file does not trip its own check.
CONFLICT_MARKERS = ("<" * 7, ">" * 7)

# Binary and vendored paths that are never hand-merged and can contain long runs
# of these characters legitimately.
SKIP_PREFIXES = ("frontend/dist/", "frontend/coverage/", "docs/")
SKIP_SUFFIXES = (".pdf", ".png", ".jpg", ".svg", ".ico")


def _tracked_files() -> list[str]:
    out = subprocess.run(
        ["git", "ls-files"], cwd=REPO_ROOT, capture_output=True, text=True, check=True
    )
    return [
        f for f in out.stdout.splitlines()
        if not f.startswith(SKIP_PREFIXES) and not f.endswith(SKIP_SUFFIXES)
    ]


def test_no_unresolved_conflict_markers():
    """A commit once landed on main with conflict markers in four files.

    The working tree read as clean afterwards, so nothing looked wrong locally —
    it surfaced only in CI, as `pip install` failing with
    `Invalid requirement: '<<<<<<< HEAD'`. This turns that into an immediate,
    local, obvious failure.
    """
    offenders: list[str] = []
    for rel in _tracked_files():
        path = REPO_ROOT / rel
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, FileNotFoundError):
            continue  # binary, or a file staged for deletion
        for line_no, line in enumerate(text.splitlines(), 1):
            if line.startswith(CONFLICT_MARKERS):
                offenders.append(f"{rel}:{line_no}: {line[:60]}")
    assert not offenders, "Unresolved merge conflict markers:\n" + "\n".join(offenders)


@pytest.mark.parametrize("req", ["requirements.txt", "requirements.cloudrun.txt"])
def test_requirements_files_are_parseable(req):
    """The conflict markers broke CI here first. Every non-comment line must be a
    requirement pip can parse."""
    from packaging.requirements import Requirement, InvalidRequirement

    path = REPO_ROOT / "backend" / req
    for line_no, raw in enumerate(path.read_text().splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        try:
            Requirement(line)
        except InvalidRequirement as exc:
            pytest.fail(f"{req}:{line_no}: {line!r} is not a valid requirement — {exc}")


def test_frontend_lockfile_matches_package_json():
    """`npm ci` fails outright when these drift, so catch it before CI does."""
    import json

    pkg = json.loads((REPO_ROOT / "frontend" / "package.json").read_text())
    lock = json.loads((REPO_ROOT / "frontend" / "package-lock.json").read_text())

    assert lock["version"] == pkg["version"], (
        f"package-lock version {lock['version']} != package.json {pkg['version']}"
    )
    declared = {**pkg.get("dependencies", {}), **pkg.get("devDependencies", {})}
    locked_root = lock["packages"][""]
    locked = {
        **locked_root.get("dependencies", {}),
        **locked_root.get("devDependencies", {}),
    }
    assert declared == locked, (
        "package-lock.json root deps are out of sync with package.json; "
        "run `npm install --package-lock-only`"
    )
