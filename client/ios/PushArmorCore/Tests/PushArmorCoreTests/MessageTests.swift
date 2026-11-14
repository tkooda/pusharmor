import XCTest
@testable import PushArmorCore

final class MessageTests: XCTestCase {
    let pid = Data([1, 2, 3, 4, 5, 6, 7, 8])

    func testInnerJSONEncodeParse() throws {
        let j = InnerJSON(n: 42, content: .url("https://example.com/a"))
        XCTAssertEqual(String(decoding: j.encode(), as: UTF8.self), "{\"n\":42,\"url\":\"https://example.com/a\"}")
        XCTAssertEqual(try InnerJSON.parse(j.encode()), j)
        let f = NameField(name: "UGhvbmU", n: 3, s: "abc")
        for c: MessageContent in [.text("a\"b\n"), .tel("+1 555"), .approve(f), .rename(f), .deny, .delete, .logout,
                                   .login, .remove("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwd")] {
            let x = InnerJSON(n: 3, content: c)
            XCTAssertEqual(try InnerJSON.parse(x.encode()), x)
        }
        XCTAssertEqual(try InnerJSON.parse(Data("{ \"url\" : \"x\", \"n\" : 7 }".utf8)), InnerJSON(n: 7, content: .url("x")))
    }

    func testInnerJSONRejects() {
        let bad = [
            "{\"n\":1.0,\"url\":\"x\"}", "{\"n\":1e0,\"url\":\"x\"}", "{\"n\":0,\"url\":\"x\"}", "{\"n\":-1,\"url\":\"x\"}",
            "{\"n\":\"1\",\"url\":\"x\"}", "{\"n\":9007199254740992,\"url\":\"x\"}", "{\"n\":1,\"n\":2,\"url\":\"x\"}",
            "{\"n\":1,\"url\":\"x\",\"url\":\"y\"}", "{\"n\":1}", "{\"n\":1,\"foo\":\"x\"}", "{\"url\":\"x\"}",
            "{\"n\":1,\"url\":5}", "{\"n\":1,\"url\":5,\"text\":\"y\"}", "{\"n\":0,\"url\":\"x\",\"z\":1}",
            "{\"n\":1,\"deny\":2}", "{\"n\":1,\"deny\":true}", "{\"n\":1,\"logout\":1.0}",
            "{\"n\":1,\"approve\":{\"name\":\"x\",\"n\":1}}", "{\"n\":1,\"approve\":{\"name\":\"x\",\"n\":1,\"z\":1}}",
            "{\"n\":1,\"url\":\"x\",\"z\":1,\"z\":2}",
            "{\"n\":1,\"rename\":{\"name\":\"x\",\"n\":0,\"s\":\"y\"}}", "[1]", "",
        ]
        for b in bad { XCTAssertThrowsError(try InnerJSON.parse(Data(b.utf8)), b) }
        let long = "{\"n\":1,\"text\":\"" + String(repeating: "a", count: 2049) + "\"}"
        XCTAssertThrowsError(try InnerJSON.parse(Data(long.utf8)))
        let ok = "{\"n\":1,\"text\":\"" + String(repeating: "a", count: 2048) + "\"}"
        XCTAssertNoThrow(try InnerJSON.parse(Data(ok.utf8)))
    }

    /// unknown keys are ignored; the first known type key in the fixed order wins.
    func testInnerJSONLenient() throws {
        let f = NameField(name: "x", n: 1, s: "y")
        let cases: [(String, MessageContent)] = [
            ("{\"n\":1,\"url\":\"x\",\"t\":5}", .url("x")),
            ("{\"z\":{\"a\":[1]},\"n\":1,\"text\":\"x\"}", .text("x")),
            ("{\"n\":1,\"text\":\"y\",\"url\":\"x\"}", .url("x")),
            ("{\"n\":1,\"tel\":\"1\",\"text\":\"y\"}", .text("y")),
            ("{\"n\":1,\"deny\":1,\"tel\":\"1\"}", .tel("1")),
            ("{\"n\":1,\"logout\":1,\"deny\":1,\"future\":1}", .deny),
            ("{\"n\":1,\"url\":\"x\",\"deny\":2}", .url("x")),
            ("{\"n\":1,\"approve\":{\"name\":\"x\",\"n\":1,\"s\":\"y\",\"z\":1}}", .approve(f)),
            ("{\"n\":1,\"rename\":{\"v\":2,\"s\":\"y\",\"n\":1,\"name\":\"x\"},\"q\":0}", .rename(f)),
        ]
        for (s, c) in cases { XCTAssertEqual(try InnerJSON.parse(Data(s.utf8)), InnerJSON(n: 1, content: c), s) }
    }

