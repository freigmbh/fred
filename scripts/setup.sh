#!/usr/bin/env bash
#
# Walks a human through configuring FRED, step by step. Started from the /wizard
# skill's template: the helpers come first, FRED's stages follow the STAGES marker.

set -euo pipefail

# ──────────────────────────────────────────────────────────────────────────
# Wizard helpers
# ──────────────────────────────────────────────────────────────────────────

if [[ -t 1 ]] && command -v tput >/dev/null 2>&1 && [[ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]]; then
  BOLD=$(tput bold); DIM=$(tput dim); RESET=$(tput sgr0)
  BLUE=$(tput setaf 4); GREEN=$(tput setaf 2); YELLOW=$(tput setaf 3); RED=$(tput setaf 1)
else
  BOLD=""; DIM=""; RESET=""; BLUE=""; GREEN=""; YELLOW=""; RED=""
fi

TOTAL_STAGES=0

_STAGE_INDEX=0
ENV_FILE="${ENV_FILE:-.env}"
WRITTEN_ENV=() # KEYs written to ENV_FILE this run
SKIPPED=()     # steps left for the human, listed by finish

# _clear wipes the terminal so only the current step is on screen. No-op when
# output isn't a terminal, so piped logs stay readable.
_clear() {
  [[ -t 1 ]] || return 0
  if command -v tput >/dev/null 2>&1; then tput clear; else printf '\033[2J\033[3J\033[H'; fi
}

# banner "Title" shows the opening frame: what this wizard does.
banner() {
  _clear
  printf '\n%s%s  %s%s\n' "$BOLD" "$BLUE" "$1" "$RESET"
  printf '%s  %s stages%s\n\n' "$DIM" "$TOTAL_STAGES" "$RESET"
  printf '%s  You drive the browser; this wizard tells you exactly what to do and\n' "$DIM"
  printf '  captures the values you copy back. Stop any time with Ctrl-C and re-run\n'
  printf '  later, since it remembers values already saved.%s\n' "$RESET"
  pause "Ready to start?"
}

# stage "Name" clears the screen, then announces a stage and shows progress.
# Clearing keeps only the current step on screen.
stage() {
  _clear
  _STAGE_INDEX=$((_STAGE_INDEX + 1))
  printf '\n%s%s▸ Stage %s/%s · %s%s\n' \
    "$BOLD" "$BLUE" "$_STAGE_INDEX" "$TOTAL_STAGES" "$1" "$RESET"
}

say()  { printf '  %s\n' "$1"; }
# step "..." is a numbered-feeling action the human takes in the browser.
step() { printf '  %s•%s %s\n' "$BLUE" "$RESET" "$1"; }
note() { printf '  %s%s%s\n' "$DIM" "$1" "$RESET"; }
warn() { printf '  %s⚠ %s%s\n' "$YELLOW" "$1" "$RESET"; }

# open_url URL opens it in the human's browser, cross-platform incl. WSL.
open_url() {
  local url="$1"
  printf '  %s↗ opening%s %s\n' "$GREEN" "$RESET" "$url"
  { if   command -v wslview     >/dev/null 2>&1; then wslview "$url"
    elif command -v explorer.exe >/dev/null 2>&1; then explorer.exe "$url"
    elif command -v xdg-open    >/dev/null 2>&1; then xdg-open "$url"
    elif command -v open        >/dev/null 2>&1; then open "$url"
    else warn "couldn't open a browser; visit it manually: $url"; fi
  } >/dev/null 2>&1 || warn "couldn't open a browser, so visit it manually: $url"
}

pause() {
  printf '  %s%s%s ' "$DIM" "${1:-Press Enter to continue}" "$RESET"
  read -r _ || true
}

confirm() {
  local reply=""
  printf '  %s? %s [y/N] ' "$YELLOW" "$1"
  read -r reply || true
  [[ "$reply" =~ ^[Yy] ]]
}

# _existing KEY: current value of KEY in ENV_FILE, if any.
_existing() {
  [[ -f "$ENV_FILE" ]] || return 1
  local line; line=$(grep -E "^${1}=" "$ENV_FILE" | tail -n1) || return 1
  printf '%s' "${line#*=}"
}

