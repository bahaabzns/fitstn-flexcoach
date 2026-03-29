const API_BASE = "http://localhost:3000";
const statusBadge = document.getElementById("status-badge");
const statusDetail = document.getElementById("status-detail");
const statusContainer = document.getElementById("status-container");
const notSignedIn = document.getElementById("not-signed-in");

const statusLabels = { active: "Active", idle: "Idle", off_shift: "Off Shift" };

function formatDuration(seconds) {
    if (seconds < 0) seconds = 0;
    if (seconds < 60) return seconds + "s";
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    if (mins < 60) return mins + "m " + secs + "s";
    const hours = Math.floor(mins / 60);
    const remMins = mins % 60;
    return hours + "h " + remMins + "m";
}

async function loadStatus() {
    try {
        const { agentToken } = await chrome.storage.local.get("agentToken");
        if (!agentToken) {
            statusContainer.style.display = "none";
            notSignedIn.style.display = "block";
            return;
        }
        const res = await fetch(API_BASE + "/api/agent/status", {
            headers: { Authorization: "Bearer " + agentToken },
        });
        const data = await res.json();

        statusContainer.style.display = "block";
        notSignedIn.style.display = "none";
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
    } catch {
        // keep last known state
    }
}

loadStatus();
setInterval(loadStatus, 5000);
