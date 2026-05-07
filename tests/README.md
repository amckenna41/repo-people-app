# repo-people Frontend Tests

This directory contains unit and integration tests for the **backend** (Python/FastAPI) and **frontend** (TypeScript/Vitest) of the repo-people Explorer.

---

## Structure

```
tests/
└── backend/
    ├── conftest.py          # pytest fixtures (in-memory DB, test client, seeded jobs)
    ├── test_store.py        # Unit tests for store.py (job CRUD, tags, CSV export)
    ├── test_api_jobs.py     # Integration tests for /jobs, /fetch, cancel, rename, tags
    ├── test_api_results.py  # Integration tests for /results, /summary, /top, exports
    ├── test_api_compare.py  # Integration tests for /compare and /compare/multi
    └── test_api_import.py   # Integration tests for POST /import

frontend/src/tests/
├── setup.ts             # Vitest global setup (fetch mock, DOM env)
├── api.test.ts          # Unit tests for src/utils/api.ts
└── components/
    └── RoleBadges.test.tsx   # Unit tests for RoleBadges component
```

---

## Running backend tests

```bash
# From repo root
REPO_PEOPLE_DB=":memory:" PYTHONPATH=. \
  .venv/bin/pytest repo_people_frontend/tests/backend -v
```

All backend tests use an **in-memory SQLite database** and a fully isolated FastAPI `TestClient` — no real GitHub API calls are made.

---

## Running frontend tests

```bash
cd frontend
npm run test          # run once
npm run test:watch    # watch mode
npm run test:coverage # with coverage report
```

Frontend tests use **Vitest** + **@testing-library/react** with a jsdom environment. `fetch` is mocked globally via `vitest-fetch-mock`.
