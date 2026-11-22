import express from 'express'
import client, { bookingsCollection, servicesCollection, usersCollection } from '../db.js'
import verifyToken from '../middleware/verifyToken.js'
import { verifyAdmin } from '../middleware/verifyRole.js'
import { escapeRegex, getPagination, hasActivePremium, toObjectId } from '../utils/helpers.js'

const router = express.Router()

const ROLES = ['admin', 'vendor', 'customer']

// Fields an admin may see; Stripe ids and auth data stay out
const publicFields = {
    name: 1,
    email: 1,
    image: 1,
    role: 1,
    isBlocked: 1,
    businessName: 1,
    phone: 1,
    subscriptionPlan: 1,
    subscriptionExpiresAt: 1,
    createdAt: 1,
}

const withPlan = (user) => ({ ...user, isPremium: hasActivePremium(user) })

// The signed-in user's own profile, read fresh from the database
router.get('/me', verifyToken, async (req, res) => {
    res.send(req.user)
})

router.get('/', verifyToken, verifyAdmin, async (req, res) => {
    const { search, role } = req.query
    const { page, limit, skip } = getPagination(req.query, 10)

    const query = {}
    if (ROLES.includes(role)) {
        query.role = role
    }
    if (typeof search === 'string' && search.trim()) {
        const pattern = new RegExp(escapeRegex(search.trim()), 'i')
        query.$or = [{ name: pattern }, { email: pattern }]
    }

    const [users, total] = await Promise.all([
        usersCollection.find(query, { projection: publicFields }).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
        usersCollection.countDocuments(query),
    ])
    res.send({ users: users.map(withPlan), total, page, totalPages: Math.ceil(total / limit) })
})

router.get('/:id', verifyToken, verifyAdmin, async (req, res) => {
    const userId = toObjectId(req.params.id)
    if (!userId) {
        return res.status(400).send({ message: 'Invalid user id' })
    }
    const user = await usersCollection.findOne({ _id: userId }, { projection: publicFields })
    if (!user) {
        return res.status(404).send({ message: 'User not found' })
    }

    const [services, bookingsAsCustomer, bookingsAsVendor] = await Promise.all([
        servicesCollection.countDocuments({ vendorId: userId }),
        bookingsCollection.countDocuments({ customerId: userId }),
        bookingsCollection.countDocuments({ vendorId: userId }),
    ])
    res.send({ ...withPlan(user), counts: { services, bookingsAsCustomer, bookingsAsVendor } })
})

router.patch('/:id/block', verifyToken, verifyAdmin, async (req, res) => {
    const userId = toObjectId(req.params.id)
    if (!userId) {
        return res.status(400).send({ message: 'Invalid user id' })
    }
    if (typeof req.body.isBlocked !== 'boolean') {
        return res.status(400).send({ message: 'isBlocked must be true or false' })
    }
    if (userId.equals(req.user.id)) {
        return res.status(400).send({ message: 'You cannot block your own account' })
    }

    const user = await usersCollection.findOne({ _id: userId }, { projection: { role: 1 } })
    if (!user) {
        return res.status(404).send({ message: 'User not found' })
    }
    if (user.role === 'admin') {
        return res.status(403).send({ message: 'Admin accounts cannot be blocked' })
    }

    await usersCollection.updateOne({ _id: userId }, { $set: { isBlocked: req.body.isBlocked, updatedAt: new Date() } })
    if (req.body.isBlocked) {
        // Signing the user out everywhere; Better Auth keeps sessions in its own collection
        await client.db(process.env.DB_NAME || 'wedplan').collection('session').deleteMany({ userId })
    }
    res.send({ message: req.body.isBlocked ? 'User blocked' : 'User unblocked' })
})

export default router
