#!/bin/sh
set -eu
: "${FRED_PUBLIC_URL:?Set FRED_PUBLIC_URL}"
: "${FRED_DASHBOARD_URL:?Set FRED_DASHBOARD_URL}"
export FRED_PUBLIC_URL="${FRED_PUBLIC_URL%/}" FRED_DASHBOARD_URL="${FRED_DASHBOARD_URL%/}"
tls=/etc/nginx/tls
unreadable() {
  echo "$0: user $(id -u) cannot read $1; give group $(id -g) read access to the TLS directory and both files, and keep symlinks inside the directory" >&2
  exit 1
}
if [ -d "$tls" ] && { [ ! -r "$tls" ] || [ ! -x "$tls" ]; }; then unreadable "$tls"; fi
# A symlink counts as present even when its target is missing, so a link out of the mount fails the read check instead of serving HTTP.
present() { [ -e "$1" ] || [ -L "$1" ]; }
certificate=no key=no
present "$tls/tls.crt" && certificate=yes
present "$tls/tls.key" && key=yes
case "$certificate$key" in
  yesyes)
    for file in "$tls/tls.crt" "$tls/tls.key"; do [ -r "$file" ] || unreadable "$file"; done
    mode=https ;;
  nono) mode=http ;;
  *) echo "$0: /etc/nginx/tls needs both tls.crt and tls.key, or neither for plain HTTP" >&2; exit 1 ;;
esac
cat /etc/nginx/fred/templates/common.conf "/etc/nginx/fred/templates/$mode.conf" \
  | envsubst '${FRED_PUBLIC_URL} ${FRED_DASHBOARD_URL}' > /etc/nginx/conf.d/servers.conf
echo "$0: serving FRED over $mode"
