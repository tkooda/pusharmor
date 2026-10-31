"""In-memory relay server and ntfy for the command tests (no network)."""

import base64
import json
import os
import threading
import time
import urllib.parse

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

import pusharmor as pa

ACCOUNT = bytes(range(1, 10))
ID_SECRET = b"fake id secret"


def wp_encrypt(pt, ua_pub, auth):
    """RFC 8291 aes128gcm, one record (the relay server side)."""
    as_priv, as_pub = pa.new_key()
    salt = os.urandom(16)
    d = pa.webpush_derive(pa.ecdh(as_priv, ua_pub), auth, ua_pub, as_pub, salt)
    ct = AESGCM(d["cek"]).encrypt(d["nonce"], pt + b"\x02", b"")
    return salt + (4096).to_bytes(4, "big") + bytes([65]) + as_pub + ct


class Resp:
    """One ntfy JSON stream."""

    def __init__(self, net, topic, since, poll, timeout):
        self.net, self.topic, self.poll, self.timeout = net, topic, poll, timeout
        msgs = net.topics.setdefault(topic, [])
        if not since:
            self.pos = len(msgs)
        elif since.isdigit():
            self.pos = 0
        else:
            ids = [m[0] for m in msgs]
            self.pos = ids.index(since) + 1 if since in ids else 0
        self.opened = False

    def readline(self, limit=-1):
        if not self.opened:
            self.opened = True
            return b'{"event":"open"}\n'
        end = time.time() + self.timeout
        with self.net.cond:
            while self.pos >= len(self.net.topics[self.topic]):
                if self.poll:
                    return b""
                if self.net.stop.is_set():
                    raise KeyboardInterrupt
                left = end - time.time()
                if left <= 0:
                    raise TimeoutError("read timeout")
                self.net.cond.wait(min(left, 0.05))
            mid, body = self.net.topics[self.topic][self.pos]
        self.pos += 1
        ev = {"id": mid, "event": "message", "message": base64.b64encode(body).decode(), "encoding": "base64"}
        return json.dumps(ev).encode() + b"\n"

    def close(self):
        pass


