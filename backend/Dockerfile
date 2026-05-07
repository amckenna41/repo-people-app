FROM python:3.11-slim

WORKDIR /workspace

# Install repo-people package from parent directory
COPY ../pyproject.toml ../README.md /workspace/pkg/
COPY ../repo_people /workspace/pkg/repo_people/
RUN pip install --no-cache-dir /workspace/pkg

# Install backend dependencies
COPY backend/requirements.txt /workspace/backend/requirements.txt
RUN pip install --no-cache-dir -r /workspace/backend/requirements.txt

COPY backend/ /workspace/backend/

WORKDIR /workspace/backend
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]
