#!/usr/bin/env bash
# Puts the hub and the web app on a server over SSH, sending only files that changed (rsync, by checksum):
#   DEPLOY_PATH/        the web app (index.html, assets/), set to use the hub beside it
#   DEPLOY_PATH/hub/    the hub (hub-php/); its config.php, data/, and media/ on the server are never touched
# then brings the hub's database up to date (tools/migrate.php). GitHub Actions runs it (.github/workflows/
# deploy-hub.yml); to run it from your machine, put the settings in deploy.local.env (see docs/hub/deploy.md):
#   npm run deploy:hub [-- --dry-run]
# Settings (environment): DEPLOY_HOST, DEPLOY_USER, DEPLOY_PATH (required); DEPLOY_PORT (22); SITE_BASE (the site's
# path on the server, such as / or /meetings/; default /); HUB_URL (where the site finds the hub; default hub/api.php,
# beside it); DEPLOY_SSH_OPTIONS (extra ssh options, such as -i ~/.ssh/streamscribe_deploy); REMOTE_PHP (php).
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f deploy.local.env ] && { set -a; . ./deploy.local.env; set +a; }
: "${DEPLOY_HOST:?Set DEPLOY_HOST (the server)}" "${DEPLOY_USER:?Set DEPLOY_USER (the SSH user)}" "${DEPLOY_PATH:?Set DEPLOY_PATH (the folder on the server, such as public_html/meetings)}"
DRY_RUN=''
[ "${1:-}" = "--dry-run" ] && DRY_RUN='--dry-run'
SSH="ssh -p ${DEPLOY_PORT:-22} -o BatchMode=yes ${DEPLOY_SSH_OPTIONS:-}"
REMOTE="$DEPLOY_USER@$DEPLOY_HOST"

if [ "${SKIP_BUILD:-}" != "1" ]; then
  # Into its own folder, so the local server's build (web/dist) stays as it is.
  VITE_BASE="${SITE_BASE:-/}" VITE_ROUTER=hash VITE_HUB_URL="${HUB_URL:-hub/api.php}" npx vite build --outDir dist-deploy --emptyOutDir
fi

$SSH "$REMOTE" "mkdir -p '$DEPLOY_PATH/hub'"
RSYNC=(rsync --recursive --links --checksum --compress --delete --itemize-changes --exclude .DS_Store -e "$SSH")
echo "Web app → $REMOTE:$DEPLOY_PATH/"
"${RSYNC[@]}" $DRY_RUN --exclude '/hub/' --exclude '/.well-known/' --exclude '/cgi-bin/' --exclude '/.htaccess' --exclude '/.user.ini' --exclude '/php.ini' web/dist-deploy/ "$REMOTE:$DEPLOY_PATH/"
echo "Hub → $REMOTE:$DEPLOY_PATH/hub/"
"${RSYNC[@]}" $DRY_RUN --exclude '/config.php' --exclude '/data/' --exclude '/media/' hub-php/ "$REMOTE:$DEPLOY_PATH/hub/"

if [ -z "$DRY_RUN" ]; then
  $SSH "$REMOTE" "cd '$DEPLOY_PATH/hub' && ${REMOTE_PHP:-php} tools/migrate.php"
fi
