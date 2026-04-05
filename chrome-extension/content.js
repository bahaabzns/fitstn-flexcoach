const CHATS_SELECTOR =
  "html body div main div div:first-child div div:last-child div div div div[class='flex items-start gap-3 p-3 cursor-pointer transition-colors hover:bg-muted/50']";

const API_URL = API_BASE + "/api/chat-click";

let currentToken = null;
let observer = null;
let sessionTimer = null;
let maxSessionSeconds = 30 * 60; // default 30 min, updated from server
let statusInterval = null;
let messageInterceptorAttached = false;
let currentStatus = null;

// Idle detection and activity tracking
const IDLE_CHECK_INTERVAL_MS = 10000;
const MOUSE_DEBOUNCE_MS = 1000;
let idleThresholdMs = 2 * 60 * 1000; // default 2 min, updated from server
let sessionTimeoutMs = 10 * 60 * 1000; // default 10 min, updated from server
let lastActivityTimestamp = Date.now();
let isCurrentlyIdle = false;
let idleSinceTimestamp = null;
let idleCheckTimer = null;
let currentSessionId = null;
let mouseMoveDebounceTimer = null;
let isChatClickInFlight = false;

const isChatPage = location.pathname.startsWith("/dashboard/chat");

// Close session on tab close / reload — only on chat pages, only if signed in and on shift
if (isChatPage) {
    window.addEventListener("beforeunload", (event) => {
        if (isAgentSignedInAndOnShift()) {
            // Use sendBeacon to reliably close the session even during reload
            const token = currentToken;
            if (token) {
                navigator.sendBeacon(
                    API_BASE + "/api/close-session",
                    new Blob([JSON.stringify({ _token: token })], { type: "application/json" })
                );
            }
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
        if (isChatPage) {
            // Close any lingering session from before the reload, then attach handlers
            closeSessionViaApi().then(() => {
                attachClickHandlers();
                attachMessageInterceptor();
                startObserver();
                interceptNavigationLinks();
                startStatusPolling();
            });
        } else {
            startStatusPolling();
        }
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
    return currentToken && (currentStatus === "in_session" || currentStatus === "between_sessions" || currentStatus === "idle" || currentStatus === "on_break");
}

function closeSessionViaApi() {
    if (!currentToken) return Promise.resolve();
    return fetch(API_BASE + "/api/close-session", {
        method: "POST",
        headers: { Authorization: "Bearer " + currentToken },
    }).catch(() => {});
}

/* ───────── Activity Event Helper ───────── */

function postActivityEvent(eventType, extraData = {}) {
    if (!currentToken) return;
    fetch(API_BASE + "/api/activity-event", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + currentToken,
        },
        body: JSON.stringify({ event_type: eventType, ...extraData }),
    }).catch(() => {});
}

/* ───────── Idle Detection (Inside Sessions) ───────── */

function resetActivityTimestamp() {
    lastActivityTimestamp = Date.now();
    if (isCurrentlyIdle) {
        isCurrentlyIdle = false;
        idleSinceTimestamp = null;
        postActivityEvent("idle_resumed", { session_id: currentSessionId });
    }
}

function onMouseMove() {
    if (mouseMoveDebounceTimer) return;
    mouseMoveDebounceTimer = setTimeout(() => { mouseMoveDebounceTimer = null; }, MOUSE_DEBOUNCE_MS);
    resetActivityTimestamp();
}

function startIdleDetection() {
    stopIdleDetection();
    lastActivityTimestamp = Date.now();
    isCurrentlyIdle = false;
    idleSinceTimestamp = null;

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("keydown", resetActivityTimestamp);
    document.addEventListener("click", resetActivityTimestamp);

    idleCheckTimer = setInterval(checkIdleState, IDLE_CHECK_INTERVAL_MS);
}

function stopIdleDetection() {
    if (idleCheckTimer) { clearInterval(idleCheckTimer); idleCheckTimer = null; }
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("keydown", resetActivityTimestamp);
    document.removeEventListener("click", resetActivityTimestamp);
    isCurrentlyIdle = false;
    idleSinceTimestamp = null;
}

function checkIdleState() {
    const idleDuration = Date.now() - lastActivityTimestamp;

    // Check session auto-timeout (client-side)
    if (isCurrentlyIdle && idleSinceTimestamp && (Date.now() - idleSinceTimestamp) >= sessionTimeoutMs) {
        autoCloseSessionDueToTimeout();
        return;
    }

    // Check idle threshold
    if (!isCurrentlyIdle && idleDuration >= idleThresholdMs) {
        isCurrentlyIdle = true;
        idleSinceTimestamp = Date.now();
        postActivityEvent("idle_started", { session_id: currentSessionId });
    }
}

function autoCloseSessionDueToTimeout() {
    closeSessionViaApi();
    hideSessionPopup();
    stopIdleDetection();
    currentSessionId = null;
    showTimeoutNotification();
}

function showTimeoutNotification() {
    const toast = document.createElement("div");
    toast.style.cssText = `
        position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
        background: #dc3545; color: #fff; padding: 12px 24px; border-radius: 8px;
        font-family: Arial, sans-serif; font-size: 14px; z-index: 99999;
        box-shadow: 0 4px 12px rgba(0,0,0,0.2);
    `;
    toast.textContent = "Session auto-closed due to inactivity";
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 5000);
}

