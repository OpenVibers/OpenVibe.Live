'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'public/js/settings.js'), 'utf8');
function functionSource(name) {
    const at = src.indexOf(`async function ${name}(`);
    assert.ok(at >= 0, `${name} exists`);
    let depth = 0;
    for (let i = src.indexOf('{', at); i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1);
    }
    throw new Error(`${name} has no closing brace`);
}

(async () => {
    const calls = [], notices = [], renders = [], changes = [];
    const currentUser = { avatar_url: '/old.png' };
    const context = {
        encodeURIComponent,
        api: async (...args) => { calls.push(args); return { avatar_url: '/new.png' }; },
        toast: (...args) => notices.push(args),
        currentUser,
        _renderSettingsAvatar: (user) => renders.push(user),
        _loadAvatarHistory: () => changes.push('history'),
        onAuthChange: () => changes.push('auth'),
    };
    vm.runInNewContext(`${functionSource('reuseAvatarObject')}\nreuseAvatarObject('object/one')`, context);
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0][0], '/auth/avatar/object/object%2Fone');
    assert.strictEqual(calls[0][1].method, 'POST');
    assert.strictEqual(currentUser.avatar_url, '/new.png');
    assert.strictEqual(notices[0][0], 'Avatar updated');
    assert.strictEqual(notices[0][1], 'success');
    assert.deepStrictEqual(renders, [currentUser]);
    assert.deepStrictEqual(changes, ['history', 'auth']);
})().catch((err) => { console.error(err); process.exitCode = 1; });
