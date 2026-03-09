import XCTest
@testable import Blackbook

final class ConstantsTests: XCTestCase {

    func testAppName() {
        XCTAssertEqual(AppConstants.appName, "Blackbook")
    }

    func testScoringWeightsSumToOne() {
        let total = AppConstants.Scoring.recencyWeight +
                    AppConstants.Scoring.frequencyWeight +
                    AppConstants.Scoring.varietyWeight +
                    AppConstants.Scoring.sentimentWeight
        XCTAssertEqual(total, 1.0, accuracy: 0.001)
    }

    func testSubscriptionProductIdsAreValid() {
        XCTAssertTrue(AppConstants.Subscription.monthlyProductId.starts(with: "com.blackbookdevelopment"))
        XCTAssertTrue(AppConstants.Subscription.yearlyProductId.starts(with: "com.blackbookdevelopment"))
    }

    func testFreeContactLimitIsReasonable() {
        XCTAssertGreaterThan(AppConstants.Subscription.freeContactLimit, 0)
        XCTAssertLessThanOrEqual(AppConstants.Subscription.freeContactLimit, 100)
    }

    func testAWSConstants() {
        XCTAssertFalse(AppConstants.AWS.graphQLAPIName.isEmpty)
        XCTAssertFalse(AppConstants.AWS.s3PhotoPrefix.isEmpty)
    }

    func testAuthConstants() {
        XCTAssertFalse(AppConstants.Auth.keychainServiceName.isEmpty)
        XCTAssertFalse(AppConstants.Auth.biometricEnabledKey.isEmpty)
    }

    func testScoreColorBoundaries() {
        let strong = AppConstants.UI.scoreColor(for: 70)
        let moderate = AppConstants.UI.scoreColor(for: 40)
        let fading = AppConstants.UI.scoreColor(for: 10)
        let dormant = AppConstants.UI.scoreColor(for: 5)

        XCTAssertEqual(strong, AppConstants.UI.strongGreen)
        XCTAssertEqual(moderate, AppConstants.UI.moderateAmber)
        XCTAssertEqual(fading, AppConstants.UI.fadingRed)
        XCTAssertEqual(dormant, AppConstants.UI.dormantGray)
    }
}
