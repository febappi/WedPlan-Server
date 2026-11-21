import express from 'express'
import { bookingsCollection, servicesCollection, transactionsCollection, usersCollection } from '../db.js'
import verifyToken from '../middleware/verifyToken.js'
import { verifyAdmin, verifyCustomer, verifyVendor } from '../middleware/verifyRole.js'
import { hasActivePremium } from '../utils/helpers.js'

const router = express.Router()

// Counts documents per status in one pass, e.g. { pending: 2, accepted: 5 }
const countByStatus = async (collection, match) => {
    const rows = await collection.aggregate([{ $match: match }, { $group: { _id: '$status', count: { $sum: 1 } } }]).toArray()
    return Object.fromEntries(rows.map((row) => [row._id, row.count]))
}

router.get('/vendor', verifyToken, verifyVendor, async (req, res) => {
    const vendorId = req.user.id
    const [totalServices, activeServices, bookings] = await Promise.all([
        servicesCollection.countDocuments({ vendorId }),
        servicesCollection.countDocuments({ vendorId, isActive: true, status: 'approved' }),
        countByStatus(bookingsCollection, { vendorId }),
    ])

    res.send({
        totalServices,
        activeServices,
        pendingBookings: bookings.pending || 0,
        acceptedBookings: bookings.accepted || 0,
        plan: hasActivePremium(req.user) ? 'premium' : 'free',
        subscriptionExpiresAt: hasActivePremium(req.user) ? req.user.subscriptionExpiresAt : null,
    })
})

router.get('/customer', verifyToken, verifyCustomer, async (req, res) => {
    const bookings = await countByStatus(bookingsCollection, { customerId: req.user.id })
    const total = Object.values(bookings).reduce((sum, count) => sum + count, 0)

    res.send({
        totalBookings: total,
        pendingBookings: bookings.pending || 0,
        acceptedBookings: bookings.accepted || 0,
        rejectedBookings: bookings.rejected || 0,
        cancelledBookings: bookings.cancelled || 0,
    })
})

router.get('/admin', verifyToken, verifyAdmin, async (req, res) => {
    const [roles, services, payments] = await Promise.all([
        usersCollection.aggregate([{ $group: { _id: '$role', count: { $sum: 1 } } }]).toArray(),
        countByStatus(servicesCollection, {}),
        transactionsCollection
            .aggregate([{ $group: { _id: { status: '$status', currency: '$currency' }, count: { $sum: 1 }, amount: { $sum: '$amount' } } }])
            .toArray(),
    ])

    const roleCount = Object.fromEntries(roles.map((row) => [row._id || 'customer', row.count]))
    const totalUsers = Object.values(roleCount).reduce((sum, count) => sum + count, 0)
    const paid = payments.filter((row) => row._id.status === 'paid')

    res.send({
        totalUsers,
        totalVendors: roleCount.vendor || 0,
        totalCustomers: roleCount.customer || 0,
        totalServices: Object.values(services).reduce((sum, count) => sum + count, 0),
        pendingServices: services.pending || 0,
        totalTransactions: payments.reduce((sum, row) => sum + row.count, 0),
        paidTransactions: paid.reduce((sum, row) => sum + row.count, 0),
        revenue: paid.map((row) => ({ currency: row._id.currency, amount: Math.round(row.amount * 100) / 100 })),
    })
})

export default router
