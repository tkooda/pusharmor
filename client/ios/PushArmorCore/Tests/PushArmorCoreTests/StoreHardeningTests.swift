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

    /// rows a newer or damaged store holds that do not map are skipped, never a trap.
    func testUnmappedRowsSkipped() throws {
        let s = try Store(path: tmpPath("rows"))
        let a = TestPeer()
        try s.db.exec("INSERT INTO pairing (peer_id, role, state, started_at) VALUES (?, 'x', 'future_state', 1)", [.text(a.id.text)])
        try s.db.exec("INSERT INTO history (dir, type, content, created_local) VALUES ('x', 'text', 'bad', 1)")
        try s.db.exec("INSERT INTO peers (id) VALUES ('not-an-id')")
        let good = try s.addMessage(dir: .incoming, peer: a.id, type: "text", content: "ok", n: nil, pairingId: nil,
                                    read: false, results: nil, now: 1)
        XCTAssertEqual(try s.pairings(), [])
        XCTAssertNil(try s.pairing(a.id))
        XCTAssertEqual(try s.history().map { $0.rowid }, [good])
        XCTAssertEqual(try s.peers().count, 0)
        try s.db.exec("DELETE FROM me")
        XCTAssertThrowsError(try s.me())
    }

    /// opening a store that needs no migration does not wait for another writer.
    func testOpenDoesNotWaitForWriter() throws {
        let path = tmpPath("open")
        let a = try DB(path: path)
        try a.exec("BEGIN IMMEDIATE")
        defer { try? a.exec("ROLLBACK") }
        let t0 = Date()
        XCTAssertNoThrow(try DB(path: path))
        XCTAssertLessThan(Date().timeIntervalSince(t0), 1)
    }

    /// an ended pairing leaves no copy of its secret in pa.sqlite or pa.sqlite-wal.
    func testDeletedPairingSecretNotOnDisk() throws {
        let path = tmpPath("secdel")
        let s = try Store(path: path)
        let a = TestPeer()
        let r = Data((0 ..< 32).map { UInt8(0xa5 ^ $0) })
        try s.savePairing(PairingEntry(peerId: a.id, role: .n, state: .committed, r: r, cN: nil, authorized: false,
                                       unsent: false, startedAt: 1, notBefore: 0, lastSendAt: 0))
        try s.deletePairing(a.id)
        for suffix in ["", "-wal"] {
            let bytes = (try? Data(contentsOf: URL(fileURLWithPath: path + suffix))) ?? Data()
            XCTAssertNil(bytes.range(of: r), "secret found in pa.sqlite" + suffix)
        }
    }

    /// history keeps at most the newest 500 rows: on prune and on every insert.
    func testHistoryCappedAt500() throws {
        let w = FakeWorker(), clock = TestClock()
        let d = try Device(worker: w, clock: clock, name: "Ndev")
        let s = d.core.store
        try s.db.exec("""
            WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM c WHERE i < 100000)
            INSERT INTO history (dir, type, content, created_local) SELECT 'in', 'text', 'm' || i, ? FROM c
            """, [.int(clock.now)])
        let top = try XCTUnwrap(s.db.one("SELECT max(rowid) AS m FROM history")?.int("m"))
        try d.core.pruneHistory()
        XCTAssertEqual(try s.db.one("SELECT count(*) AS n FROM history")?.int("n"), 500)
        XCTAssertEqual(try s.db.one("SELECT min(rowid) AS m FROM history")?.int("m"), top - 499)
        let a = TestPeer()
        let id = try s.addMessage(dir: .incoming, peer: a.id, type: "text", content: "new", n: nil, pairingId: nil,
                                  read: false, results: nil, now: clock.now)
        XCTAssertEqual(try s.db.one("SELECT count(*) AS n FROM history")?.int("n"), 500)
        XCTAssertEqual(try s.history().first?.rowid, id)
        try s.addEvent(.loggedIn, peer: a.id, content: "e", now: clock.now)
        XCTAssertEqual(try s.history().count, 500)
        let plan = try s.db.query("EXPLAIN QUERY PLAN DELETE FROM history WHERE created_local < ?", [.int(0)])
        XCTAssertTrue(plan.contains { ($0.text("detail") ?? "").contains("history_created") })
    }
}
