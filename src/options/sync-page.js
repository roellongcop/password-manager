// The Sync page. Everything here talks to the service worker; this file never
// touches the vault or the master password itself.

import { MSG, send, el, flashMessage, flashAfterReload, formatDate, relativeDate } from '../ui/common.js';
import { parseFirebaseConfig } from '../lib/sync.js';

const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /vaults/{uid} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
  }
}`;

export function renderSync(pane, { notice }) {
  const body = el('div');
  pane.append(body);

  const refresh = async () => {
    let status;
    try {
      status = await send(MSG.SYNC_STATUS);
    } catch (error) {
      body.textContent = '';
      body.append(el('p', { class: 'notice error', text: error.message }));
      return;
    }
    body.textContent = '';
    // Sections that do not apply return null, and append() would render that as
    // the word "null" rather than skipping it.
    body.append(
      ...[
        intro(),
        statusSection(status, notice, refresh),
        projectSection(status, notice, refresh),
        accountSection(status, notice, refresh),
        adoptSection(status, notice, refresh),
        helpSection(),
      ].filter(Boolean),
    );
  };

  refresh();
  return refresh;
}

function intro() {
  return el('div', { class: 'section' }, [
    el('h2', { text: 'Sync' }),
    el('p', {
      text: 'Keep the vault in a Firebase project you own, so a second computer gets the same items. Only the encrypted file is uploaded — the master password never leaves this machine and the server cannot read a single field.',
    }),
    el('ul', { class: 'small muted', style: 'margin-top:8px' }, [
      el('li', { text: 'Both computers use one master password, because the file is sealed with it. On the second computer, open the vault once with "Open the synced vault" below.' }),
      el('li', { text: 'The copy on the server wins. If this computer has edits that never uploaded and the other one has published since, those edits are replaced.' }),
      el('li', { text: 'Sync only runs while the vault is unlocked.' }),
      el('li', { text: 'Turning sync off leaves the vault on this computer exactly as it is.' }),
    ]),
  ]);
}

// -------------------------------------------------------------------- status

function statusSection(status, notice, refresh) {
  const rows = [];
  if (status.signedIn) {
    rows.push(
      infoRow('Last synced', status.lastSyncedAt ? `${relativeDate(status.lastSyncedAt)} (${formatDate(status.lastSyncedAt)})` : 'never'),
      infoRow('Version on the server', status.revision ? `#${status.revision}` : 'nothing uploaded yet'),
      infoRow('Unsent changes', status.dirty ? 'yes' : 'no'),
      infoRow('This device', status.deviceName),
    );
  }

  const syncButton = el('button', {
    class: 'primary',
    text: 'Sync now',
    disabled: status.signedIn ? null : true,
    onclick: async () => {
      syncButton.disabled = true;
      syncButton.textContent = 'Syncing...';
      try {
        const result = await send(MSG.SYNC_NOW);
        const said = {
          push: 'Vault uploaded.',
          pull: 'Vault downloaded from the server.',
          none: 'Already up to date.',
        };
        flashMessage(notice, said[result.action] || 'Sync finished.', 'ok');
      } catch (error) {
        flashMessage(notice, error.message, 'error', 0);
      }
      await refresh();
    },
  });

  return el('div', { class: 'section' }, [
    el('h2', { text: 'Status' }),
    el('p', {
      class: status.signedIn ? 'small muted' : 'small',
      text: status.signedIn
        ? `Signed in as ${status.email}. Syncing happens when you press Sync now.`
        : status.configured
          ? 'Not signed in yet. Sync is off.'
          : 'Not set up yet. Sync is off.',
    }),
    ...rows,
    status.lastError
      ? el('p', { class: 'notice error', style: 'margin-top:10px', text: status.lastError })
      : null,
    el('div', { class: 'row', style: 'margin-top:12px' }, [syncButton]),
  ]);
}

function infoRow(label, value) {
  return el('div', { class: 'history-row' }, [
    el('span', { class: 'muted', text: label }),
    el('span', { text: value }),
  ]);
}

