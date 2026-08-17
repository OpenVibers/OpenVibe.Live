/**
 * Background script — the only context allowed to touch browser.history.
 * The content script (history-bridge.js) relays the kiosk page's queries here,
 * we search history, and return ranked matches. Nothing leaves the browser.
 */
const api = (typeof browser !== "undefined") ? browser : chrome;

api.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== "openvibe-history-query") return;
  const q = String(msg.q || "").trim();
  if (!q) return Promise.resolve({ items: [] });

  return api.history.search({
    text: q,
    maxResults: 30,
    startTime: 0            // search all of history
  }).then((results) => {
    const seen = new Set();
    const items = (results || [])
      .filter((r) => r.url && /^https?:/i.test(r.url))
      .map((r) => ({
        url: r.url,
        title: r.title || "",
        visitCount: r.visitCount || 0,
        lastVisit: r.lastVisitTime || 0
      }))
      // Rank by how often + how recently you've visited.
      .sort((a, b) => (b.visitCount - a.visitCount) || (b.lastVisit - a.lastVisit))
      .filter((r) => (seen.has(r.url) ? false : (seen.add(r.url), true)))
      .slice(0, 8);
    return { items };
  }).catch(() => ({ items: [] }));
});
