import XCTest
@testable import PushArmorCore

/// Runs every section of the repo golden vector file tests/vectors/golden-v1.json through
/// the production code (software keys stand in for the Secure Enclave).
final class GoldenTests: XCTestCase {
    typealias J = [String: Any]

    static let golden: J = {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("tests/vectors/golden-v1.json")
        let d = try! Data(contentsOf: url)
        return try! JSONSerialization.jsonObject(with: d) as! J
    }()

    func section(_ k: String) -> J { GoldenTests.golden[k] as! J }
    func cases(_ k: String) -> [J] { section(k)["cases"] as! [J] }
    func b(_ s: Any?) -> Data { B64URL.decode(s as! String)! }
    func str(_ s: Any?) -> String { s as! String }
    func u64(_ v: Any?) -> UInt64 { (v as! NSNumber).uint64Value }
    func i64(_ v: Any?) -> Int64 { (v as! NSNumber).int64Value }
    func isNull(_ v: Any?) -> Bool { v == nil || v is NSNull }

    var peers: [String: J] { section("keys")["peers"] as! [String: J] }
    func peer(_ name: String) -> J { peers[name]! }
    func pid(_ name: String) -> PeerId { PeerId(text: str(peer(name)["id"]))! }
    func decryptor(_ name: String) -> SoftwareDecryptor { try! SoftwareDecryptor(raw: b(peer(name)["enc_priv"])) }

    func hmac(_ key: Data, _ parts: Data...) -> Data {
        var h = HMAC<SHA256>(key: SymmetricKey(data: key))
        for p in parts { h.update(data: p) }
        return Data(h.finalize())
    }

    // MARK: keys, ids

    func testKeys() throws {
        let secret = b(section("keys")["id_secret"])
        XCTAssertEqual(peers.count, 5)
        for (name, p) in peers {
            let sp = try P256.Signing.PrivateKey(rawRepresentation: b(p["sign_priv"])).publicKey.x963Representation
            let ep = try P256.KeyAgreement.PrivateKey(rawRepresentation: b(p["enc_priv"])).publicKey.x963Representation
            XCTAssertEqual(sp, b(p["sign_pub"]), name)
            XCTAssertEqual(ep, b(p["enc_pub"]), name)
            XCTAssertEqual(SoftwareSigner(key: try P256.Signing.PrivateKey(rawRepresentation: b(p["sign_priv"]))).publicKey, sp)
            XCTAssertEqual(decryptor(name).publicKey, ep)
            let eh = Ids.emailHash(normalized: Ids.normalizeEmail(str(p["email"]))!)
            let account = hmac(secret, eh).prefix(9)
            XCTAssertEqual(account, b(p["account"]), name)
            let kh = Ids.keyhash(signPub: sp, encPub: ep)
            XCTAssertEqual(kh, b(p["keyhash"]), name)
            let id = account + kh + hmac(secret, account + kh).prefix(9)
            XCTAssertEqual(B64URL.encode(id), str(p["id"]), name)
            let pidv = PeerId(text: str(p["id"]))!
            XCTAssertEqual(pidv.account, Data(account))
            XCTAssertEqual(pidv.matches(signPub: sp, encPub: ep), true)
            XCTAssertEqual(PublicKeys.validPair(signPub: sp, encPub: ep), name != "S")
        }
    }

    func testEmailHash() {
        let secret = b(section("keys")["id_secret"])
        let cs = cases("email_hash")
        XCTAssertFalse(cs.isEmpty)
        for c in cs {
            let n = Ids.normalizeEmail(str(c["input"]))
            if isNull(c["normalized"]) {
                XCTAssertNil(n, str(c["input"]))
                continue
            }
            XCTAssertEqual(n, str(c["normalized"]))
            let eh = Ids.emailHash(normalized: n!)
            XCTAssertEqual(eh, b(c["email_hash"]))
            XCTAssertEqual(hmac(secret, eh).prefix(9), b(c["account"]))
        }
    }

    func testIdOrder() {
        for c in cases("id_order") {
            let a = PeerId(text: str(c["a"]))!, bb = PeerId(text: str(c["b"]))!
            XCTAssertEqual(a < bb ? "a" : "b", str(c["lower"]), str(c["name"]))
            XCTAssertNotEqual(a < bb, bb < a)
        }
    }