/* ───────── Tab Visibility Tracking ───────── */

document.addEventListener("visibilitychange", () => {
    if (!currentToken) return;
    if (document.hidden) {
        postActivityEvent("tab_focus_lost", { session_id: currentSessionId });
    } else {
        postActivityEvent("tab_focus_gained", { session_id: currentSessionId });
        resetActivityTimestamp();
    }
});

/* ───────── Agent Status Badge (top-right corner) ───────── */

const STATUS_LABELS = { in_session: "In Session", between_sessions: "Off-session work", idle: "Idle", on_break: "On Break", off_shift: "Off Shift", not_signed_in: "Not Signed In" };
const STATUS_COLORS = {
    in_session:        { bg: "#dcfce7", border: "#22c55e", text: "#15803d", dot: "#22c55e" },
    between_sessions:  { bg: "#fef9c3", border: "#eab308", text: "#a16207", dot: "#eab308" },
    idle:              { bg: "#fee2e2", border: "#ef4444", text: "#b91c1c", dot: "#ef4444" },
    on_break:          { bg: "#e0e7ff", border: "#6366f1", text: "#4338ca", dot: "#6366f1" },
    off_shift:         { bg: "#f3f4f6", border: "#9ca3af", text: "#6b7280", dot: "#9ca3af" },
    not_signed_in:     { bg: "#fee2e2", border: "#ef4444", text: "#b91c1c", dot: "#ef4444" },
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
    if (document.getElementById("fc-top-bar")) return;

    const bar = document.createElement("div");
    bar.id = "fc-top-bar";
    bar.style.cssText = `
        position: fixed; top: 0; left: 0; width: 100%; z-index: 99999;
        background: #1e293b; font-family: Arial, sans-serif;
        box-shadow: 0 2px 8px rgba(0,0,0,0.2);
        display: flex; align-items: stretch; justify-content: space-between;
        padding: 0; min-height: 48px;
        transition: all 0.3s ease;
    `;
    bar.innerHTML = `
        <div id="fc-status-card" style="display:flex; align-items:center; gap:10px; padding:8px 16px; flex:1;">
            <div id="fc-status-dot" style="width:10px; height:10px; border-radius:50%; background:#ef4444; flex-shrink:0;"></div>
            <div>
                <div style="display:flex; align-items:center; gap:8px;">
                    <span id="fc-status-label" style="font-size:13px; font-weight:700; color:#fca5a5; letter-spacing:0.3px;">Not Signed In</span>
                    <span id="fc-status-detail" style="font-size:12px; color:#94a3b8; display:none;"></span>
                </div>
                <div id="fc-shift-times" style="display:none; margin-top:2px; font-size:11px; color:#94a3b8; gap:12px;">
                    <span><span style="color:#64748b;">Shift:</span> <strong id="fc-time-shift" style="color:#e2e8f0;">--</strong></span>
                    <span><span style="color:#64748b;">Active:</span> <strong id="fc-time-active" style="color:#4ade80;">--</strong></span>
                    <span><span style="color:#64748b;">Off-session work:</span> <strong id="fc-time-idle" style="color:#facc15;">--</strong></span>
                    <span><span style="color:#64748b;">Break:</span> <strong id="fc-time-break" style="color:#a78bfa;">--</strong></span>
                </div>
            </div>
        </div>
        <div id="fc-session-card" style="display:none; align-items:center; gap:10px; padding:8px 16px; border-left:1px solid #334155;">
            <div id="fc-session-dot" style="width:10px; height:10px; background:#22c55e; border-radius:50%; flex-shrink:0; animation:fc-blink 1.5s infinite;"></div>
            <div>
                <div style="font-size:10px; color:#64748b; text-transform:uppercase; letter-spacing:0.5px; line-height:1;">Session Duration</div>
                <div id="fc-session-timer" style="font-size:22px; font-weight:bold; color:#e2e8f0; font-variant-numeric:tabular-nums; line-height:1.2;">00:00</div>
            </div>
            <div id="fc-session-warning" style="display:none; font-size:11px; color:#fca5a5; font-weight:bold; margin-left:4px;"></div>
        </div>
        <div id="fc-actions" style="display:none; align-items:center; gap:8px; padding:8px 16px; border-left:1px solid #334155;">
            <button id="fc-btn-shift" style="padding:6px 14px; border:none; border-radius:6px; font-size:12px; font-weight:600; cursor:pointer; background:#22c55e; color:#fff; white-space:nowrap;">Start Shift</button>
            <button id="fc-btn-break" style="display:none; padding:6px 14px; border:none; border-radius:6px; font-size:12px; font-weight:600; cursor:pointer; background:#6366f1; color:#fff; white-space:nowrap;">Take Break</button>
            <button id="fc-btn-off-session" style="display:none; padding:6px 14px; border:none; border-radius:6px; font-size:12px; font-weight:600; cursor:pointer; background:#f59e0b; color:#fff; white-space:nowrap;">Off-session work</button>
            <button id="fc-btn-reopen" style="display:none; padding:6px 14px; border:none; border-radius:6px; font-size:12px; font-weight:600; cursor:pointer; background:#f59e0b; color:#fff; white-space:nowrap;">Reopen Shift</button>
            <button id="fc-btn-overview" style="padding:6px 14px; border:1px solid #475569; border-radius:6px; font-size:12px; font-weight:500; cursor:pointer; background:transparent; color:#cbd5e1; white-space:nowrap;">My Overview</button>
            <button id="fc-btn-signout" style="padding:6px 14px; border:1px solid #7f1d1d; border-radius:6px; font-size:12px; font-weight:500; cursor:pointer; background:#991b1b; color:#fca5a5; white-space:nowrap;">Sign Out</button>
        </div>
    `;

    const style = document.createElement("style");
    style.id = "fc-top-bar-styles";
    style.textContent = `
        @keyframes fc-blink { 0%,100%{opacity:1} 50%{opacity:0.3} }
        body { padding-top: 48px !important; }
    `;
    document.head.appendChild(style);
    document.body.appendChild(bar);

    // Attach click listeners directly (inline onclick is blocked by page CSP)
    document.getElementById("fc-btn-shift").addEventListener("click", handleShiftToggle);
    document.getElementById("fc-btn-break").addEventListener("click", handleBreakToggle);
    document.getElementById("fc-btn-off-session").addEventListener("click", handleOffSessionWork);
    document.getElementById("fc-btn-reopen").addEventListener("click", handleReopenShift);
    document.getElementById("fc-btn-overview").addEventListener("click", handleOpenOverview);
    document.getElementById("fc-btn-signout").addEventListener("click", handleSignOut);
}

