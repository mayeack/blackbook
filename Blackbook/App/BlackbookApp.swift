import SwiftUI
import SwiftData
import os

private let logger = Logger(subsystem: "com.blackbookdevelopment.app", category: "AppSetup")

@main
struct BlackbookApp: App {
    let modelContainer: ModelContainer

    init() {
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

        modelContainer = Self.createContainer(schema: schema)
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
        }
        .modelContainer(modelContainer)
    }

    private static func createContainer(schema: Schema) -> ModelContainer {
        let storeDirectory = URL.applicationSupportDirectory
        try? FileManager.default.createDirectory(at: storeDirectory, withIntermediateDirectories: true)

        // 1. Try CloudKit sync — verify with a test fetch
        do {
            let config = ModelConfiguration(
                schema: schema,
                url: storeDirectory.appending(path: "default.store"),
                cloudKitDatabase: .private(AppConstants.cloudKitContainer)
            )
            let container = try ModelContainer(for: schema, configurations: [config])
            _ = try container.mainContext.fetchCount(FetchDescriptor<Contact>())
            logger.info("Using CloudKit sync")
            return container
        } catch {
            logger.warning("CloudKit container failed: \(error.localizedDescription)")
        }

        // 2. Try local-only
        do {
            let config = ModelConfiguration(
                schema: schema,
                url: storeDirectory.appending(path: "default.store"),
                cloudKitDatabase: .none
            )
            let container = try ModelContainer(for: schema, configurations: [config])
            _ = try container.mainContext.fetchCount(FetchDescriptor<Contact>())
            logger.info("Using local storage (CloudKit unavailable)")
            return container
        } catch {
            logger.warning("Local container failed: \(error.localizedDescription)")
        }

        // 3. Last resort: delete corrupt store and retry
        logger.warning("Existing store incompatible — resetting database")
        let storeURL = storeDirectory.appending(path: "default.store")
        for suffix in ["", "-wal", "-shm"] {
            let fileURL = storeURL.deletingPathExtension()
                .appendingPathExtension("store\(suffix)")
            try? FileManager.default.removeItem(at: fileURL)
        }

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
            fatalError("Cannot create SwiftData container: \(error)")
        }
    }
}
