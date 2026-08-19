// Open Session Chrome extension — background service worker.
//
// Deliberately tiny: the side panel (sidepanel.js) drives captures itself via
// chrome.scripting/chrome.tabs (extension pages have full API access). The
// worker only owns the bits that need a persistent-ish registration: opening
// the panel from the toolbar icon, and the right-click "Send to OS"
// entry that seeds the composer with the page/selection context.

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => {});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "os1-send",
      title: "Send to OS",
      contexts: ["page", "selection", "image"],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "os1-send" || !tab?.id) return;
  // Seed the composer. storage.session survives until the browser closes and
  // the panel reads + clears it on focus/open.
  chrome.storage.session.set({
    pendingContext: {
      url: info.pageUrl || tab.url || "",
      title: tab.title || "",
      selection: info.selectionText || "",
      imageUrl: info.srcUrl || "",
      at: Date.now(),
    },
  });
  chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
});
