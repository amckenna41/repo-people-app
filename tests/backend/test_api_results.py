"""
test_api_results.py — Integration tests for results, summary, top, and export endpoints:
  GET /results/{job_id}
  GET /results/{job_id}/summary
  GET /results/{job_id}/top
  GET /results/{job_id}/export/json
  GET /results/{job_id}/export/csv
"""
from __future__ import annotations

import csv
import io
import json

import pytest

from conftest import SAMPLE_USERS, _seed_done_job, _seed_pending_job


# ===========================================================================
# GET /results/{job_id}
# ===========================================================================

class TestGetResults:
    @pytest.mark.asyncio
    async def test_returns_result_for_done_job(self, async_client, done_job_id):
        resp = await async_client.get(f"/results/{done_job_id}")
        assert resp.status_code == 200
        data = resp.json()
        # Paginated response has a "users" key with the user dict
        assert "users" in data
        assert "total" in data
        assert "page" in data
        assert "pages" in data
        assert "alice" in data["users"]
        assert "bob" in data["users"]

    @pytest.mark.asyncio
    async def test_result_contains_correct_fields(self, async_client, done_job_id):
        resp = await async_client.get(f"/results/{done_job_id}")
        alice = resp.json()["users"]["alice"]
        assert alice["followers"] == 200
        assert alice["location_normalized"] == "United Kingdom"

    @pytest.mark.asyncio
    async def test_returns_404_for_unknown_job(self, async_client):
        resp = await async_client.get("/results/no-such-job")
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_returns_409_for_pending_job(self, async_client, pending_job_id):
        resp = await async_client.get(f"/results/{pending_job_id}")
        assert resp.status_code == 409

    @pytest.mark.asyncio
    async def test_409_message_contains_status(self, async_client, pending_job_id):
        resp = await async_client.get(f"/results/{pending_job_id}")
        assert "pending" in resp.json()["detail"]

    @pytest.mark.asyncio
    async def test_empty_result_returns_empty_users(self, async_client):
        jid = await _seed_done_job({})
        resp = await async_client.get(f"/results/{jid}")
        assert resp.status_code == 200
        assert resp.json()["users"] == {}

    @pytest.mark.asyncio
    async def test_pagination_page_param(self, async_client, done_job_id):
        resp = await async_client.get(f"/results/{done_job_id}?page=1&page_size=1")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["users"]) == 1
        assert data["page"] == 1
        assert data["pages"] >= 1


# ===========================================================================
# GET /results/{job_id}/summary
# ===========================================================================

class TestGetSummary:
    @pytest.mark.asyncio
    async def test_returns_200_for_done_job(self, async_client, done_job_id):
        resp = await async_client.get(f"/results/{done_job_id}/summary")
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_summary_has_required_keys(self, async_client, done_job_id):
        resp = await async_client.get(f"/results/{done_job_id}/summary")
        data = resp.json()
        for key in ("total", "humans", "bots", "top_locations", "top_companies",
                    "account_age_distribution", "role_distribution"):
            assert key in data, f"Missing summary key: {key}"

    @pytest.mark.asyncio
    async def test_total_counts_all_users(self, async_client, done_job_id):
        resp = await async_client.get(f"/results/{done_job_id}/summary")
        assert resp.json()["total"] == len(SAMPLE_USERS)

    @pytest.mark.asyncio
    async def test_bots_count_is_correct(self, async_client, done_job_id):
        resp = await async_client.get(f"/results/{done_job_id}/summary")
        data = resp.json()
        bots = sum(1 for u in SAMPLE_USERS.values() if u.get("is_bot"))
        assert data["bots"] == bots

    @pytest.mark.asyncio
    async def test_humans_count_is_correct(self, async_client, done_job_id):
        resp = await async_client.get(f"/results/{done_job_id}/summary")
        data = resp.json()
        humans = sum(1 for u in SAMPLE_USERS.values() if not u.get("is_bot"))
        assert data["humans"] == humans

    @pytest.mark.asyncio
    async def test_top_locations_is_list(self, async_client, done_job_id):
        resp = await async_client.get(f"/results/{done_job_id}/summary")
        assert isinstance(resp.json()["top_locations"], list)

    @pytest.mark.asyncio
    async def test_top_locations_have_location_and_count(self, async_client, done_job_id):
        resp = await async_client.get(f"/results/{done_job_id}/summary")
        for loc in resp.json()["top_locations"]:
            assert "location" in loc
            assert "count" in loc

    @pytest.mark.asyncio
    async def test_account_age_distribution_has_four_bands(self, async_client, done_job_id):
        resp = await async_client.get(f"/results/{done_job_id}/summary")
        bands = resp.json()["account_age_distribution"]
        assert set(bands.keys()) == {"<1yr", "1-5yr", "5-10yr", ">10yr"}

    @pytest.mark.asyncio
    async def test_account_age_distribution_sums_to_total(self, async_client, done_job_id):
        resp = await async_client.get(f"/results/{done_job_id}/summary")
        data = resp.json()
        band_total = sum(data["account_age_distribution"].values())
        assert band_total == data["total"]

    @pytest.mark.asyncio
    async def test_role_distribution_contains_known_roles(self, async_client, done_job_id):
        resp = await async_client.get(f"/results/{done_job_id}/summary")
        roles = resp.json()["role_distribution"]
        # alice and bob are both stargazers
        assert roles.get("stargazers", 0) >= 2

    @pytest.mark.asyncio
    async def test_returns_404_for_unknown_job(self, async_client):
        resp = await async_client.get("/results/no-such-job/summary")
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_returns_409_for_pending_job(self, async_client, pending_job_id):
        resp = await async_client.get(f"/results/{pending_job_id}/summary")
        assert resp.status_code == 409

    @pytest.mark.asyncio
    async def test_empty_result_has_zero_totals(self, async_client):
        jid = await _seed_done_job({})
        resp = await async_client.get(f"/results/{jid}/summary")
        data = resp.json()
        assert data["total"] == 0
        assert data["humans"] == 0
        assert data["bots"] == 0


