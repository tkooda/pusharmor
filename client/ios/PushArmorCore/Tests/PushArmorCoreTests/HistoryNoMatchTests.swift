import XCTest
@testable import PushArmorCore

/// A chosen History filter that matches nothing stays chosen (its choice stays in the list) and
/// lists no rows, so History shows "No matching messages"; only All lists every row.
final class HistoryNoMatchTests: XCTestCase {
    private func store() throws -> (Store, PeerId, PeerId) {
        let s = try Store(path: NSTemporaryDirectory() + "pa-nm-\(UUID().uuidString).sqlite")
        let a = TestPeer(), b = TestPeer()
        var pa = Peer(id: a.id); pa.name = "A"; try s.savePeer(pa)
        var pb = Peer(id: b.id); pb.name = "B"; try s.savePeer(pb)
        try s.addMessage(dir: .incoming, peer: a.id, type: "text", content: "1", n: 1, pairingId: nil, read: false, results: nil, now: 1)
        try s.addMessage(dir: .incoming, peer: b.id, type: "text", content: "2", n: 1, pairingId: nil, read: false, results: nil, now: 2)
        try s.addMessage(dir: .outgoing, peer: a.id, type: "text", content: "3", n: nil, pairingId: nil, read: true, results: "{}", now: 3)
        try s.addEvent(.couldNotRead, peer: nil, content: S.dropped, now: 4)
        return (s, a.id, b.id)
    }

    private func shown(_ chosen: HistoryFilter, _ s: Store) throws -> (filter: HistoryFilter, rows: [HistoryRow], choices: [HistoryFilter]) {
        let rows = try s.history()
        let f = HistoryFilter.current(chosen, options: HistoryFilter.options(rows: rows, peers: try s.peers()))
        return (f, HistoryFilter.apply(f, rows), HistoryFilter.choices(HistoryFilter.options(rows: rows, peers: try s.peers()), chosen: f))
    }

    func testText() {
        XCTAssertEqual(HistoryFilter.noMatch, "No matching messages")
    }

    /// A device filter whose received rows were all deleted while it was chosen.
    func testDeviceFilterEmptiedStaysChosen() throws {
        let (s, a, _) = try store()
        let chosen = HistoryFilter.peer(a.text, "A")
        XCTAssertEqual(try shown(chosen, s).rows.count, 1)
        try s.db.exec("DELETE FROM history WHERE content = '1'")
        let v = try shown(chosen, s)
        XCTAssertEqual(v.filter, chosen)
        XCTAssertTrue(v.rows.isEmpty)
        XCTAssertTrue(v.choices.contains(chosen))
    }

    /// A device filter whose device's rows are all gone, so the device choices are hidden.
    func testDeviceFilterWithOnlyOneDeviceLeftStaysChosen() throws {
        let (s, _, b) = try store()
        let chosen = HistoryFilter.peer(b.text, "B")
        try s.db.exec("DELETE FROM history WHERE content = '2'")
        XCTAssertFalse(HistoryFilter.options(rows: try s.history(), peers: try s.peers()).contains(chosen))
        let v = try shown(chosen, s)
        XCTAssertEqual(v.filter, chosen)
        XCTAssertTrue(v.rows.isEmpty)
        XCTAssertEqual(v.choices.last, chosen)
    }

    /// The Unknown filter whose rows were all deleted.
    func testUnknownFilterEmptiedStaysChosen() throws {
        let (s, _, _) = try store()
        try s.db.exec("DELETE FROM history WHERE peer_id IS NULL")
        let v = try shown(.unknown, s)
        XCTAssertEqual(v.filter, .unknown)
        XCTAssertTrue(v.rows.isEmpty)
        XCTAssertTrue(v.choices.contains(.unknown))
    }

    /// Every row deleted while a filter is chosen.
    func testAllRowsDeletedKeepsTheFilter() throws {
        let (s, a, _) = try store()
        try s.db.exec("DELETE FROM history")
        let v = try shown(.peer(a.text, "A"), s)
        XCTAssertEqual(v.filter, .peer(a.text, "A"))
        XCTAssertTrue(v.rows.isEmpty)
        XCTAssertEqual(v.choices, [.all, .peer(a.text, "A")])
    }

    /// A renamed device keeps its filter, under the new name.
    func testRenamedDeviceKeepsItsFilter() throws {
        let (s, a, _) = try store()
        var p = try XCTUnwrap(try s.peers().first { $0.id.text == a.text })
        p.name = "A2"
        try s.savePeer(p)
        let v = try shown(.peer(a.text, "A"), s)
        XCTAssertEqual(v.filter, .peer(a.text, "A2"))
        XCTAssertEqual(v.rows.count, 1)
    }

    func testAllListsEveryRow() throws {
        let (s, _, _) = try store()
        XCTAssertEqual(try shown(.all, s).rows.count, 4)
    }
}
