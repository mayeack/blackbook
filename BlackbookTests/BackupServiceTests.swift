import Testing
import Foundation
@testable import Blackbook

// MARK: - BackupMetadata Tests

@Suite("BackupMetadata")
struct BackupMetadataTests {

    @Test("Codable roundtrip preserves all fields")
    func codableRoundtrip() throws {
        let original = BackupMetadata(
            label: "Test backup",
            type: .manual,
            recordCounts: ["Contacts": 42, "Interactions": 100, "Notes": 15],
            totalSizeBytes: 1_048_576,
            scoringWeights: ["recencyWeight": 0.35, "frequencyWeight": 0.30],
            directoryName: "2026-03-29T14-30-00Z"
        )

        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let data = try encoder.encode(original)

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let decoded = try decoder.decode(BackupMetadata.self, from: data)

        #expect(decoded.id == original.id)
        #expect(decoded.label == "Test backup")
        #expect(decoded.type == .manual)
        #expect(decoded.recordCounts["Contacts"] == 42)
        #expect(decoded.recordCounts["Interactions"] == 100)
        #expect(decoded.recordCounts["Notes"] == 15)
        #expect(decoded.totalSizeBytes == 1_048_576)
        #expect(decoded.scoringWeights["recencyWeight"] == 0.35)
        #expect(decoded.directoryName == "2026-03-29T14-30-00Z")
        #expect(decoded.appVersion == original.appVersion)
    }

    @Test("totalRecords sums all record counts")
    func totalRecords() {
        let metadata = BackupMetadata(
            type: .automatic,
            recordCounts: ["Contacts": 10, "Interactions": 20, "Notes": 5],
            totalSizeBytes: 0,
            scoringWeights: [:],
            directoryName: "test"
        )
        #expect(metadata.totalRecords == 35)
    }

    @Test("formattedSize returns human readable size")
    func formattedSize() {
        let metadata = BackupMetadata(
            type: .manual,
            recordCounts: [:],
            totalSizeBytes: 1_048_576,
            scoringWeights: [:],
            directoryName: "test"
        )
        // Should be "1 MB" or similar locale-specific format
        #expect(!metadata.formattedSize.isEmpty)
    }

    @Test("BackupType display names are correct")
    func backupTypeDisplayNames() {
        #expect(BackupType.manual.displayName == "Manual")
        #expect(BackupType.automatic.displayName == "Auto")
        #expect(BackupType.preRestore.displayName == "Pre-Restore")
    }

    @Test("BackupType codable roundtrip")
    func backupTypeCodable() throws {
        for type in [BackupType.manual, .automatic, .preRestore] {
            let data = try JSONEncoder().encode(type)
            let decoded = try JSONDecoder().decode(BackupType.self, from: data)
            #expect(decoded == type)
        }
    }
}

// MARK: - BackupService Static Methods Tests

@Suite("BackupService file operations")
struct BackupServiceFileTests {

    @Test("checkPendingRestore returns nil when no sentinel exists")
    func noPendingRestore() {
        // Clean up any leftover sentinel
        try? FileManager.default.removeItem(at: BackupService.sentinelURL)
        let result = BackupService.checkPendingRestore()
        #expect(result == nil)
    }

    @Test("checkPendingRestore returns nil for sentinel pointing to missing directory")
    func pendingRestoreMissingDir() throws {
        let fm = FileManager.default
        try fm.createDirectory(at: BackupService.backupsDirectory, withIntermediateDirectories: true)
        try "nonexistent-dir".write(to: BackupService.sentinelURL, atomically: true, encoding: .utf8)

        let result = BackupService.checkPendingRestore()
        #expect(result == nil)
        // Sentinel should be cleaned up
        #expect(!fm.fileExists(atPath: BackupService.sentinelURL.path))
    }

