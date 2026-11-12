'use strict';
/**
 * Recorded OpenVibe.AI image answers (no network): a 1×1 PNG is the smallest real image the image route can answer,
 * enough for the resize to prove itself; the refusal is the provider's safety-system 400 as it came back.
 */
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4S8AAAAASUVORK5CYII=';

const IMAGE_RESPONSE = JSON.stringify({
    id: 'run_pic_fixture',
    created: 1794467559,
    data: [{ b64_json: PNG_1X1 }],
    usage: { prompt_tokens: 0, completion_tokens: 1 },
    x_openvibe: { run_id: 'run_pic_fixture', cost_usd: 0.042, provider: 'openai' },
});

const REFUSAL_RESPONSE = JSON.stringify({
    error: { code: 'provider.http', message: 'Your request was rejected by the safety system (content policy).' },
});

module.exports = { PNG_1X1, IMAGE_RESPONSE, REFUSAL_RESPONSE };
