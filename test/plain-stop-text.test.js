'use strict';
// These are small hobby robots: no page, doc or AGENTS.md says E-STOP, estop or emergency stop. Inline code
// names a legacy protocol field and is skipped.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const files = ['AGENTS.md', 'README.md', 'STATUS.json'].map((f) => path.join(root, f)).filter((f) => fs.existsSync(f));
const walk = (dir, ext) => {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        if (fs.statSync(p).isDirectory()) walk(p, ext);
        else if (p.endsWith(ext)) files.push(p);
    }
};
walk(path.join(root, 'docs'), '.md');
walk(path.join(root, 'public', 'fragments'), '.html');
const bad = /(^|[^A-Za-z])e-?stop([^A-Za-z]|$)|emergency\s+stop/i;
for (const file of files) {
    let text = fs.readFileSync(file, 'utf8');
    text = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '')
        .replace(/<pre[\s\S]*?<\/pre>/gi, '').replace(/<code[\s\S]*?<\/code>/gi, '');
    assert.ok(!bad.test(text), `${path.relative(root, file)} says E-STOP; write Stop`);
}
console.log('plain-stop-text: no page, doc or AGENTS.md says E-STOP');
