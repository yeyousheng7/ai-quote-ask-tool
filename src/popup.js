(function () {
  "use strict";

  document.getElementById("open-manager").addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("manager.html") });
    window.close();
  });
})();
