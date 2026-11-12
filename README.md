# Veracode User Manager

A local web app that manages the users of a Veracode Platform organization through the Veracode Identity API, including bulk changes from a CSV file.

## Run it

Packages come through the Veracode package firewall, set up in the project's `.npmrc`, so there is nothing to configure.

```
npm install
npm run dev
```

The pre-commit hook runs a Veracode static scan when the Veracode CLI is installed and has HMAC API credentials (`veracode configure`, or `~/.veracode/credentials`). For the full chain of what runs when you commit, and where each step is defined, see "What happens when you commit" in `docs/PROCESS.md`.

Then open http://localhost:5173. See `docs/STATUS.md` for what works today and `docs/` for the spec, stack and standards.

## Set up the API service account

The app signs in to Veracode as its own API service account, not as you. An Administrator sets it up once per organization:

1. In the Veracode Platform user administration, add a new user and mark it as an **API service account**.
2. Give it the **Admin API** role (`adminapi`) and no other roles. It needs no team.
3. Use a real mailbox for its email address. Veracode sends the activation email there, and the account signs in to the platform only to manage its credentials.
4. Create **OAuth client credentials** for the account. Sign in to the Veracode Platform as the service account, then:
   1. Open the user account menu (top right) and choose **API Credentials**.
   2. Choose **Create API Credentials**, then **OAuth Client**.
   3. Enter a name and description, set the **expiration to 30 days or less**, and under **Available Roles** keep **Admin API**.
   4. Choose **Generate**, then **Create**.
   5. Copy the **Client ID** and **Client Secret**. The secret is shown only once; if you lose it, create new credentials.

   You don't need HMAC credentials (an API ID and key); the app uses OAuth only. An Administrator can also create OAuth credentials for the account through the Identity API (`POST /api/authn/v2/oauth2/client_credentials`).

5. In a terminal at the project folder (PowerShell, Terminal or the VS Code terminal; not Git Bash, which can't hide input), run `npm run connect`. The first time, it creates the vault and your **app user**: choose a username and a password of at least 12 characters. Then enter a name, the region (US, EU or US Federal), the client ID and the secret. Run it again to add, list or remove connections, or to add another app user with `npm run connect -- add-user`.
6. Start the app with `npm run dev`, open http://localhost:5173 and sign in with your app username and password. The sign-in page is marked "Un-official": it is this app's own login, so never type your Veracode password there. Then open **Connections** and choose **Test** to check the connection against Veracode. _The Users and Import pages still show sample data until phase 5 of `docs/PLAN_API.md`._

The secret is stored only in the encrypted vault, `.local/vault.json`, and never reaches the browser. The app gets short-lived tokens with it when needed and keeps them in memory. Any app user can open the vault, on any machine, with their own username and password. The vault is never committed: git ignores it and the pre-commit hook refuses it.

**Connections expire after 30 days.** The app removes each connection 30 days after it was added: it revokes the tokens and the client on Veracode and deletes the secret. To keep going, create a new client secret and add it. App users don't expire while they're in use: each sign-in extends them to 30 days from then, and only an app user who hasn't signed in for 30 days is removed. If you forget your password, another app user can remove and re-add you; if no app user is left, delete the vault and start again.

Why a dedicated account:

- You can revoke or rotate the app's access without touching your own login.
- The platform's audit trail shows the app's changes as made by the service account.
- An API service account can only sign in to manage its own API credentials, so it can't be used to work in the platform's other screens.

This is all the app needs; no custom role is required. If you later want access narrower than the whole organization, see the optional custom role under "Future upgrades" in `docs/SPEC.md`.
