import XCTest
@testable import Blackbook

final class SFSymbolSearchServiceTests: XCTestCase {

    func testExactKeywordMatch() {
        let results = SFSymbolSearchService.suggestIcons(for: "restaurant")

        XCTAssertTrue(results.contains("fork.knife"), "Expected 'fork.knife' for query 'restaurant', got: \(results)")
    }

    func testEmptyQueryReturnsDefaults() {
        let defaults = ["star", "heart", "globe"]
        let results = SFSymbolSearchService.suggestIcons(for: "", defaults: defaults)

        XCTAssertEqual(results, defaults)
    }

    func testLimitRespected() {
        let limit = 3
        let results = SFSymbolSearchService.suggestIcons(for: "city", limit: limit)

        XCTAssertLessThanOrEqual(results.count, limit)
    }

    func testUnknownQueryFallsBackToDefaults() {
        let defaults = ["star", "heart", "globe", "mappin", "flag", "pin"]
        let results = SFSymbolSearchService.suggestIcons(for: "xyzzyqwertynonsense", defaults: defaults)

        // With no matches and fewer than 6 results, defaults should be used
        XCTAssertFalse(results.isEmpty)
        // Should contain items from defaults
        let defaultSet = Set(defaults)
        let resultSet = Set(results)
        XCTAssertFalse(resultSet.isDisjoint(with: defaultSet), "Expected results to contain some defaults")
    }

    func testPartialMatch() {
        let results = SFSymbolSearchService.suggestIcons(for: "gym")

        XCTAssertTrue(results.contains("dumbbell"), "Expected 'dumbbell' for query 'gym', got: \(results)")
    }
}
