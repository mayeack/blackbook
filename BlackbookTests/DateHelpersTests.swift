import XCTest
@testable import Blackbook

final class DateHelpersTests: XCTestCase {

    // MARK: - Date.daysAgo

    func testDaysAgoCreatesDateInThePast() {
        let date = Date.daysAgo(5)
        XCTAssertTrue(date < Date())
    }

    func testDaysAgoZeroIsToday() {
        let date = Date.daysAgo(0)
        XCTAssertTrue(Calendar.current.isDateInToday(date))
    }

    // MARK: - daysSinceNow

    func testDaysSinceNowReturnsCorrectCount() {
        let date = Date.daysAgo(7)
        XCTAssertEqual(date.daysSinceNow, 7)
    }

    func testDaysSinceNowForTodayIsZero() {
        XCTAssertEqual(Date().daysSinceNow, 0)
    }

    // MARK: - isToday

    func testIsTodayReturnsTrueForToday() {
        XCTAssertTrue(Date().isToday)
    }

    func testIsTodayReturnsFalseForYesterday() {
        let yesterday = Date.daysAgo(1)
        XCTAssertFalse(yesterday.isToday)
    }

    // MARK: - isThisWeek

    func testIsThisWeekReturnsTrueForToday() {
        XCTAssertTrue(Date().isThisWeek)
    }

    func testIsThisWeekReturnsFalseForTenDaysAgo() {
        let tenDaysAgo = Date.daysAgo(10)
        XCTAssertFalse(tenDaysAgo.isThisWeek)
    }

    // MARK: - isThisMonth

    func testIsThisMonthReturnsTrueForToday() {
        XCTAssertTrue(Date().isThisMonth)
    }

    func testIsThisMonthReturnsFalseForFortyDaysAgo() {
        let fortyDaysAgo = Date.daysAgo(40)
        XCTAssertFalse(fortyDaysAgo.isThisMonth)
    }

    // MARK: - TimeInterval.formattedDuration

    func testFormattedDurationUnderSixtyMinutes() {
        let duration: TimeInterval = 45
        XCTAssertEqual(duration.formattedDuration, "45m")
    }

    func testFormattedDurationExactlySixtyMinutes() {
        let duration: TimeInterval = 60
        XCTAssertEqual(duration.formattedDuration, "1h")
    }

    func testFormattedDurationMixedHoursAndMinutes() {
        let duration: TimeInterval = 90
        XCTAssertEqual(duration.formattedDuration, "1h 30m")
    }

    func testFormattedDurationZeroMinutes() {
        let duration: TimeInterval = 0
        XCTAssertEqual(duration.formattedDuration, "0m")
    }

    // MARK: - relativeDescription

    func testRelativeDescriptionReturnsNonEmptyString() {
        let date = Date.daysAgo(3)
        XCTAssertFalse(date.relativeDescription.isEmpty)
    }

    // MARK: - shortFormatted / longFormatted

    func testShortFormattedReturnsNonEmptyString() {
        XCTAssertFalse(Date().shortFormatted.isEmpty)
    }

    func testLongFormattedReturnsNonEmptyString() {
        XCTAssertFalse(Date().longFormatted.isEmpty)
    }
}
