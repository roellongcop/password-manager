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
| See your 2FA codes | **Codes** tab in the popup |
| Generate a password | Generator tab, or right-click a password field |
| Manage everything | **Manage** in the popup, or the extension's options page |
| Lock immediately | **Lock** in the popup, or right-click → Lock Keyring |

The badge on the toolbar icon shows how many saved logins match the current site.

## Authenticator

Keyring is also a TOTP authenticator, so a separate 2FA extension is not needed.
Codes come in two shapes and both appear together under **Codes** in the popup,
ticking off one timer:

- A code attached to a login, filled alongside the password.
- A standalone entry (**Authenticator** in the sidebar, **Code** in the toolbar) for
  an account whose password lives somewhere else.

SHA-1/256/512, 6-8 digits and any period are supported; the defaults are what
almost every site uses. Paste an `otpauth://` link into the secret field and the
algorithm, digits, period, issuer and account are all read from it.

Three ways to add a code:

- **Scan QR on this page** in the popup Codes tab. The page dims and you drag a box
  around the QR code; click without dragging to search the whole visible page, or
  press Esc to cancel. Keyring crops its screenshot to that box, decodes it and
  saves the code, then confirms on the page itself. The screenshot is decoded
  inside the extension and never reaches the page.
- **A saved image**, or a screenshot pasted with Ctrl+V, in
  Manage -> Import & export.
- **By hand**, pasting the secret or the otpauth:// link.

QR decoding is written from scratch in [src/lib/qr.js](src/lib/qr.js) rather than
pulled from a library, so nothing third-party ships inside the vault. It handles
versions 1 to 10 at any rotation, which covers every authenticator QR; anything
larger is reported rather than guessed at.

To move codes over from another authenticator, use
**Manage → Import & export → Import authenticator codes** and paste either
`otpauth://` links one per line, or the JSON an authenticator extension exports.
Duplicate secrets are skipped. `otpauth-migration://` links (the Google
Authenticator export format) are not supported — export individual links instead.

Give a standalone entry a website and its code fills the one-time-code field there,
the same way a login does.

## Import and export

Keyring has its own CSV format. These are the columns, in the order the exporter
writes them:

```
type,name,folder,favorite,username,password,url,totp,notes,cardholder,number,expMonth,expYear,cvv
```

`type` is `login`, `note`, `card` or `totp`; leave it blank and Keyring works it out from
what the row contains. `favorite` is `true` or empty. Only the columns you actually
use need to be present. The `totp` column takes a bare base32 secret, or a whole
`otpauth://` link when the code uses a non-default algorithm, digit count or period.

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
src/lib/                 crypto, vault model, matcher, generator, TOTP, QR, CSV
src/background/          service worker (holds the key, answers every request)
src/content/             form detection, autofill, inline menu, save prompt, QR region picker
src/popup/               the toolbar popup
src/options/             full manager: items, settings, import/export, backups
src/onboarding/          first-run master password setup
tests/                   library test suite, QR fixtures, login-form fixtures
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
