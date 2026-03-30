import Foundation

// MARK: - Backup Type

enum BackupType: String, Codable {
    case manual
    case automatic
    case preRestore

    var displayName: String {
        switch self {
        case .manual: "Manual"
        case .automatic: "Auto"
        case .preRestore: "Pre-Restore"
        }
    }
}

// MARK: - Backup Metadata

struct BackupMetadata: Codable, Identifiable {
    let id: UUID
    let createdAt: Date
    let appVersion: String
    var label: String?
    let type: BackupType
    let recordCounts: [String: Int]
    let totalSizeBytes: Int64
    let scoringWeights: [String: Double]

    /// Directory name for this backup (ISO 8601 timestamp)
    let directoryName: String

    init(
        id: UUID = UUID(),
        createdAt: Date = Date(),
        appVersion: String = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "unknown",
        label: String? = nil,
        type: BackupType,
        recordCounts: [String: Int],
        totalSizeBytes: Int64,
        scoringWeights: [String: Double],
        directoryName: String
    ) {
        self.id = id
        self.createdAt = createdAt
        self.appVersion = appVersion
        self.label = label
        self.type = type
        self.recordCounts = recordCounts
        self.totalSizeBytes = totalSizeBytes
        self.scoringWeights = scoringWeights
        self.directoryName = directoryName
    }

    // MARK: Computed Properties

    var totalRecords: Int {
        recordCounts.values.reduce(0, +)
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

    var relativeDate: String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: createdAt, relativeTo: Date())
    }
}
