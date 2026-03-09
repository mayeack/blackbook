import SwiftUI

struct SignUpView: View {
    @Environment(AuthenticationService.self) private var authService
    @Environment(\.dismiss) private var dismiss
    @State private var email = ""
    @State private var password = ""
    @State private var confirmPassword = ""
    @FocusState private var focusedField: Field?

    private enum Field: Hashable { case email, password, confirm }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 24) {
                    headerSection
                        .padding(.top, 20)

                    VStack(spacing: 16) {
                        emailField
                        passwordField
                        confirmPasswordField
                        passwordRequirements
                        signUpButton
                    }
                    .padding(.horizontal, 32)
                    .frame(maxWidth: 400)
                }
                .frame(maxWidth: .infinity)
            }
            .background(AppConstants.UI.screenBackground)
            .navigationTitle("Create Account")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 450, idealWidth: 500, minHeight: 550, idealHeight: 600)
        #endif
    }

    // MARK: - Header

    private var headerSection: some View {
        VStack(spacing: 8) {
            Image(systemName: "person.badge.plus")
                .font(.system(size: 40))
                .foregroundStyle(AppConstants.UI.accentGold)

            Text("Join Blackbook")
                .font(.title2.bold())

            Text("Create an account to sync your contacts across devices")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal)
        }
    }

    // MARK: - Fields

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

    private var passwordField: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Password")
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)

            SecureField("Create a password", text: $password)
                .textFieldStyle(.plain)
                .padding(12)
                .background(AppConstants.UI.cardBackground, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                #if os(iOS)
                .textContentType(.newPassword)
                #endif
                .focused($focusedField, equals: .password)
                .submitLabel(.next)
                .onSubmit { focusedField = .confirm }
        }
    }

    private var confirmPasswordField: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Confirm Password")
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)

            SecureField("Re-enter your password", text: $confirmPassword)
                .textFieldStyle(.plain)
                .padding(12)
                .background(AppConstants.UI.cardBackground, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                #if os(iOS)
                .textContentType(.newPassword)
                #endif
                .focused($focusedField, equals: .confirm)
                .submitLabel(.go)
                .onSubmit { signUp() }
        }
    }

    // MARK: - Password Requirements

    private var passwordRequirements: some View {
        VStack(alignment: .leading, spacing: 4) {
            requirementRow("At least 8 characters", met: password.count >= 8)
            requirementRow("One uppercase letter", met: password.range(of: "[A-Z]", options: .regularExpression) != nil)
            requirementRow("One number", met: password.range(of: "[0-9]", options: .regularExpression) != nil)
            requirementRow("One special character", met: password.range(of: "[^A-Za-z0-9]", options: .regularExpression) != nil)
            requirementRow("Passwords match", met: !confirmPassword.isEmpty && password == confirmPassword)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func requirementRow(_ text: String, met: Bool) -> some View {
        HStack(spacing: 6) {
            Image(systemName: met ? "checkmark.circle.fill" : "circle")
                .font(.caption)
                .foregroundStyle(met ? .green : .secondary)
            Text(text)
                .font(.caption)
                .foregroundStyle(met ? .primary : .secondary)
        }
    }

    // MARK: - Sign Up Button

    private var signUpButton: some View {
        VStack(spacing: 8) {
            Button {
                signUp()
            } label: {
                SwiftUI.Group {
                    if authService.isProcessing {
                        ProgressView()
                            .tint(.white)
                    } else {
                        Text("Create Account")
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
                    .multilineTextAlignment(.center)
            }
        }
    }

    // MARK: - Helpers

    private var canSubmit: Bool {
        let trimmedEmail = email.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmedEmail.isEmpty &&
        password.count >= 8 &&
        password == confirmPassword &&
        password.range(of: "[A-Z]", options: .regularExpression) != nil &&
        password.range(of: "[0-9]", options: .regularExpression) != nil &&
        password.range(of: "[^A-Za-z0-9]", options: .regularExpression) != nil
    }

    private func signUp() {
        guard canSubmit else { return }
        Task {
            await authService.signUp(email: email, password: password)
        }
    }
}