    func testOAuthNonce() {
        for c in cases("oauth_nonce") {
            let sp = b(c["sign_pub"])
            XCTAssertEqual(Ids.k(signPub: sp), str(c["k"]))
            XCTAssertEqual(Ids.oauthNonce(purpose: str(c["purpose"]), signPub: sp), str(c["nonce"]))
        }
    }

    func testMyPushSha256() {
        var apnsSeen = 0
        for c in cases("my_push_sha256") {
            let p = c["push"] as! [String: String]
            let t = p["type"]!
            let s: String
            if t == "apns" || t == "apns-sandbox" {
                let pi = PushInfo(type: PushInfo.Kind(rawValue: t)!, token: p["token"]!)
                s = Ids.pushSha256(pi)
                apnsSeen += 1
            } else if t == "fcm" {
                s = B64URL.encode(Bytes.sha256(Data((t + "\n" + p["token"]!).utf8)).prefix(16))
            } else {
                s = B64URL.encode(Bytes.sha256(Data((t + "\n" + p["endpoint"]! + "\n" + p["p256dh"]! + "\n" + p["auth"]!).utf8)).prefix(16))
            }
            XCTAssertEqual(s, str(c["my_push_sha256"]), t)
        }
        XCTAssertEqual(apnsSeen, 2)
    }

    func testB64URL() {
        for c in cases("b64url") {
            let d = B64URL.decode(str(c["input"]))
            if c["ok"] as! Bool {
                XCTAssertEqual(d.map(Bytes.hex), str(c["hex"]), str(c["input"]))
                XCTAssertEqual(B64URL.encode(d!), str(c["input"]))
            } else {
                XCTAssertNil(d, str(c["input"]))
            }
        }
    }

    // MARK: pairing

    func testPairing() throws {
        let p = section("pairing")
        let n = peer(str(p["N"])), x = peer(str(p["X"]))
        let rN = b(p["r_N"]), rX = b(p["r_X"])
        let cN = PairingCrypto.commit(signPubN: b(n["sign_pub"]), encPubN: b(n["enc_pub"]), rN: rN)
        XCTAssertEqual(cN, b(p["c_N"]))
        let h = Bytes.sha256(Bytes.ascii("PA-SAS1\n"), b(n["sign_pub"]), b(n["enc_pub"]), b(x["sign_pub"]), b(x["enc_pub"]), rN, rX)
        XCTAssertEqual(h, b(p["fingerprint_hash"]))
        XCTAssertEqual(PairingCrypto.fingerprint(signPubN: b(n["sign_pub"]), encPubN: b(n["enc_pub"]), signPubX: b(x["sign_pub"]),
                                                 encPubX: b(x["enc_pub"]), rN: rN, rX: rX), str(p["fingerprint"]))
        XCTAssertEqual(B64URL.encode(PairingCrypto.pairingId(rN: rN, rX: rX)), str(p["pairing_id"]))
        XCTAssertEqual(PairingCrypto.pairingKey(nId: pid(str(p["N"])), xId: pid(str(p["X"]))), str(p["pk"]))
        let fcs = p["fingerprint_cases"] as! [J]
        var symbols = Set<Character>()
        for c in fcs {
            let f = Crockford.encodePrefix(b(c["hash"]), chars: 4)
            XCTAssertEqual(f, str(c["fingerprint"]))
            symbols.formUnion(f)
        }
        XCTAssertEqual(symbols.count, 32)
        let msgs = p["pair_messages"] as! [J]
        XCTAssertEqual(msgs.count, 3)
        for m in msgs {
            let to = str(m["to"])
            let me = pid(to)
            let msg = str(m["message"])
            XCTAssertEqual(msg.count, PairMessage.wireLength)
            let plain = try decryptor(to).hpkeOpen(wire: b(msg), info: PairMessage.info, aad: Bytes.ascii(me.text))
            XCTAssertEqual(plain, b(m["plaintext"]))
            let parsed = try PairMessage.open(msg, me: me, key: decryptor(to))
            XCTAssertEqual(parsed.from, pid(str(m["from"])))
            switch (str(m["kind"]), parsed.body) {
            case ("commit", .commit(let c)): XCTAssertEqual(c, cN)
            case ("reply", .reply(let s, let e, let r)):
                XCTAssertEqual(s, b(x["sign_pub"])); XCTAssertEqual(e, b(x["enc_pub"])); XCTAssertEqual(r, rX)
            case ("open", .open(let s, let e, let r)):
                XCTAssertEqual(PairingCrypto.commit(signPubN: s, encPubN: e, rN: r), cN)
            default: XCTFail("kind \(m["kind"]!)")
            }
            // our sealer produces the same plaintext
            XCTAssertEqual(PairMessage.plaintext(from: parsed.from, body: parsed.body), b(m["plaintext"]))
        }
    }

