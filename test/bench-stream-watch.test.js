'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { publicBenchPoll } = require('../server/web/serializers');

class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.attrs = {}; this.hidden = true; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute(key, value) { this.attrs[key] = value; }
    set innerHTML(value) { throw new Error('Entry content must not become page HTML'); }
}

(async () => {
    const panel = new Element('section');
    let refresh;
    let poll = { round_id: 'brd_test', stream_id: 17, kind_id: 'design.page', prompt: '<script>prompt</script>', status: 'open',
        closes_at: new Date(Date.now() + 30000).toISOString(), entries: [
            { payload: { html: '<h1>First</h1><script>parent.stolen = true</script>' } },
            { payload: { result: { move: 'Second' }, reply: '<img src=x onerror=alert(1)>' } },
        ] };
    const context = vm.createContext({
        document: { getElementById: () => panel, createElement: (tag) => new Element(tag) },
        currentChannelUsername: 'streamer', currentStreamId: 17, location: { pathname: '/@streamer' },
        api: async () => ({ poll }), setInterval: (fn) => { refresh = fn; },
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/bench-stream-watch.js'), 'utf8'), context);
    await new Promise(setImmediate);
    assert.strictEqual(panel.hidden, false);
    assert.strictEqual(panel.children[1].textContent, '<script>prompt</script>');
    const entries = panel.children.filter((e) => e.tagName === 'article');
    assert.strictEqual(entries.length, 2);
    const frame = entries[0].children.find((e) => e.tagName === 'iframe');
    assert.strictEqual(frame.attrs.sandbox, '');
    assert.strictEqual(frame.attrs.referrerpolicy, 'no-referrer');
    assert.ok(frame.srcdoc.includes("default-src 'none'; style-src 'unsafe-inline'; img-src data:"));
    assert.ok(entries[1].children.some((e) => e.tagName === 'pre' && e.textContent.includes('Second')));
    assert.ok(entries[1].children.some((e) => e.tagName === 'p' && e.textContent.includes('<img')));
    await refresh();
    assert.strictEqual(panel.children[3], entries[0], 'polling keeps the existing iframe');

    poll = { ...poll, status: 'closed', vote_counts: { left: 2, right: 1, tie: 0, voters: 3 } };
    await refresh();
    assert.ok(panel.children[2].textContent.includes('3 voters'));
    context.currentStreamId = 18;
    await refresh();
    assert.strictEqual(panel.hidden, true, 'an old stream cannot show its poll on a new stream');

    let answer;
    context.currentStreamId = 17;
    context.api = () => new Promise((resolve) => { answer = resolve; });
    const pending = refresh();
    context.currentChannelUsername = 'another';
    answer({ poll });
    await pending;
    assert.strictEqual(panel.hidden, true, 'a late response cannot replace another channel');

    const publicRow = publicBenchPoll({ ...poll, streamer_id: 31, user_id: 32, secret: 'private' });
    assert.strictEqual(publicRow.streamer_id, undefined);
    assert.strictEqual(publicRow.user_id, undefined);
    assert.strictEqual(publicRow.secret, undefined);
    console.log('✅ Bench watch: two entries, sandbox and CSP, safe text, results, stream isolation, private row fields');
})().catch((err) => { console.error(err); process.exitCode = 1; });
