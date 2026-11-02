import XCTest
@testable import PushArmorCore

final class KeyBootstrapTests: XCTestCase {
    let someId = PeerId(raw: Data([0x10] + [UInt8](repeating: 0, count: 29)))!

    func me(id: Bool, removed: Bool = false) -> Me {
        Me(id: id ? someId : nil, signPub: nil, encPub: nil, clockOffset: 0, lastPushSha256: nil, pushMissing: false,
           removed: removed, loggedOut: false, lastFetchAt: 0, fetchDue: false, signedInEmail: nil, name: nil,
           nameRev: 0, oldId: nil, requestToken: nil)
    }

    func d(id: Bool, removed: Bool = false, sign: KeyBootstrap.ItemRead, peerId: KeyBootstrap.ItemRead = .missing,
           inFlight: Bool = false, token: Bool = false) -> KeyBootstrap.Plan {
        KeyBootstrap.decide(me: me(id: id, removed: removed), signItem: sign, peerIdItem: peerId,
                            registerInFlight: inFlight, requestTokenSet: token)
    }

    func testSignedInDevice() {
        XCTAssertEqual(d(id: true, sign: .present), .useExisting)
        // the sign key is gone: nothing left to delete
        XCTAssertEqual(d(id: true, sign: .missing), .lost)
        // a Keychain fault is never a delete
        XCTAssertEqual(d(id: true, sign: .failed(.other(-34018))), .unusable)
        XCTAssertEqual(d(id: true, sign: .failed(.beforeFirstUnlock)), .retryLater)
    }

    func testRemovedDevice() {
        XCTAssertEqual(d(id: true, removed: true, sign: .present), .lost)
        XCTAssertEqual(d(id: false, removed: true, sign: .missing), .lost)
    }

    func testNoAccount() {
        XCTAssertEqual(d(id: false, sign: .missing), .createFresh)
        XCTAssertEqual(d(id: false, sign: .present), .createFresh)
        // a saved email-code step is bound to the keys made for it
        XCTAssertEqual(d(id: false, sign: .present, token: true), .useExisting)
        XCTAssertEqual(d(id: false, sign: .missing, token: true), .createFresh)
        XCTAssertEqual(d(id: false, sign: .failed(.beforeFirstUnlock), token: true), .retryLater)
    }

    func testOldIdReadFails() {
        // the old id read failed: neither delete nor create, try again later
        XCTAssertEqual(d(id: false, sign: .present, peerId: .failed(.other(-34018))), .retryLater)
        XCTAssertEqual(d(id: false, sign: .missing, peerId: .failed(.beforeFirstUnlock)), .retryLater)
        XCTAssertEqual(d(id: false, sign: .present, peerId: .present), .createFresh)
        // it does not matter once signed in
        XCTAssertEqual(d(id: true, sign: .present, peerId: .failed(.other(-34018))), .useExisting)
    }

    func testRegisterInFlight() {
        // a register that may have reached the relay server keeps its keys across a kill
        XCTAssertEqual(d(id: false, sign: .present, inFlight: true), .useExisting)
        XCTAssertEqual(d(id: false, sign: .present, peerId: .failed(.other(-34018)), inFlight: true), .useExisting)
        XCTAssertEqual(d(id: false, sign: .missing, inFlight: true), .createFresh)
        XCTAssertEqual(d(id: false, sign: .present, inFlight: false), .createFresh)
    }

    struct BrokenSigner: PASigner {
        let publicKey = SoftwareSigner().publicKey
        func sign(_ data: Data) throws -> Data { throw PAKeyError.unavailable }
    }

    /// signs with one key but reports the public key of another
    struct WrongKeySigner: PASigner {
        let inner = SoftwareSigner()
        let publicKey = SoftwareSigner().publicKey
        func sign(_ data: Data) throws -> Data { try inner.sign(data) }
    }

    struct BrokenDecryptor: PADecryptor {
        let publicKey = SoftwareDecryptor().publicKey
        func hpkeOpen(wire: Data, info: Data, aad: Data) throws -> Data { throw PAKeyError.unavailable }
    }

    func testSelfTest() {
        XCTAssertTrue(KeyBootstrap.selfTest(DeviceKeys(signer: SoftwareSigner(), decryptor: SoftwareDecryptor())))
        XCTAssertFalse(KeyBootstrap.selfTest(DeviceKeys(signer: BrokenSigner(), decryptor: SoftwareDecryptor())))
        XCTAssertFalse(KeyBootstrap.selfTest(DeviceKeys(signer: WrongKeySigner(), decryptor: SoftwareDecryptor())))
        XCTAssertFalse(KeyBootstrap.selfTest(DeviceKeys(signer: SoftwareSigner(), decryptor: BrokenDecryptor())))
    }
}
