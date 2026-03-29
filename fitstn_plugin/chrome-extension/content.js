const CHATS_SELECTOR =
  "html body div main div div:first-child div div:last-child div div div div[class='flex items-start gap-3 p-3 cursor-pointer transition-colors hover:bg-muted/50']";

const API_URL = "http://localhost:3000/api/chat-click";
const API_BASE = "http://localhost:3000";

let currentToken = null;
let observer = null;
let sessionTimer = null;
let sessionStartTime = null;
let maxSessionSeconds = 30 * 60; // default 30 min, updated from server
let statusInterval = null;
let messageInterceptorAttached = false;
let currentStatus = null;

const isChatPage = location.pathname.startsWith("/dashboard/chat");

// Native browser confirmation on tab close / reload — only on chat pages, only if signed in and on shift
if (isChatPage) {
    window.addEventListener("beforeunload", (event) => {
        if (isAgentSignedInAndOnShift()) {
            event.preventDefault();
            event.returnValue = "";
        }
    });
}

// Always show status badge on every page
createStatusBadge();

// Get token from storage on load
chrome.storage.local.get(["agentToken"], (result) => {
    currentToken = result.agentToken || null;
    if (currentToken) {
        if (isChatPage) { attachClickHandlers(); attachMessageInterceptor(); startObserver(); interceptNavigationLinks(); }
        startStatusPolling();
    } else {
        showNotSignedIn();
    }
});

// Listen for token changes (sign-in / sign-out while page is open)
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.agentToken) {
        currentToken = changes.agentToken.newValue || null;
        if (currentToken) {
            if (isChatPage) { attachClickHandlers(); attachMessageInterceptor(); startObserver(); }
            startStatusPolling();
        } else {
            stopObserver();
            hideSessionPopup();
            stopStatusPolling();
            showNotSignedIn();
        }
    }
});

/* ───────── Helpers ───────── */

function isAgentSignedInAndOnShift() {
    return currentToken && (currentStatus === "active" || currentStatus === "idle");
}

function closeSessionViaApi() {
    if (!currentToken) return Promise.resolve();
    return fetch(API_BASE + "/api/close-session", {
        method: "POST",
        headers: { Authorization: "Bearer " + currentToken },
    }).catch(() => {});
}

/* ───────── Agent Status Badge (top-right corner) ───────── */

const STATUS_LABELS = { active: "Active", idle: "Idle", off_shift: "Off Shift", not_signed_in: "Not Signed In" };
const STATUS_COLORS = {
    active:        { bg: "#dcfce7", border: "#22c55e", text: "#15803d", dot: "#22c55e" },
    idle:          { bg: "#fef9c3", border: "#eab308", text: "#a16207", dot: "#eab308" },
    off_shift:     { bg: "#f3f4f6", border: "#9ca3af", text: "#6b7280", dot: "#9ca3af" },
    not_signed_in: { bg: "#fee2e2", border: "#ef4444", text: "#b91c1c", dot: "#ef4444" },
};

function formatStatusDuration(seconds) {
    if (seconds < 0) seconds = 0;
    if (seconds < 60) return seconds + "s";
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    if (mins < 60) return mins + "m " + secs + "s";
    const hours = Math.floor(mins / 60);
    const remMins = mins % 60;
    return hours + "h " + remMins + "m";
}

function createStatusBadge() {
    if (document.getElementById("fc-status-badge")) return;

    const badge = document.createElement("div");
    badge.id = "fc-status-badge";
    badge.style.cssText = `
        position: fixed; top: 100px; right: 12px; z-index: 99999;
        background: #fee2e2; border: 1.5px solid #ef4444; border-radius: 8px;
        padding: 8px 14px; font-family: Arial, sans-serif;
        box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        display: flex; align-items: center; gap: 8px;
        transition: all 0.3s ease;
    `;
    badge.innerHTML = `
        <div id="fc-status-dot" style="width:8px; height:8px; border-radius:50%; background:#ef4444; flex-shrink:0;"></div>
        <div>
            <div id="fc-status-label" style="font-size:13px; font-weight:600; color:#b91c1c; line-height:1.2;">Not Signed In</div>
            <div id="fc-status-detail" style="font-size:11px; color:#888; line-height:1.2; margin-top:2px; display:none;"></div>
            <div id="fc-shift-times" style="display:none; margin-top:4px; font-size:10px; color:#555; line-height:1.4; border-top:1px solid rgba(0,0,0,0.08); padding-top:4px;">
                <div><span style="color:#888;">Shift:</span> <strong id="fc-time-shift">--</strong></div>
                <div><span style="color:#888;">Active:</span> <strong id="fc-time-active" style="color:#15803d;">--</strong></div>
                <div><span style="color:#888;">Idle:</span> <strong id="fc-time-idle" style="color:#a16207;">--</strong></div>
            </div>
        </div>
    `;
    document.body.appendChild(badge);
}

