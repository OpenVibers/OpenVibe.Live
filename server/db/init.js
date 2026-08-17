/**
 * OpenVibe.Live — Database Initialization Script
 * Run: npm run init-db
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/live.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

// Ensure data directory exists
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
    console.log(`Created data directory: ${dataDir}`);
}

// Read schema
const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');

// Initialize database
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(schema);

console.log(`Database initialized at: ${DB_PATH}`);

db.close();
process.exit(0);