# ask KEY "Prompt" reads a value into $KEY. Offers the existing .env value as
# a default on re-runs (Enter keeps it). Visible input (non-secret).
ask() {
  local key="$1" prompt="$2" current input
  current=$(_existing "$key" || true)
  if [[ -n "$current" ]]; then
    printf '  %s%s%s %s[Enter keeps current]%s ' "$BOLD" "$prompt" "$RESET" "$DIM" "$RESET"
  else
    printf '  %s%s%s ' "$BOLD" "$prompt" "$RESET"
  fi
  read -r input || true
  [[ -z "$input" && -n "$current" ]] && input="$current"
  printf -v "$key" '%s' "$input"
}

# ask_secret KEY "Prompt" is like ask, but input is hidden.
ask_secret() {
  local key="$1" prompt="$2" current input
  current=$(_existing "$key" || true)
  if [[ -n "$current" ]]; then
    printf '  %s%s%s %s[Enter keeps current]%s ' "$BOLD" "$prompt" "$RESET" "$DIM" "$RESET"
  else
    printf '  %s%s%s ' "$BOLD" "$prompt" "$RESET"
  fi
  read -rs input || true
  printf '\n'
  [[ -z "$input" && -n "$current" ]] && input="$current"
  printf -v "$key" '%s' "$input"
}

# write_env KEY VALUE upserts KEY=VALUE into ENV_FILE (creates it; replaces
# any existing line). Idempotent.
write_env() {
  local key="$1" value="$2" tmp
  touch "$ENV_FILE"
  tmp=$(mktemp)
  grep -vE "^${key}=" "$ENV_FILE" > "$tmp" || true
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  mv "$tmp" "$ENV_FILE"
  WRITTEN_ENV+=("$key")
  printf '  %s✓ wrote%s %s → %s\n' "$GREEN" "$RESET" "$key" "$ENV_FILE"
}

