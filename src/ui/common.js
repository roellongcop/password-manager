// Helpers shared by the popup, options page and onboarding.

import { MSG, send } from '../lib/messages.js';

export { MSG, send };

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    // value has to be a property: setAttribute('value') does nothing to a textarea.
    else if (key === 'value') node.value = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (value !== null && value !== undefined && value !== false) {
      node.setAttribute(key, value === true ? '' : value);
    }
  }
  for (const child of [].concat(children)) {
    if (child) node.append(child);
  }
  return node;
}

export function qs(selector, root = document) {
  return root.querySelector(selector);
}

export function qsa(selector, root = document) {
  return [...root.querySelectorAll(selector)];
}

// Copy, then ask the service worker to wipe the clipboard shortly afterwards so a
// password does not sit there until the next copy.
export async function copyWithAutoClear(text, seconds = 30) {
  await navigator.clipboard.writeText(text);
  if (seconds > 0) {
    send('clipboard:scheduleClear', { seconds }).catch(() => {});
  }
}

export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
  else delete root.dataset.theme;
}

export function formatDate(value) {
  if (!value) return '--';
  try {
    return new Date(value).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  } catch {
    return value;
  }
}

export function relativeDate(value) {
  if (!value) return 'never';
  const elapsed = Date.now() - new Date(value).getTime();
  const day = 86_400_000;
  if (elapsed < 60_000) return 'just now';
  if (elapsed < 3_600_000) return `${Math.round(elapsed / 60_000)} min ago`;
  if (elapsed < day) return `${Math.round(elapsed / 3_600_000)} h ago`;
  if (elapsed < 30 * day) return `${Math.round(elapsed / day)} d ago`;
  return formatDate(value).split(',')[0];
}

export function domainIconLetter(item) {
  const source = item.name || (item.uris || [])[0]?.uri || item.username || '?';
  const letter = String(source).replace(/^https?:\/\//, '').trim()[0];
  return (letter || '?').toUpperCase();
}

// Deterministic tint per item so the list is scannable without favicons (which
// would mean network requests from a password manager -- not worth it).
export function tintFor(text) {
  let hash = 0;
  for (const character of String(text || '?')) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  const hue = hash % 360;
  return `hsl(${hue} 42% 42%)`;
}

export function download(filename, text, mime = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const anchor = el('a', { href: url, download: filename });
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('That file could not be read.'));
    reader.readAsText(file);
  });
}

export function flashMessage(node, message, kind = 'ok', ms = 3500) {
  if (!node) return;
  node.textContent = message;
  node.className = `notice ${kind}`;
  node.classList.remove('hidden');
  clearTimeout(node.__timer);
  if (ms) {
    node.__timer = setTimeout(() => node.classList.add('hidden'), ms);
  }
}
