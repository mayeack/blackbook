import SwiftUI

struct AuthGateView: View {
    @Environment(AuthenticationService.self) private var authService
    @Environment(\.scenePhase) private var scenePhase
    @State private var biometricService = BiometricService.shared

    var body: some View {
        ZStack {
            switch authService.authState {
            case .loading:
                ProgressView("Loading...")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .task { await authService.checkCurrentSession() }

            case .signedOut:
                LoginView()

            case .signedIn:
                ContentView()

            case .confirmSignUp(let email):
                ConfirmEmailView(email: email)

            case .resetPassword:
                ForgotPasswordView()

            case .confirmResetPassword(let email):
                ForgotPasswordView(initialEmail: email, showCodeEntry: true)
            }

            if biometricService.isLocked && authService.isSignedIn {
                BiometricLockView()
                    .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.3), value: biometricService.isLocked)
        .onChange(of: scenePhase) { _, newPhase in
            if newPhase == .background || newPhase == .inactive {
                biometricService.lockApp()
            }
        }
    }
}
