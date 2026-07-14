# repo-people App — Architecture Diagram

```mermaid
flowchart TB
    subgraph User["👤 User (Browser)"]
        UI["React 18 SPA\n(TypeScript + Vite)\nTailwind CSS"]
    end

    subgraph Vercel["☁️ Vercel (Frontend Hosting)"]
        UI
    end

    subgraph CloudRun["☁️ Google Cloud Run (Backend)"]
        API["FastAPI\n(Python 3.11)\nuvicorn"]
        Worker["Async Worker\n(asyncio)"]
        DB[("SQLite\n(aiosqlite)\n/tmp/repo_people_jobs.db")]
        SessionStore["In-Memory\nSession Store\n(OAuth state + share tokens)"]
    end

    subgraph GCP["Google Cloud Platform"]
        CloudRun
        SecretMgr["Secret Manager\n(OAuth credentials)"]
        ArtifactReg["Artifact Registry\n(Docker images)"]
        CloudBuild["Cloud Build\n(CI/CD)"]
    end

    subgraph GitHubAPIs["GitHub APIs"]
        GHAPI["github.com/api\nREST v3\nPyGithub client"]
        GHOAuth["github.com/login/oauth\nGitHub OAuth 2.0"]
    end

    subgraph ExternalLibs["repo-people Library (PyPI)"]
        RepoPeople["repo-people\n(Python package)\nUser role fetching\nProfile enrichment"]
    end

    %% Frontend → Backend communication
    UI -->|"HTTPS REST + SSE\n(VITE_API_BASE_URL)"| API

    %% Auth flow
    UI -->|"Popup /auth/login"| GHOAuth
    GHOAuth -->|"Callback + code"| API
    API -->|"Token exchange"| GHOAuth

    %% Backend internals
    API --> Worker
    Worker --> RepoPeople
    RepoPeople -->|"GitHub REST API\n(PyGithub)"| GHAPI
    API <--> DB
    API <--> SessionStore
    API -->|"Reads secrets"| SecretMgr

    %% CI/CD
    CloudBuild -->|"Builds + pushes image"| ArtifactReg
    ArtifactReg -->|"Deploys to"| CloudRun

    %% Styling
    classDef frontend fill:#6366f1,color:#fff,stroke:#4338ca
    classDef backend fill:#10b981,color:#fff,stroke:#059669
    classDef storage fill:#f59e0b,color:#fff,stroke:#d97706
    classDef external fill:#64748b,color:#fff,stroke:#475569
    classDef cicd fill:#0ea5e9,color:#fff,stroke:#0284c7

    class UI frontend
    class API,Worker backend
    class DB,SessionStore storage
    class GHAPI,GHOAuth,RepoPeople external
    class CloudBuild,ArtifactReg,SecretMgr cicd
```

## Component Summary

| Layer | Technology | Purpose |
|---|---|---|
| **Frontend** | React 18, TypeScript, Vite, Tailwind CSS | SPA UI — fetch, results, compare views |
| **Tables** | TanStack Table v8 | Sortable/filterable user data table |
| **Charts** | Recharts | Role distribution, account age, leaderboards |
| **Maps** | react-simple-maps | Geographic contributor world map |
| **Exports** | jsPDF, html2canvas, xlsx | PDF/CSV/JSON export |
| **Backend** | FastAPI, Python 3.11 | REST API + SSE streaming |
| **Job worker** | asyncio | Non-blocking parallel GitHub fetching |
| **GitHub client** | PyGithub, httpx | Role fetching, OAuth token exchange |
| **Data library** | repo-people (PyPI) | User profile enrichment and role logic |
| **Database** | SQLite (aiosqlite) | Job persistence, session storage |
| **Auth** | GitHub OAuth 2.0 | Sign-in — session cookies |
| **Frontend host** | Vercel | Static build CDN delivery |
| **Backend host** | Google Cloud Run | Containerised serverless backend |
| **Container** | Docker (python:3.11-slim) | Portable backend runtime |
| **CI/CD** | Google Cloud Build | Build, test, push, deploy pipeline |
| **Secrets** | GCP Secret Manager | OAuth client ID and secret |
| **Image registry** | GCP Artifact Registry | Versioned Docker images |
| **Testing (FE)** | Vitest, Testing Library | Unit and component tests |
| **Testing (BE)** | pytest + httpx | API integration tests |
```
