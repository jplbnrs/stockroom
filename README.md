# Stockroom

Warehouse stock and movement ledger: FastAPI over plain Postgres with a
static ops-console frontend. Auth is application-level (bcrypt + JWT) —
the database enforces nothing beyond constraints.

## Stack

- FastAPI + psycopg, deployed as a single Vercel Python function
- Vanilla JS dashboard (no framework), served statically
- Postgres: warehouses / skus / stock_levels / movements, a low-stock view,
  an updated_at touch trigger, append-only movement ledger

## Setup

1. Create a Postgres database (Neon works out of the box).
2. Run `db/init.sql` against it — schema plus seed in one paste.
3. Run locally:

   ```sh
   python3 -m venv .venv && source .venv/bin/activate
   pip install -r requirements.txt
   DATABASE_URL=postgresql://localhost/stockroom uvicorn api.index:app --port 8100
   ```

   Open http://localhost:8100 — the dashboard is served by the API in dev.

Demo login: `stockroom+demo@example.com` / `stockroom-demo-1`

## Deploy

Import the repo into Vercel (no framework preset). Set env vars:

- `DATABASE_URL` — the Neon pooled connection string
- `APP_SECRET` — long random string for JWT signing

Vercel's FastAPI runtime routes every request to the app (`pyproject.toml` pins the
entrypoint to `api.index:app`); the app serves `/` and `/assets` itself, which Vercel
promotes to its CDN at build time. No `vercel.json` rewrites — a rewrite hands the
function the destination path and every `/api/*` call 404s.
