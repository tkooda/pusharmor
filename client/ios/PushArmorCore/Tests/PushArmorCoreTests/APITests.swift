import XCTest
@testable import PushArmorCore

final class APITests: XCTestCase {
    final class Recorder: @unchecked Sendable {
        var sleeps: [Double] = []
    }

    func client(_ w: FakeWorker, _ rec: Recorder) -> APIClient {
        APIClient(base: URL(string: "https://api.test")!, transport: w, clockMs: { 1761300000000 }, sleep: { rec.sleeps.append($0) })
    }

    func testRetryOn429HonorsRetryAfterAnd503Backoff() async {
        let w = FakeWorker(), rec = Recorder()
        let api = client(w, rec)
        w.script("POST", "/v1/auth/email", 429, "{\"error\":\"rate limited\",\"retry_after\":2}")
        w.script("POST", "/v1/auth/email", 503, "{\"error\":\"unavailable\"}")
        w.script("POST", "/v1/auth/email", 200, "{\"request_token\":\"rt\"}")
        let r = await AuthClient(api: api).emailStart(email: "A@B.com", signPub: SoftwareSigner().publicKey, purpose: .register, turnstile: "t")
        XCTAssertEqual(r, .requestToken("rt"))
        XCTAssertEqual(rec.sleeps, [2, 1.5])
    }

    func testNoRetryOn502AndLongRetryAfter() async {
        let w = FakeWorker(), rec = Recorder()
        let api = client(w, rec)
        w.script("POST", "/v1/auth/email", 502, "{\"error\":\"email send failed\"}")
        let r = await AuthClient(api: api).emailStart(email: "a@b.com", signPub: SoftwareSigner().publicKey, purpose: .register, turnstile: "t")
        XCTAssertEqual(r, .emailSendFailed)
        w.script("POST", "/v1/auth/email", 429, "{\"error\":\"rate limited\",\"retry_after\":60}")
        let r2 = await AuthClient(api: api).emailStart(email: "a@b.com", signPub: SoftwareSigner().publicKey, purpose: .register, turnstile: "t")
        XCTAssertEqual(r2, .rateLimited(60))
        XCTAssertEqual(rec.sleeps, [])
        // a non-ASCII address is refused before sending
        let r3 = await AuthClient(api: api).emailStart(email: "b\u{00f6}b@x.com", signPub: SoftwareSigner().publicKey, purpose: .register, turnstile: "t")
        XCTAssertEqual(r3, .badEmail)
    }

    func testOffsetResyncedFromEveryReply() async {
        let w = FakeWorker(), rec = Recorder()
        w.epoch = 1761300000 + 7
        let api = client(w, rec)
        _ = await api.call("GET", "/v1/x", auth: .none)
        XCTAssertEqual(api.offsetS, 7)
        XCTAssertEqual(api.workerNowMs, 1761300007000)
        // PA-Epoch is unix seconds (Q331); a clock ahead gives a negative offset
        w.epoch = 1761300000 - 400
        _ = await api.call("GET", "/v1/x", auth: .none)
        XCTAssertEqual(api.offsetS, -400)
    }

    /// Q328: every request carries PA-Client; a 426 reply posts upgradeRequired once and is not retried.
    func testClientHeaderAnd426() async {
        let w = FakeWorker(), rec = Recorder()
        let api = APIClient(base: URL(string: "https://api.test")!, transport: w, client: "ios/1.2.3",
                            clockMs: { 1761300000000 }, sleep: { rec.sleeps.append($0) })
        _ = await api.call("GET", "/v1/x", auth: .none)
        XCTAssertEqual(w.lastHeaders["PA-Client"], "ios/1.2.3")
        XCTAssertTrue(APIClient.defaultClient.hasPrefix("ios/"))
        let posted = expectation(forNotification: APIClient.upgradeRequired, object: api)
        w.script("POST", "/v1/send", 426, "{\"error\":\"upgrade required\"}")
        let r = await api.call("POST", "/v1/send", auth: .none)
        XCTAssertEqual(r.reply?.status, 426)
        XCTAssertEqual(w.count("POST", "/v1/send"), 1)
        XCTAssertEqual(rec.sleeps, [])
        await fulfillment(of: [posted], timeout: 1)
    }

    /// Q349: a version marked by a 426 stays marked on every check; another version clears it.
    func testUpdateGateKeepsTheMarkUntilTheVersionChanges() throws {
        let d = try XCTUnwrap(UserDefaults(suiteName: "UpdateGateTests"))
        d.removeObject(forKey: UpdateGate.key)
        XCTAssertFalse(UpdateGate.required(d, version: "0.0.19"))
        UpdateGate.mark(d, version: "0.0.19")
        XCTAssertTrue(UpdateGate.required(d, version: "0.0.19"))
        XCTAssertTrue(UpdateGate.required(d, version: "0.0.19"))
        XCTAssertFalse(UpdateGate.required(d, version: "0.0.20"))
        XCTAssertNil(d.string(forKey: UpdateGate.key))
    }
}
