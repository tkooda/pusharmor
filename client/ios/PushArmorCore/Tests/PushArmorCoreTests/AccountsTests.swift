import XCTest
@testable import PushArmorCore

/// An in-memory stand-in for the Keychain: active key items and archived copies.
final class FakeVault: AccountKeyVault {
    var active: [String: Data] = [:]
    var archive: [String: [String: Data]] = [:]
    var failActivate = false

    func archiveKeys(account: String) throws { archive[account] = active }

    func activateKeys(account: String?) throws {
        active = [:]   // a failure part way leaves the active items gone
        if failActivate { failActivate = false; throw DBError.sql(10, "keychain") }
        active = account.flatMap { archive[$0] } ?? [:]
    }

    func dropArchivedKeys(account: String) { archive[account] = nil }

    /// A fresh key set as the active items (sign-in with new keys).
    func create() -> DeviceKeys {
        let s = SoftwareSigner(), e = SoftwareDecryptor()
        active = ["sign": s.key.rawRepresentation, "enc": e.key.rawRepresentation]
        return DeviceKeys(signer: s, decryptor: e)
    }

    func load() throws -> DeviceKeys {
        guard let s = active["sign"], let e = active["enc"] else { throw StoreError.noIdentity }
        return DeviceKeys(signer: try SoftwareSigner(raw: s), decryptor: try SoftwareDecryptor(raw: e))
    }
}

final class AccountsTests: XCTestCase {
    var w: FakeWorker!
    var clock: TestClock!
    var vault: FakeVault!
    var path: String!
    var store: Store!
    let acctA = Data(repeating: 1, count: 9)
    let acctB = Data(repeating: 2, count: 9)

    override func setUp() {
        w = FakeWorker()
        clock = TestClock()
        vault = FakeVault()
        path = NSTemporaryDirectory() + "pa-acct-\(UUID().uuidString).sqlite"
        store = try! Store(path: path)
    }

    var accounts: Accounts { Accounts(store: store, vault: vault) }

    func core(_ keys: DeviceKeys? = nil) throws -> Core {
        let c = clock!
        let api = APIClient(base: URL(string: "https://api.test")!, transport: w, clockMs: { c.now * 1000 }, sleep: { _ in })
        return Core(store: store, api: api, keys: try keys ?? vault.load(), clock: { c.now })
    }

    /// Register as the app does: fresh active keys, the ticket email, POST /v1/peers.
    func register(_ email: String, account: Data, name: String) async throws -> (PeerId, DeviceKeys) {
        let k = vault.create()
        let id = testId(account: account, signPub: k.signer.publicKey, encPub: k.decryptor.publicKey)
        w.add(id, signPub: k.signer.publicKey, encPub: k.decryptor.publicKey, platform: "ios")
        w.script("POST", "/v1/peers", 200, JOut.obj([("id", .str(id.text)), ("peers", .arr([]))]).text)
        XCTAssertNil(try accounts.beforeRegister(ticketEmail: email))
        try store.setMe("signed_in_email", .text(email))
        let c = try core(k)
        guard case .registered(let got) = await c.register(ticket: "t", push: nil) else {
            XCTFail("register failed")
            return (id, k)
        }
        XCTAssertEqual(got, id)
        vault.active["peer-id"] = Data(id.text.utf8)
        try store.setMe("name", .text(name))
        return (id, k)
    }

    func logout() async throws {
        let out = try await core().logout()
        XCTAssertEqual(out.reply?.status, 200)
    }

    func historyContents() throws -> [String] { try store.history().map { $0.content } }

