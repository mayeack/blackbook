import Foundation
import Amplify
import Observation
import os

private let logger = Logger(subsystem: "com.blackbookdevelopment.app", category: "PhotoStorage")

@Observable
final class PhotoStorageService {
    static let shared = PhotoStorageService()

    private let cacheDirectory: URL
    private let maxCacheSize: Int = 100 * 1024 * 1024 // 100 MB

    private init() {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
        cacheDirectory = caches.appendingPathComponent("contact-photos", isDirectory: true)
        try? FileManager.default.createDirectory(at: cacheDirectory, withIntermediateDirectories: true)
    }

    // MARK: - Upload

    func uploadPhoto(data: Data, contactId: UUID) async -> String? {
        let key = "\(AppConstants.AWS.s3PhotoPrefix)/\(contactId.uuidString).jpg"

        do {
            let uploadTask = Amplify.Storage.uploadData(
                key: key,
                data: data,
                options: .init(accessLevel: .private, contentType: "image/jpeg")
            )
            _ = try await uploadTask.value
            cacheLocally(data: data, key: key)
            logger.info("Photo uploaded for contact \(contactId)")
            return key
        } catch {
            logger.error("Photo upload failed: \(error.localizedDescription)")
            return nil
        }
    }

    // MARK: - Download

    func downloadPhoto(key: String) async -> Data? {
        if let cached = loadFromCache(key: key) {
            return cached
        }

        do {
            let downloadTask = Amplify.Storage.downloadData(
                key: key,
                options: .init(accessLevel: .private)
            )
            let data = try await downloadTask.value
            cacheLocally(data: data, key: key)
            logger.info("Photo downloaded: \(key)")
            return data
        } catch {
            logger.error("Photo download failed for \(key): \(error.localizedDescription)")
            return nil
        }
    }

    // MARK: - Delete

    func deletePhoto(key: String) async {
        do {
            try await Amplify.Storage.remove(
                key: key,
                options: .init(accessLevel: .private)
            )
            removeFromCache(key: key)
            logger.info("Photo deleted: \(key)")
        } catch {
            logger.error("Photo delete failed for \(key): \(error.localizedDescription)")
        }
    }

    // MARK: - Local Cache

    private func cacheFilePath(for key: String) -> URL {
        let sanitized = key
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "\\", with: "_")
        return cacheDirectory.appendingPathComponent(sanitized)
    }

    private func cacheLocally(data: Data, key: String) {
        let path = cacheFilePath(for: key)
        try? data.write(to: path)
    }

    private func loadFromCache(key: String) -> Data? {
        let path = cacheFilePath(for: key)
        guard FileManager.default.fileExists(atPath: path.path) else { return nil }
        return try? Data(contentsOf: path)
    }

    private func removeFromCache(key: String) {
        let path = cacheFilePath(for: key)
        try? FileManager.default.removeItem(at: path)
    }

    func clearCache() {
        try? FileManager.default.removeItem(at: cacheDirectory)
        try? FileManager.default.createDirectory(at: cacheDirectory, withIntermediateDirectories: true)
        logger.info("Photo cache cleared")
    }
}
