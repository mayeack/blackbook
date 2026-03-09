import SwiftUI
import AuthenticationServices

struct LoginView: View {
    @Environment(AuthenticationService.self) private var authService
    @State private var email = ""
    @State private var password = ""
    @State private var showSignUp = false
    @FocusState private var focusedField: Field?

    private enum Field: Hashable { case email, password }

    var body: some View {
        GeometryReader { geometry in
            ScrollView {
                VStack(spacing: 0) {
                    Spacer(minLength: geometry.size.height * 0.08)

                    headerSection
                        .padding(.bottom, 40)

                    VStack(spacing: 16) {
                        appleSignInButton
                        dividerRow
                        emailField
                        passwordField
                        signInButton
                        forgotPasswordButton
                    }
                    .padding(.horizontal, 32)
                    .frame(maxWidth: 400)

                    Spacer(minLength: 24)

                    signUpFooter
                        .padding(.bottom, 32)
                }
                .frame(minHeight: geometry.size.height)
                .frame(maxWidth: .infinity)
            }
        }
        .background(AppConstants.UI.screenBackground)
        .sheet(isPresented: $showSignUp) {
            SignUpView()
        }
    }

    // MARK: - Header

    private var headerSection: some View {
        VStack(spacing: 12) {
            Image(systemName: "book.closed.fill")
                .font(.system(size: 56))
                .foregroundStyle(AppConstants.UI.accentGold)

            Text(AppConstants.appName)
                .font(.largeTitle.bold())

            Text("Your personal relationship manager")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
    }

    // MARK: - Sign in with Apple

    private var appleSignInButton: some View {
        Button {
            Task { await authService.signInWithApple() }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "apple.logo")
                    .font(.title3)
                Text("Sign in with Apple")
                    .font(.body.weight(.semibold))
            }
            .frame(maxWidth: .infinity, minHeight: 50)
            .foregroundStyle(.white)
            .background(.black, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(authService.isProcessing)
    }

    // MARK: - Divider

    private var dividerRow: some View {
        HStack {
            Rectangle().fill(.secondary.opacity(0.3)).frame(height: 1)
            Text("or")
                .font(.caption)
                .foregroundStyle(.secondary)
            Rectangle().fill(.secondary.opacity(0.3)).frame(height: 1)
        }
        .padding(.vertical, 4)
    }

    // MARK: - Email Field

    private var emailField: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Email")
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)

            TextField("you@example.com", text: $email)
                .textFieldStyle(.plain)
                .padding(12)
                .background(AppConstants.UI.cardBackground, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                #if os(iOS)
                .textInputAutocapitalization(.never)
                .keyboardType(.emailAddress)
                .textContentType(.emailAddress)
                #endif
                .autocorrectionDisabled()
                .focused($focusedField, equals: .email)
                .submitLabel(.next)
                .onSubmit { focusedField = .password }
        }
    }

    // MARK: - Password Field

    private var passwordField: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Password")
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)

            SecureField("Enter your password", text: $password)
                .textFieldStyle(.plain)
                .padding(12)
                .background(AppConstants.UI.cardBackground, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                #if os(iOS)
                .textContentType(.password)
                #endif
                .focused($focusedField, equals: .password)
                .submitLabel(.go)
                .onSubmit { signIn() }
        }
    }

    // MARK: - Sign In Button

    private var signInButton: some View {
        Button {
            signIn()
        } label: {
            SwiftUI.Group {
                if authService.isProcessing {
                    ProgressView()
                        .tint(.white)
                } else {
                    Text("Sign In")
                        .font(.body.weight(.semibold))
                }
            }
            .frame(maxWidth: .infinity, minHeight: 50)
            .foregroundStyle(.white)
            .background(
                canSubmit ? AppConstants.UI.accentGold : AppConstants.UI.accentGold.opacity(0.4),
                in: RoundedRectangle(cornerRadius: 12, style: .continuous)
            )
        }
        .buttonStyle(.plain)
        .disabled(!canSubmit || authService.isProcessing)

        .overlay {
            if let error = authService.error {
                Text(error.localizedDescription)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .padding(.top, 60)
            }
        }
    }

    // MARK: - Forgot Password

    private var forgotPasswordButton: some View {
        Button {
            authService.navigateToForgotPassword()
        } label: {
            Text("Forgot password?")
                .font(.subheadline)
                .foregroundStyle(AppConstants.UI.accentGold)
        }
        .buttonStyle(.plain)
        .padding(.top, 8)
    }

    // MARK: - Sign Up Footer

    private var signUpFooter: some View {
        HStack(spacing: 4) {
            Text("Don't have an account?")
                .foregroundStyle(.secondary)
            Button { showSignUp = true } label: {
                Text("Sign Up")
                    .fontWeight(.semibold)
                    .foregroundStyle(AppConstants.UI.accentGold)
            }
            .buttonStyle(.plain)
        }
        .font(.subheadline)
    }

    // MARK: - Helpers

    private var canSubmit: Bool {
        !email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        !password.isEmpty
    }

    private func signIn() {
        guard canSubmit else { return }
        Task {
            await authService.signIn(email: email, password: password)
        }
    }
}
