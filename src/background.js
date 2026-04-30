chrome.action.onClicked.addListener((tab) => {
  if (!tab.id || !tab.url || !/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(tab.url)) {
    return;
  }

  chrome.tabs.sendMessage(tab.id, { type: "CGQA_TOGGLE_PANEL" }).catch(async () => {
    try {
      await chrome.scripting.insertCSS({
        target: { tabId: tab.id },
        files: ["src/styles.css"]
      });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: [
          "src/storage.js",
          "src/dom.js",
          "src/sidebar.js",
          "src/content.js"
        ]
      });
      await chrome.tabs.sendMessage(tab.id, { type: "CGQA_TOGGLE_PANEL" });
    } catch (_error) {
      // The active tab may have navigated or blocked extension injection.
    }
  });
});
