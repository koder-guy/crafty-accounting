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
];

export const CURRENT_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;
