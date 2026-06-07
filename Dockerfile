# Cloud Build / Cloud Run Dockerfile
# Build context: repo root

FROM python:3.11-slim

WORKDIR /app

# System deps (needed by some transitive packages)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
  && rm -rf /var/lib/apt/lists/*

# Install backend Python dependencies (including repo-people from PyPI)
COPY backend/requirements.cloudrun.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt \
  && python -c "import fastapi, uvicorn, httpx, sse_starlette, aiosqlite"

# Copy backend source
COPY backend/ /app/

# SQLite DB location for Cloud Run instances
ENV REPO_PEOPLE_DB=/tmp/repo_people_jobs.db

# Cloud Run expects the container to listen on $PORT
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8080}"]
