#!/usr/bin/env bash
# Puts the hub and the web app on a server over SSH, sending only files that changed (rsync, by checksum):
#   DEPLOY_PATH/        the web app (index.html, assets/), set to use the hub beside it
#   DEPLOY_PATH/hub/    the hub (hub-php/); its data/, media/, and config.php (optional) on the server are never
#                       touched
# then brings the hub's database up to date (tools/migrate.php). GitHub Actions runs it (.github/workflows/
# deploy-hub.yml); to run it from your machine, put the settings in deploy.local.env (see docs/hub/deploy.md):
#   npm run deploy:hub [-- --dry-run]
# Settings (environment): DEPLOY_HOST, DEPLOY_USER, DEPLOY_PATH (required); DEPLOY_PORT (22); SITE_BASE (the site's
# path on the server, such as / or /meetings/; default /); HUB_URL (where the site finds the hub; default hub/api.php,
# beside it); SITE_URL (the site's full address, for sharing previews); DEPLOY_SSH_OPTIONS (extra ssh options, such as -i ~/.ssh/streamscribe_deploy); REMOTE_PHP (php).
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
  VITE_BASE="${SITE_BASE:-/}" VITE_ROUTER=hash VITE_HUB_URL="${HUB_URL:-hub/api.php}" VITE_SITE_URL="${SITE_URL:-}" npx vite build --outDir dist-deploy --emptyOutDir
fi

# The agent's code, which new agents download through the hub (hub-php/lib/agent-routes.php): bin/, src/, and
# package.json are all it needs (no npm packages).
mkdir -p web/dist-agent
COPYFILE_DISABLE=1 tar -czf web/dist-agent/streamscribe-agent.tgz --exclude .DS_Store bin src package.json config.example.js

$SSH "$REMOTE" "mkdir -p '$DEPLOY_PATH/hub/agent'"
RSYNC=(rsync --recursive --links --checksum --compress --delete --itemize-changes --exclude .DS_Store -e "$SSH")
echo "Web app → $REMOTE:$DEPLOY_PATH/"
"${RSYNC[@]}" $DRY_RUN --exclude '/hub/' --exclude '/.well-known/' --exclude '/cgi-bin/' --exclude '/.htaccess' --exclude '/.user.ini' --exclude '/php.ini' web/dist-deploy/ "$REMOTE:$DEPLOY_PATH/"
echo "Hub → $REMOTE:$DEPLOY_PATH/hub/"
"${RSYNC[@]}" $DRY_RUN --exclude '/config.php' --exclude '/data/' --exclude '/media/' --exclude '/agent/' hub-php/ "$REMOTE:$DEPLOY_PATH/hub/"
echo "Agent package → $REMOTE:$DEPLOY_PATH/hub/agent/"
"${RSYNC[@]}" $DRY_RUN web/dist-agent/ "$REMOTE:$DEPLOY_PATH/hub/agent/"

if [ -z "$DRY_RUN" ]; then
  # Caching, in the site's .htaccess (beside the host's own settings there, which stay): browsers check index.html on
  # every visit, so a deploy shows at once, and keep the content-named assets/ files for a year.
  $SSH "$REMOTE" "f='$DEPLOY_PATH/.htaccess'; touch \"\$f\"; sed -i '/^# BEGIN streamscribe/,/^# END streamscribe/d' \"\$f\"; cat >> \"\$f\"" <<'HTACCESS'
# BEGIN streamscribe (written by bin/deploy-hub.sh)
<IfModule mod_headers.c>
  <FilesMatch "^index\.html$">
    Header set Cache-Control "no-cache"
  </FilesMatch>
  <FilesMatch "^index-[A-Za-z0-9_-]{8}\.(js|css)$">
    Header set Cache-Control "public, max-age=31536000, immutable"
  </FilesMatch>
</IfModule>
# END streamscribe
HTACCESS
  $SSH "$REMOTE" "cd '$DEPLOY_PATH/hub' && ${REMOTE_PHP:-php} tools/migrate.php"
fi
