# Force every IPv4 socket onto the Dante interface via IP_BOUND_IF (macOS).
# Needed because macOS can have a 169.254/16 route on several interfaces; unbound sends
# go out the wrong one and fail with "No route to host". Active only when DANTE_IF is set.
import os, socket
_IFNAME = os.environ.get("DANTE_IF")
if _IFNAME:
    try:
        _IDX = socket.if_nametoindex(_IFNAME)
    except OSError:
        _IDX = None
    if _IDX:
        _IP_BOUND_IF = 25
        _orig = socket.socket.__init__
        def _init(self, family=-1, type=-1, proto=-1, fileno=None):
            _orig(self, family, type, proto, fileno)
            if fileno is None and self.family == socket.AF_INET:
                try: self.setsockopt(socket.IPPROTO_IP, _IP_BOUND_IF, _IDX)
                except OSError: pass
        socket.socket.__init__ = _init