    func pdInput(_ i: J) -> PairDecide.Input {
        var entry: PairDecide.Entry? = nil
        if let e = i["entry"] as? J {
            entry = PairDecide.Entry(role: PairDecide.Role(rawValue: str(e["role"]))!, state: PairDecide.State(rawValue: str(e["state"]))!,
                                     cN: e["c_N"].map { b($0) }, replyAuthorized: (e["reply_authorized"] as? Bool) ?? false)
        }
        return PairDecide.Input(ownId: PeerId(text: str(i["own_id"]))!, fromId: PeerId(text: str(i["from_id"]))!,
                                commitCN: b(i["commit_c_N"]), entry: entry, pinned: i["pinned"] as! Bool,
                                approved: i["approved"] as! Bool, approveVerified: i["approve_verified"] as! Bool,
                                approvesMe: i["approves_me"] as? Bool, getAfterVerify: i["get_after_verify"] as! Bool,
                                listed: PairDecide.Listed(rawValue: str(i["listed"]))!, openEntries: Int(i64(i["open_entries"])),
                                cap: (i["cap"] as! [NSNumber]).map { $0.int64Value }, now: i64(i["now"]))
    }

    func testPairDecide() {
        let cs = cases("pair_decide")
        XCTAssertEqual(cs.count, 28)
        for c in cs {
            let o = PairDecide.decide(pdInput(c["input"] as! J))
            let e = c["output"] as! J
            let name = str(c["name"])
            XCTAssertEqual(o.action.rawValue, str(e["action"]), name)
            XCTAssertEqual(o.notice.rawValue, str(e["notice"]), name)
            XCTAssertEqual(o.entry.rawValue, str(e["entry"]), name)
            XCTAssertEqual(o.capCounted, e["cap_counted"] as! Bool, name)
        }
    }

    func testPairTimeout() {
        for c in cases("pair_timeout") {
            let i = c["input"] as! J
            let r = isNull(i["resend"]) ? nil : PairDecide.Resend(rawValue: str(i["resend"]))!
            XCTAssertEqual(PairDecide.timeout(approveVerified: i["approve_verified"] as! Bool, approved: i["approved"] as! Bool,
                                              resend: r).rawValue, str(c["output"]), str(c["name"]))
        }
    }

    func testPairHint() {
        for c in cases("pair_hint") {
            let i = c["input"] as! J
            let h = PairDecide.hint(approvesMe: i["approves_me"] as? Bool, committedSeconds: i64(i["committed_s"]))
            XCTAssertEqual(h?.rawValue, c["output"] as? String, str(c["name"]))
        }
    }

    // MARK: request signing, name entries

    func testRequestSig() {
        for c in cases("request_sig") {
            let body = b(c["body"])
            let sb = RequestSigning.signedBytes(method: str(c["method"]), path: str(c["path"]), paTime: str(c["pa_time"]), body: body)
            XCTAssertEqual(sb, b(c["signed_bytes"]), str(c["name"]))
            XCTAssertTrue(RequestSigning.verify(method: str(c["method"]), path: str(c["path"]), paTime: str(c["pa_time"]),
                                                body: body, sig: b(c["sig"]), signPub: b(c["sign_pub"])), str(c["name"]))
        }
    }