    @Test("checkPendingRestore returns URL for valid sentinel")
    func pendingRestoreValid() throws {
        let fm = FileManager.default
        let testDirName = "test-backup-\(UUID().uuidString)"
        let backupsDir = BackupService.backupsDirectory
        let testDir = backupsDir.appendingPathComponent(testDirName, isDirectory: true)
        try fm.createDirectory(at: testDir, withIntermediateDirectories: true)

        // Verify directory was actually created
        #expect(fm.fileExists(atPath: testDir.path))

        let sentinel = BackupService.sentinelURL
        try testDirName.write(to: sentinel, atomically: true, encoding: .utf8)
        #expect(fm.fileExists(atPath: sentinel.path))

        let result = BackupService.checkPendingRestore()

        // Cleanup regardless of result
        try? fm.removeItem(at: testDir)
        try? fm.removeItem(at: sentinel)

        #expect(result != nil)
        #expect(result?.lastPathComponent == testDirName)
    }

    @Test("Backup service loads empty list when no backups directory exists")
    func loadBackupsEmpty() {
        let service = BackupService()
        // Move the backups directory aside temporarily if it exists
        let fm = FileManager.default
        let tempPath = BackupService.backupsDirectory.deletingLastPathComponent()
            .appendingPathComponent("Backups-test-aside", isDirectory: true)
        let moved = fm.fileExists(atPath: BackupService.backupsDirectory.path)
        if moved {
            try? fm.moveItem(at: BackupService.backupsDirectory, to: tempPath)
        }

        service.loadBackups()
        #expect(service.backups.isEmpty)

        // Restore
        if moved {
            try? fm.moveItem(at: tempPath, to: BackupService.backupsDirectory)
        }
    }

    @Test("checkAutoBackupNeeded returns true when never backed up")
    func autoBackupNeededNeverBacked() {
        let defaults = UserDefaults.standard
        defaults.removeObject(forKey: AppConstants.Backup.lastAutoBackupKey)
        defaults.removeObject(forKey: AppConstants.Backup.autoBackupEnabledKey)

        let service = BackupService()
        #expect(service.checkAutoBackupNeeded() == true)
    }

    @Test("checkAutoBackupNeeded returns false when recently backed up")
    func autoBackupNotNeeded() {
        let defaults = UserDefaults.standard
        defaults.set(true, forKey: AppConstants.Backup.autoBackupEnabledKey)
        defaults.set(Date(), forKey: AppConstants.Backup.lastAutoBackupKey)

        let service = BackupService()
        #expect(service.checkAutoBackupNeeded() == false)

        // Cleanup
        defaults.removeObject(forKey: AppConstants.Backup.autoBackupEnabledKey)
        defaults.removeObject(forKey: AppConstants.Backup.lastAutoBackupKey)
    }

    @Test("checkAutoBackupNeeded returns false when disabled")
    func autoBackupDisabled() {
        let defaults = UserDefaults.standard
        defaults.set(false, forKey: AppConstants.Backup.autoBackupEnabledKey)

        let service = BackupService()
        #expect(service.checkAutoBackupNeeded() == false)

        defaults.removeObject(forKey: AppConstants.Backup.autoBackupEnabledKey)
    }
}

// MARK: - Scoring Weights Tests

@Suite("Scoring weights snapshot")
struct ScoringWeightsTests {

    @Test("Default scoring weights match constants")
    func defaultWeights() {
        let defaults = UserDefaults.standard
        // Clear any custom values
        for key in ["scoring.recencyWeight", "scoring.frequencyWeight", "scoring.varietyWeight", "scoring.sentimentWeight", "scoring.fadingThreshold"] {
            defaults.removeObject(forKey: key)
        }

        // Create a metadata with default weights to verify the pattern
        let metadata = BackupMetadata(
            type: .manual,
            recordCounts: [:],
            totalSizeBytes: 0,
            scoringWeights: [
                "recencyWeight": AppConstants.Scoring.recencyWeight,
                "frequencyWeight": AppConstants.Scoring.frequencyWeight,
                "varietyWeight": AppConstants.Scoring.varietyWeight,
                "sentimentWeight": AppConstants.Scoring.sentimentWeight,
                "fadingThreshold": AppConstants.Scoring.fadingThreshold,
            ],
            directoryName: "test"
        )

        #expect(metadata.scoringWeights["recencyWeight"] == 0.35)
        #expect(metadata.scoringWeights["frequencyWeight"] == 0.30)
        #expect(metadata.scoringWeights["varietyWeight"] == 0.15)
        #expect(metadata.scoringWeights["sentimentWeight"] == 0.20)
        #expect(metadata.scoringWeights["fadingThreshold"] == 30.0)
    }
}
