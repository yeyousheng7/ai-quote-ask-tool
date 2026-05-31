# AI Quote Annotation

Chrome/Edge Manifest V3 browser extension for quote-based follow-up questions on AI chat pages.

The extension lets you select a small piece of an assistant reply, create a local `提问` thread for that quote, and continue asking short follow-up questions in a floating panel without polluting the main conversation view.

## Supported Pages

- ChatGPT normal conversations: `https://chatgpt.com/c/*`
- ChatGPT GPT/project-style conversations: `https://chatgpt.com/g/*`
- Legacy ChatGPT host equivalents under `https://chat.openai.com/c/*` and `https://chat.openai.com/g/*`
- Gemini conversations: `https://gemini.google.com/app/*`
- DeepSeek conversations: `https://chat.deepseek.com/a/chat/s/*`

ChatGPT content scripts are allowed to load on the wider ChatGPT host so SPA navigation from the homepage into a supported route can be detected. The runtime only activates the plugin on supported conversation routes. Gemini is currently injected only under `/app/*`.
DeepSeek follows the same route-activation model and only activates inside saved conversation routes under `/a/chat/s/*`.

## Install For Development

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable developer mode.
3. Click `Load unpacked`.
4. Select this project directory.
5. Open a supported ChatGPT, Gemini, or DeepSeek conversation page.

Clicking the extension icon opens a small popup:

- `ChatGPT 提问助手`
- `打开提问管理`

The popup opens the standalone local management page. It does not toggle the in-page panel.
It also provides per-provider switches for ChatGPT, Gemini, and DeepSeek. A provider only activates on its supported pages when its switch is enabled. DeepSeek is marked as beta because its page DOM is less stable around formulas.
The popup also includes `整理当前页面`, which asks the active supported tab to retry quote mark restoration and hide/unload plugin-generated temporary main-chat messages. The question-mark icon next to it explains the command in-place.
Compatibility options can keep provider-native messages visible during sending, or keep them visible only while generating and hide them automatically a few seconds after the sidebar captures the completed reply.

## Core Features

- Select text inside a supported assistant reply and click `提问`.
- On ChatGPT, the plugin attaches its `提问` action next to ChatGPT's native selection toolbar when possible.
- On providers without a compatible native selection toolbar, the plugin shows a floating selection action near the selection.
- The selected text is highlighted and receives a `提问 N` chip when the DOM can safely support an inline chip.
- ChatGPT and Gemini code blocks/tables use a block reference bar before the block, such as `引用自下方代码块` or `引用自下方表格`, so copying block content is not affected.
- DeepSeek code blocks/tables use the same block reference bar strategy.
- Block reference bars show up to two `提问` chips and fold additional chips into `更多 N`.
- ChatGPT and Gemini formula surfaces still use a conservative clickable surface mark instead of inserting a chip into fragile DOM.
- DeepSeek formula surfaces are more fragile: complete formula selection can create a quote thread, but the page mark is intentionally not rendered and partial formula selection is rejected.
- Inline code is supported as normal selectable text.
- Closing a newly opened draft without sending removes the draft mark.
- Sending the first question promotes the draft mark into a persisted thread.
- Repeated questions on the same quote stay in the same local thread.
- Multiple quote threads can exist in the same conversation, including overlapping normal text marks.

## Floating Follow-up Panel

- The panel is draggable and stays as a floating overlay.
- Only one thread panel is shown at a time.
- The panel displays:
  - quote preview,
  - user questions,
  - assistant replies,
  - reply style control,
  - bottom follow-up input,
  - delete action.
- The native page composer is visually hidden while a panel is open, so the user naturally works through the panel.
- During a panel-sent response, a shared input blocker prevents accidental typing into the provider composer.
- A compatibility option can keep the provider-native generated message visible during generation and hide or unload it automatically after capture completes.
- Opening a follow-up panel locks the current page scroll position. Closing an unsent panel unlocks it; sent follow-ups keep the lock until response capture finishes.
- The panel input is fixed-size, auto-wraps text, and scrolls after its maximum height.
- Assistant messages render sanitized HTML when the provider's page DOM exposes Markdown-derived HTML.
- Each assistant message has a small icon-only refresh button with the title `重新获取回复`.

## Sending And Capturing Replies