    func testNameEntries() throws {
        for c in cases("name_entries") {
            let owner = pid(str(c["owner"])), rec = pid(str(c["recipient"]))
            let pairing = b(c["pairing_id"])
            XCTAssertEqual(NameEntry.signedBytes(owner: owner, recipient: rec, pairingId: pairing, n: u64(c["n"]),
                                                 nameB64: str(c["name_b64"])), Data(str(c["signed_string"]).utf8))
            let raw = try decryptor(str(c["recipient"])).hpkeOpen(wire: b(c["ciphertext"]), info: NameEntry.info,
                                                                  aad: Bytes.ascii(rec.text))
            XCTAssertEqual(String(decoding: raw, as: UTF8.self), str(c["entry_json"]))
            let f = NameEntry.open(str(c["ciphertext"]), me: rec, key: decryptor(str(c["recipient"])))!
            XCTAssertEqual(f.json, str(c["entry_json"]))
            let v = NameEntry.openVerified(str(c["ciphertext"]), me: rec, key: decryptor(str(c["recipient"])), owner: owner,
                                           ownerSignPub: b(peer(str(c["owner"]))["sign_pub"]), pairingId: pairing)
            XCTAssertEqual(v?.name, str(c["name_text"]))
            XCTAssertEqual(v?.n, u64(c["n"]))
            XCTAssertTrue(NameEntry.isValidName(str(c["name_text"])))
        }
    }

    // MARK: messages

    func pinState(_ p: Any?) -> PinState? {
        guard let p = p as? J else { return nil }
        return PinState(id: PeerId(text: str(p["id"]))!, signPub: b(p["sign_pub"]), encPub: b(p["enc_pub"]),
                        pairingId: b(p["pairing_id"]), ruling: PeerState(rawValue: str(p["ruling"]))!)
    }

    func runPipeline(_ c: J) -> ReceivePipeline.Result {
        let me = pid(str(c["receiver"]))
        let pin = pinState(c["pin"])
        let w = c["window"] as! J
        let window = ReplayWindow(h: u64(w["h"]), seen: (w["seen"] as! [NSNumber]).map { $0.uint64Value })
        let hist = Set((c["history"] as! [NSNumber]).map { $0.uint64Value })
        return ReceivePipeline.run(m: str(c["message"]), me: me, key: decryptor(str(c["receiver"])),
                                   pin: { id in pin?.id == id ? pin : nil }, window: { _ in window },
                                   hasHistory: { _, n in hist.contains(n) })
    }

    func checkMessageCase(_ c: J) throws {
        let name = str(c["name"])
        let me = pid(str(c["receiver"]))
        let plain = try decryptor(str(c["receiver"])).hpkeOpen(wire: b(c["message"]), info: InnerMessage.info, aad: Bytes.ascii(me.text))
        XCTAssertEqual(plain, b(c["plaintext"]), name)
        let sp = try InnerMessage.split(plain)
        XCTAssertEqual(InnerMessage.signedBytes(recipient: me, tail: sp.tail), b(c["signed_bytes"]), name)
        XCTAssertEqual(sp.sig, b(c["sig"]))
        XCTAssertTrue(Signatures.verify(sp.sig, data: b(c["signed_bytes"]), publicKey: b(peer(str(c["from"]))["sign_pub"])), name)
        XCTAssertEqual(sp.deflated, b(c["deflated"]), name)
        XCTAssertEqual(String(decoding: try Deflate.inflateRaw(sp.deflated), as: UTF8.self), str(c["json"]), name)
        let r = runPipeline(c)
        let e = c["expect"] as! J
        XCTAssertEqual(str(e["outcome"]), "accept")
        XCTAssertEqual(r.outcome, .accept, name)
        XCTAssertEqual(r.verifiedFrom, pid(str(c["from"])))
        guard let j = r.json else { return XCTFail(name) }
        XCTAssertEqual(j.n, u64(e["n"]), name)
        XCTAssertEqual(j.content.typeKey, str(e["type"]), name)
        switch j.content {
        case .url(let s), .text(let s), .tel(let s), .remove(let s): XCTAssertEqual(s, str(e["value"]), name)
        case .approve(let f), .rename(let f):
            let v = e["value"] as! J
            XCTAssertEqual(r.name, str(v["name"]), name)
            XCTAssertEqual(f.n, u64(v["n"]), name)
        case .deny, .delete, .pause, .unpause: XCTAssertEqual(i64(e["value"]), 1, name)
        }
        XCTAssertEqual(r.windowAfter?.h, max(u64((c["window"] as! J)["h"]), j.n))
        // our sealer: a fresh seal of the same json lands in the same bucket and opens the same way
        let x = peer(str(c["from"]))
        let signer = SoftwareSigner(key: try P256.Signing.PrivateKey(rawRepresentation: b(x["sign_priv"])))
        let keys: (Data, Data)? = j.content.typeKey == "approve" ? (b(x["sign_pub"]), b(x["enc_pub"])) : nil
        let m2 = try InnerMessage.seal(j, signer: signer, from: pid(str(c["from"])), to: me, toEncPub: b(peer(str(c["receiver"]))["enc_pub"]),
                                       pairingId: sp.pairingId, keys: keys)
        XCTAssertEqual(m2.count, str(c["message"]).count, name)
        var c2 = c
        c2["message"] = m2
        XCTAssertEqual(runPipeline(c2).outcome, .accept, name)
    }

