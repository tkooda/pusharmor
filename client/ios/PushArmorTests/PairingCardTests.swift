import XCTest

/// The pairing card after this device confirmed the codes: the code stays, Codes match and
/// Codes differ are gone, and the device shows no second row.
final class PairingCardTests: XCTestCase {
    private func peersView() throws -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("App/Views/PeersView.swift")
        return try String(contentsOf: url, encoding: .utf8)
    }

    func testNoCodeButtonsAfterThisDeviceConfirmed() throws {
        let src = try peersView()
        XCTAssertTrue(src.contains("private var awaiting: Bool { entry != nil && p.state == .approved && !p.approveVerified }"))
        let awaitingCase = try XCTUnwrap(src.components(separatedBy: "case .shown where awaiting:").dropFirst().first)
        let block = try XCTUnwrap(awaitingCase.components(separatedBy: "case .shown:").first)
        XCTAssertTrue(block.contains("FingerprintPlate(code: p.fingerprint ?? \"\")"))
        XCTAssertFalse(block.contains("Button(\"Codes match\")"))
        XCTAssertFalse(block.contains("denyButton(\"Codes differ\")"))
        XCTAssertTrue(src.contains("PeerPendingLines(p: p, showCancel: false, showWaiting: false)"))
    }

    /// No Pair again button: a device that asks again or rejected this one gets Reject and Pair.
    func testNoPairAgainButton() throws {
        let src = try peersView()
        XCTAssertFalse(src.contains("Button(\"Pair again\")"))
        XCTAssertTrue(src.contains("Button(\"Pair\") { Task { await model.pairAgain(p) } }"))
        XCTAssertTrue(src.contains("StatusLine(kind: .notPaired, text: Core.pairAgainStatus(p))"))
    }

    /// While a device pairs, its card shows no more (ellipsis) button and no long-press menu.
    func testNoMoreMenuWhilePairing() throws {
        let src = try peersView()
        XCTAssertTrue(src.contains("if (!p.pinned || again) && entry == nil {\n"))
        XCTAssertTrue(src.contains("if (!p.pinned || again) && entry == nil { peerActions }"))
        XCTAssertFalse(src.contains("if !p.pinned || again {"))
    }
}
