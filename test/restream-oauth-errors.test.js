/**
 * A provider that refuses a restream sign-in says what to do (server/streaming/restream-routes.js). Twitch answers
 * "redirect_mismatch — The provided redirect_uri does not match" when its developer app does not list this site's
 * callback; the owner tried to connect Twitch four times on 2026-10-16 and saw only that sentence. The page now names
 * the exact URL to add and the hand-pasted key as the way meanwhile. Other errors pass through as the provider wrote
 * them.
 *
 *   node test/restream-oauth-errors.test.js
 */
'use strict';
const assert = require('assert');
const { oauthErrorText } = require('../server/streaming/restream-routes');
const { redirectUri } = require('../server/integrations/platform-oauth');

const twitch = oauthErrorText('twitch', 'redirect_mismatch', 'The provided redirect_uri does not match');
assert.ok(twitch.startsWith('Twitch refused the sign-in because this site\'s address is not on its app\'s list.'), twitch);
assert.ok(twitch.includes(redirectUri('twitch')) && /\/api\/restream\/oauth\/twitch\/callback/.test(twitch), 'names the exact URL to add');
assert.ok(/paste the stream key into the destination by hand/.test(twitch), 'and the way meanwhile');
assert.ok(/YouTube refused the sign-in/.test(oauthErrorText('youtube', 'invalid_request', 'Invalid parameter value for redirect_uri: Mismatch')), 'a description about the redirect URI counts too');
assert.strictEqual(oauthErrorText('kick', 'access_denied', 'The user denied the request'), 'The user denied the request', 'other errors pass through');
assert.strictEqual(oauthErrorText('kick', 'access_denied', ''), 'access_denied');
console.log('restream oauth errors: all checks passed');
