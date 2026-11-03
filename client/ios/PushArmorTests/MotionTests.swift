import XCTest

/// Transitions other than tab changes take at most 100 ms. SwiftUI animations are view
/// code, so this reads the app's source: no default (spring) animation is left.
final class MotionTests: XCTestCase {
    private func source(_ path: String) throws -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent(path)
        return try String(contentsOf: url, encoding: .utf8)
    }

    func testBannerAndScrollToDeviceTakeAtMost100ms() throws {
        let root = try source("App/Views/RootView.swift")
        XCTAssertTrue(root.contains(".animation(.easeOut(duration: 0.1), value: model.toast)"))
        XCTAssertFalse(root.contains(".animation(.default"))
        let peers = try source("App/Views/PeersView.swift")
        XCTAssertTrue(peers.contains("withAnimation(.easeOut(duration: 0.1)) { proxy.scrollTo("))
        XCTAssertFalse(peers.contains("withAnimation {"))
    }
}
