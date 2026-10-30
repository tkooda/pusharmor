import XCTest

/// Home and Peers in the debug-only screenshot mode (sample database, no Keychain, no
/// Worker call): the Send button counts its peers and the pairing card reads the
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

    func testSendButtonCountsSelectedPeers() {
        let app = launch()
        XCTAssertTrue(app.buttons["Send to 1 device"].waitForExistence(timeout: 30))
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
        XCTAssertTrue(app.staticTexts["Check that New laptop shows this same code."].exists)
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
}
