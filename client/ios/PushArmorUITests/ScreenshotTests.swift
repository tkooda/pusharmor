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
        let tab = app.tabBars.buttons["Devices"]
        XCTAssertTrue(tab.waitForExistence(timeout: 30))
        tab.tap()
    }

    func testCaptureStoreScreenshots() {
        var app = launch()
        XCTAssertTrue(app.staticTexts["Meeting moved to 3 pm, room B"].waitForExistence(timeout: 30))
        sleep(1)
        shot("03-send")
        peersTab(app)
        XCTAssertTrue(labelled(app, "Work desktop").waitForExistence(timeout: 10))
        sleep(1)
        shot("01-peers")
        app.terminate()

        app = launch(["-PAScreenshotsPairing"])
        peersTab(app)
        XCTAssertTrue(labelled(app, "Pair with New laptop?").waitForExistence(timeout: 10))
        sleep(1)
        shot("04-pairing")
        app.terminate()

        // The banner shows for a few seconds only: shoot it while it is on screen (hittable before
        // and after the shot), else relaunch, which posts the sample notification again.
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let banner = springboard.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@", "lentil-soup")).firstMatch
        for attempt in 1...3 {
            app = launch(["-PAScreenshotsNotify"])
            let allow = springboard.alerts.buttons["Allow"]
            if attempt == 1, allow.waitForExistence(timeout: 15) { allow.tap() }
            if onScreen(banner, timeout: 20) {
                settle(banner)
                let a = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
                if banner.exists && banner.isHittable {
                    a.name = "02-notification"
                    a.lifetime = .keepAlways
                    add(a)
                    return
                }
            }
            app.terminate()
        }
        XCTFail("the sample notification banner was not on screen in 3 attempts")
    }

    /// Any element whose label contains the text (a peer row reads as one combined element).
    private func labelled(_ app: XCUIApplication, _ text: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }

    /// Waits out the slide-in: the frame must hold still for three polls in a row, then a
    /// one-second pause lets the blur and the icon finish fading in.
    private func settle(_ e: XCUIElement) {
        var last = CGRect.null
        var still = 0
        let end = Date().addingTimeInterval(3)
        while still < 3 && Date() < end && e.exists {
            let f = e.frame
            still = f == last ? still + 1 : 0
            last = f
            usleep(100_000)
        }
        usleep(1_000_000)
    }

    private func onScreen(_ e: XCUIElement, timeout: TimeInterval) -> Bool {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end {
            if e.exists && e.isHittable { return true }
            usleep(200_000)
        }
        return false
    }
}
