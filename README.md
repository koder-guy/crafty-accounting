# Crafty Accounting

Self-hosted bookkeeping for a UK sole trader, built for selling at craft fairs and filing Self Assessment on the cash basis. Records are structured to match HMRC's Making Tax Digital (MTD) Self-Employment API, so submitting through MTD can be added later without restructuring the data.

- **Tax years**: create, switch and delete UK tax years (6 April to 5 April).
- **Incoming**: sales with a category, payment method (cash, card or bank transfer) and an optional attached PDF or image.
- **Outgoing**: purchases with invoice line items. Each line has a category and can be marked disallowable, and the line items must add up to the transaction amount.
- **Lists**: search, filter and sort, then export the filtered rows to CSV.
- **Dashboard**: totals, a monthly chart, a breakdown by HMRC category, and key dates.
- **MTD Quarterly**: the four standard update periods for each tax year, with deadlines and status. It shows each quarter's figures and the year-to-date figures per MTD field, can export the figures as a JSON file for MTD bridging software, and records when each quarter was submitted.
- **Year-end Summary**: the figures for each box of the Self Assessment self-employment (short) pages (SA103S), on the cash basis, with net profit or loss, a list of disallowable amounts left off the form, and a trading allowance comparison. Print it or save it as a PDF from the page.
  - **Note:** the dashboard's net profit counts business entertaining and depreciation as ordinary expenses, while the Year-end Summary leaves them out because HMRC never allows them. The two figures only differ if you record expenses in either of those categories; use the Year-end Summary figure for your return.
- **Custom categories** (Settings): your own category names, such as "Printer filament", each mapped to a standard MTD category. They're grouped under that category in every dropdown and count towards its MTD figures. Deleting a category that's in use moves its transactions to the MTD category it maps to, so MTD totals don't change.
- **Backups** (Settings): download a `.sql` dump or a full `.zip` (database plus documents), and restore from either.
- **Sign-in**: a single password.

## Run with Docker Compose

On the Linux host:

```bash
cp .env.example .env
```

Edit `.env` and set `ADMIN_PASSWORD` (and ideally `SESSION_SECRET`, made with `openssl rand -hex 32`). Then:

```bash
docker compose up -d --build
```

The app is at `http://<host>:8080`. To use a different port, set `HOST_PORT` in `.env` or in the shell.

All data lives in the `crafty-data` Docker volume, mounted at `/data`:

| Path | Contents |
|---|---|
| `/data/crafty.db` | SQLite database |
| `/data/uploads/` | Attached documents, stored under their original filenames |
| `/data/crafty.pre-restore.db` | The database as it was before the last restore |

To update to a new version, pull or copy the new code and run `docker compose up -d --build` again. Database migrations run automatically on start.

### Behind a reverse proxy (HTTPS)

Set `TRUST_PROXY=true` and `COOKIE_SECURE=true` in `.env` so the session cookie is only sent over HTTPS and sign-in rate limiting sees real client addresses.

### Sample data for testing

To fill an empty install with realistic test data, run:

```bash
docker compose exec crafty-accounting node server/dist/seed.js
```

It loads last tax year in full and this tax year up to today, with craft fair takings, Etsy payouts, purchases with line items (some disallowable), a few custom categories, sample PDF attachments and recorded MTD submissions for past quarters.

It refuses to run if any tax years already exist. Adding `--reset` first **deletes all tax years, transactions and documents**, then loads the sample data. Don't use it on real books.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `ADMIN_PASSWORD` | *(required)* | Sign-in password |
| `SESSION_SECRET` | generated | Signs the session cookie. If empty, one is generated and kept in the data folder. |
| `PORT` | `3000` | Port inside the container |
| `HOST_PORT` | `8080` | Port published by Docker Compose |
| `MAX_UPLOAD_MB` | `20` | Largest document you can attach |
| `COOKIE_SECURE` | `false` | `true` when served over HTTPS |
| `TRUST_PROXY` | `false` | `true` behind a reverse proxy |
| `DATA_DIR` | `./data` (`/data` in Docker) | Database and uploads location |

## Backups

Use **Settings → Backup and restore** in the app:

- **Full backup (.zip)** contains `backup.sql` plus every document in `uploads/`. Restoring it replaces the database and all documents.
- **Database only (.sql)** is a plain-text SQL dump with one statement per line. Restoring it replaces the database and leaves the documents folder alone.

**Start again with an empty database** (also in Backup and restore) deletes all tax years, transactions, documents, custom categories and MTD submission records, after you type `RESET` to confirm. The standard categories and your password stay. The old database is kept as `/data/crafty.pre-reset.db` and the old documents as `/data/uploads.pre-reset/` until the next reset.

Before a restore replaces anything, the file is loaded into a separate database and checked: only `CREATE TABLE`, `CREATE INDEX` and `INSERT` statements are accepted, the expected tables must exist, and foreign-key and integrity checks must pass. Backups from older versions are migrated forward automatically.

For automated off-site copies, you can also back up the Docker volume itself.

## MTD readiness

- Money is stored as integer pence. Dates are ISO `YYYY-MM-DD`. Tax years use MTD's `YYYY-YY` label (shown as `YYYY/YY`).
- Categories map to the MTD `periodIncome` / `periodExpenses` field names (`turnover`, `costOfGoods`, `adminCosts`, …).
- Disallowable line items are included in `periodExpenses` and also reported under `<code>Disallowable`, matching SA103.
- `shared/src/mtd.ts` (`buildMtdPeriodSummary`) already produces MTD-shaped totals for any set of transactions, so a future quarterly or annual submission can reuse it.
- **Quarterly update periods** are the standard tax-year quarters: 6 Apr–5 Jul, 6 Jul–5 Oct, 6 Oct–5 Jan and 6 Jan–5 Apr. Each is due by the 7th of the following month. Updates are cumulative, so the **MTD Quarterly** page defaults to year-to-date figures. Calendar-quarter periods aren't supported.
- **Submitting** directly to HMRC isn't built yet. For now, record each submission's date and reference on the MTD Quarterly page.

## Development

Requires Node 22+.

```bash
npm install
```

```bash
cp .env.example .env
```

```bash
npm run dev
```

The API runs on port 3000 and the Vite client on <http://localhost:5173>, which proxies `/api` to it. If port 3000 is in use, start the server with a different `PORT` and the client with `API_URL=http://localhost:<port>`.

To load sample data into the local database (`server/data`), run the following. Add `-- --reset` to replace existing data.

```bash
npm run seed
```

```bash
npm test
```

```bash
npm run typecheck
```

The project has three parts:

- `shared/`: tax-year and money helpers, categories, zod schemas, MTD aggregation and API types, used by both sides.
- `server/`: Express API, SQLite (better-sqlite3), uploads, CSV export and backup/restore. Tests are in `server/src/app.test.ts`.
- `client/`: React, Vite, Tailwind CSS, TanStack Query and Recharts.
