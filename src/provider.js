(function () {
  "use strict";

  function resolveProvider() {
    const providers = Array.isArray(globalThis.CGQAProviders) ? globalThis.CGQAProviders : [];
    return providers.find((provider) => {
      return provider && typeof provider.matchesLocation === "function" && provider.matchesLocation(location);
    }) || null;
  }

  const provider = resolveProvider();
  if (!provider) {
    delete globalThis.CGQAProvider;
    return;
  }

  globalThis.CGQAProvider = provider;
})();