    func testMessages() throws {
        let cs = cases("messages")
        XCTAssertEqual(cs.count, 10)
        for c in cs {
            try checkMessageCase(c)
            XCTAssertEqual(str(c["message"]).count, Int(i64(c["wire_chars"])))
        }
    }

    func testPaddedMessages() throws {
        let cs = cases("padded_messages")
        XCTAssertEqual(cs.count, 4)
        for c in cs {
            try checkMessageCase(c)
            XCTAssertEqual(str(c["message"]).count, Int(i64(c["bucket"])), str(c["name"]))
        }
    }

    func testPadding() throws {
        for c in cases("padding") {
            let pl = Int(i64(c["plaintext_len"]))
            let chars = B64URL.encodedLength(pl + 81)
            XCTAssertEqual(chars, Int(i64(c["unpadded_chars"])))
            let bucket = InnerMessage.bucket(unpaddedChars: chars)
            if isNull(c["bucket"]) {
                XCTAssertNil(bucket)
                XCTAssertThrowsError(try InnerMessage.paddedPlaintextLength(minPlaintext: pl, approve: false))
            } else {
                XCTAssertEqual(bucket, Int(i64(c["bucket"])))
                XCTAssertEqual(try InnerMessage.paddedPlaintextLength(minPlaintext: pl, approve: false), Int(i64(c["padded_plaintext_len"])))
            }
        }
    }

    func testContentCap() throws {
        for c in cases("content_cap") {
            let s = str(c["input"])
            XCTAssertEqual(SizeCap.count(s), Int(i64(c["utf8_bytes"])))
            XCTAssertEqual(!SizeCap.isOver(s), c["ok"] as! Bool)
            XCTAssertEqual(SizeCap.truncated(s), str(c["truncated"]))
            // receivers drop decoded content over 2048 bytes
            let j = InnerJSON(n: 1, content: .text(s)).encode()
            XCTAssertEqual((try? InnerJSON.parse(j)) != nil, c["ok"] as! Bool)
        }
    }

    func testInflate() {
        for c in cases("inflate") {
            let r = try? Deflate.inflateRaw(b(c["deflated"]))
            XCTAssertEqual(r != nil, c["ok"] as! Bool, str(c["name"]))
            guard let out = r else { continue }
            XCTAssertEqual(out.count, Int(i64(c["inflated_len"])))
            XCTAssertEqual(B64URL.encode(Bytes.sha256(out)), str(c["inflated_sha256"]))
            if !isNull(c["inflated"]) { XCTAssertEqual(out, b(c["inflated"])) }
        }
    }

    func testReplayWindow() {
        for c in cases("replay_window") {
            let s = c["state"] as! J, a = c["state_after"] as! J
            var w = ReplayWindow(h: u64(s["h"]), seen: (s["seen"] as! [NSNumber]).map { $0.uint64Value })
            XCTAssertEqual(w.seen, (s["seen"] as! [NSNumber]).map { $0.uint64Value })
            let n = u64(c["n"])
            let control = !["url", "text", "tel"].contains(str(c["type"]))
            let o = w.outcome(n, control: control, hasHistory: c["history_row"] as! Bool)
            XCTAssertEqual(o.rawValue, str(c["outcome"]), str(c["name"]))
            if o == .accept { w.accept(n) }
            XCTAssertEqual(w.h, u64(a["h"]), str(c["name"]))
            XCTAssertEqual(w.seen, (a["seen"] as! [NSNumber]).map { $0.uint64Value }, str(c["name"]))
        }
    }

