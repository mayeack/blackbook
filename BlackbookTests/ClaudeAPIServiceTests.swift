import XCTest
@testable import Blackbook

final class ClaudeAPIServiceTests: XCTestCase {

    private var service: ClaudeAPIService!

    override func setUp() {
        super.setUp()
        service = ClaudeAPIService()
    }

    override func tearDown() {
        service = nil
        super.tearDown()
    }

    // MARK: - extractJSON

    func testExtractJSONArray() {
        let text = "Here is the data: [1,2,3] done"
        let result = service.extractJSON(from: text)

        XCTAssertEqual(result, "[1,2,3]")
    }

    func testExtractJSONObject() {
        let text = "Result: {\"key\":\"val\"} end"
        let result = service.extractJSON(from: text)

        XCTAssertEqual(result, "{\"key\":\"val\"}")
    }

    func testExtractJSONFromMarkdown() {
        let text = "```json\n[1,2]\n```"
        let result = service.extractJSON(from: text)

        XCTAssertEqual(result, "[1,2]")
    }

    func testExtractJSONReturnsNilForPlainText() {
        let text = "This is just plain text with no JSON at all."
        let result = service.extractJSON(from: text)

        XCTAssertNil(result)
    }
}
