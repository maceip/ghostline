# Releasing Zode

Every push to `main` cuts a release. `.github/workflows/release.yml` builds the three desktop /
mobile targets and attaches them to a GitHub Release.

| Platform | Artifact | Notes |
|---|---|---|
| macOS | `zode-macos-<version>-universal.dmg` | Signed; **notarised and stapled** once the Apple secrets are in place |
| Windows | `zode-windows-<version>-x64.msi` | Per-user install, no admin rights |
| Windows | `zode-windows-<version>-x64.zip` | Portable build |
| Android | `zode-android-<version>-debug.apk` | Debug build, install with "unknown sources" |

The version comes from the `VERSION` file at the repository root. The tag is
`v<version>-dev.<run number>`, so every push gets its own release and re-running a failed
workflow replaces the assets instead of failing.

---

## The macOS "moved to your Trash" problem

This is the part worth reading.

macOS puts the `com.apple.quarantine` attribute on every file it downloads. When Gatekeeper
meets a quarantined app whose signature it cannot validate, it does not merely refuse to open
it — on modern macOS it **deletes the app** and reports:

> "Zode was moved to your Trash."

There is no user setting that disables this, and right-clicking ▸ Open does not help either
once the app has been deleted. The only supported fix is the full Apple pipeline:

1. Sign the app with a **Developer ID Application** certificate.
   *An "Apple Development" certificate is not enough* — that one only runs on your own Mac.
2. Turn on the **hardened runtime** (`codesign --options runtime`). Apple rejects notarisation
   without it.
3. Add a **secure timestamp** (`codesign --timestamp`).
4. **Notarise** the app with `xcrun notarytool submit --wait` and wait for Apple's verdict.
5. **Staple** the ticket so it travels inside the file.
6. Do all of the above to the **`.dmg`** as well, and sign the `.dmg`. The disk image is what
   the user actually downloads, so the disk image is what Gatekeeper inspects.

With the ticket stapled, Gatekeeper validates it offline and the app opens normally — no
warning, no right-click, no Trash.

`shells/macos/build-dmg.sh` does exactly these six steps — and it does them for the app **and**
for the disk image, because the disk image is the thing the user downloads.

### The one-time setup

**Before anything else: a paid Apple Developer account.** Notarisation is a service Apple sells as
part of the *Apple Developer Program* (US$99 a year). A free Apple id is not enough, and there is
no way around this — the ticket can only come from Apple's servers, and only for a member. If the
account is not enrolled, everything below still works, but the disk image cannot be notarised.

