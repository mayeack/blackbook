import XCTest
@testable import Blackbook

final class KeychainServiceTests: XCTestCase {

    private let testService = "com.blackbookdevelopment.test.\(UUID().uuidString)"
    private let testAccount = "test-account"

    override func tearDown() {
        // Clean up any test keys
        KeychainService.delete(service: testService, account: testAccount)
        KeychainService.delete(service: testService, account: "account-2")
        super.tearDown()
    }

    func testSaveAndRetrieve() {
        let saved = KeychainService.save("secret-value", service: testService, account: testAccount)
        XCTAssertTrue(saved)

        let retrieved = KeychainService.retrieve(service: testService, account: testAccount)
        XCTAssertEqual(retrieved, "secret-value")
    }

    func testUpdateExistingKey() {
        KeychainService.save("original", service: testService, account: testAccount)

        let updated = KeychainService.save("updated-value", service: testService, account: testAccount)
        XCTAssertTrue(updated)

        let retrieved = KeychainService.retrieve(service: testService, account: testAccount)
        XCTAssertEqual(retrieved, "updated-value")
    }

    func testDeleteKey() {
        KeychainService.save("to-delete", service: testService, account: testAccount)

        KeychainService.delete(service: testService, account: testAccount)

        let retrieved = KeychainService.retrieve(service: testService, account: testAccount)
        XCTAssertNil(retrieved)
    }

    func testRetrieveNonexistentReturnsNil() {
        let retrieved = KeychainService.retrieve(service: testService, account: "nonexistent-account")
        XCTAssertNil(retrieved)
    }
}
