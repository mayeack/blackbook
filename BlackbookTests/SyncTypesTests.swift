import XCTest
@testable import Blackbook

final class SyncTypesTests: XCTestCase {

    func testSyncStatusRawValues() {
        XCTAssertEqual(SyncStatus.synced.rawValue, "synced")
        XCTAssertEqual(SyncStatus.pending.rawValue, "pending")
        XCTAssertEqual(SyncStatus.modified.rawValue, "modified")
        XCTAssertEqual(SyncStatus.deleted.rawValue, "deleted")
        XCTAssertEqual(SyncStatus.conflict.rawValue, "conflict")
    }

    func testSyncRecordCodable() throws {
        let record = SyncRecord(
            id: "test-id",
            modelType: "Contact",
            operation: .create,
            payload: Data("test".utf8),
            timestamp: Date()
        )

        let data = try JSONEncoder().encode(record)
        let decoded = try JSONDecoder().decode(SyncRecord.self, from: data)

        XCTAssertEqual(decoded.id, record.id)
        XCTAssertEqual(decoded.modelType, record.modelType)
        XCTAssertEqual(decoded.operation, record.operation)
        XCTAssertEqual(decoded.payload, record.payload)
    }

    func testSyncOperationRawValues() {
        XCTAssertEqual(SyncRecord.SyncOperation.create.rawValue, "create")
        XCTAssertEqual(SyncRecord.SyncOperation.update.rawValue, "update")
        XCTAssertEqual(SyncRecord.SyncOperation.delete.rawValue, "delete")
    }
}
