# Crafty Accounting

Self-hosted bookkeeping for a UK sole trader, built for selling at craft fairs and filing Self Assessment on the cash basis. Records are structured to match HMRC's Making Tax Digital (MTD) Self-Employment API, so submitting through MTD can be added later without restructuring the data.

- **Tax years**: create, switch and delete UK tax years (6 April to 5 April).
- **Incoming**: sales with a category, payment method (cash, card or bank transfer) and an optional attached PDF or image.
- **Outgoing**: purchases with invoice line items. Each line has a category and can be marked disallowable, and the line items must add up to the transaction amount.
- **Lists**: search, filter and sort, then export the filtered rows to CSV.
- **Dashboard**: totals, a monthly chart, a breakdown by HMRC category, and key dates.
- **MTD Quarterly**: the four standard update periods for each tax year, with deadlines and status. It shows each quarter's figures and the year-to-date figures per MTD field, can export the figures as a JSON file for MTD bridging software, and records when each quarter was submitted.
- **Reports → Breakdown**: income and spending for any period (this month, last month, an MTD quarter, a tax year or custom dates, even across tax years). It's broken down by category, with custom categories grouped under their MTD category, and outgoing spending by payee. Click any row to list the transactions or line items behind it. Print or save as PDF.
- **Reports → Year-end Summary**: the figures for each box of the Self Assessment self-employment (short) pages (SA103S), on the cash basis, with net profit or loss, a list of disallowable amounts left off the form, and a trading allowance comparison. Print it or save it as a PDF from the page.
  - **Note:** the dashboard's net profit and the Breakdown report's profit count business entertaining and depreciation as ordinary expenses, while the Year-end Summary leaves them out because HMRC never allows them. They only differ if you record expenses in either of those categories; use the Year-end Summary figure for your return.
- **Custom categories** (Settings): your own category names, such as "Printer filament", each mapped to a standard MTD category. They're grouped under that category in every dropdown and count towards its MTD figures. Deleting a category that's in use moves its transactions to the MTD category it maps to, so MTD totals don't change.
- **Backups** (Settings): download a `.sql` dump or a full `.zip` (database plus documents), and restore from either.
- **Sign-in**: a single password.

## Run with Docker Compose

On the Linux host:

```bash
cp .env.example .env
```

Edit `.env`:

- Set `ADMIN_PASSWORD`, and ideally `SESSION_SECRET` (made with `openssl rand -hex 32`).
- Set `SITE_ADDRESS` to the address(es) you'll use to reach the server, for example `crafty.local, 192.168.1.50`. See **HTTPS** below.

Create the folder for automatic backups and let the container's user (UID 1000) write to it. If you can, point `BACKUP_HOST_DIR` in `.env` at another disk or a NAS share instead of `./backups`:

```bash
mkdir -p ./backups && sudo chown 1000:1000 ./backups
```

Then start it:

```bash
docker compose up -d --build
```

The app is at `https://<SITE_ADDRESS>`, and plain `http://` redirects there. Docker Compose runs two containers:

