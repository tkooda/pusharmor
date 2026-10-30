import XCTest
import SwiftUI
import UIKit
@testable import PushArmor

/// The Theme setting maps System / Light / Dark to a color scheme (F3).
final class AppearancePreferenceTests: XCTestCase {
    func testColorSchemeMapping() {
        XCTAssertNil(AppearancePreference.system.colorScheme)
        XCTAssertEqual(AppearancePreference.light.colorScheme, .light)
        XCTAssertEqual(AppearancePreference.dark.colorScheme, .dark)
    }

    func testInterfaceStyleMapping() {
        XCTAssertEqual(AppearancePreference.system.interfaceStyle, .unspecified)
        XCTAssertEqual(AppearancePreference.light.interfaceStyle, .light)
        XCTAssertEqual(AppearancePreference.dark.interfaceStyle, .dark)
    }

    func testStoredValuesRoundTrip() {
        for p in AppearancePreference.allCases {
            XCTAssertEqual(AppearancePreference(stored: p.rawValue), p)
        }
        XCTAssertEqual(AppearancePreference.allCases.map(\.rawValue), ["system", "light", "dark"])
    }

    func testMissingOrUnknownDefaultsToSystem() {
        XCTAssertEqual(AppearancePreference(stored: nil), .system)
        XCTAssertEqual(AppearancePreference(stored: ""), .system)
        XCTAssertEqual(AppearancePreference(stored: "Dark"), .system)
    }

    func testTitles() {
        XCTAssertEqual(AppearancePreference.allCases.map(\.title), ["System", "Light", "Dark"])
    }
}
