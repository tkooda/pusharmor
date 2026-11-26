import XCTest

/// iPad: the four tabs render in every orientation, with the sample data of the debug-only
/// screenshot mode (no Keychain and no Worker call). Runs only on an iPad simulator.
final class IPadLayoutTests: XCTestCase {
    override func setUpWithError() throws {
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .pad, "iPad only")
        continueAfterFailure = false
    }

    override func tearDown() {
        XCUIDevice.shared.orientation = .portrait
        super.tearDown()
    }

    func testMainScreensRenderInEveryOrientation() {
        let app = XCUIApplication()
        app.launchArguments = ["-PAScreenshots", "-PAScreenshotsStore", "-appearance", "light"]
        app.launch()
        XCTAssertTrue(app.buttons["Send to \"Pixel 8\""].waitForExistence(timeout: 30))
        let orientations: [(String, UIDeviceOrientation)] = [
            ("portrait", .portrait), ("landscape left", .landscapeLeft),
            ("upside down", .portraitUpsideDown), ("landscape right", .landscapeRight),
        ]
        for (name, o) in orientations {
            XCUIDevice.shared.orientation = o
            tab(app, "Devices").tap()
            XCTAssertTrue(labelled(app, "Galaxy S23").waitForExistence(timeout: 10), "Devices, " + name)
            tab(app, "History").tap()
            XCTAssertTrue(app.navigationBars["History"].waitForExistence(timeout: 10), "History, " + name)
            tab(app, "Settings").tap()
            XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 10), "Settings, " + name)
            tab(app, "Send").tap()
            XCTAssertTrue(app.buttons["Send to \"Pixel 8\""].waitForExistence(timeout: 10), "Send, " + name)
        }
    }

    /// A tab button: in the tab bar, or a plain button where iPad shows the tabs at the top.
    private func tab(_ app: XCUIApplication, _ name: String) -> XCUIElement {
        let b = app.tabBars.buttons[name]
        return b.waitForExistence(timeout: 5) ? b : app.buttons[name].firstMatch
    }

    /// Any element whose label contains the text (a peer row reads as one combined element).
    private func labelled(_ app: XCUIApplication, _ text: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }
}
