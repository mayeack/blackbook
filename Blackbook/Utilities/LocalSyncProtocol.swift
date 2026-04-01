import Foundation

/// API contract for the local Mac sync server (pull/push contacts, photos, backups).
/// Server and client both use these paths and header names.
enum LocalSyncProtocol {
    static let defaultPort: UInt16 = 8765
    static let bonjourType = "_blackbook-sync._tcp"
    static let passwordHeader = "X-Sync-Password"
    static let userEmailHeader = "X-User-Email"

    enum Path {
        static let syncChanges = "/sync/changes"
        static func photo(contactId: String) -> String { "/photo/\(contactId)" }

        // Backup endpoints
        static let backups = "/backups"
        static func backupMetadata(backupId: String) -> String { "/backups/\(backupId)/metadata" }
        static func backupFile(backupId: String, filename: String) -> String { "/backups/\(backupId)/file/\(filename)" }
        static func backupFiles(backupId: String) -> String { "/backups/\(backupId)/files" }
        static func backup(backupId: String) -> String { "/backups/\(backupId)" }
    }

    /// GET /sync/changes?since=ISO8601 → response JSON: { "contacts": [ { ...contact... } ] }
    static func pullQuery(since: Date) -> String {
        let iso = ISO8601DateFormatter().string(from: since)
        let encoded = iso.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? iso
        return "\(Path.syncChanges)?since=\(encoded)"
    }
}
