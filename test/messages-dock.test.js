'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

for (const file of ['public/js/messenger.js', 'public/css/messenger.css']) {
    assert.ok(!fs.existsSync(path.join(root, file)), `${file} is removed`);
}

const features = JSON.stringify(JSON.parse(read('public/features.json')));
assert.ok(!/messenger/i.test(features), 'the lazy feature registry no longer loads the local messenger');

for (const file of ['public/index.html', 'public/js/app.js', 'public/js/ov-navbar-live.js']) {
    assert.ok(!/messenger/i.test(read(file)), `${file} does not load or open the local messenger`);
}

console.log('messages Dock: the local messenger assets and entry points are removed');
