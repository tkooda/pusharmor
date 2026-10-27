import XCTest
import UserNotifications
import PushArmorCore
@testable import PushArmor

/// App-hosted unit tests of the app target's notification content (Shared/AppEnvironment.swift).
final class BannerContentTests: XCTestCase {
    func testCategoriesHaveTheDesignedActionsAndHiddenPreviewPlaceholder() {
        let cats = BannerContent.categories()
        var actions: [String: [String]] = [:]
        for c in cats {
            actions[c.identifier] = c.actions.map(\.identifier)
            XCTAssertEqual(c.hiddenPreviewsBodyPlaceholder, S.fallback, c.identifier)
        }
        XCTAssertEqual(actions, [
            BannerCategory.url.rawValue: ["OPEN", "COPY"],
            BannerCategory.text.rawValue: ["COPY"],
            BannerCategory.tel.rawValue: ["COPY"],
            BannerCategory.event.rawValue: [],
            BannerCategory.notice.rawValue: ["OK"],
        ])
        let copy = cats.flatMap(\.actions).filter { $0.identifier == "COPY" }
        XCTAssertFalse(copy.isEmpty)
        for a in copy { XCTAssertTrue(a.options.contains(.authenticationRequired)) }
    }

    func testContentKeepsOnlyTheBannerAndM() {
        let c = BannerContent.content(.dropped, m: "relay-m", key: nil)
        XCTAssertEqual(c.title, S.title)
        XCTAssertEqual(c.body, Banner.dropped.body)
        XCTAssertEqual(c.categoryIdentifier, BannerCategory.notice.rawValue)
        XCTAssertEqual(c.threadIdentifier, Banner.dropThread)
        XCTAssertEqual(c.userInfo["m"] as? String, "relay-m")
        XCTAssertEqual(c.userInfo["tap"] as? String, "history")
        XCTAssertNil(c.userInfo["done"])
        XCTAssertEqual(c.subtitle, "")
    }

    func testExpiryIsTheFallbackWithOnlyM() {
        let c = BannerContent.expiry(m: "relay-m")
        XCTAssertEqual(c.title, S.title)
        XCTAssertEqual(c.body, S.fallback)
        XCTAssertEqual(c.categoryIdentifier, Banner.fallback.category.rawValue)
        XCTAssertEqual(c.userInfo.count, 1)
        XCTAssertEqual(c.userInfo["m"] as? String, "relay-m")
        XCTAssertTrue(BannerContent.expiry(m: nil).userInfo.isEmpty)
    }
}
