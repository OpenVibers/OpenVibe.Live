'use strict';
/**
 * Binding a robot to your channel's chat from openvibe.bot (public/js/bot-bind.js, feature "botBind"): a robot approved
 * on openvibe.bot/link (the one command on its computer) links to the owner's channel with ?bind_robot=rob_…, and the
 * owner confirms there. Only a robot id the bind route accepts is offered; the request is the existing owner-only
 * PUT /api/streams/channel/:username/bot; the channel page loads the feature only for that address, on its owner's view.
 *
 *   node test/bot-bind.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const BotBind = require('../public/js/bot-bind.js');
const embed = require('../server/bot/embed');

assert.strictEqual(BotBind.robotFrom('?bind_robot=rob_01M588DQNK3B438P6KP48GE693'), 'rob_01M588DQNK3B438P6KP48GE693');
assert.strictEqual(BotBind.robotFrom('?x=1&bind_robot=rob_01M588DQNK3B438P6KP48GE693&y=2'), 'rob_01M588DQNK3B438P6KP48GE693');
for (const bad of ['', '?bind_robot=', '?bind_robot=dev_01M5', '?bind_robot=rob_%3Cscript%3E', '?bind_robot=rob_1', null]) {
    assert.strictEqual(BotBind.robotFrom(bad), null, String(bad));
}
// Whatever robotFrom offers, the bind route takes (server/bot/embed.js validRobotId).
assert.ok(embed.validRobotId(BotBind.robotFrom('?bind_robot=rob_01M588DQNK3B438P6KP48GE693')));

assert.deepStrictEqual(BotBind.bindRequest('goosely', 'rob_01M5'), { path: '/streams/channel/goosely/bot', opts: { method: 'PUT', body: { robot_id: 'rob_01M5' } } });
assert.strictEqual(BotBind.bindRequest('a b/c', 'rob_x').path, '/streams/channel/a%20b%2Fc/bot', 'the username is one path segment');

const features = JSON.parse(fs.readFileSync(path.join(__dirname, '../public/features.json'), 'utf8'));
assert.deepStrictEqual(features.features.botBind, { js: ['/js/bot-bind.js'] });
const channel = fs.readFileSync(path.join(__dirname, '../public/js/app-channel.js'), 'utf8');
assert.match(channel, /_offerBotBind\(username\);/);
assert.match(channel, /currentUser\.username === username/, 'offered on the owner\'s own channel only');
assert.match(channel, /ov\.load\('botBind'\)/, 'loaded only for that address');
assert.ok(!/innerHTML/.test(fs.readFileSync(path.join(__dirname, '../public/js/bot-bind.js'), 'utf8')), 'built from nodes, never markup');

console.log('bot-bind: ok');
