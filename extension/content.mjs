/* Classic content script. MV3 content scripts are not modules, so the panel and its
   modules are loaded with a dynamic import of web-accessible extension URLs. No remote code. */
(async () => {
  if (window.__jevChatLoaded) return;
  window.__jevChatLoaded = true;
  try {
    const panel = await import(chrome.runtime.getURL('panel.mjs'));
    panel.start();
  } catch (error) {
    console.warn('Jev Chat for Twitch could not start:', error?.message ?? error);
  }
})();
