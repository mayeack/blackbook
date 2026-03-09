import SwiftUI
import StoreKit

struct SubscriptionView: View {
    @State private var subscriptionManager = SubscriptionManager.shared
    @State private var selectedProduct: Product?

    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                headerSection
                    .padding(.top, 20)

                if subscriptionManager.isPro {
                    activeSubscriptionBanner
                } else {
                    featureList
                    productCards
                    restoreButton
                }
            }
            .padding(.horizontal)
            .frame(maxWidth: 500)
            .frame(maxWidth: .infinity)
        }
        .navigationTitle("Subscription")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
    }

    // MARK: - Header

    private var headerSection: some View {
        VStack(spacing: 12) {
            Image(systemName: "crown.fill")
                .font(.system(size: 48))
                .foregroundStyle(AppConstants.UI.accentGold)

            Text(subscriptionManager.isPro ? "Blackbook Pro" : "Upgrade to Pro")
                .font(.title.bold())

            if !subscriptionManager.isPro {
                Text("Unlock the full power of your relationship network")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
        }
    }

    // MARK: - Active Subscription

    private var activeSubscriptionBanner: some View {
        VStack(spacing: 16) {
            HStack(spacing: 12) {
                Image(systemName: "checkmark.seal.fill")
                    .font(.title2)
                    .foregroundStyle(.green)
                VStack(alignment: .leading, spacing: 4) {
                    Text("Pro Plan Active")
                        .font(.headline)
                    Text("You have access to all features")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                Spacer()
            }
            .padding()
            .background(Color.green.opacity(0.1), in: RoundedRectangle(cornerRadius: 12, style: .continuous))

            #if os(iOS)
            Button("Manage Subscription") {
                Task {
                    if let scene = await UIApplication.shared.connectedScenes.first as? UIWindowScene {
                        try? await AppStore.showManageSubscriptions(in: scene)
                    }
                }
            }
            .font(.subheadline)
            .foregroundStyle(AppConstants.UI.accentGold)
            #else
            Link("Manage Subscription", destination: URL(string: "https://apps.apple.com/account/subscriptions")!)
                .font(.subheadline)
                .foregroundStyle(AppConstants.UI.accentGold)
            #endif
        }
    }

    // MARK: - Feature List

    private var featureList: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(FeatureGating.proFeatures, id: \.self) { feature in
                HStack(spacing: 12) {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(AppConstants.UI.accentGold)
                    Text(FeatureGating.featureDescription(feature))
                        .font(.body)
                    Spacer()
                }
            }
        }
        .padding()
        .background(AppConstants.UI.cardBackground, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    // MARK: - Product Cards

    private var productCards: some View {
        VStack(spacing: 12) {
            if subscriptionManager.isLoading && subscriptionManager.products.isEmpty {
                ProgressView()
                    .padding()
            }

            ForEach(subscriptionManager.products, id: \.id) { product in
                productCard(product)
            }

            if let error = subscriptionManager.error {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
    }

    private func productCard(_ product: Product) -> some View {
        let isYearly = product.id == AppConstants.Subscription.yearlyProductId
        let isSelected = selectedProduct?.id == product.id

        return Button {
            selectedProduct = product
            Task {
                _ = await subscriptionManager.purchase(product)
            }
        } label: {
            VStack(spacing: 8) {
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 6) {
                            Text(product.displayName)
                                .font(.headline)
                            if isYearly {
                                Text("BEST VALUE")
                                    .font(.caption2.bold())
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 2)
                                    .foregroundStyle(.white)
                                    .background(AppConstants.UI.accentGold, in: Capsule())
                            }
                        }
                        Text(product.description)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    VStack(alignment: .trailing, spacing: 2) {
                        Text(product.displayPrice)
                            .font(.title3.bold())
                        Text(isYearly ? "per year" : "per month")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }

                if isYearly, let monthly = subscriptionManager.monthlyProduct {
                    let yearlyMonthly = product.price / 12
                    let savings = (1 - (yearlyMonthly / monthly.price)) * 100
                    if savings > 0 {
                        Text("Save \(NSDecimalNumber(decimal: savings).intValue)% compared to monthly")
                            .font(.caption)
                            .foregroundStyle(AppConstants.UI.accentGold)
                    }
                }
            }
            .padding()
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(AppConstants.UI.cardBackground)
                    .overlay(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .strokeBorder(
                                isSelected ? AppConstants.UI.accentGold : .clear,
                                lineWidth: 2
                            )
                    )
            )
        }
        .buttonStyle(.plain)
        .disabled(subscriptionManager.isLoading)
    }

    // MARK: - Restore

    private var restoreButton: some View {
        VStack(spacing: 8) {
            Button {
                Task { await subscriptionManager.restorePurchases() }
            } label: {
                Text("Restore Purchases")
                    .font(.subheadline)
                    .foregroundStyle(AppConstants.UI.accentGold)
            }
            .buttonStyle(.plain)

            Text("Subscriptions renew automatically. You can cancel anytime in Settings.")
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .multilineTextAlignment(.center)
                .padding(.horizontal)
        }
        .padding(.bottom, 20)
    }
}

extension Feature: Hashable {}