function removeStatusBadge() {
    const badge = document.getElementById("fc-status-badge");
    if (badge) badge.remove();
}

async function updateStatusBadge() {
    if (!currentToken) return;
    try {
        const res = await fetch(API_BASE + "/api/agent/status", {
            headers: { Authorization: "Bearer " + currentToken },
        });
        const data = await res.json();

        const badge = document.getElementById("fc-status-badge");
        const dot = document.getElementById("fc-status-dot");
        const label = document.getElementById("fc-status-label");
        const detail = document.getElementById("fc-status-detail");
        const shiftTimesContainer = document.getElementById("fc-shift-times");
        const timeShift = document.getElementById("fc-time-shift");
        const timeActive = document.getElementById("fc-time-active");
        const timeIdle = document.getElementById("fc-time-idle");
        if (!badge || !dot || !label || !detail) return;

        currentStatus = data.status;
        const colors = STATUS_COLORS[data.status] || STATUS_COLORS.off_shift;
        badge.style.background = colors.bg;
        badge.style.borderColor = colors.border;
        dot.style.background = colors.dot;
        label.style.color = colors.text;
        label.textContent = STATUS_LABELS[data.status] || data.status;

        if (data.status === "active") {
            const chatSec = Math.round((Date.now() - new Date(data.chat_started_at).getTime()) / 1000);
            detail.textContent = (data.chat_name || "Unknown") + " · " + formatStatusDuration(chatSec);
            detail.style.display = "block";
        } else if (data.status === "idle") {
            const idleSec = Math.round((Date.now() - new Date(data.idle_since).getTime()) / 1000);
            detail.textContent = "Idle for " + formatStatusDuration(idleSec);
            detail.style.display = "block";
        } else {
            detail.style.display = "none";
        }

        // Show shift time stats when on shift
        if (data.shift_started_at && shiftTimesContainer) {
            const shiftSeconds = Math.round((Date.now() - new Date(data.shift_started_at).getTime()) / 1000);
            const activeSeconds = data.total_active_seconds || 0;
            const idleSeconds = Math.max(0, shiftSeconds - activeSeconds);

            timeShift.textContent = formatStatusDuration(shiftSeconds);
            timeActive.textContent = formatStatusDuration(activeSeconds);
            timeIdle.textContent = formatStatusDuration(idleSeconds);
            shiftTimesContainer.style.display = "block";
        } else if (shiftTimesContainer) {
            shiftTimesContainer.style.display = "none";
        }
    } catch {
        // keep last known state
    }
}

function startStatusPolling() {
    stopStatusPolling();
    updateStatusBadge();
    statusInterval = setInterval(updateStatusBadge, 5000);
}

function stopStatusPolling() {
    if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
}

function showNotSignedIn() {
    const badge = document.getElementById("fc-status-badge");
    const dot = document.getElementById("fc-status-dot");
    const label = document.getElementById("fc-status-label");
    const detail = document.getElementById("fc-status-detail");
    if (!badge || !dot || !label || !detail) return;

    const colors = STATUS_COLORS.not_signed_in;
    badge.style.background = colors.bg;
    badge.style.borderColor = colors.border;
    dot.style.background = colors.dot;
    label.style.color = colors.text;
    label.textContent = STATUS_LABELS.not_signed_in;
    detail.style.display = "none";
}

