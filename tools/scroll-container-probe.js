// DevTools snippet for finding the active scroll container on AI web pages.
// Paste this whole file into the browser console, then scroll the page.
// Stop it with: window.CGQAScrollProbe.stop()
(function () {
  "use strict";

  const PROBE_KEY = "CGQAScrollProbe";
  const LOG_INTERVAL_MS = 160;
  const MAX_INITIAL_CANDIDATES = 12;

  const existingProbe = window[PROBE_KEY];
  if (existingProbe && typeof existingProbe.stop === "function") {
    existingProbe.stop();
  }

  let lastLogAt = 0;
  let queuedEvent = null;
  let frameId = 0;

  function isScrollableElement(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) {
      return false;
    }
    const style = getComputedStyle(element);
    const canScrollY = /(auto|scroll|overlay)/.test(style.overflowY);
    return canScrollY && element.scrollHeight > element.clientHeight + 8;
  }

  function getElementSummary(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) {
      return null;
    }
    return {
      tag: element.tagName,
      id: element.id || "",
      className: String(element.className || "").slice(0, 160),
      scrollTop: Math.round(element.scrollTop * 100) / 100,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      selector: getShortSelector(element)
    };
  }

  function getShortSelector(element) {
    const parts = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 5) {
      let part = current.tagName.toLowerCase();
      if (current.id) {
        part += `#${CSS.escape(current.id)}`;
        parts.unshift(part);
        break;
      }
      const stableClass = Array.from(current.classList || []).find((name) => {
        return !/[:()[\]\/]/.test(name) && name.length <= 48;
      });
      if (stableClass) {
        part += `.${CSS.escape(stableClass)}`;
      }
      parts.unshift(part);
      current = current.parentElement;
    }
    return parts.join(" > ");
  }

  function findScrollableAncestor(target) {
    let current = target && target.nodeType === Node.ELEMENT_NODE ? target : target && target.parentElement;
    while (current && current !== document.documentElement) {
      if (isScrollableElement(current)) {
        return current;
      }
      current = current.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function logScroll(event) {
    queuedEvent = event;
    if (frameId) {
      return;
    }
    frameId = requestAnimationFrame(() => {
      frameId = 0;
      const now = Date.now();
      if (now - lastLogAt < LOG_INTERVAL_MS) {
        return;
      }
      lastLogAt = now;
      const element = findScrollableAncestor(queuedEvent && queuedEvent.target);
      console.log("[CGQA scroll]", getElementSummary(element));
    });
  }

  function scanCandidates() {
    return Array.from(document.querySelectorAll("body *"))
      .filter(isScrollableElement)
      .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))
      .slice(0, MAX_INITIAL_CANDIDATES)
      .map(getElementSummary);
  }

  function stop() {
    document.removeEventListener("scroll", logScroll, true);
    if (frameId) {
      cancelAnimationFrame(frameId);
      frameId = 0;
    }
    delete window[PROBE_KEY];
    console.log("[CGQA scroll] stopped");
  }

  document.addEventListener("scroll", logScroll, true);

  window[PROBE_KEY] = {
    stop,
    scan: scanCandidates
  };

  console.log("[CGQA scroll] started. Scroll the page, or run window.CGQAScrollProbe.scan().");
  console.table(scanCandidates());
})();