- The extension does not call OpenAI, Google, or any model API directly.
- Follow-up questions are sent through the provider's normal web composer.
- The generated prompt includes the selected quote and the user's question as context.
- The generated prompt treats panel questions as isolated annotation side questions. It asks the provider to answer from the current quote and user question, only lightly using surrounding main text when necessary, and to ignore earlier quote-marked side questions.
- While the provider is generating, the sidebar mirrors the current assistant DOM response as a streaming runtime preview.
- Streaming fragments are not written to storage. Only the final stable reply is saved with its completed text/HTML.
- Plugin-generated main-chat prompts and model replies are hidden from the main page while the quote thread exists.
- The latest active thread reply is kept hidden, not unloaded, while the panel is open so the refresh button can re-read it from the page DOM.
- When the panel is closed after a reply has been captured, hidden main-chat DOM can be unloaded to reduce page cost.
- If a reply is still pending, the latest hidden DOM is kept until capture completes.
- The manual refresh button re-extracts the corresponding assistant reply from the provider page DOM and updates the saved sidebar message when newer or fuller content is available.
- The refresh button does not resend the question.
- The popup `整理当前页面` command is a manual recovery path for occasional provider/plugin timing conflicts where quote marks or hidden temporary messages are not restored correctly.

## Streaming Capture Notes

- Pending-response capture is local-scan-first with a full-page scan fallback. `src/content.js` creates and passes the runtime scan context, while provider DOM drivers decide the actual local DOM boundary.
- Provider selectors must stay inside `src/providers/*-dom.js`. Do not move ChatGPT, Gemini, or DeepSeek DOM selectors into `src/content.js`.
- After a pending assistant reply is identified, capture should prefer its stable assistant signature instead of repeatedly rediscovering the reply from the full turn list. This avoids cross-thread mixups and keeps streaming updates lightweight.
- The sidebar streaming path updates the current generating assistant message body directly. It should not repaint the whole panel for every stream update.
- During streaming, the sidebar follows the bottom only while the user is already near the bottom. If the user scrolls away, streaming content may keep growing without forcing `scrollTop` back to the bottom. Sending the next follow-up resets the default follow-bottom behavior.
- Final completion must wait for stable candidate content and, when the provider can report it, a finished provider generation state. Short text pauses during model generation are not enough to mark the reply completed.
- If streaming becomes chunky again, first check whether local scan is missing the new assistant node and falling back to full scans. Tune timing values only after the DOM boundary and assistant signature path are confirmed.
- Smooth streaming on one provider means the current DOM path works for the tested page shape; it is not a reason to generalize provider-specific selectors into shared code.

## Provider-specific Behavior

### ChatGPT

- Supports `/c/*` and `/g/*` conversation routes.
- Handles thinking-model replies where a single visible assistant turn can contain multiple assistant message nodes separated by one or more thought buttons.
- Text before and after a thought button can be selected as long as the selection stays inside one Markdown segment.
- Cross-thought selection is intentionally not supported.
- Assistant capture ignores transient status labels such as `正在思考`, `Thinking`, `Reasoning`, and `ChatGPT 说:`.
- The plugin hides ChatGPT thought controls that belong to plugin-generated hidden turns.
- The page scroll lock targets ChatGPT's internal `group/scroll-root` container rather than `window`.
- Pending-response local scan starts from ChatGPT's internal scroll root when available, then falls back to `main` or narrower ancestors. The broader root is intentional because new turns may not be siblings under the previous tail turn's direct parent.
- ChatGPT streaming prefers the last useful Markdown segment in an assistant turn, especially for thinking-model turns with multiple Markdown blocks. Final capture still re-reads the completed reply through the full sanitizer path.
- The ChatGPT local scan root must remain short-lived, tail-bounded, and tied to pending-response capture. Do not turn it into a permanent broad observer.

### Gemini

- Supports `https://gemini.google.com/app/*`.
- Uses Gemini-specific DOM selectors for turns, messages, composer, send button, and assistant extraction.
- Uses the shared pending input blocker and scroll lock.
- The page scroll lock targets Gemini's `infinite-scroller.chat-history` container.
- Gemini local pending scan is based on newly added conversation containers after the recorded tail container.
- Gemini pending cleanup only restores input state; it must not click a native stop button during normal completion.
- Manual reply refresh is available in the same panel UI as ChatGPT.

### DeepSeek

- Supports saved conversation routes under `https://chat.deepseek.com/a/chat/s/*`.
- Uses DeepSeek-specific DOM selectors for virtual-list turns, assistant markdown, user messages, composer, send button, stop button, and scroll container.
- The page scroll lock targets DeepSeek's `.ds-virtual-list--printable` scroll container.
- Code blocks and tables are referenced by a bar before the block, preserving native copy/download behavior.
- Complete formula selections are allowed as quote-only threads, but DeepSeek formula marks are not rendered. This avoids mutating KaTeX/math DOM that DeepSeek's frontend framework manages strictly.
- Partial formula selections are rejected.
- During a panel-sent pending response, DeepSeek thinking controls and thinking content are hidden while the sidebar captures the final answer.
- DeepSeek local pending scan is based on newly added virtual-list items. Because virtual-list DOM is less stable, fallback to full scan should stay conservative.
- DeepSeek completion cleanup must not click the native stop button. It should only clear prompt/input side effects that belong to the plugin.
- DeepSeek formula DOM is a known unstable area. If a page has already crashed after previous formula-marking experiments, refresh the conversation to restore a clean provider DOM before testing again.