    func testURLParse() {
        for c in cases("url_parse") {
            let p = URLRule.parse(str(c["input"]))
            XCTAssertEqual(p != nil, c["url"] as! Bool, str(c["input"]))
            if let p = p {
                XCTAssertEqual(p.href, str(c["href"]), str(c["input"]))
                XCTAssertEqual(p.host, str(c["host"]), str(c["input"]))
            }
        }
    }

    func testPhone() {
        for c in cases("phone") {
            XCTAssertEqual(PhoneDetection.isPhone(str(c["input"])), c["phone"] as! Bool, str(c["input"]))
        }
    }

    // MARK: must_fail

    func testMustFail() throws {
        var kinds: [String: Int] = [:]
        for c in cases("must_fail") {
            let name = str(c["name"]), outcome = str(c["outcome"])
            kinds[str(c["kind"]), default: 0] += 1
            switch str(c["kind"]) {
            case "message":
                let r = runPipeline(c)
                let got: String
                switch r.outcome {
                case .invalid: got = "invalid"
                case .unreadable: got = "unreadable"
                default: got = "accepted:\(r.outcome)"
                }
                XCTAssertEqual(got, outcome, name)
            case "pair":
                XCTAssertEqual(outcome, "unreadable")
                let me = pid(str(c["receiver"]))
                var ok = false
                if let p = try? PairMessage.open(str(c["message"]), me: me, key: decryptor(str(c["receiver"]))),
                   p.body.kind == kindFrom(str(c["expected_kind"])) {
                    ok = true
                    if case .open(let s, let e, let rN) = p.body {
                        ok = PairingCrypto.commit(signPubN: s, encPubN: e, rN: rN) == b(c["stored_c_N"])
                    }
                }
                XCTAssertFalse(ok, name)
            case "name_entry":
                XCTAssertEqual(outcome, "unreadable")
                let pin = pinState(c["pin"])!
                let me = pid(str(c["receiver"]))
                let v = NameEntry.openVerified(str(c["ciphertext"]), me: me, key: decryptor(str(c["receiver"])),
                                               owner: pid(str(c["owner"])), ownerSignPub: pin.signPub, pairingId: pin.pairingId)
                XCTAssertNil(v, name)
            case "request":
                XCTAssertEqual(outcome, "unreadable")
                XCTAssertFalse(RequestSigning.verify(method: str(c["method"]), path: str(c["path"]), paTime: str(c["pa_time"]),
                                                     body: b(c["body"]), sig: b(c["sig"]), signPub: b(c["sign_pub"])), name)
            case "peer_entry":
                XCTAssertEqual(outcome, "unreadable")
                let acct = pid(str(c["receiver"])).account
                XCTAssertNil(PeerEntryCheck.valid(id: str(c["id"]), signPub: str(c["sign_pub"]), encPub: str(c["enc_pub"]), myAccount: acct), name)
            default:
                XCTFail("unknown kind \(name)")
            }
        }
        XCTAssertEqual(Set(kinds.keys), ["message", "pair", "name_entry", "request", "peer_entry"])
        // every listed peer passes the same check
        let acct = pid("N").account
        for n in ["N", "X", "O"] {
            XCTAssertNotNil(PeerEntryCheck.valid(id: str(peer(n)["id"]), signPub: str(peer(n)["sign_pub"]),
                                                 encPub: str(peer(n)["enc_pub"]), myAccount: acct))
        }
    }

    func kindFrom(_ s: String) -> PairMessage.Kind {
        ["commit": .commit, "reply": .reply, "open": .open][s]!
    }

    // MARK: RFC 9180 (suite vector incl. DeriveKeyPair and key schedule)

