import XCTest
@testable import PushArmorCore

/// An account of 25 devices: one device reaches its 24 others in one call, and the
/// largest GET /v1/peers reply at 25 devices is parsed.
final class Devices25Tests: XCTestCase {
    var w: FakeWorker!
    var clock: TestClock!

    override func setUp() {
        w = FakeWorker()
        clock = TestClock()
    }

    /// N fully paired with 24 other devices.
    func account25() async throws -> (Device, [Device]) {
        let n = try Device(worker: w, clock: clock, name: "Ndev")
        var others: [Device] = []
        for _ in 0 ..< 24 {
            let x = try Device(worker: w, clock: clock, name: "Xdev")
            try await Scenario.pairFully(w, n, x)
            others.append(x)
            clock.now += 100
        }
        await n.core.fetchPeers(force: true)
        return (n, others)
    }

    /// a send to 24 devices, and the synced delete of that row, each go in one POST /v1/send.
    func testSendAndDeleteTo24DevicesIsOneCallEach() async throws {
        let (n, others) = try await account25()
        XCTAssertEqual(Core.maxSendTargets, 24)
        let ids = others.map { $0.id }
        XCTAssertEqual(Set(try n.core.allSet().map { $0.id }), Set(ids))
        var sends = w.count("POST", "/v1/send")
        let rep = try await n.core.send("hello", as: .text, to: ids, allCount: ids.count)
        XCTAssertTrue(rep.allSent)
        XCTAssertEqual(rep.sent, 24)
        XCTAssertEqual(w.count("POST", "/v1/send"), sends + 1)
        for x in others { await x.drainInbox(w) }
        let row = try XCTUnwrap(try n.core.store.history().first { $0.dir == .outgoing && $0.content == "hello" })
        sends = w.count("POST", "/v1/send")
        let notice = try await n.core.deleteHistoryRows([row.rowid])
        XCTAssertNil(notice)
        XCTAssertEqual(w.count("POST", "/v1/send"), sends + 1)
        XCTAssertNil(try n.core.store.historyRow(row.rowid))
        for x in others { XCTAssertEqual(w.inbox[x.id.text]?.count, 1) }
    }

    /// the largest legal GET /v1/peers reply at 25 devices (names at MAX_NAME_ENTRY, "removed"
    /// at RM_JSON_MAX) is over the old 65536 cap and within the current one.
    func testLargestPeersReplyAt25DevicesIsParsed() {
        let pub = String(repeating: "B", count: 87)
        func id(_ i: Int) -> String { String(repeating: "A", count: 38) + String(format: "%02d", i) }
        let peers = (0 ..< 25).map { i in
            "{\"id\":\"\(id(i))\",\"sign_pub\":\"\(pub)\",\"enc_pub\":\"\(pub)\",\"platform\":\"android\","
                + "\"created\":9999999999,\"logged_out\":false,\"approves\":24,\"approved_by\":25,\"approves_me\":false,"
                + "\"denies_me\":false,\"reachable\":false,\"name_for_me\":\"\(String(repeating: "N", count: 1024))\",\"listening\":false}"
        }
        let allow = (1 ..< 25).map { "\"\(id($0))\"" }
        let removed = "\"" + id(99) + "\":\"" + String(repeating: "R", count: 32000 - 48) + "\""
        let text = "{\"my_push_sha256\":\"\(String(repeating: "h", count: 64))\",\"my_allow\":[\(allow.joined(separator: ","))],"
            + "\"my_relay_fault\":false,\"peers\":[\(peers.joined(separator: ","))],\"removed\":{\(removed)},"
            + "\"push_missing\":true,\"id\":\"\(id(0))\"}"
        let body = Data(text.utf8)
        XCTAssertGreaterThan(body.count, 65536)
        XCTAssertLessThan(body.count, 70000)
        XCTAssertLessThanOrEqual(body.count, APIReply.maxBody)
        let r = APIReply(status: 200, body: body)
        XCTAssertNotNil(r.json)
        if case .array(let list)? = r.json?["peers"] { XCTAssertEqual(list.count, 25) } else { XCTFail("no peers") }
    }
}
