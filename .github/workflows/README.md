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

4. **Create a JSON key** for that service account (this is the value for the `GCP_SA_KEY` secret):
   ```bash
   gcloud iam service-accounts keys create key.json --iam-account="$SA"
   ```

5. **Add the GitHub secrets** (repo → Settings → Secrets and variables → Actions):

   | Secret | Required | Value |
   |---|---|---|
   | `GCP_SA_KEY` | yes | Full contents of `key.json` from step 4 |
   | `GCP_PROJECT_ID` | yes | Your GCP Project ID |
   | `CORS_ORIGINS` | no | Allowed frontend origin(s). Defaults to `https://repo-people.vercel.app` |

   Delete the local `key.json` once it's stored (`rm key.json`).

6. **Run it:** GitHub → Actions → **Deploy — Cloud Run (backend)** → **Run workflow**. Optional inputs:
   - `region` – GCP region (default `europe-west1`)
   - `service` – Cloud Run service name (default `repo-people-app`)
   - `image_tag` – image tag (blank uses the git SHA)

   The deployed service URL is printed in the run's job summary.