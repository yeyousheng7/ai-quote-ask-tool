(function () {
  "use strict";

  const MARK_SELECTOR = ".cgqa-quote-mark";
  const BAD_SELECTION_SELECTOR = [
    ".cgqa-root",
    ".cgqa-selection-menu",
    ".cgqa-toast",
    "button[disabled]",
    "[aria-label='回复操作']",
    "[aria-label='你的消息操作']"
  ].join(",");
  const COMPLEX_SELECTOR = ".katex, math, pre, code, .cm-editor, .cm-content";

  function getConversationId() {
    const match = location.pathname.match(/\/c\/([^/?#]+)/);
    return match ? match[1] : "new-chat";
  }

  function getTurn(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.TEXT_NODE) {
      return null;
    }
    const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    return element ? element.closest("section[data-testid^='conversation-turn-'][data-turn]") : null;
  }

  function getAssistantTurn(node) {
    const turn = getTurn(node);
    return turn && turn.getAttribute("data-turn") === "assistant" ? turn : null;
  }

  function getMessageNode(turn) {
    return turn ? turn.querySelector("[data-message-author-role='assistant'][data-message-id]") : null;
  }

  function getMarkdownNode(turn) {
    const message = getMessageNode(turn);
    if (!message) {
      return null;
    }
    return message.querySelector(".markdown.prose, .markdown-new-styling, .markdown");
  }

  function getMessageId(turn) {
    const message = getMessageNode(turn);
    return message ? message.getAttribute("data-message-id") : "";
  }

  function getTurnId(turn) {
    return turn ? turn.getAttribute("data-turn-id") || turn.getAttribute("data-testid") || "" : "";
  }

  function isInsideComplexContent(node) {
    const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    return Boolean(element && element.closest(COMPLEX_SELECTOR));
  }

  function isBadSelectionNode(node) {
    const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    return Boolean(element && element.closest(BAD_SELECTION_SELECTOR));
  }

  function normalizeText(text) {
    return (text || "").replace(/\u00a0/g, " ");
  }

  function getLinearText(root) {
    const walker = createTextWalker(root);
    let text = "";
    let node = walker.nextNode();
    while (node) {
      text += node.nodeValue;
      node = walker.nextNode();
    }
    return normalizeText(text);
  }

  function getReadableText(root) {
    const clone = root.cloneNode(true);
    clone.querySelectorAll(`${MARK_SELECTOR} .cgqa-quote-chip`).forEach((node) => node.remove());
    clone.querySelectorAll(".katex").forEach((node) => {
      const annotation = node.querySelector("annotation[encoding='application/x-tex']");
      if (annotation) {
        node.textContent = annotation.textContent || node.textContent || "";
      }
    });
    return normalizeText(clone.innerText || clone.textContent || "");
  }

  function createTextWalker(root) {
    return document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue) {
          return NodeFilter.FILTER_REJECT;
        }
        const parent = node.parentElement;
        if (!parent || parent.closest(".cgqa-quote-chip")) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
  }

  function getTextOffset(root, targetNode, targetOffset) {
    const walker = createTextWalker(root);
    let offset = 0;
    let node = walker.nextNode();

    while (node) {
      if (node === targetNode) {
        return offset + targetOffset;
      }
      offset += node.nodeValue.length;
      node = walker.nextNode();
    }

    return -1;
  }

  function getRangeOffsets(root, range) {
    return {
      startOffset: getTextOffset(root, range.startContainer, range.startOffset),
      endOffset: getTextOffset(root, range.endContainer, range.endOffset)
    };
  }

  function makeAnchorText(root, startOffset, endOffset) {
    const text = getLinearText(root);
    return {
      exactText: text.slice(startOffset, endOffset),
      prefixText: text.slice(Math.max(0, startOffset - 40), startOffset),
      suffixText: text.slice(endOffset, Math.min(text.length, endOffset + 40))
    };
  }

  function validateSelection(selection) {
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return { ok: false, reason: "请先选择一段 ChatGPT 回复正文。" };
    }

    const range = selection.getRangeAt(0);
    const startTurn = getAssistantTurn(range.startContainer);
    const endTurn = getAssistantTurn(range.endContainer);

    if (!startTurn || !endTurn || startTurn !== endTurn) {
      return { ok: false, reason: "暂不支持跨回复引用，请重新选择同一条回复中的内容。" };
    }

    const markdown = getMarkdownNode(startTurn);
    if (!markdown || !markdown.contains(range.commonAncestorContainer)) {
      return { ok: false, reason: "请只选择 ChatGPT 回复正文，不要选择思考提示或操作按钮。" };
    }

    if (isBadSelectionNode(range.startContainer) || isBadSelectionNode(range.endContainer)) {
      return { ok: false, reason: "请只选择 ChatGPT 回复正文内容。" };
    }

    const selectedText = normalizeText(selection.toString()).trim();
    if (!selectedText) {
      return { ok: false, reason: "选择内容为空。" };
    }

    const offsets = getRangeOffsets(markdown, range);
    if (offsets.startOffset < 0 || offsets.endOffset < 0 || offsets.endOffset <= offsets.startOffset) {
      return { ok: false, reason: "当前选区结构过于复杂，无法稳定定位。" };
    }

    const complex = isInsideComplexContent(range.startContainer) || isInsideComplexContent(range.endContainer);

    return {
      ok: true,
      range,
      turn: startTurn,
      markdown,
      selectedText,
      complex,
      ...offsets,
      ...makeAnchorText(markdown, offsets.startOffset, offsets.endOffset)
    };
  }

  function findTextPosition(root, offset) {
    const walker = createTextWalker(root);
    let currentOffset = 0;
    let node = walker.nextNode();

    while (node) {
      const nextOffset = currentOffset + node.nodeValue.length;
      if (offset <= nextOffset) {
        return { node, offset: Math.max(0, offset - currentOffset) };
      }
      currentOffset = nextOffset;
      node = walker.nextNode();
    }

    return null;
  }

  function createRangeFromOffsets(root, startOffset, endOffset) {
    const start = findTextPosition(root, startOffset);
    const end = findTextPosition(root, endOffset);
    if (!start || !end) {
      return null;
    }

    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    return range;
  }

  function createMarkElement(thread, blockMode) {
    const mark = document.createElement(blockMode ? "div" : "span");
    mark.className = blockMode ? "cgqa-quote-mark cgqa-quote-mark-block" : "cgqa-quote-mark";
    mark.dataset.quoteId = thread.quoteId;
    mark.dataset.threadId = thread.threadId;
    mark.dataset.displayIndex = String(thread.displayIndex || "");

    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "cgqa-quote-chip";
    chip.textContent = getChipText(thread);
    chip.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      globalThis.CGQAApp && globalThis.CGQAApp.openThread(thread.threadId);
    });

    mark.append(chip);
    return mark;
  }

  function getChipText(thread) {
    const count = (thread.messages || []).filter((message) => message.role === "user").length;
    return count > 0 ? `引用 ${thread.displayIndex} · ${count}` : `引用 ${thread.displayIndex}`;
  }

  function updateMarkChip(thread) {
    document.querySelectorAll(`${MARK_SELECTOR}[data-thread-id='${CSS.escape(thread.threadId)}'] .cgqa-quote-chip`).forEach((chip) => {
      chip.textContent = getChipText(thread);
    });
  }

  function clearRenderedMarks() {
    document.querySelectorAll(MARK_SELECTOR).forEach((mark) => {
      if (mark.classList.contains("cgqa-quote-mark-block")) {
        mark.remove();
        return;
      }

      const parent = mark.parentNode;
      while (mark.firstChild) {
        const child = mark.firstChild;
        if (child.classList && child.classList.contains("cgqa-quote-chip")) {
          child.remove();
        } else {
          parent.insertBefore(child, mark);
        }
      }
      mark.remove();
      parent.normalize();
    });
  }

  function setActiveMark(threadId) {
    document.querySelectorAll(MARK_SELECTOR).forEach((mark) => {
      mark.classList.toggle("is-active", mark.dataset.threadId === threadId);
    });
  }

  function wrapRange(range, thread) {
    const mark = createMarkElement(thread, false);
    try {
      const content = range.extractContents();
      mark.insertBefore(content, mark.firstChild);
      range.insertNode(mark);
      return true;
    } catch (_error) {
      mark.remove();
      return false;
    }
  }

  function markBlock(markdown, range, thread) {
    const complex = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
    const block = complex ? complex.closest(COMPLEX_SELECTOR) : null;
    if (!block || !markdown.contains(block)) {
      return false;
    }

    const mark = createMarkElement(thread, true);
    block.insertAdjacentElement("afterend", mark);
    return true;
  }

  function renderThreadMark(thread) {
    const turn = findTurnForThread(thread);
    const markdown = getMarkdownNode(turn);
    if (!markdown || markdown.querySelector(`${MARK_SELECTOR}[data-thread-id='${CSS.escape(thread.threadId)}']`)) {
      return false;
    }

    const anchor = thread.anchor || {};
    let range = null;
    if (Number.isInteger(anchor.startOffset) && Number.isInteger(anchor.endOffset)) {
      const exact = getLinearText(markdown).slice(anchor.startOffset, anchor.endOffset);
      if (exact === anchor.exactText) {
        range = createRangeFromOffsets(markdown, anchor.startOffset, anchor.endOffset);
      }
    }

    if (!range) {
      range = findRangeByContext(markdown, anchor);
    }

    if (!range) {
      return false;
    }

    if (isInsideComplexContent(range.startContainer) || isInsideComplexContent(range.endContainer)) {
      return markBlock(markdown, range, thread);
    }

    return wrapRange(range, thread);
  }

  function findTurnForThread(thread) {
    const anchor = thread.anchor || {};
    const messageId = CSS.escape(anchor.sourceMessageId || thread.sourceMessageId || "");
    if (messageId) {
      const message = document.querySelector(`[data-message-author-role='assistant'][data-message-id='${messageId}']`);
      if (message) {
        return message.closest("section[data-testid^='conversation-turn-'][data-turn='assistant']");
      }
    }

    const turnId = anchor.sourceTurnId || thread.sourceTurnId || "";
    if (turnId) {
      const turn = Array.from(document.querySelectorAll("section[data-turn='assistant']")).find((item) => {
        return item.getAttribute("data-turn-id") === turnId || item.getAttribute("data-testid") === turnId;
      });
      if (turn) {
        return turn;
      }
    }

    return null;
  }

  function findRangeByContext(markdown, anchor) {
    const text = getLinearText(markdown);
    const exactText = anchor.exactText || "";
    if (!exactText) {
      return null;
    }

    const matches = [];
    let index = text.indexOf(exactText);
    while (index >= 0) {
      const prefix = text.slice(Math.max(0, index - (anchor.prefixText || "").length), index);
      const suffix = text.slice(index + exactText.length, index + exactText.length + (anchor.suffixText || "").length);
      if ((!anchor.prefixText || prefix === anchor.prefixText) && (!anchor.suffixText || suffix === anchor.suffixText)) {
        matches.push(index);
      }
      index = text.indexOf(exactText, index + 1);
    }

    if (matches.length !== 1) {
      return null;
    }

    return createRangeFromOffsets(markdown, matches[0], matches[0] + exactText.length);
  }

  function getAllTurns() {
    return Array.from(document.querySelectorAll("section[data-testid^='conversation-turn-'][data-turn]"));
  }

  function getAssistantTurns() {
    return Array.from(document.querySelectorAll("section[data-turn='assistant']"));
  }

  function getAssistantMessageRecords() {
    return getAssistantTurns().map((turn) => {
      const message = getMessageNode(turn);
      const markdown = getMarkdownNode(turn);
      return {
        turn,
        messageId: message ? message.getAttribute("data-message-id") || "" : "",
        text: markdown ? getReadableText(markdown).trim() : ""
      };
    }).filter((record) => record.messageId || record.text);
  }

  function getLastAssistantText() {
    const turns = getAssistantTurns();
    const turn = turns[turns.length - 1];
    const markdown = getMarkdownNode(turn);
    return markdown ? getReadableText(markdown).trim() : "";
  }

  function getPromptEditor() {
    return document.querySelector("#prompt-textarea[contenteditable='true'][role='textbox']")
      || document.querySelector("textarea[name='prompt-textarea']");
  }

  function setPromptText(text) {
    const editor = getPromptEditor();
    if (!editor) {
      return false;
    }

    editor.focus();
    if (editor.tagName === "TEXTAREA") {
      editor.value = text;
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    }

    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);

    const inserted = document.execCommand && document.execCommand("insertText", false, text);
    if (!inserted) {
      editor.textContent = text;
      editor.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertText", data: text }));
      editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    }
    return true;
  }

  function findSendButton() {
    const editor = getPromptEditor();
    const composer = editor ? editor.closest("form, [class*='composer'], main") : document;
    const scope = composer || document;
    const preferred = scope.querySelector([
      "[data-testid='send-button']:not([disabled])",
      "button[type='submit']:not([disabled])",
      "button[aria-label*='发送']:not([disabled])",
      "button[aria-label*='Send']:not([disabled])"
    ].join(","));
    if (preferred) {
      return preferred;
    }

    const buttons = Array.from(scope.querySelectorAll("button:not([disabled])"));
    const editorRect = editor ? editor.getBoundingClientRect() : null;
    const candidates = buttons.filter((button) => {
      const label = `${button.getAttribute("aria-label") || ""} ${button.textContent || ""}`.toLowerCase();
      if (/添加|文件|attach|voice|语音|听写|model|模型|工具|tool|分享|share|export/.test(label)) {
        return false;
      }
      if (!editorRect) {
        return true;
      }
      const rect = button.getBoundingClientRect();
      const nearComposer = rect.bottom >= editorRect.top - 80
        && rect.top <= editorRect.bottom + 120
        && rect.right >= editorRect.left
        && rect.left <= editorRect.right + 220;
      return nearComposer;
    });

    return candidates.sort((a, b) => {
      const rectA = a.getBoundingClientRect();
      const rectB = b.getBoundingClientRect();
      return rectB.left - rectA.left || rectB.top - rectA.top;
    })[0] || null;
  }

  async function waitForSendButton() {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 2500) {
      const button = findSendButton();
      if (button && !button.disabled && button.getAttribute("aria-disabled") !== "true") {
        return button;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  }

  async function submitPrompt(text) {
    if (!setPromptText(text)) {
      throw new Error("找不到 ChatGPT 主输入框。");
    }

    const button = await waitForSendButton();
    if (!button) {
      throw new Error("找不到 ChatGPT 发送按钮。");
    }
    button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }));
    button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    button.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    button.click();
  }

  globalThis.CGQADom = {
    validateSelection,
    getConversationId,
    getTurnId,
    getMessageId,
    getReadableText,
    getLinearText,
    getMarkdownNode,
    renderThreadMark,
    clearRenderedMarks,
    setActiveMark,
    updateMarkChip,
    getAllTurns,
    getAssistantTurns,
    getAssistantMessageRecords,
    getLastAssistantText,
    submitPrompt
  };
})();
