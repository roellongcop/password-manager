// Clipboard clearing needs a DOM, and a service worker does not have one.
// This offscreen document exists only long enough to overwrite the clipboard.

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'clipboard:clear') return false;
  const scratch = document.getElementById('scratch');
  scratch.value = ' ';
  scratch.select();
  // execCommand still works here; navigator.clipboard needs document focus,
  // which an offscreen document never has.
  const ok = document.execCommand('copy');
  scratch.value = '';
  sendResponse({ ok });
  return false;
});
