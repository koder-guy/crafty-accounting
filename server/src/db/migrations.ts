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
];

export const CURRENT_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;
