(function () {
  "use strict";

  const CONTENT_VERSION = "0.7.35-stream-cleanup";
  const RUNTIME_KEY = "CGQAContentRuntime";

  const existingRuntime = globalThis[RUNTIME_KEY];
  if (existingRuntime && existingRuntime.version === CONTENT_VERSION) {
    return;
  }
  if (existingRuntime && typeof existingRuntime.destroy === "function") {
    existingRuntime.destroy();
  }

  const state = {
    providerId: "",
    providerLabel: "",
    conversationId: "",
    threads: [],
    activeThreadId: "",
    pendingSelection: null,
    pendingResponse: null,
    pendingCaptureObserver: null,
    restoreTimers: [],
    locationCheckTimers: [],
    pendingCaptureTimer: 0,
    pendingCaptureMutationTimer: 0,
    pendingDecorationTimer: 0,
    pendingStableTimer: 0,
    active: false,
    creatingThread: false,
    loadingConversation: false,
    restoring: false,
    replyStyle: {
      mode: "default",
      customPrompt: ""
    },
    compatibility: {
      keepProviderUiVisibleDuringSend: false
    },
    theme: "green",
    cleanupTasks: [],
    activeCleanupTasks: []
  };

  const RESPONSE_STABLE_DELAY_MS = 2500;
  const PENDING_MUTATION_CAPTURE_DELAY_MS = 50;
  const PENDING_DECORATION_SYNC_DELAY_MS = 250;
  const RESPONSE_TIMEOUT_MS = 120000;
  const RESTORE_DELAYS_MS = [250, 1000, 2500, 5000];
  const LOCATION_CHECK_DELAYS_MS = [0, 250, 1000];
  const PROMPT_TOKEN_PREFIX = "CGQA_PROMPT";

  let sidebar = null;
  let provider = null;
  let pendingScrollLock = null;

  function uid(prefix) {
    if (crypto && crypto.randomUUID) {
      return `${prefix}_${crypto.randomUUID()}`;
    }
    return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }

  async function init() {
    bindRuntimeMessages();
    bindNavigationEvents();
    bindSettingsEvents();
    await reconcileLocation();
  }

  async function activateProvider(nextProvider) {
    provider = nextProvider;
    globalThis.CGQAProvider = provider;
    state.active = true;
    pendingScrollLock = CGQAScrollLock.create({
      getTarget: () => provider && provider.getScrollContainer ? provider.getScrollContainer() : null
    });
    syncProviderState();
    state.replyStyle = await loadReplyStyle();
    state.compatibility = await loadCompatibilitySettings();
    state.theme = await loadTheme();
    applyTheme(state.theme);
    sidebar = CGQASidebar.buildSidebar({
      onClose: closeSidebar,
      onBeforeSend: lockPendingScroll,
      onSend: sendQuestion,
      onRefreshAssistantMessage: refreshAssistantMessage,
      onDeleteThread: deleteActiveThread,
      getAssistantLabel: () => state.providerLabel,
      getReplyStyle: () => state.replyStyle,
      onReplyStyleChange: saveReplyStyle
    });

    await loadThreads();
    bindEvents();
    provider.clearRenderedMarks();
    scheduleRestoreBurst();
    syncPageDecorations();
  }

  function getPageProvider() {
    const providers = Array.isArray(globalThis.CGQAProviders) ? globalThis.CGQAProviders : [];
    return providers.find((item) => {
      return item && typeof item.matchesLocation === "function" && item.matchesLocation(location);
    }) || null;
  }

  function syncProviderState() {
    state.providerId = provider.id;
    state.providerLabel = provider.label;
    state.conversationId = provider.getConversationId();
  }

  async function loadReplyStyle() {
    try {
      return normalizeReplyStyle(await CGQAStorage.getReplyStyleSettings());
    } catch (error) {
      console.error("[CGQA] load reply style failed", error);
      return { mode: "default", customPrompt: "" };
    }
  }

  async function loadTheme() {
    try {
      return normalizeTheme(await CGQAStorage.getThemeSettings());
    } catch (error) {
      console.error("[CGQA] load theme failed", error);
      return "green";
    }
  }

  async function loadCompatibilitySettings() {
    if (!CGQAStorage || typeof CGQAStorage.getCompatibilitySettings !== "function") {
      return normalizeCompatibilitySettings(null);
    }
    try {
      return normalizeCompatibilitySettings(await CGQAStorage.getCompatibilitySettings());
    } catch (error) {
      console.error("[CGQA] load compatibility settings failed", error);
      return normalizeCompatibilitySettings(null);
    }
  }

  function applyTheme(theme) {
    state.theme = normalizeTheme(theme);
    if (globalThis.CGQATheme && typeof CGQATheme.applyTheme === "function") {
      CGQATheme.applyTheme(state.theme);
    } else {
      document.documentElement.dataset.cgqaTheme = state.theme;
    }
  }

  async function loadThreads() {
    syncProviderState();
    const storedThreads = await CGQAStorage.listThreads(getConversationRef());
    state.threads = storedThreads.map(normalizeThread).filter(Boolean);
  }

  function getConversationRef() {
    return {
      providerId: state.providerId,
      providerLabel: state.providerLabel,
      conversationId: state.conversationId
    };
  }

  function normalizeThread(thread) {
    if (!isCurrentThreadShape(thread)) {
      return null;
    }

    return {
      ...thread,
      sourceProviderId: thread.sourceProviderId || state.providerId,
      sourceProviderLabel: thread.sourceProviderLabel || state.providerLabel,
      quoteText: String(thread.quoteText || ""),
      messages: Array.isArray(thread.messages) ? thread.messages : [],
      mainChatItems: getMainChatItems(thread)
    };
  }

  function isCurrentThreadShape(thread) {
    return Boolean(
      thread
      && thread.threadId
      && thread.quoteId
      && thread.quoteText !== undefined
      && thread.sourceConversationId
      && Number.isInteger(thread.displayIndex)
      && thread.anchor
      && thread.anchor.threadId === thread.threadId
      && thread.anchor.quoteId === thread.quoteId
      && Number.isInteger(thread.anchor.startOffset)
      && Number.isInteger(thread.anchor.endOffset)
      && typeof thread.anchor.exactText === "string"
    );
  }

  function bindEvents() {
    addActiveEvent(document, "mouseup", handleMouseUp, true);
    addActiveEvent(document, "keydown", handleKeydown, true);
    addActiveEvent(document, "click", handleQuoteMarkClick, true);
  }

  function bindSettingsEvents() {
    if (!chrome.storage || !chrome.storage.onChanged) {
      return;
    }

    const handleStorageChange = (changes, areaName) => {
      if (areaName !== "local" || !changes["cgqa:settings:v1"]) {
        return;
      }
      if (state.active) {
        loadTheme().then(applyTheme).catch((error) => {
          console.error("[CGQA] apply changed theme failed", error);
        });
        loadReplyStyle().then((replyStyle) => {
          state.replyStyle = replyStyle;
          sidebar && sidebar.render(getThread(state.activeThreadId) || null, { reason: "update" });
        }).catch((error) => {
          console.error("[CGQA] apply changed reply style failed", error);
        });
        loadCompatibilitySettings().then((compatibility) => {
          state.compatibility = compatibility;
        }).catch((error) => {
          console.error("[CGQA] apply changed compatibility settings failed", error);
        });
      }
      reconcileLocation().catch((error) => {
        console.error("[CGQA] reconcile provider setting failed", error);
      });
    };
    chrome.storage.onChanged.addListener(handleStorageChange);
    state.cleanupTasks.push(() => chrome.storage.onChanged.removeListener(handleStorageChange));
  }

  function bindRuntimeMessages() {
    if (!chrome.runtime || !chrome.runtime.onMessage) {
      return;
    }

    const handleMessage = (message, _sender, sendResponse) => {
      if (!message || message.type !== "CGQA_REPAIR_PAGE") {
        return false;
      }
      repairCurrentPage().then(sendResponse).catch((error) => {
        sendResponse({
          ok: false,
          message: error && error.message || "整理当前页面失败。"
        });
      });
      return true;
    };
    chrome.runtime.onMessage.addListener(handleMessage);
    state.cleanupTasks.push(() => chrome.runtime.onMessage.removeListener(handleMessage));
  }

  function addRuntimeEvent(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    state.cleanupTasks.push(() => target.removeEventListener(type, handler, options));
  }

  function addActiveEvent(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    state.activeCleanupTasks.push(() => target.removeEventListener(type, handler, options));
  }

  function handleKeydown(event) {
    if (event.key === "Escape") {
      CGQASidebar.hideSelectionMenu();
    }
  }

  function bindNavigationEvents() {
    const scheduleCheck = () => scheduleConversationCheckBurst();
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function (...args) {
      const result = originalPushState.apply(this, args);
      scheduleCheck();
      return result;
    };
    history.replaceState = function (...args) {
      const result = originalReplaceState.apply(this, args);
      scheduleCheck();
      return result;
    };

    state.cleanupTasks.push(() => {
      history.pushState = originalPushState;
      history.replaceState = originalReplaceState;
    });
    addRuntimeEvent(window, "popstate", scheduleCheck);
    addRuntimeEvent(window, "pageshow", scheduleCheck);
    addRuntimeEvent(window, "focus", scheduleCheck);
    addRuntimeEvent(document, "click", scheduleCheck, true);
  }

  function scheduleConversationCheckBurst() {
    clearLocationCheckTimers();
    state.locationCheckTimers = LOCATION_CHECK_DELAYS_MS.map((delay) => {
      return setTimeout(() => {
        reconcileLocation().catch((error) => {
          console.error("[CGQA] reconcile location failed", error);
        });
      }, delay);
    });
  }

  async function reconcileLocation() {
    if (state.loadingConversation) {
      return;
    }

    const nextProvider = getPageProvider();
    const providerEnabled = nextProvider ? await isProviderEnabled(nextProvider.id) : false;
    if (!nextProvider || !providerEnabled) {
      if (state.active) {
        deactivateProvider();
      } else {
        delete globalThis.CGQAProvider;
      }
      return;
    }

    if (!state.active || !provider || provider.id !== nextProvider.id) {
      if (state.active) {
        deactivateProvider();
      }
      state.loadingConversation = true;
      try {
        await activateProvider(nextProvider);
      } finally {
        state.loadingConversation = false;
      }
      return;
    }

    const nextConversationId = provider.getConversationId();
    if (nextConversationId !== state.conversationId) {
      await switchConversation();
    }
  }

  async function isProviderEnabled(providerId) {
    if (!CGQAStorage || typeof CGQAStorage.isProviderEnabled !== "function") {
      return true;
    }
    try {
      return await CGQAStorage.isProviderEnabled(providerId);
    } catch (error) {
      if (isExtensionContextInvalidated(error)) {
        console.warn("[CGQA] extension context invalidated; refresh the page to reload the helper.");
        setTimeout(destroy, 0);
        return false;
      }
      console.error("[CGQA] load provider setting failed", error);
      return true;
    }
  }

  function isExtensionContextInvalidated(error) {
    const message = String(error && (error.message || error.toString && error.toString()) || "");
    return /extension context invalidated/i.test(message);
  }

  async function switchConversation() {
    state.loadingConversation = true;
    resetTransientState();
    closeSidebar();
    CGQASidebar.hideSelectionMenu();
    provider.clearRenderedMarks();
    syncMainChatVisibility([]);

    try {
      await loadThreads();
      scheduleRestoreBurst();
      syncPageDecorations();
    } finally {
      state.loadingConversation = false;
    }
  }

  function deactivateProvider() {
    resetTransientState();
    closeSidebar();
    CGQASidebar.hideSelectionMenu();
    if (provider && provider.clearRenderedMarks) {
      provider.clearRenderedMarks();
    }
    if (provider && provider.syncHiddenMainTurns) {
      provider.syncHiddenMainTurns([]);
    }
    if (provider && provider.setMainComposerHidden) {
      provider.setMainComposerHidden(false);
    }
    if (provider && provider.setNativeGenerationControlsHidden) {
      provider.setNativeGenerationControlsHidden(false);
    }
    if (provider && provider.syncPendingResponseState) {
      provider.syncPendingResponseState({ active: false, threadId: "", promptToken: "" });
    }
    state.activeCleanupTasks.splice(0).forEach((cleanup) => cleanup());
    if (sidebar && typeof sidebar.destroy === "function") {
      sidebar.destroy();
    } else if (sidebar) {
      sidebar.render(null);
    }
    sidebar = null;
    pendingScrollLock = null;
    provider = null;
    delete globalThis.CGQAProvider;
    state.active = false;
    state.providerId = "";
    state.providerLabel = "";
    state.conversationId = "";
    state.threads = [];
    state.activeThreadId = "";
  }

  function resetTransientState() {
    state.pendingSelection = null;
    state.pendingResponse = null;
    stopPendingCaptureWatcher();
    unlockPendingScroll();
    clearPendingStableTimer();
  }

  function handleMouseUp(event) {
    if (isPluginUi(event.target)) {
      return;
    }
    if (!state.active || !provider) {
      return;
    }

    setTimeout(() => {
      if (!state.active || !provider) {
        return;
      }
      const selection = window.getSelection();
      const result = provider.validateSelection(selection);
      if (!result.ok) {
        CGQASidebar.hideSelectionMenu();
        if (selection && !selection.isCollapsed && result.reason) {
          CGQASidebar.showToast(result.reason);
        }
        return;
      }

      state.pendingSelection = result;
      CGQASidebar.showSelectionMenu(result.range.getBoundingClientRect(), createThreadFromSelection, {
        attachSelectionAction: provider.attachSelectionAction
      });
    }, 0);
  }

  function isPluginUi(target) {
    return Boolean(target && target.closest && target.closest([
      ".cgqa-root",
      ".cgqa-selection-menu",
      ".cgqa-selection-attached-button",
      ".cgqa-block-reference-bar",
      ".cgqa-block-reference-chip",
      ".cgqa-block-reference-more",
      ".cgqa-toast"
    ].join(",")));
  }

  function createThreadFromSelection() {
    if (state.creatingThread) {
      return;
    }

    state.creatingThread = true;
    CGQASidebar.hideSelectionMenu();

    try {
      const selection = state.pendingSelection;
      if (!selection || !selection.ok) {
        return;
      }

      if (selection.complex) {
        CGQASidebar.showToast("当前选区包含公式或代码结构，将使用保守标记。");
      }

      startDraftThread(selection);
    } catch (error) {
      console.error("[CGQA] create thread failed", error);
      CGQASidebar.showToast("创建批注失败，请刷新页面后重试。");
    } finally {
      state.creatingThread = false;
    }
  }

  function buildThread(selection) {
    const now = Date.now();
    const quoteId = uid("quote");
    const threadId = uid("thread");
    const sourceTurnId = provider.getTurnId(selection.turn);
    const sourceMessageId = selection.sourceMessageId || provider.getMessageId(selection.turn);
    const quoteText = selection.exactText || selection.selectedText;
    const conversationMeta = getConversationMeta();

    return {
      threadId,
      quoteId,
      quoteText,
      sourceProviderId: state.providerId,
      sourceProviderLabel: state.providerLabel,
      sourceConversationId: state.conversationId,
      sourceTurnId,
      sourceMessageId,
      displayIndex: getNextDisplayIndex(),
      anchor: {
        quoteId,
        sourceProviderId: state.providerId,
        sourceConversationId: state.conversationId,
        sourceTurnId,
        sourceMessageId,
        startOffset: selection.startOffset,
        endOffset: selection.endOffset,
        markdownIndex: Number.isInteger(selection.markdownIndex) ? selection.markdownIndex : 0,
        exactText: quoteText,
        prefixText: selection.prefixText || "",
        suffixText: selection.suffixText || "",
        threadId
      },
      messages: [],
      mainChatItems: [],
      createdAt: now,
      updatedAt: now,
      sourceTitle: conversationMeta.title,
      sourceUrl: conversationMeta.url
    };
  }

  function getConversationMeta() {
    return provider.getConversationMeta();
  }

  function startDraftThread(selection) {
    discardEmptyActiveThread();
    const thread = buildThread(selection);
    registerThread(thread);
    renderDraftThreadMark(thread, selection);
    openThread(thread.threadId);
    clearCurrentSelection();
    state.pendingSelection = null;
  }

  function registerThread(thread) {
    state.threads.push(thread);
  }

  function getNextDisplayIndex() {
    return state.threads.reduce((max, thread) => {
      return Math.max(max, Number(thread.displayIndex) || 0);
    }, 0) + 1;
  }

  function renderThreadMark(thread, options = {}) {
    try {
      const rendered = provider.renderThreadMark(thread);
      if (!rendered && options.notify) {
        CGQASidebar.showToast("已创建批注，但当前 DOM 无法安全渲染正文标记。");
      }
    } catch (error) {
      console.error("[CGQA] render mark failed", error);
      if (options.notify) {
        CGQASidebar.showToast("已打开批注小窗，但正文标记渲染失败。");
      }
    }
  }

  function renderDraftThreadMark(thread, selection) {
    try {
      const rendered = provider.renderDraftThreadMark(thread, selection.markdown, selection.range);
      if (!rendered && selection.complex) {
        CGQASidebar.showToast("已打开提问小窗，复杂选区将在发送后尝试恢复标记。");
      }
    } catch (error) {
      console.error("[CGQA] render draft mark failed", error);
    }
  }

  function ensurePersistedThreadMark(thread, options = {}) {
    const promoted = provider.promoteThreadMark(thread);
    if (!promoted) {
      renderThreadMark(thread, options);
    }
    provider.updateMarkChip(thread);
  }

  function clearCurrentSelection() {
    const selection = window.getSelection();
    if (selection) {
      selection.removeAllRanges();
    }
  }

  function openThread(threadId) {
    const thread = getThread(threadId);
    if (!thread) {
      console.warn("[CGQA] openThread missing thread", threadId);
      return;
    }

    state.activeThreadId = threadId;
    lockPendingScroll({ resetPosition: true });
    provider.setActiveMark(threadId);
    sidebar.render(thread, { reason: "open" });
    sidebar.focusInput();
    syncPanelDecorations();
  }

  function handleQuoteMarkClick(event) {
    const path = event.composedPath ? event.composedPath() : [];
    const marks = path.filter((node) => node && node.classList && node.classList.contains("cgqa-quote-mark"));
    if (marks.length === 0) {
      return;
    }

    const threadIds = [...new Set(marks.map((mark) => mark.dataset.threadId).filter(Boolean))];
    if (threadIds.length === 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (threadIds.length === 1) {
      openThread(threadIds[0]);
      return;
    }

    const threads = threadIds.map(getThread).filter(Boolean);
    CGQASidebar.showThreadChoiceMenu(marks[0].getBoundingClientRect(), threads, openThread);
  }

  function closeSidebar() {
    const activeThread = getThread(state.activeThreadId);
    const shouldSyncKnownMainChatAfterClose = Boolean(
      activeThread
      && hasThreadStarted(activeThread)
      && !state.loadingConversation
    );

    discardEmptyActiveThread();
    state.activeThreadId = "";
    provider.setActiveMark("");
    sidebar.render(null);
    syncPanelDecorations();
    if (shouldSyncKnownMainChatAfterClose) {
      syncKnownMainChatVisibility(getMainChatHideTargets());
    }
    unlockPanelScrollIfIdle();
  }

  function discardEmptyActiveThread() {
    const threadId = state.activeThreadId;
    if (!threadId) {
      return;
    }

    const thread = getThread(threadId);
    if (thread && !hasThreadStarted(thread)) {
      removeThreadFromRuntime(threadId);
    }
  }

  function removeThreadFromRuntime(threadId) {
    provider.removeThreadMark(threadId);
    state.threads = state.threads.filter((thread) => thread.threadId !== threadId);
  }

  function restorePersistedMarks() {
    state.threads.filter(hasThreadStarted).forEach((thread) => ensurePersistedThreadMark(thread));
  }

  function getThread(threadId) {
    return state.threads.find((thread) => thread.threadId === threadId);
  }

  async function saveAndRenderThread(thread, renderOptions = {}) {
    try {
      const savedThread = await CGQAStorage.saveThread(thread, getConversationMeta());
      replaceThread(savedThread);
      renderSavedThread(savedThread, renderOptions);
      return savedThread;
    } catch (error) {
      console.error("[CGQA] save thread failed", error);
      CGQASidebar.showToast(getSaveThreadErrorMessage(error));
      replaceThread(thread);
      renderSavedThread(thread, renderOptions);
      return thread;
    }
  }

  function getSaveThreadErrorMessage(error) {
    const message = String(error && (error.message || error.toString && error.toString()) || "");
    if (/extension context invalidated/i.test(message)) {
      return "扩展刚刚重新加载过，请刷新当前页面后再保存提问。";
    }
    return "本地保存失败，本次批注仍会保留在当前页面。";
  }

  function replaceThread(nextThread) {
    const index = state.threads.findIndex((thread) => thread.threadId === nextThread.threadId);
    if (index >= 0) {
      state.threads[index] = nextThread;
      return;
    }
    state.threads.push(nextThread);
  }

  function renderSavedThread(thread, options = {}) {
    if (hasThreadStarted(thread)) {
      ensurePersistedThreadMark(thread, { notify: true });
    }
    if (thread.threadId === state.activeThreadId) {
      sidebar.render(thread, options);
    }
  }

  function buildPrompt(thread, question, promptToken) {
    const styleInstruction = getReplyStyleInstruction();
    const lines = [
      `围绕 提问 ${thread.displayIndex} 的批注提问`,
      "",
      "这是插件生成的临时批注追问，用于围绕当前引用片段继续提问。",
      "请优先根据本次 <quote> 和 <user_question> 回答；为理解引用来源、术语或上下文关系，可以参考主线正文和前文上下文。",
      "如果当前问题延续了同一批注线程，可以参考前面相关的批注追问和回答。",
      "这段批注任务说明只适用于当前带有 <tracking_token> 的插件追问，不应改变或延续到后续用户在主对话中的普通提问。",
      "请不要在回答中提及或输出追踪标记。",
    ];
    if (styleInstruction) {
      lines.push(styleInstruction);
    }
    return [
      ...lines,
      "",
      "<quote>",
      thread.quoteText,
      "</quote>",
      "",
      "<user_question>",
      question,
      "</user_question>",
      "",
      "<tracking_token>",
      promptToken,
      "</tracking_token>"
    ].join("\n");
  }

  function getReplyStyleInstruction() {
    const mode = state.replyStyle && state.replyStyle.mode || "default";
    if (mode === "longer") {
      return "回复风格要求：在保持准确和相关的前提下，回答得稍微完整、展开一些。";
    }
    if (mode === "shorter") {
      return "回复风格要求：请尽量简洁回答，只保留必要信息。";
    }
    if (mode === "custom") {
      const customPrompt = String(state.replyStyle && state.replyStyle.customPrompt || "").trim();
      return customPrompt ? `回复风格要求：${customPrompt}` : "";
    }
    return "";
  }

  async function saveReplyStyle(replyStyle) {
    state.replyStyle = normalizeReplyStyle(replyStyle);
    try {
      state.replyStyle = await CGQAStorage.saveReplyStyleSettings(state.replyStyle);
    } catch (error) {
      console.error("[CGQA] save reply style failed", error);
      CGQASidebar.showToast("回复风格保存失败，本页临时生效。");
    }
    return state.replyStyle;
  }

  function normalizeReplyStyle(replyStyle) {
    const allowedModes = new Set(["default", "longer", "shorter", "custom"]);
    const customPrompt = String(replyStyle && replyStyle.customPrompt || "").trim();
    const selectedMode = allowedModes.has(replyStyle && replyStyle.mode) ? replyStyle.mode : "default";
    const mode = selectedMode === "custom" && !customPrompt ? "default" : selectedMode;
    return {
      mode,
      customPrompt
    };
  }

  function normalizeTheme(theme) {
    if (globalThis.CGQATheme && typeof CGQATheme.normalizeTheme === "function") {
      return CGQATheme.normalizeTheme(theme);
    }
    return ["green", "pink", "blue", "gold", "slate"].includes(theme) ? theme : "green";
  }

  function normalizeCompatibilitySettings(compatibility) {
    return {
      keepProviderUiVisibleDuringSend: Boolean(compatibility && compatibility.keepProviderUiVisibleDuringSend)
    };
  }

  async function sendQuestion(rawQuestion) {
    const question = (rawQuestion || "").trim();
    const thread = getThread(state.activeThreadId);
    if (!thread || !question) {
      unlockPanelScrollIfIdle();
      return;
    }
    if (state.pendingResponse || hasGeneratingMessage(thread)) {
      CGQASidebar.showToast("上一条追问仍在生成中，请稍后再发。");
      renderSavedThread(thread, { reason: "update" });
      sidebar.focusInput();
      if (!state.pendingResponse) {
        unlockPanelScrollIfIdle();
      }
      return;
    }

    const mainChatItem = createMainChatItem();
    thread.mainChatItems = [...getMainChatItems(thread), mainChatItem];

    const userMessage = {
      role: "user",
      content: question,
      createdAt: Date.now(),
      status: "completed"
    };
    const assistantMessage = {
      role: "assistant",
      content: "生成中...",
      createdAt: Date.now(),
      status: "generating",
      contentFormat: "text"
    };
    thread.messages.push(userMessage, assistantMessage);
    const scanContext = createTurnScanContext();
    state.pendingResponse = createResponseTracker(thread.threadId, mainChatItem.promptToken, scanContext, thread.messages.length - 1);
    if (shouldKeepProviderUiVisibleDuringSend()) {
      syncPanelDecorations();
    }
    lockPendingScroll();

    try {
      await saveAndRenderThread(thread, { reason: "send" });
      syncPageDecorations();
      startPendingCaptureWatcher();
      await provider.submitPrompt(buildPrompt(thread, question, mainChatItem.promptToken));
      syncPageDecorations();
    } catch (error) {
      state.pendingResponse = null;
      stopPendingCaptureWatcher();
      unlockPendingScroll();
      clearPendingStableTimer();
      assistantMessage.content = error.message || "发送失败。";
      assistantMessage.status = "failed";
      await saveAndRenderThread(thread, { reason: "complete" });
      syncPageDecorations();
      syncPanelDecorations();
      CGQASidebar.showToast(assistantMessage.content);
    }
  }

  function lockPendingScroll(options = {}) {
    if (pendingScrollLock) {
      pendingScrollLock.lock(options);
    }
  }

  function unlockPendingScroll() {
    if (pendingScrollLock) {
      pendingScrollLock.unlock();
    }
  }

  function unlockPanelScrollIfIdle() {
    if (!state.activeThreadId && !state.pendingResponse) {
      unlockPendingScroll();
    }
  }

  function hasGeneratingMessage(thread) {
    return (thread.messages || []).some((message) => message.role === "assistant" && message.status === "generating");
  }

  function hasThreadStarted(thread) {
    return Boolean(thread && Array.isArray(thread.messages) && thread.messages.some((message) => {
      return message.role === "user";
    }));
  }

  function createMainChatItem() {
    return {
      promptToken: `${PROMPT_TOKEN_PREFIX}:${uid("prompt")}`,
      createdAt: Date.now()
    };
  }

  function getMainChatItems(thread) {
    if (!Array.isArray(thread && thread.mainChatItems)) {
      return [];
    }
    return thread.mainChatItems.filter((item) => item && typeof item.promptToken === "string" && item.promptToken);
  }

  function getMainChatHideTargets() {
    const targets = [];
    state.threads.forEach((thread) => {
      const mainChatItems = getMainChatItems(thread);
      const hasPendingReply = hasGeneratingMessage(thread);
      mainChatItems.forEach((item, index) => {
        if (item && item.promptToken) {
          const isLatestActiveItem = thread.threadId === state.activeThreadId && index === mainChatItems.length - 1;
          targets.push({
            threadId: thread.threadId,
            promptToken: item.promptToken,
            unload: !isLatestActiveItem && (!hasPendingReply || index < mainChatItems.length - 1)
          });
        }
      });
    });
    return targets;
  }

  function syncMainChatVisibility(targets, options = {}) {
    if (!provider.syncHiddenMainTurns) {
      return;
    }
    const hasExplicitTargets = Array.isArray(targets);
    if (!hasExplicitTargets && shouldKeepProviderUiVisibleDuringSend()) {
      return;
    }
    const resolvedTargets = hasExplicitTargets ? targets : getMainChatHideTargets();
    if (!hasExplicitTargets && resolvedTargets.length === 0) {
      return;
    }
    const scanContext = options.scanContext || (!hasExplicitTargets ? getPendingScanContextForVisibility() : null);
    const result = provider.syncHiddenMainTurns(resolvedTargets, scanContext);
    recordPendingVisibilityScanResult(result, scanContext);
  }

  function shouldKeepProviderUiVisibleDuringSend() {
    return Boolean(
      state.pendingResponse
      && state.compatibility
      && state.compatibility.keepProviderUiVisibleDuringSend
    );
  }

  function syncKnownMainChatVisibility(targets) {
    if (!provider.syncKnownHiddenMainTurns) {
      return;
    }
    provider.syncKnownHiddenMainTurns(Array.isArray(targets) ? targets : getMainChatHideTargets());
  }

  function syncMainComposerVisibility() {
    if (!provider.setMainComposerHidden) {
      return;
    }
    if (shouldKeepProviderUiVisibleDuringSend()) {
      provider.setMainComposerHidden(false);
      return;
    }
    provider.setMainComposerHidden(Boolean(state.activeThreadId));
  }

  function syncNativeGenerationControlsVisibility() {
    if (!provider.setNativeGenerationControlsHidden) {
      return;
    }
    provider.setNativeGenerationControlsHidden(Boolean(state.activeThreadId));
  }

  function syncProviderPendingResponseState() {
    if (!provider.syncPendingResponseState) {
      return;
    }
    provider.syncPendingResponseState({
      active: Boolean(state.pendingResponse),
      threadId: state.pendingResponse && state.pendingResponse.threadId || "",
      promptToken: state.pendingResponse && state.pendingResponse.promptToken || ""
    });
  }

  function syncPageDecorations() {
    syncMainChatVisibility();
    syncPanelDecorations();
  }

  async function repairCurrentPage() {
    await reconcileLocation();
    if (!state.active || !provider) {
      return {
        ok: false,
        message: "当前页面未启用提问助手。"
      };
    }

    const targets = getMainChatHideTargets();
    syncMainChatVisibility(targets);
    syncKnownMainChatVisibility(targets);
    restorePersistedMarks();
    scheduleRestoreBurst();
    syncPageDecorations();
    return {
      ok: true,
      message: `已整理当前页面：${state.threads.length} 个提问，${targets.length} 条临时消息。`
    };
  }

  function syncPanelDecorations() {
    syncMainComposerVisibility();
    syncNativeGenerationControlsVisibility();
    syncProviderPendingResponseState();
  }

  function createTurnScanContext() {
    if (!provider || typeof provider.createTurnScanContext !== "function") {
      return null;
    }
    try {
      return provider.createTurnScanContext() || null;
    } catch (error) {
      console.warn("[CGQA] create turn scan context failed", error);
      return null;
    }
  }

  function createResponseTracker(threadId, promptToken, scanContext, messageIndex) {
    return {
      threadId,
      promptToken,
      scanContext: scanContext || null,
      messageIndex: Number.isInteger(messageIndex) ? messageIndex : -1,
      assistantSignature: "",
      candidate: null,
      latestText: "",
      latestHtml: "",
      localCaptureMissCount: 0,
      localVisibilityMissCount: 0,
      startedAt: Date.now(),
    };
  }

  function getPendingScanContext() {
    return state.pendingResponse && state.pendingResponse.scanContext || null;
  }

  function getPendingScanContextForVisibility() {
    const tracker = state.pendingResponse;
    if (!tracker || !tracker.scanContext) {
      return null;
    }
    return tracker.localVisibilityMissCount < 4 ? tracker.scanContext : null;
  }

  function recordPendingVisibilityScanResult(result, scanContext) {
    const tracker = state.pendingResponse;
    if (!tracker || !scanContext) {
      return;
    }
    if (result && result.local && result.matched) {
      tracker.localVisibilityMissCount = 0;
      return;
    }
    if (result && result.local) {
      tracker.localVisibilityMissCount += 1;
    }
  }

  function capturePendingAssistantIfReady() {
    if (!state.pendingResponse) {
      return;
    }

    const thread = getThread(state.pendingResponse.threadId);
    if (!thread) {
      state.pendingResponse = null;
      stopPendingCaptureWatcher();
      unlockPendingScroll();
      clearPendingStableTimer();
      syncPanelDecorations();
      return;
    }

    const generating = [...thread.messages].reverse().find((message) => {
      return message.role === "assistant" && message.status === "generating";
    });
    if (!generating) {
      state.pendingResponse = null;
      stopPendingCaptureWatcher();
      unlockPendingScroll();
      clearPendingStableTimer();
      syncPanelDecorations();
      return;
    }

    if (Date.now() - state.pendingResponse.startedAt > RESPONSE_TIMEOUT_MS) {
      generating.content = generating.content === "生成中..." ? "回答等待超时，请在主聊天中查看结果。" : generating.content;
      generating.status = "failed";
      state.pendingResponse = null;
      stopPendingCaptureWatcher();
      unlockPendingScroll();
      clearPendingStableTimer();
      saveAndRenderThread(thread, { reason: "complete" }).then(syncPageDecorations).catch((error) => {
        console.error("[CGQA] save timeout state failed", error);
      });
      syncPanelDecorations();
      return;
    }

    const candidate = findPendingAssistantCandidate(thread);
    if (!candidate || !candidate.text) {
      return;
    }

    applyStreamingCandidate(thread, generating, candidate);
    scheduleStableCandidateCapture(thread, generating, candidate);
  }

  function applyStreamingCandidate(thread, generating, candidate) {
    const tracker = state.pendingResponse;
    const text = candidate && candidate.text || "";
    if (!tracker || !text || text === thread.quoteText || !isUsableAssistantAnswer(text, thread)) {
      return;
    }

    const html = candidate && candidate.html || "";
    const htmlSanitized = !candidate || candidate.htmlSanitized !== false;
    if (text === tracker.latestText && html === tracker.latestHtml) {
      return;
    }

    tracker.latestText = text;
    tracker.latestHtml = html;
    generating.content = text;
    generating.html = htmlSanitized ? html : "";
    generating.contentFormat = htmlSanitized && html ? "html" : "text";
    generating.status = "generating";
    updateStreamingMessage(thread, generating, createStreamingDisplayUpdate(text, html, { htmlSanitized }));
  }

  function flushStreamingCandidate(thread, generating, text, html) {
    const tracker = state.pendingResponse;
    if (!tracker) {
      return;
    }
    tracker.latestText = text || tracker.latestText || "";
    tracker.latestHtml = html || tracker.latestHtml || "";
    generating.content = tracker.latestText;
    updateStreamingMessage(
      thread,
      generating,
      createStreamingDisplayUpdate(generating.content, tracker.latestHtml, {
        htmlSanitized: true
      })
    );
  }

  function createStreamingDisplayUpdate(text, html, options = {}) {
    if (html) {
      return { text, html, htmlSanitized: options.htmlSanitized !== false };
    }
    return { text, markdown: true };
  }

  function updateStreamingMessage(thread, generating, update) {
    const tracker = state.pendingResponse;
    if (!tracker || !thread || thread.threadId !== state.activeThreadId || !sidebar) {
      return;
    }
    if (typeof sidebar.updateStreamingMessage !== "function") {
      renderSavedThread(thread, { reason: "update" });
      return;
    }
    sidebar.updateStreamingMessage(thread.threadId, tracker.messageIndex, update || generating.content || "");
  }

  function scheduleStableCandidateCapture(thread, generating, candidate) {
    const signature = getAssistantRecordSignature(candidate);
    const pending = state.pendingResponse;
    if (!pending) {
      return;
    }

    const sameCandidate = pending.candidate
      && pending.candidate.signature === signature
      && pending.candidate.text === candidate.text;
    if (sameCandidate && state.pendingStableTimer) {
      return;
    }

    pending.candidate = { signature, text: candidate.text };
    clearPendingStableTimer();
    state.pendingStableTimer = setTimeout(async () => {
      state.pendingStableTimer = 0;
      if (!state.pendingResponse || state.pendingResponse.threadId !== thread.threadId) {
        return;
      }

      const latest = findAssistantRecordBySignature(signature, pending.scanContext, {
        mode: "final"
      }) || findPendingAssistantCandidate(thread);
      const text = latest ? latest.text : candidate.text;
      if (!text || text === thread.quoteText) {
        return;
      }
      if (isProviderResponseGenerating(pending.scanContext)) {
        scheduleStableCandidateCapture(thread, generating, latest || candidate);
        return;
      }
      const latestHtml = latest && latest.htmlSanitized === false ? "" : latest && latest.html || "";
      const candidateHtml = candidate.htmlSanitized === false ? "" : candidate.html || "";
      const finalHtml = latestHtml || candidateHtml;
      flushStreamingCandidate(thread, generating, text, finalHtml);
      generating.content = text;
      generating.html = finalHtml;
      generating.contentFormat = generating.html ? "html" : "text";
      generating.status = "completed";
      const completedResponse = state.pendingResponse;
      stopPendingCaptureWatcher();
      await saveAndRenderThread(thread, { reason: "complete" });
      await completeProviderPendingResponse(completedResponse);
      state.pendingResponse = null;
      unlockPendingScroll();
      syncPanelDecorations();
    }, RESPONSE_STABLE_DELAY_MS);
  }

  async function completeProviderPendingResponse(responseTracker) {
    if (!provider.completePendingResponse || !responseTracker) {
      return;
    }
    try {
      await provider.completePendingResponse({
        threadId: responseTracker.threadId,
        promptToken: responseTracker.promptToken
      });
    } catch (error) {
      console.warn("[CGQA] provider pending response cleanup failed", error);
    }
  }

  function findPendingAssistantCandidate(thread) {
    const tracker = state.pendingResponse;
    if (!tracker) {
      return null;
    }

    if (tracker.assistantSignature) {
      const record = findAssistantRecordBySignature(tracker.assistantSignature, tracker.scanContext, {
        mode: "stream"
      });
      if (record && isUsableAssistantAnswer(record.text, thread)) {
        tracker.localCaptureMissCount = 0;
        return record;
      }
    }

    const scanContext = tracker.localCaptureMissCount < 4 ? tracker.scanContext : null;
    const records = getAssistantMessageRecords(scanContext, { mode: "stream" });
    const turnRecords = getAllTurnRecords(scanContext);
    const followupRecord = findAssistantRecordAfterPromptToken(thread, records, tracker.promptToken, turnRecords);
    if (followupRecord) {
      tracker.assistantSignature = getAssistantRecordSignature(followupRecord);
      tracker.localCaptureMissCount = 0;
      return followupRecord;
    }

    if (scanContext) {
      tracker.localCaptureMissCount += 1;
      if (tracker.localCaptureMissCount < 4) {
        return null;
      }
    }

    const fullAssistantRecords = scanContext
      ? getAssistantMessageRecords(null, { mode: "stream" })
      : records;
    const fullTurnRecords = scanContext ? getAllTurnRecords(null) : turnRecords;
    const fullFollowupRecord = findAssistantRecordAfterPromptToken(thread, fullAssistantRecords, tracker.promptToken, fullTurnRecords);
    if (fullFollowupRecord) {
      tracker.assistantSignature = getAssistantRecordSignature(fullFollowupRecord);
      return fullFollowupRecord;
    }
    return null;
  }

  function isProviderResponseGenerating(scanContext) {
    if (!provider || typeof provider.isResponseGenerating !== "function") {
      return false;
    }
    try {
      return Boolean(provider.isResponseGenerating(scanContext || null));
    } catch (error) {
      console.warn("[CGQA] response generation state check failed", error);
      return false;
    }
  }

  function startPendingCaptureWatcher() {
    stopPendingCaptureWatcher();
    state.pendingCaptureTimer = setInterval(() => {
      capturePendingAssistantIfReady();
    }, 1000);

    const watchTarget = getPendingResponseWatchTarget();
    if (watchTarget) {
      state.pendingCaptureObserver = new MutationObserver(handlePendingMutation);
      state.pendingCaptureObserver.observe(watchTarget, { childList: true, subtree: true, characterData: true });
    }
  }

  function getPendingResponseWatchTarget() {
    if (provider && typeof provider.getPendingResponseWatchTarget === "function") {
      try {
        const target = provider.getPendingResponseWatchTarget(getPendingScanContext());
        if (target && target.nodeType === Node.ELEMENT_NODE) {
          return target;
        }
      } catch (error) {
        console.warn("[CGQA] get pending response watch target failed", error);
      }
    }
    return document.body || document.documentElement;
  }

  function stopPendingCaptureWatcher() {
    if (state.pendingCaptureTimer) {
      clearInterval(state.pendingCaptureTimer);
      state.pendingCaptureTimer = 0;
    }
    if (state.pendingCaptureObserver) {
      state.pendingCaptureObserver.disconnect();
      state.pendingCaptureObserver = null;
    }
    if (state.pendingCaptureMutationTimer) {
      clearTimeout(state.pendingCaptureMutationTimer);
      state.pendingCaptureMutationTimer = 0;
    }
    clearPendingDecorationTimer();
  }

  function handlePendingMutation() {
    if (!state.pendingResponse) {
      return;
    }

    schedulePendingCapture();
    schedulePendingDecorationSync();
  }

  function schedulePendingCapture() {
    if (state.pendingCaptureMutationTimer) {
      return;
    }
    state.pendingCaptureMutationTimer = setTimeout(() => {
      state.pendingCaptureMutationTimer = 0;
      capturePendingAssistantIfReady();
    }, PENDING_MUTATION_CAPTURE_DELAY_MS);
  }

  function schedulePendingDecorationSync() {
    if (state.pendingDecorationTimer) {
      return;
    }
    state.pendingDecorationTimer = setTimeout(() => {
      state.pendingDecorationTimer = 0;
      if (state.pendingResponse) {
        syncPageDecorations();
      }
    }, PENDING_DECORATION_SYNC_DELAY_MS);
  }

  function clearPendingDecorationTimer() {
    if (!state.pendingDecorationTimer) {
      return;
    }
    clearTimeout(state.pendingDecorationTimer);
    state.pendingDecorationTimer = 0;
  }

  function clearPendingStableTimer() {
    if (!state.pendingStableTimer) {
      return;
    }
    clearTimeout(state.pendingStableTimer);
    state.pendingStableTimer = 0;
  }

  function findAssistantRecordAfterPromptToken(thread, assistantRecords, promptToken, turnRecords) {
    if (!promptToken) {
      return null;
    }

    const records = Array.isArray(turnRecords) ? turnRecords : getAllTurnRecords(null);
    const promptIndex = findLastPromptUserRecordIndex(records, promptToken);
    if (promptIndex < 0) {
      return null;
    }

    for (let index = promptIndex + 1; index < records.length; index += 1) {
      const record = records[index];
      if (record.role === "user") {
        return null;
      }
      if (record.role !== "assistant") {
        continue;
      }
      const assistantRecord = findMatchingAssistantRecord(record, assistantRecords) || record;
      if (!isUsableAssistantAnswer(assistantRecord.text, thread)) {
        continue;
      }
      return assistantRecord;
    }

    return null;
  }

  async function refreshAssistantMessage(threadId, messageIndex) {
    const thread = getThread(threadId);
    const message = thread && thread.messages && thread.messages[messageIndex];
    if (!thread || !message || message.role !== "assistant" || message.status === "generating") {
      return;
    }

    const promptToken = getPromptTokenForAssistantMessage(thread, messageIndex);
    if (!promptToken) {
      CGQASidebar.showToast("找不到对应的主页面回复。");
      return;
    }

    const record = findAssistantRecordAfterPromptToken(
      thread,
      getAssistantMessageRecords(null),
      promptToken,
      getAllTurnRecords(null)
    );
    if (!record || !record.text) {
      CGQASidebar.showToast("暂未获取到更新内容。");
      return;
    }

    const nextHtml = record.html || "";
    const unchanged = message.content === record.text && (message.html || "") === nextHtml;
    if (unchanged) {
      CGQASidebar.showToast("当前回复已是最新。");
      return;
    }

    message.content = record.text;
    message.html = nextHtml;
    message.contentFormat = nextHtml ? "html" : "text";
    message.status = "completed";
    thread.updatedAt = Date.now();
    await saveAndRenderThread(thread, { reason: "complete" });
    syncPageDecorations();
    CGQASidebar.showToast("已重新获取回复。");
  }

  function getPromptTokenForAssistantMessage(thread, messageIndex) {
    const assistantIndex = getAssistantMessageOrdinal(thread, messageIndex);
    const mainChatItems = getMainChatItems(thread);
    return mainChatItems[assistantIndex] && mainChatItems[assistantIndex].promptToken || "";
  }

  function getAssistantMessageOrdinal(thread, messageIndex) {
    return (thread.messages || []).slice(0, messageIndex + 1).filter((message) => {
      return message.role === "assistant";
    }).length - 1;
  }

  function findLastPromptUserRecordIndex(records, promptToken) {
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const record = records[index];
      if (record.role === "user" && record.text && record.text.includes(promptToken)) {
        return index;
      }
    }
    return -1;
  }

  function findMatchingAssistantRecord(targetRecord, assistantRecords) {
    const targetSignature = getAssistantRecordSignature(targetRecord);
    return assistantRecords.find((record) => {
      return getAssistantRecordSignature(record) === targetSignature;
    }) || assistantRecords.find((record) => {
      return record.turn === targetRecord.turn || record.messageId && record.messageId === targetRecord.messageId;
    }) || null;
  }

  function findAssistantRecordBySignature(signature, scanContext, options = {}) {
    const recordOptions = { ...options, signature };
    const local = scanContext ? getAssistantMessageRecords(scanContext, recordOptions).find((record) => {
      return getAssistantRecordSignature(record) === signature;
    }) : null;
    if (local) {
      return local;
    }
    return getAssistantMessageRecords(null, recordOptions).find((record) => {
      return getAssistantRecordSignature(record) === signature;
    });
  }

  function getAssistantMessageRecords(scanContext, options = {}) {
    if (!provider || typeof provider.getAssistantMessageRecords !== "function") {
      return [];
    }
    return provider.getAssistantMessageRecords(scanContext || null, options) || [];
  }

  function getAllTurnRecords(scanContext) {
    if (!provider || typeof provider.getAllTurnRecords !== "function") {
      return [];
    }
    return provider.getAllTurnRecords(scanContext || null) || [];
  }

  function getAssistantRecordSignature(record) {
    if (record.messageId) {
      return `message:${record.messageId}`;
    }
    if (record.turnId) {
      return `turn:${record.turnId}`;
    }
    return `index:${record.index}`;
  }

  function isUsableAssistantAnswer(text, thread) {
    const normalized = (text || "").trim();
    if (
      !normalized
      || normalized === "生成中..."
      || normalized === thread.quoteText
      || isTransientAssistantStatusText(normalized)
    ) {
      return false;
    }
    return true;
  }

  function isTransientAssistantStatusText(text) {
    const normalized = text.replace(/\s+/g, " ").trim();
    const compact = normalized.replace(/\s+/g, "").toLowerCase();
    if (normalized.length > 80) {
      return false;
    }

    return /^正在思考[.。…]*$/.test(compact)
      || /^思考中[.。…]*$/.test(compact)
      || /^已思考\d*(秒|s)?$/.test(compact)
      || /^chatgpt(说|says)?[:：]?$/.test(compact)
      || /^thoughtfor(acoupleof)?\d*(second|seconds|s)?$/.test(compact)
      || /^thinking[.。…]*$/.test(compact)
      || /^reasoning[.。…]*$/.test(compact);
  }

  async function deleteActiveThread() {
    const threadId = state.activeThreadId;
    if (!threadId) {
      return;
    }

    removeThreadFromRuntime(threadId);
    if (state.pendingResponse && state.pendingResponse.threadId === threadId) {
      state.pendingResponse = null;
      stopPendingCaptureWatcher();
      unlockPendingScroll();
      clearPendingStableTimer();
      syncPanelDecorations();
    }
    await CGQAStorage.deleteThread(getConversationRef(), threadId);
    syncMainChatVisibility(getMainChatHideTargets());
    closeSidebar();
    scheduleRestoreBurst();
  }

  function scheduleRestoreBurst() {
    clearRestoreTimers();
    state.restoreTimers = RESTORE_DELAYS_MS.map((delay) => {
      return setTimeout(runRestorePass, delay);
    });
  }

  function runRestorePass() {
    if (!state.active || !provider || state.loadingConversation) {
      return;
    }

    state.restoring = true;
    restorePersistedMarks();
    if (state.activeThreadId) {
      provider.setActiveMark(state.activeThreadId);
    }
    syncPageDecorations();
    setTimeout(() => {
      state.restoring = false;
    }, 0);
  }

  function clearRestoreTimers() {
    state.restoreTimers.forEach((timer) => clearTimeout(timer));
    state.restoreTimers = [];
  }

  function clearLocationCheckTimers() {
    state.locationCheckTimers.forEach((timer) => clearTimeout(timer));
    state.locationCheckTimers = [];
  }

  function destroy() {
    clearLocationCheckTimers();
    clearRestoreTimers();
    if (state.active) {
      deactivateProvider();
    }
    state.cleanupTasks.splice(0).forEach((cleanup) => {
      try {
        cleanup();
      } catch (error) {
        if (!isExtensionContextInvalidated(error)) {
          console.warn("[CGQA] cleanup failed", error);
        }
      }
    });
  }

  globalThis[RUNTIME_KEY] = {
    version: CONTENT_VERSION,
    destroy,
    openThread,
    getThread
  };
  globalThis.CGQAApp = globalThis[RUNTIME_KEY];
  globalThis.CGQAContentVersion = CONTENT_VERSION;

  init().catch((error) => {
    console.error("[CGQA] init failed", error);
  });
})();