    func testBuckets() throws {
        XCTAssertEqual(try InnerMessage.paddedPlaintextLength(minPlaintext: 100, approve: false), 303)
        XCTAssertEqual(try InnerMessage.paddedPlaintextLength(minPlaintext: 303, approve: false), 303)
        XCTAssertEqual(try InnerMessage.paddedPlaintextLength(minPlaintext: 304, approve: false), 687)
        XCTAssertEqual(try InnerMessage.paddedPlaintextLength(minPlaintext: 100, approve: true), 687)
        XCTAssertEqual(try InnerMessage.paddedPlaintextLength(minPlaintext: 688, approve: false), 1455)
        XCTAssertEqual(try InnerMessage.paddedPlaintextLength(minPlaintext: 2769, approve: false), 2769)
        XCTAssertThrowsError(try InnerMessage.paddedPlaintextLength(minPlaintext: 2770, approve: false))
        for b in [303, 687, 1455, 2769] {
            XCTAssertEqual(B64URL.encodedLength(81 + b), [303: 512, 687: 1024, 1455: 2048, 2769: 3800][b])
        }
    }

    func roundTrip(_ j: InnerJSON, keys: Bool = false) throws -> (String, InnerMessage.Split) {
        let a = TestPeer(), b = TestPeer()
        let m = try InnerMessage.seal(j, signer: a.signer, from: a.id, to: b.id, toEncPub: b.encPub, pairingId: pid,
                                      keys: keys ? (a.signPub, a.encPub) : nil)
        let p = try InnerMessage.open(m, me: b.id, key: b.decryptor)
        let s = try InnerMessage.split(p)
        XCTAssertEqual(s.from, a.id)
        XCTAssertEqual(s.pairingId, pid)
        XCTAssertTrue(Signatures.verify(s.sig, data: InnerMessage.signedBytes(recipient: b.id, tail: s.tail), publicKey: a.signPub))
        XCTAssertFalse(Signatures.verify(s.sig, data: InnerMessage.signedBytes(recipient: a.id, tail: s.tail), publicKey: a.signPub))
        XCTAssertEqual(try InnerJSON.parse(try Deflate.inflateRaw(s.deflated)), j)
        if keys {
            XCTAssertEqual(s.keys?.signPub, a.signPub)
            XCTAssertEqual(s.keys?.encPub, a.encPub)
        } else {
            XCTAssertNil(s.keys)
        }
        // wrong recipient cannot open
        XCTAssertThrowsError(try InnerMessage.open(m, me: a.id, key: a.decryptor))
        return (m, s)
    }

    func testSealOpenEveryTypeAndBucket() throws {
        let (m1, _) = try roundTrip(InnerJSON(n: 1, content: .url("https://example.com/a")))
        XCTAssertEqual(m1.count, 512)
        let f = NameField(name: "UGhvbmU", n: 1, s: String(repeating: "A", count: 86))
        let (m2, _) = try roundTrip(InnerJSON(n: 1, content: .approve(f)), keys: true)
        XCTAssertEqual(m2.count, 1024)
        for c: MessageContent in [.text("hi"), .tel("+1 555-123-4567"), .deny, .remove("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwd"), .rename(f), .delete, .logout, .login] {
            let (m, _) = try roundTrip(InnerJSON(n: 9, content: c))
            XCTAssertEqual(m.count, 512)
        }
        var g = SystemRandomNumberGenerator()
        let noisy = String((0 ..< 900).map { _ in Character(Unicode.Scalar(UInt8.random(in: 0x21 ... 0x7e, using: &g))) })
        let (m3, _) = try roundTrip(InnerJSON(n: 5, content: .text(noisy)))
        XCTAssertEqual(m3.count, 2048)
        let noisy2 = String((0 ..< SizeCap.bytes).map { _ in Character(Unicode.Scalar(UInt8.random(in: 0x21 ... 0x7e, using: &g))) })
        let (m4, _) = try roundTrip(InnerJSON(n: 5, content: .text(noisy2)))
        XCTAssertEqual(m4.count, 3800)
        // the worst case: the longest content with a message id and the largest n still seals within 3800
        let worst = String(repeating: "\"", count: SizeCap.bytes)
        let (m5, _) = try roundTrip(InnerJSON(n: 9_007_199_254_740_991, content: .text(worst), id: InnerJSON.newId()))
        XCTAssertLessThanOrEqual(m5.count, InnerMessage.maxWire)
    }

