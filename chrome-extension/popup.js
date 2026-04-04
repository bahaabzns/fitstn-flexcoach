const API_BASE = "https://fitstn-flexcoach.onrender.com";

const loginSection = document.getElementById("login-section");
const signedInSection = document.getElementById("signed-in-section");
const errorMsg = document.getElementById("error-msg");
const agentEmailEl = document.getElementById("agent-email");

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

document.getElementById("signout-btn").addEventListener("click", () => {
    chrome.storage.local.get(["agentToken"], (result) => {
        if (result.agentToken) {
            fetch(API_BASE + "/api/agent/logout", {
                method: "POST",
                headers: { Authorization: "Bearer " + result.agentToken },
            }).catch(() => {});
        }
        chrome.storage.local.remove(["agentToken", "agentInfo", "activeShift"], () => {
            showLogin();
        });
    });
});



