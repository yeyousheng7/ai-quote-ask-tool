(function () {
  "use strict";

  const PROVIDER_ID = "chatgpt";
  const PROVIDER_LABEL = "ChatGPT";

  function matchesLocation(locationObject = location) {
    return /(^|\.)chatgpt\.com$/i.test(locationObject.hostname)
      || /(^|\.)chat\.openai\.com$/i.test(locationObject.hostname);
  }

  function getConversationMeta() {
    const conversationId = CGQADom.getConversationId();
    const title = String(document.title || "").replace(/\s*[-|]\s*ChatGPT\s*$/i, "").trim();
    return {
      providerId: PROVIDER_ID,
      providerLabel: PROVIDER_LABEL,
      conversationId,
      title: title || getFallbackTitle(conversationId),
      url: location.href
    };
  }

  function getFallbackTitle(conversationId) {
    if (!conversationId || conversationId === "new-chat") {
      return "新会话";
    }
    return `会话 ${conversationId.slice(0, 8)}`;
  }

  function createChatGPTProvider() {
    if (!globalThis.CGQADom) {
      return null;
    }

    return {
      id: PROVIDER_ID,
      label: PROVIDER_LABEL,
      matchesLocation,
      getConversationId: CGQADom.getConversationId,
      getConversationMeta,
      validateSelection: CGQADom.validateSelection,
      getTurnId: CGQADom.getTurnId,
      getMessageId: CGQADom.getMessageId,
      renderThreadMark: CGQADom.renderThreadMark,
      renderDraftThreadMark: CGQADom.renderDraftThreadMark,
      clearRenderedMarks: CGQADom.clearRenderedMarks,
      removeThreadMark: CGQADom.removeThreadMark,
      promoteThreadMark: CGQADom.promoteThreadMark,
      setActiveMark: CGQADom.setActiveMark,
      updateMarkChip: CGQADom.updateMarkChip,
      getAllTurnRecords: CGQADom.getAllTurnRecords,
      getAssistantMessageRecords: CGQADom.getAssistantMessageRecords,
      syncHiddenMainTurns: CGQADom.syncHiddenMainTurns,
      setMainComposerHidden: CGQADom.setMainComposerHidden,
      setNativeGenerationControlsHidden: CGQADom.setNativeGenerationControlsHidden,
      submitPrompt: CGQADom.submitPrompt
    };
  }

  const provider = createChatGPTProvider();
  if (!provider) {
    return;
  }

  globalThis.CGQAProviders = Array.isArray(globalThis.CGQAProviders) ? globalThis.CGQAProviders : [];
  globalThis.CGQAProviders.push(provider);
})();
