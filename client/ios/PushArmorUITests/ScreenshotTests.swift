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
        XCTAssertTrue(app.buttons["Send to \"Laptop\""].waitForExistence(timeout: 30))
        sleep(1)
        shot("03-send")
        peersTab(app)
        XCTAssertTrue(labelled(app, "Work desktop").waitForExistence(timeout: 10))
        sleep(1)
        shot("01-peers")
        app.terminate()

        app = launch(["-PAScreenshotsPairing"])   // the first-pair screen (Q338)
        XCTAssertTrue(labelled(app, "Pair with new device: \"New laptop\"").waitForExistence(timeout: 10))
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

    /// Review images (not store shots): the sign-in screen, Settings, and the first-pair screen.
    func testCaptureReviewScreenshots() {
        var app = launch(["-PAScreenshotsSignIn"])
        XCTAssertTrue(labelled(app, "Continue with Google").waitForExistence(timeout: 30))
        sleep(1)
        shot("90-signin")
        app.terminate()

        app = launch()
        let tab = app.tabBars.buttons["Settings"]
        XCTAssertTrue(tab.waitForExistence(timeout: 30))
        tab.tap()
        let signOut = app.buttons["Log out"]
        // the list is lazy: the button exists only once scrolled near
        for _ in 0..<10 where !(signOut.exists && signOut.isHittable) { app.swipeUp() }
        XCTAssertTrue(signOut.isHittable)
        sleep(1)
        shot("91-settings")
        app.terminate()

        // Q338 first-pair screen, light and dark (-appearance sets the stored theme)
        for (name, theme) in [("93-firstpair-light", "light"), ("94-firstpair-dark", "dark")] {
            app = launch(["-PAScreenshotsEmpty", "-appearance", theme])
            XCTAssertTrue(app.navigationBars["Pair your first device"].waitForExistence(timeout: 30))
            sleep(1)
            shot(name)
            app.terminate()
        }
        for (name, theme) in [("95-firstpair-waiting-light", "light"), ("96-firstpair-waiting-dark", "dark")] {
            app = launch(["-PAScreenshotsPairing", "-appearance", theme])
            XCTAssertTrue(labelled(app, "Pair with new device: \"New laptop\"").waitForExistence(timeout: 30))
            sleep(1)
            shot(name)
            app.terminate()
        }
    }

    /// About-page shots (review images, light and dark): first-pair waiting, a devices list with
    /// four devices, the offline send error and an opened history item.
    func testCaptureAboutScreenshots() {
        for theme in ["light", "dark"] {
            var app = launch(["-PAScreenshotsPairing", "-appearance", theme])
            XCTAssertTrue(labelled(app, "Pair with new device: \"New laptop\"").waitForExistence(timeout: 30))
            sleep(1)
            shot("97-first-pair-waiting-\(theme)")
            app.terminate()

            app = launch(["-PAScreenshotsMore", "-appearance", theme])
            peersTab(app)
            XCTAssertTrue(labelled(app, "Phone").waitForExistence(timeout: 10))
            sleep(1)
            shot("97-devices-list-\(theme)")
            app.terminate()

            app = launch(["-PAScreenshotsSendError", "-appearance", theme])
            XCTAssertTrue(labelled(app, "Not sent. Try again.").waitForExistence(timeout: 30))
            sleep(1)
            shot("97-send-error-\(theme)")
            app.terminate()

            // I604: a full success shows the bottom banner, above the tab bar
            app = launch(["-PAScreenshotsSentOK", "-appearance", theme])
            let banner = app.descendants(matching: .any)["banner"]
            XCTAssertTrue(banner.waitForExistence(timeout: 30))
            XCTAssertTrue(banner.label.contains("Message sent to \"Laptop\""), banner.label)
            XCTAssertLessThanOrEqual(banner.frame.maxY, app.tabBars.firstMatch.frame.minY + 1)
            sleep(1)
            shot("97-send-ok-\(theme)")
            app.terminate()

            app = launch(["-appearance", theme])
            let history = app.tabBars.buttons["History"]
            XCTAssertTrue(history.waitForExistence(timeout: 30))
            history.tap()
            let row = labelled(app, "hiking-trails")
            XCTAssertTrue(row.waitForExistence(timeout: 10))
            row.tap()
            XCTAssertTrue(app.buttons["Copy"].waitForExistence(timeout: 10))
            sleep(1)
            shot("97-history-open-\(theme)")
            app.terminate()
        }
    }

    /// Screen review (not store shots): every screen in light and dark, as NN-screen-<theme>.
    /// Runs only with PA_SHOTS_ALL=1 too (tools/screenshots.sh with PA_SHOTS_ALL=1).
    func testCaptureAllScreens() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["PA_SHOTS_ALL"] == "1", "all-screens run only")
        for theme in ["light", "dark"] {
            var app = launch(["-PAScreenshotsSignIn", "-appearance", theme])
            XCTAssertTrue(labelled(app, "Continue with Google").waitForExistence(timeout: 30))
            sleep(1)
            shot("01-signin-\(theme)")
            app.terminate()

            app = launch(["-PAScreenshotsEmpty", "-appearance", theme])
            XCTAssertTrue(app.navigationBars["Pair your first device"].waitForExistence(timeout: 30))
            sleep(1)
            shot("02-firstpair-empty-\(theme)")
            app.terminate()

            app = launch(["-PAScreenshotsPairing", "-appearance", theme])
            XCTAssertTrue(labelled(app, "Pair with new device: \"New laptop\"").waitForExistence(timeout: 30))
            sleep(1)
            shot("03-firstpair-fingerprint-\(theme)")
            app.terminate()

            app = launch(["-appearance", theme])
            XCTAssertTrue(app.buttons["Send to \"Laptop\""].waitForExistence(timeout: 30))
            sleep(1)
            shot("05-send-\(theme)")
            peersTab(app)
            XCTAssertTrue(labelled(app, "Work desktop").waitForExistence(timeout: 10))
            sleep(1)
            shot("04-devices-\(theme)")
            app.tabBars.buttons["History"].tap()
            XCTAssertTrue(labelled(app, "Meeting moved to 3 pm").waitForExistence(timeout: 10))
            sleep(1)
            shot("08-history-\(theme)")
            app.tabBars.buttons["Settings"].tap()
            XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 10))
            // every Settings section, one screen per page, then About at the end of the list
            let last = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Privacy policy")).firstMatch
            for page in 1...8 {
                sleep(1)
                shot("09-settings-\(page)-\(theme)")
                if last.exists && last.isHittable { break }
                app.swipeUp()
            }
            app.swipeUp()
            app.swipeUp()
            sleep(1)
            shot("10-about-\(theme)")
            app.terminate()

            app = launch(["-PAScreenshotsSent", "-appearance", theme])
            XCTAssertTrue(labelled(app, "Sent to 2 of 3 devices").waitForExistence(timeout: 30))
            sleep(1)
            shot("06-send-results-\(theme)")
            app.terminate()

            app = launch(["-PAScreenshotsNoHistory", "-appearance", theme])
            let history = app.tabBars.buttons["History"]
            XCTAssertTrue(history.waitForExistence(timeout: 30))
            history.tap()
            XCTAssertTrue(app.staticTexts["No messages yet"].waitForExistence(timeout: 10))
            sleep(1)
            shot("07-history-empty-\(theme)")
            app.terminate()

            app = launch(["-PAScreenshotsUpdate", "-appearance", theme])
            XCTAssertTrue(app.buttons["Update"].waitForExistence(timeout: 30))
            sleep(1)
            shot("11-update-required-\(theme)")
            app.terminate()
        }
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
