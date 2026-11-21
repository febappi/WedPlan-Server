import Stripe from 'stripe'

// The secret key stays on the server; the client only ever gets a Checkout URL
export const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null

export const PREMIUM_PLAN = {
    name: 'WedPlan Premium',
    amount: Number(process.env.PREMIUM_PRICE_AMOUNT) || 1900,
    currency: (process.env.PREMIUM_CURRENCY || 'usd').toLowerCase(),
    interval: 'month',
}

// Newer Stripe API versions keep the billing period on the subscription item
export const getPeriodEnd = (subscription) => {
    const seconds = subscription.current_period_end ?? subscription.items?.data?.[0]?.current_period_end
    return seconds ? new Date(seconds * 1000) : null
}

// Newer Stripe API versions keep the subscription id under invoice.parent
export const getInvoiceSubscriptionId = (invoice) => {
    const value = invoice.subscription ?? invoice.parent?.subscription_details?.subscription
    return typeof value === 'string' ? value : value?.id || null
}
