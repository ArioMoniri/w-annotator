# Releasing

A release is built by `.github/workflows/release.yml` when a `v*` tag is pushed. It builds macOS (universal), Windows x64 and Linux x64, attaches the installers, `latest.json` and the `w-relay` Linux binary to a **draft** GitHub release, and checks the macOS signature and notarisation on the runner.

## Secrets

Set these under *Settings → Secrets and variables → Actions*. Without the Apple secrets the macOS build is unsigned and the checks are skipped with a warning. Without the updater key there is no `latest.json`. Windows and Linux need no secrets.

| Secret | What it is |
| --- | --- |
| `APPLE_CERTIFICATE` | Developer ID Application certificate and its private key, as a base64 `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | The password chosen when exporting the `.p12` |
| `APPLE_SIGNING_IDENTITY` | The certificate name, e.g. `Developer ID Application: Jane Doe (AB12CD34EF)` |
| `APPLE_ID` | The Apple ID email used for notarisation |
| `APPLE_PASSWORD` | An app-specific password for that Apple ID (not the account password) |
| `APPLE_TEAM_ID` | The 10-character team id, e.g. `AB12CD34EF` |
| `TAURI_SIGNING_PRIVATE_KEY` | The updater private key (the contents of the key file) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | The password of that key (leave unset if it has none) |

If `APPLE_CERTIFICATE` is set, the other five Apple secrets must be set too, or the build stops.

### Getting the Apple values

You need a paid Apple Developer account, and the *Account Holder* role to create this kind of certificate.

1. **Certificate.** In Keychain Access on a Mac: *Certificate Assistant → Request a Certificate From a Certificate Authority*, save the request to disk. At <https://developer.apple.com/account/resources/certificates/add> choose **Developer ID Application**, upload the request, download the `.cer` and double-click it to add it to the *login* keychain.
2. **Export to `.p12`.** In Keychain Access, *login → My Certificates*, expand the "Developer ID Application: …" entry so the private key shows, select both, right-click → *Export 2 items…*, format *Personal Information Exchange (.p12)*, and set a password. That password is `APPLE_CERTIFICATE_PASSWORD`.
3. **Base64.** `base64 -i certificate.p12 | pbcopy` puts the value for `APPLE_CERTIFICATE` on the clipboard (on Linux: `base64 -w0 certificate.p12`). Delete the `.p12` afterwards.
4. **Signing identity.** `security find-identity -v -p codesigning` lists the identities. Use the whole quoted name, `Developer ID Application: Name (TEAMID)`, as `APPLE_SIGNING_IDENTITY`.
5. **Team id.** The code in brackets at the end of that name. It is also shown at <https://developer.apple.com/account> under *Membership details*.
6. **App-specific password.** At <https://account.apple.com> → *Sign-In and Security → App-Specific Passwords*, create one (it looks like `abcd-efgh-ijkl-mnop`). That is `APPLE_PASSWORD`. `APPLE_ID` is the email of the same account.

### Getting the updater key

Do this once and keep the key safe. If it is lost, installed copies can no longer be updated.

```
pnpm tauri signer generate -w ~/.tauri/w-annotator.key
```

- `TAURI_SIGNING_PRIVATE_KEY`: the contents of `~/.tauri/w-annotator.key`.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: the password you typed.
- Put the contents of `~/.tauri/w-annotator.key.pub` in `src-tauri/tauri.conf.json` at `plugins.updater.pubkey`, replacing `UPDATER_PUBKEY_PLACEHOLDER`, and commit it. The release stops if the placeholder is still there.

### Windows

The Windows installer is not code-signed. It works, but SmartScreen shows a warning on first run until the installer has built up reputation. Auto-update is unaffected, because updates are checked against the updater key.

## Cutting a release

The usual way is to run the workflow by hand with **Publish** ticked; the steps are in [`docs/COLLABORATING.md`](COLLABORATING.md#releases-and-auto-update). Pushing a tag, as below, does the same but leaves the release as a draft for you to publish.

1. Set the same version in three places: `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`. Run `cargo check` so `Cargo.lock` follows.
2. Commit and merge to `main`, with CI green.
3. Tag and push:
   ```
   git tag v0.2.0
   git push origin v0.2.0
   ```
   The tag must be `v` plus the version, or the workflow stops.
4. Wait for the *Release* workflow. Any warning annotation means something was skipped; read it before going on.
5. Open the draft under *Releases*, check the files, write the notes and press **Publish release**.

To try the workflow without a tag, run it by hand from the *Actions* tab. It builds the current branch into a draft named after the version in `tauri.conf.json`. Delete the draft afterwards.

A failed build job can be re-run on its own; it replaces its files in the draft. A published release is never rebuilt: bump the version instead.

## How the updater finds a release

The app asks for

```
https://github.com/ArioMoniri/w-annotator/releases/latest/download/latest.json
```

GitHub resolves `latest` to the newest release that is **published** and not marked as a pre-release. A draft is invisible to it, so nobody is offered an update until you press *Publish release*. `latest.json` holds the version, and for each platform a download link and a signature. The app updates when that version is higher than its own and the signature matches the public key built into it.

## Testing an update

1. Publish a release, say `v0.1.0`, and install it from the release page.
2. Release and publish `v0.1.1`.
3. Check what the app will see: `curl -sL https://github.com/ArioMoniri/w-annotator/releases/latest/download/latest.json` should show `"version": "0.1.1"` and an entry for `darwin-aarch64`, `darwin-x86_64`, `windows-x86_64` and `linux-x86_64`.
4. Open the installed `0.1.0`. It should offer the update, install it and restart as `0.1.1`.

On Linux only the AppImage updates itself; `.deb` and `.rpm` installs are updated by installing the new package. Not verified on macOS or Windows from this repository yet: the first signed release is the first real test.
