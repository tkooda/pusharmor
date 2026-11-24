import XCTest
import PushArmorCore

/// The file-v1.json blob vectors through the FileCrypto code linked into the app binary
/// (OpenSSL libcrypto in the iOS simulator build), public API only.
final class FileCryptoAppTests: XCTestCase {
    func testBlobVectorsOpenAndTamperedBlobsFail() throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("tests/vectors/file-v1.json")
        let all = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
        let cases = (all["blob"] as! [String: Any])["cases"] as! [[String: Any]]
        XCTAssertFalse(cases.isEmpty)
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("filecrypto-app-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        for c in cases {
            let name = c["name"] as! String
            let key = B64URL.decode(c["key"] as! String)!
            let blob = B64URL.decode(c["blob"] as! String)!
            let plain = B64URL.decode(c["plaintext"] as! String)!
            let input = dir.appendingPathComponent("in"), out = dir.appendingPathComponent("out")
            try blob.write(to: input)
            try FileCrypto.decrypt(input: input, output: out, key: key)
            XCTAssertEqual(try Data(contentsOf: out), plain, name)
            try FileManager.default.removeItem(at: out)

            var bad = blob
            bad[bad.count - 1] ^= 1
            try bad.write(to: input)
            XCTAssertThrowsError(try FileCrypto.decrypt(input: input, output: out, key: key), name)
            XCTAssertFalse(FileManager.default.fileExists(atPath: out.path), name)

            // Encrypt (random nonce) and decrypt back through the same binary.
            try plain.write(to: input)
            let sealed = dir.appendingPathComponent("sealed")
            try FileCrypto.encrypt(input: input, output: sealed, key: key)
            XCTAssertEqual(try Data(contentsOf: sealed).count, plain.count + FileCrypto.overhead, name)
            try FileCrypto.decrypt(input: sealed, output: out, key: key)
            XCTAssertEqual(try Data(contentsOf: out), plain, name)
            try FileManager.default.removeItem(at: out)
        }
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: dir.path).sorted(), ["in", "sealed"])
    }
}
