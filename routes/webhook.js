import express from 'express'
import { transactionsCollection, usersCollection } from '../db.js'
import { toObjectId } from '../utils/helpers.js'
import { enforceFreeLimit } from '../utils/plan.js'
import { getInvoiceSubscriptionId, getPeriodEnd, PREMIUM_PLAN, stripe } from '../utils/stripe.js'

const router = express.Router()

const activatePremium = async (vendorId, subscription, customerId) => {
    await usersCollection.updateOne(
        { _id: vendorId },
        {
            $set: {
                subscriptionPlan: 'premium',
                subscriptionExpiresAt: getPeriodEnd(subscription),
                stripeSubscriptionId: subscription.id,
                stripeCustomerId: customerId,
                cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
            },
        }
    )
}

const findVendorBySubscription = (subscription) => {
    const vendorId = toObjectId(subscription.metadata?.vendorId)
    return usersCollection.findOne(vendorId ? { _id: vendorId } : { stripeSubscriptionId: subscription.id })
}

// Saves a renewal or failed renewal once; Stripe may send the same event more than once
const recordInvoice = async (vendorId, invoice, status) => {
    try {
        await transactionsCollection.insertOne({
            vendorId,
            plan: 'premium',
            amount: (invoice.amount_paid || invoice.amount_due || 0) / 100,
            currency: invoice.currency,
            stripeSessionId: null,
            stripeInvoiceId: invoice.id,
            stripeSubscriptionId: getInvoiceSubscriptionId(invoice),
            status,
            createdAt: new Date(invoice.created * 1000),
        })
    } catch (error) {
        if (error.code !== 11000) {
            throw error
        }
    }
}

const handlers = {
    'checkout.session.completed': async (session) => {
        if (session.mode !== 'subscription' || session.payment_status !== 'paid') {
            return
        }
        const vendorId = toObjectId(session.metadata?.vendorId || session.client_reference_id)
        if (!vendorId) {
            return
        }
        const subscription = await stripe.subscriptions.retrieve(session.subscription)
        const update = {
            status: 'paid',
            stripeSubscriptionId: subscription.id,
            stripeInvoiceId: typeof session.invoice === 'string' ? session.invoice : session.invoice?.id || null,
            amount: (session.amount_total ?? PREMIUM_PLAN.amount) / 100,
            currency: session.currency || PREMIUM_PLAN.currency,
            paidAt: new Date(),
        }
        await transactionsCollection.updateOne(
            { stripeSessionId: session.id },
            { $set: update, $setOnInsert: { vendorId, plan: 'premium', createdAt: new Date() } },
            { upsert: true }
        )
        await activatePremium(vendorId, subscription, session.customer)
    },

    'checkout.session.expired': async (session) => {
        await transactionsCollection.updateOne({ stripeSessionId: session.id, status: 'pending' }, { $set: { status: 'cancelled' } })
    },

    // Monthly renewals extend Premium; the first invoice is covered by checkout.session.completed
    'invoice.paid': async (invoice) => {
        const subscriptionId = getInvoiceSubscriptionId(invoice)
        if (!subscriptionId || invoice.billing_reason === 'subscription_create') {
            return
        }
        const subscription = await stripe.subscriptions.retrieve(subscriptionId)
        const vendor = await findVendorBySubscription(subscription)
        if (!vendor) {
            return
        }
        await activatePremium(vendor._id, subscription, subscription.customer)
        await recordInvoice(vendor._id, invoice, 'paid')
    },

    'invoice.payment_failed': async (invoice) => {
        const subscriptionId = getInvoiceSubscriptionId(invoice)
        const vendor = subscriptionId ? await usersCollection.findOne({ stripeSubscriptionId: subscriptionId }) : null
        if (vendor) {
            await recordInvoice(vendor._id, invoice, 'failed')
        }
    },

    'customer.subscription.updated': async (subscription) => {
        const vendor = await findVendorBySubscription(subscription)
        if (!vendor) {
            return
        }
        const set = { cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end) }
        if (['active', 'trialing'].includes(subscription.status)) {
            set.subscriptionExpiresAt = getPeriodEnd(subscription)
        }
        await usersCollection.updateOne({ _id: vendor._id }, { $set: set })
    },

    // The subscription has ended (cancelled or unpaid): back to Free and the three-service limit
    'customer.subscription.deleted': async (subscription) => {
        const vendor = await findVendorBySubscription(subscription)
        if (!vendor) {
            return
        }
        await usersCollection.updateOne(
            { _id: vendor._id },
            { $set: { subscriptionPlan: 'free', subscriptionExpiresAt: null, cancelAtPeriodEnd: false, stripeSubscriptionId: null } }
        )
        await enforceFreeLimit(vendor._id)
    },
}

// Stripe signs every event; anything that fails the signature check is refused before it can change a plan
router.post('/', express.raw({ type: 'application/json' }), async (req, res) => {
    if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
        return res.status(503).send({ message: 'Payments are not set up on the server yet' })
    }

    let event
    try {
        event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET)
    } catch (error) {
        console.error('Stripe webhook signature check failed')
        return res.status(400).send({ message: 'Webhook signature check failed' })
    }

    const handler = handlers[event.type]
    if (handler) {
        try {
            await handler(event.data.object)
        } catch (error) {
            console.error(`Webhook ${event.type} failed:`, error.message)
            // A 500 makes Stripe retry the event later
            return res.status(500).send({ message: 'Webhook handling failed' })
        }
    }
    res.send({ received: true })
})

export default router