    func testSplitRejects() throws {
        let from = TestPeer().id
        var body = try InnerMessage.paddedBody(from: from, pairingId: pid, keys: nil, deflated: Data([1, 2, 3]), approve: false)
        var p = Data(count: 64) + body
        XCTAssertNoThrow(try InnerMessage.split(p))
        p[p.count - 1] = 1
        XCTAssertThrowsError(try InnerMessage.split(p))       // nonzero padding
        body[38] = 2
        XCTAssertThrowsError(try InnerMessage.split(Data(count: 64) + body)) // keys flag
        body[38] = 0
        body[39] = 0xff
        XCTAssertThrowsError(try InnerMessage.split(Data(count: 64) + body)) // length too long
        XCTAssertThrowsError(try InnerMessage.split(Data(count: 100)))
    }

    func testNameEntry() throws {
        let a = TestPeer(), b = TestPeer()
        let f = try NameEntry.make(name: "Phone", n: 7, owner: a.id, recipient: b.id, pairingId: pid, signer: a.signer)
        XCTAssertEqual(f.name, "UGhvbmU")
        XCTAssertEqual(NameEntry.verify(f, owner: a.id, recipient: b.id, pairingId: pid, ownerSignPub: a.signPub), "Phone")
        XCTAssertNil(NameEntry.verify(f, owner: a.id, recipient: b.id, pairingId: Data(count: 8), ownerSignPub: a.signPub))
        XCTAssertNil(NameEntry.verify(NameField(name: f.name, n: 8, s: f.s), owner: a.id, recipient: b.id, pairingId: pid,
                                      ownerSignPub: a.signPub))
        let c = try NameEntry.seal(f, recipient: b.id, recipientEncPub: b.encPub)
        XCTAssertLessThanOrEqual(c.count, 1024)
        XCTAssertEqual(NameEntry.open(c, me: b.id, key: b.decryptor), f)
        XCTAssertNil(NameEntry.open(c, me: a.id, key: a.decryptor))
        // an entry with an unknown extra key still opens; a missing key does not.
        let extra = Data((String(f.json.dropLast()) + ",\"v\":2}").utf8)
        let ce = B64URL.encode(try HPKEWire.seal(extra, to: b.encPub, info: NameEntry.info, aad: Bytes.ascii(b.id.text)))
        XCTAssertEqual(NameEntry.open(ce, me: b.id, key: b.decryptor), f)
        let missing = Data(("{\"name\":" + StrictJSON.quote(f.name) + ",\"n\":7}").utf8)
        let cm = B64URL.encode(try HPKEWire.seal(missing, to: b.encPub, info: NameEntry.info, aad: Bytes.ascii(b.id.text)))
        XCTAssertNil(NameEntry.open(cm, me: b.id, key: b.decryptor))
        XCTAssertEqual(NameEntry.signedBytes(owner: PeerId(raw: Data((0 ..< 30).map { UInt8($0) }))!,
                                             recipient: PeerId(raw: Data((100 ..< 130).map { UInt8($0) }))!,
                                             pairingId: Data(count: 8), n: 7, nameB64: "UGhvbmU"),
                       Data("PA-NAME1\nAAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwd\nZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXp7fH1-f4CB\nAAAAAAAAAAA\n7\nUGhvbmU".utf8))
        XCTAssertTrue(NameEntry.isValidName("A"))
        XCTAssertTrue(NameEntry.isValidName(String(repeating: "x", count: 32)))
        XCTAssertFalse(NameEntry.isValidName(""))
        XCTAssertFalse(NameEntry.isValidName(String(repeating: "x", count: 33)))
        XCTAssertFalse(NameEntry.isValidName("a\u{e9}"))
        XCTAssertFalse(NameEntry.isValidName("a\n"))
        XCTAssertFalse(NameEntry.isValidName("a\"b"))
        XCTAssertTrue(NameEntry.isValidName("a'b"))
    }

