import XCTest
@testable import PushArmorCore

final class PairDecideTests: XCTestCase {
    let low = PeerId(raw: Data([0x10] + [UInt8](repeating: 0, count: 29)))!
    let high = PeerId(raw: Data([0x90] + [UInt8](repeating: 0, count: 29)))!
    let c1 = Data(repeating: 1, count: 32), c2 = Data(repeating: 2, count: 32)
    let now: Int64 = 2_000_000_000

    func input(own: PeerId? = nil, from: PeerId? = nil, entry: PairDecide.Entry? = nil, pinned: Bool = false,
               approved: Bool = false, verified: Bool = false, approvesMe: Bool? = nil, after: Bool = false,
               listed: PairDecide.Listed = .yes, open: Int = 0, cap: [Int64] = []) -> PairDecide.Input {
        PairDecide.Input(ownId: own ?? low, fromId: from ?? high, commitCN: c1, entry: entry, pinned: pinned, approved: approved,
                         approveVerified: verified, approvesMe: approvesMe, getAfterVerify: after, listed: listed,
                         openEntries: open, cap: cap, now: now)
    }

    func d(_ i: PairDecide.Input) -> PairDecide.Output { PairDecide.decide(i) }

    func testRuleA() {
        XCTAssertEqual(d(input(entry: .init(role: .x, state: .replied, cN: c1, replyAuthorized: true))),
                       .init(.reply, .represent, .unchanged))
        // duplicate on a cap-prompted entry sends nothing (I229)
        XCTAssertEqual(d(input(entry: .init(role: .x, state: .prompted, cN: c1, replyAuthorized: false))),
                       .init(.notice, .represent, .unchanged))
        XCTAssertEqual(d(input(entry: .init(role: .x, state: .shown, cN: c1, replyAuthorized: true), pinned: true)),
                       .init(.notice, .represent, .unchanged))
    }

    func testRuleB() {
        XCTAssertEqual(d(input(entry: .init(role: .x, state: .replied, cN: c2, replyAuthorized: true))),
                       .init(.abort, .couldNotRead, .aborted))
        // after Approve: no abort; the pinned half state shows the 3d notice
        XCTAssertEqual(d(input(entry: .init(role: .x, state: .shown, cN: c2, replyAuthorized: true), pinned: true, approved: true)),
                       .init(.drop, .halfState, .unchanged))
    }

    func testRuleCCrossing() {
        // lower id stays N
        XCTAssertEqual(d(input(own: low, from: high, entry: .init(role: .n, state: .committed))),
                       .init(.drop, .crossing, .unchanged))
        // higher id wipes its N entry and replies (cap skipped)
        XCTAssertEqual(d(input(own: high, from: low, entry: .init(role: .n, state: .committed), cap: Array(repeating: now - 10, count: 10))),
                       .init(.reply, .commit, .nWipedXReplied))
        // own N entry past committed: drop; half-state notice only when waiting for X (I266)
        XCTAssertEqual(d(input(entry: .init(role: .n, state: .shown), pinned: true)), .init(.drop, .couldNotRead, .unchanged))
        XCTAssertEqual(d(input(entry: .init(role: .n, state: .shown), pinned: true, approved: true)),
                       .init(.drop, .halfState, .unchanged))
        XCTAssertEqual(d(input(entry: .init(role: .n, state: .shown), pinned: true, approved: true, verified: true)),
                       .init(.drop, .couldNotRead, .unchanged))
    }

    func testRuleD() {
        XCTAssertEqual(d(input(pinned: true, approved: true, verified: true, approvesMe: true, after: true)),
                       .init(.drop, .couldNotRead, .unchanged))
        XCTAssertEqual(d(input(pinned: true, approved: true, verified: true, approvesMe: false, after: true)),
                       .init(.drop, .halfState, .unchanged))
        // an older GET never counts: a just-completed pairing stays paired, plain drop
        XCTAssertEqual(d(input(pinned: true, approved: true, verified: true, approvesMe: false, after: false)),
                       .init(.drop, .couldNotRead, .unchanged))
        XCTAssertEqual(d(input(approved: true)), .init(.drop, .couldNotRead, .unchanged))
    }

    func testRuleE() {
        XCTAssertEqual(d(input()), .init(.reply, .commit, .createdReplied, capCounted: true))
        XCTAssertEqual(d(input(listed: .afterFetch)), .init(.reply, .commit, .createdReplied, capCounted: true))
        XCTAssertEqual(d(input(listed: .no)), .init(.drop, .couldNotRead, .none))
        XCTAssertEqual(d(input(open: 8)), .init(.reply, .commit, .createdReplied, capCounted: true))
        XCTAssertEqual(d(input(open: 9)), .init(.drop, .couldNotRead, .none))  // the 10th open entry
        let ten = (0 ..< 10).map { now - 3600 * Int64($0) - 1 }
        XCTAssertEqual(d(input(cap: Array(ten.prefix(9)))).action, .reply)
        XCTAssertEqual(d(input(cap: ten)), .init(.prompt, .commit, .createdPrompted))   // 11th in 24 h
        // cap rollover at 24 h
        var rolled = ten
        rolled[9] = now - 86400
        XCTAssertEqual(d(input(cap: rolled)).action, .reply)
        rolled[9] = now - 86399
        XCTAssertEqual(d(input(cap: rolled)).action, .prompt)
    }

    func testTimeoutAndHint() {
        XCTAssertEqual(PairDecide.timeout(approveVerified: true, approved: true, resend: nil), .keepPin)
        XCTAssertEqual(PairDecide.timeout(approveVerified: false, approved: false, resend: nil), .dropPin)
        XCTAssertEqual(PairDecide.timeout(approveVerified: false, approved: true, resend: nil), .resend)
        XCTAssertEqual(PairDecide.timeout(approveVerified: false, approved: true, resend: .paused), .keepWaiting)
        XCTAssertEqual(PairDecide.timeout(approveVerified: false, approved: true, resend: .cVerified), .complete)
        XCTAssertEqual(PairDecide.timeout(approveVerified: false, approved: true, resend: .other), .dropPin)
        XCTAssertEqual(PairDecide.hint(approvesMe: true, committedSeconds: 10), .stillHolds)
        XCTAssertEqual(PairDecide.hint(approvesMe: false, committedSeconds: 3 * 86400), .noReplyYet)
        XCTAssertNil(PairDecide.hint(approvesMe: nil, committedSeconds: 3 * 86400 - 1))
    }
}
