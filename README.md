# NAS MRO Intelligence

A single-user operating intelligence app for daily or weekly MRO work-order snapshots. It turns a changing Google Sheet or a sequence of XLSX/CSV exports into a durable WO lifecycle, deterministic production analytics, forecast ranges, executive summaries, and grounded Gemini chat.

## What changed from the AI Studio prototype

- Gemini runs only on the Node server. `GEMINI_API_KEY` is never bundled into browser JavaScript.
- PostgreSQL stores snapshots, visible WO state, lifecycle events, canonical induction dates, and saved summaries.
- WO # is the stable identity. A missing row is not treated as closed work.
- Live Google Sheet sync and multi-file XLSX/CSV upload use one normalization and validation pipeline.
- The dashboard focuses on management decisions: aging, step pressure, part bottlenecks, department load, customer taper signals, and completion forecasts.
- Chat receives a bounded, deterministic analytical context plus relevant visible WOs. Data cells are treated as untrusted observations, not prompt instructions.
- The single-user owner gate uses a server-side access key and signed, HTTP-only cookie.

Detailed assumptions are in [docs/DATA_MODEL.md](docs/DATA_MODEL.md).

## Local setup

Prerequisites: Node.js 22+, Docker, and Docker Compose.

1. Copy `.env.example` to `.env`.
2. Generate long random values for `OWNER_ACCESS_KEY`, `SESSION_SECRET`, and `INGEST_TOKEN`. Add a Gemini key only to `GEMINI_API_KEY`.
3. Start PostgreSQL:

   ```bash
   docker compose up -d postgres
   ```

4. Install and run:

   ```bash
   npm install
   npm run dev
   ```

5. Open `http://localhost:8080`. Ingest the live Sheet, or select multiple dated workbooks. Selected files are sorted by filename before ingestion, so ISO-dated names load oldest first.

Historical files must be loaded oldest-to-newest. The server rejects an older snapshot after a newer one rather than silently deriving reverse lifecycle transitions. For initial setup with the supplied history, select all historical files first and sync the live Sheet last.

The database schema is created automatically and uses idempotent `CREATE TABLE IF NOT EXISTS` migrations.

## Required spreadsheet columns

Only a WO number is mandatory. The engine recognizes common aliases for these fields:

`Number`, `Date`, `EDD`, `P/N`, `Description`, `S/N`, `Customer RO#`, `Status`, `Step`, `Customer`, `Shop`, `Total Price`, `Days in Step`, `Days in Shop`, `Quoted Date`, `Approved Date`, `Sales Person`, `Closed Date`, `Tags`.

Additional columns can be added to the source without breaking ingestion. To analyze a new field, add it to `server/types.ts`, `server/normalize.ts`, and `work_order_states` in `server/database.ts`.

## Google Cloud deployment

Recommended production components:

- Cloud Run for the app;
- Cloud SQL for PostgreSQL for durable history;
- Secret Manager for DB password, Gemini key, owner key, session secret, and ingest token;
- Cloud Scheduler for daily Sheet ingestion.

### 1. Create Cloud SQL

Create a PostgreSQL instance in the same region as Cloud Run, then create a database and user. Record the instance connection name in `PROJECT:REGION:INSTANCE` form. The Cloud Run service account needs the Cloud SQL Client role.

### 2. Store secrets

Create Secret Manager secrets for:

- `nas-mro-db-pass`
- `nas-mro-gemini-key`
- `nas-mro-owner-key`
- `nas-mro-session-secret`
- `nas-mro-ingest-token`

Do not put the values in this repository or in build arguments.

### 3. Deploy from this directory

Replace the uppercase placeholders:

```bash
gcloud run deploy nas-mro-intelligence \
  --source . \
  --region REGION \
  --allow-unauthenticated \
  --add-cloudsql-instances PROJECT:REGION:INSTANCE \
  --set-env-vars DB_USER=mro_app,DB_NAME=mro_intelligence,INSTANCE_UNIX_SOCKET=/cloudsql/PROJECT:REGION:INSTANCE,GOOGLE_SHEET_CSV_URL=SHEET_CSV_URL \
  --set-secrets DB_PASS=nas-mro-db-pass:latest,GEMINI_API_KEY=nas-mro-gemini-key:latest,OWNER_ACCESS_KEY=nas-mro-owner-key:latest,SESSION_SECRET=nas-mro-session-secret:latest,INGEST_TOKEN=nas-mro-ingest-token:latest
```

The service is reachable for the login page, but all data, chat, summaries, and manual ingestion endpoints require the signed owner session. The scheduled endpoint additionally accepts the private ingest token.

### 4. Schedule the Sheet sync

Create a daily HTTP POST job targeting:

`https://YOUR_CLOUD_RUN_URL/api/ingest/google-sheet`

Send the header `x-ingest-token: YOUR_INGEST_TOKEN`. The endpoint ingests the Sheet and saves a daily Gemini summary. To skip summary generation, append `?summary=false`.

## Commands

```bash
npm run dev      # Express + Vite development server
npm run lint     # browser TypeScript validation
npm test         # normalization, event, and analytics tests
npm run build    # production UI and server build
npm start        # run the compiled production server
```

## Operational limitations

- Historical accuracy begins with the snapshots you retain. The engine cannot reconstruct step dates that were never captured.
- Step bottlenecks are inferred from visible queue size and `Days in Step`; causal diagnosis needs capacity, staffing, machine downtime, rework, or hold-reason columns.
- Production forecasts are cohort baselines. A later phase should evaluate backtests and calibration before management treats them as commitments.
- Customer taper logic detects changed induction volume. It cannot distinguish lost demand from seasonality, contract timing, or export-scope changes without more history and commercial context.
- `Total Price` is presented as quoted value, not recognized revenue. Profit and margin are intentionally absent because reliable total cost is not in the current source.
- The current app supports one owner. If more users are added, replace the owner access key with Google Identity/IAP and role-based authorization.
