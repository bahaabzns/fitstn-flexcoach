importScripts("config.js");

const CHAT_URL_PATTERN = "https://fitstn.flexcoach.app/dashboard/chat";
const trackedTabs = new Set();

function getToken() {
    return new Promise((resolve) => {
        chrome.storage.local.get(["agentToken"], (result) => {
            resolve(result.agentToken || null);
        });
    });
}

async function closeSession() {
    const token = await getToken();
    if (!token) return;
    fetch(API_BASE + "/api/close-session", {
        method: "POST",
        headers: { Authorization: "Bearer " + token },
    }).catch(() => {});
}

chrome.tabs.onRemoved.addListener((tabId) => {
    if (trackedTabs.has(tabId)) {
        trackedTabs.delete(tabId);
        closeSession();
    }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.url) {
        if (changeInfo.url.startsWith(CHAT_URL_PATTERN)) {
            trackedTabs.add(tabId);
        } else if (trackedTabs.has(tabId)) {
            trackedTabs.delete(tabId);
            closeSession();
        }
    }
});

// Track tabs that already have the chat page open when the extension loads
chrome.tabs.query({ url: CHAT_URL_PATTERN + "*" }, (tabs) => {
    tabs.forEach((tab) => trackedTabs.add(tab.id));
});

// --- Status popup window ---
let statusWindowId = null;

chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === "closeSession") {
        closeSession();
        return;
    }
    if (msg.action === "openStatusPopup") {
        // If already open, focus it
        if (statusWindowId !== null) {
            chrome.windows.get(statusWindowId, (win) => {
                if (chrome.runtime.lastError || !win) {
                    statusWindowId = null;
                    createStatusWindow();
                } else {
                    chrome.windows.update(statusWindowId, { focused: true });
                }
            });
        } else {
            createStatusWindow();
        }
    }
});

function createStatusWindow() {
    chrome.windows.create({
        url: chrome.runtime.getURL("status-popup.html"),
        type: "popup",
        width: 250,
        height: 100,
        top: 80,
        left: Math.round(screen.availWidth - 270),
    }, (win) => {
        statusWindowId = win.id;
    });
}

chrome.windows.onRemoved.addListener((winId) => {
    if (winId === statusWindowId) statusWindowId = null;
});
