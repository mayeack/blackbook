import SwiftUI

struct ConfirmEmailView: View {
    @Environment(AuthenticationService.self) private var authService
    let email: String
    @State private var code = ""
    @State private var resent = false
    @FocusState private var codeFieldFocused: Bool

    var body: some View {
        GeometryReader { geometry in
            ScrollView {
                VStack(spacing: 24) {
                    Spacer(minLength: geometry.size.height * 0.1)

                    headerSection

                    VStack(spacing: 16) {
                        codeField
                        confirmButton
                        resendButton
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
        .onAppear { codeFieldFocused = true }
    }

    // MARK: - Header

    private var headerSection: some View {
        VStack(spacing: 12) {
            Image(systemName: "envelope.badge.shield.half.filled")
                .font(.system(size: 48))
                .foregroundStyle(AppConstants.UI.accentGold)

            Text("Verify Your Email")
                .font(.title2.bold())

            Text("We sent a verification code to")
                .font(.subheadline)
                .foregroundStyle(.secondary)

            Text(email)
                .font(.subheadline.weight(.semibold))
        }
    }

    // MARK: - Code Field

    private var codeField: some View {
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
                .focused($codeFieldFocused)
                .multilineTextAlignment(.center)
                .font(.title3.monospacedDigit())
        }
    }

    // MARK: - Confirm Button

    private var confirmButton: some View {
        VStack(spacing: 8) {
            Button {
                Task { await authService.confirmSignUp(email: email, code: code) }
            } label: {
                SwiftUI.Group {
                    if authService.isProcessing {
                        ProgressView()
                            .tint(.white)
                    } else {
                        Text("Verify Email")
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

            if let error = authService.error {
                Text(error.localizedDescription)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
    }

    // MARK: - Resend

    private var resendButton: some View {
        Button {
            Task {
                await authService.resendConfirmationCode(email: email)
                resent = true
            }
        } label: {
            if resent {
                HStack(spacing: 4) {
                    Image(systemName: "checkmark")
                    Text("Code Resent")
                }
                .font(.subheadline)
                .foregroundStyle(.green)
            } else {
                Text("Resend Code")
                    .font(.subheadline)
                    .foregroundStyle(AppConstants.UI.accentGold)
            }
        }
        .buttonStyle(.plain)
        .disabled(resent || authService.isProcessing)
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

    private var canSubmit: Bool {
        code.trimmingCharacters(in: .whitespacesAndNewlines).count >= 6
    }
}
