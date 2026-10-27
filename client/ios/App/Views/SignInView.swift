import SwiftUI
import AuthenticationServices
import PushArmorCore

struct SignInView: View {
    let purpose: AuthPurpose
    @EnvironmentObject var model: AppModel
    @Environment(\.colorScheme) private var scheme
    @State private var email = ""
    @State private var showEmail = false
    @State private var showTurnstile = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text(title)
                    .font(.title2.bold())

                SignInWithAppleButton(.signIn) { request in
                    request.requestedScopes = [.email]
                    request.nonce = try? model.nonce(purpose)
                } onCompletion: { result in
                    handleApple(result)
                }
                .signInWithAppleButtonStyle(scheme == .dark ? .white : .black)
                .frame(height: 48)

                Button {
                    Task { await GoogleSignIn().signIn(purpose: purpose, model: model) }
                } label: {
                    Text("Sign in with Google").frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .controlSize(.large)

                if showEmail {
                    TextField("Email address", text: $email)
                        .textContentType(.emailAddress)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .textFieldStyle(.roundedBorder)
                    Button {
                        if Ids.normalizeEmail(email) == nil {
                            model.errorText = S.badEmail
                        } else {
                            showTurnstile = true
                        }
                    } label: {
                        Text("Send code").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                } else {
                    Button {
                        showEmail = true
                    } label: {
                        Text("Email code").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.large)
                }

                if purpose == .deleteAccount {
                    Button("Cancel") { model.phase = .main }
                        .frame(maxWidth: .infinity)
                }
            }
            .padding(24)
        }
        .sheet(isPresented: $showTurnstile) {
            TurnstileSheet { token in
                Task { await model.emailStart(email, purpose: purpose, turnstile: token) }
            }
        }
    }

    private var title: String {
        switch purpose {
        case .register: return "Sign in"
        case .unpause: return "Sign in to resume"
        case .deleteAccount: return "Sign in to delete this account"
        }
    }

    private func handleApple(_ result: Result<ASAuthorization, Error>) {
        guard case .success(let auth) = result,
              let cred = auth.credential as? ASAuthorizationAppleIDCredential,
              let tokenData = cred.identityToken,
              let idToken = String(data: tokenData, encoding: .utf8)
        else {
            if case .failure(let e) = result, (e as? ASAuthorizationError)?.code == .canceled { return }
            model.errorText = "Sign-in failed"
            return
        }
        var code: String?
        if purpose == .deleteAccount, let c = cred.authorizationCode {
            code = String(data: c, encoding: .utf8)
        }
        Task { await model.appleToken(idToken: idToken, code: code, purpose: purpose) }
    }
}
