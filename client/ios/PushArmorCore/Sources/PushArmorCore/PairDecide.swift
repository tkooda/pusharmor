import Foundation

/// The PURE pairing decision of X for a commit push (catalog Pairing flow step 3, rules a-e;
/// first matching rule wins). Mirrors the golden "pair_decide" section.
public enum PairDecide {
    public static let capWindow: Int64 = 86400
    public static let capMax = 10
    public static let maxOpenEntries = 9

    public enum Role: String, Sendable { case n = "N", x = "X" }
    public enum State: String, Sendable { case committed, prompted, replied, shown }
    public enum Listed: String, Sendable { case yes, afterFetch = "after_fetch", no }

    public struct Entry: Sendable {
        public var role: Role
        public var state: State
        public var cN: Data?            // X role
        public var replyAuthorized: Bool // X role
        public init(role: Role, state: State, cN: Data? = nil, replyAuthorized: Bool = false) {
            self.role = role
            self.state = state
            self.cN = cN
            self.replyAuthorized = replyAuthorized
        }
    }

    public struct Input: Sendable {
        public var ownId: PeerId
        public var fromId: PeerId
        public var commitCN: Data
        public var entry: Entry?
        public var pinned: Bool
        public var approved: Bool
        public var approveVerified: Bool
        public var approvesMe: Bool?
        public var getAfterVerify: Bool
        public var listed: Listed
        public var openEntries: Int
        public var cap: [Int64]
        public var now: Int64

        public init(ownId: PeerId, fromId: PeerId, commitCN: Data, entry: Entry?, pinned: Bool, approved: Bool,
                    approveVerified: Bool, approvesMe: Bool?, getAfterVerify: Bool, listed: Listed,
                    openEntries: Int, cap: [Int64], now: Int64) {
            self.ownId = ownId
            self.fromId = fromId
            self.commitCN = commitCN
            self.entry = entry
            self.pinned = pinned
            self.approved = approved
            self.approveVerified = approveVerified
            self.approvesMe = approvesMe
            self.getAfterVerify = getAfterVerify
            self.listed = listed
            self.openEntries = openEntries
            self.cap = cap
            self.now = now
        }
    }

    public enum Action: String, Sendable { case reply, notice, abort, prompt, drop }
    public enum Notice: String, Sendable {
        case represent, couldNotRead = "could_not_read", crossing, commit, halfState = "half_state"
    }
    public enum EntryChange: String, Sendable {
        case unchanged, aborted, nWipedXReplied = "n_wiped_x_replied", none
        case createdPrompted = "created_prompted", createdReplied = "created_replied"
    }

    public struct Output: Equatable, Sendable {
        public let action: Action
        public let notice: Notice
        public let entry: EntryChange
        public let capCounted: Bool
        public init(_ action: Action, _ notice: Notice, _ entry: EntryChange, capCounted: Bool = false) {
            self.action = action
            self.notice = notice
            self.entry = entry
            self.capCounted = capCounted
        }
    }

    /// Half state: a pinned row that offers Cancel pairing (an open entry, or a GET fetched
    /// after X's approve verified that shows approves_me false).
    public static func halfState(_ i: Input) -> Bool {
        if !i.pinned { return false }
        if i.entry != nil { return true }
        return i.approveVerified && i.getAfterVerify && i.approvesMe == false
    }

    /// Automatic replies counted in the rolling 24 h window. A stamp later than now (a clock
    /// that was set ahead) does not count.
    public static func capUsed(_ cap: [Int64], now: Int64) -> Int {
        cap.filter { inWindow($0, now: now) }.count
    }

    /// 0 <= now - t < 24 h, written so that no stamp value can overflow.
    static func inWindow(_ t: Int64, now: Int64) -> Bool { t <= now && t > now - capWindow }

    public static func decide(_ i: Input) -> Output {
        let e = i.entry
        // a. duplicate on an open X-role entry
        if let e = e, e.role == .x, let c = e.cN, c == i.commitCN {
            if e.state == .shown { return Output(.notice, .represent, .unchanged) }
            if e.replyAuthorized { return Output(.reply, .represent, .unchanged) }
            return Output(.notice, .represent, .unchanged)
        }
        // b. different c_N on an open X-role entry, before Approve
        if let e = e, e.role == .x, !i.approved { return Output(.abort, .couldNotRead, .aborted) }
        // c. own N-role entry (crossing)
        if let e = e, e.role == .n {
            if e.state == .committed {
                if i.ownId < i.fromId { return Output(.drop, .crossing, .unchanged) }
                return Output(.reply, .commit, .nWipedXReplied)
            }
            if i.approved && !i.approveVerified { return Output(.drop, .halfState, .unchanged) }
            return Output(.drop, .couldNotRead, .unchanged)
        }
        // d. pinned or approved id
        if i.pinned || i.approved {
            return Output(.drop, halfState(i) ? .halfState : .couldNotRead, .unchanged)
        }
        // e. new entry
        if i.listed == .no { return Output(.drop, .couldNotRead, .none) }
        if i.openEntries >= maxOpenEntries { return Output(.drop, .couldNotRead, .none) }
        if capUsed(i.cap, now: i.now) >= capMax { return Output(.prompt, .commit, .createdPrompted) }
        return Output(.reply, .commit, .createdReplied, capCounted: true)
    }

    /// Timeout of a pairing row (step 8).
    public enum Resend: String, Sendable {
        case offline, loggedOut = "logged out", rateLimited = "429", serverError = "5xx"
        case cVerified = "200_c_verified", other = "200_other"
    }

    public enum TimeoutAction: String, Sendable {
        case keepPin = "keep_pin", dropPin = "drop_pin", resend, keepWaiting = "keep_waiting", complete
    }

    public static func timeout(approveVerified: Bool, approved: Bool, resend: Resend?) -> TimeoutAction {
        if approveVerified { return .keepPin }
        if !approved { return .dropPin }
        guard let r = resend else { return .resend }
        switch r {
        case .cVerified: return .complete
        case .other: return .dropPin
        default: return .keepWaiting
        }
    }

    /// N-side hint on a row in state committed.
    public enum Hint: String, Sendable { case stillHolds = "still_holds", noReplyYet = "no_reply_yet" }

    public static func hint(approvesMe: Bool?, committedSeconds: Int64) -> Hint? {
        if approvesMe == true { return .stillHolds }
        if committedSeconds >= 3 * 86400 { return .noReplyYet }
        return nil
    }

    /// Seconds a sent pairing step waits for the other device's automatic answer before the row shows an error.
    public static let noReplySeconds: Int64 = 120

    /// N committed or X replied (waiting on the other device, not on a person) with no answer for
    /// noReplySeconds since waitFrom (an older entry without it: startedAt).
    public static func noReply(_ e: PairingEntry, now: Int64) -> Bool {
        let waiting = (e.role == .n && e.state == .committed) || (e.role == .x && e.state == .replied)
        return waiting && now - (e.waitFrom ?? e.startedAt) >= noReplySeconds
    }
}
