/**
 * OpenVibe.Live — Cozmo Control Presets
 *
 * Provides a factory to bulk-create Cozmo-specific stream controls.
 * These map 1:1 to the commands understood by scripts/cozmo-bridge.py.
 */
'use strict';

const db = require('../db/database');

/** Cozmo control definitions — order matches sort_order. */
const COZMO_PRESETS = [
    // D-Pad movement
    { label: 'Forward',    command: 'forward',    icon: 'fa-arrow-up',           control_type: 'dpad',   key_binding: 'w', cooldown_ms: 400 },
    { label: 'Backward',   command: 'backward',   icon: 'fa-arrow-down',         control_type: 'dpad',   key_binding: 's', cooldown_ms: 400 },
    { label: 'Turn Left',  command: 'turn_left',  icon: 'fa-arrow-left',         control_type: 'dpad',   key_binding: 'a', cooldown_ms: 400 },
    { label: 'Turn Right', command: 'turn_right', icon: 'fa-arrow-right',        control_type: 'dpad',   key_binding: 'd', cooldown_ms: 400 },
    // Lift
    { label: 'Lift Up',    command: 'lift_up',    icon: 'fa-angles-up',          control_type: 'button', key_binding: 'e', cooldown_ms: 500 },
    { label: 'Lift Down',  command: 'lift_down',  icon: 'fa-angles-down',        control_type: 'button', key_binding: 'q', cooldown_ms: 500 },
    // Head
    { label: 'Head Up',    command: 'head_up',    icon: 'fa-circle-chevron-up',  control_type: 'button', key_binding: 'r', cooldown_ms: 500 },
    { label: 'Head Down',  command: 'head_down',  icon: 'fa-circle-chevron-down',control_type: 'button', key_binding: 'f', cooldown_ms: 500 },
];

/**
 * Apply Cozmo presets to a stream.
 * Skips any control whose command already exists on the stream.
 * @param {number} streamId
 * @returns {{ added: number, skipped: number }}
 */
function applyCozmoPresets(streamId) {
    const existing = db.getStreamControls(streamId);
    const existingCmds = new Set(existing.map(c => c.command));

    let added = 0, skipped = 0;

    for (let i = 0; i < COZMO_PRESETS.length; i++) {
        const preset = COZMO_PRESETS[i];
        if (existingCmds.has(preset.command)) {
            skipped++;
            continue;
        }
        db.createControl({
            stream_id: streamId,
            label: preset.label,
            command: preset.command,
            icon: preset.icon,
            control_type: preset.control_type,
            key_binding: preset.key_binding,
            cooldown_ms: preset.cooldown_ms,
        });
        added++;
    }

    return { added, skipped };
}

/**
 * Remove all Cozmo preset controls from a stream.
 * @param {number} streamId
 * @returns {number} Number of controls removed.
 */
function removeCozmoPresets(streamId) {
    const cmds = COZMO_PRESETS.map(p => p.command);
    const placeholders = cmds.map(() => '?').join(',');
    const result = db.run(
        `DELETE FROM stream_controls WHERE stream_id = ? AND command IN (${placeholders})`,
        [streamId, ...cmds]
    );
    return result?.changes || 0;
}

module.exports = { COZMO_PRESETS, applyCozmoPresets, removeCozmoPresets };