class Net:
    def __init__(self):
        self.peers, self.topics, self.log = {}, {}, []
        self.cond, self.stop, self.lock = threading.Condition(), threading.Event(), threading.RLock()
        self.clock_ms, self.seq, self.limit, self.hooks = 0, 0, 10, {}

    # ---- ntfy ----
    def ntfy_open(self, url, timeout):
        u = urllib.parse.urlsplit(url)
        q = dict(urllib.parse.parse_qsl(u.query))
        return Resp(self, u.path.split("/")[1], q.get("since", ""), q.get("poll") == "1", timeout)

    def deliver(self, pid, text):
        p = self.peers[pid]
        push = p["push"]
        topic = urllib.parse.urlsplit(push["endpoint"]).path.lstrip("/")
        body = wp_encrypt(text.encode(), pa.b64d(push["p256dh"]), pa.b64d(push["auth"]))
        with self.cond:
            self.seq += 1
            self.topics.setdefault(topic, []).append(("m%d" % self.seq, body))
            self.cond.notify_all()

    def count(self, pid):
        p = self.peers[pid]
        topic = urllib.parse.urlsplit(p["push"]["endpoint"]).path.lstrip("/")
        return len(self.topics.get(topic, []))

    # ---- relay server ----
    def http(self, method, url, headers, body):
        with self.lock:
            return self._http(method, url, headers, body or b"")

    def _http(self, method, url, headers, body):
        path = urllib.parse.urlsplit(url).path
        self.log.append((method, path))
        assert headers["PA-Client"] == "cli/" + pa.VERSION
        hook = self.hooks.get((method, path.split("/")[2]))
        if hook:
            r = hook(method, path, headers, body)
            if r:
                return r
        now = int(time.time() * 1000) + self.clock_ms
        if abs(now - int(headers["PA-Time"])) > 300000:
            return self.reply(401, {"error": "clock skew"})
        b = json.loads(body) if body else {}
        parts = path.split("/")[2:]
        if method == "POST" and parts == ["peers"]:
            return self.register(b, headers, method, path, body)
        me = headers["PA-ID"]
        caller = self.peers.get(me)
        if not caller:
            return self.reply(401, {"error": "unknown peer"})
        assert pa.verify_request(pa.b64d(caller["sign_pub"]), method, path, headers["PA-Time"], body,
                                 pa.b64d(headers["PA-Sig"]))
        if parts == ["peers"]:
            return self.reply(200, self.list_body(me))
        if parts[0] == "peers" and len(parts) == 3:
            if parts[2] == "confirm":
                caller["push_ok"] = b["code"] == caller["probe"]
                return self.reply(200 if caller["push_ok"] else 401, {} if caller["push_ok"] else {"error": "wrong code"})
            missing = [i for i in caller["allow"] if i not in b["m"]]
            if missing:
                return self.reply(400, {"error": "messages missing", "ids": missing})
            caller["logged_out"] = parts[2] == "logout"
            return self.reply(200, {"r": self.relay(me, b["m"])})
        if method == "PATCH":
            if "push" in b:
                caller["push"], caller["push_ok"] = b["push"], False
                self.probe(me)
                return self.reply(200, {})
            if "listening" in b:
                return self.reply(200, {})
            caller["names"].update(b["name"])
            return self.reply(200, {"r": self.relay(me, b["m"])})
        if method == "DELETE":
            self.peers.pop(parts[1], None)
            for p in self.peers.values():
                p["allow"].discard(parts[1])
            return self.reply(200, {"r": self.relay(me, b["m"])})
        if parts == ["send"]:
            return self.reply(200, {"r": self.relay(me, b["m"])})
        x = parts[1]
        xp = self.peers.get(x)
        if parts[0] == "pair":
            self.deliver(x, b["c"])
            return self.reply(200, {"r": "sent"})
        if parts[0] == "approve":
            caller["allow"].add(x)
            caller["names"][x] = b["name"]
            caller["pending"][x] = b["c"]
            if me not in xp["allow"]:
                return self.reply(200, {"r": "stored"})
            self.deliver(x, b["c"])
            out = {"r": "sent"}
            if me in xp["pending"]:
                out["c"] = xp["pending"][me]
            return self.reply(200, out)
        if parts[0] == "deny":
            caller["allow"].discard(x)
            return self.reply(200, {"r": "unapproved"})
        raise AssertionError("no route %s %s" % (method, path))

    def relay(self, me, m):
        r = {}
        for pid, msg in m.items():
            p = self.peers.get(pid)
            if not p:
                r[pid] = "unknown"
            elif me not in p["allow"]:
                r[pid] = "unapproved"
            elif p["logged_out"]:
                r[pid] = "logged out"
            else:
                self.deliver(pid, msg)
                r[pid] = "sent"
        return r

    def register(self, b, headers, method, path, body):
        assert "PA-ID" not in headers
        assert len(b["ticket"]) == 34 or b["ticket"].startswith("renewed")
        assert pa.verify_request(pa.b64d(b["sign_pub"]), method, path, headers["PA-Time"], body,
                                 pa.b64d(headers["PA-Sig"]))
        assert b["platform"] == "cli" and pa.re.fullmatch(r"https://[a-z0-9.-]+/up[A-Za-z0-9_-]{12}\?up=1",
                                                          b["push"]["endpoint"])
        for e in b.get("evict", []):
            self.peers.pop(e, None)
        if len(self.peers) >= self.limit:
            return self.reply(409, {"error": "peer limit", "ticket": "renewed-ticket",
                                    "peers": [{"id": i, "platform": p["platform"], "created": p["created"]}
                                              for i, p in self.peers.items()]})
        kh = pa.keyhash(pa.b64d(b["sign_pub"]), pa.b64d(b["enc_pub"]))
        pid = pa.b64e(pa.peer_id(ID_SECRET, ACCOUNT, kh))
        self.peers[pid] = {"sign_pub": b["sign_pub"], "enc_pub": b["enc_pub"], "platform": "cli",
                           "created": int(time.time()), "push": b["push"], "push_ok": False, "probe": "",
                           "allow": set(), "names": {}, "pending": {}, "logged_out": False}
        self.probe(pid)
        out = self.list_body(pid)
        out["id"] = pid
        return self.reply(200, out)

    def probe(self, pid):
        code = pa.b64e(os.urandom(16))
        self.peers[pid]["probe"] = code
        self.deliver(pid, json.dumps({"probe": code}))

    def list_body(self, me):
        peers = [{"id": i, "sign_pub": p["sign_pub"], "enc_pub": p["enc_pub"], "platform": p["platform"],
                  "created": p["created"], "logged_out": p["logged_out"], "approves_me": me in p["allow"],
                  "denies_me": False, "reachable": True, "name_for_me": p["names"].get(me)}
                 for i, p in self.peers.items()]
        return {"my_push_sha256": None, "my_allow": sorted(self.peers[me]["allow"]), "peers": peers}

    def reply(self, status, obj):
        return status, {"pa-epoch": str((int(time.time() * 1000) + self.clock_ms) // 1000)}, json.dumps(obj).encode()