    func testReceivedNameWithDoubleQuoteIsIgnored() throws {
        let a = TestPeer(), b = TestPeer()
        let f = try NameEntry.make(name: "My \"Phone\"", n: 3, owner: a.id, recipient: b.id, pairingId: pid, signer: a.signer)
        XCTAssertNil(NameEntry.verify(f, owner: a.id, recipient: b.id, pairingId: pid, ownerSignPub: a.signPub))
    }

    /// Sync deletions: a url, text or tel carries "id"; a control never does; a bad id is dropped.
    func testInnerJSONMessageId() throws {
        let id = InnerJSON.newId()
        XCTAssertEqual(id.count, 22)
        XCTAssertTrue(InnerJSON.isValidId(id))
        XCTAssertNotEqual(InnerJSON.newId(), id)
        let j = InnerJSON(n: 4, content: .text("hi"), id: id)
        XCTAssertEqual(String(decoding: j.encode(), as: UTF8.self), "{\"n\":4,\"text\":\"hi\",\"id\":\"" + id + "\"}")
        XCTAssertEqual(try InnerJSON.parse(j.encode()), j)
        XCTAssertEqual(try InnerJSON.parse(Data("{\"n\":1,\"url\":\"x\",\"id\":\"a-b_C9\"}".utf8)).id, "a-b_C9")
        for bad in ["\"\"", "\"a.b\"", "5", "\"" + String(repeating: "a", count: 65) + "\""] {
            XCTAssertNil(try InnerJSON.parse(Data(("{\"n\":1,\"url\":\"x\",\"id\":" + bad + "}").utf8)).id, bad)
        }
        XCTAssertNotNil(try InnerJSON.parse(Data(("{\"n\":1,\"url\":\"x\",\"id\":\"" + String(repeating: "a", count: 64) + "\"}").utf8)).id)
        XCTAssertNil(InnerJSON(n: 1, content: .logout, id: id).id)
        XCTAssertNil(try InnerJSON.parse(Data("{\"n\":1,\"logout\":1,\"id\":\"abc\"}".utf8)).id)
    }

    /// del is a known type: {"n":N,"del":[ids]}; empty, or not an array of valid ids = not readable.
    func testInnerJSONDel() throws {
        let j = InnerJSON(n: 7, content: .del(["a", "b-c"]))
        XCTAssertEqual(String(decoding: j.encode(), as: UTF8.self), "{\"n\":7,\"del\":[\"a\",\"b-c\"]}")
        XCTAssertEqual(try InnerJSON.parse(j.encode()), j)
        XCTAssertTrue(ReceivePipeline.isControl(.del(["a"])))
        for bad in ["{\"n\":1,\"del\":1}", "{\"n\":1,\"del\":\"a\"}", "{\"n\":1,\"del\":[1]}", "{\"n\":1,\"del\":[]}",
                    "{\"n\":1,\"del\":[\"a b\"]}", "{\"n\":1,\"del\":[\"\"]}", "{\"n\":1,\"del\":[\"\(String(repeating: "a", count: 65))\"]}"] {
            XCTAssertThrowsError(try InnerJSON.parse(Data(bad.utf8)), bad)
        }
        // the old account-delete key is unchanged
        XCTAssertEqual(try InnerJSON.parse(Data("{\"n\":1,\"delete\":1}".utf8)).content, .delete)
    }

