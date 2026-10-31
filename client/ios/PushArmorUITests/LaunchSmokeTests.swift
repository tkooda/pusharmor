import XCTest

/// UI smoke test: launch the app as a user would (no launch arguments, no environment)
/// on a fresh install and expect the first screen: sign-in, or the notification
/// explainer when notifications are denied.
final class LaunchSmokeTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    func testFirstLaunchShowsTheFirstScreen() {
        let app = XCUIApplication()
        app.launch()
        let signIn = app.buttons["Continue with Google"]
        let welcome = app.buttons["Allow notifications"]
        let shown = signIn.waitForExistence(timeout: 20) || welcome.exists
        XCTAssertTrue(shown, "neither the login screen nor the notification explainer appeared")
    }
}
