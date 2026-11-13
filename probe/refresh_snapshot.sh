#!/bin/zsh
# Rewrite live_snapshot.json from a fresh read of devices, channels and routes.
# Read-only: one `netaudio device list` (no metering, nothing that changes a device).
# The Dante interface is auto-detected (dante_iface.sh) unless DANTE_IF is set.
#
# Environment (set by the Mac app; defaults suit running from this folder):
#   DV_PYTHON  Python with netaudio installed (default: .venv/bin/python)
#   DV_DATA    where live_snapshot.json is written (default: this folder)
cd "$(dirname "$0")"
PY=${DV_PYTHON:-$PWD/.venv/bin/python}
DATA=${DV_DATA:-$PWD}
export DV_PYTHON=$PY
DANTE_IF=$(./dante_iface.sh) || exit 1   # no Dante devices visible: keep the last snapshot
export DANTE_IF PYTHONPATH="$PWD/shim"
export DANTE_IP=$(ifconfig $DANTE_IF 2>/dev/null | awk '/inet /{print $2; exit}')
tmp=$(mktemp -d)
"$(dirname "$PY")/netaudio" --no-color --interface $DANTE_IF --timeout 3 -o json device list > $tmp/raw_device_list.json 2>/dev/null &&
"$PY" split_device_list.py $tmp/raw_device_list.json $tmp &&
"$PY" -c "import json,sys;d=json.load(open(sys.argv[1]))['dante'];sys.exit(0 if d else 1)" $tmp/raw_device_list.json &&
"$PY" build_snapshot.py $tmp "$DATA/live_snapshot.json" >/dev/null
rc=$?; rm -rf $tmp; exit $rc
