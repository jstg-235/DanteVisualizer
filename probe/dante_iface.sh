#!/bin/zsh
# Print the interface name the Dante devices are seen on (via mDNS _netaudio-arc), e.g. en9 or en11.
# Uses $DANTE_IF if set. Prints nothing and exits 1 when no Dante devices are seen
# (cable out, network down), so callers can wait and try again.
# A chosen port counts only while it is up with an IPv4 address (an unplugged adapter has none).
if [ -n "$DANTE_IF" ]; then
  ifconfig "$DANTE_IF" 2>/dev/null | grep -q '^[[:space:]]*inet ' || exit 1
  echo $DANTE_IF; exit 0
fi
idx=$( (dns-sd -B _netaudio-arc._udp local. & p=$!; sleep 1.5; kill $p) 2>/dev/null | awk '$2=="Add"{print $4}' | sort | uniq -c | sort -rn | awk 'NR==1{print $2}')
[ -n "$idx" ] && "${DV_PYTHON:-python3}" -c "import socket,sys;print(socket.if_indextoname(int(sys.argv[1])))" $idx 2>/dev/null || exit 1
