// Shared helpers for the content scripts.
//
// Content scripts cannot be ES modules, but every content script of one extension
// shares a single isolated-world global, so the files below hang off one KEYRING
// namespace and are loaded in dependency order by the manifest.
//
// The message names here mirror src/lib/messages.js -- keep the two in step.

var KEYRING = (typeof KEYRING !== 'undefined' && KEYRING) || {};

(() => {
  KEYRING.MSG = {
    MATCHES: 'fill:matches',
    CREDENTIAL: 'fill:credential',
    TRIGGER: 'fill:trigger',
    APPLY: 'fill:apply',
    GENERATE: 'fill:generate',
    CAPTURE_OFFER: 'capture:offer',
    CAPTURE_PROMPT: 'capture:prompt',
    CAPTURE_SAVE: 'capture:save',
    CAPTURE_NEVER: 'capture:never',
    CAPTURE_DISCARD: 'capture:discard',
    OPEN_POPUP: 'ui:openPopup',
    GEN_PASSWORD: 'gen:password',
    SELECT_REGION: 'qr:selectRegion',
    TOAST: 'ui:toast',
  };

  // The service worker may be asleep or the extension may have been reloaded from
  // under us; neither should throw into the page.
  KEYRING.send = async (type, payload = {}) => {
    try {
      const response = await chrome.runtime.sendMessage({ type, ...payload });
      if (response && response.error) {
        const error = new Error(response.error);
        error.code = response.code || '';
        throw error;
      }
      return response;
    } catch (error) {
      if (String(error.message || '').includes('Extension context invalidated')) return null;
      throw error;
    }
  };

  KEYRING.debounce = (fn, wait) => {
    let timer = 0;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
  };

  KEYRING.isVisible = (element) => {
    if (!element || !element.isConnected) return false;
    if (element.disabled || element.readOnly) return false;
    if (element.type === 'hidden') return false;
    const rect = element.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return false;
    const style = element.ownerDocument.defaultView.getComputedStyle(element);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    if (Number(style.opacity) === 0) return false;
    return true;
  };

  // Walks open shadow roots too, so component-based sites are not invisible to us.
  KEYRING.queryAll = (selector, root = document, depth = 0) => {
    const found = [];
    if (depth > 8) return found;
    try {
      found.push(...root.querySelectorAll(selector));
      for (const element of root.querySelectorAll('*')) {
        if (element.shadowRoot) {
          found.push(...KEYRING.queryAll(selector, element.shadowRoot, depth + 1));
        }
      }
    } catch {
      // Detached or cross-document roots.
    }
    return found;
  };

  // React and Vue track the value through the prototype setter, so writing
  // element.value directly leaves their state stale and the form submits empty.
  KEYRING.setValue = (element, value) => {
    const prototype = Object.getPrototypeOf(element);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    element.focus();
    if (descriptor && descriptor.set) {
      descriptor.set.call(element, value);
    } else {
      element.value = value;
    }
    for (const name of ['keydown', 'keypress', 'keyup']) {
      element.dispatchEvent(new KeyboardEvent(name, { bubbles: true, key: 'a' }));
    }
    element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  };

  KEYRING.flash = (element) => {
    const previous = element.style.boxShadow;
    element.style.boxShadow = '0 0 0 2px rgba(47,111,79,0.9)';
    setTimeout(() => {
      element.style.boxShadow = previous;
    }, 700);
  };

  // Everything on a field that might name it. Frameworks scatter the useful word
  // across data-* attributes as often as they put it in name or id, so those are
  // swept up too -- skipping the machine-generated ones (long values, hex ids)
  // that would only add noise.
  KEYRING.attributeText = (element) => {
    const parts = [
      element.getAttribute('name'),
      element.getAttribute('id'),
      element.getAttribute('autocomplete'),
      element.getAttribute('placeholder'),
      element.getAttribute('aria-label'),
      element.getAttribute('title'),
      element.labels && element.labels.length ? element.labels[0].textContent : '',
    ];

    for (const attribute of element.attributes || []) {
      if (!attribute.name.startsWith('data-')) continue;
      parts.push(attribute.name.slice(5));
      const value = attribute.value || '';
      if (value.length <= 24 && !/^[0-9a-f]{8,}$/i.test(value)) parts.push(value);
    }

    return parts.filter(Boolean).join(' ').toLowerCase();
  };

  KEYRING.isTopFrame = window.top === window;
})();
