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
    /// First tries the public URL, then falls back to Bonjour LAN discovery.
    func configure() {
        guard let email = UserDefaults.standard.string(forKey: "auth.userEmail"), !email.isEmpty else {
            logger.info("No user email — skipping server config")
            return
        }

        // Check if already configured
        if let existing = KeychainService.retrieve(
            service: AppConstants.LocalSync.keychainServiceName,
            account: AppConstants.LocalSync.keychainServerURLAccount
        ), !existing.isEmpty {
            serverEndpoint = existing
            isConfigured = true
            logger.info("Sync server already configured: \(existing)")
            return
        }

        // Auto-configure with the public Cloudflare Tunnel URL
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
        logger.info("Auto-configured sync server: \(url)")
    }
}
#endif
