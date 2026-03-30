import SwiftUI

struct ForgotPasswordView: View {
    @Environment(AuthenticationService.self) private var authService
    @State private var email: String
    @State private var code = ""
    @State private var newPassword = ""
    @State private var confirmPassword = ""
    @State private var isNewPasswordVisible = false
    @State private var isConfirmPasswordVisible = false
    @State var showCodeEntry: Bool
    @FocusState private var focusedField: Field?

    private enum Field: Hashable { case email, code, password, confirm }

    init(initialEmail: String = "", showCodeEntry: Bool = false) {
        _email = State(initialValue: initialEmail)
        _showCodeEntry = State(initialValue: showCodeEntry)
    }

    var body: some View {
        GeometryReader { geometry in
            ScrollView {
                VStack(spacing: 24) {
                    Spacer(minLength: geometry.size.height * 0.1)

                    headerSection

                    VStack(spacing: 16) {
                        if showCodeEntry {
                            codeEntrySection
                        } else {
                            emailEntrySection
                        }
                    }
                    .padding(.horizontal, 32)
                    .frame(maxWidth: 400)

                    Spacer(minLength: 24)

                    backToSignIn
                        .padding(.bottom, 32)
                }
                .frame(minHeight: geometry.size.height)
                .frame(maxWidth: .infinity)
            }
        }
        .background(AppConstants.UI.screenBackground)
    }

    // MARK: - Header

    private var headerSection: some View {
        VStack(spacing: 12) {
            Image(systemName: showCodeEntry ? "lock.rotation" : "lock.open")
                .font(.system(size: 48))
                .foregroundStyle(AppConstants.UI.accentGold)

            Text(showCodeEntry ? "Reset Password" : "Forgot Password")
                .font(.title2.bold())

            Text(showCodeEntry
                 ? "Enter the code sent to your email and choose a new password"
                 : "Enter your email and we'll send you a reset code")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal)
        }
    }

    // MARK: - Email Entry

    private var emailEntrySection: some View {
        VStack(spacing: 16) {
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
                    .submitLabel(.go)
                    .onSubmit { requestReset() }
            }

            Button {
                requestReset()
            } label: {
                SwiftUI.Group {
                    if authService.isProcessing {
                        ProgressView().tint(.white)
                    } else {
                        Text("Send Reset Code")
                            .font(.body.weight(.semibold))
                    }
                }
                .frame(maxWidth: .infinity, minHeight: 50)
                .foregroundStyle(.white)
                .background(
                    !email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        ? AppConstants.UI.accentGold
                        : AppConstants.UI.accentGold.opacity(0.4),
                    in: RoundedRectangle(cornerRadius: 12, style: .continuous)
                )
            }
            .buttonStyle(.plain)
            .disabled(email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || authService.isProcessing)

            if let error = authService.error {
                Text(error.localizedDescription)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
    }

    // MARK: - Code + New Password Entry

    private var codeEntrySection: some View {
        VStack(spacing: 16) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Verification Code")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)

                TextField("Enter 6-digit code", text: $code)
                    .textFieldStyle(.plain)
                    .padding(12)
                    .background(AppConstants.UI.cardBackground, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    #if os(iOS)
                    .keyboardType(.numberPad)
                    .textContentType(.oneTimeCode)
                    #endif
                    .focused($focusedField, equals: .code)
                    .multilineTextAlignment(.center)
                    .font(.title3.monospacedDigit())
            }

            VStack(alignment: .leading, spacing: 6) {
                Text("New Password")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)

                ZStack(alignment: .trailing) {
                    if isNewPasswordVisible {
                        TextField("Create a new password", text: $newPassword)
                            .textFieldStyle(.plain)
                            .padding(12)
                            .padding(.trailing, 40)
                            .background(AppConstants.UI.cardBackground, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                            #if os(iOS)
                            .textContentType(.newPassword)
                            .textInputAutocapitalization(.never)
                            #endif
                            .autocorrectionDisabled()
                            .focused($focusedField, equals: .password)
                            .submitLabel(.next)
                            .onSubmit { focusedField = .confirm }
                    } else {
                        SecureField("Create a new password", text: $newPassword)
                            .textFieldStyle(.plain)
                            .padding(12)
                            .padding(.trailing, 40)
                            .background(AppConstants.UI.cardBackground, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                            #if os(iOS)
                            .textContentType(.newPassword)
                            #endif
                            .focused($focusedField, equals: .password)
                            .submitLabel(.next)
                            .onSubmit { focusedField = .confirm }
                    }

                    Button {
                        isNewPasswordVisible.toggle()
                    } label: {
                        Image(systemName: isNewPasswordVisible ? "eye.slash" : "eye")
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                    .padding(.trailing, 12)
                }
            }

            VStack(alignment: .leading, spacing: 6) {
                Text("Confirm Password")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)

                ZStack(alignment: .trailing) {
                    if isConfirmPasswordVisible {
                        TextField("Re-enter new password", text: $confirmPassword)
                            .textFieldStyle(.plain)
                            .padding(12)
                            .padding(.trailing, 40)
                            .background(AppConstants.UI.cardBackground, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                            #if os(iOS)
                            .textContentType(.newPassword)
                            .textInputAutocapitalization(.never)
                            #endif
                            .autocorrectionDisabled()
                            .focused($focusedField, equals: .confirm)
                            .submitLabel(.go)
                            .onSubmit { confirmReset() }
                    } else {
                        SecureField("Re-enter new password", text: $confirmPassword)
                            .textFieldStyle(.plain)
                            .padding(12)
                            .padding(.trailing, 40)
                            .background(AppConstants.UI.cardBackground, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                            #if os(iOS)
                            .textContentType(.newPassword)
                            #endif
                            .focused($focusedField, equals: .confirm)
                            .submitLabel(.go)
                            .onSubmit { confirmReset() }
                    }

                    Button {
                        isConfirmPasswordVisible.toggle()
                    } label: {
                        Image(systemName: isConfirmPasswordVisible ? "eye.slash" : "eye")
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                    .padding(.trailing, 12)
                }
            }

            Button {
                confirmReset()
            } label: {
                SwiftUI.Group {
                    if authService.isProcessing {
                        ProgressView().tint(.white)
                    } else {
                        Text("Reset Password")
                            .font(.body.weight(.semibold))
                    }
                }
                .frame(maxWidth: .infinity, minHeight: 50)
                .foregroundStyle(.white)
                .background(
                    canConfirmReset ? AppConstants.UI.accentGold : AppConstants.UI.accentGold.opacity(0.4),
                    in: RoundedRectangle(cornerRadius: 12, style: .continuous)
                )
            }
            .buttonStyle(.plain)
            .disabled(!canConfirmReset || authService.isProcessing)

            if let error = authService.error {
                Text(error.localizedDescription)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
    }

    // MARK: - Back

    private var backToSignIn: some View {
        Button {
            authService.navigateToSignIn()
        } label: {
            Text("Back to Sign In")
                .font(.subheadline)
                .foregroundStyle(AppConstants.UI.accentGold)
        }
        .buttonStyle(.plain)
    }

    // MARK: - Actions

    private func requestReset() {
        guard !email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        Task { await authService.forgotPassword(email: email) }
    }

    private func confirmReset() {
        guard canConfirmReset else { return }
        Task {
            await authService.confirmResetPassword(
                email: email,
                code: code,
                newPassword: newPassword
            )
        }
    }

    private var canConfirmReset: Bool {
        code.trimmingCharacters(in: .whitespacesAndNewlines).count >= 6 &&
        newPassword.count >= 8 &&
        newPassword == confirmPassword
    }
}
