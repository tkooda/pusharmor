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
        BrandLayout(text: purpose == .register ? WelcomeText.intro : title, footer: S.sameAccount) {
                SignInWithAppleButton(.continue) { request in
                    request.requestedScopes = [.email]
                    request.nonce = try? model.nonce(purpose)
                } onCompletion: { result in
                    handleApple(result)
                }
                .signInWithAppleButtonStyle(scheme == .dark ? .white : .black)
                .frame(height: 50)
                .clipShape(Capsule())

                Button {
                    Task { await GoogleSignIn().signIn(purpose: purpose, model: model) }
                } label: {
                    Text("Continue with Google")
                }
                .buttonStyle(GoogleButtonStyle())

                if showEmail {
                    // Red border while non-empty and not a valid address, updated on every edit (I468).
                    let invalid = !email.isEmpty && !Ids.looksLikeEmail(email)
                    TextField("Email address", text: $email)
                        .textContentType(.emailAddress)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .textFieldStyle(.roundedBorder)
                        .overlay(
                            RoundedRectangle(cornerRadius: 6, style: .continuous)
                                .strokeBorder(Color.errorText, lineWidth: 1.5)
                                .opacity(invalid ? 1 : 0)
                                .allowsHitTesting(false)
                        )
                        .accessibilityValue(invalid ? email + ", " + S.emailInvalid : email)
                    // The countdown ticks once a second while the same address waits.
                    TimelineView(.periodic(from: .now, by: 1)) { ctx in
                        let left = model.resend.leftMs(for: email, nowMs: Int(ctx.date.timeIntervalSince1970 * 1000))
                        Button {
                            if Ids.normalizeEmail(email) == nil {
                                model.toast = S.badEmail
                            } else {
                                showTurnstile = true
                            }
                        } label: {
                            Text(S.sendLabel("Send code", leftMs: left))
                        }
                        .buttonStyle(GreenButtonStyle())
                        .disabled(left > 0)
                    }
                } else {
                    Button {
                        showEmail = true
                    } label: {
                        Label("Email me a code", systemImage: "envelope.fill")
                            .font(.headline)
                            .frame(maxWidth: .infinity, minHeight: 36)
                    }
                    .buttonStyle(.bordered)
                    .buttonBorderShape(.capsule)
                    .controlSize(.large)
                }

                if purpose == .deleteAccount {
                    Button("Cancel") { model.phase = .main }
                        .frame(maxWidth: .infinity)
                }
        }
        .sheet(isPresented: $showTurnstile) {
            TurnstileSheet { token in
                Task { await model.emailStart(email, purpose: purpose, turnstile: token) }
            }
        }
    }

    private var title: String {
        switch purpose {
        case .register: return "Log in"
        case .login: return "Log in to resume"
        case .deleteAccount: return "Log in to delete this account"
        }
    }

    private func handleApple(_ result: Result<ASAuthorization, Error>) {
        guard case .success(let auth) = result,
              let cred = auth.credential as? ASAuthorizationAppleIDCredential,
              let tokenData = cred.identityToken,
              let idToken = String(data: tokenData, encoding: .utf8)
        else {
            if case .failure(let e) = result, (e as? ASAuthorizationError)?.code == .canceled { return }
            model.toast = S.loginFailed
            return
        }
        var code: String?
        if purpose == .deleteAccount, let c = cred.authorizationCode {
            code = String(data: c, encoding: .utf8)
        }
        Task { await model.appleToken(idToken: idToken, code: code, purpose: purpose) }
    }
}

enum WelcomeText {
    static let intro = "Send links or text to your devices. All of your data is always end-to-end encrypted, and can never be read by the server or anyone else."
}

/// Welcome and sign-in layout: halo, wordmark, one sentence, then the buttons at the bottom.
struct BrandLayout<Buttons: View>: View {
    let text: String
    var footer: String?
    @ViewBuilder let buttons: () -> Buttons

    var body: some View {
        GeometryReader { geo in
            ScrollView {
                VStack(spacing: 0) {
                    Spacer(minLength: 16)
                    SignInHalo()
                    Wordmark(size: 36)
                        .padding(.top, 6)
                    Text(text)
                        .font(.body)
                        .foregroundColor(.secondaryText)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 330)
                        .padding(.top, 12)
                    Spacer(minLength: 32)
                    VStack(spacing: 12) {
                        buttons()
                    }
                    if let f = footer {
                        Text(f)
                            .font(.footnote)
                            .foregroundColor(.secondaryText)
                            .multilineTextAlignment(.center)
                            .padding(.top, 16)
                    }
                }
                .padding(.horizontal, 24)
                .padding(.top, 24)
                .padding(.bottom, 48)
                .frame(minHeight: geo.size.height)
            }
            .scrollBounceBehavior(.basedOnSize)
        }
    }
}

/// Google sign-in button colours (Google branding: white or dark fill, grey edge).
struct GoogleButtonStyle: ButtonStyle {
    @Environment(\.colorScheme) private var scheme

    private func rgb(_ v: UInt32) -> Color {
        Color(red: Double((v >> 16) & 0xFF) / 255, green: Double((v >> 8) & 0xFF) / 255, blue: Double(v & 0xFF) / 255)
    }

    func makeBody(configuration: Configuration) -> some View {
        let dark = scheme == .dark
        return configuration.label
            .font(.body.weight(.medium))
            .foregroundStyle(rgb(dark ? 0xE3E3E3 : 0x1F1F1F))
            .frame(maxWidth: .infinity, minHeight: 50)
            .background(
                Capsule().fill(rgb(dark ? 0x131314 : 0xFFFFFF))
                    .overlay(Capsule().strokeBorder(rgb(dark ? 0x8E918F : 0x747775), lineWidth: 1))
            )
            .contentShape(Capsule())
            .opacity(configuration.isPressed ? 0.85 : 1)
    }
}
