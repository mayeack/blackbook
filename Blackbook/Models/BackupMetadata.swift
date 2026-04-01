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

// MARK: - Backup Source

/// Where a backup was loaded from — set at runtime, not persisted.
enum BackupSource: String, Codable {
    case local
    case remote
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

    /// Name of the device that created this backup.
    var deviceName: String?

    /// Whether all files have been uploaded (used by server to filter incomplete uploads).
    var isComplete: Bool

    /// Where this backup was loaded from. Not encoded to JSON on disk.
    var source: BackupSource = .local

    init(
        id: UUID = UUID(),
        createdAt: Date = Date(),
        appVersion: String = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "unknown",
        label: String? = nil,
        type: BackupType,
        recordCounts: [String: Int],
        totalSizeBytes: Int64,
        scoringWeights: [String: Double],
        directoryName: String,
        deviceName: String? = nil,
        isComplete: Bool = true
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
        self.deviceName = deviceName
        self.isComplete = isComplete
    }

    // MARK: Coding

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
        type = try c.decode(BackupType.self, forKey: .type)
        recordCounts = try c.decode([String: Int].self, forKey: .recordCounts)
        totalSizeBytes = try c.decode(Int64.self, forKey: .totalSizeBytes)
        scoringWeights = try c.decode([String: Double].self, forKey: .scoringWeights)
        directoryName = try c.decode(String.self, forKey: .directoryName)
        deviceName = try c.decodeIfPresent(String.self, forKey: .deviceName)
        isComplete = try c.decodeIfPresent(Bool.self, forKey: .isComplete) ?? true
        source = .local
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
