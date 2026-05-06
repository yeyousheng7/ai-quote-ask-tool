(function () {
  "use strict";

  const USER_SCROLL_EVENTS = ["wheel", "touchmove", "keydown"];
  const USER_SCROLL_IDLE_MS = 900;
  const SCROLL_KEYS = new Set([
    "ArrowDown",
    "ArrowUp",
    "End",
    "Home",
    "PageDown",
    "PageUp",
    " ",
    "Spacebar"
  ]);

  function create() {
    let active = false;
    let userScrolling = false;
    let lockedX = 0;
    let lockedY = 0;
    let restoreTimer = 0;
    let relockTimer = 0;

    function lock() {
      unlock();
      active = true;
      userScrolling = false;
      lockedX = window.scrollX;
      lockedY = window.scrollY;
      USER_SCROLL_EVENTS.forEach((type) => window.addEventListener(type, handleUserScrollIntent, {
        capture: true,
        passive: true
      }));
      window.addEventListener("scroll", handleScroll, true);
    }

    function unlock() {
      if (restoreTimer) {
        clearTimeout(restoreTimer);
        restoreTimer = 0;
      }
      if (relockTimer) {
        clearTimeout(relockTimer);
        relockTimer = 0;
      }
      active = false;
      userScrolling = false;
      USER_SCROLL_EVENTS.forEach((type) => window.removeEventListener(type, handleUserScrollIntent, true));
      window.removeEventListener("scroll", handleScroll, true);
    }

    function handleUserScrollIntent(event) {
      if (!active) {
        return;
      }
      if (event.type === "keydown" && !SCROLL_KEYS.has(event.key)) {
        return;
      }
      pauseForUserScroll();
    }

    function handleScroll() {
      if (!active || userScrolling) {
        return;
      }
      if (restoreTimer) {
        return;
      }
      restoreTimer = setTimeout(() => {
        restoreTimer = 0;
        if (!active || userScrolling) {
          return;
        }
        if (window.scrollX !== lockedX || window.scrollY !== lockedY) {
          window.scrollTo(lockedX, lockedY);
        }
      }, 0);
    }

    function pauseForUserScroll() {
      userScrolling = true;
      if (restoreTimer) {
        clearTimeout(restoreTimer);
        restoreTimer = 0;
      }
      if (relockTimer) {
        clearTimeout(relockTimer);
      }
      relockTimer = setTimeout(() => {
        relockTimer = 0;
        if (!active) {
          return;
        }
        lockedX = window.scrollX;
        lockedY = window.scrollY;
        userScrolling = false;
      }, USER_SCROLL_IDLE_MS);
    }

    return {
      lock,
      unlock
    };
  }

  globalThis.CGQAScrollLock = { create };
})();
