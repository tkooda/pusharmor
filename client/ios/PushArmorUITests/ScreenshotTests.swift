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

    /// Store shots (I613): the spec sample data (-PAScreenshotsStore), light only, journey order.
    func testCaptureStoreScreenshots() {
        let store = ["-PAScreenshotsStore", "-appearance", "light"]
        var app = launch(store + ["-PAScreenshotsPairWaiting"])
        XCTAssertTrue(app.buttons["Pair"].waitForExistence(timeout: 30))
        assertTabs(app)
        sleep(1)
        shot("01-pair-waiting")
        app.terminate()

        app = launch(store + ["-PAScreenshotsPairFingerprint"])
        XCTAssertTrue(app.buttons["Confirmed"].waitForExistence(timeout: 30))
        assertTabs(app)
        sleep(1)
        shot("02-pair-fingerprint")
        app.terminate()

        app = launch(store)
        XCTAssertTrue(app.buttons["Send to \"Pixel 8\""].waitForExistence(timeout: 30))
        assertTabs(app)
        peersTab(app)
        XCTAssertTrue(labelled(app, "Galaxy S23").waitForExistence(timeout: 10))
        sleep(1)
        shot("03-devices")
        // the just-paired row expanded: its switches, Hide and Remove
        let lockShow = app.switches["Show message content on lock screen"]
        for _ in 0..<2 where !lockShow.exists {
            labelled(app, "Galaxy S23").tap()
            _ = lockShow.waitForExistence(timeout: 10)
        }
        XCTAssertTrue(lockShow.exists)
        XCTAssertTrue(app.buttons["Remove device from account"].exists)
        sleep(1)
        shot("04-device-options")
        app.tabBars.buttons["Send"].tap()
        XCTAssertTrue(app.buttons["Send to \"Pixel 8\""].waitForExistence(timeout: 10))
        sleep(1)
        shot("05-send")
        app.tabBars.buttons["History"].tap()
        XCTAssertTrue(labelled(app, "Meeting moved to 3:30 pm").waitForExistence(timeout: 10))
        sleep(1)
        shot("06-history")
        app.terminate()

        app = launch(store + ["-PAScreenshotsDetailText"])
        XCTAssertTrue(app.buttons["Copy"].waitForExistence(timeout: 30))
        XCTAssertTrue(app.buttons["Save"].exists)
        sleep(1)
        shot("07-history-text")
        app.terminate()

        app = launch(store + ["-PAScreenshotsDetail"])
        XCTAssertTrue(app.buttons["Copy"].waitForExistence(timeout: 30))
        XCTAssertTrue(app.buttons["Open"].exists)
        sleep(1)
        shot("08-history-link")
        app.terminate()

        app = launch(store)
        let settings = app.tabBars.buttons["Settings"]
        XCTAssertTrue(settings.waitForExistence(timeout: 30))
        settings.tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 10))
        sleep(1)
        shot("10-settings")
        // Settings is longer than one screen: the rest, scrolled to the Account section
        let logOut = app.buttons["Log out"]
        for _ in 0..<10 where !(logOut.exists && logOut.isHittable) { app.swipeUp() }
        XCTAssertTrue(logOut.isHittable)
        sleep(1)
        shot("11-settings-more")
        app.terminate()
    }

    /// The four tabs, in order.
    private func assertTabs(_ app: XCUIApplication) {
        let bar = app.tabBars.firstMatch
        XCTAssertTrue(bar.waitForExistence(timeout: 10))
        XCTAssertEqual(bar.buttons.allElementsBoundByIndex.map(\.label), ["Send", "History", "Devices", "Settings"])
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

        // first-pair screen (the Devices tab with no paired device, I612), light and dark (-appearance sets the stored theme)
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
}
