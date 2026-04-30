chrome.action.onClicked.addListener((tab) => {
  if (!tab.id || !tab.url || !/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(tab.url)) {
    return;
  }

  openPanel(tab.id);
});

async function openPanel(tabId) {
  try {
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ["src/styles.css"]
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [
        "src/storage.js",
        "src/dom.js",
        "src/sidebar.js",
        "src/content.js"
      ]
    });
    await chrome.tabs.sendMessage(tabId, { type: "CGQA_TOGGLE_PANEL" });
  } catch (_error) {
    // The active tab may have navigated or blocked extension injection.
  }
}
