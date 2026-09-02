// Message names shared by the popup, options page and service worker.
// The content scripts are classic (non-module) scripts and repeat these string
// literals in src/content/util.js -- keep the two lists in step.

export const MSG = Object.freeze({
  STATUS: 'vault:status',
  CREATE: 'vault:create',
  UNLOCK: 'vault:unlock',
  LOCK: 'vault:lock',
  GET: 'vault:get',
  ITEM_SAVE: 'vault:itemSave',
  ITEM_DELETE: 'vault:itemDelete',
  ITEMS_ADD: 'vault:itemsAdd',
  CHANGE_PASSWORD: 'vault:changePassword',
  EXPORT: 'vault:export',
  IMPORT_BLOB: 'vault:importBlob',
  WIPE: 'vault:wipe',
  TOUCH: 'vault:touch',
  USED: 'vault:used',

  MATCHES: 'fill:matches',
  CREDENTIAL: 'fill:credential',
  FILL_FROM_POPUP: 'fill:fromPopup',
  TRIGGER: 'fill:trigger',

  TOTP_CODE: 'totp:code',
  SCAN_TAB: 'qr:scanTab',

  CAPTURE_OFFER: 'capture:offer',
  CAPTURE_PROMPT: 'capture:prompt',
  CAPTURE_SAVE: 'capture:save',
  CAPTURE_NEVER: 'capture:never',
  CAPTURE_PENDING: 'capture:pending',
  CAPTURE_DISCARD: 'capture:discard',

  SYNC_STATUS: 'sync:status',
  SYNC_CONFIGURE: 'sync:configure',
  SYNC_SIGNIN: 'sync:signIn',
  SYNC_SIGNUP: 'sync:signUp',
  SYNC_SIGNOUT: 'sync:signOut',
  SYNC_NOW: 'sync:now',
  SYNC_ADOPT: 'sync:adopt',

  OPEN_POPUP: 'ui:openPopup',
  SETTINGS_SET: 'settings:set',
});

// Small helper so every caller handles a dead service worker the same way.
export async function send(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (response && response.error) throw new Error(response.error);
  return response;
}