# ===========================================================================
# GET /results/{job_id}/top
# ===========================================================================

class TestGetTop:
    @pytest.mark.asyncio
    async def test_returns_list_for_done_job(self, async_client, done_job_id):
        resp = await async_client.get(f"/results/{done_job_id}/top?by=followers&n=10")
        assert resp.status_code == 200
        assert isinstance(resp.json(), list)

    @pytest.mark.asyncio
    async def test_default_sorts_by_followers_descending(self, async_client, done_job_id):
        resp = await async_client.get(f"/results/{done_job_id}/top?by=followers&n=10")
        users = resp.json()
        followers = [u["followers"] for u in users]
        assert followers == sorted(followers, reverse=True)

    @pytest.mark.asyncio
    async def test_top_1_returns_one_user(self, async_client, done_job_id):
        resp = await async_client.get(f"/results/{done_job_id}/top?by=followers&n=1")
        assert len(resp.json()) == 1

    @pytest.mark.asyncio
    async def test_top_n_respects_n_param(self, async_client, done_job_id):
        resp = await async_client.get(f"/results/{done_job_id}/top?by=followers&n=2")
        assert len(resp.json()) <= 2

    @pytest.mark.asyncio
    async def test_sort_by_public_repos(self, async_client, done_job_id):
        resp = await async_client.get(f"/results/{done_job_id}/top?by=public_repos&n=10")
        assert resp.status_code == 200
        users = resp.json()
        repos = [u["public_repos"] for u in users]
        assert repos == sorted(repos, reverse=True)

    @pytest.mark.asyncio
    async def test_sort_by_account_age_days(self, async_client, done_job_id):
        resp = await async_client.get(f"/results/{done_job_id}/top?by=account_age_days&n=10")
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_n_zero_returns_422(self, async_client, done_job_id):
        resp = await async_client.get(f"/results/{done_job_id}/top?by=followers&n=0")
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_n_over_100_returns_422(self, async_client, done_job_id):
        resp = await async_client.get(f"/results/{done_job_id}/top?by=followers&n=101")
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_returns_404_for_unknown_job(self, async_client):
        resp = await async_client.get("/results/no-such-job/top")
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_returns_409_for_pending_job(self, async_client, pending_job_id):
        resp = await async_client.get(f"/results/{pending_job_id}/top")
        assert resp.status_code == 409

    @pytest.mark.asyncio
    async def test_unknown_sort_field_returns_all_with_zero_score(self, async_client, done_job_id):
        # Unknown field — all values are 0, so all users still returned
        resp = await async_client.get(f"/results/{done_job_id}/top?by=nonexistent_field&n=10")
        assert resp.status_code == 200
        assert isinstance(resp.json(), list)


# ===========================================================================
# GET /results/{job_id}/export/json
# ===========================================================================

class TestExportJson:
    @pytest.mark.asyncio
    async def test_returns_200_with_json_content_type(self, async_client, done_job_id):
        resp = await async_client.get(f"/results/{done_job_id}/export/json")
        assert resp.status_code == 200
        assert "application/json" in resp.headers.get("content-type", "")

    @pytest.mark.asyncio
    async def test_response_is_valid_json(self, async_client, done_job_id):
        resp = await async_client.get(f"/results/{done_job_id}/export/json")
        data = json.loads(resp.content)
        assert isinstance(data, dict)

    @pytest.mark.asyncio
    async def test_response_contains_all_users(self, async_client, done_job_id):
        resp = await async_client.get(f"/results/{done_job_id}/export/json")
        data = json.loads(resp.content)
        for login in SAMPLE_USERS:
            assert login in data

    @pytest.mark.asyncio
    async def test_content_disposition_header_present(self, async_client, done_job_id):
        resp = await async_client.get(f"/results/{done_job_id}/export/json")
        assert "attachment" in resp.headers.get("content-disposition", "")

    @pytest.mark.asyncio
    async def test_returns_404_for_unknown_job(self, async_client):
        resp = await async_client.get("/results/no-such-job/export/json")
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_returns_409_for_pending_job(self, async_client, pending_job_id):
        resp = await async_client.get(f"/results/{pending_job_id}/export/json")
        assert resp.status_code == 409


