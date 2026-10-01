#!/usr/bin/env node
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

async function main() {
    const url = process.env.DATABASE_DIRECT_URL;
    if (!url) throw new Error('DATABASE_DIRECT_URL is required for the analytics PostgreSQL migration');
    const { createDb } = require('openvibe-sdk/db');
    const db = createDb({ url, service: 'live-analytics-migrate' });
    try {
        const result = await db.migrate({ dir: path.join(__dirname, '..', 'migrations') });
        console.log(`[Analytics] migrations applied: ${result.applied.length}; held: ${result.held.length}`);
    } finally {
        await db.close();
    }
}

if (require.main === module) main().catch((err) => { console.error(err); process.exitCode = 1; });
module.exports = { main };