function createSessionPopup() {
    let popup = document.getElementById("fc-session-popup");
    if (popup) return popup;

    popup = document.createElement("div");
    popup.id = "fc-session-popup";
    popup.style.cssText = `
        position: fixed; bottom: 20px; left: 20px; z-index: 99999;
        background: #fff; border-radius: 10px; padding: 14px 18px;
        box-shadow: 0 4px 20px rgba(0,0,0,0.15); border-left: 4px solid #28a745;
        font-family: Arial, sans-serif; min-width: 200px; display: none;
        transition: opacity 0.3s; opacity: 0;
    `;
    popup.innerHTML = `
        <div style="font-size:11px; color:#888; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:8px;">Chat Duration</div>
        <div style="display:flex; align-items:center; gap:8px;">
            <div id="fc-session-dot" style="width:8px; height:8px; background:#28a745; border-radius:50%; animation:fc-blink 1.5s infinite;"></div>
            <span id="fc-session-timer" style="font-size:28px; font-weight:bold; color:#333; font-variant-numeric:tabular-nums;">00:00</span>
        </div>
        <div id="fc-session-warning" style="display:none; margin-top:8px; font-size:12px; color:#dc3545; font-weight:bold;"></div>
    `;

    const style = document.createElement("style");
    style.textContent = `@keyframes fc-blink { 0%,100%{opacity:1} 50%{opacity:0.3} }`;
    document.head.appendChild(style);
    document.body.appendChild(popup);
    return popup;
}

function fetchMaxSessionThreshold() {
    if (!currentToken) return;
    fetch(API_BASE + "/api/agent/settings", {
        headers: { Authorization: "Bearer " + currentToken },
    })
        .then(res => res.json())
        .then(data => {
            if (data.max_session_minutes) {
                maxSessionSeconds = parseInt(data.max_session_minutes) * 60;
            }
        })
        .catch(() => {});
}

