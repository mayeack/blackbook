import Foundation

/// Tracks the local sync state of a model record relative to the remote store.
enum SyncStatus: String, Codable {
    case synced
    case pending
    case modified
    case deleted
    case conflict
}

/// Indicates whether a sync operation sends local changes or fetches remote changes.
enum SyncDirection {
    case push
    case pull
}

/// A serializable record describing a single create, update, or delete operation to sync.
struct SyncRecord: Codable, Sendable {
    let id: String
    let modelType: String
    let operation: SyncOperation
    let payload: Data
    let timestamp: Date

    enum SyncOperation: String, Codable {
        case create
        case update
        case delete
    }
}
