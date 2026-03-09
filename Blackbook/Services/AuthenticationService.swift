import Foundation
import Observation
import Amplify
import AWSCognitoAuthPlugin
import AuthenticationServices
import os

private let logger = Logger(subsystem: "com.blackbookdevelopment.app", category: "Auth")

enum AuthState: Equatable {
    case loading
    case signedOut
    case signedIn(userId: String)
    case confirmSignUp(email: String)
    case resetPassword(email: String)
    case confirmResetPassword(email: String)
}

enum AppAuthError: LocalizedError, Equatable {
    case signInFailed(String)
    case signUpFailed(String)
    case confirmationFailed(String)
    case resetFailed(String)
    case signOutFailed(String)
    case unknown(String)

    var errorDescription: String? {
        switch self {
        case .signInFailed(let msg): return msg
        case .signUpFailed(let msg): return msg
        case .confirmationFailed(let msg): return msg
        case .resetFailed(let msg): return msg
        case .signOutFailed(let msg): return msg
        case .unknown(let msg): return msg
        }
    }
}

@Observable
final class AuthenticationService {
    var authState: AuthState = .loading
    var error: AppAuthError?
    var isProcessing = false

    var isSignedIn: Bool {
        if case .signedIn = authState { return true }
        return false
    }

    var currentUserId: String? {
        if case .signedIn(let userId) = authState { return userId }
        return nil
    }

    // MARK: - Session Check

    func checkCurrentSession() async {
        do {
            let session = try await Amplify.Auth.fetchAuthSession()
            if session.isSignedIn {
                let user = try await Amplify.Auth.getCurrentUser()
                authState = .signedIn(userId: user.userId)
                logger.info("Restored session for user \(user.userId, privacy: .private)")
            } else {
                authState = .signedOut
            }
        } catch {
            logger.warning("No active session: \(error.localizedDescription)")
            authState = .signedOut
        }
    }

    // MARK: - Email/Password Sign In

    func signIn(email: String, password: String) async {
        isProcessing = true
        self.error = nil
        defer { isProcessing = false }

        do {
            let result = try await Amplify.Auth.signIn(
                username: email.lowercased().trimmingCharacters(in: .whitespacesAndNewlines),
                password: password
            )
            if result.isSignedIn {
                let user = try await Amplify.Auth.getCurrentUser()
                authState = .signedIn(userId: user.userId)
                logger.info("Email sign-in succeeded")
            } else if case .confirmSignUp = result.nextStep {
                authState = .confirmSignUp(email: email)
            }
        } catch let authError as AuthError {
            logger.error("Sign-in failed: \(authError.localizedDescription)")
            self.error = .signInFailed(sanitizedAuthMessage(authError))
        } catch {
            logger.error("Sign-in failed: \(error.localizedDescription)")
            self.error = .signInFailed("Invalid username or password")
        }
    }

    // MARK: - Email/Password Sign Up

    func signUp(email: String, password: String) async {
        isProcessing = true
        self.error = nil
        defer { isProcessing = false }

        let sanitizedEmail = email.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)