function removeStatusBadge() {
    const bar = document.getElementById("fc-top-bar");
    if (bar) bar.remove();
    const barStyles = document.getElementById("fc-top-bar-styles");
    if (barStyles) barStyles.remove();
}

let reopenShiftTimer = null;
let shiftEndedAt = null;
const REOPEN_GRACE_MINUTES = 5;

/* ───────── Top Bar Button Handlers ───────── */

async function handleShiftToggle() {
    if (!currentToken) return;
    const btn = document.getElementById("fc-btn-shift");
    if (!btn) return;

    const isOnShift = btn.dataset.onShift === "true";

    if (isOnShift) {
        showEndShiftConfirmation();
        return;
    }

    await executeShiftStart();
}

async function executeShiftStart() {
    const btn = document.getElementById("fc-btn-shift");
    if (!btn) return;
    btn.disabled = true;
    btn.style.opacity = "0.6";

    try {
        const res = await fetch(API_BASE + "/api/agent/start-shift", {
            method: "POST",
            headers: { Authorization: "Bearer " + currentToken },
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({ error: "Server error " + res.status }));
            showBreakError(err.error || "Failed to start shift");
            return;
        }
        clearReopenTimer();
        updateStatusBadge();
    } catch (err) {
        showBreakError("Network error — could not start shift");
        console.error("Start shift request failed:", err);
    } finally {
        btn.disabled = false;
        btn.style.opacity = "1";
    }
}

