import Foundation
import SwiftData
import SQLite3
import Observation
import CryptoKit
import os
#if canImport(UIKit)
import UIKit
#endif

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
    /// Canonical schema version shared with BlackbookApp.migrateStoreIfNeeded().
    /// Bump this when the SwiftData schema changes.
    static let currentSchemaVersion = 3
    private(set) var backups: [BackupMetadata] = []
    private(set) var remoteBackups: [BackupMetadata] = []
    private(set) var isCreatingBackup = false
    private(set) var isPreparingRestore = false
    private(set) var isUploadingBackup = false
    private(set) var isDownloadingBackup = false
    private(set) var isLoadingRemoteBackups = false
    var uploadProgress: Double = 0
    var downloadProgress: Double = 0
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
            // Non-fatal: backup copies WAL+SHM files, so it's valid even without checkpoint
            do {
                try Self.checkpointWAL()
            } catch {
                logger.warning("WAL checkpoint skipped (non-fatal): \(error.localizedDescription)")
            }

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
                directoryName: dirName,
                deviceName: Self.currentDeviceName
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

            // Auto-upload to server (fire and forget)
            if type != .preRestore {
                Task { await uploadBackupToServer(metadata: metadata) }
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

    // MARK: - Remote Backup Operations

    /// Derives a deterministic sync password from a user email using SHA256.
    /// Both the Mac server and iOS clients use this so they share the same password.
    static func derivePassword(from email: String) -> String {
        let hash = SHA256.hash(data: Data(email.utf8))
        return Data(hash).prefix(24).base64EncodedString()
    }

    /// Current user's email for organizing backups on the server.
    private var userEmail: String? {
        UserDefaults.standard.string(forKey: "auth.userEmail")
    }

    static var currentDeviceName: String {
        #if os(iOS)
        UIDevice.current.name
        #else
        Host.current().localizedName ?? "Mac"
        #endif
    }

    private static func sanitizeEmail(_ email: String) -> String {
        email.replacingOccurrences(of: "@", with: "_at_")
            .replacingOccurrences(of: ".", with: "_")
    }

    // MARK: Server Config (platform-aware)

    #if os(macOS)
    /// On macOS, the Mac IS the server — only need user email.
    var isServerConfigured: Bool { userEmail != nil }

    private static var remoteBackupsDirectory: URL {
        let dir = URL.applicationSupportDirectory.appendingPathComponent("Blackbook/RemoteBackups", isDirectory: true)
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private func userRemoteDir() -> URL? {
        guard let email = userEmail else { return nil }
        let dir = Self.remoteBackupsDirectory.appendingPathComponent(Self.sanitizeEmail(email), isDirectory: true)
        try? Self.fm.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    /// macOS: copy backup directly to RemoteBackups via filesystem.
    func uploadBackupToServer(metadata: BackupMetadata) async {
        guard let destRoot = userRemoteDir() else { return }
        isUploadingBackup = true
        uploadProgress = 0
        defer { isUploadingBackup = false }

        let sourceDir = Self.backupsDirectory.appendingPathComponent(metadata.directoryName, isDirectory: true)
        let destDir = destRoot.appendingPathComponent(metadata.directoryName, isDirectory: true)
        guard Self.fm.fileExists(atPath: sourceDir.path) else { return }

        do {
            if Self.fm.fileExists(atPath: destDir.path) {
                try Self.fm.removeItem(at: destDir)
            }
            try Self.fm.copyItem(at: sourceDir, to: destDir)
            uploadProgress = 1.0
            logger.info("Backup copied to central storage: \(metadata.directoryName)")
        } catch {
            logger.error("Backup copy failed: \(error.localizedDescription)")
        }
    }

    /// macOS: read directly from RemoteBackups filesystem.
    func loadRemoteBackups() async {
        guard let userDir = userRemoteDir() else {
            remoteBackups = []
            return
        }
        isLoadingRemoteBackups = true
        defer { isLoadingRemoteBackups = false }

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        var loaded: [BackupMetadata] = []

        guard let contents = try? Self.fm.contentsOfDirectory(at: userDir, includingPropertiesForKeys: nil) else {
            remoteBackups = []
            return
        }
        for dir in contents where dir.hasDirectoryPath {
            let metaURL = dir.appendingPathComponent("metadata.json")
            guard let data = try? Data(contentsOf: metaURL),
                  var meta = try? decoder.decode(BackupMetadata.self, from: data),
                  meta.isComplete else { continue }
            meta.source = .remote
            loaded.append(meta)
        }
        remoteBackups = loaded.sorted { $0.createdAt > $1.createdAt }
    }

    /// macOS: download from RemoteBackups to local Backups dir.
    func downloadBackupFromServer(metadata: BackupMetadata) async -> Bool {
        guard let userDir = userRemoteDir() else { return false }
        isDownloadingBackup = true
        downloadProgress = 0
        defer { isDownloadingBackup = false }

        let sourceDir = userDir.appendingPathComponent(metadata.directoryName, isDirectory: true)
        let localDir = Self.backupsDirectory.appendingPathComponent(metadata.directoryName, isDirectory: true)

        do {
            if Self.fm.fileExists(atPath: localDir.path) {
                try Self.fm.removeItem(at: localDir)
            }
            try Self.fm.copyItem(at: sourceDir, to: localDir)
            downloadProgress = 1.0
            loadBackups()
            return true
        } catch {
            lastError = "Download failed: \(error.localizedDescription)"
            return false
        }
    }

    /// macOS: delete from RemoteBackups filesystem.
    func deleteRemoteBackup(_ backup: BackupMetadata) async {
        guard let userDir = userRemoteDir() else { return }
        let dir = userDir.appendingPathComponent(backup.directoryName, isDirectory: true)
        try? Self.fm.removeItem(at: dir)
        logger.info("Deleted remote backup: \(backup.directoryName)")
        await loadRemoteBackups()
    }

    #else
    // MARK: iOS — HTTP-based remote backups

    /// Server base URL from Keychain (auto-configured via Bonjour).
    private var serverBaseURL: String? {
        KeychainService.retrieve(
            service: AppConstants.LocalSync.keychainServiceName,
            account: AppConstants.LocalSync.keychainServerURLAccount
        )
    }

    /// Server password from Keychain (derived from email, stored by Bonjour auto-config).
    private var serverPassword: String? {
        KeychainService.retrieve(
            service: AppConstants.LocalSync.keychainServiceName,
            account: AppConstants.LocalSync.keychainPasswordAccount
        )
    }

    /// On iOS, need server URL + password + email.
    var isServerConfigured: Bool {
        serverBaseURL != nil && serverPassword != nil && userEmail != nil
    }

    private func makeServerRequest(path: String, method: String = "GET", body: Data? = nil) async throws -> (Data, HTTPURLResponse) {
        guard let baseURL = serverBaseURL, let password = serverPassword, let email = userEmail else {
            throw URLError(.userAuthenticationRequired)
        }
        guard let url = URL(string: baseURL + path) else {
            throw URLError(.badURL)
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue(password, forHTTPHeaderField: LocalSyncProtocol.passwordHeader)
        request.setValue(email, forHTTPHeaderField: LocalSyncProtocol.userEmailHeader)
        if let body {
            request.httpBody = body
            request.setValue("\(body.count)", forHTTPHeaderField: "Content-Length")
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }
        return (data, httpResponse)
    }

    /// iOS: upload backup to Mac server via HTTP.
    func uploadBackupToServer(metadata: BackupMetadata) async {
        guard isServerConfigured else { return }
        isUploadingBackup = true
        uploadProgress = 0
        defer { isUploadingBackup = false }

        let backupDir = Self.backupsDirectory.appendingPathComponent(metadata.directoryName, isDirectory: true)
        guard Self.fm.fileExists(atPath: backupDir.path) else { return }

        do {
            var files: [(relativePath: String, url: URL)] = []
            if let enumerator = Self.fm.enumerator(at: backupDir, includingPropertiesForKeys: nil) {
                while let url = enumerator.nextObject() as? URL {
                    guard !url.hasDirectoryPath else { continue }
                    let rel = url.standardizedFileURL.path.replacingOccurrences(of: backupDir.standardizedFileURL.path + "/", with: "")
                    if rel != "metadata.json" { files.append((rel, url)) }
                }
            }

            let totalSteps = Double(files.count + 2)

            // 1. Upload metadata with isComplete = false
            var incompleteMeta = metadata
            incompleteMeta.isComplete = false
            let encoder = JSONEncoder()
            encoder.dateEncodingStrategy = .iso8601
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            let metaData = try encoder.encode(incompleteMeta)
            let metaPath = LocalSyncProtocol.Path.backupMetadata(backupId: metadata.directoryName)
            let (_, metaResp) = try await makeServerRequest(path: metaPath, method: "POST", body: metaData)
            guard metaResp.statusCode == 200 else { return }
            uploadProgress = 1.0 / totalSteps

            // 2. Upload each file
            for (i, file) in files.enumerated() {
                let fileData = try Data(contentsOf: file.url)
                let filePath = LocalSyncProtocol.Path.backupFile(backupId: metadata.directoryName, filename: file.relativePath)
                let (_, fileResp) = try await makeServerRequest(path: filePath, method: "POST", body: fileData)
                if fileResp.statusCode != 200 {
                    logger.error("Failed to upload \(file.relativePath): HTTP \(fileResp.statusCode)")
                }
                uploadProgress = Double(i + 2) / totalSteps
            }

            // 3. Finalize with isComplete = true
            var completeMeta = metadata
            completeMeta.isComplete = true
            let finalData = try encoder.encode(completeMeta)
            _ = try await makeServerRequest(path: metaPath, method: "POST", body: finalData)
            uploadProgress = 1.0
            logger.info("Backup uploaded to server: \(metadata.directoryName)")
        } catch {
            logger.error("Backup upload failed: \(error.localizedDescription)")
        }
    }

    /// iOS: fetch backup list from Mac server via HTTP.
    func loadRemoteBackups() async {
        guard isServerConfigured else {
            remoteBackups = []
            return
        }
        isLoadingRemoteBackups = true
        defer { isLoadingRemoteBackups = false }

        do {
            let (data, response) = try await makeServerRequest(path: LocalSyncProtocol.Path.backups)
            guard response.statusCode == 200 else { return }
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .iso8601
            var loaded = try decoder.decode([BackupMetadata].self, from: data)
            for i in loaded.indices { loaded[i].source = .remote }
            remoteBackups = loaded
        } catch {
            logger.error("Failed to load remote backups: \(error.localizedDescription)")
        }
    }

    /// iOS: download backup from Mac server via HTTP.
    func downloadBackupFromServer(metadata: BackupMetadata) async -> Bool {
        guard isServerConfigured else { return false }
        isDownloadingBackup = true
        downloadProgress = 0
        defer { isDownloadingBackup = false }

        let localDir = Self.backupsDirectory.appendingPathComponent(metadata.directoryName, isDirectory: true)

        do {
            try Self.fm.createDirectory(at: localDir, withIntermediateDirectories: true)

            let filesPath = LocalSyncProtocol.Path.backupFiles(backupId: metadata.directoryName)
            let (listData, listResp) = try await makeServerRequest(path: filesPath)
            guard listResp.statusCode == 200,
                  let json = try? JSONSerialization.jsonObject(with: listData) as? [String: Any],
                  let files = json["files"] as? [[String: Any]] else { return false }

            let totalFiles = Double(files.count)
            guard totalFiles > 0 else { return false }

            for (i, file) in files.enumerated() {
                guard let name = file["name"] as? String else { continue }
                let filePath = LocalSyncProtocol.Path.backupFile(backupId: metadata.directoryName, filename: name)
                let (fileData, fileResp) = try await makeServerRequest(path: filePath)
                guard fileResp.statusCode == 200 else { continue }

                let dest = localDir.appendingPathComponent(name)
                try Self.fm.createDirectory(at: dest.deletingLastPathComponent(), withIntermediateDirectories: true)
                try fileData.write(to: dest)
                downloadProgress = Double(i + 1) / totalFiles
            }

            downloadProgress = 1.0
            loadBackups()
            return true
        } catch {
            lastError = "Download failed: \(error.localizedDescription)"
            return false
        }
    }

    /// iOS: delete backup from Mac server via HTTP.
    func deleteRemoteBackup(_ backup: BackupMetadata) async {
        guard isServerConfigured else { return }
        let path = LocalSyncProtocol.Path.backup(backupId: backup.directoryName)
        _ = try? await makeServerRequest(path: path, method: "DELETE")
        logger.info("Deleted remote backup: \(backup.directoryName)")
        await loadRemoteBackups()
    }
    #endif

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

        // Checkpoint the restored WAL into the main store file so SwiftData
        // opens a consistent database without relying on WAL replay.
        // No other process holds a connection at this point, so TRUNCATE is safe.
        let restoredStorePath = storeDir.appending(path: "default.store").path
        var db: OpaquePointer?
        if sqlite3_open_v2(restoredStorePath, &db, SQLITE_OPEN_READWRITE, nil) == SQLITE_OK {
            sqlite3_exec(db, "PRAGMA wal_checkpoint(TRUNCATE)", nil, nil, nil)
            sqlite3_close(db)
            logger.info("Post-restore WAL checkpoint completed")
        } else {
            sqlite3_close(db)
            logger.warning("Could not open restored store for WAL checkpoint")
        }
        // Remove now-empty WAL and SHM files
        for suffix in ["-wal", "-shm"] {
            let fileURL = storeDir.appending(path: "default.store\(suffix)")
            try? fm.removeItem(at: fileURL)
        }

        // Restore external storage support directory (SwiftData @Attribute(.externalStorage))
        let currentSupport = storeDir.appending(path: ".default_SUPPORT")
        if fm.fileExists(atPath: currentSupport.path) {
            try fm.removeItem(at: currentSupport)
        }
        let backupSupport = backupDir.appendingPathComponent(".default_SUPPORT")
        if fm.fileExists(atPath: backupSupport.path) {
            try fm.copyItem(at: backupSupport, to: currentSupport)
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

        // Mark schema version as current so migrateStoreIfNeeded() doesn't
        // delete the restored database thinking it's from an old schema.
        UserDefaults.standard.set(currentSchemaVersion, forKey: "SwiftDataSchemaVersion")

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
        let execResult = sqlite3_exec(db, "PRAGMA wal_checkpoint(PASSIVE)", nil, nil, &errMsg)
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
        // Copy external storage support directory (SwiftData @Attribute(.externalStorage))
        let supportDir = storeDir.appending(path: ".default_SUPPORT")
        if fm.fileExists(atPath: supportDir.path) {
            try fm.copyItem(at: supportDir, to: destination.appendingPathComponent(".default_SUPPORT"))
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
