# Crafty Accounting

Self-hosted bookkeeping for UK sole traders (cash basis), filing by Self Assessment return or through HMRC's Making Tax Digital (MTD) self-employment APIs. It started out for craft fair sellers (the sample data still is), but isn't limited to them. Keep README.md user-facing and short; implementation detail belongs here. README.md covers features, setup, Docker, HTTPS and backups; read it first.

**Status:** v1.0.0 is released but not yet in use with real books (as of 2026-10-28), so changes to the app and database structure are still fine. It stays a self-hosted web app; a native macOS version was considered and dropped.

## Layout

npm workspaces, all TypeScript:
- `shared/` (`@crafty/shared`): consumed as source, no build. Tax years, money, categories, zod schemas, API types, MTD and SA103S calculations (`mtd.ts`, `selfAssessment.ts`), mileage rates (`mileage.ts`), use of home flat rate (`useOfHome.ts`), Income Tax and Class 4 rates and the tax estimate (`taxEstimate.ts`).
- `server/`: Express 5 + better-sqlite3, bundled with tsup. Routes in `src/routes/`, SQL in `src/repo.ts`, migrations in `src/db/migrations.ts`, backup/restore/reset in `src/backup.ts`, daily backups in `src/autoBackup.ts`, people and password hashing in `src/users.ts`, the live-update event stream in `src/liveUpdates.ts`, the HMRC OAuth connection, token refresh and `callHmrc` in `src/hmrc.ts` (calls go through `ctx.fetch`, which tests replace), HMRC's fraud prevention headers in `src/fraudPrevention.ts`. Tests in `src/app.test.ts` (Vitest + supertest against a temporary database).
- `client/`: Vite, React 19, react-router 7, TanStack Query, react-hook-form, Tailwind v4, Recharts, lucide-react. API hooks in `src/lib/queries.ts`, theme tokens in `src/index.css`.

## Commands

