import Foundation
import Observation
import os

private let logger = Logger(subsystem: "com.blackbookdevelopment.app", category: "Auth")

/// Represents the current authentication state of the app.
enum AuthState: Equatable {
    case loading
    case signedOut
    case signedIn(userId: String)
    case confirmSignUp(email: String)
    case resetPassword(email: String)
    case confirmResetPassword(email: String)
}

/// Authentication error types with user-friendly descriptions.
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

/// Manages authentication state for the app using local-only auth.
///
/// All data is stored locally on the device. No cloud authentication backend is required.
/// The service immediately signs the user in as a local user on session check.
@Observable
final class AuthenticationService {
    var authState: AuthState = .loading
    var error: AppAuthError?
    var isProcessing = false
    var userEmail: String?

    /// The display name for the current user, defaulting to their email.
    var displayName: String? {
        userEmail
    }

    /// Whether the user is currently signed in.
    var isSignedIn: Bool {
        if case .signedIn = authState { return true }
        return false
    }

    /// The current user's ID, or nil if not signed in.
    var currentUserId: String? {
        if case .signedIn(let userId) = authState { return userId }
        return nil
    }

    // MARK: - Session Check

    /// Checks for an existing session. Restores the signed-in state only if
    /// the user has previously signed in; otherwise shows the login screen.
    func checkCurrentSession() async {
        if let email = UserDefaults.standard.string(forKey: "auth.userEmail"), !email.isEmpty {
            self.userEmail = email
            UserActionLogger.shared.setUserEmail(email)
            authState = .signedIn(userId: "local")
            logger.info("Restored local session for \(email)")
            Log.action("auth.session.restored", metadata: ["email": email])
        } else {
            authState = .signedOut
            logger.info("No previous session — showing login")
        }
    }

    // MARK: - Email/Password Sign In

    /// Signs in the user. In local mode, immediately transitions to signed-in state.
    func signIn(email: String, password: String) async {
        isProcessing = true
        self.error = nil
        defer { isProcessing = false }

        self.userEmail = email
        UserDefaults.standard.set(email, forKey: "auth.userEmail")
        UserActionLogger.shared.setUserEmail(email)
        authState = .signedIn(userId: "local")
        logger.info("Local sign-in succeeded")
        Log.action("auth.signIn", metadata: ["email": email, "method": "password"], success: true)
    }

    // MARK: - Email/Password Sign Up

    /// Registers a new user. In local mode, immediately signs in.
    func signUp(email: String, password: String) async {
        isProcessing = true
        self.error = nil
        defer { isProcessing = false }

        self.userEmail = email
        UserDefaults.standard.set(email, forKey: "auth.userEmail")
        UserActionLogger.shared.setUserEmail(email)
        authState = .signedIn(userId: "local")
        logger.info("Local sign-up succeeded")
        Log.action("auth.signUp", metadata: ["email": email], success: true)
    }

    // MARK: - Confirm Sign Up

    /// Confirms a sign-up code. In local mode, transitions to signed-out (ready to sign in).
    func confirmSignUp(email: String, code: String) async {
        isProcessing = true
        self.error = nil
        defer { isProcessing = false }

        authState = .signedOut
        logger.info("Confirmation acknowledged (local mode)")
    }

    /// Resends a confirmation code. No-op in local mode.
    func resendConfirmationCode(email: String) async {
        logger.info("Resend code not applicable in local mode")
    }

    // MARK: - Forgot / Reset Password

    /// Initiates a password reset. No-op in local mode.
    func forgotPassword(email: String) async {
        isProcessing = true
        self.error = nil
        defer { isProcessing = false }

        authState = .signedOut
        logger.info("Password reset not applicable in local mode")
    }

    /// Confirms a password reset. No-op in local mode.
    func confirmResetPassword(email: String, code: String, newPassword: String) async {
        isProcessing = true
        self.error = nil
        defer { isProcessing = false }

        authState = .signedOut
        logger.info("Password reset confirmed (local mode)")
    }

    // MARK: - Sign in with Apple

    /// Signs in with Apple. In local mode, immediately signs in.
    func signInWithApple() async {
        isProcessing = true
        self.error = nil
        defer { isProcessing = false }

        let email = "apple-user"
        self.userEmail = email
        UserDefaults.standard.set(email, forKey: "auth.userEmail")
        UserActionLogger.shared.setUserEmail(email)
        authState = .signedIn(userId: "local")
        logger.info("Apple sign-in succeeded (local mode)")
        Log.action("auth.signIn", metadata: ["email": email, "method": "apple"], success: true)
    }

    // MARK: - Sign Out

    /// Signs the user out, transitioning to the signed-out state.
    func signOut() async {
        isProcessing = true
        self.error = nil
        defer { isProcessing = false }

        let priorEmail = self.userEmail
        Log.action("auth.signOut", metadata: ["email": priorEmail ?? ""])
        await UserActionLogger.shared.uploadPending()
        self.userEmail = nil
        UserDefaults.standard.removeObject(forKey: "auth.userEmail")
        UserActionLogger.shared.setUserEmail(nil)
        authState = .signedOut
        logger.info("Sign-out complete")
    }

    /// Navigates to the sign-in screen.
    func navigateToSignIn() {
        error = nil
        authState = .signedOut
    }

    /// Navigates to the forgot-password screen.
    func navigateToForgotPassword() {
        error = nil
        authState = .resetPassword(email: "")
    }
}
