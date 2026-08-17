/**
 * Content script injected into openvibe.live/kiosk. It is the bridge between
 * the page (which can't read history) and the background script (which can):
 *
 *   page  --postMessage(history-query)-->  this  --runtime.sendMessage-->  background
 *   page  <--postMessage(history-result)--  this  <--response--------------  background
 *
 * Only same-origin page messages are honoured, and replies are posted back with
 * the page's own origin as targetOrigin, so history never leaks to other sites.
 */
const api = (typeof browser !== "undefined") ? browser : chrome;
const ORIGIN = window.location.origin;

function announce() {
  window.postMessage({ source: "openvibe-kiosk-ext", type: "ready" }, ORIGIN);
}
// Announce both immediately and once the page's listener is surely attached.
announce();
window.addEventListener("DOMContentLoaded", announce);

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const d = event.data;
  if (!d || d.source !== "openvibe-kiosk") return;

  if (d.type === "ping") { announce(); return; }

  if (d.type === "history-query") {
    const { q, id } = d;
    api.runtime.sendMessage({ type: "openvibe-history-query", q })
      .then((resp) => {
        window.postMessage({ source: "openvibe-kiosk-ext", type: "history-result", id, q, items: (resp && resp.items) || [] }, ORIGIN);
      })
      .catch(() => {
        window.postMessage({ source: "openvibe-kiosk-ext", type: "history-result", id, q, items: [] }, ORIGIN);
      });
  }
});
