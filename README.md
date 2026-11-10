# Crafty Accounting

Self-hosted bookkeeping for UK sole traders on the cash basis. Keep your income and expenses, then file with HMRC either on a Self Assessment return or through Making Tax Digital (MTD), using the app's quarterly figures with bridging software.

## Features

- **Business details**: your name, trading name, what the business does, address, contact details, start date and UTR, plus a logo (an image or PDF, trimmed and shrunk to fit), in **Settings → Business Details**. A new install asks for them before anything else, or you can restore a backup or load the sample data instead. They appear at the top of the dashboard, on the Year-end summary and at the top of printed reports, go in backups, and are kept when you start again with an empty database.
- **Tax years** run 6 April to 5 April. Each is set to go to HMRC by a **Self Assessment return** or by **Making Tax Digital**, and the menu shows only that section. A year with quarterly updates stays MTD.
- **Income and expenses**: income with a category and payment method (cash, card or bank transfer); purchases split into line items, each with a category and optionally marked disallowable, with the transaction total added up from them. Attach up to 10 documents (PDFs or images) to each, or take a photo with the device's camera (a computer's camera needs [HTTPS](#https); a phone's works either way). Photos are saved as JPEGs of 2 MB or less, and you can rename any new document before saving. **Duplicate** starts a new entry from an existing one, for things that repeat.
- **Reading invoices with AI** (optional): choose Claude or Google's Gemini in **Settings → AI Document Scanning**, add an API key from Anthropic or Google and choose a model, and **Scan documents** on the Expenses page takes PDFs and photos of invoices and receipts, one or many at once. The AI reads them in the background, filling in the date, payee, numbers, payment method and categorised lines, and you check each one and save it as an expense, or skip or discard it. The invoice is attached, named by date, payee, invoice number and amount. Each invoice read is sent to the provider chosen, which bills the key per use (about a penny an invoice). On Google's free tier, what's sent may be used to improve Google's products. Keys are shown only partly, and stay out of backups.
- **Importing from Square** (optional): add a Square access token in **Settings → Square Integration** (the page says how to get one), and **Import from Square** on the Income page lists the payouts Square has made to your bank for sales in the tax year you're working in. Each one you import becomes an income of that day's card sales, before Square's fees and less refunds, paid by bank transfer, plus an expense for the fees, both dated the day of the sales. Each gets a PDF statement of the payout attached: every sale, refund and fee in it, with Square's receipt numbers linking to its receipts. Sales and fees go under custom categories named for them, such as "Square sales" and "Square fees", if you have them, unless you choose others in Settings. A payout already imported is never imported twice, and one holding anything other than sales and fees (a hold or an adjustment) is left for you to add by hand. The token is shown only partly, and stays out of backups.
- **Lists** can be searched, filtered, sorted and exported to CSV or JSON. The JSON keeps each expense's line items, with amounts in pence, and can be imported again with **Import**, here or on another install: each transaction goes into the tax year its date falls in, and ones already in the books are left out. Document files aren't in an export, so they need attaching again.
- **Simplified expenses**:
  - **Mileage** at HMRC's rates (for each tax year; for 2026/27, cars and vans 55p a mile for the first 10,000 miles and 25p after, motorcycles 24p, bicycles 20p). It warns if a year also has actual vehicle costs, which HMRC doesn't allow alongside mileage.
  - **Use of Home** at HMRC's flat rate, from the hours worked at home each month: £10 for 25 to 50 hours, £18 for 51 to 100, £26 for 101 or more.
  - Both claims count in every total: dashboard, reports, MTD figures and the SA103S.
- **Custom categories**, such as "Printer filament", each mapped to a standard MTD category and counted towards it.
- **Dashboard**: totals, a monthly chart, a breakdown by HMRC category and key dates.
- **Reports**:
  - **Breakdown**: income and spending for any period, by category and payee, with the transactions behind each row.
  - **Compare years**: two tax years side by side: income, expenses, profit and margin, month by month and by category, plus the estimated tax for full years. A year still in progress is compared with the same stretch of the other.
  - **Tax estimate**: Income Tax and Class 4 National Insurance on the year's profit, using the trading allowance if that's better. It shows what to put aside and when it's due, including payments on account, and can allow for a salary or pension. Rates are for England, Wales and Northern Ireland.
- **Self Assessment → Year-end summary**: the figures for each box of the SA103S (self-employment, short), with disallowable amounts listed and a trading allowance comparison. Business entertaining is always disallowable, in every total. Depreciation isn't offered for new expenses, because on the cash basis you claim equipment when you buy it. Record the date you filed, and the app warns if the figures change afterwards.
- **Making Tax Digital**: each quarter's figures as a CSV for bridging software, and a record of each submission (see [Making Tax Digital](#making-tax-digital)).
- **Users**: everyone signs in with their own name and password. **Editors** can change anything; **Read-only** users can view, export and print but not change the books or download backups. Transactions show who added and last changed them.
- **Working together**: changes appear in every open browser within a second. If two people edit the same transaction, the second save is refused and the form offers to load the other version.
- **Backups**: daily automatic backups, each one downloadable or restorable in a click (see [Backups](#backups)).
- Reports and the year-end summary print or save as PDF.
- **Notifications**: a bell at the top right shows how many unread notifications you have: a new version to install, or the disk running low on space. Open one to go to the page that deals with it, or mark it read. Only editors get these two, since only they can act on them.
- **Updates**: the app checks for new versions twice a day and says so under the bell. **Settings → Updates** lists what's changed and, for the Linux quick install, installs it in a click after saving a backup. For Docker it shows the command to run.

## Quick install (Linux server)

For a Linux server or container, such as a Proxmox LXC running Debian or Ubuntu. Run this **as root**:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/koder-guy/crafty-accounting/main/install.sh)"
```

[`install.sh`](install.sh) does everything in one go:
- creates a `crafty` account (or uses the one that's there), which owns and runs the app;
- as that account, downloads the latest release with its own Node 22 and [Caddy](https://caddyserver.com) into `/home/crafty/crafty-accounting`, builds it and writes the settings;
- sets up two services, `crafty-accounting` (the app) and `crafty-caddy` (HTTPS on ports 80 and 443), which start now, on every boot, and again if they stop;
- prints the `https://` addresses to open.

If the server's address on its own network differs from its public one (a cloud server usually has a private `10.x` address), it asks which you'll browse to. To answer in advance, put `CRAFTY_SITE_IP=203.0.113.10` (your address) before `bash`. To change it later, edit `SITE_ADDRESS` and `SITE_IP` in `/home/crafty/crafty-accounting/.env` and run `/home/crafty/crafty-accounting/crafty restart`.

It also asks for an optional domain name to open the app at, such as `books.example.co.uk` (press Enter to skip; `CRAFTY_DOMAIN=books.example.co.uk` before `bash` answers in advance). The app adds it to its addresses in **Settings → HTTPS Certificate** when it first starts, where more can be added or removed later. Point the name at the server in your DNS or on your router.

It needs Linux with systemd (Debian, Ubuntu, Fedora and most others) on Intel/AMD or ARM. On a Mac, on Alpine, or without systemd, use [Docker](#quick-install-with-docker).

**Signing in for the first time:** use the username `Admin` and the password `admin`. You'll be asked to choose your own password before anything else; change your username and add other users in **Settings → Users**.

**HTTPS:** Caddy serves the app with a private certificate, so browsers warn about it until each device trusts `/home/crafty/crafty-accounting/crafty-root.crt` once (see [HTTPS](#https)). Only Caddy is allowed to use ports 80 and 443; the app itself answers only on the server. If those ports are taken, choose others with `CRAFTY_HTTP_PORT` and `CRAFTY_HTTPS_PORT` before `bash`.

**Updates:** **Settings → Updates** installs new versions in a click, or run the install command again as root. Either way your books and settings stay, and a failed update leaves the running version alone.

**Day to day**, as root or as `crafty` (`su - crafty`):

```bash
/home/crafty/crafty-accounting/crafty status
```

`crafty` also takes `log`, `restart` (after changing the settings in `/home/crafty/crafty-accounting/.env`) and `update`. To stop or start the app, as root: `systemctl stop crafty-accounting crafty-caddy` (or `start`).

**From an earlier quick install** (version 1.8 or before, run with `crafty start`): run the install command as root. It reuses your `crafty` account, books and settings, moves HTTPS to ports 80 and 443, stops the copy started with `crafty start` and removes a `@reboot` crontab line for it. An update from **Settings → Updates** can't make that change, so do this first.

## Quick install with Docker

For a Mac, or any Linux. Needs Docker: on a Mac, [Docker Desktop](https://www.docker.com/products/docker-desktop/) or OrbStack. On Linux the script offers to install Docker if it's missing.

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/koder-guy/crafty-accounting/main/install-docker.sh)"
```

[`install-docker.sh`](install-docker.sh) sets everything up in `~/crafty-accounting`, starts the containers and prints the `https://` addresses to open. Like the Linux install, it asks which address you'll browse to when the computer's network and public addresses differ (`CRAFTY_SITE_IP` answers in advance), and for an optional domain name to open the app at, which the app adds to its addresses in **Settings → HTTPS Certificate** (`CRAFTY_DOMAIN` answers in advance). Sign in as `Admin` / `admin` and choose your own password. It uses ports 80 and 443, or 8080 and 8443 if those are taken (choose with `CRAFTY_HTTP_PORT` and `CRAFTY_HTTPS_PORT`). It saves Caddy's certificate as `crafty-root.crt` and prints the command to trust it on a Mac; for other devices see [HTTPS](#https). To update, run `~/crafty-accounting/install-docker.sh` again.

## Run with Docker Compose by hand

Clone the repository:

```bash
git clone https://github.com/koder-guy/crafty-accounting.git
cd crafty-accounting
```

**On a server, or to use it from other devices**, first tell it the addresses you'll browse to, in a `.env` file in that folder. Without one, only `https://localhost` on the same computer works, and any other address gets a page saying what to set. For a server at 192.168.1.50 (on Linux, `hostname -I` shows its address):

```bash
printf 'SITE_ADDRESS=localhost, 192.168.1.50\nSITE_IP=192.168.1.50\n' > .env
```

`SITE_ADDRESS` can also list names, such as `localhost, crafty.local, 192.168.1.50`; `SITE_IP` is the IP address in it. Then start it:

```bash
docker compose up -d --build
```

Open `https://localhost`, or the server's address, sign in as `Admin` / `admin` and choose your own password. Browsers warn about the certificate until you trust it (see [HTTPS](#https)).

Everything else has a default (see [Configuration](#configuration)). Run `docker compose up -d` after changing `.env`.

Automatic backups go to `./backups`, or to `BACKUP_HOST_DIR` (ideally another disk or a NAS share). On Linux, let the container's user write there:

```bash
mkdir -p ./backups && sudo chown 1000:1000 ./backups
```

Caddy (`crafty-caddy`) provides HTTPS in front of the app (`crafty-accounting`). The database and documents are in the `crafty-data` Docker volume. To update, run `git pull` and `docker compose up -d --build` again; database migrations run on start.

### HTTPS

Both installs serve HTTPS through Caddy. To start with, Caddy uses a private certificate of its own for the addresses in `SITE_ADDRESS`, which each device trusts once. Then, in **Settings → HTTPS Certificate**, you can add a domain on Cloudflare with a Let's Encrypt certificate, or upload a certificate of your own; browsers already trust either. After changing `SITE_ADDRESS`, run `/home/crafty/crafty-accounting/crafty restart` (Linux quick install) or `docker compose up -d` (Docker).

**The app's own certificate (the default).** The app's web server, Caddy, creates its own certificate authority, which each device must trust once. Each device can download it from `https://<server address>/crafty-root.crt` (past the browser's warning, this once). The installers also save it as `crafty-root.crt` in the install's folder, and print its SHA-256 fingerprint, a command to paste into a Mac's Terminal that downloads it, checks the fingerprint and trusts it, and, on a first install, the certificate itself to copy into a file. As the download isn't checked, compare the fingerprint before trusting it; Keychain Access shows it under **SHA-256**. The summary at the top of **Settings → HTTPS Certificate** offers the same file with its fingerprint.

Then install `crafty-root.crt` on each device:
- **Mac:** add it to the System keychain, then in Keychain Access set **Trust → When using this certificate** to **Always Trust**.
- **Windows:** **Install Certificate → Local Machine → Trusted Root Certification Authorities**.
- **iPhone/iPad:** install the profile in **Settings → General → VPN & Device Management**, then turn it on in **Settings → General → About → Certificate Trust Settings**.
- **Android:** **Settings → Security → Encryption & credentials → Install a certificate → CA certificate**.

The authority lasts 10 years. The Linux quick install keeps it in `/home/crafty/crafty-accounting/caddy/data`, Docker in the `caddy-data` volume; removing it creates a new one, which you'd have to trust again.

**A domain on Cloudflare (Settings → HTTPS Certificate).** If your domain's DNS is on Cloudflare, Caddy can get a Let's Encrypt certificate for a name in it, such as `books.example.co.uk`, while the app stays on your home network: nothing forwarded, nothing to install on devices. Caddy proves the domain is yours by adding a temporary DNS record through Cloudflare's API.

1. In Cloudflare, create an API token (**My Profile → API Tokens → Create Token**, starting from **Edit zone DNS**) with **Zone → DNS → Edit** and **Zone → Zone → Read**, for your domain's zone only. A token, not the Global API Key.
2. In Cloudflare, add an **A record** for the name you'll use, such as `books.example.co.uk`, pointing at the server's address (the one in `SITE_IP`), with the proxy off (**DNS only**, the grey cloud). Cloudflare's proxy can't reach a server on a home network.
3. In the app, enter the domain and the token. The app checks them with Cloudflare, then Caddy restarts (on Docker, run `docker compose restart caddy` in the install's folder) and gets the certificate, which takes a minute or two; the page shows when it's in place. Caddy renews it by itself.

Then open `https://books.example.co.uk`. Some routers and DNS filters (Fritz!Box, pfSense, Pi-hole and others) refuse DNS answers that point at a home address, as protection against "DNS rebinding"; if the name doesn't work at home, allow the domain there, or add it to the router's own DNS. The token is kept with the install, not in backups. To try it out without using up Let's Encrypt's limits, set `ACME_CA=https://acme-staging-v02.api.letsencrypt.org/directory` in `.env` and restart (browsers won't trust that certificate), then remove it, restart and save the domain again.

**Your own certificate (Settings → HTTPS Certificate).** Upload a `.pfx` or `.p12` file holding a certificate and its private key, such as one from your organisation or a certificate authority, with its password. The app checks it, keeps it (not in backups) and Caddy serves it for the addresses in `SITE_ADDRESS` instead of its own private certificate (a domain on Cloudflare keeps its Let's Encrypt one). The Linux quick install restarts Caddy straight away; on Docker, run `docker compose restart caddy` in the install's folder. The bell warns 30 days before it expires. Its names should match `SITE_ADDRESS`, or browsers warn. If browsers can't open the app with it, add `TLS_CUSTOM=off` to `.env` and restart as above to go back to Caddy's own certificate, then remove or replace it.

If ports 80 and 443 are taken, change `HTTP_PORT` and `HTTPS_PORT`; the address then needs the port, such as `https://crafty.local:8443`.

## Configuration

Settings go in a `.env` file next to the app (the installers write one). Only include what you change.

| Variable | Default | Purpose |
|---|---|---|
| `ADMIN_NAME` / `ADMIN_PASSWORD` | `Admin` / `admin` | The first person's username and password, created when nobody exists yet; ignored after that. With the default password they must choose their own when they first sign in. |
| `SESSION_SECRET` | generated | Signs the session cookie; one is generated and kept with the data if empty |
| `PORT` | `3000` | Port the app listens on (behind Caddy with HTTPS) |
| `HOST` | all addresses | Address the app listens on; the Linux quick install sets `127.0.0.1`, so only Caddy reaches it |
| `SITE_ADDRESS` | `localhost` | HTTPS: address(es) you browse to, comma separated. The server's own IP address on its network is always served too: the Linux quick install finds it each time it starts, and the Docker installer adds it here |
| `CRAFTY_ADDRESSES` | none | Domain names the installer asked for, comma separated: the app adds them to its addresses in **Settings → HTTPS Certificate** once, when it next starts; change them there |
| `SITE_IP` | `localhost` | HTTPS: the IP address in `SITE_ADDRESS` that browsers use, if any; when it isn't an IP address, the server's own IP address is used |
| `ACME_CA` | Let's Encrypt | HTTPS: another ACME certificate authority for a domain on Cloudflare, such as Let's Encrypt's staging one |
| `TLS_CUSTOM` | on | HTTPS: `off` ignores a certificate uploaded in Settings → HTTPS Certificate |
| `HTTP_PORT` / `HTTPS_PORT` | `80` / `443` | HTTPS: ports Caddy listens on |
| `MAX_UPLOAD_MB` | `20` | Largest document you can attach |
| `COOKIE_SECURE` / `TRUST_PROXY` | `false` (`true` in both installs) | HTTPS-only cookie; trust the proxy's forwarded headers |
| `DATA_DIR` | `./data` (`/data` in Docker) | Database and documents |
| `BACKUP_HOST_DIR` | `./backups` | Docker: the folder on the server for automatic backups |
| `BACKUP_DIR` | `DATA_DIR/backups` | Without Docker: where automatic backups go (the `crafty` account must be able to write there) |
| `TZ` | `Europe/London` | Time zone for the daily backup |
| `UPDATE_CHECK` | `true` | `false` stops the app checking GitHub for new versions by itself; **Settings → Updates** can still check |

## Backups

**Automatic:** every day at 02:00 the app writes a full `.zip` backup to the backup folder (`BACKUP_HOST_DIR` with Docker). Days without changes are skipped, the newest 30 are kept, and a missed backup runs when the app next starts. Change this, or use **Back up now**, in **Settings → Backup and Restore**, which also says if the folder can't be written to (usually its permissions) and how much free space is left for the books and the backups, in red when it's running low. The folder is outside the Docker volume; keep it on another disk or a NAS, or copy it elsewhere regularly.

Also in **Settings → Backup and Restore**:
- **Saved backups**: download any of the latest ten, or restore one in place after you type `RESTORE`. It replaces the database and every document; later backups stay in the folder.
- **Restore from a backup file**: a `.zip` replaces the database and every document; an older `.sql` backup replaces the database and leaves documents alone.
- **Start again with an empty database** deletes the books after you type `RESET`, keeping your business details and optionally your custom categories; the old database and documents are kept until the next reset.

A restore is checked in a separate database before anything is replaced, and older backups are upgraded automatically. Backups don't include the people who can sign in, so a restore keeps them as they are.

## Uninstalling

This removes the app and everything it has saved: the books, documents, backups, settings and certificates. There's no undo, so download a backup first (**Settings → Backup and Restore**) if you might want the books again.

**Linux quick install:** as root, run [`uninstall.sh`](uninstall.sh). It lists what it will remove and asks you to type `delete` first.

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/koder-guy/crafty-accounting/main/uninstall.sh)"
```

It removes both services and the `crafty` account with its home folder. If `.env` moved `DATA_DIR` or `BACKUP_DIR` elsewhere, it removes those too (only the automatic backups from `BACKUP_DIR`). Give `CRAFTY_USER` if you installed with it.

**Docker:** in the install's folder (`~/crafty-accounting` for the quick install), remove the containers and their volumes, then the folder and its `backups` (and `BACKUP_HOST_DIR`, if you moved them):

```bash
cd ~/crafty-accounting && docker compose down --volumes --rmi local && cd .. && rm -rf crafty-accounting
```

Then remove the trusted certificate ("Caddy Local Authority") from each device: on a Mac in Keychain Access → System, on an iPhone in **Settings → General → VPN & Device Management**.

## Making Tax Digital

From the 2025/26 tax year, an MTD year goes to HMRC through bridging software. Export each quarter's figures as a CSV (or as JSON in HMRC's own update format), import them into your bridging software, submit them, then record the submission in the app. The CSV has a row of HMRC's field names and a row of values, always the same columns. Bridging tools each have their own import format, so you may need to map the columns. Disallowable amounts are in the expense columns and in their own, so don't add them all up.

- **Expenses** go by category, or as one total if your annual turnover is below the VAT registration threshold (set per year in Settings → Tax Years). One total is allowable expenses only, with no disallowable amounts. Once the year's turnover reaches the threshold, expenses go by category for the whole year.
- **Quarterly updates** cover 6 Apr–5 Jul, 6 Jul–5 Oct, 6 Oct–5 Jan and 6 Jan–5 Apr, each due by the 7th of the next month. They're cumulative, so each reports the year to date. Submitted figures can still be corrected: the app warns when you change them, and tells you how to bring HMRC up to date.
- **The final declaration** replaces the Self Assessment return and is due by 31 January. Make it with your MTD software, as the app doesn't send anything to HMRC itself.

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

MIT; see [LICENSE](LICENSE). Crafty Accounting comes with no warranty: it helps you keep your books, but you remain responsible for what you submit to HMRC.