## Reply Style And Theme

The panel stores global reply style settings in local extension storage:

- `默认`
- `长一点`
- `短一点`
- `自定义`

`自定义` uses inline editing in the bottom action area. The saved custom instruction is inserted into future panel-generated prompts.

The extension also stores a global theme key. Current themes:

- green
- pink
- blue
- gold
- slate

The active theme drives quote marks, chips, panel focus states, popup controls, and the management page.
Provider switches are stored in the same local settings object. ChatGPT and Gemini are enabled by default; DeepSeek is disabled by default because its formula DOM can crash when touched by extensions.

## Local Storage And Management Page

- Threads are stored in `chrome.storage.local`.
- Stored data is provider-aware and grouped by provider id plus conversation id.
- The management page reads structured storage data only; it does not scan provider page DOM.
- The management page supports:
  - viewing saved conversations,
  - viewing saved quote threads,
  - deleting a single thread,
  - deleting all saved threads for a conversation,
  - opening the original conversation URL.

Deleting a thread removes the corresponding local record and removes visible quote marks/chips from the current page when possible.

## Architecture

- `src/content.js` owns provider-neutral runtime state, route activation, quote thread lifecycle, prompt construction, persistence timing, pending-response capture, manual reply refresh, main-chat hiding, and scroll-lock orchestration.
- `src/provider.js` resolves the active provider from registered providers.
- `src/providers/chatgpt.js` registers ChatGPT provider metadata and exposes the ChatGPT DOM driver through the provider contract.
- `src/providers/chatgpt-dom.js` owns ChatGPT DOM queries, selection validation, segmented Markdown handling, quote anchoring, mark rendering/restoration, composer submission, assistant extraction, hidden main-turn handling, and ChatGPT scroll target lookup.
- `src/providers/gemini.js` registers Gemini provider metadata and exposes the Gemini DOM driver through the provider contract.
- `src/providers/gemini-dom.js` owns Gemini DOM queries, selection validation, quote anchoring, mark rendering/restoration, composer submission, assistant extraction, pending cleanup, and Gemini scroll target lookup.
- `src/providers/deepseek.js` registers DeepSeek provider metadata and exposes the DeepSeek DOM driver through the provider contract.
- `src/providers/deepseek-dom.js` owns DeepSeek DOM queries, selection validation, quote anchoring, conservative mark rendering/restoration, composer submission, assistant extraction, pending cleanup, and DeepSeek scroll target lookup.
- `src/sidebar.js` owns the floating panel, selection action UI, reply style controls, assistant refresh button UI, and panel interactions.
- `src/storage.js` owns persisted conversation/thread data and migration/reset policy.
- `src/sanitize.js` owns safe HTML rendering for saved assistant replies.
- `src/theme.js` and `src/theme.css` own shared theme definitions.
- `src/provider-input-blocker.js` owns the shared pending-response overlay for native composers.
- `src/scroll-lock.js` owns the provider-targeted scroll lock used during panel-sent responses.
- `popup.html` and `src/popup.js` own the extension action popup.
- `manager.html` and `src/manager.js` own the standalone management page.
- `AI_WEB_DOM_CAPTURE_PROMPTS.md` contains reusable prompt sequences for collecting provider DOM samples.
- `tools/scroll-container-probe.js` is a reusable DevTools snippet for identifying the active internal scroll container on a provider page.

Provider-specific DOM behavior should stay inside `src/providers/*-dom.js`. Shared business flow should stay provider-neutral in `src/content.js`.

## Known Boundaries

- The extension is designed for desktop Chrome/Edge Manifest V3.
- It does not sync data to the cloud.
- It does not call model APIs directly.
- Cross-thought selection in ChatGPT is intentionally not supported.
- Cross-message or cross-user/assistant selection is intentionally rejected.
- Formula marking is conservative to avoid corrupting provider-rendered DOM.
- DeepSeek formula marking is disabled entirely. Complete formulas can still be quoted and asked about, but no visible mark is rendered on the provider page.
- ChatGPT and Gemini code blocks/tables are referenced by a bar before the block rather than by inline text marks, so selecting exact code/table text is preserved in storage but the visible page marker is block-level.
- DeepSeek code blocks/tables follow the same block reference strategy; formula selections are stored without a page marker.
- Already-unloaded hidden main-chat DOM cannot be manually refreshed until the provider page re-renders it, for example after a page refresh.
- If a saved quote cannot be matched safely after provider DOM changes, the extension keeps the saved thread but does not force-render an unsafe mark.
