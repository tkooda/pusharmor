import XCTest
@testable import PushArmorCore

/// A file refused before any send try (too large, unreadable, no room) keeps nothing: no file
/// record (so no pending History row) and no History item. Only the toast shows.
final class RefusedFileTests: XCTestCase {
    func testRefusedFileLeavesNoHistoryItem() async throws {
        let w = FakeWorker(), clock = TestClock()
        let n = try Device(worker: w, clock: clock, name: "Ndev"), x = try Device(worker: w, clock: clock, name: "Xdev")
        try await Scenario.pairFully(w, n, x)
        await n.core.fetchPeers(force: true)
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("refused-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }
        let before = try n.core.store.history().count

        // too large: a sparse file one byte over the limit
        let big = tmp.appendingPathComponent("big.bin")
        XCTAssertTrue(FileManager.default.createFile(atPath: big.path, contents: nil))
        let h = try FileHandle(forWritingTo: big)
        try h.truncate(atOffset: UInt64(FileRules.maxFile + 1))
        try h.close()
        XCTAssertThrowsError(try n.core.fileSendPrepare(input: big, rawName: "big.bin", to: [x.id], allCount: 1,
                                                        dir: tmp.appendingPathComponent("n"), free: nil)) {
            XCTAssertEqual($0 as? Core.FileSendError, .tooLarge)
        }
        // unreadable: no such file
        XCTAssertThrowsError(try n.core.fileSendPrepare(input: tmp.appendingPathComponent("gone.bin"), rawName: "gone.bin",
                                                        to: [x.id], allCount: 1, dir: tmp.appendingPathComponent("n"), free: nil)) {
            XCTAssertEqual($0 as? Core.FileSendError, .unreadable)
        }

        XCTAssertEqual(try n.core.store.allFiles().count, 0)
        XCTAssertTrue(try n.core.store.allFiles().filter(FileUi.pendingSend).isEmpty)
        XCTAssertEqual(try n.core.store.history().count, before)
    }
}
