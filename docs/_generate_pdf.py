"""
Generates docs/repo-people-tech-overview.pdf
Run: python docs/_generate_pdf.py
"""
from fpdf import FPDF
from fpdf.enums import XPos, YPos
import os

OUTPUT = os.path.join(os.path.dirname(__file__), "repo-people-tech-overview.pdf")

PURPLE = (99, 102, 241)
GREEN  = (16, 185, 129)
AMBER  = (245, 158, 11)
BLUE   = (14, 165, 233)
DARK   = (15, 23, 42)
GREY   = (100, 116, 139)
LIGHT  = (248, 250, 252)
WHITE  = (255, 255, 255)


class PDF(FPDF):
    def header(self):
        self.set_fill_color(*DARK)
        self.rect(0, 0, 210, 18, "F")
        self.set_font("Helvetica", "B", 9)
        self.set_text_color(*WHITE)
        self.set_xy(10, 5)
        self.cell(0, 8, "repo-people App - Technical Overview", new_x=XPos.LMARGIN, new_y=YPos.NEXT)
        self.set_text_color(*DARK)
        self.ln(4)

    def footer(self):
        self.set_y(-14)
        self.set_font("Helvetica", "", 8)
        self.set_text_color(*GREY)
        self.cell(0, 8, f"Page {self.page_no()}", align="C")

    def section_title(self, text, color=PURPLE):
        self.set_font("Helvetica", "B", 13)
        self.set_text_color(*color)
        self.ln(3)
        self.cell(0, 8, text, new_x=XPos.LMARGIN, new_y=YPos.NEXT)
        self.set_draw_color(*color)
        self.set_line_width(0.5)
        self.line(10, self.get_y(), 200, self.get_y())
        self.ln(3)
        self.set_text_color(*DARK)

    def sub_title(self, text):
        self.set_font("Helvetica", "B", 10)
        self.set_text_color(*DARK)
        self.cell(0, 6, text, new_x=XPos.LMARGIN, new_y=YPos.NEXT)
        self.ln(1)

    def body(self, text):
        self.set_font("Helvetica", "", 9)
        self.set_text_color(*DARK)
        self.multi_cell(0, 5, text)
        self.ln(2)

    def badge_row(self, items: list[tuple[str, tuple]], row_gap=4):
        """Render a row of coloured pill badges."""
        x0 = self.get_x()
        y0 = self.get_y()
        x = x0
        for label, color in items:
            w = self.get_string_width(label) + 6
            if x + w > 195:
                x = x0
                y0 += 8
            self.set_fill_color(*color)
            self.set_text_color(*WHITE)
            self.set_font("Helvetica", "B", 7)
            self.set_xy(x, y0)
            self.cell(w, 6, label, fill=True)
            x += w + 3
        self.ln(row_gap + 8)
        self.set_text_color(*DARK)

    def table(self, headers: list[str], rows: list[list[str]], col_widths: list[int]):
        # Header row
        self.set_fill_color(*DARK)
        self.set_text_color(*WHITE)
        self.set_font("Helvetica", "B", 8)
        for h, w in zip(headers, col_widths):
            self.cell(w, 7, h, border=0, fill=True)
        self.ln()
        # Data rows
        for i, row in enumerate(rows):
            bg = LIGHT if i % 2 == 0 else WHITE
            self.set_fill_color(*bg)
            self.set_text_color(*DARK)
            self.set_font("Helvetica", "", 8)
            # Calculate max lines for this row to size height correctly
            for j, (cell, w) in enumerate(zip(row, col_widths)):
                x = self.get_x()
                y = self.get_y()
                self.multi_cell(w, 5.5, cell, fill=(j == 0), border=0)
                if j < len(row) - 1:
                    self.set_xy(x + w, y)
            self.ln(1)
        self.ln(2)


