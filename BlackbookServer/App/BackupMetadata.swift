import Foundation

/// Backup type matching the main app's BackupType.
enum ServerBackupType: String, Codable {
    case manual
    case automatic
    case preRestore
}

/// Metadata for a backup stored on the server.
/// Mirrors the main app's BackupMetadata for JSON compatibility.
struct BackupMetadata: Codable, Identifiable {
    let id: UUID
    let createdAt: Date
    let appVersion: String
    var label: String?
    let type: ServerBackupType
    let recordCounts: [String: Int]
    let totalSizeBytes: Int64
    let scoringWeights: [String: Double]
    let directoryName: String
    var deviceName: String?
    var isComplete: Bool

    enum CodingKeys: String, CodingKey {
        case id, createdAt, appVersion, label, type, recordCounts
        case totalSizeBytes, scoringWeights, directoryName
        case deviceName, isComplete
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(UUID.self, forKey: .id)
        createdAt = try c.decode(Date.self, forKey: .createdAt)
        appVersion = try c.decode(String.self, forKey: .appVersion)
        label = try c.decodeIfPresent(String.self, forKey: .label)
        type = try c.decode(ServerBackupType.self, forKey: .type)
        recordCounts = try c.decode([String: Int].self, forKey: .recordCounts)
        totalSizeBytes = try c.decode(Int64.self, forKey: .totalSizeBytes)
        scoringWeights = try c.decode([String: Double].self, forKey: .scoringWeights)
        directoryName = try c.decode(String.self, forKey: .directoryName)
        deviceName = try c.decodeIfPresent(String.self, forKey: .deviceName)
        isComplete = try c.decodeIfPresent(Bool.self, forKey: .isComplete) ?? true
    }

    var formattedSize: String {
        ByteCountFormatter.string(fromByteCount: totalSizeBytes, countStyle: .file)
    }

    var formattedDate: String {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter.string(from: createdAt)
    }
}
