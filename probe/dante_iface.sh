#!/bin/zsh
# Print the interface name the Dante devices are seen on (via mDNS _netaudio-arc), e.g. en9 or en11.
# Uses $DANTE_IF if set. Prints nothing and exits 1 when no Dante devices are seen
# (cable out, network down), so callers can wait and try again.
[ -n "$DANTE_IF" ] && { echo $DANTE_IF; exit 0; }
idx=$( (dns-sd -B _netaudio-arc._udp local. & p=$!; sleep 1.5; kill $p) 2>/dev/null | awk '$2=="Add"{print $4}' | sort | uniq -c | sort -rn | awk 'NR==1{print $2}')
[ -n "$idx" ] && "${DV_PYTHON:-python3}" -c "import socket,sys;print(socket.if_indextoname(int(sys.argv[1])))" $idx 2>/dev/null || exit 1
