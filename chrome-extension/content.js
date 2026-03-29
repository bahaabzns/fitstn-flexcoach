const CHATS_SELECTOR =
  "html body div main div div:first-child div div:last-child div div div div[class='flex items-start gap-3 p-3 cursor-pointer transition-colors hover:bg-muted/50']";

const API_URL = "http://localhost:3000/api/chat-click";

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
          .then((data) => console.log("Chat click saved:", data))
          .catch((err) => console.error("Failed to save chat click:", err));
      });
      chat.dataset.handlerAttached = "true";
    }
  });
}

// Run once on load
attachClickHandlers();

// Re-run when the DOM changes (SPA navigation / lazy-loaded chats)
const observer = new MutationObserver(() => attachClickHandlers());
observer.observe(document.body, { childList: true, subtree: true });
