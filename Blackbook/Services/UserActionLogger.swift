import Foundation
import Observation
import CryptoKit
import os
#if canImport(UIKit)
import UIKit
#endif

private let logger = Logger(subsystem: "com.blackbookdevelopment.app", category: "ActionLog")

/// One serialized JSON-line entry written to disk and uploaded to the backup server.
struct UserActionLogEntry: Codable {
    let id: UUID
    let timestamp: Date
    let email: String
    let action: String
    let metadata: [String: String]
    let durationMs: Int?
    let success: Bool?
    let error: String?
    let appVersion: String
    let device: String
    let platform: String
}

/// Verbose per-user action logger. Writes JSONL files under
/// `<Application Support>/Blackbook/Logs/{sanitized_email}/actions-YYYY-MM-DD.jsonl`
/// and uploads them to the backup server via `POST /logs/{filename}`.
@Observable
final class UserActionLogger: @unchecked Sendable {
    static let shared = UserActionLogger()

    private(set) var recentEntries: [UserActionLogEntry] = []
    private(set) var lastUploadDate: Date?
    private(set) var lastUploadError: String?
    private(set) var isUploading = false

    private let writeQueue = DispatchQueue(label: "com.blackbookdevelopment.actionlog", qos: .utility)
    private let maxFileBytes: Int = 5 * 1024 * 1024
    private let inMemoryCap = 50
    private let uploadedHashesKey = "actionlog.uploadedHashes"

    private var userEmail: String?

