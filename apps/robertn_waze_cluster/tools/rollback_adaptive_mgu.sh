#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Invoke only from an approved, stationary MGU maintenance session.
set -eu

deploy=/var/opt/mgu-deploy/mgu-deploy.sh
app=robertn_waze_cluster
tool=waze-on-cluster
app_version=0.6.26112301
tool_version=0.14.26112301

version() {
    "$deploy" status --read-only --json | node -e '
        const fs = require("fs"), status = JSON.parse(fs.readFileSync(0, "utf8"));
        if (!Array.isArray(status.components)) process.exit(1);
        const rows = status.components.filter((c) => c.id === process.argv[1]);
        if (rows.length > 1 || (rows[0] && typeof rows[0].version !== "string")) process.exit(1);
        process.stdout.write(rows.length ? rows[0].version : "absent");' "$1"
}

mode=${1:---status}
case "$mode" in
    --status|--remove-adaptive) ;;
    *) printf 'Usage: %s [--status | --remove-adaptive]\n' "$0" >&2; exit 2 ;;
esac

app_installed=$(version "$app")
tool_installed=$(version "$tool")
printf '%s %s\n%s %s\n' "$app" "$app_installed" "$tool" "$tool_installed"
[ "$mode" = '--remove-adaptive' ] || exit 0

if { [ "$app_installed" != 'absent' ] && [ "$app_installed" != "$app_version" ]; } ||
   { [ "$tool_installed" != 'absent' ] && [ "$tool_installed" != "$tool_version" ]; }; then
    printf '%s\n' 'A different package version is installed. Use the Store to manage it.' >&2
    exit 1
fi

if [ "$app_installed" = "$app_version" ]; then
    "$deploy" uninstall "$app" --yes
fi
if [ "$tool_installed" = "$tool_version" ]; then
    "$deploy" uninstall "$tool" --yes
fi
printf '%s\n' 'Removal commands completed. Follow any Store restart prompt and reinstall the recorded original versions from their source.'
