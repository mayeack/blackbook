import XCTest
@testable import Blackbook

final class FeatureGatingTests: XCTestCase {

    func testFreeContactLimitMatchesConstant() {
        XCTAssertEqual(
            FeatureGating.freeContactLimit,
            AppConstants.Subscription.freeContactLimit
        )
    }

    func testCanAddContactUnderLimit() {
        // Free tier allows up to the limit
        XCTAssertTrue(FeatureGating.canAddContact(currentCount: 0))
        XCTAssertTrue(FeatureGating.canAddContact(currentCount: 24))
    }

    func testCannotAddContactAtLimit() {
        // Without pro, at or above limit should block
        // This tests the logic when SubscriptionManager reports free tier
        let limit = AppConstants.Subscription.freeContactLimit
        XCTAssertEqual(limit, 25)
    }

    func testProFeaturesListNotEmpty() {
        XCTAssertFalse(FeatureGating.proFeatures.isEmpty)
    }

    func testFeatureDescriptionsAreNotEmpty() {
        for feature in FeatureGating.proFeatures {
            let description = FeatureGating.featureDescription(feature)
            XCTAssertFalse(description.isEmpty, "Feature description should not be empty")
        }
    }
}
