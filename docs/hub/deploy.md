# Deploying the hub

`bin/deploy-hub.sh` puts the hub and the web app on your server over SSH. GitHub Actions runs it on every push to main (`.github/workflows/deploy-hub.yml`), and you can run it from your own machine.

On the server, everything goes in one folder (`DEPLOY_PATH`):

```
DEPLOY_PATH/              the web app: index.html, assets/         → https://example.com/meetings/
DEPLOY_PATH/hub/          the hub: api.php, lib/, tools/           → https://example.com/meetings/hub/api.php
DEPLOY_PATH/hub/agent/    the agents' code, for installing agents (downloadable only with a token or key)
DEPLOY_PATH/hub/data/, media/, config.php (optional)            made on the server; never touched by deploys
<database folder>/private/  meetings' files (private_dir); outside the web folder
```

The web app there is built to use the hub beside it, so visitors just open the site.

- **Only changed files are sent:** rsync compares checksums.
- **Old files are removed:** files gone from the repository are deleted on the server, except the hub's `config.php`, `data/` and `media/`, and the host's own files in the site folder (`.htaccess`, `.user.ini`, `php.ini`, `.well-known/`, `cgi-bin/`). The script adds its caching rules to the site's `.htaccess` in a marked block of its own.
- **The database is updated:** after copying, the script runs `php hub/tools/migrate.php` on the server, which brings the database up to date.

GitHub Pages can publish the same web app too. It keeps its data in each visitor's browser (IndexedDB) and, if you give it the hub's address, syncs with your server. See GitHub Pages below.

## Once, on the server

You need SSH access, PHP 8 with `pdo_sqlite` on the command line and the web server, HTTPS, and `rsync` (most hosts have it).

