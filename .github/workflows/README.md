# Workflows used in repo-people-app

* `build_test.yml` - build and test the repo-people application, running all unit tests.
* `deploy_cloud_run.yml` - build the backend image and deploy it to GCP Cloud Run (manual `workflow_dispatch`).

## GCP Cloud Run Setup

Step-by-step to set up and run `deploy_cloud_run.yml`. Do steps 1–5 once; step 6 is how you run it.

1. **Pick/create a GCP project** and note its Project ID:
   ```bash
   gcloud projects list
   ```

2. **Enable the required APIs:**
   ```bash
   gcloud services enable run.googleapis.com artifactregistry.googleapis.com --project=PROJECT_ID
   ```
   (The workflow auto-creates the `repo-people` Artifact Registry repo on first run, so you don't need to create it manually.)

3. **Create a service account** for the workflow and grant it the roles it needs:
   ```bash
   gcloud iam service-accounts create gh-deployer \
     --display-name="GitHub Actions deployer" --project=PROJECT_ID

   SA="gh-deployer@PROJECT_ID.iam.gserviceaccount.com"
   for ROLE in roles/run.admin roles/artifactregistry.admin roles/iam.serviceAccountUser; do
     gcloud projects add-iam-policy-binding PROJECT_ID --member="serviceAccount:$SA" --role="$ROLE"
   done
   ```

4. **Set up Workload Identity Federation** so GitHub Actions authenticates with short-lived tokens instead of a downloaded key. Run once, replacing `OWNER/repo-people-app` with your repo:
   ```bash
   REPO="OWNER/repo-people-app"
   PROJECT_NUM=$(gcloud projects describe PROJECT_ID --format='value(projectNumber)')

   # Pool + GitHub OIDC provider, locked to your repository
   gcloud iam workload-identity-pools create github \
     --location=global --project=PROJECT_ID

   gcloud iam workload-identity-pools providers create-oidc repo-people \
     --location=global --project=PROJECT_ID \
     --workload-identity-pool=github \
     --issuer-uri="https://token.actions.githubusercontent.com" \
     --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
     --attribute-condition="assertion.repository=='${REPO}'"

   # Let only this repo impersonate the deployer SA
   gcloud iam service-accounts add-iam-policy-binding "$SA" \
     --project=PROJECT_ID \
     --role=roles/iam.workloadIdentityUser \
     --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUM}/locations/global/workloadIdentityPools/github/attribute.repository/${REPO}"

   # The full provider resource name — value for the GCP_WIF_PROVIDER secret
   echo "projects/${PROJECT_NUM}/locations/global/workloadIdentityPools/github/providers/repo-people"
   ```
   The `attribute-condition` pinning to your repo is what stops any other GitHub repo from impersonating the SA — don't omit it.

5. **Add the GitHub secrets** (repo → Settings → Secrets and variables → Actions):

   | Secret | Required | Value |
   |---|---|---|
   | `GCP_WIF_PROVIDER` | yes | Provider resource name printed at the end of step 4 |
   | `GCP_DEPLOY_SA` | yes | `gh-deployer@PROJECT_ID.iam.gserviceaccount.com` |
   | `GCP_PROJECT_ID` | yes | Your GCP Project ID |
   | `CORS_ORIGINS` | no | Allowed frontend origin(s). Defaults to `https://repo-people.vercel.app` |

   No key file to store or delete — the workflow already requests `id-token: write` and mints a short-lived token per run.

6. **Run it:** GitHub → Actions → **Deploy — Cloud Run (backend)** → **Run workflow**. Optional inputs:
   - `region` – GCP region (default `europe-west1`)
   - `service` – Cloud Run service name (default `repo-people-app`)
   - `image_tag` – image tag (blank uses the git SHA)

   The deployed service URL is printed in the run's job summary.