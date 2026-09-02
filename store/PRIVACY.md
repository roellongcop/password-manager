# Keyring — Privacy Policy

_Last updated: 2 September 2026_

Keyring is a password manager that runs entirely inside your own browser. This
policy describes what it does with your data, which is: nothing beyond keeping it
on your computer.

## What Keyring stores

- The items you create: logins, secure notes and payment cards, along with their
  names, folders, websites and any notes or custom fields you add.
- Your settings: auto-lock timeout, clipboard behaviour, theme, and the list of
  sites you have told it to ignore.

All of it is held as a single blob encrypted with AES-256-GCM, using a key derived
from your master password with PBKDF2-SHA-256 (600,000 iterations, random salt).
The blob lives in your browser profile's local extension storage.

Your master password is never stored, in any form. While the vault is unlocked the
derived key is held in the browser's session storage, which exists only in memory,
is never written to disk, and is discarded when the browser closes or the idle
timer fires.

## What Keyring transmits

Nothing, unless you switch on Sync. Sync is off until you set it up, and with it off
the extension makes no network requests of any kind: no account, no server, no
analytics, no telemetry, no crash reporting and no remote code.

With Sync on, the extension uploads your vault to a Firebase project **you** create
and control, under a Firebase account you create. What is uploaded is the encrypted
blob described above, a revision number, and a name you give the computer. Nothing
is decrypted anywhere but on your own machines, and your master password is never
sent, in any form. The author of Keyring has no access to your Firebase project and
no way to reach anything in it. Google’s handling of the data you store in your own
Firebase project is covered by your agreement with Google.

The author of Keyring cannot see your vault, your settings, the sites you visit, or
the fact that you use the extension at all.

Files you export are written to your own downloads folder by your browser and are
not sent anywhere.

## Access to the pages you visit

Keyring needs permission to run on any website because it cannot know in advance
which sites you will save a login for. On a page it may run:

- **Login form detection.** It looks for password and username fields so it can
  offer to fill or save them. It does not read, collect or transmit any other part
  of the page.
- **Filling, on your instruction.** A credential is only ever sent to a page after
  you click it in the Keyring menu or press the fill shortcut, and only after the
  extension has confirmed that the item you picked is saved for that exact site.
  Nothing is filled automatically when a page loads.
- **Reading a QR code, only when you ask.** Choosing "Scan QR on this page" lets
  you draw a box around the code; Keyring then takes a picture of the visible tab,
  crops it to that box and keeps only the authenticator link it finds. The picture is processed inside the extension, is
  never stored, and is never sent anywhere. Nothing is captured unless you press
  that button.
- **Capturing a login you have just typed.** When you submit a login form, Keyring
  may offer to save or update it. Nothing is saved unless you accept the prompt,
  and you can turn the prompt off entirely, or disable it per site.

A web page never receives your vault, a list of your items, or any credential other
than the single one you chose for that site.

## Data sharing

Keyring shares no data with anyone. Nothing is sold, transferred, or used for
advertising, credit assessment, or any purpose other than running the extension for
you. If you switch on Sync, your encrypted vault is stored in infrastructure you
chose and control; it is not shared with the author of Keyring or anyone else.

## Deleting your data

Manage → Master password → **Delete this vault** erases everything from the browser
profile. If you used Sync, delete the document from your own Firebase console too;
Keyring cannot reach it once the extension is gone. Removing the extension from Chrome also removes its storage. Neither can
be undone, and neither the author nor anyone else holds a copy that could restore
it — there is no recovery for a forgotten master password, by design.

## Changes

Any change to this policy will be published alongside the extension's source. The
date at the top marks the current version.

## Contact

Questions about this policy can be sent to the address listed on the extension's
Chrome Web Store page.
