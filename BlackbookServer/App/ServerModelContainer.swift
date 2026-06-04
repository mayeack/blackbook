import Foundation
import SwiftData
import os

private let logger = Logger(subsystem: "com.blackbookdevelopment.server", category: "ServerModelContainer")

/// Builds the canonical SwiftData container that BlackbookServer uses as the master store.
///
/// The store lives at an explicit unsandboxed path (`~/Library/Application Support/Blackbook/Server/default.store`)
/// so it survives BlackbookServer updates and doesn't collide with the macOS Blackbook UI app's
/// sandboxed store. The UI app and the iPhone app are clients that reconcile against this master
/// via `/sync/changes`.
enum ServerModelContainer {

    /// Filesystem location of the master store. Created lazily on first access.
    static var storeURL: URL {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let dir = appSupport
            .appendingPathComponent("Blackbook", isDirectory: true)
            .appendingPathComponent("Server", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("default.store")
    }

    /// Filesystem location of the epoch file — a UUID written next to the master store the first
    /// time the daemon starts on a fresh store directory. Persists across daemon restarts; is only
    /// regenerated when the directory is wiped (which is exactly the signal clients need to bootstrap).
    static var epochURL: URL {
        storeURL.deletingLastPathComponent().appendingPathComponent("epoch.txt")
    }

    /// Returns the current server epoch. Loads from disk if present; otherwise generates a fresh
    /// UUID, writes it, and returns it. Idempotent and safe to call repeatedly.
    static func currentEpoch() -> String {
        if let data = try? Data(contentsOf: epochURL),
           let stored = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
           !stored.isEmpty {
            return stored
        }
        let fresh = UUID().uuidString
        try? Data(fresh.utf8).write(to: epochURL, options: .atomic)
        logger.info("Wrote new server epoch \(fresh, privacy: .public) at \(epochURL.path, privacy: .public)")
        return fresh
    }

    /// Schema list mirrors `BlackbookApp.init`'s schema so the same JSON payloads round-trip
    /// correctly between client and server.
    private static var schema: Schema {
        Schema([
            Contact.self,
            Interaction.self,
            Note.self,
            Tag.self,
            Group.self,
            Location.self,
            ContactRelationship.self,
            Reminder.self,
            Activity.self,
            RejectedCalendarEvent.self,
            AppNotification.self
        ])
    }

    /// Creates the master `ModelContainer`. Logs and returns nil on failure rather than crashing
    /// — BlackbookServer can still serve `/backups` and `/logs` without a SwiftData store.
    static func make() -> ModelContainer? {
        do {
            let config = ModelConfiguration(
                schema: schema,
                url: storeURL,
                cloudKitDatabase: .none
            )
            let container = try ModelContainer(for: schema, configurations: [config])
            logger.info("Master store ready at \(storeURL.path, privacy: .public)")
            return container
        } catch {
            logger.error("Failed to open master store: \(error.localizedDescription)")
            return nil
        }
    }
}
