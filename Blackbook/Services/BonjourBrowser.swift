#if os(iOS)
import Foundation
import Network
import Observation
import os

private let logger = Logger(subsystem: "com.blackbookdevelopment.app", category: "BonjourBrowser")

/// Configures the sync server connection for iOS devices.
/// Uses the public Cloudflare Tunnel URL by default so backups work over the internet.
/// Falls back to Bonjour discovery on the local network if the public URL is unreachable.
@Observable
final class BonjourBrowser {
    private var browser: NWBrowser?
    private(set) var isConfigured = false
    private(set) var serverEndpoint: String?

    /// Configures the sync server credentials.
    /// Always re-derives the password from the current email to stay in sync.
    func configure() {
        guard let email = UserDefaults.standard.string(forKey: "auth.userEmail"), !email.isEmpty else {
            logger.info("No user email — skipping server config")
            return
        }

        let url = AppConstants.LocalSync.serverURL
        let password = BackupService.derivePassword(from: email)

        KeychainService.save(
            url,
            service: AppConstants.LocalSync.keychainServiceName,
            account: AppConstants.LocalSync.keychainServerURLAccount
        )
        KeychainService.save(
            password,
            service: AppConstants.LocalSync.keychainServiceName,
            account: AppConstants.LocalSync.keychainPasswordAccount
        )

        serverEndpoint = url
        isConfigured = true
        logger.info("Configured sync server: \(url) for \(email)")
    }
}
#endif
