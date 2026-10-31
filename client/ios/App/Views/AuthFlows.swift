import SwiftUI
import UIKit
import WebKit
import AuthenticationServices
import PushArmorCore

/// Google sign-in: PKCE authorization code flow in an ephemeral web session, then the
/// token exchange; the id_token goes to the Worker through the model.
@MainActor
final class GoogleSignIn: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap { $0.windows }
            .first { $0.isKeyWindow } ?? ASPresentationAnchor()
    }

    func signIn(purpose: AuthPurpose, model: AppModel) async {
        let clientId = AppEnvironment.shared.googleClientId
        let suffix = ".apps.googleusercontent.com"
        guard clientId.hasSuffix(suffix), clientId.count > suffix.count else {
            model.errorText = "Login failed."
            return
        }
        let scheme = "com.googleusercontent.apps." + String(clientId.dropLast(suffix.count))
        let redirect = scheme + ":/oauth2redirect"
        let pkce = PKCE.make()
        let state = PKCE.make().verifier
        guard let nonce = try? model.nonce(purpose) else {
            model.errorText = "Login failed."
            return
        }
        let url = GoogleOAuth.authURL(clientId: clientId, redirect: redirect, pkce: pkce, nonce: nonce, state: state)

        var resumed = false
        let callback: URL? = await withCheckedContinuation { cont in
            let s = ASWebAuthenticationSession(url: url, callbackURLScheme: scheme) { u, _ in
                if !resumed { resumed = true; cont.resume(returning: u) }
            }
            s.presentationContextProvider = self
            s.prefersEphemeralWebBrowserSession = true
            self.session = s
            if !s.start() && !resumed {
                resumed = true
                cont.resume(returning: nil)
            }
        }
        session = nil

        guard let cb = callback,
              let items = URLComponents(url: cb, resolvingAgainstBaseURL: false)?.queryItems,
              items.first(where: { $0.name == "state" })?.value == state,
              let code = items.first(where: { $0.name == "code" })?.value
        else {
            model.errorText = "Login failed."
            return
        }

        var req = URLRequest(url: URL(string: "https://oauth2.googleapis.com/token")!)
        req.httpMethod = "POST"
        req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        req.httpBody = GoogleOAuth.tokenBody(clientId: clientId, redirect: redirect, code: code, pkce: pkce)
        guard let (data, _) = try? await URLSession.shared.data(for: req),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let idToken = obj["id_token"] as? String
        else {
            model.errorText = "Login failed."
            return
        }
        await model.googleToken(idToken: idToken, purpose: purpose)
    }
}

/// Sheet with the Turnstile page. Only a String message from the pusharmor.com origin
/// is accepted as a token.
struct TurnstileSheet: View {
    let onToken: (String) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            TurnstileWebView { token in
                onToken(token)
                dismiss()
            }
            .navigationTitle("Verify")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }
}

private struct TurnstileWebView: UIViewRepresentable {
    static let handlerName = "paTurnstile"
    let onToken: (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onToken: onToken) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.userContentController.add(context.coordinator, name: TurnstileWebView.handlerName)
        let web = WKWebView(frame: .zero, configuration: config)
        if let url = URL(string: "https://pusharmor.com/turnstile") {
            web.load(URLRequest(url: url))
        }
        return web
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    static func dismantleUIView(_ uiView: WKWebView, coordinator: Coordinator) {
        uiView.configuration.userContentController.removeScriptMessageHandler(forName: handlerName)
    }

    @MainActor
    final class Coordinator: NSObject, WKScriptMessageHandler {
        let onToken: (String) -> Void
        private var done = false

        init(onToken: @escaping (String) -> Void) { self.onToken = onToken }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            let origin = message.frameInfo.securityOrigin
            guard !done,
                  TurnstileOrigin.accept(scheme: origin.`protocol`, host: origin.host, port: origin.port),
                  let token = message.body as? String, !token.isEmpty
            else { return }
            done = true
            onToken(token)
        }
    }
}
