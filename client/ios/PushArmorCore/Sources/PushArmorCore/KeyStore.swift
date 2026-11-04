import Foundation
#if os(iOS) && canImport(Security)
import Security

/// Keychain storage of the two device keys and the peer id (ios sections 2, 3). Every
/// SecItem call passes the shared access group; items are
/// kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly (never backed up or migrated).
public final class KeychainKeyStore {
    public let accessGroup: String
    static let service = "com.pusharmor.keys"
    enum Item: String { case sign = "sign", encSE = "enc.se", encSoftware = "enc.sw", peerId = "peer-id" }

    public init(accessGroup: String) { self.accessGroup = accessGroup }

    func query(_ item: Item) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: KeychainKeyStore.service,
         kSecAttrAccount as String: item.rawValue, kSecAttrAccessGroup as String: accessGroup]
    }

    func read(_ item: Item) throws -> Data? { try read(query: query(item)) }

    func read(query base: [String: Any]) throws -> Data? {
        var q = base
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let st = SecItemCopyMatching(q as CFDictionary, &out)
        switch st {
        case errSecSuccess: return out as? Data
        case errSecItemNotFound: return nil
        case errSecInteractionNotAllowed: throw KeyLoadError.beforeFirstUnlock
        default: throw KeyLoadError.other(st)
        }
    }

    func write(_ item: Item, _ data: Data) throws { try write(query: query(item), data) }

    func write(query base: [String: Any], _ data: Data) throws {
        SecItemDelete(base as CFDictionary)
        var q = base
        q[kSecValueData as String] = data
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let st = SecItemAdd(q as CFDictionary, nil)
        guard st == errSecSuccess else { throw KeyLoadError.other(st) }
    }

    /// Step 2 of the NSE flow and every launch.
    public func load() throws -> DeviceKeys {
        guard let s = try read(.sign) else { throw KeyLoadError.other(errSecItemNotFound) }
        let signer: PASigner
        #if targetEnvironment(simulator)
        if SecureEnclave.isAvailable {
            signer = try SecureEnclaveSigner(blob: s)
        } else {
            signer = try SoftwareSigner(raw: s)
        }
        #else
        signer = try SecureEnclaveSigner(blob: s)
        #endif
        if let e = try read(.encSE) {
            return DeviceKeys(signer: signer, decryptor: try SecureEnclaveDecryptor(blob: e))
        }
        guard let e = try read(.encSoftware) else { throw KeyLoadError.other(errSecItemNotFound) }
        return DeviceKeys(signer: signer, decryptor: try SoftwareDecryptor(raw: e))
    }

    /// First sign-in: two SE keys with .privateKeyUsage, no biometry, usable after first
    /// unlock. The Simulator has no SE: software keys through the same code paths. The
    /// software path is compiled only for the Simulator; a device without an SE throws.
    public func create() throws -> DeviceKeys {
        guard SecureEnclave.isAvailable else {
            #if targetEnvironment(simulator)
            let s = SoftwareSigner(), e = SoftwareDecryptor()
            try write(.sign, s.key.rawRepresentation)
            try write(.encSoftware, e.key.rawRepresentation)
            return DeviceKeys(signer: s, decryptor: e)
            #else
            throw KeyLoadError.noSecureEnclave
            #endif
        }
        var err: Unmanaged<CFError>?
        guard let ac = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
                                                       .privateKeyUsage, &err) else {
            throw KeyLoadError.other(errSecParam)
        }
        let sk = try SecureEnclave.P256.Signing.PrivateKey(accessControl: ac)
        try write(.sign, sk.dataRepresentation)
        let ek = try SecureEnclave.P256.KeyAgreement.PrivateKey(accessControl: ac)
        try write(.encSE, ek.dataRepresentation)
        return DeviceKeys(signer: SecureEnclaveSigner(key: sk), decryptor: SecureEnclaveDecryptor(key: ek))
    }

    public func peerId() throws -> String? {
        guard let d = try read(.peerId) else { return nil }
        return String(data: d, encoding: .ascii)
    }

    public func savePeerId(_ id: PeerId) throws { try write(.peerId, Data(id.text.utf8)) }

    /// SecItemDelete for the access group (all three Keychain items).
    public func deleteAll() {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: KeychainKeyStore.service,
                                kSecAttrAccessGroup as String: accessGroup]
        SecItemDelete(q as CFDictionary)
    }

    func readState(_ item: Item) -> KeyBootstrap.ItemRead {
        do { return try read(item) == nil ? .missing : .present }
        catch let e as KeyLoadError { return .failed(e) }
        catch { return .failed(.other(errSecInternalError)) }
    }

    /// Launch invariant (section 3): with no me row, read the old Keychain peer id, delete
    /// every item of the group, then create keys. The old id is kept for the DELETE. A
    /// signed-in device never deletes on a failed read: it throws KeyBootstrap.Stop.
    public func bootstrap(store: Store) throws -> DeviceKeys? {
        let me = try store.me()
        var old: String?
        var peerIdItem = KeyBootstrap.ItemRead.missing
        if me.id == nil && !me.removed {
            do {
                old = try peerId()
                if old != nil { peerIdItem = .present }
            } catch let e as KeyLoadError {
                peerIdItem = .failed(e)
            } catch {
                peerIdItem = .failed(.other(errSecInternalError))
            }
        }
        let inFlight = (try? store.setting(KeyBootstrap.registerKeysSetting)) == "1"
        switch KeyBootstrap.decide(me: me, signItem: readState(.sign), peerIdItem: peerIdItem,
                                   registerInFlight: inFlight, requestTokenSet: me.requestToken != nil) {
        case .lost:
            // id set but no sign key (a wipe whose DB part failed): removed, not a launch error
            if !me.removed { try store.keysLost() }
            return nil   // keys wiped; the next sign-in creates new keys
        case .retryLater:
            throw KeyBootstrap.Stop.retryLater
        case .unusable:
            throw KeyBootstrap.Stop.unusable
        case .useExisting where me.id == nil:
            // a saved email-code step, or a register that may have reached the relay server,
            // is bound to these keys
            if let k = try? load() { return k }
            return try createFresh(store: store, oldId: old)
        case .createFresh:
            return try createFresh(store: store, oldId: old)
        case .useExisting:
            let k: DeviceKeys
            do {
                k = try load()
            } catch KeyLoadError.beforeFirstUnlock {
                throw KeyBootstrap.Stop.retryLater
            } catch {
                throw KeyBootstrap.Stop.unusable
            }
            guard KeyBootstrap.selfTest(k) else { throw KeyBootstrap.Stop.unusable }
            return k
        }
    }

    private func createFresh(store: Store, oldId: String?) throws -> DeviceKeys {
        if let old = oldId { try store.setMe("old_id", .text(old)) }
        deleteAll()
        return try create()
    }
}

