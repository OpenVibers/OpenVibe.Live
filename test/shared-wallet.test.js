'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
let config, opens = 0, refreshes = 0;
const context = { window: { OpenVibeNavbar: {
    init(c) { config = c; }, setActive() {}, updateLink() {},
    openWallet() { opens++; }, refreshWallet() { refreshes++; },
} }, document: { readyState: 'loading', addEventListener() {} }, currentUser: null };
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/ov-navbar-live.js'), 'utf8'), context);
context.window.LiveNav.sync({ id: 1, username: 'alice' });
assert.strictEqual(config.wallet, true);
assert.strictEqual(config.chips, undefined, 'Live does not override the shared balances');
const wallet = config.menu.sections.flatMap((s) => s.items).find((i) => i.id === 'wallet');
wallet.onClick(); assert.strictEqual(opens, 1);
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
assert(!html.includes('id="cosmetics-modal"'));
assert(!fs.existsSync(path.join(root, 'public/js/cosmetics-ui.js')));
const vibes = fs.readFileSync(path.join(root, 'public/js/vibes.js'), 'utf8');
assert(!vibes.includes('openvibeBucksBuyModal') && !vibes.includes('/payments/bucks/checkout'));
assert(vibes.includes('window.OpenVibeNavbar.openWallet()'));
const security = fs.readFileSync(path.join(root, 'server/index.js'), 'utf8');
assert(!security.includes('"https://billing.openvibe.network"') && !security.includes('"https://inventory.openvibe.network"'),
    'the shared wallet asks Network\'s relays, so connect-src needs neither host');
console.log('Live delegates wallet and store to Shared, retaining cosmetic renderers and channel actions');