// ------------------------------------------------------------------- project

function projectSection(status, notice, refresh) {
  const config = status.config || {};
  const apiKey = el('input', { type: 'text', value: config.apiKey || '', placeholder: 'AIzaSy...', autocomplete: 'off', spellcheck: 'false' });
  const projectId = el('input', { type: 'text', value: config.projectId || '', placeholder: 'my-vault-1a2b3', autocomplete: 'off', spellcheck: 'false' });
  const device = el('input', { type: 'text', value: config.deviceName || status.deviceName || '', autocomplete: 'off' });

  // The console hands over a whole config snippet, so take it whole rather than
  // making someone pick two values out of it on every computer they set up.
  const paste = el('textarea', {
    class: 'mono',
    rows: '4',
    placeholder: 'const firebaseConfig = {\n  apiKey: "AIzaSy...",\n  projectId: "my-vault-1a2b3",\n  ...\n};',
    oninput: () => {
      const found = parseFirebaseConfig(paste.value);
      if (!found.apiKey && !found.projectId) return;
      if (found.apiKey) apiKey.value = found.apiKey;
      if (found.projectId) projectId.value = found.projectId;
      paste.value = '';
      flashMessage(notice, 'Read the API key and project ID out of that. Now save them.', 'ok');
    },
  });

  return el('div', { class: 'section' }, [
    el('h2', { text: 'Firebase project' }),
    el('p', { text: 'Paste the config snippet and the two fields below fill themselves.' }),
    el('div', { class: 'field' }, [el('label', { text: 'Paste the Firebase config' }), paste]),
    el('div', { class: 'field' }, [el('label', { text: 'Web API key' }), apiKey]),
    el('div', { class: 'field' }, [el('label', { text: 'Project ID' }), projectId]),

    el('div', { class: 'field' }, [
      el('label', { text: 'Name for this computer' }),
      device,
      el('span', { class: 'small muted', text: 'Anything you like. It is recorded with each upload, so the other computer can see where the vault came from.' }),
    ]),

    el('button', {
      class: 'primary',
      text: 'Save project details',
      onclick: async () => {
        try {
          await send(MSG.SYNC_CONFIGURE, {
            config: { apiKey: apiKey.value, projectId: projectId.value, deviceName: device.value },
          });
          flashMessage(notice, 'Project details saved.', 'ok');
        } catch (error) {
          flashMessage(notice, error.message, 'error', 0);
        }
        await refresh();
      },
    }),
  ]);
}

// ------------------------------------------------------------------- account

function accountSection(status, notice, refresh) {
  if (status.signedIn) {
    return el('div', { class: 'section' }, [
      el('h2', { text: 'Sync account' }),
      el('p', { text: `Signed in as ${status.email}.` }),
      el('button', {
        text: 'Turn sync off on this computer',
        onclick: async () => {
          await send(MSG.SYNC_SIGNOUT);
          flashMessage(notice, 'Sync is off. The vault on this computer is untouched.', 'ok');
          await refresh();
        },
      }),
    ]);
  }

  const email = el('input', { type: 'email', autocomplete: 'off', placeholder: 'you@example.com' });
  const password = el('input', { type: 'password', autocomplete: 'off' });

  const submit = async (type) => {
    if (!email.value || !password.value) {
      return flashMessage(notice, 'Enter the sync email and password.', 'error');
    }
    try {
      await send(type, { email: email.value.trim(), password: password.value });
      password.value = '';
      flashMessage(notice, 'Signed in. Syncing now.', 'ok');
      await send(MSG.SYNC_NOW).catch(() => {});
    } catch (error) {
      flashMessage(notice, error.message, 'error', 0);
    }
    await refresh();
  };

  return el('div', { class: 'section' }, [
    el('h2', { text: 'Sync account' }),
    el('p', {
      text: 'A Firebase email and password you make up here, used only to reach your own copy of the encrypted file. Create it once, then sign in with the same two on every other computer.',
    }),
    el('p', {
      class: 'notice warn',
      text: 'Do not reuse the master password here. This one is stored by Google, under Authentication → Users in the Firebase console, and is checked there every time you sign in. The master password must never be.',
    }),
    el('div', { class: 'field' }, [el('label', { text: 'Email' }), email]),
    el('div', { class: 'field' }, [el('label', { text: 'Password' }), password]),
    el('div', { class: 'row' }, [
      el('button', {
        class: 'primary',
        text: 'Sign in',
        disabled: status.configured ? null : true,
        onclick: () => submit(MSG.SYNC_SIGNIN),
      }),
      el('button', {
        text: 'Create the account',
        disabled: status.configured ? null : true,
        onclick: () => submit(MSG.SYNC_SIGNUP),
      }),
    ]),
    status.configured
      ? null
      : el('p', { class: 'small muted', style: 'margin-top:10px', text: 'Save the project details first.' }),
  ]);
}

