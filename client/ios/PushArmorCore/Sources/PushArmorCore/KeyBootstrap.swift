import Foundation

/// The launch decision for the device keys, free of the Keychain so it is testable. A
/// Keychain read that fails is never a reason to delete keys.
public enum KeyBootstrap {
    /// The outcome of one Keychain item read.
    public enum ItemRead: Equatable {
        case present
        case missing
        case failed(KeyLoadError)
    }

    public enum Plan: Equatable {
        /// no account on this device: delete what is left and make new keys
        case createFresh
        /// load the saved keys
        case useExisting
        /// no keys to use: removed, or the sign key is gone
        case lost
        /// the keys are there but do not work
        case unusable
        /// a passing Keychain fault (before first unlock): change nothing, try again later
        case retryLater
    }

    /// Thrown by the launch when the keys cannot be used now.
    public enum Stop: Error, Equatable {
        case unusable
        case retryLater
    }

    /// Store setting: "1" while a register call with the current keys may have reached the
    /// relay server; its keys are kept across a kill so the next register heals the same id.
    public static let registerKeysSetting = "register_keys"

    /// peerIdItem is the read of the old peer id; it matters only with no account.
    public static func decide(me: Me, signItem: ItemRead, peerIdItem: ItemRead, registerInFlight: Bool,
                              requestTokenSet: Bool) -> Plan {
        if me.removed { return .lost }
        if me.id == nil {
            if signItem == .failed(.beforeFirstUnlock) { return .retryLater }
            if (requestTokenSet || registerInFlight) && signItem == .present { return .useExisting }
            // the old id is needed for the DELETE of the old device: keep the keys until it reads
            if case .failed = peerIdItem { return .retryLater }
            return .createFresh
        }
        switch signItem {
        case .missing: return .lost
        case .failed(.beforeFirstUnlock): return .retryLater
        case .failed: return .unusable
        case .present: return .useExisting
        }
    }

    /// The loaded keys still sign and open: a fixed message is signed and verified, and a
    /// 1-byte message sealed to the enc key is opened again.
    public static func selfTest(_ keys: DeviceKeys) -> Bool {
        let msg = Data(repeating: 0x5A, count: 32)
        guard let sig = try? keys.signer.sign(msg),
              Signatures.verify(sig, data: msg, publicKey: keys.signer.publicKey) else { return false }
        let one = Data([0x01]), info = Data("pusharmor key check".utf8)
        guard let wire = try? HPKEWire.seal(one, to: keys.decryptor.publicKey, info: info, aad: Data()),
              let back = try? keys.decryptor.hpkeOpen(wire: wire, info: info, aad: Data()) else { return false }
        return back == one
    }
}
