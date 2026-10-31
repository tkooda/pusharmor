import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// JSON writer for request bodies (signed as sent).
public indirect enum JOut: Sendable {
    case str(String)
    case int(Int64)
    case bool(Bool)
    case null
    case obj([(String, JOut)])
    case arr([JOut])

    public var text: String {
        switch self {
        case .str(let s): return StrictJSON.quote(s)
        case .int(let i): return String(i)
        case .bool(let b): return b ? "true" : "false"
        case .null: return "null"
        case .obj(let m): return "{" + m.map { StrictJSON.quote($0.0) + ":" + $0.1.text }.joined(separator: ",") + "}"
        case .arr(let a): return "[" + a.map { $0.text }.joined(separator: ",") + "]"
        }
    }

    public var data: Data { Data(text.utf8) }

    /// {"$id": "$message", ..}
    public static func messages(_ m: [PeerId: String]) -> JOut {
        .obj(m.sorted { $0.key.text < $1.key.text }.map { ($0.key.text, .str($0.value)) })
    }
}

public struct HTTPResponse: Sendable {
    public var status: Int
    public var headers: [String: String]   // lowercased names
    public var body: Data
    public init(status: Int, headers: [String: String], body: Data) {
        self.status = status
        self.headers = Dictionary(uniqueKeysWithValues: headers.map { ($0.key.lowercased(), $0.value) })
        self.body = body
    }
}

public protocol HTTPTransport: Sendable {
    func perform(method: String, url: URL, headers: [String: String], body: Data, timeout: Double) async throws -> HTTPResponse
}

public struct URLSessionTransport: HTTPTransport {
    public init() {}
    public func perform(method: String, url: URL, headers: [String: String], body: Data, timeout: Double) async throws -> HTTPResponse {
        var req = URLRequest(url: url, timeoutInterval: timeout)
        req.httpMethod = method
        for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }
        if !body.isEmpty || method != "GET" { req.httpBody = body }
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let h = resp as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        var hs: [String: String] = [:]
        for (k, v) in h.allHeaderFields { hs[String(describing: k)] = String(describing: v) }
        return HTTPResponse(status: h.statusCode, headers: hs, body: data)
    }
}

/// A Worker reply.
public struct APIReply: Sendable {
    public let status: Int
    public let body: Data
    public let json: JSONValue?
    public var ok: Bool { (200 ..< 300).contains(status) }
    public var error: String? { json?["error"]?.stringValue }
    /// Clamped to 0...3600 so a bad relay reply cannot trap a sleep or a clock sum (I554).
    public var retryAfter: Int? {
        if case .number(let t)? = json?["retry_after"], let v = Int(t) { return min(max(v, 0), 3600) }
        return nil
    }
    public init(status: Int, body: Data) {
        self.status = status
        self.body = body
        self.json = try? StrictJSON.parse(body)
    }
}

public enum APIOutcome: Sendable {
    case reply(APIReply)          // any HTTP reply after the retry policy ran
    case network                  // no reply after the retry policy ran

    public var reply: APIReply? {
        if case .reply(let r) = self { return r }
        return nil
    }
    public var isClockSkew: Bool { reply?.status == 401 && reply?.error == "clock skew" }
}

/// Retries (catalog General): up to 3 retries on 429, 503 and network errors only, backoff
/// about 0.5 s, 1.5 s, 3 s, 8 s total budget; Retry-After honored when it fits the budget.
public enum RetryPolicy {
    public static let delays: [Double] = [0.5, 1.5, 3.0]
    public static let budget: Double = 8

    /// Delay before the next try, or nil to stop. status nil = network error.
    public static func delay(retriesDone: Int, status: Int?, retryAfter: Int?, elapsed: Double) -> Double? {
        if let s = status, s != 429 && s != 503 { return nil }
        guard retriesDone < delays.count else { return nil }
        var d = delays[retriesDone]
        if status == 429, let ra = retryAfter { d = Double(ra) }
        return elapsed + d <= budget ? d : nil
    }
}

