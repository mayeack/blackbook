import XCTest
@testable import Blackbook

final class NoteModelTests: XCTestCase {

    // MARK: - NoteCategory enum

    func testNoteCategoryRawValues() {
        XCTAssertEqual(NoteCategory.general.rawValue, "General")
        XCTAssertEqual(NoteCategory.personal.rawValue, "Personal")
        XCTAssertEqual(NoteCategory.professional.rawValue, "Professional")
        XCTAssertEqual(NoteCategory.topicDiscussed.rawValue, "Topic Discussed")
    }

    func testNoteCategoryCaseCount() {
        XCTAssertEqual(NoteCategory.allCases.count, 4)
    }

    func testNoteCategoryIconsAreNonEmpty() {
        for category in NoteCategory.allCases {
            XCTAssertFalse(category.icon.isEmpty, "\(category.rawValue) should have a non-empty icon")
        }
    }

    func testNoteCategoryIdentifiable() {
        for category in NoteCategory.allCases {
            XCTAssertEqual(category.id, category.rawValue)
        }
    }
}
