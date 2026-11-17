#!/bin/zsh
# Put a private Python with netaudio inside the app, so it runs with no Python installed
# and no internet on first launch.
#
#   mac/embed_python.sh "build/Dante Visualizer.app"
#
# Uses a relocatable CPython from python-build-standalone (pinned, checked by SHA-256) and
# installs requirements.txt with the versions in python-lock.txt into
# Contents/Resources/python. The download is cached in mac/.cache.
set -euo pipefail
setopt null_glob
cd "$(dirname "$0")"
APP=$1
PBS_TAG=20261026
PBS_FILE="cpython-3.14.10+${PBS_TAG}-aarch64-apple-darwin-install_only_stripped.tar.gz"
PBS_SHA=95eb8c87d16af37c54e9765e31d8c56c0d8ffa9968ea0f704f73a9b83f84e9f9
PBS_URL="https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_TAG}/${PBS_FILE//+/%2B}"

mkdir -p .cache
if [[ ! -f ".cache/$PBS_FILE" ]] || [[ $(shasum -a 256 ".cache/$PBS_FILE" | cut -d' ' -f1) != "$PBS_SHA" ]]; then
  echo "Downloading $PBS_FILE…"
  curl -fL --retry 3 -o ".cache/$PBS_FILE.part" "$PBS_URL"
  mv ".cache/$PBS_FILE.part" ".cache/$PBS_FILE"
fi
if [[ $(shasum -a 256 ".cache/$PBS_FILE" | cut -d' ' -f1) != "$PBS_SHA" ]]; then
  echo "Checksum mismatch for $PBS_FILE" >&2
  exit 1
fi

PY_DIR="$APP/Contents/Resources/python"
rm -rf "$PY_DIR"
tar -xzf ".cache/$PBS_FILE" -C "$APP/Contents/Resources"   # unpacks to python/
PY="$PY_DIR/bin/python3"

echo "Installing netaudio into the app…"
PIP_DISABLE_PIP_VERSION_CHECK=1 PYTHONNOUSERSITE=1 "$PY" -m pip install --no-warn-script-location \
  -r ../requirements.txt -c python-lock.txt >/dev/null

# Trim what the app never uses (and that would only add files to sign).
LIB=$(echo "$PY_DIR"/lib/python3.*)
rm -rf "$LIB"/{test,idlelib,tkinter,turtledemo,ensurepip,lib2to3} "$LIB"/lib-dynload/_tkinter*.so \
       "$PY_DIR"/lib/{libtcl,libtk,tcl,tk,itcl,thread}* "$PY_DIR"/share "$PY_DIR"/include
find "$PY_DIR" -name '__pycache__' -prune -exec rm -rf {} +

# Console scripts carry this build machine's path; replace netaudio's with a relative one.
rm -f "$PY_DIR"/bin/netaudio* "$PY_DIR"/bin/pip*
rm -rf "$LIB"/site-packages/pip "$LIB"/site-packages/pip-*.dist-info
cat > "$PY_DIR/bin/netaudio" <<'SH'
#!/bin/sh
exec "$(dirname "$0")/python3" -m netaudio "$@"
SH
chmod +x "$PY_DIR/bin/netaudio"

# Compile now: the signed app must never write .pyc files into itself.
"$PY" -m compileall -q -j 0 "$PY_DIR/lib" >/dev/null || true
echo "Embedded Python: $("$PY" -c 'import sys; print(sys.version.split()[0])'), $(du -sh "$PY_DIR" | cut -f1)"
