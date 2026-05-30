(function () {
  "use strict";

  const ALLOWED_TAGS = new Set([
    "a",
    "b",
    "blockquote",
    "br",
    "code",
    "div",
    "em",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "i",
    "li",
    "ol",
    "p",
    "pre",
    "s",
    "span",
    "strong",
    "table",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "tr",
    "ul"
  ]);

  function sanitizeMessageHtml(html) {
    if (!html) {
      return "";
    }

    const template = document.createElement("template");
    template.innerHTML = String(html);
    const container = document.createElement("div");
    Array.from(template.content.childNodes).forEach((node) => appendSanitizedNode(container, node));
    return container.innerHTML.trim();
  }

  function renderStreamingMarkdown(text) {
    const html = renderMarkdownBlocks(String(text || ""));
    return sanitizeMessageHtml(html);
  }

  function renderMarkdownBlocks(text) {
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    const blocks = [];
    let paragraph = [];
    let list = null;
    let codeFence = null;
    let codeLines = [];

    function flushParagraph() {
      if (!paragraph.length) {
        return;
      }
      blocks.push(`<p>${renderInlineMarkdown(paragraph.join("\n"))}</p>`);
      paragraph = [];
    }

    function flushList() {
      if (!list) {
        return;
      }
      blocks.push(`<${list.type}>${list.items.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join("")}</${list.type}>`);
      list = null;
    }

    function flushCode() {
      if (!codeFence) {
        return;
      }
      const className = codeFence.language ? ` class="language-${escapeAttribute(codeFence.language)}"` : "";
      blocks.push(`<pre><code${className}>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
      codeFence = null;
      codeLines = [];
    }

    lines.forEach((line) => {
      const fenceMatch = line.match(/^\s*```([\w-]*)\s*$/);
      if (fenceMatch) {
        if (codeFence) {
          flushCode();
          return;
        }
        flushParagraph();
        flushList();
        codeFence = { language: fenceMatch[1] || "" };
        codeLines = [];
        return;
      }

      if (codeFence) {
        codeLines.push(line);
        return;
      }

      if (!line.trim()) {
        flushParagraph();
        flushList();
        return;
      }

      const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
      if (headingMatch) {
        flushParagraph();
        flushList();
        const level = headingMatch[1].length;
        blocks.push(`<h${level}>${renderInlineMarkdown(headingMatch[2])}</h${level}>`);
        return;
      }

      const quoteMatch = line.match(/^>\s?(.*)$/);
      if (quoteMatch) {
        flushParagraph();
        flushList();
        blocks.push(`<blockquote>${renderInlineMarkdown(quoteMatch[1])}</blockquote>`);
        return;
      }

      const unorderedMatch = line.match(/^\s*[-*+]\s+(.+)$/);
      const orderedMatch = line.match(/^\s*\d+[.)]\s+(.+)$/);
      if (unorderedMatch || orderedMatch) {
        flushParagraph();
        const type = unorderedMatch ? "ul" : "ol";
        if (!list || list.type !== type) {
          flushList();
          list = { type, items: [] };
        }
        list.items.push(unorderedMatch ? unorderedMatch[1] : orderedMatch[1]);
        return;
      }

      flushList();
      paragraph.push(line);
    });

    flushParagraph();
    flushList();
    flushCode();
    return blocks.join("");
  }

  function renderInlineMarkdown(text) {
    const codeParts = String(text || "").split(/(`[^`]*`)/g);
    return codeParts.map((part) => {
      if (/^`[^`]*`$/.test(part)) {
        return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
      }
      return escapeHtml(part)
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/__([^_]+)__/g, "<strong>$1</strong>")
        .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
        .replace(/_([^_\n]+)_/g, "<em>$1</em>")
        .replace(/\n/g, "<br>");
    }).join("");
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function escapeAttribute(value) {
    return String(value || "").replace(/[^\w-]/g, "");
  }

  function appendSanitizedNode(parent, sourceNode) {
    const sanitized = sanitizeNode(sourceNode);
    if (sanitized) {
      parent.append(sanitized);
    }
  }

  function sanitizeNode(sourceNode) {
    if (sourceNode.nodeType === Node.TEXT_NODE) {
      return document.createTextNode(sourceNode.nodeValue || "");
    }
    if (sourceNode.nodeType !== Node.ELEMENT_NODE) {
      return null;
    }

    const tagName = sourceNode.tagName.toLowerCase();
    if (!ALLOWED_TAGS.has(tagName)) {
      const fragment = document.createDocumentFragment();
      Array.from(sourceNode.childNodes).forEach((child) => appendSanitizedNode(fragment, child));
      return fragment;
    }

    const element = document.createElement(tagName);
    copySafeAttributes(sourceNode, element, tagName);
    Array.from(sourceNode.childNodes).forEach((child) => appendSanitizedNode(element, child));
    return element;
  }

  function copySafeAttributes(sourceNode, targetNode, tagName) {
    if (tagName === "a") {
      const href = sourceNode.getAttribute("href") || "";
      if (isSafeLinkHref(href)) {
        targetNode.setAttribute("href", href);
        targetNode.setAttribute("target", "_blank");
        targetNode.setAttribute("rel", "noopener noreferrer");
      }
      const title = sourceNode.getAttribute("title");
      if (title) {
        targetNode.setAttribute("title", title);
      }
    }

    if (tagName === "code") {
      const className = getSafeCodeClass(sourceNode.getAttribute("class") || "");
      if (className) {
        targetNode.setAttribute("class", className);
      }
    }

    if (tagName === "td" || tagName === "th") {
      copyPositiveIntegerAttribute(sourceNode, targetNode, "colspan");
      copyPositiveIntegerAttribute(sourceNode, targetNode, "rowspan");
    }

    if (tagName === "ol") {
      copyPositiveIntegerAttribute(sourceNode, targetNode, "start");
    }
  }

  function isSafeLinkHref(href) {
    return /^(https?:|mailto:)/i.test(href);
  }

  function getSafeCodeClass(className) {
    const safeClasses = className.split(/\s+/).filter((name) => /^language-[\w-]+$/.test(name));
    return safeClasses.join(" ");
  }

  function copyPositiveIntegerAttribute(sourceNode, targetNode, attributeName) {
    const value = sourceNode.getAttribute(attributeName);
    if (/^[1-9]\d{0,2}$/.test(value || "")) {
      targetNode.setAttribute(attributeName, value);
    }
  }

  globalThis.CGQASanitize = {
    sanitizeMessageHtml,
    renderStreamingMarkdown
  };
})();