    /// A registers and pairs, logs out; an email login as B makes new keys and an account
    /// of its own; B logs out; an email login as A brings back A's keys, id, peers,
    /// history, and settings, with B archived intact. A can then log in and send.
    func testEmailLoginSwitchesBetweenAccounts() async throws {
        let (idA, keysA) = try await register("a@x.com", account: acctA, name: "Ndev")
        let n = try Device(worker: w, clock: clock, account: acctA, name: "Ndev", path: path, keys: keysA)
        let x = try Device(worker: w, clock: clock, account: acctA, name: "Xdev")
        try await Scenario.pairFully(w, n, x)
        let c = try core()
        _ = try await c.send("from A", as: .text, to: [x.id], allCount: 1)
        try store.setSetting(SettingKey.historyDays, "7")
        let tap = try TapStamp.key(store)
        try await logout()
        let pinA = try XCTUnwrap(store.peer(x.id))

        // login as B on the logged-out screen: a new account, register
        let next = try accounts.beforeEmail(" B@x.com ", purpose: .login)
        XCTAssertEqual(next.purpose, .register)
        XCTAssertTrue(next.switched)
        XCTAssertNil(try store.me().id)
        XCTAssertNil(try store.me().signedInEmail)
        XCTAssertEqual(try store.peers().count, 0)
        XCTAssertEqual(try historyContents(), [])
        XCTAssertNil(try store.setting(SettingKey.historyDays))
        XCTAssertEqual(try TapStamp.key(store), tap)   // device state stays
        XCTAssertTrue(vault.active.isEmpty)
        XCTAssertTrue(try accounts.isArchived(Accounts.accountId(idA)))
        let (idB, keysB) = try await register("b@x.com", account: acctB, name: "Bdev")
        XCTAssertNotEqual(keysB.signer.publicKey, keysA.signer.publicKey)
        try store.addMessage(dir: .outgoing, peer: idB, type: "text", content: "from B", n: nil, pairingId: nil, read: true,
                             results: nil, now: clock.now)
        try await logout()

        // login as A: A's account comes back
        let back = try accounts.beforeEmail("a@x.com", purpose: .login)
        XCTAssertEqual(back.purpose, .login)
        XCTAssertTrue(back.switched)
        let me = try store.me()
        XCTAssertEqual(me.id, idA)
        XCTAssertEqual(me.name, "Ndev")
        XCTAssertNil(me.signedInEmail)   // the archive held no plain address
        XCTAssertTrue(me.loggedOut)
        XCTAssertEqual(try vault.load().signer.publicKey, keysA.signer.publicKey)
        XCTAssertEqual(try vault.load().decryptor.publicKey, keysA.decryptor.publicKey)
        XCTAssertEqual(vault.active["peer-id"], Data(idA.text.utf8))
        let pin = try XCTUnwrap(store.peer(x.id))
        XCTAssertEqual(pin.pairingId, pinA.pairingId)
        XCTAssertEqual(pin.lastN, pinA.lastN)
        XCTAssertEqual(pin.name, "Xdev")
        XCTAssertEqual(try store.allowSet(), [x.id.text])
        XCTAssertEqual(try historyContents(), ["from A"])
        XCTAssertEqual(try store.setting(SettingKey.historyDays), "7")
        XCTAssertEqual(try TapStamp.key(store), tap)
        // B archived intact
        XCTAssertTrue(try accounts.isArchived(Accounts.accountId(idB)))
        XCTAssertEqual(vault.archive[Accounts.accountId(idB)]?["sign"], keysB.signer.privateRaw)
        XCTAssertNil(vault.archive[Accounts.accountId(idA)])
        XCTAssertNil(try accounts.archived(email: "a@x.com"))
        XCTAssertEqual(try accounts.archived(email: "b@x.com"), Accounts.accountId(idB))

        // A logs in and sends again with its pins
        let out = await accounts.login(core: try core(), ticket: "t", email: "a@x.com", push: nil)
        XCTAssertEqual(out, .loggedIn)
        let rep = try await core().send("again", as: .text, to: [x.id], allCount: 1)
        XCTAssertEqual(rep.sent, 1)
        let got = await x.drainInbox(w)
        XCTAssertTrue(got.contains { $0.newMessage })

        // and B comes back the same way, with its own history
        try await logout()
        XCTAssertEqual(try accounts.beforeEmail("b@x.com", purpose: .login).purpose, .login)
        XCTAssertEqual(try store.me().id, idB)
        XCTAssertEqual(try historyContents(), ["from B"])
        XCTAssertEqual(try vault.load().signer.publicKey, keysB.signer.publicKey)
    }