async function executeShiftEnd() {
    const btn = document.getElementById("fc-btn-shift");
    if (!btn) return;
    btn.disabled = true;
    btn.style.opacity = "0.6";

    // Close active chat session before ending the shift
    await closeSessionViaApi();
    hideSessionPopup();

    try {
        const res = await fetch(API_BASE + "/api/agent/end-shift", {
            method: "POST",
            headers: { Authorization: "Bearer " + currentToken },
        });
        if (!res.ok) {
            const err = await res.json();
            console.error("End shift failed:", err.error || "Unknown error");
        } else {
            startReopenTimer();
        }
        updateStatusBadge();
    } catch (err) {
        console.error("End shift request failed:", err);
    } finally {
        btn.disabled = false;
        btn.style.opacity = "1";
    }
}

function showEndShiftConfirmation() {
    const existing = document.getElementById("fc-end-shift-confirmation");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.id = "fc-end-shift-confirmation";
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
        <h3 style="margin: 0 0 8px; font-size: 18px; color: #333;">End Your Shift?</h3>
        <p style="margin: 0 0 20px; font-size: 14px; color: #666; line-height: 1.5;">
            Are you sure you want to end your shift? If this is a mistake, you can reopen it within <strong>${REOPEN_GRACE_MINUTES} minutes</strong>.
        </p>
        <div style="display: flex; gap: 12px; justify-content: center;">
            <button id="fc-confirm-cancel-end" style="
                padding: 10px 24px; border-radius: 8px; border: 1.5px solid #ddd;
                background: #fff; color: #333; font-size: 14px; font-weight: 600;
                cursor: pointer;
            ">Cancel</button>
            <button id="fc-confirm-end-shift" style="
                padding: 10px 24px; border-radius: 8px; border: none;
                background: #dc3545; color: #fff; font-size: 14px; font-weight: 600;
                cursor: pointer;
            ">End Shift</button>
        </div>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    document.getElementById("fc-confirm-cancel-end").addEventListener("click", () => overlay.remove());
    document.getElementById("fc-confirm-end-shift").addEventListener("click", () => {
        overlay.remove();
        executeShiftEnd();
    });
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
}

/* ───────── Reopen Shift (grace period) ───────── */

function startReopenTimer() {
    clearReopenTimer();
    shiftEndedAt = Date.now();
    const reopenBtn = document.getElementById("fc-btn-reopen");
    if (reopenBtn) reopenBtn.style.display = "inline-block";
    reopenShiftTimer = setTimeout(() => {
        clearReopenTimer();
        updateStatusBadge();
    }, REOPEN_GRACE_MINUTES * 60 * 1000);
}

function clearReopenTimer() {
    if (reopenShiftTimer) { clearTimeout(reopenShiftTimer); reopenShiftTimer = null; }
    shiftEndedAt = null;
    const reopenBtn = document.getElementById("fc-btn-reopen");
    if (reopenBtn) reopenBtn.style.display = "none";
}

async function handleReopenShift() {
    if (!currentToken) return;
    const btn = document.getElementById("fc-btn-reopen");
    if (!btn) return;
    btn.disabled = true;
    btn.style.opacity = "0.6";

    try {
        const res = await fetch(API_BASE + "/api/agent/reopen-shift", {
            method: "POST",
            headers: { Authorization: "Bearer " + currentToken },
        });
        if (!res.ok) {
            const err = await res.json();
            showBreakError(err.error || "Failed to reopen shift");
        }
        clearReopenTimer();
        updateStatusBadge();
    } catch (err) {
        showBreakError("Network error — could not reopen shift");
    } finally {
        btn.disabled = false;
        btn.style.opacity = "1";
    }
}

