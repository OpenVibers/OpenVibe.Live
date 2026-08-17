'use strict';
const Database = require('better-sqlite3');
const path = require('path');

const dbPath = process.env.DB_PATH || path.join(__dirname, '../data/live.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 10000');

const tableInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='stream_controls'").get();
if (tableInfo && tableInfo.sql && !tableInfo.sql.includes("'keyboard'")) {
    console.log('[Migration] stream_controls missing keyboard type — migrating...');
    db.exec(`
        CREATE TABLE IF NOT EXISTS stream_controls_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            stream_id INTEGER NOT NULL,
            label TEXT NOT NULL,
            command TEXT NOT NULL,
            icon TEXT DEFAULT 'fa-gamepad',
            control_type TEXT DEFAULT 'button' CHECK(control_type IN ('button', 'toggle', 'slider', 'dpad', 'onvif', 'keyboard')),
            key_binding TEXT,
            cooldown_ms INTEGER DEFAULT 500,
            is_enabled INTEGER DEFAULT 1,
            sort_order INTEGER DEFAULT 0,
            camera_id INTEGER,
            onvif_movement TEXT,
            btn_color TEXT DEFAULT '',
            btn_bg TEXT DEFAULT '',
            btn_border_color TEXT DEFAULT '',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (stream_id) REFERENCES streams(id) ON DELETE CASCADE
        );
        INSERT INTO stream_controls_new
            SELECT id, stream_id, label, command, icon, control_type, key_binding,
                   cooldown_ms, is_enabled, sort_order, NULL, NULL,
                   btn_color, btn_bg, btn_border_color, created_at
            FROM stream_controls;
        DROP TABLE stream_controls;
        ALTER TABLE stream_controls_new RENAME TO stream_controls;
    `);
    console.log('[Migration] Done — keyboard type now allowed in stream_controls');
} else {
    console.log('[Migration] stream_controls already has keyboard type — skipping');
}

// Now apply config 14 (Cozmo) to stream 1123
const streamId = parseInt(process.argv[2] || '0');
if (streamId) {
    // delete existing non-onvif controls
    db.prepare('DELETE FROM stream_controls WHERE stream_id = ? AND (control_type != ? OR control_type IS NULL)').run(streamId, 'onvif');
    const buttons = db.prepare('SELECT * FROM control_config_buttons WHERE config_id = ? ORDER BY sort_order').all(14);
    let count = 0;
    for (let i = 0; i < buttons.length; i++) {
        const b = buttons[i];
        if (!b.is_enabled) continue;
        db.prepare(`INSERT INTO stream_controls (stream_id, label, command, icon, control_type, key_binding, cooldown_ms, sort_order, btn_color, btn_bg, btn_border_color)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            streamId, b.label, b.command, b.icon || 'fa-gamepad', b.control_type, b.key_binding || null,
            b.cooldown_ms || 100, b.sort_order || i, b.btn_color || '', b.btn_bg || '', b.btn_border_color || ''
        );
        count++;
    }
    db.prepare('UPDATE streams SET control_config_id = ? WHERE id = ?').run(14, streamId);
    const controls = db.prepare('SELECT * FROM stream_controls WHERE stream_id = ? ORDER BY sort_order').all(streamId);
    console.log(`[Apply] Inserted ${count} buttons for stream ${streamId}. Total controls: ${controls.length}`);
    controls.forEach(c => console.log(`  [${c.id}] ${c.label} (${c.control_type}) cmd=${c.command}`));
}

db.close();
