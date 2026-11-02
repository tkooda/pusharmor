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
}