async function handleBreakToggle() {
    if (!currentToken) return;
    const btn = document.getElementById("fc-btn-break");
    if (!btn) return;
    btn.disabled = true;
    btn.style.opacity = "0.6";

    const isOnBreak = btn.dataset.onBreak === "true";
    const endpoint = isOnBreak ? "/api/agent/end-break" : "/api/agent/start-break";

    // Close active chat session before starting a break
    if (!isOnBreak) {
        await closeSessionViaApi();
        hideSessionPopup();
    }

    try {
        const res = await fetch(API_BASE + endpoint, {
            method: "POST",
            headers: { Authorization: "Bearer " + currentToken },
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({ error: "Server error " + res.status }));
            showBreakError(err.error || "Break action failed");
            return;
        }
        updateStatusBadge();
    } catch (err) {
        showBreakError("Network error — check your connection");
    } finally {
        btn.disabled = false;
        btn.style.opacity = "1";
    }
}

async function handleOffSessionWork() {
    if (!currentToken) return;
    const btn = document.getElementById("fc-btn-off-session");
    if (!btn) return;
    btn.disabled = true;
    btn.style.opacity = "0.6";

    try {
        await closeSessionViaApi();
        hideSessionPopup();
        updateStatusBadge();
        showOffSessionToast("Session closed — you are now off-session");
    } catch (err) {
        showBreakError("Failed to close session — check your connection");
    } finally {
        btn.disabled = false;
        btn.style.opacity = "1";
    }
}

