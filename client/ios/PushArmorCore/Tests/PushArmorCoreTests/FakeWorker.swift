import XCTest
@testable import PushArmorCore

/// An in-memory stand-in for the Worker: verifies PA-Sig, keeps allow / deny / name /
/// pending per peer, relays pair, approve, deny and send messages into per-peer inboxes.
final class FakeWorker: HTTPTransport, @unchecked Sendable {
    struct Row {
        var id: PeerId
        var signPub: Data
        var encPub: Data
        var platform = "android"
        var created: Int64 = 1761300000
        var allow: [String: Bool] = [:]
        var deny: [String: Bool] = [:]
        var name: [String: String] = [:]
        var pending: [String: String] = [:]
        var loggedOut = false
        var push = true
        var listening: Bool? = nil     // set only for platform "cli"
    }

    let lock = NSLock()
    var rows: [String: Row] = [:]
    var inbox: [String: [String]] = [:]
    var calls: [(String, String)] = []
    var lastHeaders: [String: String] = [:]
    /// Scripted replies: path prefix -> list of (status, body) used once each, before normal handling.
    var scripted: [(method: String, prefix: String, status: Int, body: String)] = []
    var epoch: Int64 = 1761300000
    var offline = false
    /// Stored remove messages handed out by GET /v1/peers: receiver id -> removed id -> sealed message.
    var removed: [String: [String: String]] = [:]

    func add(_ id: PeerId, signPub: Data, encPub: Data, platform: String = "android") {
        lock.lock(); defer { lock.unlock() }
        rows[id.text] = Row(id: id, signPub: signPub, encPub: encPub, platform: platform)
    }

    func take(_ id: PeerId) -> [String] {
        lock.lock(); defer { lock.unlock() }
        let m = inbox[id.text] ?? []
        inbox[id.text] = []
        return m
    }

    func script(_ method: String, _ prefix: String, _ status: Int, _ body: String) {
        lock.lock(); defer { lock.unlock() }
        scripted.append((method, prefix, status, body))
    }

    func count(_ method: String, _ prefix: String) -> Int {
        lock.lock(); defer { lock.unlock() }
        return calls.filter { $0.0 == method && $0.1.hasPrefix(prefix) }.count
    }

    func reply(_ status: Int, _ body: String) -> HTTPResponse {
        HTTPResponse(status: status, headers: ["PA-Epoch": String(epoch)], body: Data(body.utf8))
    }