// --------------------------------------------------------------------- adopt

// Setting a second computer up. Its vault has a different salt, so the key in
// memory cannot open the file from the first one even under the same master
// password. This asks for that password once; afterwards both computers hold the
// same file and ordinary syncing takes over.
function adoptSection(status, notice, refresh) {
  if (!status.signedIn) return null;
  const password = el('input', { type: 'password', autocomplete: 'off' });

  return el('div', { class: 'section' }, [
    el('details', {}, [
      el('summary', { text: 'Open the synced vault on this computer' }),
      el('p', {
        class: 'small',
        style: 'margin-top:10px',
        text: 'Replaces everything on this computer with the copy from the server. Use it when setting up a new computer, or if Keyring says the file was sealed elsewhere.',
      }),
      el('div', { class: 'field' }, [
        el('label', { text: 'Master password of the synced vault' }),
        password,
      ]),
      el('button', {
        text: 'Download and open it',
        onclick: async () => {
          if (!password.value) return flashMessage(notice, 'Enter the master password.', 'error');
          try {
            await send(MSG.SYNC_ADOPT, { password: password.value });
            password.value = '';
            flashAfterReload('This computer now holds the synced vault.');
            location.reload();
          } catch (error) {
            flashMessage(notice, error.message, 'error', 0);
            await refresh();
          }
        },
      }),
    ]),
  ]);
}

// ---------------------------------------------------------------------- help

function helpSection() {
  const rules = el('textarea', { class: 'mono', rows: '9', value: RULES, readonly: true, style: 'margin-top:8px' });

  return el('div', { class: 'section' }, [
    el('details', {}, [
      el('summary', { text: 'Setting up the Firebase project' }),
      el('ol', { class: 'small', style: 'margin-top:10px' }, [
        el('li', { text: 'At console.firebase.google.com, create a project. The free Spark plan is enough — a vault is one small document.' }),
        el('li', { text: 'Build → Authentication → Get started → Email/Password → enable it.' }),
        el('li', { text: 'Build → Firestore Database → Create database → start in production mode.' }),
        el('li', { text: 'Firestore → Rules → replace them with the rules below → Publish. These are what stop anyone else reading your file.' }),
        el('li', { text: 'Project settings (the gear) → General → Your apps → add a Web app. Paste the whole config snippet it shows into "Paste the Firebase config" above; the API key and project ID are read out of it. The API key is the apiKey line and the project ID is the lowercase name in the console URL, if you would rather type them.' }),
        el('li', { text: 'Paste those two above, save, then create the sync account.' }),
      ]),
      rules,
      el('p', {
        class: 'small muted',
        text: 'The API key is not a secret — it only identifies the project. The rules above are the access control: without them anyone could read the file, though it would still be encrypted.',
      }),
      el('p', {
        class: 'small muted',
        text: 'On the second computer: install Keyring, set the same master password, enter the same project details, sign in with the same sync account, then Sync now.',
      }),
    ]),
  ]);
}
