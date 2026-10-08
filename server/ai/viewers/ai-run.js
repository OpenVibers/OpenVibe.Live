/**
 * AI viewers' runs on OpenVibe.AI (roadmap WS-O task 2). The director's rules, the fast reply, the memory fold and
 * the clone brief are AI's versioned templates live.viewers.*; Live sends the context it builds (roster, settings,
 * transcript, chat, memories).
 *
 * provider: null = the site's AI (the admin switch and the daily budget apply); { credentialSubject } = the
 * streamer's own key stored in OpenVibe.AI (a run with credential { subject }, metered as 'byo'); anything else —
 * a key that never moved to AI, or none — keeps the streamer's viewers quiet, never falling back to the site's AI.
 */
'use strict';
const aiService = require('../ai-service');
const llm = require('../llm');

/** → { output, usage: { input, output, cached }, model, cost, latencyMs } or null (quiet). */
async function viewerRun(workflow, input, { provider = null, ownerUserId = null, kind, role }) {
    const own = provider ? provider.credentialSubject : null;
    if (provider && !own) return null;
    if (!aiService.enabled()) return null;
    if (!own && !(await llm.isEnabled() && await llm.withinBudget())) return null;
    const started = Date.now();
    const r = await aiService.run(workflow, input, { attribution: aiService.ownerRef(ownerUserId), credentialSubject: own || null, waitMs: 60000 });
    await aiService.meter(r, { kind, role, ownerUserId, source: 'ai_viewers', provider: own ? 'byo' : 'openvibe-ai' });
    const output = aiService.usable(r);
    if (!output) return null;
    return {
        output,
        usage: { input: (r.usage && r.usage.tokens_in) || 0, output: (r.usage && r.usage.tokens_out) || 0, cached: 0 },
        model: (r.provenance && r.provenance.model) || null, cost: (r.usage && r.usage.cost_usd) || 0, latencyMs: Date.now() - started,
    };
}

module.exports = { viewerRun };
