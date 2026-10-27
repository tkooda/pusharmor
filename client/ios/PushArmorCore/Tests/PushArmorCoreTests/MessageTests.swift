import XCTest
@testable import PushArmorCore

final class MessageTests: XCTestCase {
    let pid = Data([1, 2, 3, 4, 5, 6, 7, 8])

    func testInnerJSONEncodeParse() throws {
        let j = InnerJSON(n: 42, content: .url("https://example.com/a"))
        XCTAssertEqual(String(decoding: j.encode(), as: UTF8.self), "{\"n\":42,\"url\":\"https://example.com/a\"}")
        XCTAssertEqual(try InnerJSON.parse(j.encode()), j)
        let f = NameField(name: "UGhvbmU", n: 3, s: "abc")
        for c: MessageContent in [.text("a\"b\n"), .tel("+1 555"), .approve(f), .rename(f), .deny, .delete, .pause,
                                   .unpause, .remove("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwd")] {
            let x = InnerJSON(n: 3, content: c)
            XCTAssertEqual(try InnerJSON.parse(x.encode()), x)
        }
        XCTAssertEqual(try InnerJSON.parse(Data("{ \"url\" : \"x\", \"n\" : 7 }".utf8)), InnerJSON(n: 7, content: .url("x")))
    }

    func testInnerJSONRejects() {
        let bad = [
            "{\"n\":1.0,\"url\":\"x\"}", "{\"n\":1e0,\"url\":\"x\"}", "{\"n\":0,\"url\":\"x\"}", "{\"n\":-1,\"url\":\"x\"}",
            "{\"n\":\"1\",\"url\":\"x\"}", "{\"n\":9007199254740992,\"url\":\"x\"}", "{\"n\":1,\"n\":2,\"url\":\"x\"}",
            "{\"n\":1,\"url\":\"x\",\"url\":\"y\"}", "{\"n\":1}", "{\"n\":1,\"url\":\"x\",\"text\":\"y\"}",
            "{\"n\":1,\"url\":\"x\",\"t\":5}", "{\"n\":1,\"foo\":\"x\"}", "{\"url\":\"x\"}", "{\"n\":1,\"url\":5}",
            "{\"n\":1,\"deny\":2}", "{\"n\":1,\"deny\":true}", "{\"n\":1,\"pause\":1.0}",
            "{\"n\":1,\"approve\":{\"name\":\"x\",\"n\":1}}", "{\"n\":1,\"approve\":{\"name\":\"x\",\"n\":1,\"s\":\"y\",\"z\":1}}",
            "{\"n\":1,\"rename\":{\"name\":\"x\",\"n\":0,\"s\":\"y\"}}", "[1]", "",
        ]
        for b in bad { XCTAssertThrowsError(try InnerJSON.parse(Data(b.utf8)), b) }
        let long = "{\"n\":1,\"text\":\"" + String(repeating: "a", count: 2049) + "\"}"
        XCTAssertThrowsError(try InnerJSON.parse(Data(long.utf8)))
        let ok = "{\"n\":1,\"text\":\"" + String(repeating: "a", count: 2048) + "\"}"
        XCTAssertNoThrow(try InnerJSON.parse(Data(ok.utf8)))
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
        for c: MessageContent in [.text("hi"), .tel("+1 555-123-4567"), .deny, .remove("x"), .rename(f), .delete, .pause, .unpause] {
            let (m, _) = try roundTrip(InnerJSON(n: 9, content: c))
            XCTAssertEqual(m.count, 512)
        }
        var g = SystemRandomNumberGenerator()
        let noisy = String((0 ..< 900).map { _ in Character(Unicode.Scalar(UInt8.random(in: 0x21 ... 0x7e, using: &g))) })
        let (m3, _) = try roundTrip(InnerJSON(n: 5, content: .text(noisy)))
        XCTAssertEqual(m3.count, 2048)
        let noisy2 = String((0 ..< 2048).map { _ in Character(Unicode.Scalar(UInt8.random(in: 0x21 ... 0x7e, using: &g))) })
        let (m4, _) = try roundTrip(InnerJSON(n: 5, content: .text(noisy2)))
        XCTAssertEqual(m4.count, 3800)
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
