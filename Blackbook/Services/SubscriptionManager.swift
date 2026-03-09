import Foundation
import StoreKit
import Observation
import os

private let logger = Logger(subsystem: "com.blackbookdevelopment.app", category: "Subscription")

enum SubscriptionTier: String, Sendable {
    case free
    case pro
}

@Observable
final class SubscriptionManager {
    static let shared = SubscriptionManager()

    var products: [Product] = []
    var purchasedProductIDs: Set<String> = []
    var isLoading = false
    var error: String?

    var currentTier: SubscriptionTier {
        purchasedProductIDs.isEmpty ? .free : .pro
    }

    var isPro: Bool { currentTier == .pro }

    var monthlyProduct: Product? {
        products.first { $0.id == AppConstants.Subscription.monthlyProductId }
    }

    var yearlyProduct: Product? {
        products.first { $0.id == AppConstants.Subscription.yearlyProductId }
    }

    private var transactionListener: Task<Void, Error>?

    private init() {
        transactionListener = listenForTransactions()
        Task { await loadProducts() }
        Task { await updatePurchasedProducts() }
    }

    deinit {
        transactionListener?.cancel()
    }

    // MARK: - Load Products

    func loadProducts() async {
        isLoading = true
        defer { isLoading = false }

        do {
            let productIds = [
                AppConstants.Subscription.monthlyProductId,
                AppConstants.Subscription.yearlyProductId
            ]
            products = try await Product.products(for: productIds)
                .sorted { $0.price < $1.price }
            logger.info("Loaded \(self.products.count) product(s)")
        } catch {
            logger.error("Failed to load products: \(error.localizedDescription)")
            self.error = "Unable to load subscription options."
        }
    }

    // MARK: - Purchase

    func purchase(_ product: Product) async -> Bool {
        isLoading = true
        error = nil
        defer { isLoading = false }

        do {
            let result = try await product.purchase()

            switch result {
            case .success(let verification):
                let transaction = try checkVerified(verification)
                await transaction.finish()
                await updatePurchasedProducts()
                logger.info("Purchase successful: \(product.id)")
                return true

            case .userCancelled:
                logger.info("User cancelled purchase")
                return false

            case .pending:
                logger.info("Purchase pending approval")
                return false

            @unknown default:
                return false
            }
        } catch {
            logger.error("Purchase failed: \(error.localizedDescription)")
            self.error = "Purchase failed. Please try again."
            return false
        }
    }

    // MARK: - Restore

    func restorePurchases() async {
        isLoading = true
        defer { isLoading = false }

        do {
            try await AppStore.sync()
            await updatePurchasedProducts()
            logger.info("Purchases restored")
        } catch {
            logger.error("Restore failed: \(error.localizedDescription)")
            self.error = "Unable to restore purchases."
        }
    }

    // MARK: - Transaction Listener

    private func listenForTransactions() -> Task<Void, Error> {
        Task.detached {
            for await result in Transaction.updates {
                do {
                    let transaction = try self.checkVerified(result)
                    await self.updatePurchasedProducts()
                    await transaction.finish()
                } catch {
                    logger.error("Transaction update failed verification")
                }
            }
        }
    }

    // MARK: - Entitlement Check

    func updatePurchasedProducts() async {
        var purchased: Set<String> = []

        for await result in Transaction.currentEntitlements {
            do {
                let transaction = try checkVerified(result)
                if transaction.revocationDate == nil {
                    purchased.insert(transaction.productID)
                }
            } catch {
                logger.warning("Entitlement verification failed")
            }
        }

        purchasedProductIDs = purchased
        logger.info("Active subscriptions: \(purchased)")
    }

    // MARK: - Verification

    private func checkVerified<T>(_ result: VerificationResult<T>) throws -> T {
        switch result {
        case .unverified:
            throw StoreKitError.notAvailableInStorefront
        case .verified(let safe):
            return safe
        }
    }
}
