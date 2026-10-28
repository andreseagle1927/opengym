# OpenGym authentication setup

OpenGym uses its API at `https://gym.adrenocromo.com` for profiles, workout data, and sessions. Supabase Auth can manage email/password, Google, and Apple identities. The OpenGym API verifies Supabase access tokens, then maps each Supabase user ID to an OpenGym profile. Workout data stays in OpenGym on Hetzner. Accounts are never merged solely because providers report the same email address.

## Configure Supabase Auth

Set the OpenGym API environment:

```dotenv
SUPABASE_URL=https://db.example.com
SUPABASE_ANON_KEY=<publishable-or-anon-key>
```

Use the project's public publishable/anon key, never its service-role/secret key. The API checks sessions with Supabase Auth and does not need the JWT signing secret.

In Supabase Auth URL configuration:

- Set the site URL to the OpenGym web origin, or leave the shared project default and add OpenGym as an allowed redirect URL.
- Allow `https://gym.adrenocromo.com/**` for email confirmation, password recovery, and OAuth return navigation.
- Use the Supabase API hostname as the OAuth provider callback: `https://db.example.com/auth/v1/callback`.
- Enable email signup and configure SMTP. Keep email confirmation enabled for production.

The OpenGym deployment should use the Supabase API host (`db.example.com`) rather than the Studio hostname for `SUPABASE_URL`. Supabase has to be configured before its Google or Apple provider buttons appear.

## Google Sign-In

Create a Google OAuth client for the web and platform clients you plan to ship. In Google Cloud, configure the Supabase callback URL as an authorized redirect URI, and configure OpenGym's web origin as an authorized JavaScript origin. Add the web client ID and secret in Supabase Auth's Google provider settings. Native Android/iOS clients also need their package/bundle identifiers and signing configuration. For native ID-token exchange, set the public client IDs in the OpenGym API environment as documented in `.env.example`.

## Apple Sign-In

Apple Sign-In needs an Apple Developer account. Create and configure the App ID and Services ID, then add the Services ID, Team ID, Key ID, and private key to Supabase Auth's Apple provider settings. Register the Supabase callback URL with Apple. Native iOS also needs the Sign in with Apple capability and the correct bundle ID. Keep Apple private keys in the Supabase server configuration only.

Provider credentials are not included in this repository. If they are not configured, the corresponding provider is not offered by OpenGym.

## Existing authentication methods

Web email registration uses Supabase email confirmation. Users can request a password reset link from the sign-in screen. Google/Apple web login uses Supabase OAuth; native clients can exchange provider ID tokens with Supabase. Linking adds the Supabase identity to the currently signed-in OpenGym profile and refuses an identity already linked elsewhere.

OpenGym passkeys and its legacy password/provider API endpoints remain available for existing clients. The Kotlin and Swift starter repositories are separate clients and are not automatically upgraded by configuring Supabase. Keep one working sign-in method on each profile before removing another.

## Make the first account an administrator

To use a dedicated email account, set its verified email in `ADMIN_EMAILS` in `/home/andres/opengym/.env`. The account receives admin access after it registers and confirms that email. Alternatively, add an existing profile ID to `ADMIN_UIDS`. After changing either value, recreate only the API container so it reads the updated environment. The Admin page can issue one-time reset codes for legacy OpenGym password accounts; Supabase-managed accounts use Supabase's email reset flow.

## Passkey app/domain association

- Web passkeys use HTTPS and `RP_ID=gym.adrenocromo.com`.
- Android passkeys require the site's Digital Asset Links file to include the release signing certificate fingerprint; Play Store builds use the Play App Signing certificate.
- iOS passkeys require Associated Domains with `webcredentials:gym.adrenocromo.com`, plus the correct Apple Team ID and app ID.

See `.env.example` for the current server variables and the Kotlin/Swift starter repositories for native setup details.