    /// Google: the login gets 401 "account mismatch" naming B. With B archived, this device
    /// switches to B (T1); the second login works. With no archive, it switches to a new
    /// account; the second sign-in registers.
    func testGoogleMismatchSwitchesAndSecondLoginWorks() async throws {
        let (idA, _) = try await register("a@x.com", account: acctA, name: "Adev")
        try await logout()
        _ = try accounts.beforeEmail("b@x.com", purpose: .login)
        let (idB, keysB) = try await register("b@x.com", account: acctB, name: "Bdev")
        try await logout()
        _ = try accounts.beforeEmail("a@x.com", purpose: .login)
        XCTAssertEqual(try store.me().id, idA)

        // archived account
        w.script("POST", "/v1/peers/\(idA.text)/login", 401,
                 "{\"error\":\"account mismatch\",\"account\":\"\(Accounts.accountId(idB))\"}")
        let first = await accounts.login(core: try core(), ticket: "t", email: "b@x.com", push: nil)
        XCTAssertEqual(first, .switched(.otherLogin(email: "b@x.com")))
        XCTAssertEqual(ErrorCopy.text(.loginGoogle, .otherLogin(email: "b@x.com")),
                       "Unable to log in with Google.\nTo finish logging in as \"b@x.com\", log in again.")
        XCTAssertEqual(try store.me().id, idB)
        XCTAssertNil(try store.me().signedInEmail)
        XCTAssertEqual(try vault.load().signer.publicKey, keysB.signer.publicKey)
        XCTAssertTrue(try accounts.isArchived(Accounts.accountId(idA)))
        let second = await accounts.login(core: try core(), ticket: "t", email: "b@x.com", push: nil)
        XCTAssertEqual(second, .loggedIn)
        XCTAssertFalse(try store.me().loggedOut)
        XCTAssertFalse(w.rows[idB.text]!.loggedOut)

        // new account: a ticket of an account this device never had
        try await logout()
        let acctC = String(repeating: "C", count: 12)
        w.script("POST", "/v1/peers/\(idB.text)/login", 401, "{\"error\":\"account mismatch\",\"account\":\"\(acctC)\"}")
        let third = await accounts.login(core: try core(), ticket: "t", email: "c@x.com", push: nil)
        XCTAssertEqual(third, .switched(.otherLogin(email: "c@x.com")))
        XCTAssertNil(try store.me().id)
        XCTAssertTrue(vault.active.isEmpty)
        XCTAssertTrue(try accounts.isArchived(Accounts.accountId(idA)))
        XCTAssertTrue(try accounts.isArchived(Accounts.accountId(idB)))
        let (idC, _) = try await register("c@x.com", account: Data(repeating: 9, count: 9), name: "Cdev")
        XCTAssertEqual(try store.me().id, idC)
        XCTAssertFalse(try store.me().loggedOut)

        // no account known before: T1; any other mismatch: T3
        XCTAssertEqual(ErrorCopy.Reason.otherLogin(email: "b@x.com").line,
                       "To finish logging in as \"b@x.com\", log in again.")
        XCTAssertEqual(ErrorCopy.reason(status: 401, error: "account mismatch"), .otherAccount)
        XCTAssertEqual(ErrorCopy.Reason.otherAccount.line, "This login is for another account.")
    }

    /// A store written by the version before multiple accounts (no archive table) is the
    /// active account as it is: it survives a switch out and back, row for row.
    func testOldLayoutSurvivesSwitchOutAndBack() throws {
        let id = TestPeer(account: acctA).id, x = TestPeer(account: acctA).id
        let old = try Store(path: path)
        try old.db.write {
            try old.setMe("id", .text(id.text))
            try old.setMe("logged_out", .int(1))
            try old.setMe("signed_in_email", .text("A@x.com"))
            try old.setMe("name", .text("Old"))
            try old.setMe("sign_pub", .blob(Data([1, 2, 3])))
            try old.db.exec("INSERT INTO peers (id, name, pairing_id, sign_pub, enc_pub, last_n) VALUES (?, 'Xdev', ?, ?, ?, 4)",
                            [.text(x.text), .blob(Data(repeating: 5, count: 16)), .blob(Data([6])), .blob(Data([7]))])
            try old.db.exec("INSERT INTO pairing (peer_id, role, state, r, started_at) VALUES (?, 'initiator', 'shown', ?, 9)",
                            [.text(x.text), .blob(Data(repeating: 8, count: 32))])
            try old.db.exec("INSERT INTO replay (peer_id, pairing_id, h, bitmap) VALUES (?, ?, 3, ?)",
                            [.text(x.text), .blob(Data(repeating: 5, count: 16)), .blob(Data([0xff]))])
            try old.db.exec("INSERT INTO history (dir, peer_id, type, content, created_local) VALUES ('in', ?, 'text', 'hello', 10)",
                            [.text(x.text)])
            try old.db.exec("INSERT INTO allow_set (id) VALUES (?)", [.text(x.text)])
            try old.setSetting("show_all", "0")
            try old.setSetting("tap_key", "device-key")
        }
        XCTAssertNil(try old.db.one("SELECT name FROM sqlite_master WHERE name = 'archive'"))
        vault.active = ["sign": Data([1]), "enc": Data([2]), "peer-id": Data(id.text.utf8)]
        func rows() throws -> [String] {
            try Accounts.slotTables.flatMap { t in try old.db.query("SELECT * FROM \(t)").map { "\(t) \($0.values.sorted { $0.key < $1.key })" } }.sorted()
        }
        let before = try rows()

        store = try Store(path: path)
        XCTAssertEqual(try accounts.beforeEmail("b@x.com", purpose: .login).purpose, .register)
        XCTAssertNil(try store.me().id)
        XCTAssertEqual(try store.setting("tap_key"), "device-key")
        XCTAssertEqual(try accounts.archived(email: "a@x.com"), Accounts.accountId(id))
        let back = try accounts.beforeEmail("a@x.com", purpose: .register)
        XCTAssertEqual(back.purpose, .login)
        XCTAssertEqual(try rows(), before)
        XCTAssertEqual(vault.active, ["sign": Data([1]), "enc": Data([2]), "peer-id": Data(id.text.utf8)])
    }

