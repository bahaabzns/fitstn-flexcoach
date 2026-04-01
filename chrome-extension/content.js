const CHATS_SELECTOR =
  "html body div main div div:first-child div div:last-child div div div div[class='flex items-start gap-3 p-3 cursor-pointer transition-colors hover:bg-muted/50']";

const API_URL = "http://localhost:3000/api/chat-click";
const CLOSE_SESSION_URL = "http://localhost:3000/api/close-session";
const AGENT_STATUS_URL = "http://localhost:3000/api/agent-status";

function createCloseSessionButton() {
  if (document.getElementById("close-session-btn")) return;

  const topBar = document.querySelector("header") || document.querySelector("nav") || document.querySelector("main > div:first-child");
  if (!topBar) return;

  const button = document.createElement("button");
  button.id = "close-session-btn";
  button.textContent = "Close Session";
  button.style.cssText = [
    "background: #ff9800",
    "color: #fff",
    "border: none",
    "padding: 8px 16px",
    "border-radius: 8px",
    "font-size: 14px",
    "font-weight: bold",
    "cursor: pointer",
    "margin-left: 12px",
    "transition: background 0.2s",
  ].join(";");

  button.addEventListener("mouseenter", () => { button.style.background = "#e68900"; });
  button.addEventListener("mouseleave", () => { button.style.background = "#ff9800"; });

  button.addEventListener("click", closeSession);

  topBar.style.display = "flex";
  topBar.style.alignItems = "center";
  topBar.appendChild(button);
}

async function closeSession() {
  const button = document.getElementById("close-session-btn");
  if (!button) return;

  button.disabled = true;
  button.textContent = "Closing...";

  try {
    const res = await fetch(CLOSE_SESSION_URL, { method: "POST" });
    const data = await res.json();
    console.log("Session closed manually:", data);
    updateButtonToStatusBetween(button);
  } catch (err) {
    console.error("Failed to close session:", err);
    button.textContent = "Close Session";
    button.disabled = false;
  }
}

function updateButtonToStatusBetween(button) {
  button.textContent = "Between Sessions";
  button.style.background = "#9e9e9e";
  button.disabled = true;
  button.style.cursor = "default";
}

function resetButtonToCloseSession(button) {
  button.textContent = "Close Session";
  button.style.background = "#ff9800";
  button.disabled = false;
  button.style.cursor = "pointer";
}

function attachClickHandlers() {
  const chats = document.querySelectorAll(CHATS_SELECTOR);
  console.log(`Fetched ${chats.length} chats.`);

  chats.forEach((chat) => {
    if (!chat.dataset.handlerAttached) {
      chat.addEventListener("click", function handleClick() {
        const chatName = chat.querySelector("h3, [class*='font-semibold']")?.textContent?.trim() || "none";
        const chatPreview = chat.querySelector("p, [class*='text-muted']")?.textContent?.trim() || "none";

        fetch(API_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chatName, chatPreview }),
        })
          .then((res) => res.json())
          .then((data) => {
            console.log("Chat click saved:", data);
            const button = document.getElementById("close-session-btn");
            if (button) resetButtonToCloseSession(button);
          })
          .catch((err) => console.error("Failed to save chat click:", err));
      });
      chat.dataset.handlerAttached = "true";
    }
  });
}

// Run once on load
attachClickHandlers();
createCloseSessionButton();

// Re-run when the DOM changes (SPA navigation / lazy-loaded chats)
const observer = new MutationObserver(() => {
  attachClickHandlers();
  createCloseSessionButton();
});
observer.observe(document.body, { childList: true, subtree: true });