    /// Many ids split over as few del messages as fit: a del filled to the max seals within
    /// 3800 characters, and one more id does not seal.
    func testDelChunksFitTheSizeCap() throws {
        let maxN: UInt64 = 9_007_199_254_740_991
        let ids = (0 ..< 400).map { _ in InnerJSON.newId() }
        let chunks = try InnerJSON.delChunks(ids)
        XCTAssertGreaterThan(chunks.count, 1)
        XCTAssertEqual(chunks.flatMap { $0 }, ids)
        let first = chunks[0]
        let (m, _) = try roundTrip(InnerJSON(n: maxN, content: .del(first)))
        XCTAssertLessThanOrEqual(m.utf8.count, InnerMessage.maxWire)
        XCTAssertThrowsError(try roundTrip(InnerJSON(n: maxN, content: .del(Array(ids.prefix(first.count + 1))))))
        for c in chunks {
            let (m, _) = try roundTrip(InnerJSON(n: maxN, content: .del(c)))
            XCTAssertLessThanOrEqual(m.utf8.count, InnerMessage.maxWire)
        }
        // received ids may be up to 64 characters: they split the same way
        let long = (0 ..< 200).map { _ in InnerJSON.newId() + InnerJSON.newId() + "abcdefghijklmnopqrst" }
        XCTAssertEqual(long[0].count, 64)
        for c in try InnerJSON.delChunks(long) {
            let (m, _) = try roundTrip(InnerJSON(n: maxN, content: .del(c)))
            XCTAssertLessThanOrEqual(m.utf8.count, InnerMessage.maxWire)
        }
        XCTAssertEqual(try InnerJSON.delChunks(["a"]), [["a"]])
        XCTAssertEqual(try InnerJSON.delChunks([]), [])
    }

    func testPairMessages() throws {
        let n = TestPeer(), x = TestPeer()
        let rN = PairingCrypto.randomR()
        let cN = PairingCrypto.commit(signPubN: n.signPub, encPubN: n.encPub, rN: rN)
        let commit = try PairMessage.seal(from: n.id, to: x.id, recipientEncPub: x.encPub, body: .commit(cN: cN))
        XCTAssertEqual(commit.count, 366)
        XCTAssertEqual(try PairMessage.open(commit, me: x.id, key: x.decryptor), .init(from: n.id, body: .commit(cN: cN)))
        let rX = PairingCrypto.randomR()
        let reply = try PairMessage.seal(from: x.id, to: n.id, recipientEncPub: n.encPub, body: .reply(signPub: x.signPub, encPub: x.encPub, r: rX))
        XCTAssertEqual(try PairMessage.open(reply, me: n.id, key: n.decryptor).body, .reply(signPub: x.signPub, encPub: x.encPub, r: rX))
        let open = try PairMessage.seal(from: n.id, to: x.id, recipientEncPub: x.encPub, body: .open(signPub: n.signPub, encPub: n.encPub, r: rN))
        guard case .open(let s, let e, let r) = try PairMessage.open(open, me: x.id, key: x.decryptor).body else { return XCTFail() }
        XCTAssertEqual(PairingCrypto.commit(signPubN: s, encPubN: e, rN: r), cN)
        // wrong recipient
        XCTAssertThrowsError(try PairMessage.open(commit, me: n.id, key: n.decryptor))
        // other account
        let other = TestPeer(account: Data(repeating: 9, count: 9))
        let c2 = try PairMessage.seal(from: other.id, to: x.id, recipientEncPub: x.encPub, body: .commit(cN: cN))
        XCTAssertThrowsError(try PairMessage.open(c2, me: x.id, key: x.decryptor))
        // keys that do not hash to the from id
        let r2 = try PairMessage.seal(from: x.id, to: n.id, recipientEncPub: n.encPub, body: .reply(signPub: n.signPub, encPub: n.encPub, r: rX))
        XCTAssertThrowsError(try PairMessage.open(r2, me: n.id, key: n.decryptor))
        // parse: nonzero commit padding, bad kind, bad length
        var p = PairMessage.plaintext(from: n.id, body: .commit(cN: cN))
        XCTAssertNoThrow(try PairMessage.parse(p, me: x.id))
        p[192] = 1
        XCTAssertThrowsError(try PairMessage.parse(p, me: x.id))
        p[192] = 0
        p[0] = 4
        XCTAssertThrowsError(try PairMessage.parse(p, me: x.id))
        XCTAssertThrowsError(try PairMessage.parse(p.prefix(192), me: x.id))
        // sign_pub equal to enc_pub
        let same = testId(account: x.id.account, signPub: x.signPub, encPub: x.signPub)
        let ps = PairMessage.plaintext(from: same, body: .reply(signPub: x.signPub, encPub: x.signPub, r: rX))
        XCTAssertThrowsError(try PairMessage.parse(ps, me: n.id))
        // wrong length on the wire
        XCTAssertThrowsError(try PairMessage.open(String(commit.dropLast()), me: x.id, key: x.decryptor))
    }
}
