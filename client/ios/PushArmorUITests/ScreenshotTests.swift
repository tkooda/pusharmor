import XCTest

/// Store screenshots with sample data (tools/screenshots.sh). Skipped unless the test runner
/// gets PA_SHOTS=1 (xcodebuild passes TEST_RUNNER_PA_SHOTS). The app runs in its debug-only
/// screenshot mode: a sample database, no Keychain and no Worker call.
final class ScreenshotTests: XCTestCase {
    override func setUpWithError() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["PA_SHOTS"] == "1", "screenshot run only")
        continueAfterFailure = false
    }

    private func launch(_ extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-PAScreenshots"] + extra
        app.launch()
        return app
    }

    private func shot(_ name: String) {
        let a = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        a.name = name
        a.lifetime = .keepAlways
        add(a)
    }

    private func peersTab(_ app: XCUIApplication) {
        let tab = app.tabBars.buttons["Peers"]
        XCTAssertTrue(tab.waitForExistence(timeout: 30))
        tab.tap()
    }

    func testCaptureStoreScreenshots() {
        var app = launch()
        XCTAssertTrue(app.staticTexts["Meeting moved to 3 pm, room B"].waitForExistence(timeout: 30))
        sleep(1)
        shot("03-send")
        peersTab(app)
        XCTAssertTrue(app.staticTexts["Work desktop"].waitForExistence(timeout: 10))
        sleep(1)
        shot("01-peers")
        app.terminate()

        app = launch(["-PAScreenshotsPairing"])
        peersTab(app)
        XCTAssertTrue(app.staticTexts["New laptop"].waitForExistence(timeout: 10))
        sleep(1)
        shot("04-pairing")
        app.terminate()

        app = launch(["-PAScreenshotsNotify"])
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let allow = springboard.alerts.buttons["Allow"]
        if allow.waitForExistence(timeout: 15) { allow.tap() }
        let banner = springboard.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@", "lentil-soup")).firstMatch
        XCTAssertTrue(banner.waitForExistence(timeout: 15), "the sample notification did not show")
        shot("02-notification")
    }
}
