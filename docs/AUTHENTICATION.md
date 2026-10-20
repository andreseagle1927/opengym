# OpenGym authentication setup

This deployment uses the OpenGym API at `https://gym.adrenocromo.com` for web and native clients. Each sign-in method creates or returns an OpenGym profile; Google and Apple identities are stored by their provider subject. The API does not merge accounts just because two providers report the same email address.

## What is already enabled

- Open account registration (`INVITE_ONLY=0`).
- Email and password accounts (12–128 characters); addresses are not verified and no email is sent.
- Web passkeys for browsers that expose WebAuthn.
- Native passkeys in the Kotlin and Swift starters, once the app/domain association is configured.
- Google and Apple provider flows in the clients and API, hidden until the required public client IDs are configured.
- One-time administrator-issued password reset codes; there is no self-service email reset.

The Capacitor Android build can use email/password and the native provider plugin. Its WebView may not expose WebAuthn; use the Kotlin app for native Android passkeys. The Swift starter has native iOS passkey support, but requires Xcode/macOS to build and configure.

## Google Sign-In

In Google Cloud Console, configure the OAuth consent screen/branding and create OAuth clients for the platforms you will use:

1. **Web application**: authorized JavaScript origin `https://gym.adrenocromo.com` and authorized redirect URI `https://gym.adrenocromo.com/`. The Capacitor Social Login web flow uses that root callback and processes the provider response when the app reloads.
2. **Android**: create an Android OAuth client for package `com.adrenocromo.gym` and register the SHA-1 signing certificate for each build you distribute. Get the local debug fingerprint with `cd frontend/android && ./gradlew signingReport`; add the release certificate fingerprint when you create a signed release. Credential Manager still uses the **web** client ID as its ID-token server audience; the Android client ID stays configured in Google Cloud and is not passed as `webClientId`.
3. **iOS**: bundle ID `com.adrenocromo.gym` (or the final host app bundle ID). The Xcode target must use that same ID or the provider configuration must be changed to match it.

Copy the resulting client IDs into the API environment. These are public identifiers, not secrets:

```dotenv
GOOGLE_WEB_CLIENT_ID=<web-client-id>
GOOGLE_IOS_CLIENT_ID=<ios-client-id>
GOOGLE_CLIENT_IDS=<web-client-id>
```

`GOOGLE_CLIENT_IDS` is the API's ID-token audience allowlist. The native Android and iOS flows request the web client ID as their server audience, so that is the ID the API must allow. The iOS OAuth client identifies the iOS app to Google and is configured separately. The web and Android sign-in buttons can be enabled before the iOS OAuth client is configured.

## Apple Sign-In

In Apple Developer, register the App ID `com.adrenocromo.gym` and enable Sign in with Apple. For web and Android, also create a **Services ID**, for example `com.adrenocromo.gym.web`, associate it with the App ID, and configure:

- Domain: `gym.adrenocromo.com`
- Return URL: `https://gym.adrenocromo.com/api/auth/apple/callback`

Set these API environment values:

```dotenv
APPLE_WEB_CLIENT_ID=com.adrenocromo.gym.web
APPLE_IOS_CLIENT_ID=com.adrenocromo.gym
APPLE_REDIRECT_URL=https://gym.adrenocromo.com/api/auth/apple/callback
APPLE_CLIENT_IDS=com.adrenocromo.gym,com.adrenocromo.gym.web
```

Use the actual Services ID you registered in place of the example. The bundle ID is the native iOS audience; the Services ID is the web/Android audience. This implementation validates Apple's signed ID token using Apple's published signing keys and does not need an Apple private key or client secret.

## Apply provider IDs on Hetzner

1. SSH to the server and edit `/home/andres/opengym/.env`.
2. Set the Google and/or Apple values above. Do not put private signing keys, service account keys, or passwords in the repository or client apps.
3. Recreate only the API container from the deployment directory so it reads the new environment: `docker compose up -d --force-recreate api`.
4. Check `https://gym.adrenocromo.com/api/config`. Web/Android use `google_enabled` and `apple_enabled`; iOS uses `google_ios_enabled` and `apple_native_enabled`. Each enabled flag requires its audience to be included in the matching `*_CLIENT_IDS` allowlist.
5. Complete an account creation and sign-in in the web app and each native client you intend to ship. Keep at least one existing sign-in method on the profile before unlinking any other method.

Provider setup remains disabled until those real client IDs are set. Never paste Apple or Google secrets into the chat, a source file, or a public repository.

## Make the first account an administrator

The server intentionally starts with no administrator. Create your own profile at `https://gym.adrenocromo.com` first, then on Hetzner read that profile's `id` from `/home/andres/opengym/data/db.json` under `users`. Add the ID to `ADMIN_UIDS` in `/home/andres/opengym/.env`, then run `docker compose up -d --force-recreate api` from `/home/andres/opengym`. After signing out and back in, the Admin page should be available in Settings.

Use the Admin page to issue one-time password reset codes. Each code expires after 15 minutes and can be used once. Since OpenGym does not send email, deliver the code to the affected user through a trusted channel.

## App/domain association for passkeys

- **Web**: HTTPS and `RP_ID=gym.adrenocromo.com` are already configured for this deployment.
- **Android**: `https://gym.adrenocromo.com/.well-known/assetlinks.json` now associates the site with `com.adrenocromo.gym` signed by the Kotlin starter's current debug certificate. The Kotlin manifest also references the association file. Before distributing a release, add that release's signing certificate SHA-256 fingerprint; Play Store builds use the Play App Signing certificate. Google Password Manager credential sharing in production should be configured through Play Console and use a Play-published build.
- **iOS**: enable Associated Domains and add `webcredentials:gym.adrenocromo.com`; serve an Apple App Site Association file listing the Apple Team ID and app bundle ID.

## References

- [Google Identity Services: get a client ID](https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid)
- [Google Identity Services: integration considerations](https://developers.google.com/identity/gsi/web/guides/integrate)
- [Apple: configure Sign in with Apple for the web](https://developer.apple.com/help/account/capabilities/configure-sign-in-with-apple-for-the-web/)
- [WebAuthn domain association (Android Digital Asset Links)](https://developers.google.com/identity/passkeys/developer-guides/server-registration)
- [Android Credential Manager app/site association](https://developers.google.com/identity/fido/android/native-apps)
