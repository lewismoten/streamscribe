# Deploying the hub

`bin/deploy-hub.sh` puts the hub and the web app on your server over SSH. GitHub Actions runs it on every push to main (`.github/workflows/deploy-hub.yml`), and you can run it from your own machine.

On the server, everything goes in one folder (`DEPLOY_PATH`):

```
DEPLOY_PATH/            the web app: index.html, assets/       → https://example.com/meetings/
DEPLOY_PATH/hub/        the hub: api.php, lib/, tools/         → https://example.com/meetings/hub/api.php
DEPLOY_PATH/hub/config.php, data/, media/                      made on the server; never touched by deploys
```

The web app there is built to use the hub beside it, so visitors just open the site.

- **Only changed files are sent:** rsync compares checksums.
- **Old files are removed:** files gone from the repository are deleted on the server, except `config.php`, `data/` and `media/`.
- **The database is updated:** after copying, the script runs `php hub/tools/migrate.php` on the server, which brings the database up to date.

GitHub Pages can publish the same web app too. It keeps its data in each visitor's browser (IndexedDB) and, if you give it the hub's address, syncs with your server. See GitHub Pages below.

## Once, on the server

You need SSH access, PHP 8 with `pdo_sqlite` on the command line and the web server, HTTPS, and `rsync` (most hosts have it).

1. **Pick a folder only for streamscribe**, such as `public_html/meetings`, because deploys delete anything else in it (except `.well-known/`, `cgi-bin/` and `.htaccess`). Add an SSH key for deploying (see On your machine below).
2. **Make the hub's settings.** Run the first deploy (it stops at "No config.php yet"), or make the folder `hub/` yourself, then:

   ```bash
   ssh you@example.com
   cd public_html/meetings/hub
   cp config.example.php config.php
   nano config.php
   ```

   In `config.php`:
   - **`database`:** put the database outside the web folder if you can, such as `'/home/you/streamscribe-data/hub.sqlite'`.
   - **`allowed_origins`:** add your GitHub Pages address (`https://YOUR-NAME.github.io`) if you'll use Pages. The site on this server needs nothing here.
   - **`keys`:** add one per recorder: `php tools/new-key.php recorder "Office Mac"`.
3. **Make your admin account:**

   ```bash
   php tools/new-user.php YOUR-NAME --admin --name "Your Name"
   ```

   It asks for a password. Run it again any time to reset the password.
4. **Check the hub:** open `https://example.com/meetings/hub/api.php/info`. It should answer with the hub's name.

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
   DEPLOY_SSH_OPTIONS="-i $HOME/.ssh/streamscribe_deploy -o IdentitiesOnly=yes"
   ```

   Then:
   - `npm run deploy:hub -- --dry-run` lists what would change.
   - `npm run deploy:hub` deploys.

   To try the hub on your own machine first: copy `hub-php/config.example.php` to `hub-php/config.php` (Git ignores it), run `npm run hub:dev`, and use `http://127.0.0.1:8080/api.php` as the hub address.

## In GitHub

Under the repository's **Settings → Environments**, make an environment named `production` (the deploy job uses it) and add the following to it, one name and value at a time. Repository-level secrets and variables (**Settings → Secrets and variables → Actions**) work too. To use `gh` instead, add `--env production` to the commands below.

**Secrets** (hidden):

| Name | Value |
| --- | --- |
| `DEPLOY_SSH_KEY` | the private key: the whole of `~/.ssh/streamscribe_deploy`, including the BEGIN and END lines |
| `DEPLOY_KNOWN_HOSTS` | the server's host keys, from `ssh-keyscan -p 22 example.com`, so the deploy can tell it's your server |

```bash
gh secret set DEPLOY_SSH_KEY < ~/.ssh/streamscribe_deploy
ssh-keyscan -p 22 example.com | gh secret set DEPLOY_KNOWN_HOSTS
```

**Variables** (visible):

| Name | Value | Needed |
| --- | --- | --- |
| `DEPLOY_HOST` | `example.com` | yes; the deploy is skipped until it's set |
| `DEPLOY_USER` | your SSH user | yes |
| `DEPLOY_PATH` | `public_html/meetings` (relative to your home folder, or absolute) | yes |
| `DEPLOY_PORT` | SSH port | if it isn't 22 |
| `SITE_BASE` | the site's path in the browser, such as `/meetings/` | if it isn't `/` |
| `REMOTE_PHP` | the PHP command on the server, such as `php8.3` or `/usr/local/bin/php` | if plain `php` isn't PHP 8 |
| `PAGES_HUB_URL` | `https://example.com/meetings/hub/api.php` | for GitHub Pages, to sync with your hub |
| `PAGES_ON_PUSH` | `true` | to publish GitHub Pages on every push (otherwise run it by hand) |

```bash
gh variable set DEPLOY_HOST --body example.com
gh variable set DEPLOY_USER --body you
gh variable set DEPLOY_PATH --body public_html/meetings
gh variable set SITE_BASE --body /meetings/
gh variable set PAGES_HUB_URL --body https://example.com/meetings/hub/api.php
```

Then push to main, or run **Deploy hub** from the Actions tab. The job runs the tests (`npm test`), builds the web app, and deploys. It runs again whenever the hub, the web app or the sync code changes on main.

## GitHub Pages

The **Pages** workflow publishes the web app at `https://YOUR-NAME.github.io/REPOSITORY/`.

1. Under **Settings → Pages**, set the source to **GitHub Actions**.
2. Set `PAGES_HUB_URL` so the site syncs with your hub, and add `https://YOUR-NAME.github.io` to `allowed_origins` in the hub's `config.php`. Without a hub address, each visitor's browser keeps its own copy (IndexedDB) and nothing is shared.
3. Run **Pages** from the Actions tab, or set `PAGES_ON_PUSH` to `true` to publish on every push.

Visitors can point the site at a different hub, or at none, under Settings. Sign-ins work the same on Pages as on your server; each browser keeps its own session.

## When something goes wrong

- **The deploy can't connect** ("Host key verification failed" or "Permission denied"):
  - Check that `DEPLOY_KNOWN_HOSTS` came from the same host and port as `DEPLOY_HOST` and `DEPLOY_PORT`.
  - Check that the public key is in the server's `~/.ssh/authorized_keys`.
- **"No config.php yet":** do step 2 under Once, on the server, then deploy again.
- **"rsync: command not found":** the server needs rsync. Ask your host, or deploy from a machine that can reach a server that has it.
- **The site loads but says it can't reach the hub:** open `…/hub/api.php/info`.
  - A PHP error there means the server's PHP lacks `pdo_sqlite`, or can't write the folder in `database`.
  - A 404 means `SITE_BASE` or `DEPLOY_PATH` doesn't match where the site is served from.
- **Sign-in works on the server's site but not on GitHub Pages:** the Pages address is missing from `allowed_origins`.
