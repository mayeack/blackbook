import Foundation
import Observation
import ServiceManagement
import SwiftData

@Observable
final class ServerStatusModel {
    private(set) var server: BackupServer?
    private(set) var isRunning = false
    private(set) var port: UInt16 = 0
    private(set) var backupCount = 0
    private(set) var diskUsage: String = "0 bytes"

    /// Master SwiftData container. Nil if container init failed (sync routes will return 503
    /// in that case; backups and logs continue to work since they're filesystem-only).
    private let modelContainer: ModelContainer?

    /// Reads the local iMessage database and logs interactions into the master store.
    /// Runs independently of the backup/sync server (it only needs the master container +
    /// Full Disk Access). Interactions it creates reach all devices on their next pull.
    let imessage: IMessageSyncService
    var launchAtLogin: Bool {
        get { SMAppService.mainApp.status == .enabled }
        set {
            do {
                if newValue {
                    try SMAppService.mainApp.register()
                } else {
                    try SMAppService.mainApp.unregister()
                }
            } catch {
                // Registration can fail if the app isn't in /Applications
            }
        }
    }

    private let defaults = UserDefaults(suiteName: "com.blackbookdevelopment.server") ?? .standard
    private let mainAppDefaults = UserDefaults(suiteName: "com.blackbookdevelopment.app")

    init(modelContainer: ModelContainer? = nil) {
        self.modelContainer = modelContainer
        self.imessage = IMessageSyncService(modelContainer: modelContainer)
        if !email.isEmpty {
            startServer()
        }
        // iMessage logging is independent of the email/sync server — start it if the user enabled it.
        imessage.startIfEnabled()
    }

    // Source of truth is the main Blackbook app's logged-in user.
    // Local `serverEmail` is a fallback override used only when the main
    // app hasn't written its auth state yet (fresh install, dev/test).
    var email: String {
        get {
            if let main = mainAppDefaults?.string(forKey: "auth.userEmail"), !main.isEmpty {
                return main
            }
            return defaults.string(forKey: "serverEmail") ?? ""
        }
        set {
            defaults.set(newValue, forKey: "serverEmail")
            restartIfNeeded()
        }
    }

    var isConfigured: Bool { !email.isEmpty }

    func startServer() {
        guard !email.isEmpty else { return }
        let password = BackupServer.derivePassword(from: email)
        let srv = BackupServer(password: password, container: modelContainer, imessage: imessage)
        srv.start()
        server = srv

        // Poll for status (NWListener state updates are async)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            self?.refreshStatus()
        }
    }

    func stopServer() {
        server?.stop()
        server = nil
        isRunning = false
        port = 0
    }

    func refreshStatus() {
        guard let server else {
            isRunning = false
            port = 0
            backupCount = 0
            diskUsage = "0 bytes"
            return
        }
        isRunning = server.isRunning
        port = server.port
        backupCount = server.backupCount
        let bytes = server.diskUsageBytes
        diskUsage = ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
    }

    private func restartIfNeeded() {
        if server != nil {
            stopServer()
            startServer()
        }
    }
}
