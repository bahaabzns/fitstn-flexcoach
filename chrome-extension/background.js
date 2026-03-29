const CHAT_URL_PATTERN = "https://fitstn.flexcoach.app/dashboard/chat";

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  if (trackedTabs.has(tabId)) {
    trackedTabs.delete(tabId);
    fetch("http://localhost:3000/api/close-session", { method: "POST" }).catch(() => {});
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    if (changeInfo.url.startsWith(CHAT_URL_PATTERN)) {
      trackedTabs.add(tabId);
    } else if (trackedTabs.has(tabId)) {
      trackedTabs.delete(tabId);
      fetch("http://localhost:3000/api/close-session", { method: "POST" }).catch(() => {});
    }
  }
});

const trackedTabs = new Set();

// Track tabs that already have the chat page open when the extension loads
chrome.tabs.query({ url: CHAT_URL_PATTERN + "*" }, (tabs) => {
  tabs.forEach((tab) => trackedTabs.add(tab.id));
});
