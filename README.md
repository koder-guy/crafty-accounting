# Crafty Accounting

Self-hosted bookkeeping for a UK sole trader, built for selling at craft fairs and filing Self Assessment on the cash basis. Records are structured to match HMRC's Making Tax Digital (MTD) Self-Employment API, so submitting through MTD can be added later without restructuring the data.

- **Tax years**: create, switch and delete UK tax years (6 April to 5 April).
- **Incoming**: sales with a category, payment method (cash, card or bank transfer) and up to 10 attached documents (PDFs or images, such as a payout statement).
- **Outgoing**: purchases with invoice line items. Each line has a category and can be marked disallowable, and the line items must add up to the transaction amount. Attach up to 10 documents, such as an invoice and a delivery note.
- **Simplified Expenses → Mileage**: business journeys claimed at HMRC's approved mileage rates (cars and vans 45p a mile for the first 10,000 miles in a tax year and 25p after, motorcycles 24p, bicycles 20p). Claims count as car, van and travel expenses everywhere: the dashboard, MTD figures, Breakdown and SA103S box 12. Export the log to CSV. HMRC doesn't allow the mileage rate and actual running costs (fuel, insurance, repairs) for the same vehicle, so if a tax year has both mileage and outgoing in car, van and travel expenses, the Mileage page and Year-end summary warn you and link to that outgoing to check. Parking, tolls and fares are fine alongside mileage.
- **Simplified Expenses → Use of Home**: HMRC's flat rate for working from home. Enter the hours of business work at home for each month (6th to the 5th, like the tax year) and it claims £10 for 25 to 50 hours, £18 for 51 to 100 and £26 for 101 or more. Claims count as rent, rates, power and insurance costs everywhere: the dashboard, MTD figures, Breakdown and SA103S box 14. The flat rate replaces a share of household bills, so don't claim those as well.
- **Duplicate**: start a new incoming, outgoing or mileage trip from an existing one, for things that repeat like stall fees, subscriptions or the same journey. The copy is dated today and opens in the form to check before adding; references, invoice and order numbers and attached documents aren't copied.
- **Lists**: search, filter and sort, then export the filtered rows to CSV.
- **Dashboard**: totals, a monthly chart, a breakdown by HMRC category, and key dates.
- **MTD Quarterly**: the four standard update periods for each tax year, with deadlines and status. It shows each quarter's figures and the year-to-date figures per MTD field, can export the figures as a JSON file for MTD bridging software, and records when each quarter was submitted. Connected to HMRC, it sends each quarter's update itself (see [Sending quarterly updates](#sending-quarterly-updates)).
- **Reports → Breakdown**: income and spending for any period (this month, last month, an MTD quarter, a tax year or custom dates, even across tax years). It's broken down by category, with custom categories grouped under their MTD category, and outgoing spending by payee. Click any row to list the transactions or line items behind it. Print or save as PDF.
- **Reports → Year-end summary**: the figures for each box of the Self Assessment self-employment (short) pages (SA103S), on the cash basis, with net profit or loss, a list of disallowable amounts left off the form, and a trading allowance comparison. Print it or save it as a PDF from the page.
  - **Note:** the dashboard's net profit and the Breakdown report's profit count business entertaining and depreciation as ordinary expenses, while the Year-end summary leaves them out because HMRC never allows them. They only differ if you record expenses in either of those categories; use the Year-end summary figure for your return.
- **Reports → Tax estimate**: the Income Tax and Class 4 National Insurance on the year's profit so far (using the trading allowance if that's better), how much of your profit to put aside, and when it's due, including payments on account. Add a salary or pension for the year and it works out the extra tax the business causes. Uses the rates for England, Wales and Northern Ireland; rates are in `shared/src/taxEstimate.ts`. The dashboard's Net profit box shows the estimate too.
- **Custom categories** (Settings): your own category names, such as "Printer filament", each mapped to a standard MTD category. They're grouped under that category in every dropdown and count towards its MTD figures. Deleting a category that's in use moves its transactions to the MTD category it maps to, so MTD totals don't change.
- **Backups** (Settings): download a `.sql` dump or a full `.zip` (database plus documents), and restore from either.
- **People** (Settings): each person signs in with their own name and password, and has their own active tax year. Transactions show who added them and who last changed them.
  - **Access**: each person is an **Editor** (can change anything, manage people and settings, and download backups) or **Read-only** (can view everything, download documents, export CSVs and the MTD JSON, and print reports, but can't change the books or download backups). Read-only people can still choose which tax year they're viewing and change their own password. The server enforces this, not just the screens. Everyone set up before this was added is an Editor, and there's always at least one.
- **HMRC** (Settings): your National Insurance number, the connection to HMRC for Making Tax Digital and your self-employment business there. Editors connect by signing in to HMRC, which gives the app authority for 18 months. Once connected, the MTD Quarterly page shows which updates HMRC expects and which it has received. Uses HMRC's sandbox (test service) for now; see [Connecting to HMRC](#connecting-to-hmrc).
- **Working together**: when someone saves a change, every other open browser shows it within a second or so, without reloading. If two people edit the same transaction at once, the second save is refused rather than overwriting the first, and the form offers to load the other person's version. What you've typed in a form is never replaced while you're typing.

## Run with Docker Compose

On the Linux host:

```bash
cp .env.example .env
```

Edit `.env`:

- Set `ADMIN_NAME` and `ADMIN_PASSWORD` for the first person to sign in, and ideally `SESSION_SECRET` (made with `openssl rand -hex 32`). Once someone exists, add other people and change passwords in **Settings → People**; these two variables are then ignored.
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

Upgrading from v1.0.0, which had one shared password: the first time it starts, the app creates a person from `ADMIN_NAME` (`Admin` unless you set it) and your existing `ADMIN_PASSWORD`. Sign in with that name and password, rename yourself in **Settings → People** if you like, and add anyone else there.

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

Caddy then gets a free Let's Encrypt certificate and renews it automatically, and there's nothing to install on your devices. Use strong passwords for everyone if the app is reachable from the internet.

If ports 80 and 443 are already used on the server, change `HTTP_PORT` and `HTTPS_PORT`. The address then needs the port, e.g. `https://crafty.local:8443`. Let's Encrypt needs 80 and 443 to be reachable from outside, so for a public domain forward those router ports to whichever ports you've chosen.

After changing these settings, run `docker compose up -d` to apply them.

### Sample data for testing

On a new install with no tax years, the dashboard offers **Load sample data**, which is the quickest way to explore the app. A reminder stays on the dashboard until you clear it with **Settings → Backup and restore → Start again with an empty database**.

You can also load it from the command line:

```bash
docker compose exec crafty-accounting node server/dist/seed.js
```

It loads last tax year in full and this tax year up to today, with craft fair takings, Etsy payouts, purchases with line items (some disallowable), mileage to each fair, hours worked at home, a few custom categories, sample PDF attachments and recorded MTD submissions for past quarters.

It refuses to run if any tax years already exist. Adding `--reset` first **deletes all tax years, transactions and documents**, then loads the sample data. Don't use it on real books.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `ADMIN_NAME` | `Admin` | Name of the first person, created when nobody has been set up yet |
| `ADMIN_PASSWORD` | *(required at first)* | Password for that first person. Needed only until someone exists; after that people are managed in Settings → People. |
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
| `HMRC_CLIENT_ID` / `HMRC_CLIENT_SECRET` | *(none)* | Your application's credentials from HMRC's Developer Hub. See [Connecting to HMRC](#connecting-to-hmrc). |
| `HMRC_ENV` | `sandbox` | `sandbox` for HMRC's test service, or `production` for the live one |
| `HMRC_REDIRECT_URI` | worked out | Only if Settings → HMRC shows the wrong redirect URI (an unusual proxy setup) |

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

**Start again with an empty database** (also in Backup and restore) deletes all tax years, transactions, documents, custom categories and MTD submission records, after you type `RESET` to confirm. The standard categories, the people who can sign in and the HMRC connection stay. The old database is kept as `/data/crafty.pre-reset.db` and the old documents as `/data/uploads.pre-reset/` until the next reset.

Before a restore replaces anything, the file is loaded into a separate database and checked: only `CREATE TABLE`, `CREATE INDEX` and `INSERT` statements are accepted, the expected tables must exist, and foreign-key and integrity checks must pass. Backups from older versions are migrated forward automatically.

Backups don't include the people who can sign in or their passwords. A restore keeps whoever is set up on this install, so nobody is locked out by restoring an older backup.

You can also back up the Docker volume itself.

## MTD readiness

- Money is stored as integer pence. Dates are ISO `YYYY-MM-DD`. Tax years use MTD's `YYYY-YY` label (shown as `YYYY/YY`).
- Categories map to the MTD `periodIncome` / `periodExpenses` field names (`turnover`, `costOfGoods`, `adminCosts`, …).
- Disallowable line items are included in `periodExpenses` and also reported under `<code>Disallowable`, matching SA103.
- `shared/src/mtd.ts` (`buildMtdPeriodSummary`) already produces MTD-shaped totals for any set of transactions, so a future quarterly or annual submission can reuse it.
- **Quarterly update periods** are the standard tax-year quarters: 6 Apr–5 Jul, 6 Jul–5 Oct, 6 Oct–5 Jan and 6 Jan–5 Apr. Each is due by the 7th of the following month. Updates are cumulative, so the **MTD Quarterly** page defaults to year-to-date figures. Calendar-quarter periods aren't supported.
- **Submitting**: connected to HMRC, the app sends each quarter's update itself (see below). Otherwise export the JSON for bridging software and record each submission's date and reference on the MTD Quarterly page.

### Connecting to HMRC

The app talks to HMRC's MTD APIs as its own application, registered on HMRC's Developer Hub. It starts with the sandbox, HMRC's test service with made-up taxpayers. Using the live service needs HMRC's production approval for the application, which isn't covered here yet.

1. Sign in at [developer.service.hmrc.gov.uk](https://developer.service.hmrc.gov.uk) and add a sandbox application.
2. Subscribe it to these APIs, at these versions (subscriptions are per version):
   - **Business Details (MTD)** 2.0
   - **Obligations (MTD)** 3.0
   - **Self Employment Business (MTD)** 5.0
   - **Individual Calculations (MTD)** 8.0
   - **Test Fraud Prevention Headers** 1.0 (sandbox only)
3. Add the redirect URI shown in **Settings → HMRC** (the app's address followed by `/api/hmrc/callback`, e.g. `https://crafty.local/api/hmrc/callback`).
4. Put the application's client ID and a client secret in `.env` as `HMRC_CLIENT_ID` and `HMRC_CLIENT_SECRET`, and restart the app.
5. Create a sandbox test user (an **Individual**) with HMRC's [Create test user](https://developer.service.hmrc.gov.uk/api-test-user) service. In **Settings → HMRC**, enter its National Insurance number, choose **Connect to HMRC** and sign in with its user ID and password.
6. Choose **Find my business**. In the sandbox HMRC answers with a made-up business (such as Company X), and the MTD Quarterly page shows HMRC's test obligations (the app asks the sandbox for its `DYNAMIC` test scenario, which answers for the dates asked), not your own.

**Fraud prevention headers.** HMRC requires details of the browser, device and network with every MTD call (the `WEB_APP_VIA_SERVER` connection method). The browser sends its part (a device ID kept in the browser, screen and window size, time zone, user agent) and the server adds the rest. HMRC says never to guess a value, so values the app can't know are left out: there's no multi-factor sign-in or licence key, and when the app is reached over a home network the public IP addresses of the browser and server aren't visible to it. Behind a public domain they are (Caddy passes on the browser's port). **Settings → HMRC → Check with HMRC** sends this browser's headers to HMRC's test API and lists anything missing or wrong. HMRC asks software makers to tell it about values that can't be collected, which would be part of applying for production access.

### Sending quarterly updates

Once connected with a business, each quarter's submission panel on the MTD Quarterly page has **Send to HMRC** (editors only), from the 2025/26 tax year:

- It sends the year-to-date figures (6 April to the end of the quarter) as a cumulative period summary to the Self Employment Business API. Every income and expense field is sent, zeros included; disallowable amounts are listed separately. The JSON export is the same.
- A confirmation lists every non-zero field before anything goes. If the figures change between opening it and sending, the app refuses and asks you to check them again.
- HMRC takes an update from 10 days before its quarter ends.
- HMRC gives no reference for an update, so the app records who sent it, when, to which HMRC service, HMRC's correlation ID and exactly what was sent. That record can't be changed or removed by hand, and it's part of backups.
- If the figures change after sending, the panel says so. Updates are cumulative, so the next quarter's update puts HMRC right; the latest quarter HMRC has can also be sent again. HMRC refuses to replace an earlier quarter once it has a later one, so the panel offers no button then and says why.
- The panel also uses HMRC's obligations: when HMRC has received a quarter the app didn't send (from other software, say), it says so, and sending replaces it. Forms for incoming, outgoing and mileage, their delete confirmations and Use of Home warn when a change is dated on or before the end of the latest quarter sent.
- Updates sent to the sandbox are tests: once the app uses HMRC's live service (`HMRC_ENV=production`) they no longer count as submitted, the panel just mentions them, and the quarter can be sent for real.

### HMRC's tax calculation

**MTD Quarterly** shows HMRC's own calculation for the year below the quarters, next to the app's estimate, once connected (from 2025/26). It's kept apart from **Reports → Tax estimate**, which is the app's own Self Assessment guide and links to it. **Ask HMRC to calculate** (editors) asks HMRC to work out the tax from the quarterly updates it has (an in-year calculation, Individual Calculations API 8.0); HMRC does it in the background, and the page checks every few seconds until it's ready. It shows HMRC's profit, allowances, Income Tax, Class 2 and Class 4 National Insurance and total due, HMRC's projection for the whole year, and any messages HMRC adds. In the sandbox HMRC answers with its worked example (`UK_SE_SAVINGS_EXAMPLE`), not your figures.

The connection lasts 18 months, after which you connect again. Like people, it belongs to the install rather than the books: the HMRC tokens never go into backups, and the connection is kept through a restore or a reset. **Disconnect** makes the app forget the tokens; to withdraw the authority at HMRC as well, do it in your HMRC online account.

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
