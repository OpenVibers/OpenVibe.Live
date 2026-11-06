'use strict';
/**
 * The desk's last frame: one JPEG or WebP per agent stream, under DATA_DIR/agent-frames (server/paths.js, never a
 * literal directory). It is the card's picture and the task page's still while the desk is not encoding.
 *
 * Writes are atomic (a temporary sibling then a rename), so a viewer never reads half a picture; reads never create a
 * file. The file name is the stream's own public id, which the route has already matched against a row — nothing a
 * caller sends becomes a path.
 */
const fs = require('fs');
const path = require('path');

const DIR = require('../paths').dir('AGENT_FRAMES_PATH', 'agent-frames');

function fileFor(name) {
    // Public ids only (ags_<ULID>.<jpg|webp>); anything else is not a frame this service wrote.
    if (!/^ags_[0-9A-HJKMNP-TV-Z]{26}\.(jpg|webp)$/.test(String(name || ''))) return null;
    return { path: path.join(DIR, name), type: name.endsWith('.webp') ? 'image/webp' : 'image/jpeg' };
}

async function write(name, bytes) {
    fs.mkdirSync(DIR, { recursive: true });
    const file = fileFor(name);
    if (!file) throw new TypeError('not a frame name');
    const tmp = `${file.path}.${process.pid}.${Date.now()}.tmp`;
    await fs.promises.writeFile(tmp, bytes);
    await fs.promises.rename(tmp, file.path);
    return file;
}

/** The stored picture for a row's last_frame_path, or null when there is none. */
async function read(name) {
    const file = fileFor(name);
    if (!file) return null;
    try {
        const bytes = await fs.promises.readFile(file.path);
        return { bytes, type: file.type };
    } catch {
        return null;
    }
}

module.exports = { DIR, fileFor, write, read };
