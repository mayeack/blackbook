import Foundation
import SwiftData
import SQLite3
import Observation
import os

private let logger = Logger(subsystem: "com.blackbookdevelopment.app", category: "Backup")

// MARK: - Backup Error

enum BackupError: LocalizedError {
    case checkpointFailed(String)
    case copyFailed(String)
    case metadataCorrupted
    case backupNotFound
    case restoreFailed(String)

    var errorDescription: String? {
        switch self {
        case .checkpointFailed(let msg): "WAL checkpoint failed: \(msg)"
        case .copyFailed(let msg): "File copy failed: \(msg)"
        case .metadataCorrupted: "Backup metadata is corrupted"
        case .backupNotFound: "Backup directory not found"
        case .restoreFailed(let msg): "Restore failed: \(msg)"
        }
    }
}

// MARK: - Backup Service

@Observable
final class BackupService {
    private(set) var backups: [BackupMetadata] = []
    private(set) var isCreatingBackup = false
    private(set) var isPreparingRestore = false
    private(set) var lastError: String?

    private static let fm = FileManager.default

    // MARK: - Directory Paths

    static var storeDirectory: URL {
        URL.applicationSupportDirectory
    }

    static var storeURL: URL {
        storeDirectory.appending(path: "default.store")
    }

    static var backupsDirectory: URL {
        URL.applicationSupportDirectory.appendingPathComponent("Blackbook/Backups", isDirectory: true)
    }

    static var photosDirectory: URL {
        URL.applicationSupportDirectory.appendingPathComponent("Blackbook/Photos", isDirectory: true)
    }

    static var sentinelURL: URL {
        backupsDirectory.appendingPathComponent(".pending-restore")
    }

    // MARK: - Create Backup

    @MainActor
    func createBackup(modelContext: ModelContext, type: BackupType, label: String? = nil) async -> BackupMetadata? {
        guard !isCreatingBackup else { return nil }
        isCreatingBackup = true
        lastError = nil
        defer { isCreatingBackup = false }

        do {
            // Flush pending writes
            try modelContext.save()

            // Generate directory name from timestamp
            let dirName = Self.directoryName(for: Date())
            let backupDir = Self.backupsDirectory.appendingPathComponent(dirName, isDirectory: true)

            try Self.fm.createDirectory(at: backupDir, withIntermediateDirectories: true)

            // Checkpoint WAL to consolidate data into main store file
            try Self.checkpointWAL()

            // Copy store files
            try Self.copyStoreFiles(to: backupDir)

            // Copy photos directory
            try Self.copyPhotos(to: backupDir)

            // Gather metadata
            let counts = Self.gatherRecordCounts(modelContext: modelContext)
            let weights = Self.gatherScoringWeights()
            let size = Self.directorySize(at: backupDir)

            let metadata = BackupMetadata(
                label: label,
                type: type,
                recordCounts: counts,
                totalSizeBytes: size,
                scoringWeights: weights,
                directoryName: dirName
            )

            // Write metadata.json
            let encoder = JSONEncoder()
            encoder.dateEncodingStrategy = .iso8601
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            let data = try encoder.encode(metadata)
            try data.write(to: backupDir.appendingPathComponent("metadata.json"))

            logger.info("Backup created: \(dirName) (\(metadata.formattedSize))")

            // Reload list and prune
            loadBackups()
            pruneOldBackups()

            // Update last auto-backup date
            if type == .automatic {
                UserDefaults.standard.set(Date(), forKey: AppConstants.Backup.lastAutoBackupKey)
            }

            return metadata
        } catch {
            lastError = error.localizedDescription
            logger.error("Backup creation failed: \(error.localizedDescription)")
            return nil
        }
    }

    // MARK: - Load Backups

    func loadBackups() {
        let dir = Self.backupsDirectory
        guard Self.fm.fileExists(atPath: dir.path) else {
            backups = []
            return
        }

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601

        var loaded: [BackupMetadata] = []
        guard let contents = try? Self.fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil) else {
            backups = []
            return
        }

        for item in contents {
            guard item.hasDirectoryPath else { continue }
            let metadataURL = item.appendingPathComponent("metadata.json")
            guard let data = try? Data(contentsOf: metadataURL),
                  let meta = try? decoder.decode(BackupMetadata.self, from: data) else {
                continue
            }
            loaded.append(meta)
        }

