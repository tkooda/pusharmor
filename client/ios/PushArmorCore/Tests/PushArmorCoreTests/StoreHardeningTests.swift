import XCTest
@testable import PushArmorCore

final class StoreHardeningTests: XCTestCase {
    func tmpPath(_ tag: String) -> String { NSTemporaryDirectory() + "pa-\(tag)-\(UUID().uuidString).sqlite" }

    /// an argument with no matching parameter is an error, not silently ignored.
    func testSurplusBindArgumentThrows() throws {
        let db = try DB(path: tmpPath("bind"))
        XCTAssertThrowsError(try db.query("SELECT ?", [.int(1), .int(2)])) { e in
            guard case DBError.sql(let rc, _) = e else { return XCTFail("not a DBError.sql: \(e)") }
            XCTAssertEqual(rc, 25)   // SQLITE_RANGE
        }
        XCTAssertEqual(try db.one("SELECT ? AS v", [.int(1)])?.int("v"), 1)
    }

    /// a NUL inside message text is stored and read back whole.
    func testNulInTextKept() throws {
        let s = try Store(path: tmpPath("nul"))
        let a = TestPeer()
        let r1 = try s.addMessage(dir: .incoming, peer: a.id, type: "text", content: "a\u{0}b", n: nil, pairingId: nil,
                                  read: false, results: nil, now: 1)
        let r2 = try s.addMessage(dir: .incoming, peer: a.id, type: "text", content: "\u{0}x", n: nil, pairingId: nil,
                                  read: false, results: nil, now: 1)
        XCTAssertEqual(try s.historyRow(r1)?.content, "a\u{0}b")
        XCTAssertEqual(try s.historyRow(r2)?.content, "\u{0}x")
        XCTAssertEqual(try s.db.one("SELECT length(CAST(content AS BLOB)) AS n FROM history WHERE rowid = ?", [.int(r1)])?.int("n"), 3)
    }
}
