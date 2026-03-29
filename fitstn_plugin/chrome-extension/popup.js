const API_BASE = "http://localhost:3000";

const loginSection = document.getElementById("login-section");
const signedInSection = document.getElementById("signed-in-section");
const errorMsg = document.getElementById("error-msg");
const agentEmailEl = document.getElementById("agent-email");
const startShiftBtn = document.getElementById("start-shift-btn");
const endShiftBtn = document.getElementById("end-shift-btn");
const shiftStatus = document.getElementById("shift-status");
const statusContainer = document.getElementById("agent-status-container");
const statusBadge = document.getElementById("agent-status-badge");
const statusDetail = document.getElementById("agent-status-detail");
let statusInterval = null;

// Check current auth state
chrome.storage.local.get(["agentToken", "agentInfo"], (result) => {
    if (result.agentToken && result.agentInfo) {
        showSignedIn(result.agentInfo);
    } else {
        showLogin();
    }
});

function showLogin() {
    loginSection.style.display = "block";
    signedInSection.style.display = "none";
}

function showSignedIn(agentInfo) {
    loginSection.style.display = "none";
    signedInSection.style.display = "block";
    agentEmailEl.textContent = agentInfo.name || agentInfo.email;
    loadShiftState();
    loadAgentStatus();
    if (statusInterval) clearInterval(statusInterval);
    statusInterval = setInterval(loadAgentStatus, 5000);
}

function formatTime(isoString) {
    return new Date(isoString).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDuration(seconds) {
    if (seconds < 0) seconds = 0;
    if (seconds < 60) return seconds + 's';
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    if (mins < 60) return mins + 'm ' + secs + 's';
    const hours = Math.floor(mins / 60);
    const remMins = mins % 60;
    return hours + 'h ' + remMins + 'm';
}

const statusLabels = { active: 'Active', idle: 'Idle', off_shift: 'Off Shift' };

async function loadAgentStatus() {
    try {
        const { agentToken } = await new Promise(r => chrome.storage.local.get("agentToken", r));
        if (!agentToken) return;
        const res = await fetch(API_BASE + "/api/agent/status", {
            headers: { Authorization: "Bearer " + agentToken },
        });
        const data = await res.json();

        statusContainer.style.display = "block";
        statusBadge.textContent = statusLabels[data.status] || data.status;
        statusBadge.className = "status-indicator status-" + data.status;

        if (data.status === "active") {
            const chatSec = Math.round((Date.now() - new Date(data.chat_started_at).getTime()) / 1000);
            statusDetail.textContent = "In chat: " + (data.chat_name || "Unknown") + " (" + formatDuration(chatSec) + ")";
            statusDetail.style.display = "block";
        } else if (data.status === "idle") {
            const idleSec = Math.round((Date.now() - new Date(data.idle_since).getTime()) / 1000);
            statusDetail.textContent = "Idle for " + formatDuration(idleSec);
            statusDetail.style.display = "block";
        } else {
            statusDetail.style.display = "none";
        }
    } catch (err) {
        // Keep last known state on error
    }
}

function showShiftActive(shift) {
    startShiftBtn.style.display = "none";
    endShiftBtn.style.display = "block";
    shiftStatus.textContent = "Shift started at " + formatTime(shift.shift_started_at);
    shiftStatus.style.display = "block";
}

function showShiftInactive() {
    startShiftBtn.style.display = "block";
    endShiftBtn.style.display = "none";
    shiftStatus.style.display = "none";
}

async function loadShiftState() {
    chrome.storage.local.get(["agentToken", "activeShift"], async (result) => {
        if (!result.agentToken) return;

        // Show cached state immediately
        if (result.activeShift) {
            showShiftActive(result.activeShift);
        } else {
            showShiftInactive();
        }

        // Sync with server
        try {
            const res = await fetch(API_BASE + "/api/agent/active-shift", {
                headers: { Authorization: "Bearer " + result.agentToken },
            });
            const data = await res.json();
            if (data.active && data.shift) {
                chrome.storage.local.set({ activeShift: data.shift });
                showShiftActive(data.shift);
            } else {
                chrome.storage.local.remove("activeShift");
                showShiftInactive();
            }
        } catch (err) {
            // Keep cached state on network error
        }
    });
}

document.getElementById("signin-btn").addEventListener("click", async () => {
    const email = document.getElementById("email").value.trim();
    const password = document.getElementById("password").value;
    errorMsg.style.display = "none";

    if (!email || !password) {
        errorMsg.textContent = "Email and password required";
        errorMsg.style.display = "block";
        return;
    }

    try {
        const res = await fetch(API_BASE + "/api/agent/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, password }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);

        chrome.storage.local.set(
            { agentToken: data.token, agentInfo: data.agent },
            () => showSignedIn(data.agent)
        );
    } catch (err) {
        errorMsg.textContent = err.message || "Sign in failed";
        errorMsg.style.display = "block";
    }
});

startShiftBtn.addEventListener("click", async () => {
    startShiftBtn.disabled = true;
    try {
        const { agentToken } = await new Promise((r) => chrome.storage.local.get("agentToken", r));
        const res = await fetch(API_BASE + "/api/agent/start-shift", {
            method: "POST",
            headers: { Authorization: "Bearer " + agentToken },
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        chrome.storage.local.set({ activeShift: data.shift });
        showShiftActive(data.shift);
    } catch (err) {
        errorMsg.textContent = err.message || "Failed to start shift";
        errorMsg.style.display = "block";
    } finally {
        startShiftBtn.disabled = false;
    }
});

endShiftBtn.addEventListener("click", async () => {
    endShiftBtn.disabled = true;
    try {
        const { agentToken } = await new Promise((r) => chrome.storage.local.get("agentToken", r));
        const res = await fetch(API_BASE + "/api/agent/end-shift", {
            method: "POST",
            headers: { Authorization: "Bearer " + agentToken },
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        chrome.storage.local.remove("activeShift");
        showShiftInactive();
    } catch (err) {
        errorMsg.textContent = err.message || "Failed to end shift";
        errorMsg.style.display = "block";
    } finally {
        endShiftBtn.disabled = false;
    }
});

document.getElementById("signout-btn").addEventListener("click", () => {
    chrome.storage.local.get(["agentToken"], (result) => {
        if (result.agentToken) {
            fetch(API_BASE + "/api/agent/logout", {
                method: "POST",
                headers: { Authorization: "Bearer " + result.agentToken },
            }).catch(() => {});
        }
        if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
        statusContainer.style.display = "none";
        chrome.storage.local.remove(["agentToken", "agentInfo", "activeShift"], () => {
            showLogin();
        });
    });
});

document.getElementById("my-overview-btn").addEventListener("click", () => {
    chrome.storage.local.get(["agentToken"], (result) => {
        if (!result.agentToken) return;
        chrome.tabs.create({ url: API_BASE + "/overview.html#agentToken=" + result.agentToken });
    });
});

