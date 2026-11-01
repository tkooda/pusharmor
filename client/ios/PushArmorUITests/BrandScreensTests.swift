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

    /// I617: Send as text sits on the hint row, at its right end.
    func testSendAsTextSharesTheHintRow() {
        let app = launch()
        let hint = app.staticTexts["Will open as a link"]
        XCTAssertTrue(hint.waitForExistence(timeout: 30))
        let toggle = app.switches["Send as text"]
        XCTAssertTrue(toggle.exists)
        XCTAssertLessThan(abs(toggle.frame.midY - hint.frame.midY), 12)
        XCTAssertGreaterThan(toggle.frame.minX, hint.frame.maxX)
    }

    /// I604: a successful send shows the bottom banner between the Send button and the tab
    /// bar, so it covers neither.
    func testSendBannerSitsAboveTheTabBar() {
        let app = launch(["-PAScreenshotsSentOK"])
        let banner = app.descendants(matching: .any)["banner"]
        XCTAssertTrue(banner.waitForExistence(timeout: 30))
        XCTAssertTrue(banner.label.contains("Message sent to \"Laptop\""), banner.label)
        let send = app.buttons["Send to \"Laptop\""]
        XCTAssertTrue(send.exists)
        XCTAssertLessThanOrEqual(send.frame.maxY, banner.frame.minY + 1)
        XCTAssertLessThanOrEqual(banner.frame.maxY, app.tabBars.firstMatch.frame.minY + 1)
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
        // no paired device yet: the Devices tab holds the pairing card, and the tabs stay (I612)
        let app = launch(["-PAScreenshotsPairing"])
        XCTAssertTrue(app.navigationBars["Pair your first device"].waitForExistence(timeout: 30))
        let cells = app.descendants(matching: .any)["Pairing fingerprint K, 7, Q, D"]
        XCTAssertTrue(cells.waitForExistence(timeout: 10))
        XCTAssertTrue(app.tabBars.firstMatch.exists)
        XCTAssertTrue(app.buttons["Confirmed"].exists)
        XCTAssertTrue(app.buttons["Reject"].exists)
        XCTAssertTrue(app.staticTexts["Verify that \"New laptop\" shows this same code."].exists)
    }

    func testUnpairedPeerActionsHaveAVisibleButton() {
        // no paired device yet: the first-pair screen holds the pairing card (Q338)
        let app = launch(["-PAScreenshotsPairing"])
        XCTAssertTrue(app.navigationBars["Pair your first device"].waitForExistence(timeout: 30))
        let more = app.buttons["More actions"]
        XCTAssertTrue(more.waitForExistence(timeout: 10))
        // I589: on a slow CI simulator the first tap can land before the menu takes taps.
        let hide = app.buttons["Hide"]
        for _ in 0..<2 where !hide.exists {
            more.tap()
            _ = hide.waitForExistence(timeout: 10)
        }
        XCTAssertTrue(hide.exists)
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

    /// I609: the device name shows once; Rename edits it inline with Cancel and Save, no dialog.
    func testRenameIsInline() {
        let app = launch()
        let tab = app.tabBars.buttons["Settings"]
        XCTAssertTrue(tab.waitForExistence(timeout: 30))
        tab.tap()
        let rename = app.buttons["Rename"]
        XCTAssertTrue(rename.waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["Copy"].exists)
        XCTAssertFalse(app.buttons["Save"].exists)
        XCTAssertFalse(app.textFields.firstMatch.exists)
        rename.tap()
        let field = app.textFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Save"].exists)
        XCTAssertFalse(app.buttons["Rename"].exists)
        XCTAssertFalse(app.alerts.firstMatch.exists)
        app.buttons["Cancel"].tap()
        XCTAssertTrue(rename.waitForExistence(timeout: 5))
        XCTAssertFalse(field.exists)
        XCTAssertFalse(app.buttons["Save"].exists)
    }

    /// I610: Show message content in notifications sits above the lock screen switch, which is
    /// disabled while content is off; Delete account and Log out share one centered row.
    func testContentSwitchAndAccountRow() {
        let app = launch()
        let tab = app.tabBars.buttons["Settings"]
        XCTAssertTrue(tab.waitForExistence(timeout: 30))
        tab.tap()
        let show = app.switches["Show message content in notifications"]
        let lock = app.switches["Show message content on lock screen"]
        for _ in 0..<10 where !(show.exists && show.isHittable && lock.exists && lock.isHittable) { app.swipeUp() }
        XCTAssertFalse(app.switches["Always hide content"].exists)
        XCTAssertLessThan(show.frame.minY, lock.frame.minY)
        XCTAssertEqual(show.value as? String, "1")
        XCTAssertTrue(lock.isEnabled)
        // the switch itself, not its label: the inner switch where exposed, else the right end of the row
        let knob = show.switches.firstMatch
        if knob.exists { knob.tap() } else { show.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap() }
        wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", "0"), object: show)], timeout: 5)
        XCTAssertFalse(lock.isEnabled)
        let del = app.buttons["Delete account"]
        let out = app.buttons["Log out"]
        for _ in 0..<10 where !(out.exists && out.isHittable) { app.swipeUp() }
        XCTAssertEqual(del.frame.midY, out.frame.midY, accuracy: 2)
        XCTAssertLessThan(del.frame.maxX, out.frame.minX)
        XCTAssertEqual((del.frame.minX + out.frame.maxX) / 2, app.windows.firstMatch.frame.midX, accuracy: 8)
    }

    /// I611: empty History offers Send a message, which opens the Send tab.
    func testEmptyHistoryOffersSend() {
        let app = launch(["-PAScreenshotsNoHistory"])
        let history = app.tabBars.buttons["History"]
        XCTAssertTrue(history.waitForExistence(timeout: 30))
        history.tap()
        XCTAssertTrue(app.staticTexts["Messages you send or receive show here."].waitForExistence(timeout: 10))
        let send = app.buttons["Send a message"]
        XCTAssertTrue(send.exists)
        send.tap()
        XCTAssertTrue(app.navigationBars["Send"].waitForExistence(timeout: 5))
    }

    /// I468: the email field is marked invalid while non-empty and not a valid address.
    func testEmailFieldMarksInvalidLive() {
        let app = launch(["-PAScreenshotsSignIn"])
        let more = app.buttons["Email me a code"]
        XCTAssertTrue(more.waitForExistence(timeout: 30))
        more.tap()
        let field = app.textFields["Email address"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        XCTAssertFalse((field.value as? String ?? "").contains("Not a valid email address"))
        field.tap()
        field.typeText("abc")
        XCTAssertTrue((field.value as? String ?? "").contains("Not a valid email address"))
        field.typeText("@example.com")
        XCTAssertFalse((field.value as? String ?? "").contains("Not a valid email address"))
    }

    /// I612: zero devices: the tabs show, opened on Devices with the first-pair steps and a
    /// waiting line; Send and History offer Pair a device, which opens Devices.
    func testFirstPairScreenWithNoDevice() {
        let app = launch(["-PAScreenshotsEmpty"])
        XCTAssertTrue(app.navigationBars["Pair your first device"].waitForExistence(timeout: 30))
        XCTAssertTrue(app.staticTexts["Install PushArmor on another device."].exists)
        XCTAssertTrue(app.staticTexts["Log in with the same account."].exists)
        XCTAssertTrue(app.staticTexts["When it shows below, tap Pair, then tap Confirmed when the fingerprints match."].exists)
        XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@",
            "Waiting for another device to log in.")).firstMatch.exists)
        XCTAssertTrue(app.tabBars.firstMatch.exists)
        for name in ["Send", "History"] {
            app.tabBars.buttons[name].tap()
            XCTAssertTrue(app.staticTexts["Pair your first device to start sending."].waitForExistence(timeout: 5))
            app.buttons["Pair a device"].tap()
            XCTAssertTrue(app.navigationBars["Pair your first device"].waitForExistence(timeout: 5))
        }
        app.tabBars.buttons["Settings"].tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 10))
    }

    /// I612: logged out there are no tabs; the gear on the login screen opens Settings.
    func testSignInHasSettingsGear() {
        let app = launch(["-PAScreenshotsSignIn"])
        let gear = app.buttons["Settings"]
        XCTAssertTrue(gear.waitForExistence(timeout: 30))
        XCTAssertFalse(app.tabBars.firstMatch.exists)
        gear.tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 10))
    }

    /// Q338: with a paired device the normal tabs show, on Send.
    func testPairedDeviceShowsTabsOnSend() {
        let app = launch()
        XCTAssertTrue(app.tabBars.buttons["Send"].waitForExistence(timeout: 30))
        XCTAssertTrue(app.navigationBars["Send"].exists)
        XCTAssertFalse(app.navigationBars["Pair your first device"].exists)
    }

    /// Q367: Log out acts at once; no confirm shows and Delete account stays.
    func testLogOutAsksNothing() {
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
        XCTAssertFalse(question.waitForExistence(timeout: 3))
        XCTAssertFalse(app.buttons["Cancel"].exists)
        XCTAssertTrue(app.buttons["Delete account"].exists)
    }

    /// Q398: a text message opens a sheet with its text and Copy, Share, and Save pinned at the
    /// bottom; no Read, View, or Open button.
    func testMessageSheetShowsTextAndButtons() {
        let app = launch(["-PAScreenshotsStore", "-PAScreenshotsDetailText"])
        let copy = app.buttons["Copy"]
        XCTAssertTrue(copy.waitForExistence(timeout: 30))
        XCTAssertTrue(app.buttons["Share"].exists)
        XCTAssertTrue(app.buttons["Save"].exists)
        XCTAssertFalse(app.buttons["Open"].exists)
        XCTAssertFalse(app.buttons["Read"].exists)
        XCTAssertFalse(app.buttons["View"].exists)
        XCTAssertTrue(app.descendants(matching: .any)["messageText"].exists)
        XCTAssertTrue(copy.isHittable)
        // I639: the last text line ends above the button row, not under it
        let text = app.descendants(matching: .any)["messageText"]
        XCTAssertLessThanOrEqual(text.frame.maxY, copy.frame.minY, "text \(text.frame) copy \(copy.frame) window \(app.windows.firstMatch.frame)")
        app.buttons["Done"].tap()
        XCTAssertFalse(copy.waitForExistence(timeout: 3))
    }

    /// I604: Delete all history asks in a standard alert; Cancel closes it.
    func testDeleteHistoryAsksInAnAlert() {
        let app = launch()
        let tab = app.tabBars.buttons["Settings"]
        XCTAssertTrue(tab.waitForExistence(timeout: 30))
        tab.tap()
        let del = app.buttons["Delete all history"]
        for _ in 0..<10 where !(del.exists && del.isHittable) { app.swipeUp() }
        XCTAssertTrue(del.isHittable)
        del.tap()
        let alert = app.alerts["Delete all history?"]
        XCTAssertTrue(alert.waitForExistence(timeout: 10))
        XCTAssertTrue(alert.buttons["Delete"].exists)
        alert.buttons["Cancel"].tap()
        XCTAssertFalse(alert.waitForExistence(timeout: 2))
    }

    /// I569: scrolled to the end, the last About row sits above the tab bar, not under it.
    func testAboutEndsAboveTheTabBar() {
        let app = launch()
        let tab = app.tabBars.buttons["Settings"]
        XCTAssertTrue(tab.waitForExistence(timeout: 30))
        tab.tap()
        let last = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Privacy policy")).firstMatch
        // the list is lazy: the row exists only once scrolled near; then swipe on to the end
        for _ in 0..<10 where !(last.exists && last.isHittable) { app.swipeUp() }
        app.swipeUp()
        app.swipeUp()
        sleep(1)
        XCTAssertTrue(last.isHittable)
        let bar = app.tabBars.firstMatch
        XCTAssertTrue(bar.exists)
        XCTAssertLessThanOrEqual(last.frame.maxY, bar.frame.minY)
    }
}
