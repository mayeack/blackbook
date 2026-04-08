import Foundation
import Observation
import ServiceManagement

@Observable
final class ServerStatusModel {
    private(set) var server: BackupServer?
    private(set) var isRunning = false
    private(set) var port: UInt16 = 0
    private(set) var backupCount = 0
    private(set) var diskUsage: String = "0 bytes"
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

    init() {
        // Auto-start on launch if configured
        if let email = defaults.string(forKey: "serverEmail"), !email.isEmpty {
            startServer()
        }
    }

    var email: String {
        get { defaults.string(forKey: "serverEmail") ?? "" }
        set {
            defaults.set(newValue, forKey: "serverEmail")
            restartIfNeeded()
        }
    }

    var isConfigured: Bool { !email.isEmpty }

    func startServer() {
        guard !email.isEmpty else { return }
        let password = BackupServer.derivePassword(from: email)
        let srv = BackupServer(password: password)
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
