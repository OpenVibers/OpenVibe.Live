'use strict';
/**
 * Buttons for your viewers on the dashboard (Controls tab): the streamer's Elements library, which Live #842 shipped
 * as an API with no page (the 11-12 review: Design's "Install" put elements in a library nobody could see, and the
 * deck stayed off). The card turns the deck on, turns each button on or off, removes one, and says where to get more.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const html = read('public/fragments/dashboard.html');
const js = read('public/js/dashboard.js');
const css = read('public/css/features/dashboard.css');

assert.ok(html.includes('id="dash-card-elements"') && html.includes('Buttons for your viewers'), 'the card is in the dashboard');
assert.ok(/controls:\s*\['dash-card-elements'/.test(js), 'first on the Controls tab');
assert.ok(/_dashTabLoaders\.controls = \(\) => \{ loadDashElements\(\);/.test(js), 'loaded when Controls opens');
for (const call of ["api('/me/elements')", "api('/me/elements/settings', { method: 'PUT'", "{ method: 'PATCH', body: { active: on.checked } }", "{ method: 'DELETE' }"])
    assert.ok(js.includes(call), `calls ${call}`);
assert.ok(!js.includes("api('/api/me/elements") && !js.includes('api(`/api/me/elements'), 'api() adds /api itself');
assert.ok(html.includes('https://openvibe.design/create?kind=element') && html.includes('https://openvibe.design/gallery'), 'where to get more: made with AI, or free in the gallery');
// Names and labels come from what people made: text nodes, never markup.
const card = js.slice(js.indexOf('function _dashElNode'), js.indexOf('async function loadDashElements'));
assert.ok(!/innerHTML\s*=\s*`[^`]*\$\{e\./.test(card) && !/innerHTML\s*=\s*[^;]*\be\.(name|look|description)/.test(card), 'no element text goes in as markup');
assert.ok(css.includes('.dash-el-row') && css.includes('.dash-el-del { display: grid; place-items: center; width: 44px; height: 44px;'), 'the rows and a 44 px remove button');
console.log('dashboard-elements: the streamer sees, turns on and removes the buttons viewers press');