def build():
    pdf = PDF()
    pdf.set_auto_page_break(auto=True, margin=16)
    pdf.set_margins(10, 22, 10)
    pdf.add_page()

    # ── Cover section ────────────────────────────────────────────────────────
    pdf.set_fill_color(*PURPLE)
    pdf.rect(0, 20, 210, 38, "F")
    pdf.set_font("Helvetica", "B", 24)
    pdf.set_text_color(*WHITE)
    pdf.set_xy(10, 26)
    pdf.cell(0, 12, "repo-people App", new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    pdf.set_font("Helvetica", "", 12)
    pdf.set_xy(10, 40)
    pdf.cell(0, 8, "Technical Overview - Tools, Technologies & Architecture", new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    pdf.set_text_color(*DARK)
    pdf.ln(14)

    # ── What is it ───────────────────────────────────────────────────────────
    pdf.section_title("What is repo-people?", PURPLE)
    pdf.body(
        "repo-people is a full-stack web application for exploring and analysing the people "
        "behind any GitHub repository. Given a repository owner and name, it fetches every "
        "relevant user - contributors, stargazers, forkers, watchers, issue authors, PR authors, "
        "and maintainers - and enriches each profile with location, company, follower count, "
        "account age, and more.\n\n"
        "The results are presented in an interactive dashboard with sortable tables, charts, "
        "a geographic world map, role-overlap analysis, leaderboards, shareable links, and "
        "multi-format export (JSON, CSV, Markdown, PDF). Users can authenticate via GitHub "
        "OAuth to skip manual token management, or supply a Personal Access Token for higher "
        "rate limits."
    )

    # ── Architecture overview ────────────────────────────────────────────────
    pdf.section_title("Architecture Overview", GREEN)
    pdf.body(
        "The app is split into a React single-page application deployed on Vercel and a "
        "Python FastAPI backend deployed as a containerised service on Google Cloud Run. "
        "The two tiers communicate over HTTPS - REST for commands and Server-Sent Events "
        "(SSE) for live fetch progress streaming."
    )

    arch_rows = [
        ["Vercel (CDN)", "Frontend static build (JS/CSS/HTML)", "Frontend hosting"],
        ["Google Cloud Run", "Containerised Python service", "Backend hosting"],
        ["SQLite (aiosqlite)", "Job results + OAuth sessions", "Persistence"],
        ["GitHub OAuth 2.0", "User sign-in via popup flow", "Authentication"],
        ["GCP Secret Manager", "OAuth client ID + secret", "Secrets management"],
        ["GCP Artifact Registry", "Versioned Docker images", "Image storage"],
        ["Google Cloud Build", "Build -> push -> deploy pipeline", "CI/CD"],
    ]
    pdf.table(
        ["Component", "Role", "Purpose"],
        arch_rows,
        [45, 80, 65],
    )

    # ── Frontend stack ───────────────────────────────────────────────────────
    pdf.section_title("Frontend Stack", PURPLE)
    pdf.badge_row([
        ("React 18", PURPLE), ("TypeScript", BLUE), ("Vite 5", GREEN),
        ("Tailwind CSS 3", AMBER), ("TanStack Table v8", PURPLE),
        ("Recharts", GREEN), ("react-simple-maps", BLUE),
        ("jsPDF", AMBER), ("html2canvas", GREY), ("xlsx", PURPLE),
        ("Lucide Icons", BLUE),
    ])

    fe_rows = [
        ["React 18 + TypeScript", "UI framework", "Component-based SPA with full type safety"],
        ["Vite 5", "Build tool", "Lightning-fast HMR in dev; optimised production bundles"],
        ["Tailwind CSS 3", "Styling", "Utility-first CSS; dark theme throughout"],
        ["TanStack Table v8", "Data table", "Virtualised, sortable, filterable user table"],
        ["Recharts", "Charts", "Role distribution, account-age pie, leaderboard bars"],
        ["react-simple-maps", "World map", "SVG geographic map of contributor locations"],
        ["jsPDF + html2canvas", "PDF export", "Client-side PDF generation from rendered DOM"],
        ["xlsx", "Spreadsheet export", "CSV/XLSX file generation in the browser"],
        ["Lucide React", "Icons", "Consistent icon set across the UI"],
        ["Vitest + Testing Library", "Testing", "Unit + component tests with DOM simulation"],
    ]
    pdf.table(
        ["Library", "Category", "Usage"],
        fe_rows,
        [48, 34, 108],
    )

    # ── Backend stack ────────────────────────────────────────────────────────
    pdf.section_title("Backend Stack", GREEN)
    pdf.badge_row([
        ("Python 3.11", GREEN), ("FastAPI", GREEN), ("uvicorn", BLUE),
        ("aiosqlite", AMBER), ("PyGithub", GREY), ("httpx", PURPLE),
        ("sse-starlette", GREEN), ("Pydantic v2", BLUE),
        ("repo-people (PyPI)", AMBER), ("python-dotenv", GREY),
    ])

    be_rows = [
        ["FastAPI", "Web framework", "Async REST API with automatic OpenAPI docs"],
        ["uvicorn", "ASGI server", "Production-grade async server (ASGI)"],
        ["aiosqlite", "Database driver", "Non-blocking SQLite for job + session persistence"],
        ["PyGithub", "GitHub client", "Paginated GitHub REST API v3 calls"],
        ["httpx", "HTTP client", "Async HTTP for OAuth token exchange"],
        ["sse-starlette", "Streaming", "Server-Sent Events for live fetch progress"],
        ["Pydantic v2", "Validation", "Request body validation and field coercion"],
        ["repo-people", "Data library", "User role fetching and profile enrichment (PyPI pkg)"],
        ["python-dotenv", "Config", "Local .env file loading for development"],
        ["pytest + httpx", "Testing", "Backend API integration tests"],
    ]
    pdf.table(
        ["Library", "Category", "Usage"],
        be_rows,
        [38, 34, 118],
    )

    # ── Infrastructure ───────────────────────────────────────────────────────
    pdf.add_page()
    pdf.section_title("Infrastructure & Deployment", BLUE)
    pdf.body(
        "The backend is containerised using Docker (python:3.11-slim base) and deployed to "
        "Google Cloud Run, which provides automatic HTTPS, scale-to-zero, and managed TLS. "
        "A single Cloud Run instance is enforced (maxScale=1) to avoid split SQLite state. "
        "The frontend is a static Vite build deployed to Vercel for global CDN delivery."
    )

    infra_rows = [
        ["Docker", "Container runtime", "python:3.11-slim; builds via Dockerfile.cloudrun"],
        ["Google Cloud Run", "Backend hosting", "Serverless containers; scale-to-zero; HTTPS"],
        ["Vercel", "Frontend hosting", "Static CDN; automatic deploys from Git"],
        ["GCP Artifact Registry", "Image registry", "Stores tagged backend Docker images"],
        ["Google Cloud Build", "CI/CD", "Builds image, runs tests, deploys on push to main"],
        ["GCP Secret Manager", "Secrets", "GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET"],
        ["GitHub Actions", "CI", "Frontend lint, type-check, and test suite on PRs"],
    ]
    pdf.table(
        ["Tool", "Category", "Role"],
        infra_rows,
        [48, 38, 104],
    )

    # ── OAuth / Auth ─────────────────────────────────────────────────────────
    pdf.section_title("Authentication Flow", AMBER)
    pdf.body(
        "GitHub OAuth 2.0 is used for user authentication. The flow:\n"
        "  1. Frontend opens a small popup to GET /auth/login on the backend.\n"
        "  2. Backend constructs a GitHub authorize URL (with state token for CSRF "
        "protection) and redirects the popup to GitHub.\n"
        "  3. GitHub redirects back to /auth/callback on the backend with a short-lived code.\n"
        "  4. Backend exchanges the code for a GitHub access token via httpx POST.\n"
        "  5. Backend fetches the user profile, creates a server-side session (aiosqlite), "
        "and sets a secure HttpOnly session cookie.\n"
        "  6. Backend redirects the popup back to the frontend with #auth=success in the URL.\n"
        "  7. Frontend detects the hash, closes the popup, and polls /auth/me to retrieve "
        "the authenticated user profile."
    )

    # ── Key features ─────────────────────────────────────────────────────────
    pdf.section_title("Key Features", PURPLE)
    features = [
        ("Multi-role fetching", "Fetch Contributors, Stargazers, Forkers, Watchers, Issue Authors, PR Authors, Maintainers in parallel"),
        ("Live SSE streaming", "Real-time fetch progress (users fetched, ETA, rate-limit remaining) via Server-Sent Events"),
        ("Rich analytics", "Role distribution charts, account-age breakdowns, leaderboards, overlap analysis, health score"),
        ("Geographic map", "World map of contributor locations using react-simple-maps + SVG"),
        ("Multi-repo compare", "Fetch multiple repos and compare user overlap across jobs"),
        ("GitHub OAuth", "Sign in once; backend uses your GitHub session for all subsequent fetches"),
        ("Shareable links", "Generate 24-hour read-only share tokens for any job"),
        ("Multi-format export", "Download results as JSON, CSV, Markdown table, or PDF report"),
        ("Job history", "Persistent job list with tagging, renaming, and deletion"),
        ("Fetch cancellation", "Stop an in-progress fetch at any time; partial results are preserved"),
    ]
    for title, desc in features:
        pdf.set_font("Helvetica", "B", 9)
        pdf.set_text_color(*PURPLE)
        pdf.cell(55, 5.5, f"* {title}", new_x=XPos.RIGHT, new_y=YPos.TOP)
        pdf.set_font("Helvetica", "", 9)
        pdf.set_text_color(*DARK)
        pdf.multi_cell(0, 5.5, desc)
        pdf.ln(1)

    # ── Environment variables ────────────────────────────────────────────────
    pdf.section_title("Environment Variables", GREY)
    env_rows = [
        ["VITE_API_BASE_URL", "Frontend (Vercel)", "Cloud Run backend URL; required for prod builds"],
        ["BACKEND_URL", "Backend (Cloud Run)", "Self-referencing URL used in OAuth redirect_uri"],
        ["FRONTEND_URL", "Backend (Cloud Run)", "Vercel app URL; used in post-OAuth redirect"],
        ["CORS_ORIGINS", "Backend (Cloud Run)", "Comma-separated allowed origins for CORS"],
        ["GITHUB_CLIENT_ID", "Backend (Cloud Run)", "OAuth App client ID (via Secret Manager)"],
        ["GITHUB_CLIENT_SECRET", "Backend (Cloud Run)", "OAuth App client secret (via Secret Manager)"],
        ["FETCH_LIMIT", "Backend (Cloud Run)", "Max users per job (0 = unlimited)"],
        ["REPO_PEOPLE_DB", "Backend (Cloud Run)", "SQLite DB path (default: /tmp/repo_people_jobs.db)"],
    ]
    pdf.table(
        ["Variable", "Scope", "Purpose"],
        env_rows,
        [52, 42, 96],
    )

    # ── Testing ──────────────────────────────────────────────────────────────
    pdf.section_title("Testing", GREEN)
    test_rows = [
        ["Vitest", "Frontend", "Unit and component test runner (Vite-native)"],
        ["@testing-library/react", "Frontend", "DOM rendering and user-event simulation"],
        ["vitest-fetch-mock", "Frontend", "Mock fetch() calls in test suite"],
        ["pytest", "Backend", "Python test runner for API integration tests"],
        ["httpx (test client)", "Backend", "Async HTTP client used in pytest fixtures"],
        ["GitHub Actions", "CI", "Runs full frontend + backend test suite on every PR"],
    ]
    pdf.table(
        ["Tool", "Layer", "Purpose"],
        test_rows,
        [50, 32, 108],
    )

    pdf.output(OUTPUT)
    print(f"PDF written to: {OUTPUT}")


if __name__ == "__main__":
    build()