- `crafty-accounting`: the app. It isn't reachable directly.
- `crafty-caddy`: [Caddy](https://caddyserver.com), which provides HTTPS and passes requests on to the app.

All data lives in the `crafty-data` Docker volume, mounted at `/data`:

| Path | Contents |
|---|---|
| `/data/crafty.db` | SQLite database |
| `/data/uploads/` | Attached documents, stored under their original filenames |
| `/data/crafty.pre-restore.db` | The database as it was before the last restore |

To update to a new version, pull or copy the new code and run `docker compose up -d --build` again. Database migrations run automatically on start.

### HTTPS

All traffic is encrypted. Caddy gets the certificate in one of two ways, chosen by `TLS_ISSUER` in `.env`:

**Home network (`TLS_ISSUER=internal`, the default).** Caddy creates its own private certificate authority and issues certificates for every address in `SITE_ADDRESS`, such as a name like `crafty.local` or the server's IP address. Browsers don't know this authority yet, so each device needs to trust it once:

1. Copy the certificate out of the container, on the server:

   ```bash
   docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./crafty-root.crt
   ```

2. Install `crafty-root.crt` on each device that uses the app:
   - **Mac:** double-click it, add it to the System keychain, then open it in Keychain Access and set **Trust → When using this certificate** to **Always Trust**.
   - **Windows:** double-click it, choose **Install Certificate → Local Machine**, and put it in **Trusted Root Certification Authorities**.
   - **iPhone/iPad:** send it to the device (e.g. by AirDrop or email), install the profile in **Settings → General → VPN & Device Management**, then turn it on in **Settings → General → About → Certificate Trust Settings**.
   - **Android:** **Settings → Security → Encryption & credentials → Install a certificate → CA certificate**. The wording varies by phone.

The authority is valid for 10 years and is kept in the `caddy-data` volume. Caddy renews the site certificates itself. If you remove that volume, a new authority is created and you'll need to trust it again.

**Public domain (`TLS_ISSUER=you@example.com`).** If you reach the app from the internet using your own domain:

1. Point the domain (e.g. `accounts.example.co.uk`) at your home IP.
2. Forward ports 80 and 443 on your router to the server.
3. Set `SITE_ADDRESS` to the domain and `TLS_ISSUER` to your email address.

Caddy then gets a free Let's Encrypt certificate and renews it automatically, and there's nothing to install on your devices. Use a strong `ADMIN_PASSWORD` if the app is reachable from the internet.

If ports 80 and 443 are already used on the server, change `HTTP_PORT` and `HTTPS_PORT`. The address then needs the port, e.g. `https://crafty.local:8443`. Let's Encrypt needs 80 and 443 to be reachable from outside, so for a public domain forward those router ports to whichever ports you've chosen.

After changing these settings, run `docker compose up -d` to apply them.

### Sample data for testing

On a new install with no tax years, the dashboard offers **Load sample data**, which is the quickest way to explore the app. A reminder stays on the dashboard until you clear it with **Settings → Backup and restore → Start again with an empty database**.

You can also load it from the command line:

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
| `SITE_ADDRESS` | `localhost` | Docker: address(es) for HTTPS, comma separated |
| `TLS_ISSUER` | `internal` | Docker: `internal` for a private certificate, or your email address for Let's Encrypt |
| `HTTP_PORT` / `HTTPS_PORT` | `80` / `443` | Docker: ports Caddy listens on |
| `MAX_UPLOAD_MB` | `20` | Largest document you can attach |
| `COOKIE_SECURE` | `false` (`true` in Docker) | Only send the session cookie over HTTPS |
| `TRUST_PROXY` | `false` (`true` in Docker) | Trust the reverse proxy's forwarded headers |
| `DATA_DIR` | `./data` (`/data` in Docker) | Database and uploads location |
| `BACKUP_HOST_DIR` | `./backups` | **With Docker:** the folder on the server where automatic backups appear. This is the one to change. |
| `BACKUP_DIR` | `DATA_DIR/backups` | **Without Docker only:** where automatic backups are written. Ignored in Docker, where Compose fixes it to `/backups` inside the container and connects that to `BACKUP_HOST_DIR`. |
| `TZ` | `Europe/London` | Time zone for the daily backup time |

## Backups

### Automatic backups

Every day at 02:00 (UK time, set by `TZ`), the app writes a full `.zip` backup to the backup folder, `BACKUP_HOST_DIR` on the host (default `./backups`). Days with no changes are skipped, and only the newest 30 are kept. If the app was off at the scheduled time, it catches up when it next starts.

In **Settings → Backup and restore → Automatic backups** you can:

- switch it on or off, and change the time and how many backups to keep
- see the last and next backup
- use **Back up now**
- download recent backups

To restore one, use **Restore from a backup** with the downloaded file. If the folder can't be written to (usually a permissions issue, see above), the page says so.

The backups live outside the Docker volume, so they survive the container or volume being removed. To protect against the server's disk failing, put the folder on a different disk or a NAS, or copy it somewhere else regularly.

### Manual backups and restore

Use **Settings → Backup and restore** in the app:

- **Full backup (.zip)** contains `backup.sql` plus every document in `uploads/`. Restoring it replaces the database and all documents.
- **Database only (.sql)** is a plain-text SQL dump with one statement per line. Restoring it replaces the database and leaves the documents folder alone.

**Start again with an empty database** (also in Backup and restore) deletes all tax years, transactions, documents, custom categories and MTD submission records, after you type `RESET` to confirm. The standard categories and your password stay. The old database is kept as `/data/crafty.pre-reset.db` and the old documents as `/data/uploads.pre-reset/` until the next reset.

Before a restore replaces anything, the file is loaded into a separate database and checked: only `CREATE TABLE`, `CREATE INDEX` and `INSERT` statements are accepted, the expected tables must exist, and foreign-key and integrity checks must pass. Backups from older versions are migrated forward automatically.

You can also back up the Docker volume itself.

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