**1. A Developer ID Application certificate.** On the Apple Developer portal
(<https://developer.apple.com/account/resources/certificates/list>) create a
**Developer ID Application** certificate and export it as a `.p12` with a password.

If you have Xcode, the certificate can also be created by Xcode and exported from Keychain
Access.

Base64 it:

```bash
base64 -i "Developer ID Application.p12" -o certificate.p12.b64
```

**2. An app-specific password.** At <https://appleid.apple.com> create an app-specific
password for notarisation. Apple id account settings → Security → "Generate an app-specific
password".

**3. Add the secrets to the repository.** Settings → Secrets and variables → Actions:

| Secret | What it is |
|---|---|
| `MACOS_CERTIFICATE` | The base64 `.p12` from step 1 |
| `MACOS_CERTIFICATE_PASSWORD` | The password of that `.p12` |
| `APPLE_ID` | Your Apple id (the email you sign in with) |
| `APPLE_APP_SPECIFIC_PASSWORD` | The app-specific password from step 2 |
| `APPLE_TEAM_ID` | Your team id (Xcode ▸ Settings ▸ Accounts, or the portal's membership page) |

That is the whole setup. The workflow imports the certificate, stores the notarisation
credentials as a `notarytool` keychain profile, and the release comes out notarised.

### If something in that goes wrong

**Nothing breaks.** A missing certificate, a wrong password, a failed submission — none of it
takes the release down. The disk image is still built and signed, the build script writes
`shells/macos/build/notarization.status`, the release notes say in plain words that the image is
not notarised, and the artifacts are still attached. Only the one step fails, and it says so.

To find out exactly where you stand, run the diagnostic on your Mac:

```bash
./scripts/check-notarization.sh                        # the last local build
./scripts/check-notarization.sh ~/Downloads/zode.dmg   # a downloaded copy
```

It checks the signing identity, the signature, the hardened runtime, the stapled ticket, the
quarantine attribute and what Gatekeeper would decide — and it changes nothing.

### Without the secrets

The workflow still runs and still produces a `.dmg` — it just cannot notarise, because
notarisation needs Apple's servers and a paid developer account. An un-notarised download will
be moved to the Trash.

The build script says so at the end, and prints the escape hatch for someone testing it on
their own machine:

```bash
# remove the quarantine attribute yourself
xattr -dr com.apple.quarantine /Volumes/Zode/Zode.app
```

Or right-click the app inside the disk image and choose **Open** — that works once, before
Gatekeeper has deleted it, on macOS 11 and later. (Building from source on the same Mac never
sets the quarantine attribute, so a locally built copy always opens.)

### Building it yourself

```bash
cd shells/macos
./build-dmg.sh                 # build, sign, notarise, staple
./build-dmg.sh --no-notarize   # build and sign, skip Apple
```

Environment:

| Variable | What it is |
|---|---|
| `ZODE_TEAM_ID` | Apple Developer team id |
| `ZODE_SIGN_IDENTITY` | Signing identity; defaults to the first Developer ID found |
| `ZODE_KEYCHAIN_PROFILE` | `notarytool` keychain profile (optional) |
| `ZODE_NOTARY_APPLE_ID` | Apple id, if you are not using a keychain profile |
| `ZODE_NOTARY_PASSWORD` | App-specific password |
| `ZODE_NOTARY_TEAM_ID` | Team id used for notarisation |
| `ZODE_APP_VERSION` | Version stamped into the bundle |

Check a built image the way Gatekeeper does:

```bash
spctl --assess --type open --context context:primary-signature -v shells/macos/build/Zode.dmg
```

---

## Before anything is published

Every release is opened and checked before it is attached:

| Check | What it proves |
|---|---|
| `scripts/check_artifacts.py` | The `.zip` has the launcher **and** the .NET runtime **and** the `web/` folder; the `.apk` has the manifest, the dex and the shared data; the `.dmg` has the app binary, the web app, the haptics and the icon |
| `Zode.Shell.exe --selftest` | The portable build in the `.zip` actually starts and finds its resources |
| `Zode.app/Contents/MacOS/Zode --selftest` | The app inside the `.dmg` actually starts and finds its resources |

The self test resolves its resources the same way the app does, so it
cannot pass by accident.

**A bare `.exe` is never published.** The publish is self-contained, so
`Zode.Shell.exe` is only the ~520 KB apphost launcher; it needs the ~100 MB
of runtime files and the `web/` folder beside it to start. It once shipped on
its own, downloaded fine, and then did nothing.

---

## Windows

```bash
pwsh ./shells/windows/build-msi.ps1                     # framework-dependent
pwsh ./shells/windows/build-msi.ps1 -SelfContained      # no .NET runtime needed
```

The installer is built with **WiX v5**, which harvests a whole directory with a single
`<Files>` element — no `heat.exe` and no XSLT. The script installs the tool if it is missing:

```bash
dotnet tool install --global wix
```

The `.msi` is a **per-user** install: no administrator rights, the app lands in the user's own
`AppData`, and a Start menu shortcut is created.

**The web app ships next to the executable**, not inside it. The shell maps it into the webview
with `SetVirtualHostNameToFolderMapping` and reads it from `AppContext.BaseDirectory\web`, so a
single-file publish would break the app. That is why there is a `.zip` as well as a `.msi`.

**There is no bare `.exe` asset, and there should not be one.** The publish is self-contained, so
`Zode.Shell.exe` is only the ~520 KB apphost launcher — it needs the ~100 MB of .NET runtime
files and the `web/` folder beside it to start at all. Shipping it on its own produced a file
that downloaded fine and then failed to run, which is worse than not shipping it. The `.zip` is
the portable build: unzip it, run `Zode.Shell.exe` from inside.

There is **no signing key** for the Windows build, by design. The unsigned installer works:
Windows SmartScreen may show a warning on first run, and "More info ▸ Run anyway" gets past it.

---

## Android

```bash
cd mobile/android
./gradlew :app:assembleDebug
```

The APK is a **debug** build, so it is signed with the standard Android debug key. Install it
with "install from unknown sources" enabled. A release build would need a real upload key —
that is a separate decision, and the `zune-code` project it comes from was never reachable
from this machine.

---

## The web app

There is nothing to build. It is plain ES modules with no dependencies and no bundler:

```bash
node apps/web/serve.mjs     # http://localhost:5173
```

CI checks that every asset the app references resolves, that no module imports a bare
specifier, and that the contract self-check passes.
