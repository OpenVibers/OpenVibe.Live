'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
let config, opens = 0, refreshes = 0, inits = 0;
const context = { window: { OpenVibeNavbar: {
    init(c) { config = c; inits++; }, setActive() {}, updateLink() {},
    openWallet() { opens++; }, refreshWallet() { refreshes++; },
} }, document: { readyState: 'loading', addEventListener() {} }, currentUser: null };
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/ov-navbar-live.js'), 'utf8'), context);
context.window.LiveNav.sync({ id: 1, username: 'alice' });
assert.strictEqual(config.wallet, true);
assert.strictEqual(config.chips, undefined, 'Live does not override the shared balances');
// The purse (Shared 4.212.0, ask 273): on a channel page the wallet pill catches up that channel's points too. The
// streamer is the channel owner's numeric user id (app-channel.js reads ch.user_id after the channel data loads);
// elsewhere the bar passes nothing, so /wallet/changes carries no streamer.
assert.strictEqual(config.purse.streamer, undefined, 'no channel page: the purse gets no streamer');
context.window.LiveNav.setStreamer('alice');
assert.strictEqual(config.purse.streamer, undefined, 'a non-numeric id is not a streamer');
context.window.LiveNav.setStreamer(0);
assert.strictEqual(config.purse.streamer, undefined, 'zero is not a streamer');
context.window.LiveNav.setStreamer('42');
assert.strictEqual(config.purse.streamer, 42, 'the channel\'s numeric owner id reaches the purse');
assert.strictEqual(refreshes, 1, 'the wallet catches up at once instead of waiting for the 60s chip cache');
assert.strictEqual(inits, 1, 'the bar is not re-rendered for it');
context.window.LiveNav.setStreamer('42');
assert.strictEqual(refreshes, 1, 'the same streamer does not fetch twice');
context.window.LiveNav.setStreamer(null);
assert.strictEqual(config.purse.streamer, undefined, 'leaving the channel clears it');
assert.strictEqual(refreshes, 1, 'leaving a channel does not fetch again');
assert.strictEqual(config.purse.streamer, undefined, 'the purse is the same object, so the navbar sees the clear');
// The page wires it: app-channel.js after the channel data, app.js for every page that is not a channel.
const page = fs.readFileSync(path.join(__dirname, '../public/js/app-channel.js'), 'utf8');
assert.match(page, /const ch = data\.channel;\n[\s\S]{0,400}LiveNav\.setStreamer\(ch\.user_id\)/, 'a channel page passes ch.user_id once it loads');
const appSrc = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
assert.match(appSrc, /page !== 'channel'\) window\.LiveNav\.setStreamer\(null\)/, 'every other page passes no streamer');
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
// The wallet sheet and the navbar's openWallet/refreshWallet arrived in openvibe-shared 4.170.0: a pin below it threw
// "refreshWallet is not a function" in onAuthChange for every signed-in person (2026-11-09, Live #717 on 4.168.0).
const pin = /refs\/tags\/v(\d+)\.(\d+)\.(\d+)/.exec(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).dependencies['openvibe-shared']);
assert(pin && (Number(pin[1]) > 4 || (Number(pin[1]) === 4 && Number(pin[2]) >= 170)), 'openvibe-shared is pinned at 4.170.0 or later');
assert(/typeof window\.OpenVibeNavbar\.refreshWallet === 'function'\) window\.OpenVibeNavbar\.refreshWallet\(\)/.test(appSrc),
    'sign-in never stops on a navbar without the wallet');
console.log('Live delegates wallet and store to Shared, retaining cosmetic renderers and channel actions');
