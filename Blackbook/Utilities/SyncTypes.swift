import Foundation

enum SyncStatus: String, Codable {
    case synced
    case pending
    case modified
    case deleted
    case conflict
}

enum SyncDirection {
    case push
    case pull
}

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
