import Foundation
import Observation
import os

private let logger = Logger(subsystem: "com.blackbookdevelopment.app", category: "PhotoStorage")

/// Manages contact photo storage on the local filesystem.
///
/// Photos are stored in the Application Support directory under `Blackbook/Photos/`.
/// A separate cache directory under Caches is used for fast access.
@Observable
final class PhotoStorageService {
    static let shared = PhotoStorageService()

    private let photosDirectory: URL
    private let cacheDirectory: URL

    private init() {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        photosDirectory = appSupport.appendingPathComponent("Blackbook/Photos", isDirectory: true)

        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
        cacheDirectory = caches.appendingPathComponent("contact-photos", isDirectory: true)

        do {
            try FileManager.default.createDirectory(at: photosDirectory, withIntermediateDirectories: true)
            try FileManager.default.createDirectory(at: cacheDirectory, withIntermediateDirectories: true)
        } catch {
            logger.error("Failed to create photo directories: \(error.localizedDescription)")
        }
    }

    // MARK: - Upload

    /// Saves a photo locally for the given contact and returns the storage key.
    ///
    /// - Parameters:
    ///   - data: The JPEG image data to store.
    ///   - contactId: The UUID of the contact this photo belongs to.
    /// - Returns: The storage key string, or nil if saving failed.
    func uploadPhoto(data: Data, contactId: UUID) async -> String? {
        let key = "\(AppConstants.AWS.s3PhotoPrefix)/\(contactId.uuidString).jpg"
        let fileURL = photosDirectory.appendingPathComponent("\(contactId.uuidString).jpg")

        do {
            try data.write(to: fileURL)
            cacheLocally(data: data, key: key)
            logger.info("Photo saved for contact \(contactId)")
            return key
        } catch {
            logger.error("Photo save failed: \(error.localizedDescription)")
            return nil
        }
    }

    // MARK: - Download

    /// Retrieves a photo by its storage key, checking cache first then primary storage.
    ///
    /// - Parameter key: The storage key returned by ``uploadPhoto(data:contactId:)``.
    /// - Returns: The image data, or nil if not found.
    func downloadPhoto(key: String) async -> Data? {
        if let cached = loadFromCache(key: key) {
            return cached
        }

        let filename = key.components(separatedBy: "/").last ?? key
        let fileURL = photosDirectory.appendingPathComponent(filename)

        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            logger.warning("Photo not found: \(key)")
            return nil
        }

        do {
            let data = try Data(contentsOf: fileURL)
            cacheLocally(data: data, key: key)
            logger.info("Photo loaded: \(key)")
            return data
        } catch {
            logger.error("Photo load failed for \(key): \(error.localizedDescription)")
            return nil
        }
    }

    // MARK: - Delete

    /// Removes a photo from both primary storage and cache.
    ///
    /// - Parameter key: The storage key of the photo to delete.
    func deletePhoto(key: String) async {
        let filename = key.components(separatedBy: "/").last ?? key
        let fileURL = photosDirectory.appendingPathComponent(filename)

        do {
            if FileManager.default.fileExists(atPath: fileURL.path) {
                try FileManager.default.removeItem(at: fileURL)
            }
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
        do {
            try data.write(to: path)
        } catch {
            logger.warning("Failed to cache photo \(key): \(error.localizedDescription)")
        }
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

    /// Clears the photo cache directory.
    func clearCache() {
        do {
            try FileManager.default.removeItem(at: cacheDirectory)
            try FileManager.default.createDirectory(at: cacheDirectory, withIntermediateDirectories: true)
            logger.info("Photo cache cleared")
        } catch {
            logger.error("Failed to clear photo cache: \(error.localizedDescription)")
        }
    }
}
