# Cloud Run & Cloud Build Deployment Guide

How to deploy the `repo-people-app` backend to Google Cloud Run using Cloud Build for CI/CD.

---

## Prerequisites

- [gcloud CLI](https://cloud.google.com/sdk/docs/install) installed and authenticated (`gcloud auth login`)
- A Google Cloud project with billing enabled
- Docker installed locally (for manual builds only)
- Your GitHub repository connected to Cloud Build

---

## Key Files

| File | Purpose |
|---|---|
| `Dockerfile.cloudrun` | Production Docker image for Cloud Run |
| `Dockerfile` | Root-level alias used by Cloud Build default config |
| `backend/requirements.cloudrun.txt` | Python dependencies for Cloud Run (no local file references) |
| `cloudbuild.yaml` | Cloud Build pipeline: build → push → deploy |
| `cloudrun-service.yaml` | Declarative Cloud Run service definition (optional manual deploys) |

---

## One-Time GCP Setup

### 1. Enable required APIs

```bash
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  --project=YOUR_PROJECT_ID
```

### 2. Create an Artifact Registry repository

**What is Artifact Registry?**

Artifact Registry is Google Cloud's private storage for Docker images (and other build artifacts). When Cloud Build creates your container image, it needs a place to store it. Cloud Run then pulls that image from Artifact Registry to run your backend.

The deployment flow is:
```
GitHub push → Cloud Build → builds image → pushes to Artifact Registry → Cloud Run pulls image → deploys
```

Your image will be stored at:
```
europe-west1-docker.pkg.dev/YOUR_PROJECT_ID/repo-people/backend:latest
```

**Create via gcloud CLI:**

```bash
gcloud artifacts repositories create repo-people \
  --repository-format=docker \
  --location=europe-west1 \
  --project=YOUR_PROJECT_ID
```

**Alternative: Create via GCP Console (if gcloud is not installed):**

1. Go to **GCP Console → Artifact Registry → Repositories**
2. Click **Create Repository**
3. Configure:
   - **Name**: `repo-people`
   - **Format**: Docker
   - **Mode**: Standard
   - **Location type**: Region
   - **Region**: `europe-west1`
4. Click **Create**

### 3. Grant Cloud Build permissions to deploy Cloud Run

Cloud Build runs as a service account that needs explicit roles to deploy to Cloud Run.

```bash
PROJECT_NUMBER=$(gcloud projects describe YOUR_PROJECT_ID --format='value(projectNumber)')
CB_SA="$PROJECT_NUMBER@cloudbuild.gserviceaccount.com"

# Allow Cloud Build to deploy Cloud Run services
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="serviceAccount:$CB_SA" \
  --role="roles/run.admin"

# Allow Cloud Build to act as the default compute service account (required for deploy)
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="serviceAccount:$CB_SA" \
  --role="roles/iam.serviceAccountUser"

# Allow Cloud Build to push images to Artifact Registry
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="serviceAccount:$CB_SA" \
  --role="roles/artifactregistry.writer"
```

### 4. Set up Secret Manager

Secret Manager securely stores sensitive values like OAuth credentials. The detailed setup is covered in the **GitHub OAuth App Setup** section below, but you need to enable the API first:

```bash
gcloud services enable secretmanager.googleapis.com --project=YOUR_PROJECT_ID
```

After creating your GitHub OAuth App, return to the OAuth section for step-by-step instructions on storing credentials in Secret Manager.

---

## Cloud Build Configuration

The `cloudbuild.yaml` at the repo root defines three steps: build the image, push it to Artifact Registry, and deploy it to Cloud Run.

```yaml
steps:
  - name: gcr.io/cloud-builders/docker
    id: Build
    args:
      - build
      - -f
      - Dockerfile.cloudrun
      - -t
      - ${_REGION}-docker.pkg.dev/$PROJECT_ID/${_AR_REPO}/backend:latest
      - .

  - name: gcr.io/cloud-builders/docker
    id: Push
    args:
      - push
      - ${_REGION}-docker.pkg.dev/$PROJECT_ID/${_AR_REPO}/backend:latest

  - name: gcr.io/google.com/cloudsdktool/cloud-sdk:slim
    id: Deploy
    entrypoint: gcloud
    args:
      - run
      - deploy
      - ${_SERVICE_NAME}
      - --image=${_REGION}-docker.pkg.dev/$PROJECT_ID/${_AR_REPO}/backend:latest
      - --region=${_REGION}
      - --platform=managed
      - --allow-unauthenticated
      - --max-instances=1
      - --min-instances=0
      - --timeout=3600

substitutions:
  _REGION: europe-west1
  _AR_REPO: repo-people
  _SERVICE_NAME: repo-people-app

options:
  logging: CLOUD_LOGGING_ONLY

images:
  - ${_REGION}-docker.pkg.dev/$PROJECT_ID/${_AR_REPO}/backend:latest
```

> **Important:** `$PROJECT_ID` is a Cloud Build built-in variable — it is resolved automatically from the GCP project context. Never hardcode it in the `substitutions` block.

---

## Creating the Cloud Build Trigger

1. Go to **Cloud Build → Triggers → Create trigger**
2. Configure:
   - **Name**: `repo-people-app-deploy`
   - **Event**: Push to branch
   - **Branch**: `^main$`
   - **Repository**: `amckenna41/repo-people-app`
   - **Build configuration**: Cloud Build configuration file (yaml)
   - **File location**: `cloudbuild.yaml`
3. Under **Substitution variables**, add:

   | Variable | Value |
   |---|---|
   | `_REGION` | `europe-west1` |
   | `_AR_REPO` | `repo-people` |
   | `_SERVICE_NAME` | `repo-people-app` |

4. Save. Every push to `main` will now build, push, and deploy automatically.

---

## Cloud Run Environment Variables

Set these on the Cloud Run service after first deploy (Cloud Console → Cloud Run → Service → Edit & Deploy → Variables):

| Variable | Value |
|---|---|
| `BACKEND_URL` | Your Cloud Run service URL (e.g. `https://repo-people-app-xxxxx-ew.a.run.app`) |
| `FRONTEND_URL` | Your Vercel frontend URL (e.g. `https://repo-people.vercel.app`) |
| `CORS_ORIGINS` | Same as `FRONTEND_URL` |
| `REPO_PEOPLE_DB` | `/tmp/repo_people_jobs.db` (SQLite database path for Cloud Run) |
| `GITHUB_CLIENT_ID` | Set via Secret Manager (see GitHub OAuth App Setup section) |
| `GITHUB_CLIENT_SECRET` | Set via Secret Manager (see GitHub OAuth App Setup section) |

> **Note:** OAuth credentials should be stored in Secret Manager, not as plain environment variables. See the **GitHub OAuth App Setup** section below for detailed instructions.

---

## GitHub OAuth App Setup

### Creating the OAuth Application

1. Go to **GitHub → Settings → Developer settings → OAuth Apps → New OAuth App**
2. Fill in the registration form:

   **Application name** (required)
   ```
   Repo People App
   ```
   Any name users will recognize when authorizing.

   **Homepage URL** (required)
   ```
   https://repo-people.vercel.app
   ```
   Your Vercel frontend URL (where users access your app).

   **Application description** (optional)
   ```
   Application for analyzing repository contributors
   ```
   Or leave blank.

   **Authorization callback URL** (required)
   ```
   https://YOUR_CLOUD_RUN_URL/auth/callback
   ```
   Replace `YOUR_CLOUD_RUN_URL` with your actual Cloud Run service URL (e.g., `repo-people-app-xxxxx-ew.a.run.app`).

   > **Important:** The callback URL MUST point to your **backend** (Cloud Run), not your frontend (Vercel). This is where GitHub sends the authorization code after the user approves.

3. **Enable Device Flow**: Leave unchecked (unless you need CLI/desktop app authentication)

4. Click **Register application**

5. After registration, you'll see your **Client ID** on the app page

6. Click **Generate a new client secret** to get your **Client Secret**

   > ⚠️ **Copy the secret immediately** — GitHub only shows it once!

### Finding Your Cloud Run URL

If you've already deployed once:

**Via GCP Console:**
- Go to **Cloud Run → repo-people-app**
- Copy the URL shown at the top (e.g., `https://repo-people-app-xxxxx-ew.a.run.app`)

**Via gcloud:**
```bash
gcloud run services describe repo-people-app \
  --region=europe-west1 \
  --format='value(status.url)'
```

If you haven't deployed yet, do a first deploy, then come back and update the OAuth callback URL.

### Storing Credentials in Secret Manager

Never hardcode OAuth secrets in environment variables or config files. Use Google Cloud Secret Manager.

#### Step 1: Create Secrets

**Via GCP Console:**

1. Go to **GCP Console → Security → Secret Manager**
2. Click **Create Secret**
3. For the Client ID:
   - **Name**: `github-client-id`
   - **Secret value**: Paste your GitHub Client ID
   - Click **Create Secret**
4. Repeat for Client Secret:
   - **Name**: `github-client-secret`
   - **Secret value**: Paste your GitHub Client Secret
   - Click **Create Secret**

**Via gcloud:**
```bash
echo -n "your_client_id_here" | gcloud secrets create github-client-id \
  --data-file=- \
  --replication-policy="automatic" \
  --project=YOUR_PROJECT_ID

echo -n "your_client_secret_here" | gcloud secrets create github-client-secret \
  --data-file=- \
  --replication-policy="automatic" \
  --project=YOUR_PROJECT_ID
```

#### Step 2: Grant Cloud Run Access to Secrets

The Cloud Run runtime service account needs permission to read these secrets.

**Via GCP Console:**

1. In Secret Manager, click on **github-client-id**
2. Go to **Permissions** tab
3. Click **Grant Access**
4. Add principal: `YOUR_PROJECT_NUMBER-compute@developer.gserviceaccount.com`
5. Role: **Secret Manager Secret Accessor**
6. Click **Save**
7. Repeat steps 1-6 for **github-client-secret**

**Via gcloud:**
```bash
PROJECT_NUMBER=$(gcloud projects describe YOUR_PROJECT_ID --format='value(projectNumber)')
RUNTIME_SA="$PROJECT_NUMBER-compute@developer.gserviceaccount.com"

gcloud secrets add-iam-policy-binding github-client-id \
  --member="serviceAccount:$RUNTIME_SA" \
  --role="roles/secretmanager.secretAccessor" \
  --project=YOUR_PROJECT_ID

gcloud secrets add-iam-policy-binding github-client-secret \
  --member="serviceAccount:$RUNTIME_SA" \
  --role="roles/secretmanager.secretAccessor" \
  --project=YOUR_PROJECT_ID
```

#### Step 3: Configure Cloud Run to Use Secrets

**Via GCP Console:**

1. Go to **Cloud Run → repo-people-app**
2. Click **Edit & Deploy New Revision**
3. Go to **Variables & Secrets** tab
4. Under **Secrets**, click **Reference a Secret**
5. Add `GITHUB_CLIENT_ID`:
   - **Secret**: `github-client-id`
   - **Reference Method**: Exposed as environment variable
   - **Environment variable name**: `GITHUB_CLIENT_ID`
   - **Version**: `latest`
6. Click **Done**
7. Add `GITHUB_CLIENT_SECRET`:
   - **Secret**: `github-client-secret`
   - **Reference Method**: Exposed as environment variable
   - **Environment variable name**: `GITHUB_CLIENT_SECRET`
   - **Version**: `latest`
8. Click **Done**, then **Deploy**

**Via cloudbuild.yaml (automated):**

Add the `--set-secrets` flag to your deploy step in `cloudbuild.yaml`:

```yaml
- name: gcr.io/google.com/cloudsdktool/cloud-sdk:slim
  id: Deploy
  entrypoint: gcloud
  args:
    - run
    - deploy
    - ${_SERVICE_NAME}
    - --image=${_REGION}-docker.pkg.dev/$PROJECT_ID/${_AR_REPO}/backend:latest
    - --region=${_REGION}
    - --platform=managed
    - --allow-unauthenticated
    - --max-instances=1
    - --min-instances=0
    - --timeout=3600
    - --set-secrets=GITHUB_CLIENT_ID=github-client-id:latest,GITHUB_CLIENT_SECRET=github-client-secret:latest
```

> **Note:** Secrets are securely referenced, not stored directly as environment variables. Use `latest` version to always pull the current secret value.

### Adding Credentials to Vercel (Frontend)

Your frontend also needs the OAuth Client ID to initiate the login flow.

1. Go to **Vercel → Your Project → Settings → Environment Variables**
2. Add these variables for **all environments** (Production, Preview, Development):

   | Name | Value |
   |---|---|
   | `GITHUB_CLIENT_ID` | Your GitHub OAuth App Client ID |
   | `GITHUB_CLIENT_SECRET` | Your GitHub OAuth App Client Secret |

3. Click **Save**
4. Redeploy your frontend for changes to take effect

> **Security Note:** While the Client ID is public (sent to browsers), the Client Secret should be kept private. In this architecture, the frontend only uses the Client ID for UI, while the backend handles the secret securely.

---

## Manual Build & Deploy (Without CI/CD)

```bash
# Authenticate Docker with Artifact Registry
gcloud auth configure-docker europe-west1-docker.pkg.dev

# Build and push
docker build -f Dockerfile.cloudrun \
  -t europe-west1-docker.pkg.dev/YOUR_PROJECT_ID/repo-people/backend:latest .
docker push europe-west1-docker.pkg.dev/YOUR_PROJECT_ID/repo-people/backend:latest

# Deploy to Cloud Run
gcloud run deploy repo-people-app \
  --image=europe-west1-docker.pkg.dev/YOUR_PROJECT_ID/repo-people/backend:latest \
  --region=europe-west1 \
  --platform=managed \
  --allow-unauthenticated \
  --max-instances=1 \
  --timeout=3600
```

Or trigger Cloud Build manually:

```bash
gcloud builds submit --config=cloudbuild.yaml \
  --substitutions=_REGION=europe-west1,_AR_REPO=repo-people,_SERVICE_NAME=repo-people-app
```

---

## Common Issues & Troubleshooting

### ❌ `lstat /workspace/Dockerfile: no such file or directory`

**Cause:** Cloud Build trigger is set to Dockerfile build type and is looking for a file named `Dockerfile` at the repo root, but this project uses `Dockerfile.cloudrun`.

**Fix (Option A — recommended):** Change trigger to use **Cloud Build configuration file** and point to `cloudbuild.yaml`. The yaml explicitly passes `-f Dockerfile.cloudrun`.

**Fix (Option B):** In the trigger's Dockerfile field, change `Dockerfile` to `Dockerfile.cloudrun`.

---

### ❌ `fatal: could not read Username for 'https://github.com'` during pip install

**Cause:** `requirements.cloudrun.txt` or `Dockerfile.cloudrun` was installing a package directly from a private or unauthenticated GitHub URL (e.g. `repo-people @ git+https://github.com/...`). Cloud Build runs non-interactively and cannot authenticate.

**Fix:** Install from PyPI instead. Add the package to `backend/requirements.cloudrun.txt` with a version specifier:
```
repo-people>=1.0.0
```
Remove any `RUN pip install ... git+https://github.com/...` lines from the Dockerfile.

---

### ❌ `ModuleNotFoundError: No module named 'httpx'` (container fails to start)

**Cause:** A package imported in `main.py` was missing from `backend/requirements.cloudrun.txt`. The dev `requirements.txt` had it but the Cloud Run-specific file did not.

**Fix:** Ensure `requirements.cloudrun.txt` is a complete list of all runtime imports. Compare against `requirements.txt` and add any missing packages:
```
httpx>=0.27.0
```

**Tip:** Add an import smoke test to the Dockerfile so the build fails early rather than at runtime:
```dockerfile
RUN pip install --no-cache-dir -r requirements.txt \
  && python -c "import fastapi, uvicorn, httpx, sse_starlette, aiosqlite"
```

---

### ❌ Container failed to start and listen on PORT=8080

**Cause:** The container is crashing before binding to the port. This is usually a Python import error (missing dependency) or a misconfigured startup command.

**Fix:** Check the Cloud Run logs immediately after the failed deployment:
- Go to Cloud Run → Service → Logs tab
- Look for `Traceback` or `ModuleNotFoundError` lines
- The real error is always in the logs; the "failed to start" message is generic

---

### ❌ `invalid image name ".../$PROJECT_ID/...": could not parse reference`

**Cause:** `$PROJECT_ID` was used inside the `substitutions:` block of `cloudbuild.yaml`. Cloud Build only resolves `$PROJECT_ID` inside step `args`, not in substitution values.

**Fix:** Never use `$PROJECT_ID` in the `substitutions:` block. Use it directly in step `args`:
```yaml
args:
  - ${_REGION}-docker.pkg.dev/$PROJECT_ID/${_AR_REPO}/backend:latest
```

---

### ❌ `if 'build.service_account' is specified, the build must specify 'build.logs_bucket'`

**Cause:** A custom service account was specified on the trigger without a logs bucket.

**Fix:** Add `logging: CLOUD_LOGGING_ONLY` to the `options` block in `cloudbuild.yaml`:
```yaml
options:
  logging: CLOUD_LOGGING_ONLY
```

---

### ❌ Two Cloud Run services created on every push (e.g. `repo-people` and `repo-people-app`)

**Cause:** Multiple Cloud Build triggers pointing to the same repository, each deploying to a different hardcoded service name. This typically happens when you connect a repo via the GCP Console multiple times, which auto-creates inline triggers.

**Fix:**
1. Go to Cloud Build → Triggers
2. Delete all auto-generated inline triggers for the repository
3. Keep only one manually created trigger that uses `cloudbuild.yaml`
4. Delete the unwanted duplicate Cloud Run service from Cloud Run → Services

---

### ❌ `name unknown: Repository "repo-people" not found` during push

**Cause:** The Artifact Registry repository doesn't exist yet in your GCP project. Cloud Build successfully built the image but has nowhere to push it.

**Fix:** Create the repository once (see step 2 in One-Time GCP Setup above):

```bash
gcloud artifacts repositories create repo-people \
  --repository-format=docker \
  --location=europe-west1 \
  --project=YOUR_PROJECT_ID
```

Or create it via the GCP Console: **Artifact Registry → Repositories → Create Repository**.

Once created, re-run the Cloud Build trigger. The push step will succeed.

---

### ❌ Vercel frontend build fails with `Cannot find module 'vitest'`

**Cause:** The frontend `tsconfig.json` included `../tests/frontend` which caused Vercel's production `tsc` build to type-check test files. Vitest and testing library packages are devDependencies not available in production builds.

**Fix:** Remove test directories from the main `tsconfig.json`:
```json
"include": ["src"]
```
Create a separate `tsconfig.test.json` for IDE/test support:
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "types": ["vite/client", "vitest/globals"] },
  "include": ["src", "../tests/frontend"]
}
```

---

## Vercel Frontend Environment Variables

| Variable | Value |
|---|---|
| `VITE_API_BASE_URL` | Your Cloud Run backend URL (e.g. `https://repo-people-app-xxxxx-ew.a.run.app`) |

Set this in Vercel Project Settings → Environment Variables, then redeploy.

Why this matters:
- The frontend calls OAuth endpoints using `${VITE_API_BASE_URL}/auth/*`.
- If `VITE_API_BASE_URL` is empty in production, OAuth calls go to the Vercel frontend domain and can return `404 NOT_FOUND`.

Optional alternative:
- You can proxy `/auth/*` through Vercel via `vercel.json`, but then all API routes must be consistently proxied. The default recommended setup is direct frontend → Cloud Run using `VITE_API_BASE_URL`.
