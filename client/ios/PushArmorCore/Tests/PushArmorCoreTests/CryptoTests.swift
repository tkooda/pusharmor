import XCTest
@testable import PushArmorCore

final class CryptoTests: XCTestCase {
    struct HPKEFile: Decodable {
        struct Enc: Decodable { let aad, ct, nonce, pt: String }
        struct V: Decodable {
            let aead_id: Int
            let info, skRm, pkRm, enc: String
            let encryptions: [Enc]
        }
        let vectors: [V]
    }

    /// RFC 9180 test vectors (base mode, DHKEM(P-256, HKDF-SHA256), HKDF-SHA256,
    /// AES-128-GCM = A.3.1 and AES-256-GCM), open direction.
    func testRFC9180Open() throws {
        let url = Bundle.module.url(forResource: "rfc9180-p256-base", withExtension: "json", subdirectory: "Fixtures")!
        let f = try JSONDecoder().decode(HPKEFile.self, from: Data(contentsOf: url))
        XCTAssertEqual(f.vectors.count, 2)
        for v in f.vectors {
            let sk = try P256.KeyAgreement.PrivateKey(rawRepresentation: hex(v.skRm))
            XCTAssertEqual(sk.publicKey.x963Representation, hex(v.pkRm))
            let suite = HPKE.Ciphersuite(kem: .P256_HKDF_SHA256, kdf: .HKDF_SHA256,
                                         aead: v.aead_id == 1 ? .AES_GCM_128 : .AES_GCM_256)
            var r = try HPKE.Recipient(privateKey: sk, ciphersuite: suite, info: hex(v.info), encapsulatedKey: hex(v.enc))
            for e in v.encryptions {
                XCTAssertEqual(try r.open(hex(e.ct), authenticating: hex(e.aad)), hex(e.pt))
            }
            if v.aead_id == 2 {
                // our wire form (enc || ct+tag) through HPKEWire, first encryption
                let wire = hex(v.enc) + hex(v.encryptions[0].ct)
                XCTAssertEqual(try HPKEWire.open(wire, key: sk, info: hex(v.info), aad: hex(v.encryptions[0].aad)),
                               hex(v.encryptions[0].pt))
                XCTAssertEqual(try SoftwareDecryptor(raw: hex(v.skRm)).hpkeOpen(
                    wire: wire, info: hex(v.info), aad: hex(v.encryptions[0].aad)), hex(v.encryptions[0].pt))
                var bad = wire
                bad[bad.count - 1] ^= 1
                XCTAssertThrowsError(try HPKEWire.open(bad, key: sk, info: hex(v.info), aad: hex(v.encryptions[0].aad)))
                XCTAssertThrowsError(try HPKEWire.open(wire, key: sk, info: hex(v.info), aad: Data("x".utf8)))
            }
        }
    }

    func testHPKESealOpenRoundTrip() throws {
        let k = SoftwareDecryptor()
        let w = try HPKEWire.seal(Data("hi".utf8), to: k.publicKey, info: Data("PA-MSG1".utf8), aad: Data("id".utf8))
        XCTAssertEqual(w.count, 65 + 2 + 16)
        XCTAssertEqual(try k.hpkeOpen(wire: w, info: Data("PA-MSG1".utf8), aad: Data("id".utf8)), Data("hi".utf8))
        XCTAssertThrowsError(try k.hpkeOpen(wire: w, info: Data("PA-NAME1".utf8), aad: Data("id".utf8)))
        XCTAssertThrowsError(try SoftwareDecryptor().hpkeOpen(wire: w, info: Data("PA-MSG1".utf8), aad: Data("id".utf8)))
    }

    /// RFC 6979 A.2.5 (P-256, SHA-256): the key pair and the signatures for "sample" and "test".
    func testECDSAVerifyRFC6979() throws {
        let sk = try P256.Signing.PrivateKey(rawRepresentation: hex("C9AFA9D845BA75166B5C215767B1D6934E50C3DB36E89B127B8A622B120F6721"))
        let pub = hex("04" + "60FED4BA255A9D31C961EB74C6356D68C049B8923B61FA6CE669622E60F29FB6"
                      + "7903FE1008B8BC99A41AE9E95628BC64F2F1B20C2D7E9F5177A3C294D4462299")
        XCTAssertEqual(sk.publicKey.x963Representation, pub)
        let sample = hex("EFD48B2AACB6A8FD1140DD9CD45E81D69D2C877B56AAF991C34D0EA84EAF3716"
                         + "F7CB1C942D657C41D436C7A1B6E29F65F3E900DBB9AFF4064DC4AB2F843ACDA8")
        let test = hex("F1ABB023518351CD71D881567B1EA663ED3EFCF6C5132B354F28D3B0B7D38367"
                       + "019F4113742A2B14BD25926B49C649155F267E60D3814B4C0CC84250E46F0083")
        XCTAssertTrue(Signatures.verify(sample, data: Data("sample".utf8), publicKey: pub))
        XCTAssertTrue(Signatures.verify(test, data: Data("test".utf8), publicKey: pub))
        XCTAssertFalse(Signatures.verify(sample, data: Data("test".utf8), publicKey: pub))
        XCTAssertFalse(Signatures.verify(sample.prefix(63), data: Data("sample".utf8), publicKey: pub))
        // our signer output verifies
        let s = SoftwareSigner(key: sk)
        XCTAssertTrue(Signatures.verify(try s.sign(Data("x".utf8)), data: Data("x".utf8), publicKey: pub))
    }

    func testPublicKeyChecks() {
        let a = SoftwareSigner().publicKey, b = SoftwareDecryptor().publicKey
        XCTAssertTrue(PublicKeys.validPair(signPub: a, encPub: b))
        XCTAssertFalse(PublicKeys.validPair(signPub: a, encPub: a))
        XCTAssertFalse(PublicKeys.isValid(a.prefix(64)))
        var off = a
        off[64] ^= 1  // not on the curve
        XCTAssertFalse(PublicKeys.isValid(off))
        XCTAssertFalse(PublicKeys.isValid(Data([2]) + a.dropFirst().prefix(32)))
    }

    func testRequestSigning() throws {
        XCTAssertEqual(RequestSigning.signedBytes(method: "POST", path: "/v1/send", paTime: "1761300000000", body: Data("{}".utf8)),
                       Data("PA-REQ1\nPOST\n/v1/send\n1761300000000\n{}".utf8))
        XCTAssertEqual(RequestSigning.signedBytes(method: "GET", path: "/v1/peers", paTime: "1761300000000", body: Data()),
                       Data("PA-REQ1\nGET\n/v1/peers\n1761300000000\n".utf8))
        let p = TestPeer()
        let h = try RequestSigning.headers(signer: p.signer, peerId: p.id, method: "GET", path: "/v1/peers",
                                           timeMs: 1761300000123, body: Data())
        XCTAssertEqual(h["PA-Time"], "1761300000123")
        XCTAssertEqual(h["PA-ID"], p.id.text)
        let sig = B64URL.decode(h["PA-Sig"]!)!
        XCTAssertEqual(sig.count, 64)
        XCTAssertTrue(Signatures.verify(sig, data: Data("PA-REQ1\nGET\n/v1/peers\n1761300000123\n".utf8), publicKey: p.signPub))
    }
}