/// Archived accounts: a copy of each key item under a separate service, so deleteAll never
/// touches them; the account item name is "<account id>.<item>".
extension KeychainKeyStore: AccountKeyVault {
    static let archiveService = "com.pusharmor.keys.archive"
    static let slotItems: [Item] = [.sign, .encSE, .encSoftware, .peerId]

    func archiveQuery(_ account: String, _ item: Item) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: KeychainKeyStore.archiveService,
         kSecAttrAccount as String: account + "." + item.rawValue, kSecAttrAccessGroup as String: accessGroup]
    }

    public func archiveKeys(account: String) throws {
        for item in KeychainKeyStore.slotItems {
            SecItemDelete(archiveQuery(account, item) as CFDictionary)
            if let d = try read(item) { try write(query: archiveQuery(account, item), d) }
        }
    }

    /// Every archived item is read before an active one is replaced.
    public func activateKeys(account: String?) throws {
        var copy: [(Item, Data)] = []
        if let a = account {
            for item in KeychainKeyStore.slotItems {
                if let d = try read(query: archiveQuery(a, item)) { copy.append((item, d)) }
            }
        }
        deleteAll()
        for (item, d) in copy { try write(item, d) }
    }

    public func dropArchivedKeys(account: String) {
        for item in KeychainKeyStore.slotItems { SecItemDelete(archiveQuery(account, item) as CFDictionary) }
    }
}
#endif
