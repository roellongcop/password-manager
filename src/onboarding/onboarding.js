import { MSG, send, qs, flashMessage } from '../ui/common.js';
import { passwordStrength } from '../lib/vault.js';
import { generatePassphrase } from '../lib/generator.js';

const password = qs('#password');
const confirm = qs('#confirm');
const ack = qs('#ack');
const create = qs('#create');
const meter = qs('#meter');
const strength = qs('#strength');
const notice = qs('#notice');

const MIN_LENGTH = 10;

function refresh() {
  const value = password.value;
  const result = passwordStrength(value);
  meter.dataset.score = String(result.score);
  meter.firstElementChild.style.width = `${Math.min(100, (result.bits / 110) * 100)}%`;

  if (!value) {
    strength.textContent = 'Use a long passphrase you can remember without writing down.';
  } else if (value.length < MIN_LENGTH) {
    strength.textContent = `${result.label} — at least ${MIN_LENGTH} characters, please.`;
  } else {
    strength.textContent = `${result.label} — roughly ${result.bits} bits.`;
  }

  const matched = value.length >= MIN_LENGTH && value === confirm.value;
  create.disabled = !(matched && ack.checked);
}

for (const input of [password, confirm]) input.addEventListener('input', refresh);
ack.addEventListener('change', refresh);

qs('#suggest').addEventListener('click', () => {
  const suggestion = generatePassphrase({ words: 5, capitalize: true, includeNumber: false });
  password.value = suggestion;
  confirm.value = '';
  password.type = 'text';
  flashMessage(
    notice,
    'Write this one down somewhere safe until you have it memorised, then destroy the note.',
    'warn',
    0,
  );
  refresh();
  confirm.focus();
});

qs('#form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (create.disabled) return;
  create.disabled = true;
  create.textContent = 'Creating…';

  try {
    await send(MSG.CREATE, { password: password.value });
    password.value = '';
    confirm.value = '';
    location.href = '../options/options.html#welcome';
  } catch (error) {
    flashMessage(notice, error.message, 'error', 0);
    create.disabled = false;
    create.textContent = 'Create vault';
  }
});

// If a vault already exists, this page is the wrong place to be.
send(MSG.STATUS)
  .then((status) => {
    if (status.initialized) location.replace('../options/options.html');
  })
  .catch(() => {});

refresh();