function showSessionPopup() {
    const popup = createSessionPopup();
    sessionStartTime = Date.now();
    popup.style.display = "block";
    popup.style.borderLeftColor = "#28a745";
    setTimeout(() => { popup.style.opacity = "1"; }, 10);

    // Reset warning state
    const dot = document.getElementById("fc-session-dot");
    const warningEl = document.getElementById("fc-session-warning");
    const timerEl = document.getElementById("fc-session-timer");
    if (dot) dot.style.background = "#28a745";
    if (warningEl) { warningEl.style.display = "none"; warningEl.textContent = ""; }
    if (timerEl) timerEl.style.color = "#333";

    // Fetch latest threshold
    fetchMaxSessionThreshold();

    if (sessionTimer) clearInterval(sessionTimer);
    sessionTimer = setInterval(() => {
        const elapsed = Math.floor((Date.now() - sessionStartTime) / 1000);
        const h = Math.floor(elapsed / 3600);
        const m = Math.floor((elapsed % 3600) / 60);
        const s = elapsed % 60;
        const timerEl = document.getElementById("fc-session-timer");
        if (timerEl) {
            timerEl.textContent = h > 0
                ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
                : `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
        }

        // Check threshold
        if (elapsed >= maxSessionSeconds) {
            const popup = document.getElementById("fc-session-popup");
            const dot = document.getElementById("fc-session-dot");
            const warningEl = document.getElementById("fc-session-warning");
            if (popup) popup.style.borderLeftColor = "#dc3545";
            if (dot) dot.style.background = "#dc3545";
            if (timerEl) timerEl.style.color = "#dc3545";
            if (warningEl) {
                warningEl.textContent = "Session exceeds " + Math.round(maxSessionSeconds / 60) + " min limit!";
                warningEl.style.display = "block";
            }
        }
    }, 1000);
}

function hideSessionPopup() {
    if (sessionTimer) { clearInterval(sessionTimer); sessionTimer = null; }
    const popup = document.getElementById("fc-session-popup");
    if (popup) { popup.style.opacity = "0"; setTimeout(() => { popup.style.display = "none"; }, 300); }
}

function attachClickHandlers() {
    if (!currentToken) return;
    const chats = document.querySelectorAll(CHATS_SELECTOR);
    console.log(`Fetched ${chats.length} chats.`);

    chats.forEach((chat) => {
        if (!chat.dataset.handlerAttached) {
            chat.addEventListener("click", function handleClick() {
                if (!currentToken) return;
                const chatName =
                    chat.querySelector("h3, [class*='font-semibold']")?.textContent?.trim() || "none";
                const chatPreview =
                    chat.querySelector("p, [class*='text-muted']")?.textContent?.trim() || "none";

                showSessionPopup();

                fetch(API_URL, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: "Bearer " + currentToken,
                    },
                    body: JSON.stringify({ chatName, chatPreview }),
                })
                    .then((res) => res.json())
                    .then((data) => console.log("Chat click saved:", data))
                    .catch((err) => console.error("Failed to save chat click:", err));
            });
            chat.dataset.handlerAttached = "true";
        }
    });
}

/* ───────── Tab Close Confirmation Popup ───────── */

function showCloseConfirmation(onConfirm, onCancel) {
    const existing = document.getElementById("fc-close-confirmation");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.id = "fc-close-confirmation";
    overlay.style.cssText = `
        position: fixed; top: 0; left: 0; width: 100%; height: 100%;
        background: rgba(0,0,0,0.5); z-index: 999999;
        display: flex; align-items: center; justify-content: center;
        font-family: Arial, sans-serif;
    `;

    const modal = document.createElement("div");
    modal.style.cssText = `
        background: #fff; border-radius: 12px; padding: 24px 28px;
        box-shadow: 0 8px 30px rgba(0,0,0,0.2); max-width: 400px; width: 90%;
        text-align: center;
    `;
    modal.innerHTML = `
        <div style="font-size: 40px; margin-bottom: 12px;">&#9888;</div>
        <h3 style="margin: 0 0 8px; font-size: 18px; color: #333;">End Session & Leave?</h3>
        <p style="margin: 0 0 20px; font-size: 14px; color: #666; line-height: 1.5;">
            Leaving this page will end your current session and set your status to <strong>Idle</strong>.
        </p>
        <div style="display: flex; gap: 12px; justify-content: center;">
            <button id="fc-confirm-stay" style="
                padding: 10px 24px; border-radius: 8px; border: 1.5px solid #ddd;
                background: #fff; color: #333; font-size: 14px; font-weight: 600;
                cursor: pointer;
            ">Stay</button>
            <button id="fc-confirm-leave" style="
                padding: 10px 24px; border-radius: 8px; border: none;
                background: #dc3545; color: #fff; font-size: 14px; font-weight: 600;
                cursor: pointer;
            ">Leave & End Session</button>
        </div>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    document.getElementById("fc-confirm-stay").addEventListener("click", () => {
        overlay.remove();
        if (onCancel) onCancel();
    });

    document.getElementById("fc-confirm-leave").addEventListener("click", () => {
        overlay.remove();
        if (onConfirm) onConfirm();
    });

    overlay.addEventListener("click", (e) => {
        if (e.target === overlay) {
            overlay.remove();
            if (onCancel) onCancel();
        }
    });
}

/* ───────── In-Page Navigation Interception ───────── */

function interceptNavigationLinks() {
    document.addEventListener("click", (e) => {
        if (!isAgentSignedInAndOnShift()) return;

        const link = e.target.closest("a[href]");
        if (!link) return;

        const href = link.getAttribute("href");
        if (!href || href.startsWith("/dashboard/chat")) return;

        e.preventDefault();
        e.stopPropagation();

        showCloseConfirmation(
            () => closeSessionViaApi().then(() => { window.location.href = href; }),
            () => {}
        );
    }, true);
}

/* ───────── Message Interception ───────── */

function getMessageInput() {
    return document.querySelector(
        'textarea, [contenteditable="true"], input[type="text"]'
    );
}

const SEND_BTN_SELECTOR = 'form > button.bg-primary.size-9';

function getSendButton() {
    return document.querySelector(SEND_BTN_SELECTOR);
}

function captureAndSendMessage() {
    if (!currentToken) return;
    const input = getMessageInput();
    if (!input) return;

    const text = (input.value || input.textContent || '').trim();
    if (!text) return;

    fetch(API_BASE + '/api/session-message', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + currentToken,
        },
        body: JSON.stringify({ message: text }),
    })
        .then(res => res.json())
        .then(data => console.log('Message saved:', data))
        .catch(err => console.error('Failed to save message:', err));
}

function attachMessageInterceptor() {
    if (messageInterceptorAttached) return;

    // Use capture phase (3rd arg = true) so we read the value before the app clears it
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            const input = getMessageInput();
            if (input && document.activeElement === input) {
                captureAndSendMessage();
            }
        }
    }, true);

    // Also intercept click on send button
    document.addEventListener('click', (e) => {
        const btn = e.target.closest(SEND_BTN_SELECTOR);
        if (btn) captureAndSendMessage();
    }, true);

    messageInterceptorAttached = true;
    console.log('Message interceptor attached.');
}

function startObserver() {
    if (observer) return;
    observer = new MutationObserver(() => { attachClickHandlers(); attachMessageInterceptor(); });
    observer.observe(document.body, { childList: true, subtree: true });
}

function stopObserver() {
    if (observer) {
        observer.disconnect();
        observer = null;
    }
}