    /// Delete account with a ticket for another address: T2, and no relay server call.
    func testDeleteAccountWithAnotherLoginMakesNoCall() async throws {
        let (idA, _) = try await register("a@x.com", account: acctA, name: "Adev")
        let calls = w.calls.count
        let r = await accounts.deleteAccount(core: try core(), ticket: "t", email: "b@x.com")
        XCTAssertEqual(r, .deleteOtherAccount(email: "b@x.com"))
        XCTAssertEqual(ErrorCopy.text(.deleteAccount, r!),
                       "Unable to delete the account.\nThis login is for \"b@x.com\", not the account on this device. Log in with the account you want to delete.")
        XCTAssertEqual(w.calls.count, calls)
        XCTAssertEqual(try store.me().id, idA)
        XCTAssertFalse(try store.me().removed)
        XCTAssertEqual(try store.me().signedInEmail, "a@x.com")
        // the same address deletes
        w.script("DELETE", "/v1/account", 200, "{}")
        let ok = await accounts.deleteAccount(core: try core(), ticket: "t", email: "A@x.com")
        XCTAssertNil(ok)
        XCTAssertEqual(w.count("DELETE", "/v1/account"), 1)
    }

    /// The archive holds a hash of the address, never the address; a plain one from an earlier version is hashed.
    func testArchiveHoldsNoPlainEmail() async throws {
        let (idA, _) = try await register("a@x.com", account: acctA, name: "Adev")
        try await logout()
        try accounts.switchTo(nil)
        func archiveText() throws -> String {
            try store.db.query("SELECT email, data FROM archive").map { ($0.text("email") ?? "") + String(decoding: $0.blob("data") ?? Data(), as: UTF8.self) }.joined()
        }
        XCTAssertFalse(try archiveText().contains("a@x.com"))
        try store.db.exec("UPDATE archive SET email = ?", [.text("a@x.com")])
        XCTAssertEqual(try accounts.archived(email: "a@x.com"), Accounts.accountId(idA))
        XCTAssertFalse(try store.db.query("SELECT email FROM archive").contains { ($0.text("email") ?? "").contains("@") })
    }

    /// Keys with no id (the register reply was lost) are archived on a switch, not deleted.
    func testKeysWithoutIdSurviveSwitch() throws {
        _ = vault.create()
        let keys = vault.active
        XCTAssertFalse(keys.isEmpty)
        try accounts.switchTo(nil)
        XCTAssertTrue(vault.active.isEmpty)
        XCTAssertTrue(vault.archive.values.contains(keys))
    }

    /// Never a switch while logged in; a failed switch keeps every copy and the active keys.
    func testSwitchRefusedWhileLoggedInAndFailureKeepsAll() async throws {
        let (idA, keysA) = try await register("a@x.com", account: acctA, name: "Adev")
        XCTAssertThrowsError(try accounts.switchTo(nil)) { XCTAssertEqual($0 as? Accounts.SwitchError, .signedIn) }
        XCTAssertEqual(try accounts.beforeEmail("b@x.com", purpose: .login).switched, false)
        try await logout()
        vault.failActivate = true
        XCTAssertThrowsError(try accounts.beforeEmail("b@x.com", purpose: .login))
        XCTAssertFalse(vault.failActivate)
        XCTAssertEqual(try store.me().id, idA)
        XCTAssertEqual(try vault.load().signer.publicKey, keysA.signer.publicKey)
        XCTAssertNil(try accounts.archived(email: "a@x.com"))
    }
}

extension PASigner {
    var privateRaw: Data? { (self as? SoftwareSigner)?.key.rawRepresentation }
}
