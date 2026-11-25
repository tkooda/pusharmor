import XCTest
@testable import PushArmor

/// the device limit list: fewest pairings (trusts + trusted by) first, then oldest added first.
@MainActor
final class LimitOrderTests: XCTestCase {
    func testFewestPairingsThenOldest() {
        func e(_ id: String, _ approves: Int, _ approvedBy: Int, _ created: Int64) -> AppModel.LimitEntry {
            AppModel.LimitEntry(id: id, platform: "android", created: created, approves: approves, approvedBy: approvedBy,
                                reachable: true, loggedOut: false, oldInstall: false)
        }
        let sorted = AppModel.limitOrder([e("a", 2, 1, 100), e("b", 0, 1, 300), e("c", 1, 0, 200), e("d", 0, 0, 400), e("e", 3, 0, 50)])
        XCTAssertEqual(sorted.map(\.id), ["d", "c", "b", "e", "a"])
    }
}
