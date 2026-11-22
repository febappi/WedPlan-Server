import express from 'express'
import { transactionsCollection, usersCollection } from '../db.js'
import { CLIENT_URL } from '../config.js'
import verifyToken from '../middleware/verifyToken.js'
import { verifyAdmin, verifyVendor } from '../middleware/verifyRole.js'
import { getPagination, hasActivePremium } from '../utils/helpers.js'
import { PREMIUM_PLAN, stripe } from '../utils/stripe.js'

const router = express.Router()

const PAYMENT_STATUSES = ['pending', 'paid', 'failed', 'cancelled']

const requireStripe = (req, res, next) => {
    if (!stripe) {
        return res.status(503).send({ message: 'Payments are not set up on the server yet' })
    }
    next()
}

// Price shown on the Subscription page
router.get('/plan', (req, res) => {
    res.send({ name: PREMIUM_PLAN.name, amount: PREMIUM_PLAN.amount, currency: PREMIUM_PLAN.currency, interval: PREMIUM_PLAN.interval })
})

router.post('/checkout-session', verifyToken, verifyVendor, requireStripe, async (req, res) => {
    if (hasActivePremium(req.user)) {
        return res.status(409).send({ message: 'You already have Premium' })
    }

    // The vendor always comes from the verified token, never from the request body
    const vendor = await usersCollection.findOne({ _id: req.user.id }, { projection: { email: 1, name: 1, stripeCustomerId: 1 } })
    let customerId = vendor.stripeCustomerId
    if (!customerId) {
        const customer = await stripe.customers.create({
            email: vendor.email,
            name: vendor.name,
            metadata: { vendorId: String(req.user.id) },
        })
        customerId = customer.id
        await usersCollection.updateOne({ _id: req.user.id }, { $set: { stripeCustomerId: customerId } })
    }

    const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer: customerId,
        client_reference_id: String(req.user.id),
        line_items: [
            {
                quantity: 1,
                price_data: {
                    currency: PREMIUM_PLAN.currency,
                    unit_amount: PREMIUM_PLAN.amount,
                    recurring: { interval: PREMIUM_PLAN.interval },
                    product_data: { name: PREMIUM_PLAN.name, description: 'Unlimited active services and a Premium vendor badge' },
                },
            },
        ],
        metadata: { vendorId: String(req.user.id) },
        subscription_data: { metadata: { vendorId: String(req.user.id) } },
        success_url: `${CLIENT_URL}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${CLIENT_URL}/payment/cancel`,
    })

    // Recorded as pending; only the verified webhook can mark it paid
    await transactionsCollection.insertOne({
        vendorId: req.user.id,
        plan: 'premium',
        amount: PREMIUM_PLAN.amount / 100,
        currency: PREMIUM_PLAN.currency,
        stripeSessionId: session.id,
        stripeSubscriptionId: null,
        status: 'pending',
        createdAt: new Date(),
    })

    res.send({ url: session.url })
})

// The success page asks this until the webhook has confirmed the payment
router.get('/session/:sessionId', verifyToken, verifyVendor, async (req, res) => {
    const transaction = await transactionsCollection.findOne({ stripeSessionId: req.params.sessionId, vendorId: req.user.id })
    if (!transaction) {
        return res.status(404).send({ message: 'Payment not found' })
    }
    res.send({
        status: transaction.status,
        amount: transaction.amount,
        currency: transaction.currency,
        plan: transaction.plan,
        subscriptionExpiresAt: req.user.subscriptionExpiresAt,
        isPremium: hasActivePremium(req.user),
    })
})

router.get('/subscription', verifyToken, verifyVendor, async (req, res) => {
    const vendor = await usersCollection.findOne(
        { _id: req.user.id },
        { projection: { subscriptionPlan: 1, subscriptionExpiresAt: 1, cancelAtPeriodEnd: 1, stripeSubscriptionId: 1 } }
    )
    res.send({
        isPremium: hasActivePremium(vendor),
        subscriptionExpiresAt: vendor.subscriptionExpiresAt || null,
        cancelAtPeriodEnd: Boolean(vendor.cancelAtPeriodEnd),
        canCancel: Boolean(vendor.stripeSubscriptionId) && hasActivePremium(vendor) && !vendor.cancelAtPeriodEnd,
    })
})

// Stops renewal; Premium stays until the paid month ends, then the webhook moves the vendor to Free
router.post('/cancel-subscription', verifyToken, verifyVendor, requireStripe, async (req, res) => {
    const vendor = await usersCollection.findOne({ _id: req.user.id }, { projection: { stripeSubscriptionId: 1 } })
    if (!vendor.stripeSubscriptionId || !hasActivePremium(req.user)) {
        return res.status(400).send({ message: 'You do not have an active Premium subscription' })
    }
    await stripe.subscriptions.update(vendor.stripeSubscriptionId, { cancel_at_period_end: true })
    await usersCollection.updateOne({ _id: req.user.id }, { $set: { cancelAtPeriodEnd: true } })
    res.send({ message: 'Premium will end when the current month runs out' })
})

// Admin: every payment, read only. There is no route that changes a payment record,
// so a failed or pending payment can never be marked paid by hand.
router.get('/transactions', verifyToken, verifyAdmin, async (req, res) => {
    const { page, limit, skip } = getPagination(req.query, 10)
    const match = PAYMENT_STATUSES.includes(req.query.status) ? { status: req.query.status } : {}

    const [result] = await transactionsCollection
        .aggregate([
            { $match: match },
            {
                $facet: {
                    transactions: [
                        { $sort: { createdAt: -1 } },
                        { $skip: skip },
                        { $limit: limit },
                        {
                            $lookup: {
                                from: 'users',
                                localField: 'vendorId',
                                foreignField: '_id',
                                as: 'vendor',
                                pipeline: [{ $project: { name: 1, email: 1, image: 1, businessName: 1 } }],
                            },
                        },
                        { $unwind: { path: '$vendor', preserveNullAndEmptyArrays: true } },
                        { $project: { stripeSessionId: 0 } },
                    ],
                    total: [{ $count: 'count' }],
                },
            },
        ])
        .toArray()

    const total = result.total[0]?.count || 0
    res.send({ transactions: result.transactions, total, page, totalPages: Math.ceil(total / limit) })
})

export default router
