#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 || -e "$1" || ( $# == 2 && -e "$2" ) ]]; then
    printf 'Usage: %s NEW_USB_ARCHIVE.zip [NEW_BUILD_SOURCE.bundle]\n' "$0" >&2
    exit 2
fi
out=$(realpath -m "$1")
bundle=
if [[ $# == 2 ]]; then bundle=$(realpath -m "$2"); fi
repo=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
source=$(git -C "$repo" rev-parse HEAD)
scratch=$(mktemp -d)
trap 'rm -rf -- "$scratch"' EXIT
git -c advice.detachedHead=false clone -q --no-hardlinks "$repo" "$scratch/source"
cd "$scratch/source"
git -c advice.detachedHead=false checkout -q --detach "$source"
node - <<'JS'
const fs = require('fs');
const app = 'apps/robertn_waze_cluster/';
const appVersion = '0.6.26112701';
const toolVersion = '0.14.26112701';
function edit(file, change) {
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    change(json);
    fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
}
for (const file of ['mgu-app.json', 'package/package.json', 'package/npm-shrinkwrap.json']) {
    edit(app + file, (json) => { json.version = appVersion; });
}
edit(app + 'package/rhmiData/application.json', (json) => { json.application.version = appVersion; });
edit(app + 'release.json', (json) => { json.requires['waze-on-cluster'] = toolVersion; });
edit('native/waze-on-cluster/component.json', (json) => {
    json.version = toolVersion;
    json.requires['cluster-render'] = '0.6.9';
});
JS
git add -- apps/robertn_waze_cluster native/waze-on-cluster/component.json
git -c user.name='Local adaptive HUD build' -c user.email='adaptive-hud@localhost' commit -qm 'Stage local adaptive HUD package versions'
node release/release.js build robertn_waze_cluster waze-on-cluster
if [[ -n "$bundle" ]]; then
    git branch adaptive-package HEAD
    git bundle create "$bundle" refs/heads/adaptive-package
fi
mkdir -p "$scratch/usb/mgu-repo"
mv release/out "$scratch/usb/mgu-repo/bmw-adaptive-hud"
python3 - "$scratch/usb" "$out" <<'PY'
import hashlib
import json
import pathlib
import sys
import zipfile

root = pathlib.Path(sys.argv[1])
catalog = root / 'mgu-repo/bmw-adaptive-hud/catalog.json'
entries = json.loads(catalog.read_text(encoding='utf-8'))['components']
assert {c['id'] for c in entries} == {'robertn_waze_cluster', 'waze-on-cluster'}
for entry in entries:
    artifact = entry['artifact']
    package = catalog.with_name(artifact['name']).read_bytes()
    assert len(package) == artifact['size']
    assert hashlib.sha256(package).hexdigest() == artifact['sha256']
    print(entry['id'], entry['version'], artifact['sha256'])
with zipfile.ZipFile(sys.argv[2], 'x', compression=zipfile.ZIP_DEFLATED) as archive:
    for file in sorted(root.rglob('*')):
        if file.is_file():
            archive.write(file, file.relative_to(root))
with zipfile.ZipFile(sys.argv[2]) as archive:
    assert archive.testzip() is None
PY
