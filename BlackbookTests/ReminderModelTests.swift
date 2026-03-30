import XCTest
@testable import Blackbook

final class ReminderModelTests: XCTestCase {

    // MARK: - Recurrence enum

    func testRecurrenceRawValues() {
        XCTAssertEqual(Recurrence.weekly.rawValue, "Weekly")
        XCTAssertEqual(Recurrence.biweekly.rawValue, "Biweekly")
        XCTAssertEqual(Recurrence.monthly.rawValue, "Monthly")
        XCTAssertEqual(Recurrence.quarterly.rawValue, "Quarterly")
    }

    func testRecurrenceCaseCount() {
        XCTAssertEqual(Recurrence.allCases.count, 4)
    }

    func testRecurrenceIdentifiable() {
        for recurrence in Recurrence.allCases {
            XCTAssertEqual(recurrence.id, recurrence.rawValue)
        }
    }
}