    func perform(method: String, url: URL, headers: [String: String], body: Data, timeout: Double) async throws -> HTTPResponse {
        lock.lock(); defer { lock.unlock() }
        if offline { throw URLError(.notConnectedToInternet) }
        let path = url.path
        calls.append((method, path))
        lastHeaders = headers
        if let i = scripted.firstIndex(where: { $0.method == method && path.hasPrefix($0.prefix) }) {
            let s = scripted.remove(at: i)
            return reply(s.status, s.body)
        }
        let j = (try? StrictJSON.parse(body)) ?? .object([])
        // POST /v1/peers: register (keys in body)
        if method == "POST" && path == "/v1/peers" { return reply(500, "{}") }
        guard let idT = headers["PA-ID"], var me = rows[idT], let sigT = headers["PA-Sig"], let sig = B64URL.decode(sigT),
              let t = headers["PA-Time"],
              RequestSigning.verify(method: method, path: path, paTime: t, body: body, sig: sig, signPub: me.signPub) else {
            return reply(401, "{\"error\":\"invalid client signature\"}")
        }
        let parts = path.split(separator: "/").map(String.init)   // ["v1", ...]
        func relay(_ to: String, _ c: String) { inbox[to, default: []].append(c) }
        func allowCovered(_ m: JSONValue?) -> [String]? {
            let keys = Set(m?.objectMembers?.map { $0.0 } ?? [])
            let missing = me.allow.keys.filter { !keys.contains($0) }.sorted()
            return missing.isEmpty ? nil : missing
        }
        let withdraw = method == "POST" && parts.count == 3 && parts[1] == "deny" && j["withdraw"] != nil
        if me.loggedOut && !withdraw && !(parts.count == 4 && parts[3] == "login") {
            return reply(401, "{\"error\":\"logged out\"}")
        }
        switch (method, parts.count > 1 ? parts[1] : "") {
        case ("GET", "peers"):
            var list: [JOut] = []
            for r in rows.values.sorted(by: { $0.id.text < $1.id.text }) where r.id.account == me.id.account {
                var e: [(String, JOut)] = [("id", .str(r.id.text)), ("sign_pub", .str(B64URL.encode(r.signPub))),
                                  ("enc_pub", .str(B64URL.encode(r.encPub))), ("platform", .str(r.platform)),
                                  ("created", .int(r.created)), ("logged_out", .bool(r.loggedOut)),
                                  ("approves", .int(Int64(r.allow.count))), ("approved_by", .int(0)),
                                  ("approves_me", .bool(r.allow[idT] != nil)), ("denies_me", .bool(r.deny[idT] != nil)),
                                  ("reachable", .bool(r.push)), ("name_for_me", r.name[idT].map { .str($0) } ?? .null)]
                if let l = r.listening { e.append(("listening", .bool(l))) }
                list.append(.obj(e))
            }
            var top: [(String, JOut)] = [("my_push_sha256", .null), ("my_allow", .arr(me.allow.keys.sorted().map { .str($0) })),
                                         ("peers", .arr(list))]
            if let rm = removed[idT], !rm.isEmpty {
                top.append(("removed", .obj(rm.keys.sorted().map { ($0, JOut.str(rm[$0]!)) })))
            }
            return reply(200, JOut.obj(top).text)
        case ("POST", "pair"):
            let x = parts[2]
            guard let xr = rows[x] else { return reply(200, "{\"r\":\"unknown\"}") }
            if xr.deny[idT] != nil { return reply(200, "{\"r\":\"denied\"}") }
            relay(x, j["c"]!.stringValue!)
            return reply(200, "{\"r\":\"sent\"}")
        case ("POST", "approve"):
            let x = parts[2]
            guard var xr = rows[x] else { return reply(200, "{\"r\":\"unknown\"}") }
            if xr.deny[idT] != nil { return reply(200, "{\"r\":\"denied\"}") }
            let c = j["c"]!.stringValue!
            me.allow[x] = true; me.deny[x] = nil; me.name[x] = j["name"]?.stringValue; me.pending[x] = c
            rows[idT] = me
            if xr.allow[idT] != nil {
                relay(x, c)
                xr = rows[x]!
                let back = xr.pending[idT].map { ",\"c\":\"\($0)\"" } ?? ""
                return reply(200, "{\"r\":\"sent\"\(back)}")
            }
            return reply(200, "{\"r\":\"stored\"}")
        case ("POST", "deny"):
            let x = parts[2]
            if withdraw {
                me.allow[x] = nil; me.name[x] = nil; me.pending[x] = nil
                rows[idT] = me
                return reply(200, "{\"r\":\"unapproved\"}")
            }
            me.deny[x] = true; me.allow[x] = nil; me.name[x] = nil; me.pending[x] = nil
            rows[idT] = me
            guard let xr = rows[x], xr.allow[idT] != nil else { return reply(200, "{\"r\":\"unapproved\"}") }
            relay(x, j["c"]!.stringValue!)
            return reply(200, "{\"r\":\"sent\"}")
        case ("POST", "send"):
            var res: [(String, JOut)] = []
            for (k, v) in j["m"]?.objectMembers ?? [] {
                guard let xr = rows[k] else { res.append((k, .str("unknown"))); continue }
                if xr.deny[idT] != nil { res.append((k, .str("denied"))); continue }
                if xr.allow[idT] == nil { res.append((k, .str("unapproved"))); continue }
                if xr.loggedOut { res.append((k, .str("logged out"))); continue }
                if xr.listening == false { res.append((k, .str("not listening"))); continue }
                if !xr.push { res.append((k, .str("gone"))); continue }
                relay(k, v.stringValue!)
                res.append((k, .str("sent")))
            }
            return reply(200, JOut.obj([("r", .obj(res))]).text)
        case ("POST", "peers") where parts.count == 4:
            if let missing = allowCovered(j["m"]) {
                return reply(400, JOut.obj([("error", .str("messages missing")), ("ids", .arr(missing.map { .str($0) }))]).text)
            }
            for (k, v) in j["m"]?.objectMembers ?? [] where rows[k] != nil { relay(k, v.stringValue!) }
            me.loggedOut = parts[3] == "logout"
            rows[idT] = me
            return reply(200, "{\"r\":{}}")
        case ("PATCH", "peers"):
            if j["push"] != nil { return reply(200, "{}") }
            if let missing = allowCovered(j["m"]) {
                return reply(400, JOut.obj([("error", .str("messages missing")), ("ids", .arr(missing.map { .str($0) }))]).text)
            }
            for (k, v) in j["name"]?.objectMembers ?? [] where me.allow[k] != nil { me.name[k] = v.stringValue }
            rows[idT] = me
            for (k, v) in j["m"]?.objectMembers ?? [] where rows[k] != nil { relay(k, v.stringValue!) }
            return reply(200, "{\"r\":{}}")
        case ("DELETE", "peers"):
            let x = parts[2]
            for (k, v) in j["m"]?.objectMembers ?? [] where rows[k] != nil { relay(k, v.stringValue!) }
            rows[x] = nil
            for k in rows.keys {
                rows[k]!.allow[x] = nil; rows[k]!.deny[x] = nil; rows[k]!.name[x] = nil; rows[k]!.pending[x] = nil
            }
            return reply(200, "{\"r\":{}}")
        default:
            return reply(404, "{\"error\":\"not found\"}")
        }
    }
}

