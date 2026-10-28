# Crafty Accounting

Self-hosted bookkeeping for a UK sole trader who sells at craft fairs (cash basis). The data model follows HMRC's Making Tax Digital (MTD) self-employment API so submission can be added later. README.md covers features, setup, Docker, HTTPS and backups; read it first.

**Status:** v1.0.0 is released but not yet in use with real books (as of 2026-10-28), so changes to the app and database structure are still fine. It stays a self-hosted web app; a native macOS version was considered and dropped.

## Layout

npm workspaces, all TypeScript:
- `shared/` (`@crafty/shared`): consumed as source, no build. Tax years, money, categories, zod schemas, API types, MTD and SA103S calculations (`mtd.ts`, `selfAssessment.ts`), mileage rates (`mileage.ts`), use of home flat rate (`useOfHome.ts`), Income Tax and Class 4 rates and the tax estimate (`taxEstimate.ts`).
- `server/`: Express 5 + better-sqlite3, bundled with tsup. Routes in `src/routes/`, SQL in `src/repo.ts`, migrations in `src/db/migrations.ts`, backup/restore/reset in `src/backup.ts`, daily backups in `src/autoBackup.ts`, people and password hashing in `src/users.ts`, the live-update event stream in `src/liveUpdates.ts`. Tests in `src/app.test.ts` (Vitest + supertest against a temporary database).
- `client/`: Vite, React 19, react-router 7, TanStack Query, react-hook-form, Tailwind v4, Recharts, lucide-react. API hooks in `src/lib/queries.ts`, theme tokens in `src/index.css`.

## Commands

Node 22 comes from Homebrew and isn't on the default PATH. Prefix shell commands with:

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
```

- `npm run typecheck`: shared, server and client.
- `npx vitest run`: all tests. Run both before every commit.
- `npm run build`, `npm run seed`, `docker compose up -d --build`.

## Rules

- **Database changes go in a new migration.** Append a new version to `MIGRATIONS` in `server/src/db/migrations.ts`; don't edit one that has shipped. Until real books are in use, editing migration 1 is possible but ask first, since dev databases and backups use it. Restore runs migrations on older backups, so a new migration must also upgrade an old dump; add a test for that.
- **Money** is integer pence everywhere; convert only for display, CSV and the MTD payload. Dates are ISO `YYYY-MM-DD`. Tax years are stored as `2025-26` and shown as `2025/26`.
- **Categories** carry an `hmrc_code` (MTD field name). Custom categories (`is_custom`) roll up to the standard category they map to.
- **Profit figures** use allowable expenses only (disallowable excluded): dashboard boxes, monthly chart, and the Reports → Breakdown Profit box. Category tables still list disallowable amounts, marked. The Year-end summary also drops entertainment and depreciation (see the README note).
- **People:** each has their own sign-in and active tax year (`users.active_tax_year_id`). People belong to the install, not the books: they're left out of backups and kept through a restore or reset, so transactions store `created_by`/`updated_by` as names, not user ids.
- **Working together:** every successful non-GET API call is broadcast to the other open browsers over `GET /api/events` (Server-Sent Events), which refetch. Edit forms fill once and send `expectedUpdatedAt`; the server answers 409 if the record changed since, and the form offers to load the other version.
- **Mileage** is stored in tenths of a mile and claimed at HMRC rates, worked out in date order per tax year (the 10,000-mile car threshold). Claims count as `carVanTravelExpenses` in every total.
- **Use of home** is hours per tax month (`home_working_months`), claimed at HMRC's flat rate as `premisesRunningCosts`, each month's claim dated its last day (the 5th). Mileage and use of home claims reach every total through `yearEntries`, `mileageClaimLines` and `useOfHomeClaimLines` in `repo.ts`; use those rather than querying expense lines directly.
- **Tax rates** are per tax year in `TAX_RATES` (`shared/src/taxEstimate.ts`); add each new year when HMRC confirms it. Later years fall back to the latest rates with a warning.
- **MTD:** no copy and paste of figures (digital links). Exports are files.
- **UI conventions:**
  - Dark theme with indigo/violet accents; use the tokens in `index.css`, which also define the light print theme.
  - Red for destructive actions and outgoing amounts. Green (`ok`) for income.
  - Payment badges: cash is amber, card is teal, bank transfer is indigo.
  - Sub-pages use `SectionLayout`: `variant="tabs"` in Reports, the side menu in Settings.
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

MTD stage 2 (submitting to HMRC), locking submitted quarters, change history, recurring transactions, bank statement CSV/OFX import with matching, card reader and marketplace imports (SumUp, Square, Etsy), profit per craft fair, phone camera capture for receipts, VAT threshold warning, deadline reminders, read-only accountant access, Scottish tax rates, code splitting.
