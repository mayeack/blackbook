import SwiftUI
import SwiftData
import Amplify
import AWSCognitoAuthPlugin
import AWSAPIPlugin
import AWSS3StoragePlugin
import os

private let logger = Logger(subsystem: "com.blackbookdevelopment.app", category: "AppSetup")

@main
struct BlackbookApp: App {
    let modelContainer: ModelContainer
    @State private var authService = AuthenticationService()

    init() {
        Self.configureAmplify()

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
            AuthGateView()
                .environment(authService)
        }
        .modelContainer(modelContainer)
    }

    private static func configureAmplify() {
        do {
            try Amplify.add(plugin: AWSCognitoAuthPlugin())
            try Amplify.add(plugin: AWSAPIPlugin(modelRegistration: AmplifyModels()))
            try Amplify.add(plugin: AWSS3StoragePlugin())
            try Amplify.configure()
            logger.info("Amplify configured successfully")
        } catch {
            logger.error("Amplify configuration failed: \(error.localizedDescription)")
        }
    }

    private static func createContainer(schema: Schema) -> ModelContainer {
        let storeDirectory = URL.applicationSupportDirectory
        try? FileManager.default.createDirectory(at: storeDirectory, withIntermediateDirectories: true)

        // Local-only SwiftData store; cloud sync handled by AWSSyncService via AppSync
        do {
            let config = ModelConfiguration(
                schema: schema,
                url: storeDirectory.appending(path: "default.store"),
                cloudKitDatabase: .none
            )
            let container = try ModelContainer(for: schema, configurations: [config])
            _ = try container.mainContext.fetchCount(FetchDescriptor<Contact>())
            logger.info("SwiftData local store ready (cloud sync via AWS)")
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