/// A test clock shared by the cores of one scenario.
final class TestClock: @unchecked Sendable {
    var now: Int64 = 1761300000
}

/// One device in a scenario: its own store file, keys, Core, and the shared fake Worker.
final class Device {
    let core: Core
    let id: PeerId
    let keys: DeviceKeys
    let path: String
    static var counter = 0

    init(worker: FakeWorker, clock: TestClock, account: Data = Data(repeating: 3, count: 9), name: String, platform: String = "android",
         path: String? = nil, keys: DeviceKeys? = nil) throws {
        let k = keys ?? DeviceKeys(signer: SoftwareSigner(), decryptor: SoftwareDecryptor())
        self.keys = k
        Device.counter += 1
        self.path = path ?? NSTemporaryDirectory() + "pa-test-\(ProcessInfo.processInfo.processIdentifier)-\(Device.counter)-\(UUID().uuidString).sqlite"
        let store = try Store(path: self.path)
        let api = APIClient(base: URL(string: "https://api.test")!, transport: worker,
                            clockMs: { clock.now * 1000 }, sleep: { _ in })
        core = Core(store: store, api: api, keys: k, clock: { clock.now })
        id = testId(account: account, signPub: k.signer.publicKey, encPub: k.decryptor.publicKey)
        if path == nil {
            try store.setMe("id", .text(id.text))
            try store.setMe("name", .text(name))
            worker.add(id, signPub: k.signer.publicKey, encPub: k.decryptor.publicKey, platform: platform)
        }
    }

    /// Process every queued push like the NSE does; returns the banners.
    @discardableResult
    func drainInbox(_ w: FakeWorker) async -> [ReceiveResult] {
        var out: [ReceiveResult] = []
        for m in w.take(id) { out.append(await core.receive(m, mode: .nse)) }
        return out
    }
}

/// Shared pairing steps for scenario tests.
enum Scenario {
    /// Steps 1-5: commit, automatic reply, open. Both sides end in state shown.
    static func pairToShown(_ w: FakeWorker, _ n: Device, _ x: Device) async throws {
        await n.core.fetchPeers(force: true)
        await x.core.fetchPeers(force: true)
        let v1 = try await n.core.startPair(x.id)
        XCTAssertEqual(v1, .sent)
        let r1 = await x.drainInbox(w)
        XCTAssertEqual(r1.first?.banner?.body, S.pairCommit)
        let r2 = await n.drainInbox(w)
        XCTAssertEqual(r2.first?.banner?.body, S.pairReply)
        let r3 = await x.drainInbox(w)
        let fpN = try n.core.store.peer(x.id)!.fingerprint!
        let fpX = try x.core.store.peer(n.id)!.fingerprint!
        XCTAssertEqual(fpN, fpX)
        XCTAssertEqual(r3.first?.banner?.body, S.pairOpen(fpX))
        XCTAssertEqual(r3.first?.banner?.threadId, r1.first?.banner?.threadId)   // open replaces the commit notice (pk)
        XCTAssertEqual(try n.core.store.pairing(x.id)?.state, .shown)
        XCTAssertEqual(try x.core.store.pairing(n.id)?.state, .shown)
        XCTAssertEqual(try n.core.store.peer(x.id)!.pairingId, try x.core.store.peer(n.id)!.pairingId)
    }

    /// Steps 6-7: X approves first (stored), N second (relayed, gets c back).
    static func pairFully(_ w: FakeWorker, _ n: Device, _ x: Device) async throws {
        try await pairToShown(w, n, x)
        let v2 = await x.core.approve(n.id)
        XCTAssertEqual(v2, .stored)
        let v3 = await n.core.approve(x.id)
        XCTAssertEqual(v3, .completed)
        await x.drainInbox(w)
        XCTAssertTrue(try n.core.store.peer(x.id)!.approveVerified)
        XCTAssertTrue(try x.core.store.peer(n.id)!.approveVerified)
        XCTAssertNil(try n.core.store.pairing(x.id))
        XCTAssertNil(try x.core.store.pairing(n.id))
        XCTAssertEqual(try n.core.store.peer(x.id)!.name, "Xdev")
        XCTAssertEqual(try x.core.store.peer(n.id)!.name, "Ndev")
    }

}
