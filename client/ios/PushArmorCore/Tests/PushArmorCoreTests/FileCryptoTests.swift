import XCTest
@testable import PushArmorCore

/// The blob section of tests/vectors/file-v1.json through FileCrypto (OpenSSL), plus the
/// streaming and the tag-before-move rules.
final class FileCryptoTests: XCTestCase {
    typealias J = [String: Any]

    static let blobCases: [J] = {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("tests/vectors/file-v1.json")
        let d = try! Data(contentsOf: url)
        let all = try! JSONSerialization.jsonObject(with: d) as! J
        return (all["blob"] as! J)["cases"] as! [J]
    }()

    var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("filecrypto-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    func b(_ s: Any?) -> Data { B64URL.decode(s as! String)! }
    func file(_ name: String, _ data: Data) throws -> URL {
        let u = dir.appendingPathComponent(name)
        try data.write(to: u)
        return u
    }
    func names() throws -> [String] { try FileManager.default.contentsOfDirectory(atPath: dir.path).sorted() }

    func testBlobVectors() throws {
        XCTAssertEqual(Self.blobCases.count, 3)
        for c in Self.blobCases {
            let name = c["name"] as! String
            let key = b(c["key"]), nonce = b(c["nonce"]), plain = b(c["plaintext"]), blob = b(c["blob"])
            XCTAssertEqual(plain.count, (c["size"] as! NSNumber).intValue, name)
            XCTAssertEqual(blob.count, (c["blob_size"] as! NSNumber).intValue, name)
            XCTAssertEqual(blob.count, plain.count + FileCrypto.overhead, name)
            XCTAssertEqual(blob.prefix(FileCrypto.nonceSize), nonce, name)

            let p = try file("\(name).plain", plain)
            let sealed = dir.appendingPathComponent("\(name).blob")
            try FileCrypto.encrypt(input: p, output: sealed, key: key, nonce: nonce)
            XCTAssertEqual(try Data(contentsOf: sealed), blob, name)
            XCTAssertEqual(B64URL.encode(Data(SHA256.hash(data: blob))), c["sha256"] as! String, name)

            let opened = dir.appendingPathComponent("\(name).out")
            try FileCrypto.decrypt(input: try file("\(name).in", blob), output: opened, key: key)
            XCTAssertEqual(try Data(contentsOf: opened), plain, name)
        }
    }

    /// Any flipped bit fails, and the failed decrypt leaves no output and no temp file.
    func testEveryFlippedBitFailsAndLeavesNothing() throws {
        for c in Self.blobCases {
            let name = c["name"] as! String
            let key = b(c["key"]), blob = b(c["blob"])
            let out = dir.appendingPathComponent("out")
            for i in 0..<blob.count {
                var bad = blob
                bad[i] ^= UInt8(1 << (i % 8))
                let input = try file("in", bad)
                XCTAssertThrowsError(try FileCrypto.decrypt(input: input, output: out, key: key), "\(name) byte \(i)") {
                    XCTAssertEqual($0 as? FileCrypto.Failure, .tagMismatch)
                }
                XCTAssertEqual(try names(), ["in"], "\(name) byte \(i)")
            }
        }
    }

    func testWrongKeyFailsAndKeepsAnExistingOutput() throws {
        let c = Self.blobCases[1]
        var key = b(c["key"])
        key[0] ^= 0x80
        let out = try file("out", Data("earlier".utf8))
        XCTAssertThrowsError(try FileCrypto.decrypt(input: try file("in", b(c["blob"])), output: out, key: key)) {
            XCTAssertEqual($0 as? FileCrypto.Failure, .tagMismatch)
        }
        XCTAssertEqual(try Data(contentsOf: out), Data("earlier".utf8))
        XCTAssertEqual(try names(), ["in", "out"])
    }

    func testShortBlobAndBadKeySize() throws {
        let key = Data(repeating: 7, count: 32)
        let out = dir.appendingPathComponent("out")
        XCTAssertThrowsError(try FileCrypto.decrypt(input: try file("in", Data(count: 27)), output: out, key: key)) {
            XCTAssertEqual($0 as? FileCrypto.Failure, .tooShort)
        }
        XCTAssertThrowsError(try FileCrypto.decrypt(input: try file("in", Data(count: 28)), output: out, key: key.prefix(31))) {
            XCTAssertEqual($0 as? FileCrypto.Failure, .badKey)
        }
        XCTAssertThrowsError(try FileCrypto.encrypt(input: try file("p", Data()), output: out, key: key.prefix(16))) {
            XCTAssertEqual($0 as? FileCrypto.Failure, .badKey)
        }
        XCTAssertEqual(try names(), ["in", "p"])
    }

    /// Several chunks and a partial last chunk; the blob also opens with CryptoKit
    /// (AES.GCM one-shot), so both engines agree; a random nonce differs per call.
    func testMultiChunkRoundTripMatchesCryptoKit() throws {
        let size = FileCrypto.chunkSize * 3 + 17
        var g = SystemRandomNumberGenerator()
        let plain = Data((0..<size).map { _ in UInt8.random(in: 0...255, using: &g) })
        let key = Data((0..<32).map { _ in UInt8.random(in: 0...255, using: &g) })
        let p = try file("plain", plain)
        let blob1 = dir.appendingPathComponent("blob1"), blob2 = dir.appendingPathComponent("blob2")
        try FileCrypto.encrypt(input: p, output: blob1, key: key)
        try FileCrypto.encrypt(input: p, output: blob2, key: key)
        let b1 = try Data(contentsOf: blob1), b2 = try Data(contentsOf: blob2)
        XCTAssertEqual(b1.count, size + 28)
        XCTAssertNotEqual(b1.prefix(12), b2.prefix(12))
        let box = try AES.GCM.SealedBox(combined: b1)
        XCTAssertEqual(try AES.GCM.open(box, using: SymmetricKey(data: key)), plain)

        let out = dir.appendingPathComponent("out")
        try FileCrypto.decrypt(input: blob1, output: out, key: key)
        XCTAssertEqual(try Data(contentsOf: out), plain)
        XCTAssertEqual(try names(), ["blob1", "blob2", "out", "plain"])
    }
}