Node 22 comes from Homebrew and isn't on the default PATH. Prefix shell commands with:

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
```

- If `node_modules` is missing (it can be cleared between sessions), run `npm ci` first.
- `npm run typecheck`: shared, server and client.
- `npx vitest run`: all tests. Run both before every commit.
- `npm run build`, `npm run seed`, `docker compose up -d --build`.
- `install-docker.sh`: the Docker Compose equivalent (source and `.env` in `~/crafty-accounting-docker`, `COMPOSE_PROJECT_NAME=crafty-accounting` pinned in `.env`, so it shares volumes with a checkout run by hand; `CRAFTY_PROJECT` overrides it for tests). Its body is in `main()` so an update can overwrite the running file; run from an install's folder it updates that install. Same token handling as `install.sh`. Caddy omits the port from its http→https redirect when `https_port` matches, so non-443 setups need the port in the address.
- `install.sh`: one-command install or update for macOS and Linux (glibc), fetched with curl from `main`. The repo is public (since 2026-10-29), so no token is needed: the script checks the repo API answers without one, and only if it doesn't (the repo made private again) asks for `GITHUB_TOKEN` on `/dev/tty`, checks it against the repo API, and uses it for both downloads (raw.githubusercontent.com with a Bearer header, and the source from the API's `/tarball/<branch>`, since archive URLs don't accept tokens); the token is never saved. A set but rejected token is dropped when the repo is public. `crafty update` runs a copy of the installed `app/install.sh`; `crafty` is replaced by moving a new file in, since the old one is still being read. `crafty start` launches node detached (its own session) via a node one-liner: with nohup alone it dies when the terminal closes. Everything goes in `~/crafty-accounting`: its own Node 22 from nodejs.org, the app built in `app.new` then swapped for `app`, `.env`, `data/`, and the `crafty` start/stop script (nohup and a pid file; deliberately no launchd/systemd autostart). Uses `npm ci --ignore-scripts` so better-sqlite3's bundled prebuilds are used instead of compiling.

## Rules

- **Database changes go in a new migration.** Append a new version to `MIGRATIONS` in `server/src/db/migrations.ts`; don't edit one that has shipped. Until real books are in use, editing migration 1 is possible but ask first, since dev databases and backups use it. Restore runs migrations on older backups, so a new migration must also upgrade an old dump; add a test for that.
- **Money** is integer pence everywhere; convert only for display, CSV and the MTD payload. Dates are ISO `YYYY-MM-DD`. Tax years are stored as `2025-26` and shown as `2025/26`.
- **Categories** carry an `hmrc_code` (MTD field name). Custom categories (`is_custom`) roll up to the standard category they map to.
- **Profit figures** use allowable expenses only (disallowable excluded): dashboard boxes, monthly chart, and the Reports → Breakdown Profit box. Category tables still list disallowable amounts, marked. The Year-end summary also drops entertainment and depreciation (see the README note).
- **People:** each has their own sign-in and active tax year (`users.active_tax_year_id`), and a role: `editor` or `viewer` (read-only). `readOnlyGuard` in `routes/auth.ts` refuses every change from a viewer (except switching their tax year and changing their own password) and backup downloads; the client hides editing with `useCanEdit()` and `EditorOnly`. New routes that change data are covered automatically; new editor-only downloads need adding to `EDITOR_ONLY_DOWNLOADS`. People belong to the install, not the books: they're left out of backups and kept through a restore or reset, so transactions store `created_by`/`updated_by` as names, not user ids.
- **Working together:** every successful non-GET API call is broadcast to the other open browsers over `GET /api/events` (Server-Sent Events), which refetch. Edit forms fill once and send `expectedUpdatedAt`; the server answers 409 if the record changed since, and the form offers to load the other version.
- **Documents** live in the `documents` table (one transaction can have up to `MAX_DOCUMENTS`), stored in `uploads/` under their original filenames, which must be unique. Uploads go through `saveWithDocuments` in `documents.ts`, which places the files, runs the database write and cleans up either way. The old `document_filename` columns on incomes and expenses are unused (always NULL since migration 6).
- **Mileage** is stored in tenths of a mile and claimed at HMRC rates, worked out in date order per tax year (the 10,000-mile car threshold). Claims count as `carVanTravelExpenses` in every total.
- **Use of home** is hours per tax month (`home_working_months`), claimed at HMRC's flat rate as `premisesRunningCosts`, each month's claim dated its last day (the 5th). Mileage and use of home claims reach every total through `yearEntries`, `mileageClaimLines` and `useOfHomeClaimLines` in `repo.ts`; use those rather than querying expense lines directly.
- **Tax rates** are per tax year in `TAX_RATES` (`shared/src/taxEstimate.ts`); add each new year when HMRC confirms it. Later years fall back to the latest rates with a warning.
- **Submission method:** each tax year goes to HMRC by Self Assessment return or MTD (`tax_years.submission_method`); the sidebar shows only that year's section. Quarterly updates can only be recorded or sent for MTD years, and an MTD year with any, recorded or sent (`mtdUpdateCounts`), can't go back to Self Assessment.
- **MTD:** no copy and paste of figures (digital links). Exports are files.
- **HMRC connection** (`hmrc_connections`, one row per `HMRC_ENV`): NINO and OAuth tokens. Install-level like people: left out of backups (`INSTALL_TABLES` in `backup.ts`) and kept through a restore or reset. Call HMRC's APIs with `callHmrc(ctx, req, …)`: it adds the token (`hmrcAccessToken` refreshes once for concurrent callers) and the fraud prevention headers, and turns HMRC's errors into HttpErrors (never 401, which would sign the person out). Routes that call HMRC live under `/api/hmrc/`, so the client sends the browser's part of the fraud prevention data (`X-Fraud-Prevention`, from `client/src/lib/fraudPrevention.ts`). Never invent a header value HMRC can't be given truthfully; leave it out. Quarterly updates go through `POST /api/hmrc/quarters/:taxYearId/:quarter/send` with the payload the person confirmed (`mtdPayload`, shared with the JSON export); the server rebuilds it and refuses (409) if it differs. A sent record (`mtd_submissions.sent_*`) is never changed by hand. The final declaration (`POST /api/hmrc/final-declaration/:taxYearId`, recorded in `mtd_final_declarations` per HMRC service) agrees to an `intent-to-finalise` calculation; the server reads it again and refuses (409) if it has errors or its total differs from the one shown, and a declared year takes no more quarterly updates except Q4, the whole year, as part of an amendment. Amendments (`/amendment/calculation`, then `/amendment`; `intent-to-amend`, `confirm-amendment`, recorded in `mtd_amendments`) are allowed until `mtdAmendmentDeadline`, 12 months after the filing deadline. Develop against the sandbox; `HMRC_ENV` defaults to it.
- **UI conventions:**
  - Dark theme with indigo/violet accents; use the tokens in `index.css`, which also define the light print theme.
  - Red for destructive actions and outgoing amounts. Green (`ok`) for income.
  - Delete and Remove buttons use the `softDanger` button variant (`SOFT_DANGER` in `ui.tsx`): red text on a light red background with a faint red border.
  - Payment badges: cash is amber, card is teal, bank transfer is indigo.
  - Sidebar icons are muted grey; only the current page's icon takes the accent colour.
  - Sub-pages use `SectionLayout`: `variant="tabs"` in Self Assessment (Year-end summary), Making Tax Digital (Quarterly updates), Simplified Expenses (Mileage, Use of Home) and Reports (Tax estimate, Breakdown); a section with one page shows no tabs, the side menu in Settings.
  - Dialogs are centred `<dialog>` elements with a blurred backdrop.

## Working in this repo

- Never read `.env`; it holds the owner's real password.
- The owner's own dev preview runs on ports 3101 (API) and 5173 (web); don't stop or restart it. For browser checks, start a separate copy (`api-check` and `web-check` in `.claude/launch.json` do this, signing in as `Admin` / `check-password`):
  - API on 3102, with `DATA_DIR` set to a scratch folder and a throwaway `ADMIN_PASSWORD`/`SESSION_SECRET`.
  - Vite on 5174, with `API_URL=http://localhost:3102`.
  - Load sample data with `POST /api/sample-data`.
- Check UI changes in the browser.
- Commit and push each finished change to `main` (remote `koder-guy/crafty-accounting`).
- Bump `APP_VERSION` in `shared/src/index.ts` and the package versions for a release, then tag it.

## Open ideas

MTD stage 2 (submitting to HMRC; sandbox connection, fraud prevention headers, business details, obligations, sending quarterly updates, HMRC's tax calculation and the final declaration are built; and amendments after it are built; next is going live with production credentials), locking submitted quarters, change history, recurring transactions, bank statement CSV/OFX import with matching, card reader and marketplace imports (SumUp, Square, Etsy), profit per craft fair, phone camera capture for receipts, VAT threshold warning, deadline reminders, Scottish tax rates, code splitting.