    func testRFC9180() throws {
        let v = section("rfc9180")
        func h(_ k: String) -> Data { hex(v[k] as! String) }
        XCTAssertEqual(i64(v["kem_id"]), 16); XCTAssertEqual(i64(v["kdf_id"]), 1); XCTAssertEqual(i64(v["aead_id"]), 2)
        XCTAssertEqual(i64(v["mode"]), 0)
        // DeriveKeyPair
        XCTAssertEqual(HPKERef.deriveKeyPair(ikm: h("ikmE")), h("skEm"))
        XCTAssertEqual(HPKERef.deriveKeyPair(ikm: h("ikmR")), h("skRm"))
        let skE = try P256.KeyAgreement.PrivateKey(rawRepresentation: h("skEm"))
        let skR = try P256.KeyAgreement.PrivateKey(rawRepresentation: h("skRm"))
        XCTAssertEqual(skE.publicKey.x963Representation, h("pkEm"))
        XCTAssertEqual(skR.publicKey.x963Representation, h("pkRm"))
        XCTAssertEqual(h("enc"), h("pkEm"))
        // Encap shared secret and key schedule
        let ss = try HPKERef.sharedSecret(skE: skE, pkR: skR.publicKey)
        XCTAssertEqual(ss, h("shared_secret"))
        let ks = HPKERef.keySchedule(sharedSecret: ss, info: h("info"))
        XCTAssertEqual(ks.context, h("key_schedule_context"))
        XCTAssertEqual(ks.secret, h("secret"))
        XCTAssertEqual(ks.key, h("key"))
        XCTAssertEqual(ks.baseNonce, h("base_nonce"))
        XCTAssertEqual(ks.exporterSecret, h("exporter_secret"))
        let encs = v["encryptions"] as! [J]
        let e0 = encs[0]
        XCTAssertEqual(hex(e0["nonce"] as! String), ks.baseNonce)
        // seal at sequence 0 == ct
        let sealed = try AES.GCM.seal(hex(e0["pt"] as! String), using: SymmetricKey(data: ks.key),
                                      nonce: AES.GCM.Nonce(data: ks.baseNonce), authenticating: hex(e0["aad"] as! String))
        XCTAssertEqual(sealed.ciphertext + sealed.tag, hex(e0["ct"] as! String))
        // production open (CryptoKit HPKE through HPKEWire)
        XCTAssertEqual(try HPKEWire.open(h("enc") + hex(e0["ct"] as! String), key: skR, info: h("info"), aad: hex(e0["aad"] as! String)),
                       hex(e0["pt"] as! String))
    }

    // MARK: RFC 8291 (web push; not used by the iPhone, checked with CryptoKit primitives)

    func testRFC8291() throws {
        let v = section("rfc8291")
        func d(_ k: String) -> Data { b(v[k]) }
        let asKey = try P256.KeyAgreement.PrivateKey(rawRepresentation: d("as_private"))
        let uaKey = try P256.KeyAgreement.PrivateKey(rawRepresentation: d("ua_private"))
        XCTAssertEqual(asKey.publicKey.x963Representation, d("as_public"))
        XCTAssertEqual(uaKey.publicKey.x963Representation, d("ua_public"))
        let ecdh = try uaKey.sharedSecretFromKeyAgreement(with: asKey.publicKey).withUnsafeBytes { Data($0) }
        XCTAssertEqual(ecdh, d("ecdh_secret"))
        let keyInfo = Data("WebPush: info".utf8) + Data([0]) + d("ua_public") + d("as_public")
        XCTAssertEqual(keyInfo, d("key_info"))
        let prkKey = hmac(d("auth_secret"), ecdh)
        XCTAssertEqual(prkKey, d("prk_key"))
        let ikm = hmac(prkKey, keyInfo + Data([1]))
        XCTAssertEqual(ikm, d("ikm"))
        let prk = hmac(d("salt"), ikm)
        XCTAssertEqual(prk, d("prk"))
        let cekInfo = Data("Content-Encoding: aes128gcm".utf8) + Data([0])
        XCTAssertEqual(cekInfo, d("cek_info"))
        let cek = hmac(prk, cekInfo + Data([1])).prefix(16)
        XCTAssertEqual(cek, d("cek"))
        let nonceInfo = Data("Content-Encoding: nonce".utf8) + Data([0])
        XCTAssertEqual(nonceInfo, d("nonce_info"))
        let nonce = hmac(prk, nonceInfo + Data([1])).prefix(12)
        XCTAssertEqual(nonce, d("nonce"))
        let rs = UInt32((v["record_size"] as! NSNumber).uint32Value)
        let header = d("salt") + Data([UInt8(rs >> 24), UInt8(rs >> 16 & 0xff), UInt8(rs >> 8 & 0xff), UInt8(rs & 0xff)])
            + Data([65]) + d("as_public")
        XCTAssertEqual(header, d("header"))
        XCTAssertEqual(d("body"), header + d("ciphertext"))
        let ct = d("ciphertext")
        let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: nonce), ciphertext: ct.dropLast(16), tag: ct.suffix(16))
        let padded = try AES.GCM.open(box, using: SymmetricKey(data: cek))
        XCTAssertEqual(padded, d("padded_plaintext"))
        var pt = padded
        while pt.last == 0 { pt.removeLast() }
        XCTAssertEqual(pt.last, 2)
        pt.removeLast()
        XCTAssertEqual(pt, d("plaintext"))
    }
}