1. **Pick a folder only for streamscribe**, such as `public_html/meetings`, because deploys delete anything else in it (except `.well-known/`, `cgi-bin/`, `.htaccess`, `.user.ini` and `php.ini`). Add an SSH key for deploying (see On your machine below).
2. **Deploy** (On your machine, below). The hub needs no config file: it keeps its database in `hub/data/` and published files in `hub/media/` (the included `.htaccess` keeps `data/` off the web, and deploys never touch either).
3. **Open the site right away** and make your admin account: a hub with no accounts asks the first visitor for a username and password, and that account becomes the admin. Everything else (the hub's name, a GitHub Pages address allowed to use it, keys, podcast details, limits) is under **Accounts** once you're signed in.
4. **Check the hub:** open `https://example.com/meetings/hub/api.php/info`. It should answer with the hub's name.

**Optional, `config.php`:** to keep the database outside the web folder (better, if the host allows it), copy `hub/config.example.php` to `hub/config.php` on the server and set `database`, such as `'/home/you/streamscribe-data/hub.sqlite'`. Over SSH, `php tools/new-user.php YOUR-NAME --admin` also makes an admin, or resets a forgotten password.

## On your machine

1. **Make a key just for deploying**, with no passphrase, since GitHub can't type one:

   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/streamscribe_deploy -C "streamscribe deploy" -N ""
   ssh-copy-id -i ~/.ssh/streamscribe_deploy.pub -p 22 you@example.com
   ```

   If `ssh-copy-id` isn't available, add the `.pub` file's line to `~/.ssh/authorized_keys` on the server.

2. **Check that it works:** `ssh -i ~/.ssh/streamscribe_deploy you@example.com 'php -v && rsync --version'`.
3. **To deploy from your machine**, make `deploy.local.env` at the repository root. Git ignores it.

   ```bash
   DEPLOY_HOST=example.com
   DEPLOY_USER=you
   DEPLOY_PATH=public_html/meetings
   DEPLOY_PORT=22
   SITE_BASE=/meetings/
   SITE_URL=https://example.com/meetings
   DEPLOY_SSH_OPTIONS="-i $HOME/.ssh/streamscribe_deploy -o IdentitiesOnly=yes"
   ```

   Then:
   - `npm run deploy:hub -- --dry-run` lists what would change.
   - `npm run deploy:hub` deploys.
   - `HUB_URL=…` builds the site for a hub somewhere else (default `hub/api.php`, beside it); `SKIP_BUILD=1` sends what was built last.

   To try the hub on your own machine first: run `npm run hub:dev` and use `http://127.0.0.1:8080/api.php` as the hub address (its database goes in `hub-php/data/`, which Git ignores).

## In GitHub

Under the repository's **Settings → Environments**, make an environment named `production` (the deploy job uses it) and add the following to it, one name and value at a time. Repository-level secrets and variables (**Settings → Secrets and variables → Actions**) work too. To use `gh` instead, add `--env production` to the commands below.

**Secrets** (hidden):

| Name                 | Value                                                                                                 |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| `DEPLOY_SSH_KEY`     | the private key: the whole of `~/.ssh/streamscribe_deploy`, including the BEGIN and END lines         |
| `DEPLOY_KNOWN_HOSTS` | the server's host keys, from `ssh-keyscan -p 22 example.com`, so the deploy can tell it's your server |

```bash
gh secret set DEPLOY_SSH_KEY < ~/.ssh/streamscribe_deploy
ssh-keyscan -p 22 example.com | gh secret set DEPLOY_KNOWN_HOSTS
```

**Variables** (visible):

| Name            | Value                                                                   | Needed                                                                               |
| --------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `DEPLOY_HOST`   | `example.com`                                                           | yes; the deploy is skipped until it's set                                            |
| `DEPLOY_USER`   | your SSH user                                                           | yes                                                                                  |
| `DEPLOY_PATH`   | `public_html/meetings` (relative to your home folder, or absolute)      | yes                                                                                  |
| `DEPLOY_PORT`   | SSH port                                                                | if it isn't 22                                                                       |
| `SITE_BASE`     | the site's path in the browser, such as `/meetings/`                    | if it isn't `/`                                                                      |
| `SITE_URL`      | the site's full address, such as `https://streamscribe.lewismoten.com`  | for the preview picture when links are shared                                        |
| `REMOTE_PHP`    | the PHP command on the server, such as `php8.3` or `/usr/local/bin/php` | if plain `php` isn't PHP 8                                                           |
| `PAGES_HUB_URL` | `https://example.com/meetings/hub/api.php`                              | for GitHub Pages, to sync with your hub                                              |
| `PAGES_ON_PUSH` | `false`                                                                 | to publish GitHub Pages only when run by hand (it publishes on every push otherwise) |

```bash
gh variable set DEPLOY_HOST --body example.com
gh variable set DEPLOY_USER --body you
gh variable set DEPLOY_PATH --body public_html/meetings
gh variable set SITE_BASE --body /meetings/
gh variable set PAGES_HUB_URL --body https://example.com/meetings/hub/api.php
```

Then push to main, or run **Deploy hub** from the Actions tab. The job runs the tests (`npm test`), builds the web app, and deploys. It runs again whenever the hub, the web app or the sync code changes on main.

## Sending recordings you already have

Meetings a recorder records reach the hub by themselves. For ones already in your local library, run `npm run publish-library` on the machine that has them. It sends each recording's details, final transcript, up to `recorder.maxStills` stills from its thumbnails, its marks (speakers, chapters, votes, word corrections and the rest) and each source's people. The video stays on your machine.

1. **Make a recorder key:** under Accounts → Keys, make one "For: Recording" (or run `php tools/new-key.php recorder "Your Mac"` on the server). It's shown once.
2. **Point your machine at the hub:** in `config.local.js`, add the hub's address and that key:

   ```js
   recorder: { hubUrl: 'https://example.com/hub/api.php', key: 'ss_…' }
   ```

3. **Send:** `npm run publish-library -- --dry-run` lists what would go, and `npm run publish-library` sends it.

Run it again after transcribing or marking more. Only what changed is sent, and pictures already on the hub aren't uploaded again.

- `--recording <id>` sends one recording, by its id in the library database.
- `--all` also sends captures already joined into a full meeting.

## GitHub Pages

The **Pages** workflow publishes the web app at `https://YOUR-NAME.github.io/REPOSITORY/`.

1. Under **Settings → Pages**, set the source to **GitHub Actions**.
2. Set `PAGES_HUB_URL` so the site syncs with your hub, and add `https://YOUR-NAME.github.io` under Accounts → Hub settings, "Other sites that may use this hub". Without a hub address, each visitor's browser keeps its own copy (IndexedDB) and nothing is shared.
3. Push to main (or run **Pages** from the Actions tab). It publishes on every push unless `PAGES_ON_PUSH` is `false`; it fails with a message if step 1 wasn't done.

Visitors can point the site at a different hub, or at none, under Settings. Sign-ins work the same on Pages as on your server; each browser keeps its own session.

## When something goes wrong

- **The deploy can't connect** ("Host key verification failed" or "Permission denied"):
  - Check that `DEPLOY_KNOWN_HOSTS` came from the same host and port as `DEPLOY_HOST` and `DEPLOY_PORT`.
  - Check that the public key is in the server's `~/.ssh/authorized_keys`.
- **"rsync: command not found":** the server needs rsync. Ask your host, or deploy from a machine that can reach a server that has it.
- **The site loads but says it can't reach the hub:** open `…/hub/api.php/info`.
  - A PHP error there means the server's PHP lacks `pdo_sqlite`, or can't write the folder in `database`.
  - A 404 means `SITE_BASE` or `DEPLOY_PATH` doesn't match where the site is served from.
- **Sign-in works on the server's site but not on GitHub Pages:** the Pages address is missing from Accounts → Hub settings ("Other sites that may use this hub").
