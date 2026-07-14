# repo-people Explorer

![Vercel](https://therealsujitk-vercel-badge.vercel.app/?app=repo-people)
[![PyPI version](https://badge.fury.io/py/repo-people.svg)](https://badge.fury.io/py/repo-people)
[![License: MIT](https://img.shields.io/badge/License-MIT-red.svg)](https://opensource.org/licenses/MIT)
[![Issues](https://img.shields.io/github/issues/amckenna41/repo-people-app)](https://github.com/amckenna41/repo-people-app/issues)

A full-stack web application that uses the `repo-people` Python package to explore the community and profile data of GitHub repositories, including in-depth analytics and visualizations.

<p align="center">
  <img src="https://raw.githubusercontent.com/amckenna41/repo-people/refs/heads/main/images/logo.png" alt="repo-people logo" width="300"/>
</p>

## Table of Contents
  * [Introduction](#introduction)
  * [Background](#background)
  * [Prerequisites](#prerequisites)
  * [Quick start (local, no Docker)](#quick-start-local-no-docker)
  * [Quick start (Docker Compose)](#quick-start-docker-compose)
  * [Deploying to Cloud Run](#deploying-to-cloud-run)
  * [API endpoints](#api-endpoints)
  * [Stack](#stack)
  * [Project structure](#project-structure)
  * [Views](#views)
  * [Tests](#tests)
  * [Changelog](#changelog)
  * [Issues](#issues)
  * [Contact](#contact)
  * [License](#license)

---

## Introduction

**repo-people** provides a single-call pipeline to collect every GitHub user associated with a repository across 9 role categories, fetch 30+ profile fields for each person from the GitHub API, and export the results to JSON, CSV, or Markdown. It is designed for research, open-source community analysis, and developer intelligence workflows.

Key features:
- **Role-aware collection** — fetches contributors across 9 role categories (stargazers, forkers, watchers, contributors, and more) in a single job
- **Rich profile data** — 30+ fields per user including bio, location, company, followers, organisations, and languages
- **Analytics dashboard** — summary cards, role distribution chart, account age donut chart, and a top-N leaderboard sortable by any numeric field
- **Sortable, filterable data table** — powered by TanStack Table with per-column filtering and a global search modal
- **User detail drawer** — click any row to expand a full profile panel with all fetched fields
- **Job comparison** — side-by-side diff of two completed jobs showing unique, shared, and overlapping users with statistics
- **Data export** — download full results as JSON or CSV from any completed job
- **Multi-job management** — rename, tag, cancel, and browse all past collection jobs from a single view
- **Import** — load previously exported JSON back into the app to re-analyse or compare without re-fetching

## Background

Understanding who contributes to, uses, and maintains an open-source project is valuable for community health analysis, academic research, and competitive intelligence. GitHub exposes this information across many endpoints (contributors, stargazers, watchers, forks, issues, pull requests, CODEOWNERS, commit history), but collecting and joining it requires many paginated API calls.

**repo-people** automates that collection, deduplicates users across all roles, enriches each record with the full GitHub profile, and computes additional signals (account age, activity recency, bot detection) in a single pipeline call.


## Prerequisites

| Requirement | Minimum version |
|---|---|
| Python | 3.11 |
| Node.js | 18 |
| npm | 9 |
| GitHub personal access token | — |

A GitHub personal access token is required to fetch data from the GitHub API. To create one:

1. Go to [github.com/settings/tokens](https://github.com/settings/tokens) (GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic))
2. Click **Generate new token (classic)**
3. Give it a descriptive name (e.g. `repo-people-explorer`)
4. Set an expiration as appropriate
5. Select the following scopes:
   - `read:user` — read public profile data for any user
   - `public_repo` — read contributor and commit data from public repositories
6. Click **Generate token** and copy it immediately — it will not be shown again

**The token is entered directly in the app UI when starting a collection job. It is transmitted as an `Authorization: Bearer` HTTP header and is never stored server-side or included in the request body.**

## Quick start (local, no Docker)

### 1. Backend

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

### 2. Frontend

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:5173

## Quick start (Docker Compose)

```bash
docker compose up --build
```

- Backend: http://localhost:8000
- Frontend: http://localhost:5173
- API docs: http://localhost:8000/docs

## API endpoints

| Method | Path | Description |
|---|---|---|
| POST | `/fetch` | Start a new fetch job (token via `Authorization: Bearer` header) |
| GET | `/fetch/{job_id}/stream` | SSE progress stream for a running job |
| POST | `/fetch/{job_id}/cancel` | Cancel a running job |
| POST | `/jobs/{job_id}/refresh` | Re-run a job with its original fetch parameters (returns a new job) |
| GET | `/jobs` | List the caller's jobs |
| DELETE | `/jobs/{job_id}` | Delete a job |
| PATCH | `/jobs/{job_id}` | Rename a job (body: `{"label": "..."}`) |
| PATCH | `/jobs/{job_id}/tags` | Update tags on a job (body: `{"tags": [...]}`) |
| GET | `/results/{job_id}` | Paginated user data — accepts `?page=1&page_size=200` |
| GET | `/results/{job_id}/summary` | Aggregated summary stats (cached after first call) |
| GET | `/results/{job_id}/top` | Top N users by field |
| POST | `/compare` | Compare two jobs |
| POST | `/compare/multi` | Compare more than two jobs |
| GET | `/results/{job_id}/export/json` | Download results as JSON |
| GET | `/results/{job_id}/export/csv` | Download results as CSV |
| POST | `/import` | Import a previously exported JSON file (max 5 MB; unsafe URLs stripped) |

> **Job scoping.** Jobs are private to the caller — identified by the GitHub login for OAuth users, or an anonymous `rp_client` cookie otherwise. `GET /jobs` returns only your jobs, and every job-specific endpoint returns `404` for jobs you don't own (legacy jobs created before scoping have no owner and remain public). `/fetch` and `/import` are rate-limited per caller. Send credentials (cookies) with every request; for a cross-origin frontend/backend split set `COOKIE_SAMESITE=none`.

## Stack

| Layer | Technology |
|---|---|
| Backend | Python 3.11, FastAPI, Uvicorn, sse-starlette |
| Frontend | React 18, TypeScript, Vite, Tailwind CSS |
| Charts | Recharts |
| Data grid | TanStack Table |
| Icons | Lucide React |

## Project structure

```
├── backend/
│   ├── main.py          # FastAPI app + all endpoints
│   ├── worker.py        # Background job coroutine
│   ├── store.py         # SQLite job store + CSV helper
│   ├── models.py        # Pydantic request/response models
│   ├── requirements.txt
│   └── Dockerfile
├── frontend/
│   ├── src/
│   │   ├── views/       # FetchView, ResultsView, CompareView
│   │   ├── components/  # UserTable, UserDrawer, RoleBadges, WorldMap
│   │   ├── utils/api.ts # Typed fetch helpers
│   │   └── types/       # Shared TypeScript types
│   ├── vite.config.ts
│   └── Dockerfile.dev
├── tests/
│   ├── backend/         # pytest integration + unit tests
│   └── frontend/        # Vitest component + API tests (in frontend/src/tests/)
└── docker-compose.yml
```

## Deploying to Cloud Run

The backend is designed to run as a single long-lived container, which maps well to Google Cloud Run with `max-instances=1`. The frontend can be deployed as a static site anywhere (Vercel, Firebase Hosting, Netlify, etc.).

> **Why max-instances=1?** The app uses an in-process SQLite store and an in-memory runtime dict. Multiple container instances would each have their own isolated state. A single instance avoids this while still scaling to zero when idle.

### Files created for Cloud Run

| File | Purpose |
|---|---|
| `Dockerfile.cloudrun` | Standalone production image (build context: repo root) |
| `backend/requirements.cloudrun.txt` | Python deps without the local `file://` reference |
| `cloudrun-service.yaml` | Declarative Cloud Run service definition |
| `.github/workflows/deploy-cloud-run.yml` | CI/CD — builds image and deploys on push to `main` |
| `frontend/.env.production` | Sets `VITE_API_BASE_URL` for the production frontend build |

### One-time Google Cloud setup

```bash
# 1. Create an Artifact Registry repository for Docker images
gcloud artifacts repositories create repo-people \
  --repository-format=docker \
  --location=us-central1

# 2. Create a service account for the GitHub Actions deployer
gcloud iam service-accounts create github-deployer \
  --display-name="GitHub Actions Cloud Run deployer"

# Grant it the minimum required roles
gcloud projects add-iam-policy-binding PROJECT_ID \
  --member="serviceAccount:github-deployer@PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/run.admin"
gcloud projects add-iam-policy-binding PROJECT_ID \
  --member="serviceAccount:github-deployer@PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/artifactregistry.writer"
gcloud projects add-iam-policy-binding PROJECT_ID \
  --member="serviceAccount:github-deployer@PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/iam.serviceAccountUser"

# 3. Set up Workload Identity Federation (no long-lived keys stored in GitHub)
#    Follow: https://github.com/google-github-actions/auth?tab=readme-ov-file#workload-identity-federation-through-a-service-account
```

### GitHub repository secrets / variables required

| Name | Type | Value |
|---|---|---|
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | Secret | Workload Identity provider resource name |
| `GCP_SERVICE_ACCOUNT` | Secret | `github-deployer@PROJECT_ID.iam.gserviceaccount.com` |
| `FRONTEND_URL` | Secret | Your frontend URL (used as `CORS_ORIGINS` on the backend) |
| `GCP_PROJECT_ID` | Variable | Your Google Cloud project ID |

### Manual deploy (without CI/CD)

```bash
# Build and push the image
docker build -f Dockerfile.cloudrun -t us-central1-docker.pkg.dev/PROJECT_ID/repo-people/backend:latest .
docker push us-central1-docker.pkg.dev/PROJECT_ID/repo-people/backend:latest

# Deploy using the service YAML (substitute IMAGE and CORS_ORIGINS first)
sed \
  -e "s|IMAGE|us-central1-docker.pkg.dev/PROJECT_ID/repo-people/backend:latest|g" \
  -e "s|CORS_ORIGINS|https://your-frontend.vercel.app|g" \
  cloudrun-service.yaml | \
gcloud run services replace - --region us-central1
```

### Frontend build for production

```bash
# Set the Cloud Run backend URL in frontend/.env.production, then:
cd frontend
npm run build   # output in frontend/dist/ — deploy to Vercel / Firebase Hosting / etc.
```

## Backend environment variables

| Name | Default | Purpose |
|---|---|---|
| `CORS_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | Comma-separated allowed origins |
| `FETCH_LIMIT` | `500` | Max users per job on the hosted service; `0` = unlimited (local installs) |
| `FETCH_RATE_LIMIT` | `20` | Max `/fetch` + `/import` requests per caller per minute (in-memory, per instance) |
| `COOKIE_SAMESITE` | `lax` | Set to `none` for a cross-origin frontend/backend split (forces `Secure`) |
| `ALLOW_DEV_CLEAR` | _(unset)_ | Set to `1` to enable the guarded `POST /clear_cache` dev endpoint |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | _(unset)_ | Enable GitHub OAuth sign-in |
| `FRONTEND_URL` / `BACKEND_URL` | localhost dev URLs | OAuth redirect targets; `BACKEND_URL` over HTTPS auto-enables `Secure` cookies |
| `REPO_PEOPLE_DB` | `backend/repo_people_jobs.db` | SQLite job-store path |

## Views

- **Fetch** — form to start a new fetch job; configure repository, roles, filters, and token; shows a live SSE progress log with ETA and rate-limit status; supports importing a previously exported JSON file
- **Results** — summary cards, role distribution chart, account age donut, world map of user locations, sortable/filterable data table, user detail drawer, top-N leaderboard, and export buttons (JSON/CSV/Excel)
- **Compare** — side-by-side diff of two or more completed jobs showing unique, shared, and overlapping users with statistics

## Tests

### Backend

```bash
# From repo root, using the backend venv
backend/.venv/bin/python -m pytest tests/backend -v
```

All backend tests use an isolated SQLite database and a fully mocked FastAPI `TestClient` — no real GitHub API calls are made.

### Frontend

```bash
cd frontend
npm run test          # run once
npm run test:watch    # watch mode
npm run test:coverage # with coverage report
```

Frontend tests use **Vitest** + **@testing-library/react** with a jsdom environment.

## Changelog
See [CHANGELOG.md](CHANGELOG.md) for a full history of additions, changes, fixes, and security improvements.

## Issues
Any issues, errors or bugs can be raised via the [Issues](https://github.com/amckenna41/repo-people-app/issues) tab in the repository.

## Contact
If you have any questions or comments, please contact amckenna41@qub.ac.uk or raise an issue on the [Issues][Issues] tab. <br><br>

## License
Distributed under the MIT License. See [`LICENSE`][license] for more details. 


<!-- [<img src="https://img.shields.io/github/stars/amckenna41/repo-people-app?color=green&label=star%20it%20on%20GitHub" width="132" height="20" alt="Star it on GitHub">](https://github.com/amckenna41/repo-people-app) -->


<!-- <a href="https://www.buymeacoffee.com/amckenna41" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/default-orange.png" alt="Buy Me A Coffee" height="41" width="174"></a> -->

[Back to top](#TOP)

[Issues]: https://github.com/amckenna41/repo-people-app/issues
[license]: https://github.com/amckenna41/repo-people-app/blob/master/LICENSE