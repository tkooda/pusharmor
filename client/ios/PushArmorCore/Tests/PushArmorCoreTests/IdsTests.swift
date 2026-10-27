import XCTest
@testable import PushArmorCore

/// Known answers computed independently (Python hashlib) for fixed inputs.
final class IdsTests: XCTestCase {
    let sp = Data([4] + (1 ... 64).map { UInt8($0) })
    let ep = Data([4] + (65 ... 128).map { UInt8($0) })
    let rN = Data(repeating: 0xa5, count: 32)
    let rX = Data((0 ..< 32).map { UInt8($0) })
    let idN = PeerId(raw: Data((0 ..< 30).map { UInt8($0) }))!
    let idX = PeerId(raw: Data((100 ..< 130).map { UInt8($0) }))!

    func testKeyhash() {
        XCTAssertEqual(Bytes.hex(Ids.keyhash(signPub: sp, encPub: ep)), "ae4e606e8fadc4a6ff4bf78f")
    }

    func testPeerIdText() {
        XCTAssertEqual(idN.text, "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwd")
        XCTAssertEqual(idX.text, "ZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXp7fH1-f4CB")
        XCTAssertEqual(PeerId(text: idX.text), idX)
        XCTAssertNil(PeerId(text: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxw"))
        XCTAssertNil(PeerId(text: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxw="))
        XCTAssertEqual(idN.account, Data((0 ..< 9).map { UInt8($0) }))
        XCTAssertEqual(idN.keyhash, Data((9 ..< 21).map { UInt8($0) }))
    }

    func testIdMatchesKeys() {
        let id = testId(account: Data(count: 9), signPub: sp, encPub: ep)
        XCTAssertTrue(id.matches(signPub: sp, encPub: ep))
        XCTAssertFalse(id.matches(signPub: ep, encPub: sp))
    }

    func testIdOrderUnsigned() {
        let a = PeerId(raw: Data([0x7f] + [UInt8](repeating: 0, count: 29)))!
        let b = PeerId(raw: Data([0x80] + [UInt8](repeating: 0, count: 29)))!
        XCTAssertTrue(a < b)
        XCTAssertFalse(b < a)
        let c = PeerId(raw: Data([UInt8](repeating: 1, count: 29) + [0xff]))!
        let d = PeerId(raw: Data([UInt8](repeating: 1, count: 29) + [0x00]))!
        XCTAssertTrue(d < c)
        XCTAssertFalse(c < c)
    }

    func testPairingHashes() {
        XCTAssertEqual(Bytes.hex(PairingCrypto.commit(signPubN: sp, encPubN: ep, rN: rN)),
                       "1e75735d5877f2fd41bca1483f021881f511a055a9355e0bd54aa1f2e6b2e0c7")
        XCTAssertEqual(PairingCrypto.fingerprint(signPubN: sp, encPubN: ep, signPubX: ep, encPubX: sp, rN: rN, rX: rX), "V1GM")
        XCTAssertEqual(Bytes.hex(PairingCrypto.pairingId(rN: rN, rX: rX)), "0e62cf08bcfdcef3")
        XCTAssertEqual(PairingCrypto.pairingKey(nId: idN, xId: idX), "2-kFchE8MV_V4nx88GD7Qg")
        XCTAssertEqual(PairingCrypto.randomR().count, 32)
        XCTAssertNotEqual(PairingCrypto.randomR(), PairingCrypto.randomR())
    }

    func testOAuthNonceEmailPush() {
        XCTAssertEqual(Ids.k(signPub: sp), "DtOmq5V_9vWaljCkc9MafQT8tGVIuJAWGWmAx-llhPY")
        XCTAssertEqual(Ids.oauthNonce(purpose: "register", signPub: sp), "9Z9tiT7-8oZ6D0-nop4OsnXp9RC-IROrCbLqDqjEPws")
        XCTAssertEqual(Ids.normalizeEmail("  Alice@Example.COM\t"), "alice@example.com")
        XCTAssertNil(Ids.normalizeEmail("b\u{00f6}b@example.com"))
        XCTAssertEqual(Ids.normalizeEmail("\u{212A}@x.com"), nil) // Kelvin sign is not ASCII
        XCTAssertEqual(Bytes.hex(Ids.emailHash(normalized: "alice@example.com")),
                       "7624c6701ef8ac176f1be6cbf31344b7910c7fdaa9d33c8ae3d8e5cec24936bb")
        let push = PushInfo(type: .apns, tokenBytes: Data([0x00, 0xff, 0x10, 0xab]))
        XCTAssertEqual(push.token, "00ff10ab")
        XCTAssertEqual(Ids.pushSha256(push), "g2yVfdj0WC52Qi5YlkgzDA")
        XCTAssertEqual(PushInfo(type: .apnsSandbox, token: "ab").hashString, "apns-sandbox\nab")
    }
}