# ===========================================================================
# GET /results/{job_id}/export/csv
# ===========================================================================

class TestExportCsv:
    @pytest.mark.asyncio
    async def test_returns_200_with_csv_content_type(self, async_client, done_job_id):
        resp = await async_client.get(f"/results/{done_job_id}/export/csv")
        assert resp.status_code == 200
        assert "text/csv" in resp.headers.get("content-type", "")

    @pytest.mark.asyncio
    async def test_response_is_valid_csv(self, async_client, done_job_id):
        resp = await async_client.get(f"/results/{done_job_id}/export/csv")
        text = resp.content.decode()
        reader = list(csv.DictReader(io.StringIO(text)))
        assert len(reader) == len(SAMPLE_USERS)

    @pytest.mark.asyncio
    async def test_csv_has_login_column(self, async_client, done_job_id):
        resp = await async_client.get(f"/results/{done_job_id}/export/csv")
        text = resp.content.decode()
        header = text.splitlines()[0]
        assert "login" in header

    @pytest.mark.asyncio
    async def test_csv_contains_all_logins(self, async_client, done_job_id):
        resp = await async_client.get(f"/results/{done_job_id}/export/csv")
        text = resp.content.decode()
        for login in SAMPLE_USERS:
            assert login in text

    @pytest.mark.asyncio
    async def test_content_disposition_header_present(self, async_client, done_job_id):
        resp = await async_client.get(f"/results/{done_job_id}/export/csv")
        assert "attachment" in resp.headers.get("content-disposition", "")

    @pytest.mark.asyncio
    async def test_returns_404_for_unknown_job(self, async_client):
        resp = await async_client.get("/results/no-such-job/export/csv")
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_returns_409_for_pending_job(self, async_client, pending_job_id):
        resp = await async_client.get(f"/results/{pending_job_id}/export/csv")
        assert resp.status_code == 409

    @pytest.mark.asyncio
    async def test_empty_result_returns_empty_body(self, async_client):
        jid = await _seed_done_job({})
        resp = await async_client.get(f"/results/{jid}/export/csv")
        assert resp.status_code == 200
        assert resp.content == b""


# ===========================================================================
# POST /results/{job_id}/share  and  GET /share/{token}
# ===========================================================================

class TestShareEndpoints:
    @pytest.mark.asyncio
    async def test_create_share_returns_token_and_url(self, async_client, done_job_id):
        resp = await async_client.post(f"/results/{done_job_id}/share")
        assert resp.status_code == 200
        data = resp.json()
        assert "token" in data
        assert "url" in data
        assert "expires_at" in data
        assert data["token"] in data["url"]

    @pytest.mark.asyncio
    async def test_create_share_404_for_unknown_job(self, async_client):
        resp = await async_client.post("/results/no-such-job/share")
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_create_share_409_for_pending_job(self, async_client, pending_job_id):
        resp = await async_client.post(f"/results/{pending_job_id}/share")
        assert resp.status_code == 409

    @pytest.mark.asyncio
    async def test_get_shared_results_returns_users(self, async_client, done_job_id):
        create = await async_client.post(f"/results/{done_job_id}/share")
        token = create.json()["token"]
        resp = await async_client.get(f"/share/{token}")
        assert resp.status_code == 200
        data = resp.json()
        assert "users" in data
        assert "total" in data
        assert "page" in data
        assert "pages" in data
        assert "job_label" in data
        assert "expires_at" in data

    @pytest.mark.asyncio
    async def test_get_shared_results_contains_correct_users(self, async_client, done_job_id):
        create = await async_client.post(f"/results/{done_job_id}/share")
        token = create.json()["token"]
        resp = await async_client.get(f"/share/{token}")
        users = resp.json()["users"]
        assert "alice" in users
        assert "bob" in users

    @pytest.mark.asyncio
    async def test_get_shared_results_paginated(self, async_client, done_job_id):
        create = await async_client.post(f"/results/{done_job_id}/share")
        token = create.json()["token"]
        resp = await async_client.get(f"/share/{token}?page=1&page_size=1")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["users"]) == 1
        assert data["total"] == 2

    @pytest.mark.asyncio
    async def test_get_shared_results_404_for_bad_token(self, async_client):
        resp = await async_client.get("/share/totally-invalid-token")
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_get_shared_results_410_for_expired_token(self, async_client, done_job_id):
        import main as app_module
        # Manually insert an already-expired share token
        expired_token = "expired-test-token-xyz"
        app_module._share_tokens[expired_token] = {
            "job_id": done_job_id,
            "expires_at": 1.0,  # far in the past
        }
        resp = await async_client.get(f"/share/{expired_token}")
        assert resp.status_code == 410
        # Ensure the token was pruned
        assert expired_token not in app_module._share_tokens
