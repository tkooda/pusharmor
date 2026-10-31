import XCTest

/// Send and Devices tabs in the debug-only screenshot mode (sample database, no Keychain, no
/// Worker call): the Send button names its one device and the pairing card reads the
/// fingerprint one character at a time.
final class BrandScreensTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private func launch(_ extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-PAScreenshots"] + extra
        app.launch()
        return app
    }

    func testSendButtonNamesTheSelectedPeer() {
        let app = launch()
        XCTAssertTrue(app.buttons["Send to \"Laptop\""].waitForExistence(timeout: 30))
        XCTAssertTrue(app.tabBars.buttons["Send"].exists)
        XCTAssertTrue(app.navigationBars["Send"].exists)
        XCTAssertTrue(app.staticTexts["Will open as a link"].exists)
        let header = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Send to (1 of ")).firstMatch
        XCTAssertTrue(header.exists)
    }

    /// F24: History is its own tab; the Send tab shows no history rows.
    func testHistoryIsItsOwnTab() {
        let app = launch()
        XCTAssertTrue(app.buttons["Send to \"Laptop\""].waitForExistence(timeout: 30))
        let row = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "Meeting moved to 3 pm")).firstMatch
        XCTAssertFalse(row.exists)
        let tab = app.tabBars.buttons["History"]
        XCTAssertTrue(tab.exists)
        tab.tap()
        XCTAssertTrue(app.navigationBars["History"].waitForExistence(timeout: 10))
        XCTAssertTrue(row.waitForExistence(timeout: 10))
    }

    func testPairingCardShowsTheFingerprintCells() {
        let app = launch(["-PAScreenshotsPairing"])
        let tab = app.tabBars.buttons["Devices"]
        XCTAssertTrue(tab.waitForExistence(timeout: 30))
        tab.tap()
        let cells = app.descendants(matching: .any)["Pairing fingerprint K, 7, Q, D"]
        XCTAssertTrue(cells.waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["Approve"].exists)
        XCTAssertTrue(app.buttons["Deny"].exists)
        XCTAssertTrue(app.staticTexts["Verify that \"New laptop\" shows this same code."].exists)
    }

    func testUnpairedPeerActionsHaveAVisibleButton() {
        let app = launch(["-PAScreenshotsPairing"])
        let tab = app.tabBars.buttons["Devices"]
        XCTAssertTrue(tab.waitForExistence(timeout: 30))
        tab.tap()
        let more = app.buttons["More actions"]
        XCTAssertTrue(more.waitForExistence(timeout: 10))
        more.tap()
        XCTAssertTrue(app.buttons["Hide"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Remove"].exists)
    }

    /// F25, F30, F31: Devices has no This device row and offers the pairing how-to; the
    /// rename lives in Settings.
    func testPairHowToAndRenameInSettings() {
        let app = launch()
        let tab = app.tabBars.buttons["Devices"]
        XCTAssertTrue(tab.waitForExistence(timeout: 30))
        tab.tap()
        XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "Work desktop"))
            .firstMatch.waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["Rename"].exists)
        let pair = app.buttons["Pair a new device"]
        for _ in 0..<5 where !(pair.exists && pair.isHittable) { app.swipeUp() }
        pair.tap()
        XCTAssertTrue(app.staticTexts["Install PushArmor on the other device."].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Log in with the same account."].exists)
        XCTAssertTrue(app.staticTexts["It appears here. Tap Pair."].exists)
        app.buttons["Done"].tap()
        app.tabBars.buttons["Settings"].tap()
        XCTAssertTrue(app.buttons["Rename"].waitForExistence(timeout: 10))
    }

    /// I462: with no paired device, Send says how to pair one and opens Devices.
    func testSendWithNoPairedDeviceGuidesToDevices() {
        let app = launch(["-PAScreenshotsPairing"])
        XCTAssertTrue(app.staticTexts["Pair a device first"].waitForExistence(timeout: 30))
        XCTAssertTrue(app.staticTexts["Install PushArmor on the other device."].exists)
        XCTAssertTrue(app.staticTexts["It appears in Devices. Tap Pair."].exists)
        app.buttons["Open Devices"].tap()
        XCTAssertTrue(app.navigationBars["Devices"].waitForExistence(timeout: 10))
    }

    func testLogOutAsksFirstAndCancelKeepsTheDevice() {
        let app = launch()
        let tab = app.tabBars.buttons["Settings"]
        XCTAssertTrue(tab.waitForExistence(timeout: 30))
        tab.tap()
        let logOut = app.buttons["Log out"]
        // the list is lazy: the button exists only once scrolled near
        for _ in 0..<10 where !(logOut.exists && logOut.isHittable) { app.swipeUp() }
        XCTAssertTrue(logOut.isHittable)
        logOut.tap()
        let question = app.staticTexts[
            "Log out of this device? Keys, paired devices, names, and history stay on this device."]
        XCTAssertTrue(question.waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["Log out"].exists)
        let cancel = app.buttons["Cancel"]
        XCTAssertTrue(cancel.exists)
        cancel.tap()
        XCTAssertFalse(question.waitForExistence(timeout: 2))
        XCTAssertTrue(app.buttons["Log out"].exists)
        XCTAssertTrue(app.tabBars.buttons["Settings"].exists)
    }
}