/// Q349: the app version that got HTTP 426, kept so the update screen shows on every launch
/// of that version; a mark left by another version is cleared.
public enum UpdateGate {
    public static let key = "update_required"

    public static func mark(_ d: UserDefaults, version: String) { d.set(version, forKey: key) }

    public static func required(_ d: UserDefaults, version: String) -> Bool {
        guard let seen = d.string(forKey: key) else { return false }
        if seen == version { return true }
        d.removeObject(forKey: key)
        return false
    }
}

/// The Worker API client: PA-Sig signing, PA-Epoch offset (unix seconds, Q331), retry policy.
public final class APIClient: @unchecked Sendable {
    public static let defaultBase = URL(string: "https://api.pusharmor.com")!
    /// "ios/<CFBundleShortVersionString>", sent as PA-Client on every request (Q328).
    public static let defaultClient = "ios/" + ((Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "0.0.0")
    /// Posted (any thread) when the Worker answers 426: this app version is too old (Q328).
    public static let upgradeRequired = Notification.Name("PushArmorUpgradeRequired")
    let base: URL
    let client: String
    let transport: HTTPTransport
    let clockMs: @Sendable () -> Int64
    let sleep: @Sendable (Double) async -> Void
    private let lock = NSLock()
    private var _offset: Int64
    public var onOffset: (@Sendable (Int64) -> Void)?

    public init(base: URL = APIClient.defaultBase, transport: HTTPTransport = URLSessionTransport(), offsetS: Int64 = 0,
                client: String = APIClient.defaultClient,
                clockMs: @escaping @Sendable () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) },
                sleep: @escaping @Sendable (Double) async -> Void = { try? await Task.sleep(nanoseconds: UInt64($0 * 1e9)) }) {
        self.base = base
        self.client = client
        self.transport = transport
        self._offset = offsetS
        self.clockMs = clockMs
        self.sleep = sleep
    }

    /// Worker clock minus local clock, in seconds.
    public var offsetS: Int64 {
        lock.lock(); defer { lock.unlock() }
        return _offset
    }

    func setOffset(_ o: Int64) {
        lock.lock()
        _offset = o
        lock.unlock()
        onOffset?(o)
    }

    /// Estimate of Worker time in ms (PA-Time stays ms).
    public var workerNowMs: Int64 { clockMs() + offsetS * 1000 }

    public enum Auth {
        case none
        /// PA-Time + PA-Sig; PA-ID when the id is given.
        case signed(PASigner, PeerId?)
    }

    /// One call. `path` is the full signed path, starting with /v1. `retry` false = one try.
    public func call(_ method: String, _ path: String, body: Data = Data(), auth: Auth, retry: Bool = true,
                     timeout: Double = 15) async -> APIOutcome {
        let start = clockMs()
        var retries = 0
        while true {
            var headers = ["Content-Type": "application/json", "PA-Client": client]
            if case .signed(let signer, let id) = auth {
                if let h = try? RequestSigning.headers(signer: signer, peerId: id, method: method, path: path,
                                                       timeMs: workerNowMs, body: body) {
                    headers.merge(h) { $1 }
                }
            }
            var status: Int? = nil
            var reply: APIReply? = nil
            do {
                let r = try await transport.perform(method: method, url: URL(string: path, relativeTo: base)!.absoluteURL,
                                                    headers: headers, body: body, timeout: timeout)
                if let e = r.headers["pa-epoch"], let sec = Int64(e) { setOffset(sec - clockMs() / 1000) }
                if r.status == 426 { NotificationCenter.default.post(name: APIClient.upgradeRequired, object: self) }
                reply = APIReply(status: r.status, body: r.body)
                status = r.status
            } catch {
                status = nil
            }
            let elapsed = Double(clockMs() - start) / 1000
            guard retry, let d = RetryPolicy.delay(retriesDone: retries, status: status, retryAfter: reply?.retryAfter,
                                                   elapsed: elapsed) else {
                return reply.map { .reply($0) } ?? .network
            }
            retries += 1
            await sleep(d)
        }
    }
}
