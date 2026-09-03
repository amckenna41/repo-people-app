"""
test_worker.py — per-role error classification.

Context: GitHub now rejects unauthenticated requests for `stargazers` and
`watchers` (401), and `maintainers` needs collaborator access. A tokenless run
therefore collects nothing for those roles while still completing "successfully"
— for a repo whose community is mostly stargazers, that silently drops most of
the result set. The message shown must point at the real cause.
"""
from __future__ import annotations

import pytest
from github import GithubException

from worker import _classify_role_error, _AUTH_REQUIRED_ROLES


def gh(status: int, message: str = "Requires authentication") -> GithubException:
    return GithubException(status, {"message": message}, {})


class TestClassifyRoleError:
    @pytest.mark.parametrize("role", sorted(_AUTH_REQUIRED_ROLES))
    def test_401_without_a_token_blames_the_missing_token(self, role):
        msg = _classify_role_error(gh(401), role, has_token=False)
        assert "requires a token" in msg.lower()
        # The old wording sent people off to regenerate a token they never had.
        assert "invalid or expired" not in msg.lower()
        assert role in msg

    def test_401_with_a_token_still_blames_the_token(self, role="stargazers"):
        msg = _classify_role_error(gh(401), role, has_token=True)
        assert "invalid or expired" in msg.lower()

    def test_403_without_a_token_on_an_auth_only_role_names_the_token(self):
        # GitHub returns 403 rather than 401 on some of these paths.
        msg = _classify_role_error(gh(403, "Forbidden"), "watchers", has_token=False)
        assert "requires a token" in msg.lower()

    def test_403_without_a_token_on_a_public_role_keeps_the_generic_message(self):
        # contributors works unauthenticated, so a 403 there means something
        # else — private repo, or scope — and must not be mislabelled.
        msg = _classify_role_error(gh(403, "Forbidden"), "contributors", has_token=False)
        assert "access denied" in msg.lower()
        assert "requires a token" not in msg.lower()

    def test_rate_limit_403_is_reported_as_a_rate_limit(self):
        msg = _classify_role_error(gh(403, "API rate limit exceeded"), "stargazers", has_token=False)
        assert "rate limit" in msg.lower()

    @pytest.mark.parametrize("status,expected", [
        (404, "not found"),
        (429, "secondary rate limit"),
    ])
    def test_other_statuses_keep_their_specific_messages(self, status, expected):
        assert expected in _classify_role_error(gh(status), "contributors").lower()

    def test_non_github_exception_is_reported_verbatim(self):
        msg = _classify_role_error(ValueError("boom"), "contributors")
        assert "ValueError" in msg and "boom" in msg

    def test_defaults_to_assuming_a_token(self):
        # Keeps the signature backwards-compatible for any other caller.
        assert "invalid or expired" in _classify_role_error(gh(401), "stargazers").lower()
