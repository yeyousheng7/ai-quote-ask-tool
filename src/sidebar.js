(function () {
  "use strict";

  function createElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) {
      element.className = className;
    }
    if (text !== undefined) {
      element.textContent = text;
    }
    return element;
  }

  function appendOverlayRoot(node) {
    (document.body || document.documentElement).appendChild(node);
  }

  function removePanel() {
    document.querySelectorAll(".cgqa-root").forEach((node) => node.remove());
  }

  function applyPanelStyle(panel) {
    panel.style.cssText = [
      "all: initial !important",
      "box-sizing: border-box !important",
      "position: fixed !important",
      "top: 140px !important",
      "right: 28px !important",
      "z-index: 2147483647 !important",
      "display: flex !important",
      "flex-direction: column !important",
      "width: min(380px, calc(100vw - 32px)) !important",
      "max-height: min(640px, calc(100vh - 48px)) !important",
      "overflow: hidden !important",
      "visibility: visible !important",
      "opacity: 1 !important",
      "pointer-events: auto !important",
      "color: #1f2933 !important",
      "background: rgba(255,255,255,0.98) !important",
      "border: 1px solid rgba(212,219,226,0.95) !important",
      "border-radius: 18px !important",
      "box-shadow: 0 18px 60px rgba(15,23,42,0.20), 0 4px 18px rgba(15,23,42,0.10) !important",
      "font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif !important"
    ].join(";");
  }

  function buildSidebar(callbacks) {
    let root = null;
    let input = null;

    function render(thread) {
      if (!thread) {
        removePanel();
        root = null;
        input = null;
        return;
      }

      root = createPanel(callbacks, thread);
      input = root.querySelector(".cgqa-input");
    }

    function renderHelp() {
      root = createPanel(callbacks, {
        displayIndex: "",
        quoteText: "在 ChatGPT 的回复正文里划选文字，然后点击浮动的“批注”按钮。创建后，同一引用的追问会保存在这里。",
        messages: [],
        help: true
      });
      input = root.querySelector(".cgqa-input");
      if (input) {
        input.disabled = true;
      }
    }

    function focusInput() {
      if (!input) {
        return;
      }
      input.disabled = false;
      input.focus();
    }

    function isOpen() {
      return Boolean(root && root.isConnected);
    }

    return { render, renderHelp, focusInput, isOpen };
  }

  function createPanel(callbacks, thread) {
    removePanel();

    const panel = createElement("aside", "cgqa-root is-open");
    panel.id = "cgqa-root";
    panel.setAttribute("aria-live", "polite");
    applyPanelStyle(panel);

    const header = createElement("header", "cgqa-panel-header");
    const titleWrap = createElement("div", "cgqa-panel-title-wrap");
    const title = createElement("h2", "cgqa-panel-title", thread.help ? "批注引用" : `引用 ${thread.displayIndex}`);
    const subtitle = createElement("div", "cgqa-panel-subtitle", thread.help ? "先选择一段 ChatGPT 回复" : "围绕该引用继续提问");
    const close = createElement("button", "cgqa-icon-button", "x");
    close.type = "button";
    close.title = "关闭";
    close.addEventListener("click", () => callbacks.onClose());
    titleWrap.append(title, subtitle);
    header.append(titleWrap, close);

    const quote = createElement("blockquote", "cgqa-quote-preview", thread.quoteText || "");
    const messages = createElement("div", "cgqa-messages");
    if (thread.help) {
      messages.append(createElement("div", "cgqa-empty", "当前会话还没有批注引用。"));
    } else if (!thread.messages || thread.messages.length === 0) {
      messages.append(createElement("div", "cgqa-empty", "还没有围绕这个引用的追问。"));
    } else {
      thread.messages.forEach((message) => messages.append(renderMessage(message)));
    }

    const footer = createElement("footer", "cgqa-panel-footer");
    const inputRow = createElement("div", "cgqa-input-row");
    const input = createElement("textarea", "cgqa-input");
    input.placeholder = "继续追问这个引用...";
    input.rows = 1;
    const send = createElement("button", "cgqa-send-button", "↑");
    send.type = "button";
    send.title = "发送";
    send.addEventListener("click", () => callbacks.onSend(input.value));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        callbacks.onSend(input.value);
      }
    });
    inputRow.append(input, send);

    const actions = createElement("div", "cgqa-panel-actions");
    const deleteThread = createElement("button", "cgqa-text-button", "删除引用");
    const clearConversation = createElement("button", "cgqa-text-button", "清除当前会话");
    deleteThread.type = "button";
    clearConversation.type = "button";
    deleteThread.addEventListener("click", () => callbacks.onDeleteThread());
    clearConversation.addEventListener("click", () => callbacks.onClearConversation());
    actions.append(deleteThread, clearConversation);
    footer.append(inputRow, actions);

    panel.append(header, quote, messages, footer);
    appendOverlayRoot(panel);
    messages.scrollTop = messages.scrollHeight;
    return panel;
  }

  function renderMessage(message) {
    const item = createElement("article", `cgqa-message cgqa-message-${message.role}`);
    const meta = createElement("div", "cgqa-message-meta", message.role === "user" ? "你" : "ChatGPT");
    const body = createElement("div", "cgqa-message-body", message.content || "");
    if (message.status === "generating") {
      body.classList.add("is-generating");
    }
    if (message.status === "failed") {
      body.classList.add("is-failed");
    }
    item.append(meta, body);
    return item;
  }

  function showSelectionMenu(rect, onAnnotate) {
    hideSelectionMenu();
    const menu = createElement("div", "cgqa-selection-menu");
    const button = createElement("button", "", "批注");
    button.type = "button";
    const submit = (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (menu.dataset.submitted === "true") {
        return;
      }
      menu.dataset.submitted = "true";
      onAnnotate();
    };
    button.addEventListener("pointerdown", submit);
    button.addEventListener("click", submit);
    menu.append(button);
    appendOverlayRoot(menu);

    const top = Math.max(8, window.scrollY + rect.top - menu.offsetHeight - 10);
    const left = Math.min(window.scrollX + rect.left, window.scrollX + window.innerWidth - menu.offsetWidth - 12);
    menu.style.top = `${top}px`;
    menu.style.left = `${Math.max(8, left)}px`;
  }

  function hideSelectionMenu() {
    document.querySelectorAll(".cgqa-selection-menu").forEach((node) => node.remove());
  }

  function showThreadChoiceMenu(rect, threads, onChoose) {
    hideSelectionMenu();
    const menu = createElement("div", "cgqa-selection-menu cgqa-thread-choice-menu");
    threads.forEach((thread) => {
      const button = createElement("button", "", `引用 ${thread.displayIndex}: ${(thread.quoteText || "").slice(0, 28)}`);
      button.type = "button";
      button.addEventListener("click", (event) => {
        event.preventDefault();
        hideSelectionMenu();
        onChoose(thread.threadId);
      });
      menu.append(button);
    });
    appendOverlayRoot(menu);

    const top = Math.min(window.scrollY + rect.bottom + 8, window.scrollY + window.innerHeight - menu.offsetHeight - 12);
    const left = Math.min(window.scrollX + rect.left, window.scrollX + window.innerWidth - menu.offsetWidth - 12);
    menu.style.top = `${Math.max(8, top)}px`;
    menu.style.left = `${Math.max(8, left)}px`;
  }

  function showToast(message) {
    let toast = document.querySelector(".cgqa-toast");
    if (!toast) {
      toast = createElement("div", "cgqa-toast");
      appendOverlayRoot(toast);
    }
    toast.textContent = message;
    toast.classList.add("is-visible");
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove("is-visible"), 2400);
  }

  globalThis.CGQASidebar = {
    buildSidebar,
    showSelectionMenu,
    showThreadChoiceMenu,
    hideSelectionMenu,
    showToast
  };
})();