/// RFC 9180 internals for the suite vector (DeriveKeyPair, Encap shared secret, key
/// schedule), built from HMAC-SHA256 only. Test code; production uses CryptoKit HPKE.
enum HPKERef {
    static let kemSuite = Data("KEM".utf8) + Data([0x00, 0x10])
    static let hpkeSuite = Data("HPKE".utf8) + Data([0x00, 0x10, 0x00, 0x01, 0x00, 0x02])

    static func extract(salt: Data, ikm: Data) -> Data {
        Data(HMAC<SHA256>.authenticationCode(for: ikm, using: SymmetricKey(data: salt.isEmpty ? Data(count: 32) : salt)))
    }

    static func expand(prk: Data, info: Data, length: Int) -> Data {
        var out = Data(), t = Data()
        var i: UInt8 = 1
        while out.count < length {
            t = Data(HMAC<SHA256>.authenticationCode(for: t + info + Data([i]), using: SymmetricKey(data: prk)))
            out += t
            i += 1
        }
        return out.prefix(length)
    }

    static func labeledExtract(_ suite: Data, salt: Data, label: String, ikm: Data) -> Data {
        extract(salt: salt, ikm: Data("HPKE-v1".utf8) + suite + Data(label.utf8) + ikm)
    }

    static func labeledExpand(_ suite: Data, prk: Data, label: String, info: Data, length: Int) -> Data {
        expand(prk: prk, info: Data([UInt8(length >> 8), UInt8(length & 0xff)]) + Data("HPKE-v1".utf8) + suite + Data(label.utf8) + info,
               length: length)
    }

    static let order = Bytes.fromHex("ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551")!

    static func deriveKeyPair(ikm: Data) -> Data? {
        let prk = labeledExtract(kemSuite, salt: Data(), label: "dkp_prk", ikm: ikm)
        for counter in 0 ... 255 {
            let c = labeledExpand(kemSuite, prk: prk, label: "candidate", info: Data([UInt8(counter)]), length: 32)
            if c != Data(count: 32) && Ids.idLess(c, order) { return c }
        }
        return nil
    }

    static func sharedSecret(skE: P256.KeyAgreement.PrivateKey, pkR: P256.KeyAgreement.PublicKey) throws -> Data {
        let dh = try skE.sharedSecretFromKeyAgreement(with: pkR).withUnsafeBytes { Data($0) }
        let kemContext = skE.publicKey.x963Representation + pkR.x963Representation
        let eae = labeledExtract(kemSuite, salt: Data(), label: "eae_prk", ikm: dh)
        return labeledExpand(kemSuite, prk: eae, label: "shared_secret", info: kemContext, length: 32)
    }

    struct KS { let context, secret, key, baseNonce, exporterSecret: Data }

    static func keySchedule(sharedSecret: Data, info: Data) -> KS {
        let pskIdHash = labeledExtract(hpkeSuite, salt: Data(), label: "psk_id_hash", ikm: Data())
        let infoHash = labeledExtract(hpkeSuite, salt: Data(), label: "info_hash", ikm: info)
        let ctx = Data([0]) + pskIdHash + infoHash
        let secret = labeledExtract(hpkeSuite, salt: sharedSecret, label: "secret", ikm: Data())
        return KS(context: ctx, secret: secret,
                  key: labeledExpand(hpkeSuite, prk: secret, label: "key", info: ctx, length: 32),
                  baseNonce: labeledExpand(hpkeSuite, prk: secret, label: "base_nonce", info: ctx, length: 12),
                  exporterSecret: labeledExpand(hpkeSuite, prk: secret, label: "exp", info: ctx, length: 32))
    }
}