# finish clears, then shows a closing summary of everything configured.
finish() {
  _clear
  printf '\n%s%s  ✓ Setup complete%s\n' "$BOLD" "$GREEN" "$RESET"
  (( ${#WRITTEN_ENV[@]} ))    && note "wrote ${#WRITTEN_ENV[@]} value(s) to $ENV_FILE: ${WRITTEN_ENV[*]}"
  if (( ${#SKIPPED[@]} )); then
    printf '\n'; warn "still to do by hand:"
    for s in "${SKIPPED[@]}"; do note "  - $s"; done
  fi
  printf '\n'
}

# ──────────────────────────────────────────────────────────────────────────
# STAGES: one stage() per step the human takes. TOTAL_STAGES counts them.
# ──────────────────────────────────────────────────────────────────────────

TOTAL_STAGES=6

if [[ "${1:-}" == "--help" ]]; then
  printf 'Usage: pnpm run setup\n\nGuides backend, controller, GitLab, and worker configuration.\nExisting values are preserved on Enter. Secrets stay hidden.\nLocal files and controller updates each require confirmation.\nNo reviews, provider calls, deployments, or services start automatically.\n'
  exit 0
fi
[[ $# == 0 && -t 0 ]] || { printf 'Run pnpm run setup in an interactive terminal.\n' >&2; exit 1; }
command -v node >/dev/null || { printf 'Install Node 22.9 or newer first.\n' >&2; exit 1; }
node -e 'const [major,minor]=process.versions.node.split(".").map(Number);process.exit(major>22||(major===22&&minor>=9)?0:1)' || { printf 'Node 22.9 or newer is required.\n' >&2; exit 1; }
SETUP_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SETUP_HELPER="$SETUP_ROOT/scripts/setup-env.mjs"
umask 077
SETUP_TEMP=$(mktemp -d)
trap 'rm -rf "$SETUP_TEMP"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
ENV_FILE="$SETUP_TEMP/draft"

# Runs the setup data adapter with credentials in the private draft, never command arguments.
helper() { node "$SETUP_HELPER" "$1" "$SETUP_ROOT" "$ENV_FILE" "${@:2}"; }

# Captures one explained value, keeping existing input on Enter and clearing optional values with a dash.
field() {
  local key="$1" requirement="$2" description="$3" fallback="${4:-}" secret="${5:-no}" value
  say "${6:-$key} · $requirement"
  note "$description"
  value=$(_existing "$key" || true)
  if [[ -z "$value" && -n "$fallback" ]]; then write_env "$key" "$fallback" >/dev/null; value="$fallback"; fi
  if [[ "$secret" == no && -n "$value" ]]; then note "Current/default: $value"; fi
  if [[ "$requirement" == Optional* ]]; then
    if [[ -n "$fallback" ]]; then note 'Enter keeps the current value. A single - resets the default.'; else note 'Enter keeps the current value. A single - clears it.'; fi
  fi
  while true; do
    if [[ "$secret" == yes ]]; then ask_secret "$key" 'Value:' </dev/tty; else ask "$key" 'Value:' </dev/tty; fi
    value="${!key}"
    [[ "$value" != '-' ]] || value="$fallback"
    if [[ "$requirement" == Required* && -z "$value" ]]; then warn 'A value is required.'; continue; fi
    if printf '%s' "$value" | helper validate "$key"; then
      printf -v "$key" '%s' "$value"
      write_env "$key" "$value" >/dev/null
      break
    fi
  done
}

# Prompts for `key`, prefilled with its saved value or 32 new random bytes. The optional third argument is the encoding: hex (default) or base64.
generated_secret() {
  local key="$1" description="$2" encoding="${3:-hex}" value
  value=$(_existing "$key" || true)
  if [[ -z "$value" ]]; then value=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString(process.argv[1]))' "$encoding"); fi
  field "$key" 'Required · generated default' "$description" "$value" yes
}

helper init
banner 'FRED setup'

stage 'Choose the setup target'
say 'Configure all services from one place. Nothing starts automatically.'
field SETUP_BACKEND Required 'existing: connect to a self-hosted backend. local: prepare the Docker backend in this checkout.' existing
if [[ "$SETUP_BACKEND" == local ]]; then
  generated_secret INSTANCE_SECRET 'Backend storage/authentication secret. Keep the existing value for an existing database.'
  field INSTANCE_NAME 'Optional · default fred' 'Name of this local Convex instance.' fred
  note 'Backend image revisions and SQLite defaults come from the repository template.'
  if confirm 'Change the optional backend image revisions, ports, or public origins?'; then
    field REV Required 'Backend image revision. Keep the repository pin unless deliberately upgrading.'
    field DASHBOARD_REV Optional 'Dashboard image revision. Empty follows REV.'
    field PORT 'Optional · default 3210' 'Port used by the worker and deployment CLI.' 3210
    field SITE_PROXY_PORT 'Optional · default 3211' 'HTTP action port, including the GitLab webhook.' 3211
    field DASHBOARD_PORT 'Optional · default 6791' 'Port for the self-hosted Convex dashboard.' 6791
    field CONVEX_CLOUD_ORIGIN Optional 'Public backend client URL. Empty uses http://127.0.0.1:<PORT>.'
    field CONVEX_SITE_ORIGIN Optional 'Public HTTP action URL. Empty uses http://127.0.0.1:<SITE_PROXY_PORT>.'
    field POSTGRES_URL Optional 'Database connection string. Leave empty for the MVP SQLite backend.' '' yes
    field NEXT_PUBLIC_DEPLOYMENT_URL Optional 'Backend URL used by the dashboard. Empty uses the local backend port.'
  fi
  if confirm 'Change advanced backend concurrency, retention, database TLS, metrics, or logging settings?'; then
    field APPLICATION_MAX_CONCURRENT_MUTATIONS 'Optional · default 64' 'Maximum concurrent database mutations.' 64
    field APPLICATION_MAX_CONCURRENT_NODE_ACTIONS 'Optional · default 64' 'Maximum concurrent actions in the Node runtime.' 64
    field APPLICATION_MAX_CONCURRENT_QUERIES 'Optional · default 64' 'Maximum concurrent database queries.' 64
    field APPLICATION_MAX_CONCURRENT_V8_ACTIONS 'Optional · default 64' 'Maximum concurrent actions in the default runtime.' 64
    field DOCUMENT_RETENTION_DELAY 'Optional · default 172800' 'Seconds of historical document revisions retained by the backend.' 172800
    field DO_NOT_REQUIRE_SSL 'Optional · default true' 'true allows database connections without TLS. Enter - to require TLS for Postgres; SQLite is unaffected.'
    field DISABLE_METRICS_ENDPOINT 'Optional · default true' 'Disable the backend metrics endpoint.' true
    field RUST_LOG 'Optional · default info' 'Backend log filter. Leave info for ordinary operation.' info
  fi
  write_env DISABLE_BEACON true >/dev/null
  helper summary backend
  if ! confirm "Save backend configuration to $SETUP_ROOT/apps/controller/self-hosted/.env?"; then say 'Cancelled before saving.'; exit 0; fi
  helper save backend
  say 'In a second terminal on the backend machine, run:'
  printf '    cd %q\n    docker compose up -d\n    docker compose exec -T backend ./generate_admin_key.sh\n' "$SETUP_ROOT/apps/controller/self-hosted"
  note 'Copy the generated admin key for the next stage. Do not replace an existing instance secret.'
  pause 'Press Enter when the backend is available and you have its admin key.'
fi

stage 'Connect the controller'
field CONVEX_SELF_HOSTED_URL Required 'Self-hosted backend API URL for deployment and runtime configuration. Convex Cloud is refused.' "http://127.0.0.1:$(_existing PORT || printf 3210)"
field CONVEX_SELF_HOSTED_ADMIN_KEY Required 'Deployment admin key from the backend administrator or generate_admin_key.sh. Only the deployment configuration receives it.' '' yes
if confirm "Read existing controller settings from $CONVEX_SELF_HOSTED_URL?"; then
  if ! helper import-controller; then
    warn 'Could not load existing settings. Continuing might replace existing shared secrets.'
    confirm 'Continue by entering controller values manually?' || exit 1
  fi
fi
if [[ ! -f "$SETUP_ROOT/apps/worker/.env" ]]; then write_env CONVEX_URL "$CONVEX_SELF_HOSTED_URL" >/dev/null; fi
field CONVEX_URL Required 'Backend URL reachable from the worker. Usually the same as the deployment URL.' "$CONVEX_SELF_HOSTED_URL"
field SETUP_SITE_URL Required 'HTTP action origin reachable from GitLab, often port 3211. This is not the backend client URL.' "http://127.0.0.1:$(_existing SITE_PROXY_PORT || printf 3211)"
write_env SETUP_DASHBOARD_URL "http://127.0.0.1:$(_existing DASHBOARD_PORT || printf 6791)" >/dev/null
field SETUP_DASHBOARD_URL Optional 'Dashboard URL for initial controller settings. Enter - if your administrator handles this.'
generated_secret WORKER_SECRET 'Authenticates workers. The exact same value is saved for the controller and worker.'
generated_secret GITLAB_WEBHOOK_SECRET 'GitLab sends this secret with webhook requests. The controller checks it.'

stage 'Configure GitLab'
field GITLAB_URL Required 'Company GitLab base URL, for example https://gitlab.company.example.'
generated_secret FRED_TOKEN_KEY 'Encrypts project access tokens stored in the controller. Keep the existing value; a new key makes every saved token unreadable.' base64
say 'Each project reviews through its own project access token, connected in the admin UI.'
step 'For each project: Settings > Access tokens. Create a token named 0 FRED with the api scope and the Developer role.'
step 'Paste it on the admin UI Projects page and choose the review pipeline.'
note 'FRED checks the token with GitLab, finds its project, and creates missing fred-review::clean and fred-review::findings labels.'
say "Webhook URL: ${SETUP_SITE_URL%/}/webhook/gitlab"
step 'For each project: Settings > Webhooks. Select Merge request events and Comments and enter this URL and the webhook secret.'
if confirm 'Show the webhook secret once so you can copy it into GitLab?'; then printf '\n%s\n\n' "$GITLAB_WEBHOOK_SECRET"; pause 'Press Enter after copying. The next stage clears the screen.'; fi
note 'GitLab must reach that URL over the company network. A localhost URL will not work from a different host.'
note 'Reviews need the connected token and the webhook. Private-fork MRs are reviewed only when the token can read the source project.'
confirm 'Are project tokens connected and project webhooks ready?' || SKIPPED+=('Connect each project with its 0 FRED token in the admin UI and add its webhook')

stage 'Configure OpenRouter'
open_url 'https://openrouter.ai/settings/keys'
step 'Create or select a service API token for the worker.'
field OPENROUTER_API_TOKEN Required 'OpenRouter API token used for all review models in every project.' '' yes
note 'Setup does not call model APIs or validate billing access. Select models and reasoning effort per project and stage in the admin UI.'

stage 'Choose review settings'
field WORKER_MODE 'Optional · default fixture' 'fixture: localhost controller and selected test projects. service: authorized shared operation.' fixture
if [[ "$WORKER_MODE" == fixture ]]; then
  field WORKER_FIXTURE_PROJECT_IDS Required 'Comma-separated numeric IDs of dedicated fixture projects. Other projects are refused.'
  write_env AI_REVIEW_LIVE '' >/dev/null
  if confirm 'Enable human-run fixture reviews? Starting the worker later will spend provider budget and post to GitLab.'; then
    write_env AI_REVIEW_LIVE 1 >/dev/null
  else
    SKIPPED+=('Set AI_REVIEW_LIVE=1 before a human-run fixture review')
  fi
fi
note 'Optional worker settings keep their current values or repository defaults.'
if confirm 'Configure optional concurrency or other bot IDs?'; then
  field WORKER_CONCURRENCY 'Optional · default 8' 'Simultaneous reviews across different MRs. Work on one MR runs sequentially.' 8
  field BOT_USER_IDS_OTHER Optional 'Comma-separated IDs of other bots, such as Renovate. Their MR author is not charged.'
fi

if confirm 'Choose the initial budget and timezone for a new controller? Existing settings are left alone.'; then
  field SETUP_MONTHLY_BUDGET 'Optional · default 3000 USD' 'Default monthly developer budget, not a per-review cap.' 3000
  field SETUP_TIMEZONE 'Optional · default Europe/Berlin' 'IANA timezone used to assign usage to a calendar month.' Europe/Berlin
fi

stage 'Review and save'
helper check
helper summary
note 'Existing unrelated variables are retained. Updated files are readable only by their owner.'
note 'Exported environment variables take precedence when the worker starts; remove stale shell overrides.'
if ! confirm 'Save these deployment, controller-runtime, and worker env files?'; then say 'Cancelled. The final configuration files were not saved.'; exit 0; fi
helper save
say 'Saved deployment credentials, controller runtime variables, and worker settings.'
note 'The controller runtime env file is a local copy. Convex must receive those variables separately.'
if confirm "Apply controller runtime variables to $CONVEX_SELF_HOSTED_URL now? This updates that deployment."; then
  if ! helper apply; then warn 'Controller apply failed. Local files are saved; rerun setup to retry.'; exit 1; fi
else
  SKIPPED+=('Apply apps/controller/.env.runtime to the intended Convex deployment; rerun setup to do this')
fi
if [[ -n "$SETUP_DASHBOARD_URL" ]]; then
  open_url "$SETUP_DASHBOARD_URL"
  step 'For a new controller, deploy its functions using the local run guide, then open Data > settings.'
  step 'Keep an existing settings row. If none exists, insert exactly one row:'
  helper initial-settings
  note 'Required initial settings: kill switch, monthly default budget in USD, and organization timezone. Adjust budget/timezone for your organization.'
  note 'Enable globalEnabled only when the deployment is ready for reviews.'
  confirm 'Does the controller have its initial settings row?' || SKIPPED+=('Create the initial controller settings row')
else
  SKIPPED+=('Have the administrator verify the controller settings row')
fi
SKIPPED+=('On the Linux worker host, verify credentials and sandbox behavior with a supervised fixture review')
ENV_FILE='the reviewed configuration files'
finish
say 'No deployment, service, or review was started by this wizard.'
say 'Next steps: docs/run-locally.html. Start the configured worker with pnpm --filter @fred/worker start.'
