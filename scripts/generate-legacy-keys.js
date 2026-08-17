#!/usr/bin/env node
/**
 * OpenVibe.Live — Legacy Username Key Generator
 *
 * Reads all real users from the RS-Companion SQLite DB, reserves their
 * usernames in OpenVibe.Live by generating verification keys, and outputs
 * a lookup table (username → key) so you can DM each user their key.
 *
 * The key allows them to claim their old username on the signup screen.
 * Until redeemed, nobody else can register that username.
 *
 * Prerequisites:
 *   • OpenVibe.Live server must have been started once (schema + admin exist)
 *   • RS-Companion DB path provided as argument
 *
 * Usage:
 *   node scripts/generate-legacy-keys.js <path-to-rs-companion.db>
 *   node scripts/generate-legacy-keys.js <path-to-rs-companion.db> --min-messages=5
 *
 * Output: prints a table and writes keys to data/legacy-keys.json
 */

const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// ── Args ─────────────────────────────────────────────────────
const rsDbPath = process.argv[2];
if (!rsDbPath) {
    console.error('Usage: node scripts/generate-legacy-keys.js <path-to-rs-companion.db> [--min-messages=N]');
    process.exit(1);
}

// Optional minimum message threshold (default: 1 — skip zero-message users)
let minMessages = 1;
const minArg = process.argv.find(a => a.startsWith('--min-messages='));
if (minArg) minMessages = parseInt(minArg.split('=')[1], 10) || 1;

const openvibeDbPath = path.resolve(__dirname, '../data/live.db');
const outputPath = path.resolve(__dirname, '../data/legacy-keys.json');

console.log(`[LegacyKeys] RS-Companion DB : ${rsDbPath}`);
console.log(`[LegacyKeys] OpenVibe.Live DB : ${openvibeDbPath}`);
console.log(`[LegacyKeys] Min messages    : ${minMessages}`);

// ── Open databases ───────────────────────────────────────────
const rsDb = new Database(rsDbPath, { readonly: true });
const openvibeDb = new Database(openvibeDbPath);
openvibeDb.pragma('journal_mode = WAL');

// ── Find admin user (creator of keys) ────────────────────────
const admin = openvibeDb.prepare("SELECT id, username FROM users WHERE role = 'admin' LIMIT 1").get();
if (!admin) {
    console.error('[LegacyKeys] ❌ No admin user found. Start the server once first.');
    rsDb.close(); openvibeDb.close();
    process.exit(1);
}
console.log(`[LegacyKeys] Admin user      : ${admin.username} (id=${admin.id})`);

// ── Fetch RS-Companion users ─────────────────────────────────
const rsUsers = rsDb.prepare(`
    SELECT user_id, username, total_messages, coins, xp, level
    FROM users
    WHERE username NOT LIKE 'anon%'
      AND username NOT IN ('[Private]mods', 'ChatBot')
      AND total_messages >= ?
    ORDER BY total_messages DESC
`).all(minMessages);

console.log(`[LegacyKeys] ${rsUsers.length} eligible RS-Companion users\n`);

// ── Generate keys ────────────────────────────────────────────
function generateKey() {
    return 'OPENVIBE-' + [4, 4, 4].map(() =>
        crypto.randomBytes(2).toString('hex').toUpperCase()
    ).join('-');
}

const insertKey = openvibeDb.prepare(`
    INSERT INTO verification_keys (key, target_username, note, created_by)
    VALUES (?, ?, ?, ?)
`);

const checkExisting = openvibeDb.prepare(`
    SELECT id FROM verification_keys WHERE LOWER(target_username) = LOWER(?) AND status = 'active'
`);

const checkUserExists = openvibeDb.prepare(`
    SELECT id FROM users WHERE LOWER(username) = LOWER(?)
`);

const results = [];
let created = 0, skippedExisting = 0, skippedRegistered = 0;

const generateAll = openvibeDb.transaction(() => {
    for (const rsu of rsUsers) {
        const username = rsu.username;

        // Skip if this username is already registered on OpenVibe.Live
        const existingUser = checkUserExists.get(username);
        if (existingUser) {
            console.log(`  ⏭  ${username} — already registered (user #${existingUser.id})`);
            skippedRegistered++;
            continue;
        }

        // Skip if a key already exists for this username
        const existingKey = checkExisting.get(username);
        if (existingKey) {
            console.log(`  ⏭  ${username} — key already exists`);
            skippedExisting++;
            continue;
        }

        const key = generateKey();
        const note = `RS-Companion legacy user (id=${rsu.user_id}, msgs=${rsu.total_messages}, coins=${Math.floor(rsu.coins || 0)})`;

        insertKey.run(key, username, note, admin.id);

        results.push({
            username,
            key,
            messages: rsu.total_messages,
            coins: Math.floor(rsu.coins || 0),
            level: rsu.level || 1,
            rs_user_id: rsu.user_id
        });

        created++;
    }
});

try {
    generateAll();
} catch (err) {
    console.error(`[LegacyKeys] ❌ Failed: ${err.message}`);
    rsDb.close(); openvibeDb.close();
    process.exit(1);
}

// ── Output ───────────────────────────────────────────────────
console.log('\n' + '═'.repeat(80));
console.log('  LEGACY USERNAME VERIFICATION KEYS');
console.log('═'.repeat(80));
console.log('');
console.log(`  ${'Username'.padEnd(25)} ${'Key'.padEnd(20)} ${'Messages'.padStart(8)}  ${'Coins'.padStart(8)}`);
console.log(`  ${'─'.repeat(25)} ${'─'.repeat(20)} ${'─'.repeat(8)}  ${'─'.repeat(8)}`);

for (const r of results) {
    console.log(`  ${r.username.padEnd(25)} ${r.key.padEnd(20)} ${String(r.messages).padStart(8)}  ${String(r.coins).padStart(8)}`);
}

console.log('');
console.log(`  Created: ${created} | Skipped (existing key): ${skippedExisting} | Skipped (registered): ${skippedRegistered}`);
console.log('═'.repeat(80));

// Write JSON for easy lookup
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
console.log(`\n[LegacyKeys] ✅ Keys saved to ${outputPath}`);
console.log('[LegacyKeys] Send each user their key — they enter it on the signup screen.\n');

rsDb.close();
openvibeDb.close();