    private static let isoFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let dateFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        return f
    }()

    private static let rotationFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd-HHmmss"
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        return f
    }()

    private init() {
        userEmail = UserDefaults.standard.string(forKey: "auth.userEmail")
    }

    // MARK: - Public API

    func setUserEmail(_ email: String?) {
        writeQueue.async { [weak self] in
            self?.userEmail = email
        }
    }

    func log(_ action: String,
             metadata: [String: String] = [:],
             durationMs: Int? = nil,
             success: Bool? = nil,
             error: String? = nil) {
        let entry = UserActionLogEntry(
            id: UUID(),
            timestamp: Date(),
            email: userEmail ?? "anonymous",
            action: action,
            metadata: metadata,
            durationMs: durationMs,
            success: success,
            error: error,
            appVersion: Self.appVersion,
            device: Self.deviceName,
            platform: Self.platform
        )
        writeQueue.async { [weak self] in
            self?.append(entry)
        }
    }

    func uploadPending() async {
        guard !isUploading else { return }
        isUploading = true
        defer { isUploading = false }

        await withCheckedContinuation { continuation in
            writeQueue.async { [weak self] in
                self?.performUpload()
                continuation.resume()
            }
        }
    }

    func currentLogFileURL(for date: Date = Date()) -> URL? {
        guard let dir = userLogDirectory() else { return nil }
        let filename = "actions-\(Self.dateFormatter.string(from: date)).jsonl"
        return dir.appendingPathComponent(filename)
    }

    // MARK: - Disk I/O (always on writeQueue)

    private func append(_ entry: UserActionLogEntry) {
        recentEntries.append(entry)
        if recentEntries.count > inMemoryCap {
            recentEntries.removeFirst(recentEntries.count - inMemoryCap)
        }

        guard let fileURL = currentLogFileURL(for: entry.timestamp) else { return }
        do {
            try ensureDirectory(for: fileURL)
            rotateIfNeeded(at: fileURL)

            let encoder = JSONEncoder()
            encoder.dateEncodingStrategy = .iso8601
            encoder.outputFormatting = [.sortedKeys]
            var data = try encoder.encode(entry)
            data.append(0x0A)

            if FileManager.default.fileExists(atPath: fileURL.path) {
                let handle = try FileHandle(forWritingTo: fileURL)
                try handle.seekToEnd()
                try handle.write(contentsOf: data)
                try handle.close()
            } else {
                try data.write(to: fileURL)
            }
        } catch {
            logger.error("Failed to append log entry: \(error.localizedDescription)")
        }
    }

    private func rotateIfNeeded(at fileURL: URL) {
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return }
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: fileURL.path),
              let size = attrs[.size] as? Int, size >= maxFileBytes else { return }
        let dir = fileURL.deletingLastPathComponent()
        let rotated = dir.appendingPathComponent("actions-\(Self.rotationFormatter.string(from: Date())).jsonl")
        do {
            try FileManager.default.moveItem(at: fileURL, to: rotated)
            logger.info("Rotated log file to \(rotated.lastPathComponent)")
        } catch {
            logger.warning("Log rotation failed: \(error.localizedDescription)")
        }
    }

    private func ensureDirectory(for fileURL: URL) throws {
        let dir = fileURL.deletingLastPathComponent()
        if !FileManager.default.fileExists(atPath: dir.path) {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        }
    }

    private func userLogDirectory() -> URL? {
        guard let email = userEmail, !email.isEmpty else { return nil }
        let sanitized = BackupService.sanitizeEmail(email)
        let dir = URL.applicationSupportDirectory
            .appendingPathComponent("Blackbook/Logs", isDirectory: true)
            .appendingPathComponent(sanitized, isDirectory: true)
        return dir
    }

    // MARK: - Upload

    private func performUpload() {
        guard let dir = userLogDirectory(),
              FileManager.default.fileExists(atPath: dir.path) else { return }
        let contents = (try? FileManager.default.contentsOfDirectory(
            at: dir, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
        let logFiles = contents
            .filter { $0.lastPathComponent.hasSuffix(".jsonl") }
            .sorted { lhs, rhs in
                let lDate = (try? lhs.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
                let rDate = (try? rhs.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
                return lDate < rDate
            }
        guard !logFiles.isEmpty else { return }

        var hashes = (UserDefaults.standard.dictionary(forKey: uploadedHashesKey) as? [String: String]) ?? [:]
        var uploadedAny = false

        for fileURL in logFiles {
            let filename = fileURL.lastPathComponent
            guard let data = try? Data(contentsOf: fileURL) else { continue }
            let digest = SHA256.hash(data: data)
            let hex = digest.map { String(format: "%02x", $0) }.joined()
            if hashes[filename] == hex { continue }

            let semaphore = DispatchSemaphore(value: 0)
            var didSucceed = false
            uploadFile(filename: filename, data: data) { ok in
                didSucceed = ok
                semaphore.signal()
            }
            semaphore.wait()

            if didSucceed {
                hashes[filename] = hex
                uploadedAny = true
            }
        }

        if uploadedAny {
            UserDefaults.standard.set(hashes, forKey: uploadedHashesKey)
            DispatchQueue.main.async { [weak self] in
                self?.lastUploadDate = Date()
                self?.lastUploadError = nil
            }
            cleanupRotatedFiles(in: dir)
        }
    }

    private func uploadFile(filename: String, data: Data, completion: @escaping (Bool) -> Void) {
        guard let request = makeUploadRequest(filename: filename, body: data) else {
            completion(false); return
        }
        URLSession.shared.dataTask(with: request) { [weak self] _, response, error in
            if let error {
                logger.warning("Log upload failed for \(filename): \(error.localizedDescription)")
                DispatchQueue.main.async { self?.lastUploadError = error.localizedDescription }
                completion(false); return
            }
            if let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) {
                completion(true)
            } else {
                let code = (response as? HTTPURLResponse)?.statusCode ?? -1
                logger.warning("Log upload returned status \(code) for \(filename)")
                completion(false)
            }
        }.resume()
    }

    private func makeUploadRequest(filename: String, body: Data) -> URLRequest? {
        guard let email = userEmail, !email.isEmpty else { return nil }
        guard let baseURLString = serverBaseURL, let url = URL(string: baseURLString + "/logs/\(filename)") else { return nil }
        guard let password = serverPassword else { return nil }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue(password, forHTTPHeaderField: LocalSyncProtocol.passwordHeader)
        request.setValue(email, forHTTPHeaderField: LocalSyncProtocol.userEmailHeader)
        request.setValue("application/x-ndjson", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        return request
    }

    /// On macOS the server URL is the local default; on iOS read from Keychain.
    private var serverBaseURL: String? {
        #if os(macOS)
        return "http://127.0.0.1:\(LocalSyncProtocol.defaultPort)"
        #else
        return KeychainService.retrieve(
            service: AppConstants.LocalSync.keychainServiceName,
            account: AppConstants.LocalSync.keychainServerURLAccount
        )
        #endif
    }

    private var serverPassword: String? {
        #if os(macOS)
        guard let email = userEmail else { return nil }
        return BackupService.derivePassword(from: email)
        #else
        return KeychainService.retrieve(
            service: AppConstants.LocalSync.keychainServiceName,
            account: AppConstants.LocalSync.keychainPasswordAccount
        )
        #endif
    }

    private func cleanupRotatedFiles(in dir: URL) {
        guard let contents = try? FileManager.default.contentsOfDirectory(
            at: dir, includingPropertiesForKeys: [.contentModificationDateKey]) else { return }
        let cutoff = Date().addingTimeInterval(-24 * 3600)
        for url in contents {
            let name = url.lastPathComponent
            // Keep today's main log, only delete rotated ones (with HHmmss suffix).
            guard name.hasPrefix("actions-"), name.hasSuffix(".jsonl") else { continue }
            let stem = name.dropFirst("actions-".count).dropLast(".jsonl".count)
            // Rotated filenames are 17 chars: "yyyy-MM-dd-HHmmss". Daily files are 10 chars.
            guard stem.count > 10 else { continue }
            if let mtime = (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate,
               mtime < cutoff {
                try? FileManager.default.removeItem(at: url)
            }
        }
    }

    // MARK: - Static metadata

    private static var appVersion: String {
        (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "unknown"
    }

    private static var deviceName: String {
        BackupService.currentDeviceName
    }

    private static var platform: String {
        #if os(iOS)
        return "iOS"
        #elseif os(macOS)
        return "macOS"
        #else
        return "unknown"
        #endif
    }
}

/// Tiny convenience facade so call sites stay terse.
enum Log {
    static func action(_ name: String,
                       metadata: [String: String] = [:],
                       durationMs: Int? = nil,
                       success: Bool? = nil,
                       error: String? = nil) {
        UserActionLogger.shared.log(name, metadata: metadata,
                                    durationMs: durationMs,
                                    success: success, error: error)
    }
}