        backups = loaded.sorted { $0.createdAt > $1.createdAt }
    }

    // MARK: - Delete Backup

    func deleteBackup(_ backup: BackupMetadata) {
        let dir = Self.backupsDirectory.appendingPathComponent(backup.directoryName, isDirectory: true)
        do {
            try Self.fm.removeItem(at: dir)
            loadBackups()
            logger.info("Backup deleted: \(backup.directoryName)")
        } catch {
            lastError = error.localizedDescription
            logger.error("Failed to delete backup: \(error.localizedDescription)")
        }
    }

    // MARK: - Prune Old Backups

    func pruneOldBackups() {
        let maxBackups = UserDefaults.standard.object(forKey: AppConstants.Backup.maxBackupsKey) as? Int
            ?? AppConstants.Backup.maxBackupsDefault

        guard backups.count > maxBackups else { return }

        let toRemove = backups.suffix(from: maxBackups)
        for backup in toRemove {
            let dir = Self.backupsDirectory.appendingPathComponent(backup.directoryName, isDirectory: true)
            try? Self.fm.removeItem(at: dir)
            logger.info("Pruned old backup: \(backup.directoryName)")
        }

        loadBackups()
    }

    // MARK: - Prepare Restore

    @MainActor
    func prepareRestore(from backup: BackupMetadata, modelContext: ModelContext) async -> Bool {
        guard !isPreparingRestore else { return false }
        isPreparingRestore = true
        lastError = nil
        defer { isPreparingRestore = false }

        // Verify backup exists
        let backupDir = Self.backupsDirectory.appendingPathComponent(backup.directoryName, isDirectory: true)
        guard Self.fm.fileExists(atPath: backupDir.path) else {
            lastError = "Backup directory not found"
            return false
        }

        // Create pre-restore safety backup
        logger.info("Creating pre-restore safety backup...")
        let safetyBackup = await createBackup(modelContext: modelContext, type: .preRestore, label: "Before restoring \(backup.formattedDate)")
        guard safetyBackup != nil else {
            lastError = "Failed to create safety backup before restore"
            return false
        }

        // Write sentinel file
        do {
            try Self.fm.createDirectory(at: Self.backupsDirectory, withIntermediateDirectories: true)
            try backup.directoryName.write(to: Self.sentinelURL, atomically: true, encoding: .utf8)
            logger.info("Restore sentinel written for: \(backup.directoryName)")
            return true
        } catch {
            lastError = "Failed to write restore sentinel: \(error.localizedDescription)"
            logger.error("Sentinel write failed: \(error.localizedDescription)")
            return false
        }
    }

    // MARK: - Auto-Backup Check

    func checkAutoBackupNeeded() -> Bool {
        let enabled = UserDefaults.standard.object(forKey: AppConstants.Backup.autoBackupEnabledKey) as? Bool ?? true
        guard enabled else { return false }

        guard let lastBackup = UserDefaults.standard.object(forKey: AppConstants.Backup.lastAutoBackupKey) as? Date else {
            return true // Never backed up
        }

        let hoursSince = Date().timeIntervalSince(lastBackup) / 3600
        return hoursSince >= Double(AppConstants.Backup.autoBackupIntervalHours)
    }

    var totalBackupSize: Int64 {
        backups.reduce(0) { $0 + $1.totalSizeBytes }
    }

    var formattedTotalSize: String {
        ByteCountFormatter.string(fromByteCount: totalBackupSize, countStyle: .file)
    }

    // MARK: - Static Restore Methods (called at app launch before ModelContainer)

    static func checkPendingRestore() -> URL? {
        guard fm.fileExists(atPath: sentinelURL.path) else { return nil }
        guard let dirName = try? String(contentsOf: sentinelURL, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines) else {
            try? fm.removeItem(at: sentinelURL)
            return nil
        }
        let backupDir = backupsDirectory.appendingPathComponent(dirName, isDirectory: true)
        guard fm.fileExists(atPath: backupDir.path) else {
            logger.error("Pending restore backup not found: \(dirName)")
            try? fm.removeItem(at: sentinelURL)
            return nil
        }
        return backupDir
    }

    static func performRestore(from backupDir: URL) throws {
        logger.info("Performing restore from: \(backupDir.lastPathComponent)")

        // Delete current store files
        let storeDir = storeDirectory
        for suffix in ["", "-wal", "-shm"] {
            let fileURL = storeDir.appending(path: "default.store\(suffix)")
            if fm.fileExists(atPath: fileURL.path) {
                try fm.removeItem(at: fileURL)
            }
        }

        // Copy backup store files
        let backupStore = backupDir.appendingPathComponent("default.store")
        if fm.fileExists(atPath: backupStore.path) {
            try fm.copyItem(at: backupStore, to: storeDir.appending(path: "default.store"))
        }
        for suffix in ["-wal", "-shm"] {
            let src = backupDir.appendingPathComponent("default.store\(suffix)")
            if fm.fileExists(atPath: src.path) {
                try fm.copyItem(at: src, to: storeDir.appending(path: "default.store\(suffix)"))
            }
        }

        // Replace photos directory
        let currentPhotos = photosDirectory
        if fm.fileExists(atPath: currentPhotos.path) {
            try fm.removeItem(at: currentPhotos)
        }
        let backupPhotos = backupDir.appendingPathComponent("Photos", isDirectory: true)
        if fm.fileExists(atPath: backupPhotos.path) {
            try fm.copyItem(at: backupPhotos, to: currentPhotos)
        }

        // Restore UserDefaults scoring weights from metadata
        let metadataURL = backupDir.appendingPathComponent("metadata.json")
        if let data = try? Data(contentsOf: metadataURL) {
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .iso8601
            if let metadata = try? decoder.decode(BackupMetadata.self, from: data) {
                restoreScoringWeights(from: metadata)
            }
        }

        // Delete sentinel
        try? fm.removeItem(at: sentinelURL)

        logger.info("Restore completed successfully")
    }

    // MARK: - Private Helpers

    private static func directoryName(for date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.string(from: date)
            .replacingOccurrences(of: ":", with: "-")
    }

    private static func checkpointWAL() throws {
        let storePath = storeURL.path
        var db: OpaquePointer?

        let openResult = sqlite3_open_v2(storePath, &db, SQLITE_OPEN_READWRITE, nil)
        guard openResult == SQLITE_OK else {
            let msg = db.flatMap { String(cString: sqlite3_errmsg($0)) } ?? "unknown"
            sqlite3_close(db)
            throw BackupError.checkpointFailed(msg)
        }

        var errMsg: UnsafeMutablePointer<CChar>?
        let execResult = sqlite3_exec(db, "PRAGMA wal_checkpoint(TRUNCATE)", nil, nil, &errMsg)
        let errorString = errMsg.flatMap { String(cString: $0) }
        sqlite3_free(errMsg)
        sqlite3_close(db)

        if execResult != SQLITE_OK {
            throw BackupError.checkpointFailed(errorString ?? "unknown")
        }
    }

    private static func copyStoreFiles(to destination: URL) throws {
        let storeDir = storeDirectory
        // Always copy main store file
        let mainStore = storeDir.appending(path: "default.store")
        if fm.fileExists(atPath: mainStore.path) {
            try fm.copyItem(at: mainStore, to: destination.appendingPathComponent("default.store"))
        }
        // Copy WAL and SHM if they exist (they may be empty after checkpoint)
        for suffix in ["-wal", "-shm"] {
            let src = storeDir.appending(path: "default.store\(suffix)")
            if fm.fileExists(atPath: src.path) {
                try fm.copyItem(at: src, to: destination.appendingPathComponent("default.store\(suffix)"))
            }
        }
    }

    private static func copyPhotos(to destination: URL) throws {
        let photos = photosDirectory
        guard fm.fileExists(atPath: photos.path) else { return }
        let destPhotos = destination.appendingPathComponent("Photos", isDirectory: true)
        try fm.copyItem(at: photos, to: destPhotos)
    }

    private static func gatherRecordCounts(modelContext: ModelContext) -> [String: Int] {
        var counts: [String: Int] = [:]
        counts["Contacts"] = (try? modelContext.fetchCount(FetchDescriptor<Contact>())) ?? 0
        counts["Interactions"] = (try? modelContext.fetchCount(FetchDescriptor<Interaction>())) ?? 0
        counts["Notes"] = (try? modelContext.fetchCount(FetchDescriptor<Note>())) ?? 0
        counts["Reminders"] = (try? modelContext.fetchCount(FetchDescriptor<Reminder>())) ?? 0
        counts["Tags"] = (try? modelContext.fetchCount(FetchDescriptor<Tag>())) ?? 0
        counts["Groups"] = (try? modelContext.fetchCount(FetchDescriptor<Group>())) ?? 0
        counts["Locations"] = (try? modelContext.fetchCount(FetchDescriptor<Location>())) ?? 0
        counts["Activities"] = (try? modelContext.fetchCount(FetchDescriptor<Activity>())) ?? 0
        counts["Relationships"] = (try? modelContext.fetchCount(FetchDescriptor<ContactRelationship>())) ?? 0
        counts["Rejected Events"] = (try? modelContext.fetchCount(FetchDescriptor<RejectedCalendarEvent>())) ?? 0
        return counts
    }

    private static func gatherScoringWeights() -> [String: Double] {
        let defaults = UserDefaults.standard
        return [
            "recencyWeight": defaults.object(forKey: "scoring.recencyWeight") as? Double ?? AppConstants.Scoring.recencyWeight,
            "frequencyWeight": defaults.object(forKey: "scoring.frequencyWeight") as? Double ?? AppConstants.Scoring.frequencyWeight,
            "varietyWeight": defaults.object(forKey: "scoring.varietyWeight") as? Double ?? AppConstants.Scoring.varietyWeight,
            "sentimentWeight": defaults.object(forKey: "scoring.sentimentWeight") as? Double ?? AppConstants.Scoring.sentimentWeight,
            "fadingThreshold": defaults.object(forKey: "scoring.fadingThreshold") as? Double ?? AppConstants.Scoring.fadingThreshold,
        ]
    }

    private static func restoreScoringWeights(from metadata: BackupMetadata) {
        let defaults = UserDefaults.standard
        for (key, value) in metadata.scoringWeights {
            defaults.set(value, forKey: "scoring.\(key)")
        }
    }

    private static func directorySize(at url: URL) -> Int64 {
        guard let enumerator = fm.enumerator(at: url, includingPropertiesForKeys: [.fileSizeKey]) else {
            return 0
        }
        var total: Int64 = 0
        for case let fileURL as URL in enumerator {
            if let size = try? fileURL.resourceValues(forKeys: [.fileSizeKey]).fileSize {
                total += Int64(size)
            }
        }
        return total
    }
}
