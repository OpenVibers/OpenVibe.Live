// Open the kiosk with the PAGE focused instead of the address bar.
//
// The trick (same one the "Custom New Tab" extensions use): simply navigating this
// temporary new-tab tab to a URL leaves focus on the address bar. But opening the URL
// in a FRESH tab and then closing this temporary tab makes Firefox focus the web page —
// so the kiosk's omnibar input gets the caret. Falls back to a plain redirect if the
// tabs API isn't available.
const api = (typeof browser !== "undefined") ? browser : chrome;
const TARGET = "https://openvibe.live/kiosk#input";

(async () => {
  try {
    const tab = await api.tabs.getCurrent();
    if (!tab || tab.id == null) { location.replace(TARGET); return; }

    const created = await api.tabs.create({
      url: TARGET,
      index: tab.index,
      windowId: tab.windowId,
      active: true
    });

    // Keep the replacement in the same tab group, if any (best-effort).
    if (api.tabs.group && tab.groupId != null && tab.groupId > -1) {
      try { await api.tabs.group({ groupId: tab.groupId, tabIds: created.id }); } catch (e) { /* ignore */ }
    }

    await api.tabs.remove(tab.id);
    try { api.history.deleteUrl({ url: location.href }); } catch (e) { /* ignore */ }
  } catch (e) {
    location.replace(TARGET); // fallback: at least land on the kiosk
  }
})();
