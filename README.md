# Crafty Accounting

Self-hosted bookkeeping for UK sole traders on the cash basis. Keep your income and expenses, then file with HMRC either on a Self Assessment return or through Making Tax Digital (MTD): quarterly updates, the final declaration and amendments are sent from the app.

## Features

- **Tax years** run 6 April to 5 April. Each is set to go to HMRC by a **Self Assessment return** or by **Making Tax Digital**, and the menu shows only that section. A year with quarterly updates stays MTD.
- **Incoming and outgoing**: income with a category and payment method (cash, card or bank transfer); purchases split into line items, each with a category and optionally marked disallowable, with the transaction total added up from them. Attach up to 10 documents (PDFs or images) to each, or take a photo with the device's camera (a computer's camera needs [HTTPS](#https); a phone's works either way). Photos are saved as JPEGs of 2 MB or less, and you can rename any new document before saving. **Duplicate** starts a new entry from an existing one, for things that repeat.
- **Lists** can be searched, filtered, sorted and exported to CSV.
- **Simplified expenses**:
  - **Mileage** at HMRC's rates (cars and vans 45p a mile for the first 10,000 miles in a tax year and 25p after, motorcycles 24p, bicycles 20p). It warns if a year also has actual vehicle costs, which HMRC doesn't allow alongside mileage.
  - **Use of Home** at HMRC's flat rate, from the hours worked at home each month: £10 for 25 to 50 hours, £18 for 51 to 100, £26 for 101 or more.
  - Both claims count in every total: dashboard, reports, MTD figures and the SA103S.
- **Custom categories**, such as "Printer filament", each mapped to a standard MTD category and counted towards it.
- **Dashboard**: totals, a monthly chart, a breakdown by HMRC category and key dates.
- **Reports**:
  - **Breakdown**: income and spending for any period, by category and payee, with the transactions behind each row.
  - **Tax estimate**: Income Tax and Class 4 National Insurance on the year's profit, using the trading allowance if that's better. It shows what to put aside and when it's due, including payments on account, and can allow for a salary or pension. Rates are for England, Wales and Northern Ireland.
- **Self Assessment → Year-end summary**: the figures for each box of the SA103S (self-employment, short), with disallowable amounts listed and a trading allowance comparison. Business entertaining is always disallowable, in every total. Depreciation isn't offered for new expenses, because on the cash basis you claim equipment when you buy it.
- **Making Tax Digital**: quarterly updates, HMRC's tax calculation, the final declaration and amendments (see [Making Tax Digital](#making-tax-digital)).
- **People**: everyone signs in with their own name and password. **Editors** can change anything; **Read-only** people can view, export and print but not change the books or download backups. Transactions show who added and last changed them.
- **Working together**: changes appear in every open browser within a second. If two people edit the same transaction, the second save is refused and the form offers to load the other version.
- **Backups**: daily automatic backups, plus manual download and restore (see [Backups](#backups)).
- Reports and the year-end summary print or save as PDF.

## Quick install (macOS and Linux)

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/koder-guy/crafty-accounting/main/install.sh)"
```

[`install.sh`](install.sh) works on macOS and on Linux distributions such as Ubuntu, Debian and Fedora (Intel/AMD or ARM), and needs only `curl` and `tar`. It needs no administrator password: everything goes in `~/crafty-accounting`, including its own copy of Node 22. It starts the app and prints the addresses to open.

The app keeps running when the terminal closes, but doesn't start by itself after a restart:

```bash
~/crafty-accounting/crafty start
```

`crafty` also takes `stop`, `restart`, `status`, `log` and `update`. An update keeps your books and settings, and leaves the running copy alone if it fails. Settings are in `~/crafty-accounting/.env`, the books in `~/crafty-accounting/data`. On a new install you can set `CRAFTY_DIR` or `CRAFTY_PORT` before `/bin/bash`.

**Signing in for the first time:** use the name `Admin` and the password `admin`. You'll be asked to choose your own password before anything else; rename yourself and add other people in **Settings → People**.

This serves plain HTTP, which is fine on a home network. For HTTPS, or on Alpine and other musl-based Linux, use Docker.

## Quick install with Docker

Needs Docker: on a Mac, [Docker Desktop](https://www.docker.com/products/docker-desktop/) or OrbStack. On Linux the script offers to install Docker if it's missing.

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/koder-guy/crafty-accounting/main/install-docker.sh)"
```

[`install-docker.sh`](install-docker.sh) sets everything up in `~/crafty-accounting`, starts the containers and prints the `https://` addresses to open. Sign in as `Admin` / `admin` and choose your own password. It uses ports 80 and 443, or 8080 and 8443 if those are taken (choose with `CRAFTY_HTTP_PORT` and `CRAFTY_HTTPS_PORT`). It saves Caddy's certificate as `crafty-root.crt` and prints the command to trust it on a Mac; for other devices see [HTTPS](#https). To update, run `~/crafty-accounting/install-docker.sh` again. The Docker and non-Docker installs share that folder, so to have both, give one another folder with `CRAFTY_DIR`.

## Run with Docker Compose by hand

Clone the repository and start it from inside the folder:

```bash
git clone https://github.com/koder-guy/crafty-accounting.git
cd crafty-accounting
docker compose up -d --build
```

Open `https://localhost`, sign in as `Admin` / `admin` and choose your own password. Browsers warn about the certificate until you trust it (see [HTTPS](#https)).

Everything has a default, so a `.env` file in the same folder is only needed for what you change (see [Configuration](#configuration)). Usually that's `SITE_ADDRESS`, so other devices can reach it, such as `SITE_ADDRESS=localhost, crafty.local, 192.168.1.50`. Run `docker compose up -d` after changing it.

Automatic backups go to `./backups`, or to `BACKUP_HOST_DIR` (ideally another disk or a NAS share). On Linux, let the container's user write there:

```bash
mkdir -p ./backups && sudo chown 1000:1000 ./backups
```

Caddy (`crafty-caddy`) provides HTTPS in front of the app (`crafty-accounting`). The database and documents are in the `crafty-data` Docker volume. To update, run `git pull` and `docker compose up -d --build` again; database migrations run on start.

### HTTPS

`TLS_ISSUER` in `.env` chooses how Caddy gets its certificate. Run `docker compose up -d` after changing it.

**Home network (`TLS_ISSUER=internal`, the default).** Caddy creates its own certificate authority, which each device must trust once. Copy it out of the container:

```bash
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./crafty-root.crt
```

Then install `crafty-root.crt` on each device:
- **Mac:** add it to the System keychain, then in Keychain Access set **Trust → When using this certificate** to **Always Trust**.
- **Windows:** **Install Certificate → Local Machine → Trusted Root Certification Authorities**.
- **iPhone/iPad:** install the profile in **Settings → General → VPN & Device Management**, then turn it on in **Settings → General → About → Certificate Trust Settings**.
- **Android:** **Settings → Security → Encryption & credentials → Install a certificate → CA certificate**.

The authority lasts 10 years and is kept in the `caddy-data` volume. Removing that volume creates a new one, which you'd have to trust again.

**Public domain (`TLS_ISSUER=you@example.com`).** Point your domain at your home IP, forward ports 80 and 443 to the server, and set `SITE_ADDRESS` to the domain. Caddy then gets a Let's Encrypt certificate, with nothing to install on devices. Use strong passwords if the app can be reached from the internet.

If ports 80 and 443 are taken, change `HTTP_PORT` and `HTTPS_PORT`; the address then needs the port, such as `https://crafty.local:8443`.

## Configuration

Settings go in a `.env` file next to the app (the installers write one). Only include what you change.

| Variable | Default | Purpose |
|---|---|---|
| `ADMIN_NAME` / `ADMIN_PASSWORD` | `Admin` / `admin` | The first person, created when nobody exists yet; ignored after that. With the default password they must choose their own when they first sign in. |
| `SESSION_SECRET` | generated | Signs the session cookie; one is generated and kept with the data if empty |
| `PORT` | `3000` | Port the app listens on |
| `SITE_ADDRESS` | `localhost` | Docker: address(es) for HTTPS, comma separated |
| `TLS_ISSUER` | `internal` | Docker: `internal`, or your email address for Let's Encrypt |
| `HTTP_PORT` / `HTTPS_PORT` | `80` / `443` | Docker: ports Caddy listens on |
| `MAX_UPLOAD_MB` | `20` | Largest document you can attach |
| `COOKIE_SECURE` / `TRUST_PROXY` | `false` (`true` in Docker) | HTTPS-only cookie; trust the proxy's forwarded headers |
| `DATA_DIR` | `./data` (`/data` in Docker) | Database and documents |
| `BACKUP_HOST_DIR` | `./backups` | Docker: the folder on the server for automatic backups |
| `BACKUP_DIR` | `DATA_DIR/backups` | Without Docker: where automatic backups go |
| `TZ` | `Europe/London` | Time zone for the daily backup |
| `HMRC_CLIENT_ID` / `HMRC_CLIENT_SECRET` | *(none)* | Your application's credentials from HMRC (see [Connecting to HMRC](#connecting-to-hmrc)) |
| `HMRC_ENV` | `sandbox` | `sandbox` (HMRC's test service) or `production` |
| `HMRC_REDIRECT_URI` | worked out | Only if Settings → HMRC shows the wrong redirect URI |

## Backups

**Automatic:** every day at 02:00 the app writes a full `.zip` backup to the backup folder (`BACKUP_HOST_DIR` with Docker). Days without changes are skipped, the newest 30 are kept, and a missed backup runs when the app next starts. Change this, or use **Back up now**, in **Settings → Backup and restore**, which also says if the folder can't be written to (usually its permissions). The folder is outside the Docker volume; keep it on another disk or a NAS, or copy it elsewhere regularly.

**Manual**, in **Settings → Backup and restore**:
- **Full backup (.zip)**: the database and every document. Restoring it replaces both.
- **Database only (.sql)**: restoring it replaces the database and leaves documents alone.
- **Start again with an empty database** deletes the books after you type `RESET`; the old database and documents are kept until the next reset.

A restore is checked in a separate database before anything is replaced, and older backups are upgraded automatically. Backups don't include the people who can sign in or the HMRC connection, so a restore keeps both as they are.

## Making Tax Digital

From the 2025/26 tax year, an MTD year goes to HMRC like this. Without a connection to HMRC, you can still export each quarter's figures as a CSV for bridging software and record the submission. It has a row of HMRC's field names and a row of values, always the same columns. Bridging tools each have their own import format, so you may need to map the columns. Disallowable amounts are in the expense columns and in their own, so don't add them all up.

- **Expenses** go by category, or as one total if your annual turnover is below the VAT registration threshold (set per year in Settings → Tax years). One total is allowable expenses only, with no disallowable amounts. Once the year's turnover reaches the threshold, expenses go by category for the whole year.
- **Quarterly updates** cover 6 Apr–5 Jul, 6 Jul–5 Oct, 6 Oct–5 Jan and 6 Jan–5 Apr, each due by the 7th of the next month. They're cumulative, so each sends the year to date. **Send to HMRC** shows the figures to confirm first, and HMRC takes an update from 10 days before its quarter ends. The page shows what HMRC expects and has received, and warns when a later change affects a quarter already sent.
- **HMRC's tax calculation** for the year so far appears on the Quarterly updates page, next to the app's own estimate.
- **Final declaration**: after the tax year ends and once HMRC has all four updates, ask HMRC to calculate. Check its figures, including the band-by-band workings, and agree to HMRC's declaration. This replaces the Self Assessment return and is due by 31 January. Report any other income in your HMRC online account first, because the app only covers the business.
- **Amendments**: until 12 months after the 31 January deadline, correct your books, send the corrected year's figures, and agree to HMRC's new calculation.

The app records who sent each update, declaration and amendment, when, and HMRC's reference. These records are kept in backups and can't be changed by hand. It refuses to send if the figures have changed since you checked them.

### Connecting to HMRC

The app talks to HMRC as its own application, registered on HMRC's Developer Hub. For now that's the sandbox, HMRC's test service with made-up taxpayers; using the live service needs HMRC's approval for the application.

1. At [developer.service.hmrc.gov.uk](https://developer.service.hmrc.gov.uk), add a sandbox application and subscribe it to **Business Details (MTD)** 2.0, **Obligations (MTD)** 3.0, **Self Employment Business (MTD)** 5.0, **Individual Calculations (MTD)** 8.0 and **Test Fraud Prevention Headers** 1.0.
2. Add the redirect URI shown in **Settings → HMRC** (the app's address followed by `/api/hmrc/callback`).
3. Put the client ID and a client secret in `.env` as `HMRC_CLIENT_ID` and `HMRC_CLIENT_SECRET`, and restart the app.
4. Create an **Individual** with HMRC's [Create test user](https://developer.service.hmrc.gov.uk/api-test-user) service. In **Settings → HMRC**, enter its National Insurance number, choose **Connect to HMRC**, sign in as it, then choose **Find my business**.

In the sandbox, HMRC answers with test data (a made-up business, obligations and calculations), not your own figures. Updates sent to the sandbox don't count once the app uses the live service.

The connection lasts 18 months. **Disconnect** makes the app forget it; to withdraw the authority at HMRC too, do it in your HMRC online account.

HMRC also requires fraud prevention details about the browser, device and network with every call. The app sends what it truthfully knows and leaves out the rest; **Settings → HMRC → Check with HMRC** lists anything HMRC says is missing.

## Development

Requires Node 22+.

```bash
npm install
npm run dev
```

The API runs on port 3000 and the client on <http://localhost:5173>, which proxies `/api` to it. To use another API port, start the server with `PORT` and the client with `API_URL=http://localhost:<port>`.

`npm test` runs the tests and `npm run typecheck` checks the types. `npm run seed` loads sample data (add `-- --reset` to replace existing data); on a new install the dashboard also offers **Load sample data**.

The code is in three parts:
- `shared/`: tax years, money, categories, schemas and MTD calculations, used by both sides.
- `server/`: the Express API with SQLite. Tests are in `server/src/app.test.ts`.
- `client/`: React, Vite, Tailwind CSS, TanStack Query and Recharts.

## Licence

MIT; see [LICENSE](LICENSE). Crafty Accounting comes with no warranty: it helps you keep your books and send them to HMRC, but you remain responsible for what you submit.
