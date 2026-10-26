// Command-line entry point: fills the database with sample data for testing.
//   npm run seed               (refuses if data already exists)
//   npm run seed -- --reset    (deletes ALL tax years, transactions and documents first)
// In Docker: docker compose exec crafty-accounting node server/dist/seed.js [--reset]
import fs from 'node:fs';
import path from 'node:path';
import { openDatabase } from './db';
import { clearData, generateSampleData, hasData } from './sampleData';

const dataDir = path.resolve(process.env.DATA_DIR ?? 'data');
const uploadsDir = path.join(dataDir, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

const db = openDatabase(path.join(dataDir, 'crafty.db'));
try {
  if (hasData(db)) {
    if (!process.argv.includes('--reset')) {
      console.error('The database already has data. Run again with --reset to delete everything and load sample data.');
      process.exitCode = 1;
    } else {
      clearData(db, uploadsDir);
      console.log('Deleted existing tax years, transactions and documents.');
    }
  }
  if (!process.exitCode) {
    const result = generateSampleData(db, uploadsDir);
    console.log(
      `Loaded sample data into ${dataDir}: ${result.taxYears} tax years, ${result.incomes} incoming, ` +
        `${result.expenses} outgoing, ${result.documents} documents, ${result.submissions} MTD submissions.`,
    );
  }
} finally {
  db.close();
}
