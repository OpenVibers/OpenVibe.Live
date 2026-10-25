'use strict';
/**
 * What streamers said, as the home page's "Lately on OpenVibe" strip quotes it: the front page of the site, read by
 * everyone who arrives. A quote with a slur, strong profanity (English, Portuguese, Spanish, French, German) or a hate
 * topic out of context is left off it; the next best take is shown instead. The Rundown keeps every take as said.
 *
 * The rule is the platform's own since openvibe-sdk 0.64.0 (openvibe-sdk/front-page, moved from here: Live#345/#346),
 * so Community's "Most viewed" and every other front page judge the same way.
 */
module.exports = { frontPageOk: require('openvibe-sdk/front-page').frontPageOk };