        do {
            let attributes = [AuthUserAttribute(.email, value: sanitizedEmail)]
            let options = AuthSignUpRequest.Options(userAttributes: attributes)
            let result = try await Amplify.Auth.signUp(
                username: sanitizedEmail,
                password: password,
                options: options
            )

            switch result.nextStep {
            case .confirmUser:
                authState = .confirmSignUp(email: sanitizedEmail)
                logger.info("Sign-up needs confirmation")
            case .done:
                await signIn(email: sanitizedEmail, password: password)
            @unknown default:
                logger.warning("Unhandled sign-up step: \(String(describing: result.nextStep))")
                self.error = .signUpFailed("Unexpected sign-up state. Please try again.")
            }
        } catch let authError as AuthError {
            logger.error("Sign-up failed: \(authError.localizedDescription)")
            self.error = .signUpFailed(sanitizedAuthMessage(authError))
        } catch {
            logger.error("Sign-up failed: \(error.localizedDescription)")
            self.error = .signUpFailed("Registration failed. Please try again.")
        }
    }

    // MARK: - Confirm Sign Up

    func confirmSignUp(email: String, code: String) async {
        isProcessing = true
        self.error = nil
        defer { isProcessing = false }

        let sanitizedEmail = email.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)

        do {
            let result = try await Amplify.Auth.confirmSignUp(
                for: sanitizedEmail,
                confirmationCode: code.trimmingCharacters(in: .whitespacesAndNewlines)
            )
            if result.isSignUpComplete {
                authState = .signedOut
                logger.info("Email confirmed successfully")
            }
        } catch let authError as AuthError {
            logger.error("Confirmation failed: \(authError.localizedDescription)")
            self.error = .confirmationFailed(sanitizedAuthMessage(authError))
        } catch {
            logger.error("Confirmation failed: \(error.localizedDescription)")
            self.error = .confirmationFailed("Verification failed. Please check your code.")
        }
    }

    func resendConfirmationCode(email: String) async {
        let sanitizedEmail = email.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            _ = try await Amplify.Auth.resendSignUpCode(for: sanitizedEmail)
            logger.info("Confirmation code resent")
        } catch {
            logger.error("Resend code failed: \(error.localizedDescription)")
            self.error = .confirmationFailed("Could not resend code. Please try again.")
        }
    }

    // MARK: - Forgot / Reset Password

    func forgotPassword(email: String) async {
        isProcessing = true
        self.error = nil
        defer { isProcessing = false }

        let sanitizedEmail = email.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)

        do {
            let result = try await Amplify.Auth.resetPassword(for: sanitizedEmail)
            switch result.nextStep {
            case .confirmResetPasswordWithCode:
                authState = .confirmResetPassword(email: sanitizedEmail)
                logger.info("Password reset code sent")
            case .done:
                authState = .signedOut
            @unknown default:
                logger.warning("Unhandled reset step: \(String(describing: result.nextStep))")
                authState = .confirmResetPassword(email: sanitizedEmail)
            }
        } catch {
            // Return generic message to prevent account enumeration
            authState = .confirmResetPassword(email: sanitizedEmail)
            logger.warning("Password reset request: \(error.localizedDescription)")
        }
    }

    func confirmResetPassword(email: String, code: String, newPassword: String) async {
        isProcessing = true
        self.error = nil
        defer { isProcessing = false }

        let sanitizedEmail = email.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)

        do {
            try await Amplify.Auth.confirmResetPassword(
                for: sanitizedEmail,
                with: newPassword,
                confirmationCode: code.trimmingCharacters(in: .whitespacesAndNewlines)
            )
            authState = .signedOut
            logger.info("Password reset completed")
        } catch let authError as AuthError {
            logger.error("Password reset confirm failed: \(authError.localizedDescription)")
            self.error = .resetFailed(sanitizedAuthMessage(authError))
        } catch {
            logger.error("Password reset confirm failed: \(error.localizedDescription)")
            self.error = .resetFailed("Password reset failed. Please try again.")
        }
    }

    // MARK: - Sign in with Apple

    func signInWithApple() async {
        isProcessing = true
        self.error = nil
        defer { isProcessing = false }

        do {
            let result = try await Amplify.Auth.signInWithWebUI(
                for: .apple,
                presentationAnchor: await getPresentationAnchor()
            )
            if result.isSignedIn {
                let user = try await Amplify.Auth.getCurrentUser()
                authState = .signedIn(userId: user.userId)
                logger.info("Apple sign-in succeeded")
            }
        } catch let authError as AuthError {
            logger.error("Apple sign-in failed: \(authError.localizedDescription)")
            self.error = .signInFailed(sanitizedAuthMessage(authError))
        } catch {
            logger.error("Apple sign-in failed: \(error.localizedDescription)")
            self.error = .signInFailed("Sign in with Apple failed. Please try again.")
        }
    }

    // MARK: - Sign Out

    func signOut() async {
        isProcessing = true
        self.error = nil
        defer { isProcessing = false }

        let result = await Amplify.Auth.signOut()
        if let signOutResult = result as? AWSCognitoSignOutResult {
            switch signOutResult {
            case .complete:
                authState = .signedOut
                logger.info("Sign-out complete")
            case let .partial(revokeTokenError, globalSignOutError, hostedUIError):
                authState = .signedOut
                if let err = revokeTokenError {
                    logger.warning("Token revocation issue: \(String(describing: err))")
                }
                if let err = globalSignOutError {
                    logger.warning("Global sign-out issue: \(String(describing: err))")
                }
                if let err = hostedUIError {
                    logger.warning("HostedUI sign-out issue: \(String(describing: err))")
                }
            case .failed(let error):
                logger.error("Sign-out failed: \(error.localizedDescription)")
                self.error = .signOutFailed("Sign out failed. Please try again.")
            }
        }
    }

    func navigateToSignIn() {
        error = nil
        authState = .signedOut
    }

    func navigateToForgotPassword() {
        error = nil
        authState = .resetPassword(email: "")
    }

    // MARK: - Helpers

    @MainActor
    private func getPresentationAnchor() -> AuthUIPresentationAnchor {
        #if os(iOS)
        guard let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
              let window = scene.windows.first else {
            return AuthUIPresentationAnchor()
        }
        return window
        #else
        return NSApplication.shared.windows.first ?? AuthUIPresentationAnchor()
        #endif
    }

    private func sanitizedAuthMessage(_ error: AuthError) -> String {
        switch error {
        case .notAuthorized:
            return "Invalid username or password"
        case .service(let description, _, _):
            if description.contains("User does not exist") ||
               description.contains("user not found") {
                return "Invalid username or password"
            }
            return description
        case .validation(_, let description, _, _):
            return description
        case .configuration, .unknown, .invalidState, .signedOut, .sessionExpired:
            return "An error occurred. Please try again."
        }
    }
}
