// Schema migrations, applied in order and recorded in schema_migrations.
// Add new versions to the end; never edit one that has shipped.
//
// Keep SQL comments out of CREATE statements: the backup dump writes each
// statement on a single line, and an inline "--" comment would swallow the rest.

export interface Migration {
  version: number;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
CREATE TABLE tax_years (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL UNIQUE CHECK (label GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK (type IN ('INCOME', 'EXPENSE')),
  name TEXT NOT NULL,
  hmrc_code TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_custom INTEGER NOT NULL DEFAULT 0 CHECK (is_custom IN (0, 1))
);

CREATE UNIQUE INDEX idx_categories_standard ON categories (type, hmrc_code) WHERE is_custom = 0;
CREATE UNIQUE INDEX idx_categories_name ON categories (type, name COLLATE NOCASE);

CREATE TABLE incomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tax_year_id INTEGER NOT NULL REFERENCES tax_years(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  description TEXT NOT NULL,
  source TEXT,
  reference TEXT,
  payment_method TEXT NOT NULL CHECK (payment_method IN ('cash', 'card', 'bank_transfer')),
  amount_pence INTEGER NOT NULL CHECK (amount_pence > 0),
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
  notes TEXT,
  document_filename TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tax_year_id INTEGER NOT NULL REFERENCES tax_years(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  payee TEXT NOT NULL,
  invoice_number TEXT,
  order_number TEXT,
  description TEXT,
  payment_method TEXT NOT NULL CHECK (payment_method IN ('cash', 'card', 'bank_transfer')),
  total_pence INTEGER NOT NULL CHECK (total_pence > 0),
  notes TEXT,
  document_filename TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE expense_line_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  expense_id INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  amount_pence INTEGER NOT NULL CHECK (amount_pence > 0),
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
  disallowable INTEGER NOT NULL DEFAULT 0 CHECK (disallowable IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE mtd_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tax_year_id INTEGER NOT NULL REFERENCES tax_years(id) ON DELETE CASCADE,
  quarter INTEGER NOT NULL CHECK (quarter BETWEEN 1 AND 4),
  submitted_on TEXT NOT NULL,
  reference TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (tax_year_id, quarter)
);

CREATE INDEX idx_incomes_year_date ON incomes (tax_year_id, date);
CREATE INDEX idx_expenses_year_date ON expenses (tax_year_id, date);
CREATE INDEX idx_line_items_expense ON expense_line_items (expense_id);
`,
  },
  // Sign-ins for each person. Users belong to the install and survive a restore
  // (see backup.ts), so transactions record names as text rather than user ids,
  // and a user's active tax year is checked when read rather than by a foreign key.
  {
    version: 2,
    sql: `
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  active_tax_year_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE UNIQUE INDEX idx_users_name ON users (name COLLATE NOCASE);

ALTER TABLE incomes ADD COLUMN created_by TEXT;
ALTER TABLE incomes ADD COLUMN updated_by TEXT;
ALTER TABLE expenses ADD COLUMN created_by TEXT;
ALTER TABLE expenses ADD COLUMN updated_by TEXT;

DELETE FROM settings WHERE key = 'active_tax_year_id';
`,
  },
  // Business mileage claimed at HMRC's rates, and other income for the tax estimate.
  {
    version: 3,
    sql: `
CREATE TABLE mileage_trips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tax_year_id INTEGER NOT NULL REFERENCES tax_years(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  description TEXT NOT NULL,
  vehicle TEXT NOT NULL CHECK (vehicle IN ('car', 'motorcycle', 'bicycle')),
  distance_tenths INTEGER NOT NULL CHECK (distance_tenths > 0),
  notes TEXT,
  created_by TEXT,
  updated_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_mileage_year_date ON mileage_trips (tax_year_id, date);

ALTER TABLE tax_years ADD COLUMN other_income_pence INTEGER NOT NULL DEFAULT 0 CHECK (other_income_pence >= 0);
`,
  },
  // Hours worked at home each tax month, for the use of home flat rate.
  {
    version: 4,
    sql: `
CREATE TABLE home_working_months (
  tax_year_id INTEGER NOT NULL REFERENCES tax_years(id) ON DELETE CASCADE,
  month_index INTEGER NOT NULL CHECK (month_index BETWEEN 0 AND 11),
  hours INTEGER NOT NULL CHECK (hours > 0),
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (tax_year_id, month_index)
);
`,
  },
  // Read-only sign-ins. Everyone set up before this is an editor.
  {
    version: 5,
    sql: `
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'editor' CHECK (role IN ('editor', 'viewer'));
`,
  },
  // Several documents per transaction. Existing attachments move into the new
  // table. The old document_filename columns stay (SQLite can't drop a UNIQUE
  // column) but are always NULL from here on.
  {
    version: 6,
    sql: `
CREATE TABLE documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT NOT NULL UNIQUE,
  income_id INTEGER REFERENCES incomes(id) ON DELETE CASCADE,
  expense_id INTEGER REFERENCES expenses(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ((income_id IS NULL) != (expense_id IS NULL))
);

CREATE INDEX idx_documents_income ON documents (income_id);
CREATE INDEX idx_documents_expense ON documents (expense_id);

INSERT INTO documents (filename, income_id) SELECT document_filename, id FROM incomes WHERE document_filename IS NOT NULL ORDER BY id;
INSERT INTO documents (filename, expense_id) SELECT document_filename, id FROM expenses WHERE document_filename IS NOT NULL ORDER BY id;
UPDATE incomes SET document_filename = NULL;
UPDATE expenses SET document_filename = NULL;
`,
  },
  // The connection to HMRC for Making Tax Digital, one row per HMRC service
  // (sandbox or production). Like users it belongs to the install, not the
  // books: left out of backups and kept through a restore or reset.
  {
    version: 7,
    sql: `
CREATE TABLE hmrc_connections (
  environment TEXT PRIMARY KEY CHECK (environment IN ('sandbox', 'production')),
  nino TEXT,
  access_token TEXT,
  refresh_token TEXT,
  access_expires_at TEXT,
  refresh_expires_at TEXT,
  scope TEXT,
  connected_by TEXT,
  connected_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
`,
  },
  // The self-employment business at HMRC that quarterly updates are for.
  {
    version: 8,
    sql: `
ALTER TABLE hmrc_connections ADD COLUMN business_id TEXT;
ALTER TABLE hmrc_connections ADD COLUMN trading_name TEXT;
`,
  },
  // Quarterly updates the app sent to HMRC itself: who, when, to which HMRC
  // service, HMRC's correlation id and exactly what was sent.
  {
    version: 9,
    sql: `
ALTER TABLE mtd_submissions ADD COLUMN sent_by TEXT;
ALTER TABLE mtd_submissions ADD COLUMN sent_at TEXT;
ALTER TABLE mtd_submissions ADD COLUMN sent_environment TEXT;
ALTER TABLE mtd_submissions ADD COLUMN correlation_id TEXT;
ALTER TABLE mtd_submissions ADD COLUMN sent_payload TEXT;
`,
  },
  // How each year reaches HMRC. Years with a quarterly update recorded are MTD.
  {
    version: 10,
    sql: `
ALTER TABLE tax_years ADD COLUMN submission_method TEXT NOT NULL DEFAULT 'self_assessment'
  CHECK (submission_method IN ('self_assessment', 'mtd'));
UPDATE tax_years SET submission_method = 'mtd' WHERE id IN (SELECT tax_year_id FROM mtd_submissions);
`,
  },
  // Final declarations the app made for an MTD year, one per HMRC service:
  // who, when, the calculation agreed to and HMRC's correlation id.
  {
    version: 11,
    sql: `
CREATE TABLE mtd_final_declarations (
  tax_year_id INTEGER NOT NULL REFERENCES tax_years(id) ON DELETE CASCADE,
  environment TEXT NOT NULL CHECK (environment IN ('sandbox', 'production')),
  calculation_id TEXT NOT NULL,
  total_due_pence INTEGER NOT NULL,
  declared_by TEXT NOT NULL,
  declared_at TEXT NOT NULL,
  correlation_id TEXT,
  PRIMARY KEY (tax_year_id, environment)
);
`,
  },
  // Amendments confirmed after a final declaration, as many as are made.
  {
    version: 12,
    sql: `
CREATE TABLE mtd_amendments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tax_year_id INTEGER NOT NULL REFERENCES tax_years(id) ON DELETE CASCADE,
  environment TEXT NOT NULL CHECK (environment IN ('sandbox', 'production')),
  calculation_id TEXT NOT NULL,
  total_due_pence INTEGER NOT NULL,
  amended_by TEXT NOT NULL,
  amended_at TEXT NOT NULL,
  correlation_id TEXT
);
`,
  },
  // A person who must choose a new password before doing anything else: the
  // first person, when created with the default password.
  {
    version: 13,
    sql: `
ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;
`,
  },
  // How an MTD year's expenses go to HMRC: by category, or as one total.
  {
    version: 14,
    sql: `
ALTER TABLE tax_years ADD COLUMN mtd_expenses TEXT NOT NULL DEFAULT 'itemised'
  CHECK (mtd_expenses IN ('itemised', 'consolidated'));
`,
  },
  // Entertainment and depreciation are never allowable, so their lines are always disallowable.
  {
    version: 15,
    sql: `
UPDATE expense_line_items SET disallowable = 1
WHERE category_id IN (SELECT id FROM categories WHERE type = 'EXPENSE' AND hmrc_code IN ('businessEntertainmentCosts', 'depreciation'));
`,
  },
  // Expenses no longer have a description of their own (line items still do). Any written so far
  // move to the notes, which stay within their 2000 character limit.
  {
    version: 16,
    sql: `
UPDATE expenses SET notes = substr(CASE WHEN notes IS NULL OR notes = '' THEN description ELSE notes || char(10) || description END, 1, 2000)
WHERE description IS NOT NULL AND description <> '';
ALTER TABLE expenses DROP COLUMN description;
`,
  },
  // The figures when a quarter was recorded by hand, and a year's Self Assessment return being filed
  // with its figures then, so the app can tell when they've changed since.
  {
    version: 17,
    sql: `
ALTER TABLE mtd_submissions ADD COLUMN recorded_payload TEXT;
ALTER TABLE tax_years ADD COLUMN sa_filed_on TEXT;
ALTER TABLE tax_years ADD COLUMN sa_filed_figures TEXT;
`,
  },
  // Notifications under the bell (an update to install, the disk running low), and who has read
  // each. Like the people, they belong to the install, not the books: left out of backups.
  // `key` names the condition, so it's raised once while it lasts; the row goes when it ends.
  {
    version: 18,
    sql: `
CREATE TABLE notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  link TEXT,
  audience TEXT NOT NULL DEFAULT 'all' CHECK (audience IN ('all', 'editors')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE notification_reads (
  notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (notification_id, user_id)
);
`,
  },
  // The Claude integration: the Anthropic API key and the model that reads invoices. Like the
  // HMRC connection it belongs to the install, not the books: left out of backups, kept through a
  // restore. One row at most.
  {
    version: 19,
    sql: `
CREATE TABLE claude_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  api_key TEXT,
  key_added_by TEXT,
  key_added_at TEXT,
  model TEXT
);
`,
  },
  // How documents Claude read are named (Settings → Claude Integration). NULL is the default pattern.
  {
    version: 20,
    sql: `
ALTER TABLE claude_settings ADD COLUMN filename_pattern TEXT;
`,
  },
  // New installs default to Haiku rather than Opus. One that saved settings without choosing a
  // model was using Opus, the old default, and keeps it.
  {
    version: 21,
    sql: `
UPDATE claude_settings SET model = 'claude-opus-5-5' WHERE model IS NULL;
`,
  },
  // Documents scanned in bulk, waiting to be checked and saved as expenses. Their files are in
  // uploads/ (named scan-…), so they go into backups with the books. `reading` is Claude's
  // InvoiceReading as JSON. Not tied to a tax year: each is saved into the year its date falls in.
  {
    version: 22,
    sql: `
CREATE TABLE scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'reading', 'ready', 'failed')),
  reading TEXT,
  error TEXT,
  uploaded_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
`,
  },
  // Each scan's and document's SHA-256, so a file scanned again is noticed. Rows from before
  // (and from older backups) start NULL and are filled in from their files when scans are listed.
  {
    version: 23,
    sql: `
ALTER TABLE scans ADD COLUMN sha256 TEXT;
ALTER TABLE documents ADD COLUMN sha256 TEXT;
CREATE INDEX idx_documents_sha256 ON documents (sha256);
`,
  },
  // The Square connection (Settings → Square): an access token, and the categories its payouts
  // are imported into. Like the Claude key it belongs to the install, not the books: left out of
  // backups, kept through a restore. Each income and fees expense imported from Square keeps the
  // payout's id, so a payout is never imported twice.
  {
    version: 24,
    sql: `
CREATE TABLE square_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  access_token TEXT,
  environment TEXT NOT NULL DEFAULT 'production' CHECK (environment IN ('production', 'sandbox')),
  merchant_name TEXT,
  token_added_by TEXT,
  token_added_at TEXT,
  income_category_id INTEGER,
  fee_category_id INTEGER
);
ALTER TABLE incomes ADD COLUMN square_payout_id TEXT;
ALTER TABLE expenses ADD COLUMN square_payout_id TEXT;
CREATE UNIQUE INDEX idx_incomes_square_payout ON incomes (square_payout_id) WHERE square_payout_id IS NOT NULL;
CREATE UNIQUE INDEX idx_expenses_square_payout ON expenses (square_payout_id) WHERE square_payout_id IS NOT NULL;
`,
  },
  // Business details (Settings → Business Details), one row, with the logo as a PNG or JPEG.
  // Books data, so in backups; a reset keeps it unless it's the sample data's made-up business.
  {
    version: 25,
    sql: `
CREATE TABLE business_details (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  owner_name TEXT NOT NULL,
  trading_name TEXT,
  description TEXT NOT NULL,
  address_line1 TEXT,
  address_line2 TEXT,
  town TEXT,
  county TEXT,
  postcode TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  website TEXT,
  start_date TEXT,
  end_date TEXT,
  utr TEXT,
  logo BLOB,
  logo_type TEXT CHECK (logo_type IN ('image/png', 'image/jpeg')),
  is_sample INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);
`,
  },
  // An HTTPS certificate of the owner's own (Settings → HTTPS Certificate), from a .pfx/.p12
  // file: the certificate with its intermediates, and the private key, both as PEM. Like the
  // Claude key it belongs to the install: left out of backups, kept through a restore or reset.
  {
    version: 26,
    sql: `
CREATE TABLE tls_certificate (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  cert_pem TEXT NOT NULL,
  key_pem TEXT NOT NULL,
  file_name TEXT,
  added_by TEXT NOT NULL,
  added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
`,
  },
  // The Claude integration becomes AI document scanning, with Gemini (Google) as a second choice.
  // Each provider keeps its own key and model, so switching back loses neither; `provider` is the
  // one that reads documents. Installs from before it keep Claude.
  {
    version: 27,
    sql: `
ALTER TABLE claude_settings RENAME TO ai_settings;
ALTER TABLE ai_settings RENAME COLUMN api_key TO claude_api_key;
ALTER TABLE ai_settings RENAME COLUMN key_added_by TO claude_key_added_by;
ALTER TABLE ai_settings RENAME COLUMN key_added_at TO claude_key_added_at;
ALTER TABLE ai_settings RENAME COLUMN model TO claude_model;
ALTER TABLE ai_settings ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude';
ALTER TABLE ai_settings ADD COLUMN gemini_api_key TEXT;
ALTER TABLE ai_settings ADD COLUMN gemini_key_added_by TEXT;
ALTER TABLE ai_settings ADD COLUMN gemini_key_added_at TEXT;
ALTER TABLE ai_settings ADD COLUMN gemini_model TEXT;
`,
  },
  // A domain on Cloudflare that Caddy gets a Let's Encrypt certificate for (Settings → HTTPS
  // Certificate), with the API token Caddy uses for Cloudflare's DNS. `dns_record_id` is the
  // A/AAAA record the app made pointing the domain at this server, removed with the domain.
  // Install-level like tls_certificate: left out of backups, kept through a restore or reset.
  {
    version: 28,
    sql: `
CREATE TABLE tls_domain (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  domain TEXT NOT NULL,
  zone_id TEXT NOT NULL,
  zone_name TEXT NOT NULL,
  api_token TEXT NOT NULL,
  dns_record_id TEXT,
  pointed_at TEXT,
  added_by TEXT NOT NULL,
  added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
`,
  },
  // The app no longer points a domain at this server in Cloudflare (that's left to the person),
  // so the record it made and the address aren't kept. A record made before stays in Cloudflare.
  {
    version: 29,
    sql: `
ALTER TABLE tls_domain DROP COLUMN dns_record_id;
ALTER TABLE tls_domain DROP COLUMN pointed_at;
`,
  },
  // Which HTTPS method is in use (Settings → HTTPS Certificate), so the domain and the uploaded
  // certificate can both stay saved while one, or Caddy's own, is used. Install-level like them.
  // Before, a saved domain was always used, and an uploaded certificate whenever there was one.
  {
    version: 30,
    sql: `
CREATE TABLE tls_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  method TEXT NOT NULL CHECK (method IN ('internal', 'cloudflare', 'custom'))
);
INSERT INTO tls_settings (id, method) SELECT 1, CASE
  WHEN EXISTS (SELECT 1 FROM tls_domain) THEN 'cloudflare'
  WHEN EXISTS (SELECT 1 FROM tls_certificate) THEN 'custom'
  ELSE 'internal' END;
`,
  },
  // Addresses added in Settings → HTTPS Certificate beside SITE_ADDRESS in .env, served with the
  // app's own certificate unless the method in use covers them. Install-level like tls_settings.
  {
    version: 31,
    sql: `
CREATE TABLE tls_addresses (
  name TEXT PRIMARY KEY,
  added_by TEXT NOT NULL,
  added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
`,
  },
];

export const CURRENT_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;
