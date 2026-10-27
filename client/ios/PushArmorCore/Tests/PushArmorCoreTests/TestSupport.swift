import XCTest
@testable import PushArmorCore

func hex(_ s: String) -> Data { Bytes.fromHex(s)! }

/// A deterministic id for tests: account(9) || keyhash(12) || filler(9).
func testId(account: Data, signPub: Data, encPub: Data, tail: UInt8 = 0) -> PeerId {
    PeerId(raw: account + Ids.keyhash(signPub: signPub, encPub: encPub) + Data(repeating: tail, count: 9))!
}

/// A software peer: keys and an id in a given account.
struct TestPeer {
    let signer: SoftwareSigner
    let decryptor: SoftwareDecryptor
    let id: PeerId
    init(account: Data = Data(repeating: 7, count: 9), tail: UInt8 = 0) {
        signer = SoftwareSigner()
        decryptor = SoftwareDecryptor()
        id = testId(account: account, signPub: signer.publicKey, encPub: decryptor.publicKey, tail: tail)
    }
    var signPub: Data { signer.publicKey }
    var encPub: Data { decryptor.publicKey }
}