function showOffSessionToast(message) {
    const toast = document.createElement("div");
    toast.style.cssText = `
        position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
        background: #f59e0b; color: #1e293b; padding: 12px 24px; border-radius: 8px;
        font-family: Arial, sans-serif; font-size: 14px; z-index: 99999;
        box-shadow: 0 4px 12px rgba(0,0,0,0.2); font-weight: 600;
    `;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

function showBreakError(message) {
    const toast = document.createElement("div");
    toast.style.cssText = `
        position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
        background: #dc3545; color: #fff; padding: 12px 24px; border-radius: 8px;
        font-family: Arial, sans-serif; font-size: 14px; z-index: 99999;
        box-shadow: 0 4px 12px rgba(0,0,0,0.2);
    `;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
}

function handleOpenOverview() {
    if (!currentToken) return;
    window.open(API_BASE + "/overview.html#agentToken=" + currentToken, "_blank");
}

async function handleSignOut() {
    if (!currentToken) return;
    const btn = document.getElementById("fc-btn-signout");
    if (btn) { btn.disabled = true; btn.style.opacity = "0.6"; }

    try {
        await fetch(API_BASE + "/api/agent/logout", {
            method: "POST",
            headers: { Authorization: "Bearer " + currentToken },
        });
    } catch (err) {
        console.error("Sign out request failed:", err);
    }

    currentToken = null;
    chrome.storage.local.remove(["agentToken", "agentInfo", "activeShift"]);
    stopStatusPolling();
    hideSessionPopup();
    showNotSignedIn();
    updateActionButtons(false, false);
}

function updateActionButtons(isSignedIn, isOnShift, isOnBreak) {
    const actionsContainer = document.getElementById("fc-actions");
    const shiftBtn = document.getElementById("fc-btn-shift");
    const breakBtn = document.getElementById("fc-btn-break");
    const offSessionBtn = document.getElementById("fc-btn-off-session");
    const reopenBtn = document.getElementById("fc-btn-reopen");
    if (!actionsContainer) return;

    actionsContainer.style.display = isSignedIn ? "flex" : "none";

    if (shiftBtn) {
        shiftBtn.dataset.onShift = isOnShift ? "true" : "false";
        const isReopenGraceActive = shiftEndedAt !== null;
        if (isOnShift) {
            shiftBtn.textContent = "End Shift";
            shiftBtn.style.background = "#dc2626";
            shiftBtn.style.color = "#fff";
            shiftBtn.style.display = "inline-block";
        } else if (isReopenGraceActive) {
            // During reopen grace period, hide Start Shift — only show Reopen
            shiftBtn.style.display = "none";
        } else {
            shiftBtn.textContent = "Start Shift";
            shiftBtn.style.background = "#22c55e";
            shiftBtn.style.color = "#fff";
            shiftBtn.style.display = "inline-block";
        }
    }

    if (breakBtn) {
        if (isOnShift) {
            breakBtn.style.display = "inline-block";
            breakBtn.dataset.onBreak = isOnBreak ? "true" : "false";
            if (isOnBreak) {
                breakBtn.textContent = "Resume";
                breakBtn.style.background = "#22c55e";
                breakBtn.style.color = "#fff";
            } else {
                breakBtn.textContent = "Take Break";
                breakBtn.style.background = "#6366f1";
                breakBtn.style.color = "#fff";
            }
        } else {
            breakBtn.style.display = "none";
        }
    }

    // Show Off-session work button only when on shift, not on break, and in an active session
    if (offSessionBtn) {
        const hasActiveSession = currentStatus === "in_session";
        offSessionBtn.style.display = (isOnShift && !isOnBreak && hasActiveSession) ? "inline-block" : "none";
    }

    // Hide Reopen button when back on shift
    if (reopenBtn && isOnShift) {
        clearReopenTimer();
    }
}

async function updateStatusBadge() {
    if (!currentToken) return;
    try {
        const res = await fetch(API_BASE + "/api/agent/status", {
            headers: { Authorization: "Bearer " + currentToken },
        });
        const data = await res.json();

        const statusCard = document.getElementById("fc-status-card");
        const dot = document.getElementById("fc-status-dot");
        const label = document.getElementById("fc-status-label");
        const detail = document.getElementById("fc-status-detail");
        const shiftTimesContainer = document.getElementById("fc-shift-times");
        const timeShift = document.getElementById("fc-time-shift");
        const timeActive = document.getElementById("fc-time-active");
        const timeIdle = document.getElementById("fc-time-idle");
        if (!statusCard || !dot || !label || !detail) return;

        currentStatus = data.status;
        const colors = STATUS_COLORS[data.status] || STATUS_COLORS.off_shift;
        dot.style.background = colors.dot;
        label.style.color = colors.text;
        label.textContent = STATUS_LABELS[data.status] || data.status;

        if (data.status === "in_session") {
            detail.textContent = (data.chat_name || "Unknown") + " · " + formatStatusDuration(data.chat_duration_seconds || 0);
            detail.style.display = "inline";
        } else if (data.status === "between_sessions") {
            detail.textContent = "Off-session for " + formatStatusDuration(data.idle_since_seconds || 0);
            detail.style.display = "inline";
        } else if (data.status === "idle") {
            detail.textContent = "Idle for " + formatStatusDuration(data.idle_since_seconds || 0);
            detail.style.display = "inline";
        } else if (data.status === "on_break") {
            detail.textContent = "Break for " + formatStatusDuration(data.current_break_seconds || 0);
            detail.style.display = "inline";
        } else {
            detail.style.display = "none";
        }

        // Sync session card with server status
        const sessionCard = getSessionCard();
        const isSessionVisible = sessionCard && sessionCard.style.display !== "none";

        if (data.status === "in_session" && !isSessionVisible && isChatPage) {
            showSessionPopup(data.chat_duration_seconds || 0);
            if (!currentSessionId) startIdleDetection();
        } else if (data.status !== "in_session" && isSessionVisible && !isChatClickInFlight) {
            hideSessionPopup();
        }

        // Show shift time stats when on shift (all durations from server)
        const isOnShift = !!data.shift_duration_seconds;
        const isOnBreak = data.status === "on_break";
        if (isOnShift && shiftTimesContainer) {
            const timeBreak = document.getElementById("fc-time-break");
            timeShift.textContent = formatStatusDuration(data.shift_duration_seconds || 0);
            timeActive.textContent = formatStatusDuration(data.total_active_seconds || 0);
            timeIdle.textContent = formatStatusDuration(data.idle_duration_seconds || 0);
            if (timeBreak) timeBreak.textContent = formatStatusDuration(data.total_break_seconds || 0);
            shiftTimesContainer.style.display = "flex";
        } else if (shiftTimesContainer) {
            shiftTimesContainer.style.display = "none";
        }

        updateActionButtons(true, isOnShift, isOnBreak);
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
    const dot = document.getElementById("fc-status-dot");
    const label = document.getElementById("fc-status-label");
    const detail = document.getElementById("fc-status-detail");
    if (!dot || !label || !detail) return;

    const colors = STATUS_COLORS.not_signed_in;
    dot.style.background = colors.dot;
    label.style.color = colors.text;
    label.textContent = STATUS_LABELS.not_signed_in;
    detail.style.display = "none";
    updateActionButtons(false, false);
}

function getSessionCard() {
    return document.getElementById("fc-session-card");
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
            if (data.idle_inside_session_minutes) {
                idleThresholdMs = parseInt(data.idle_inside_session_minutes) * 60 * 1000;
            }
            if (data.session_timeout_minutes) {
                sessionTimeoutMs = parseInt(data.session_timeout_minutes) * 60 * 1000;
            }
        })
        .catch(() => {});
}

