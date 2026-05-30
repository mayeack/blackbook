import Foundation
import os
#if os(iOS)
import UIKit
#endif

private let logger = Logger(subsystem: "com.blackbookdevelopment.app", category: "DeviceIdentity")

/// Stable per-install device identity used for record provenance (createdBy / lastEditedBy on
/// every model). Generated once on first launch and persisted to UserDefaults so it survives
/// app launches and OS updates. Resets only if the app is uninstalled and reinstalled.
///
/// Deliberately *not* derived from `identifierForVendor` (iOS-only and zeroed when the last
/// app from the vendor is uninstalled) or `IOPlatformUUID` (macOS-only). UUID-in-UserDefaults
/// is the simplest cross-platform stable identifier we need.
enum DeviceIdentity {
    private static let installIdKey = "device.installId"

    /// UUID for this install. Generated lazily on first read; persisted forever after.
    static var installId: String {
        if let stored = UserDefaults.standard.string(forKey: installIdKey), !stored.isEmpty {
            return stored
        }
        let fresh = UUID().uuidString
        UserDefaults.standard.set(fresh, forKey: installIdKey)
        logger.info("Generated new device installId \(fresh, privacy: .public)")
        return fresh
    }

    /// Compile-time platform name.
    static var platform: String {
        #if os(iOS)
        return "iOS"
        #elseif os(macOS)
        return "macOS"
        #else
        return "unknown"
        #endif
    }

    /// Human-readable device name snapshot at the moment of the call. Defined inline (rather
    /// than wrapping `BackupService.currentDeviceName`) so this utility stays standalone and
    /// can be shared with the BlackbookServer target without pulling BackupService along.
    static var deviceName: String {
        #if os(iOS)
        return UIDevice.current.name
        #elseif os(macOS)
        return Host.current().localizedName ?? "Mac"
        #else
        return "unknown"
        #endif
    }
}
