import AppKit
import Foundation

/// Permission and process probes, injected so tests never query TCC.
protocol SystemProbe: AnyObject {
    func contactsPermission() -> String
    /// Automation → Messages without prompting.
    func automationMessagesPermission() -> String
    func isRunning(bundleID: String) -> Bool
}

final class LiveSystemProbe: SystemProbe {
    static let messagesBundleID = "com.apple.MobileSMS"
    static let whatsappBundleID = "net.whatsapp.WhatsApp"

    func contactsPermission() -> String {
        SystemContactsSource().authorization().rawValue
    }

    func automationMessagesPermission() -> String {
        let target = NSAppleEventDescriptor(bundleIdentifier: Self.messagesBundleID)
        guard let desc = target.aeDesc else { return "unknown" }
        let status = AEDeterminePermissionToAutomateTarget(desc, AEEventClass(typeWildCard), AEEventID(typeWildCard), false)
        switch status {
        case noErr: return "granted"
        case OSStatus(errAEEventNotPermitted): return "denied"
        case OSStatus(errAEEventWouldRequireUserConsent): return "not_determined"
        case OSStatus(procNotFound): return "unknown"
        default: return "unknown"
        }
    }

    func isRunning(bundleID: String) -> Bool {
        !NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).isEmpty
    }
}

/// `GET /v1/health`. Calendar/EventKit is intentionally absent (Google Calendar API is used).
final class HealthReporter {
    private let reader: MessageReader
    private let whatsapp: WhatsAppSnapshotter
    private let probe: SystemProbe
    private let startedAt: Date
    private let info: [String: Any]
    private let macOSVersion: String

    init(reader: MessageReader, whatsapp: WhatsAppSnapshotter, probe: SystemProbe, startedAt: Date,
         info: [String: Any] = Bundle.main.infoDictionary ?? [:], macOSVersion: String = HealthReporter.currentMacOS()) {
        self.reader = reader
        self.whatsapp = whatsapp
        self.probe = probe
        self.startedAt = startedAt
        self.info = info
        self.macOSVersion = macOSVersion
    }

    static func currentMacOS() -> String {
        let os = ProcessInfo.processInfo.operatingSystemVersion
        return "\(os.majorVersion).\(os.minorVersion).\(os.patchVersion)"
    }

    func fields(now: Date) -> [(String, JSON)] {
        var fda = "unknown"
        var chatdb = JSON.object([("max_rowid", .null), ("newest_at", .null)])
        switch reader.db.probe() {
        case .success:
            fda = "granted"
            chatdb = .object([
                ("max_rowid", .num(try? reader.maxRowID())),
                ("newest_at", .iso((try? reader.newestMessageDate()) ?? nil)),
            ])
        case .failure(.accessDenied):
            fda = "denied"
        case .failure:
            fda = "unknown"
        }

        return [
            ("version", .string(info["CFBundleShortVersionString"] as? String ?? "dev")),
            ("build", .string(info["CFBundleVersion"] as? String ?? "0")),
            ("macos", .string(macOSVersion)),
            ("uptime_s", .num(Int64(max(0, now.timeIntervalSince(startedAt))))),
            ("permissions", .object([
                ("fda", .string(fda)),
                ("contacts", .string(probe.contactsPermission())),
                ("automation_messages", .string(probe.automationMessagesPermission())),
            ])),
            ("chatdb", chatdb),
            ("whatsapp", .object([
                ("installed", .bool(whatsapp.isInstalled)),
                ("running", .bool(probe.isRunning(bundleID: LiveSystemProbe.whatsappBundleID))),
                ("container_mtime", .iso(whatsapp.sourceMtime())),
            ])),
            ("messages_app_running", .bool(probe.isRunning(bundleID: LiveSystemProbe.messagesBundleID))),
        ]
    }
}