function showSessionPopup(initialElapsedSeconds) {
    const card = getSessionCard();
    if (!card) return;
    const serverAnchorTime = Date.now();
    const serverElapsedSeconds = initialElapsedSeconds || 0;
    card.style.display = "flex";

    // Reset warning state
    const dot = document.getElementById("fc-session-dot");
    const warningEl = document.getElementById("fc-session-warning");
    const timerEl = document.getElementById("fc-session-timer");
    if (dot) dot.style.background = "#22c55e";
    if (warningEl) { warningEl.style.display = "none"; warningEl.textContent = ""; }
    if (timerEl) timerEl.style.color = "#e2e8f0";

    // Fetch latest threshold
    fetchMaxSessionThreshold();

    if (sessionTimer) clearInterval(sessionTimer);
    sessionTimer = setInterval(() => {
        const localTickSeconds = Math.floor((Date.now() - serverAnchorTime) / 1000);
        const elapsed = serverElapsedSeconds + localTickSeconds;
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
            const dot = document.getElementById("fc-session-dot");
            const warningEl = document.getElementById("fc-session-warning");
            if (dot) dot.style.background = "#ef4444";
            if (timerEl) timerEl.style.color = "#fca5a5";
            if (warningEl) {
                warningEl.textContent = "Exceeds " + Math.round(maxSessionSeconds / 60) + " min!";
                warningEl.style.display = "inline";
            }
        }
    }, 1000);
}

function hideSessionPopup() {
    if (sessionTimer) { clearInterval(sessionTimer); sessionTimer = null; }
    stopIdleDetection();
    currentSessionId = null;
    const card = getSessionCard();
    if (card) card.style.display = "none";
}

function extractChatNameFromHeader() {
    const chatHeader = document.querySelector(".border-b.bg-background");
    if (!chatHeader) return "";
    const nameEl = chatHeader.querySelector("h1");
    const codeEl = chatHeader.querySelector("span.text-xs");
    const name = nameEl?.innerText?.trim() || "";
    const code = codeEl?.innerText?.trim() || "";
    if (name && code) return name + " " + code;
    if (name) return name;
    if (code) return code;
    return "";
}

function attachClickHandlers() {
    if (!currentToken) return;
    const chats = document.querySelectorAll(CHATS_SELECTOR);
    console.log(`Fetched ${chats.length} chats.`);

    chats.forEach((chat) => {
        if (!chat.dataset.handlerAttached) {
            chat.addEventListener("click", function handleClick() {
                if (!currentToken) return;

                // Block session start while on break
                if (currentStatus === "on_break") {
                    showBreakError("You are on break — resume your shift first");
                    return;
                }

                isChatClickInFlight = true;
                showSessionPopup();

                // Wait for the chat header to load, then extract name + code
                setTimeout(() => {
                    const chatName = extractChatNameFromHeader() || "Unknown";

                    fetch(API_URL, {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            Authorization: "Bearer " + currentToken,
                        },
                        body: JSON.stringify({ chatName, chatPreview: "" }),
                    })
                        .then((res) => res.json())
                        .then((data) => {
                            console.log("Chat click saved:", data);
                            currentSessionId = data.data?.id || null;
                            isChatClickInFlight = false;
                            startIdleDetection();
                        })
                        .catch((err) => {
                            console.error("Failed to save chat click:", err);
                            isChatClickInFlight = false;
                        });
                }, 500);
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
