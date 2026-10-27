import Foundation

public enum KeyLoadError: Error, Equatable {
    /// errSecInteractionNotAllowed: before first unlock (ios 6.3).
    case beforeFirstUnlock
    /// Any other Keychain error, errSecItemNotFound included: a drop, never 6.3.
    case other(Int32)
}

/// The NSE didReceive flow (ios 6.1 to 6.5), free of UserNotifications so it is testable.
public enum NSEFlow {
    /// - Parameters:
    ///   - m: the "m" payload value.
    ///   - loadKeys: Keychain load (step 2).
    ///   - openCore: opens the DB and builds the core (step 3).
    ///   - budgetLeft: seconds left of the NSE budget.
    /// - Returns: the banner to deliver and whether the step 8-9 transaction committed.
    public static func handle(m: Any?, loadKeys: () throws -> DeviceKeys, openCore: (DeviceKeys?) -> Core?,
                              inbox: LockedInbox, nowMs: Int64, budgetLeft: () -> Double,
                              onReceived: ((ReceiveResult) -> Void)? = nil) async -> ReceiveResult {
        // step 1: missing, not strict b64url or > 3800 chars -> drop; event when the DB is readable
        guard let ms = m as? String, ms.utf8.count <= InnerMessage.maxWire, B64URL.isStrict(ms) else {
            return dropWithEvent(openCore(nil))
        }
        // step 2
        let keys: DeviceKeys
        do {
            keys = try loadKeys()
        } catch KeyLoadError.beforeFirstUnlock {
            do {
                try inbox.write(ms, nowMs: nowMs)
                return .plain(.locked)
            } catch {
                return .plain(.dropped)
            }
        } catch {
            return dropWithEvent(openCore(nil))
        }
        // step 3
        guard let core = openCore(keys) else { return .plain(.dropped) }
        var r = await core.receive(ms, mode: .nse)
        if r.banner == nil { r.banner = .dropped }   // never empty content for a push
        onReceived?(r)
        // 6.5: an unknown sender sets fetch_due; one GET /peers only with >= 10 s of budget left
        if (try? core.store.me().fetchDue) == true && budgetLeft() >= 10 {
            await core.fetchPeers(nse: true)
        }
        return r
    }

    static func dropWithEvent(_ core: Core?) -> ReceiveResult {
        if let c = core { return c.drop(.nse) }
        return .plain(.dropped)
    }
}
