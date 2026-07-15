#!/usr/bin/env python3
"""Print the NetEase desktop-app session cookie as one line, for NEMR_COOKIE.

    python3 extract-macos.py

Copy the single line it prints and paste it into the NEMR_COOKIE environment
variable of the Docker stack. The value goes to stdout only (nothing is logged),
so you can also pipe it, e.g.  python3 extract-macos.py | pbcopy

The app keeps its cookies as an NSKeyedArchiver plist inside an MMKV file. We
find the "cookie" MMKV entry and parse the archived NSHTTPCookie objects.
"""
import os, plistlib, sys

MMKV = os.environ.get(
    "MMKV_PATH",
    os.path.expanduser(
        "~/Library/Containers/com.netease.163music/Data/Documents/storage/mmkv.default"
    ),
)
buf = open(MMKV, "rb").read()


def read_varint(b, i):
    shift = val = 0
    while True:
        c = b[i]; i += 1
        val |= (c & 0x7F) << shift
        if not c & 0x80:
            return val, i
        shift += 7


# MMKV appends; the last well-formed write for "cookie" wins.
key = b"cookie"
latest = None
i = 0
while True:
    j = buf.find(key, i)
    if j < 0:
        break
    i = j + 1
    if j == 0 or buf[j - 1] != len(key):  # require the length prefix
        continue
    _clen, k = read_varint(buf, j + len(key))
    dlen, k = read_varint(buf, k)
    val = buf[k : k + dlen]
    if val[:8] == b"bplist00":
        latest = val

if not latest:
    sys.exit("[nemr] no cookie bplist found — is the app installed and logged in?")

# NSKeyedArchiver: each NSHTTPCookie is a dict with a 'properties' NSDictionary
# holding {Name, Value, Domain, ...}.
objs = plistlib.loads(latest)["$objects"]
deref = lambda o: objs[o.data] if isinstance(o, plistlib.UID) else o
as_dict = lambda d: {deref(k): deref(v) for k, v in zip(d["NS.keys"], d["NS.objects"])}

cookies = {}
for o in objs:
    if isinstance(o, dict) and "properties" in o:
        props = deref(o["properties"])
        if isinstance(props, dict) and "NS.keys" in props:
            props = as_dict(props)
        name, value = props.get("Name"), props.get("Value")
        if isinstance(name, str) and isinstance(value, str):
            cookies[name] = value

if "MUSIC_U" not in cookies or "__csrf" not in cookies:
    print("[nemr] found:", ", ".join(cookies) or "(none)", file=sys.stderr)
    sys.exit("[nemr] MUSIC_U/__csrf missing — is the desktop app logged in?")

# Human-facing notes go to stderr; the copy-paste line is the only thing on stdout.
print(f"[nemr] extracted {len(cookies)} cookies incl. MUSIC_U, __csrf.", file=sys.stderr)
print("[nemr] paste the line below into the NEMR_COOKIE env var:\n", file=sys.stderr)
print("; ".join(f"{k}={v}" for k, v in cookies.items()))
