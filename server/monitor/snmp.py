"""A tiny read-only SNMP v1/v2c client (GET and WALK) using only the standard library.

Both Netgear M4250 and Luminex GigaCore switches answer standard SNMP, so
this is how we read port status and error counters from them.
"""
import random
import socket

# ---- BER encoding ---------------------------------------------------------
INTEGER, OCTET_STRING, NULL, OID, SEQUENCE = 0x02, 0x04, 0x05, 0x06, 0x30
IPADDRESS, COUNTER32, GAUGE32, TIMETICKS, OPAQUE, COUNTER64 = 0x40, 0x41, 0x42, 0x43, 0x44, 0x46
NO_SUCH_OBJECT, NO_SUCH_INSTANCE, END_OF_MIB = 0x80, 0x81, 0x82
GET, GETNEXT, RESPONSE, GETBULK = 0xA0, 0xA1, 0xA2, 0xA5


class SnmpError(Exception):
    pass


def _len(n):
    if n < 0x80:
        return bytes([n])
    out = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return bytes([0x80 | len(out)]) + out


def _tlv(tag, value):
    return bytes([tag]) + _len(len(value)) + value


def _int(v):
    return _tlv(INTEGER, v.to_bytes(max(1, (v.bit_length() + 8) // 8), "big", signed=True))


def _oid(oid):
    parts = [int(p) for p in oid.strip(".").split(".")]
    body = bytes([parts[0] * 40 + parts[1]])
    for p in parts[2:]:
        chunk = [p & 0x7F]
        p >>= 7
        while p:
            chunk.append(0x80 | (p & 0x7F))
            p >>= 7
        body += bytes(reversed(chunk))
    return _tlv(OID, body)


def build_request(community, oids, pdu_type=GET, version=1, request_id=None,
                  non_repeaters=0, max_repetitions=20):
    """version: 0 = SNMPv1, 1 = SNMPv2c"""
    request_id = request_id if request_id is not None else random.randint(1, 0x7FFFFFFF)
    varbinds = b"".join(_tlv(SEQUENCE, _oid(o) + _tlv(NULL, b"")) for o in oids)
    if pdu_type == GETBULK:
        fields = _int(request_id) + _int(non_repeaters) + _int(max_repetitions)
    else:
        fields = _int(request_id) + _int(0) + _int(0)
    pdu = _tlv(pdu_type, fields + _tlv(SEQUENCE, varbinds))
    msg = _int(version) + _tlv(OCTET_STRING, community.encode()) + pdu
    return _tlv(SEQUENCE, msg), request_id


# ---- BER decoding ---------------------------------------------------------
def _read_tlv(data, i):
    tag = data[i]
    i += 1
    length = data[i]
    i += 1
    if length & 0x80:
        n = length & 0x7F
        length = int.from_bytes(data[i:i + n], "big")
        i += n
    return tag, data[i:i + length], i + length


def _decode_oid(b):
    parts = [b[0] // 40, b[0] % 40]
    val = 0
    for byte in b[1:]:
        val = (val << 7) | (byte & 0x7F)
        if not byte & 0x80:
            parts.append(val)
            val = 0
    return ".".join(str(p) for p in parts)


def _decode_value(tag, b):
    if tag == INTEGER:
        return int.from_bytes(b, "big", signed=True)
    if tag in (COUNTER32, GAUGE32, TIMETICKS, COUNTER64):
        return int.from_bytes(b, "big", signed=False)
    if tag == OCTET_STRING:
        return b
    if tag == OID:
        return _decode_oid(b)
    if tag == IPADDRESS:
        return ".".join(str(x) for x in b)
    if tag in (NO_SUCH_OBJECT, NO_SUCH_INSTANCE, END_OF_MIB, NULL):
        return None
    return b


def parse_response(data):
    """Return (request_id, error_status, error_index, [(oid, tag, value), ...])."""
    tag, msg, _ = _read_tlv(data, 0)
    if tag != SEQUENCE:
        raise SnmpError("not an SNMP message")
    i = 0
    _, _ver, i = _read_tlv(msg, i)
    _, _comm, i = _read_tlv(msg, i)
    pdu_tag, pdu, _ = _read_tlv(msg, i)
    if pdu_tag != RESPONSE:
        raise SnmpError("unexpected PDU")
    j = 0
    _, rid, j = _read_tlv(pdu, j)
    _, err, j = _read_tlv(pdu, j)
    _, erri, j = _read_tlv(pdu, j)
    _, vbl, _ = _read_tlv(pdu, j)
    out = []
    k = 0
    while k < len(vbl):
        _, vb, k = _read_tlv(vbl, k)
        _, oid_b, m = _read_tlv(vb, 0)
        vtag, vval, _ = _read_tlv(vb, m)
        out.append((_decode_oid(oid_b), vtag, _decode_value(vtag, vval)))
    return int.from_bytes(rid, "big", signed=True), int.from_bytes(err, "big"), \
        int.from_bytes(erri, "big"), out


# ---- client ---------------------------------------------------------------
class SnmpClient:
    def __init__(self, host, community="public", port=161, timeout=1.5, retries=2, version="2c"):
        self.host = host
        self.community = community
        self.port = port
        self.timeout = timeout
        self.retries = retries
        self.version = 1 if version == "2c" else 0

    def _request(self, oids, pdu_type, **kw):
        packet, rid = build_request(self.community, oids, pdu_type, self.version, **kw)
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(self.timeout)
        try:
            for _ in range(self.retries + 1):
                s.sendto(packet, (self.host, self.port))
                try:
                    while True:
                        data, _ = s.recvfrom(65535)
                        got_id, err, erri, vbs = parse_response(data)
                        if got_id == rid:
                            if err:
                                raise SnmpError("SNMP error %d at item %d" % (err, erri))
                            return vbs
                except socket.timeout:
                    continue
            raise SnmpError("no reply from %s (check SNMP is enabled and the community name)" % self.host)
        finally:
            s.close()

    def get(self, oids):
        return {oid: val for oid, _t, val in self._request(list(oids), GET)}

    def walk(self, base, max_rows=5000):
        """Return {full_oid: value} for everything under base."""
        base = base.strip(".")
        prefix = base + "."
        result = {}
        current = base
        while len(result) < max_rows:
            if self.version == 1:
                vbs = self._request([current], GETBULK, max_repetitions=25)
            else:
                vbs = self._request([current], GETNEXT)
            if not vbs:
                break
            done = False
            for oid, tag, val in vbs:
                if not oid.startswith(prefix) or tag == END_OF_MIB:
                    done = True
                    break
                result[oid] = val
                current = oid
            if done:
                break
        return result


def table_by_index(walk_result, column_oid):
    """{'1.3.6...column.5': v} -> {'5': v}"""
    prefix = column_oid.strip(".") + "."
    return {oid[len(prefix):]: v for oid, v in walk_result.items() if oid.startswith(prefix)}


def text(v):
    if isinstance(v, bytes):
        try:
            return v.decode("utf-8").strip("\x00").strip()
        except UnicodeDecodeError:
            return v.hex()
    return "" if v is None else str(v)
