# Keyring

A local-only password manager for Chrome, Edge and Brave. Encrypted vault, autofill,
save prompts, password generator, TOTP codes, secure notes and cards — no account,
no subscription, no third party involved.

There is no server, no sync and no telemetry. The extension makes **no network
requests at all**.

## Install

1. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and pick this folder.
4. The setup tab opens. Choose a master password.

Pin the toolbar icon so the popup is one click away.

## Everyday use

| Action | How |
| --- | --- |
| Open the vault | Click the icon, or `Ctrl+Shift+Space` |
| Fill the login on the current page | Click the icon inside the field, or `Ctrl+Shift+L` |
| Save a new login | Sign in as usual and answer the prompt |
| Generate a password | Generator tab, or right-click a password field |
| Manage everything | **Manage** in the popup, or the extension's options page |
| Lock immediately | **Lock** in the popup, or right-click → Lock Keyring |

The badge on the toolbar icon shows how many saved logins match the current site.

## Import and export

Keyring has its own CSV format. These are the columns, in the order the exporter
writes them:

```
type,name,folder,favorite,username,password,url,totp,notes,cardholder,number,expMonth,expYear,cvv
```

`type` is `login`, `note` or `card`; leave it blank and Keyring works it out from
what the row contains. `favorite` is `true` or empty. Only the columns you actually
use need to be present.

**Manage → Import & export → Download a blank template** gives you that header plus
one example of each item type, ready to fill in with a spreadsheet or a text editor
and import back.

Any other CSV imports too. If its headings are recognisable (title, login, secret,
web site, category and similar) they are matched automatically; anything else starts
as *Ignore* and you say what each column holds. Nothing is ever guessed from column
position — an unmapped column is simply not imported. A file with no header row at
all works once you untick **First row is a header** and map the columns by hand.

Importing merges into the vault. A row whose site and username already exist is
skipped rather than duplicated.

## Backups

**Manage → Import & export → Download encrypted backup** writes the same encrypted
blob the extension stores internally. It is useless without the master password, so
it is safe to keep in a sync folder or on a USB stick.

Restoring replaces the whole vault. There is also a plain-CSV export behind a
confirmation — it holds every password in readable text, so delete it as soon as
you are done with it.

**Test the backup before you trust the vault:** export, delete the vault
(Manage → Master password → Delete this vault), restore from the file, confirm
everything came back.

## How it is protected

- Master password → PBKDF2-SHA-256, 600,000 iterations, 16-byte random salt → a
  256-bit key.
- The whole vault is encrypted with AES-256-GCM under that key, with a fresh IV on
  every write. A wrong password fails as a GCM authentication error; there is no
  separate verifier hash to attack.
- The master password is never stored. The key lives in `chrome.storage.session`
  (memory only, never written to disk, unreachable from web pages) and disappears
  when the browser closes or the idle timer fires.
- Sites are matched on the registrable domain, so `evil-paypal.com` can never see a
  credential saved for `paypal.com`.
- A page never receives the vault. It receives one credential, for one item you
  picked, after the extension has confirmed that item is saved for that exact site.
- Nothing is filled automatically on page load — filling always takes a click or the
  keyboard shortcut.
- Filling on `http://` pages is refused unless you switch it on for that one item.

The one thing this design cannot survive is a forgotten master password. There is no
recovery, by design.

## Layout

```
manifest.json            MV3 manifest
src/lib/                 crypto, vault model, matcher, generator, TOTP, CSV
src/background/          service worker (holds the key, answers every request)
src/content/             form detection, autofill, inline menu, save prompt
src/popup/               the toolbar popup
src/options/             full manager: items, settings, import/export, backups
src/onboarding/          first-run master password setup
tests/                   library test suite and login-form fixtures
tools/make-icons.js      regenerates the PNG icons
tools/serve.js           static server for the test pages
tools/package.js         builds the Chrome Web Store upload
store/                   listing copy and privacy policy for publishing
```

No build step. Edit a file, hit **Reload** on the extensions page.

To publish: `node tools/package.js` writes `dist/keyring-<version>.zip`, and
[store/listing.md](store/listing.md) has every field the Chrome Web Store asks for.

## Tests

```bash
node tests/run.mjs
```

The same suite runs in a browser at `tests/test.html`, and `tests/forms.html` holds
login forms in the shapes the detector has to handle (plain, no `<form>`, decoy
fields, two-step, shadow DOM, late-rendered, one-time code, sign-up, iframe). Serve
them rather than opening from disk:

```bash
node tools/serve.js
```
