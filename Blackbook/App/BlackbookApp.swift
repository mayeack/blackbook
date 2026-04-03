import SwiftUI
import SwiftData
import os

private let logger = Logger(subsystem: "com.blackbookdevelopment.app", category: "AppSetup")

/// Bump this integer whenever the SwiftData schema changes (new/removed/renamed
/// stored properties, new model classes, relationship changes, etc.).
/// When the running version doesn't match the value stored in UserDefaults the
/// existing store is deleted before SwiftData tries to open it, preventing a
/// fatal crash inside `DefaultStore.fulfill`.
private let currentSchemaVersion = 3

@main
struct BlackbookApp: App {
    let modelContainer: ModelContainer
    @State private var authService = AuthenticationService()
    #if os(macOS)
    @State private var iMessageService = IMessageSyncService()
    #endif

    init() {
        // Check for a pending restore before opening the store
        if let backupDir = BackupService.checkPendingRestore() {
            do {
                try BackupService.performRestore(from: backupDir)
                logger.info("Database restored from backup: \(backupDir.lastPathComponent)")
            } catch {
                logger.error("Restore failed: \(error.localizedDescription)")
            }
        }

        let schema = Schema([
            Contact.self,
            Interaction.self,
            Note.self,
            Tag.self,
            Group.self,
            Location.self,
            ContactRelationship.self,
            Reminder.self,
            Activity.self,
            RejectedCalendarEvent.self
        ])

        // Wipe the store when the schema version changes so SwiftData never
        // tries to load data that doesn't match the current model definitions.
        Self.migrateStoreIfNeeded()

        modelContainer = Self.createContainer(schema: schema)
    }

    var body: some Scene {
        WindowGroup {
            AuthGateView()
                .environment(authService)
                #if os(macOS)
                .environment(iMessageService)
                .onAppear {
                    iMessageService.startIfEnabled(with: modelContainer.mainContext)
                }
                #endif
        }
        .modelContainer(modelContainer)
    }

    /// Deletes the on-disk store when the persisted schema version doesn't match
    /// `currentSchemaVersion`. This runs *before* `ModelContainer` is created so
    /// SwiftData never attempts to deserialize incompatible data.
    private static func migrateStoreIfNeeded() {
        let key = "SwiftDataSchemaVersion"
        let saved = UserDefaults.standard.integer(forKey: key)
        guard saved != currentSchemaVersion else { return }

        logger.warning("Schema version changed (\(saved) → \(currentSchemaVersion)) — removing old store")
        let storeURL = URL.applicationSupportDirectory.appending(path: "default.store")
        for suffix in ["", "-wal", "-shm"] {
            let fileURL = storeURL.deletingPathExtension()
                .appendingPathExtension("store\(suffix)")
            try? FileManager.default.removeItem(at: fileURL)
        }
        // Remove SwiftData external storage directory (@Attribute(.externalStorage))
        let supportDir = URL.applicationSupportDirectory.appending(path: ".default_SUPPORT")
        try? FileManager.default.removeItem(at: supportDir)
        UserDefaults.standard.set(currentSchemaVersion, forKey: key)
    }

    private static func createContainer(schema: Schema) -> ModelContainer {
        let storeDirectory = URL.applicationSupportDirectory
        do {
            try FileManager.default.createDirectory(at: storeDirectory, withIntermediateDirectories: true)
        } catch {
            logger.error("Failed to create store directory: \(error.localizedDescription)")
        }

        // Local-only SwiftData store
        do {
            let config = ModelConfiguration(
                schema: schema,
                url: storeDirectory.appending(path: "default.store"),
                cloudKitDatabase: .none
            )
            let container = try ModelContainer(for: schema, configurations: [config])
            // Materialize a real object (not just count) to catch schema mismatches
            // that only surface during property access.
            var descriptor = FetchDescriptor<Contact>()
            descriptor.fetchLimit = 1
            let probe = try container.mainContext.fetch(descriptor)
            if let contact = probe.first {
                _ = contact.firstName
            }
            logger.info("SwiftData local store ready")
            return container
        } catch {
            logger.warning("Local container failed: \(error.localizedDescription)")
        }

        // Last resort: delete corrupt store and retry
        logger.warning("Existing store incompatible — resetting database")
        let storeURL = storeDirectory.appending(path: "default.store")
        for suffix in ["", "-wal", "-shm"] {
            let fileURL = storeURL.deletingPathExtension()
                .appendingPathExtension("store\(suffix)")
            try? FileManager.default.removeItem(at: fileURL)
        }
        try? FileManager.default.removeItem(at: storeDirectory.appending(path: ".default_SUPPORT"))

        do {
            let config = ModelConfiguration(
                schema: schema,
                url: storeURL,
                cloudKitDatabase: .none
            )
            let container = try ModelContainer(for: schema, configurations: [config])
            logger.info("Created fresh local store")
            return container
        } catch {
            // Fall back to in-memory container to avoid crashing the app
            logger.error("Cannot create persistent SwiftData container: \(error.localizedDescription). Using in-memory store.")
            do {
                let inMemoryConfig = ModelConfiguration(schema: schema, isStoredInMemoryOnly: true)
                return try ModelContainer(for: schema, configurations: [inMemoryConfig])
            } catch {
                fatalError("Cannot create even in-memory SwiftData container: \(error)")
            }
        }
    }
}
