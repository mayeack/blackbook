import Foundation
import LocalAuthentication
import Observation
import os

private let logger = Logger(subsystem: "com.blackbookdevelopment.app", category: "Biometric")

@Observable
final class BiometricService {
    static let shared = BiometricService()

    var isLocked = false
    var authenticationError: String?

    var isEnabled: Bool {
        KeychainService.retrieve(
            service: AppConstants.Auth.keychainServiceName,
            account: AppConstants.Auth.biometricEnabledKey
        ) == "true"
    }

    var biometricType: LABiometryType {
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) else {
            return .none
        }
        return context.biometryType
    }

    var biometryName: String {
        switch biometricType {
        case .faceID: return "Face ID"
        case .touchID: return "Touch ID"
        case .opticID: return "Optic ID"
        @unknown default: return "Biometrics"
        }
    }

    var biometryIcon: String {
        switch biometricType {
        case .faceID: return "faceid"
        case .touchID: return "touchid"
        case .opticID: return "opticid"
        @unknown default: return "lock.shield"
        }
    }

    var isBiometricAvailable: Bool {
        let context = LAContext()
        var error: NSError?
        return context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
    }

    private init() {
        if isEnabled {
            isLocked = true
        }
    }

    func setEnabled(_ enabled: Bool) {
        if enabled {
            KeychainService.save(
                "true",
                service: AppConstants.Auth.keychainServiceName,
                account: AppConstants.Auth.biometricEnabledKey
            )
        } else {
            KeychainService.delete(
                service: AppConstants.Auth.keychainServiceName,
                account: AppConstants.Auth.biometricEnabledKey
            )
            isLocked = false
        }
        logger.info("Biometric lock \(enabled ? "enabled" : "disabled")")
    }

    func lockApp() {
        guard isEnabled else { return }
        isLocked = true
        authenticationError = nil
    }

    func authenticate() async {
        authenticationError = nil
        let context = LAContext()
        context.localizedCancelTitle = "Use Passcode"

        var error: NSError?
        // Try biometrics first, fall back to device passcode
        let policy: LAPolicy = context.canEvaluatePolicy(
            .deviceOwnerAuthenticationWithBiometrics, error: &error
        ) ? .deviceOwnerAuthenticationWithBiometrics : .deviceOwnerAuthentication

        do {
            let success = try await context.evaluatePolicy(
                policy,
                localizedReason: "Unlock \(AppConstants.appName) to access your contacts"
            )
            if success {
                isLocked = false
                logger.info("Biometric unlock succeeded")
            }
        } catch let laError as LAError {
            switch laError.code {
            case .userFallback:
                await authenticateWithPasscode()
            case .userCancel:
                logger.info("User cancelled biometric authentication")
            case .biometryLockout:
                authenticationError = "\(biometryName) is locked. Use your device passcode."
                await authenticateWithPasscode()
            default:
                authenticationError = "Authentication failed. Please try again."
                logger.error("Biometric auth failed: \(laError.localizedDescription)")
            }
        } catch {
            authenticationError = "Authentication failed. Please try again."
            logger.error("Biometric auth error: \(error.localizedDescription)")
        }
    }

    private func authenticateWithPasscode() async {
        let context = LAContext()
        do {
            let success = try await context.evaluatePolicy(
                .deviceOwnerAuthentication,
                localizedReason: "Unlock \(AppConstants.appName) with your passcode"
            )
            if success {
                isLocked = false
                logger.info("Passcode unlock succeeded")
            }
        } catch {
            authenticationError = "Authentication failed."
            logger.error("Passcode auth failed: \(error.localizedDescription)")
        }
    }
}
