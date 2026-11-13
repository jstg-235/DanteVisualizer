#!/bin/zsh
# Run meter_daemon.py on the current Dante interface; restart it if the interface changes (exit 3).
# Extra args go to meter_daemon.py (e.g. --dry-run). Stop with Ctrl-C or `kill <pid of this script>`:
# the signal is forwarded so the helper sends metering_stop to every device before exiting.
#
# Environment (set by the Mac app; defaults suit running from this folder):
#   DV_PYTHON  Python with netaudio installed (default: .venv/bin/python)
#   DV_DATA    where levels.json is written and live_snapshot.json is read (default: this folder)
cd "$(dirname "$0")"
PY=${DV_PYTHON:-$PWD/.venv/bin/python}
export DV_PYTHON=$PY
# A port chosen by the user (DANTE_IF already set) stays fixed; otherwise it is detected each round.
CHOSEN=$DANTE_IF
[ -n "$CHOSEN" ] && export DANTE_IF_FIXED=1
child=0
trap 'stopping=1; [ $child -ne 0 ] && kill -TERM $child 2>/dev/null' INT TERM HUP
stopping=0
while [ $stopping -eq 0 ]; do
  if ! DANTE_IF=$(DANTE_IF=$CHOSEN ./dante_iface.sh); then
    # No Dante devices visible (cable out, network down): wait and look again.
    sleep 3 & child=$!; wait $child; child=0
    continue
  fi
  export DANTE_IF PYTHONPATH="$PWD/shim"
  "$PY" meter_daemon.py "$@" &
  child=$!
  wait $child; rc=$?
  # wait returns early when a trapped signal arrives: wait again for the child to finish its cleanup
  while kill -0 $child 2>/dev/null; do wait $child; rc=$?; done
  child=0
  [ $rc -eq 3 ] || break
  echo "$(date '+%F %T') interface changed or gone; restarting helper in 3 s"
  sleep 3 & child=$!; wait $child; child=0
done
exit $rc
