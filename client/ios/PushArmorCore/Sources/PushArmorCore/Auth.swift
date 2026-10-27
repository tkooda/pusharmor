import Foundation

/// Sign-in calls (catalog Auth, unsigned) and the client-side helpers.
public enum AuthPurpose: String, Sendable { case register, unpause, deleteAccount = "delete-account" }

public enum AuthResult: Sendable, Equatable {
    case ticket(ticket: String, email: String)
    case requestToken(String)
    case badEmail            // "Only email addresses with plain ASCII characters are supported."
    case emailSendFailed     // 502: "could not send the email, try again"
    case rateLimited(Int)
    case failed(Int, String?)
    case network
}

public struct PKCE: Sendable {
    public let verifier: String
    public let challenge: String   // S256

    public init(verifier: String) {
        self.verifier = verifier
        self.challenge = B64URL.encode(Bytes.sha256(Data(verifier.utf8)))
    }

    public static func make() -> PKCE {
        var g = SystemRandomNumberGenerator()
        return PKCE(verifier: B64URL.encode(Data((0 ..< 32).map { _ in UInt8.random(in: 0 ... 255, using: &g) })))
    }
}

public struct AuthClient: Sendable {
    public let api: APIClient
    public init(api: APIClient) { self.api = api }

    func handle(_ out: APIOutcome) -> AuthResult {
        guard let r = out.reply else { return .network }
        if r.status == 400 && r.error == "bad email" { return .badEmail }
        if r.status == 502 { return .emailSendFailed }
        if r.status == 429 { return .rateLimited(r.retryAfter ?? 60) }
        guard r.ok else { return .failed(r.status, r.error) }
        if let t = r.json?["ticket"]?.stringValue { return .ticket(ticket: t, email: r.json?["email"]?.stringValue ?? "") }
        if let t = r.json?["request_token"]?.stringValue { return .requestToken(t) }
        return .failed(r.status, nil)
    }

    /// POST /auth/email; a non-ASCII address is refused locally first.
    public func emailStart(email: String, signPub: Data, purpose: AuthPurpose, turnstile: String) async -> AuthResult {
        guard let n = Ids.normalizeEmail(email), !n.isEmpty else { return .badEmail }
        let body = JOut.obj([("email", .str(n)), ("sign_pub", .str(B64URL.encode(signPub))), ("purpose", .str(purpose.rawValue)),
                             ("turnstile", .str(turnstile))]).data
        return handle(await api.call("POST", "/v1/auth/email", body: body, auth: .none))
    }

    public func emailVerify(requestToken: String, code: String) async -> AuthResult {
        let body = JOut.obj([("request_token", .str(requestToken)), ("code", .str(code))]).data
        return handle(await api.call("POST", "/v1/auth/email/verify", body: body, auth: .none))
    }

    public func googleToken(idToken: String, signPub: Data, purpose: AuthPurpose) async -> AuthResult {
        let body = JOut.obj([("id_token", .str(idToken)), ("sign_pub", .str(B64URL.encode(signPub))),
                             ("purpose", .str(purpose.rawValue))]).data
        return handle(await api.call("POST", "/v1/auth/google/token", body: body, auth: .none))
    }

    /// With purpose delete-account the body also carries "code" (the authorizationCode).
    public func appleToken(idToken: String, signPub: Data, purpose: AuthPurpose, code: String?) async -> AuthResult {
        var f: [(String, JOut)] = [("id_token", .str(idToken)), ("sign_pub", .str(B64URL.encode(signPub))),
                                   ("purpose", .str(purpose.rawValue))]
        if purpose == .deleteAccount, let c = code { f.append(("code", .str(c))) }
        return handle(await api.call("POST", "/v1/auth/apple/token", body: JOut.obj(f).data, auth: .none))
    }
}

/// Google OAuth for iOS: ASWebAuthenticationSession with the iOS-type client id (no
/// secret), PKCE S256, nonce bound to sha256(sign_pub).
public enum GoogleOAuth {
    public static func authURL(clientId: String, redirect: String, pkce: PKCE, nonce: String, state: String) -> URL {
        var c = URLComponents(string: "https://accounts.google.com/o/oauth2/v2/auth")!
        c.queryItems = [
            URLQueryItem(name: "client_id", value: clientId), URLQueryItem(name: "redirect_uri", value: redirect),
            URLQueryItem(name: "response_type", value: "code"), URLQueryItem(name: "scope", value: "openid email"),
            URLQueryItem(name: "code_challenge", value: pkce.challenge), URLQueryItem(name: "code_challenge_method", value: "S256"),
            URLQueryItem(name: "nonce", value: nonce), URLQueryItem(name: "state", value: state),
        ]
        return c.url!
    }

    /// Form body for oauth2.googleapis.com/token.
    public static func tokenBody(clientId: String, redirect: String, code: String, pkce: PKCE) -> Data {
        var c = URLComponents()
        c.queryItems = [
            URLQueryItem(name: "client_id", value: clientId), URLQueryItem(name: "redirect_uri", value: redirect),
            URLQueryItem(name: "code", value: code), URLQueryItem(name: "code_verifier", value: pkce.verifier),
            URLQueryItem(name: "grant_type", value: "authorization_code"),
        ]
        return Data((c.percentEncodedQuery ?? "").utf8)
    }
}

/// The Turnstile message handler origin check (website design section 4): https,
/// pusharmor.com, default port.
public enum TurnstileOrigin {
    public static func accept(scheme: String, host: String, port: Int) -> Bool {
        scheme == "https" && host == "pusharmor.com" && (port == 0 || port == 443)
    }
}
