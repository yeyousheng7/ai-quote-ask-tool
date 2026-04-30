# ChatGPT Quote Annotation

Chrome/Edge Manifest V3 browser extension for lightweight quote annotation threads on ChatGPT.

## Install for Development

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable developer mode.
3. Click "Load unpacked".
4. Select this project directory.
5. Open `https://chatgpt.com/`.

## MVP Behavior

- Select text inside a ChatGPT assistant reply.
- Click the floating `批注` button.
- The selected reply text receives a lightweight `引用 N` marker.
- A right-side annotation panel opens for that quote.
- Questions typed in the panel are saved in the quote thread and sent through the ChatGPT main composer with the quote as hidden context.
- Threads are stored locally with `chrome.storage.local`, grouped by conversation id.

## Notes

- The extension does not call OpenAI APIs directly.
- Data stays local unless ChatGPT itself receives a question through the page composer.
- Code blocks and formulas are handled conservatively so the extension does not corrupt ChatGPT's rendered DOM.
- If a saved quote cannot be matched safely after refresh or response switching, the extension does not render a marker.
