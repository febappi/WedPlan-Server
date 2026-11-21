import express from 'express'
import { bookingsCollection, servicesCollection } from '../db.js'
import verifyToken from '../middleware/verifyToken.js'
import verifyRole, { verifyAdmin, verifyVendor } from '../middleware/verifyRole.js'
import { CATEGORIES, FREE_ACTIVE_SERVICE_LIMIT, SERVICE_STATUSES } from '../utils/constants.js'
import { escapeRegex, getPagination, hasActivePremium, toObjectId } from '../utils/helpers.js'
import { getServiceFields, validateService } from '../utils/validateService.js'

const router = express.Router()

// Only approved services that the vendor keeps available are shown to the public
const PUBLIC_MATCH = { status: 'approved', isActive: true }

// Adds safe vendor details to each service. Email and account fields stay private.
const vendorLookup = [
    {
        $lookup: {
            from: 'users',
            localField: 'vendorId',
            foreignField: '_id',
            as: 'vendor',
            pipeline: [
                {
                    $project: {
                        name: 1,
                        image: 1,
                        businessName: 1,
                        isBlocked: 1,
                        isPremium: {
                            $and: [
                                { $eq: ['$subscriptionPlan', 'premium'] },
                                {
                                    $or: [
                                        { $eq: [{ $ifNull: ['$subscriptionExpiresAt', null] }, null] },
                                        { $gt: ['$subscriptionExpiresAt', '$$NOW'] },
                                    ],
                                },
                            ],
                        },
                    },
                },
            ],
        },
    },
    { $unwind: { path: '$vendor', preserveNullAndEmptyArrays: true } },
]

const hideBlockedVendors = { $match: { 'vendor.isBlocked': { $ne: true } } }
const dropPrivateVendorFields = { $project: { 'vendor.isBlocked': 0 } }

const sortOptions = {
    price_asc: { price: 1, createdAt: -1 },
    price_desc: { price: -1, createdAt: -1 },
    newest: { createdAt: -1 },
}

// Every word of the search has to appear in the name, description, location, category or business name
const getSearchMatch = (search) => {
    const words = search.trim().split(/\s+/).filter(Boolean).slice(0, 6)
    return {
        $and: words.map((word) => {
            const pattern = new RegExp(escapeRegex(word), 'i')
            return {
                $or: [
                    { serviceName: pattern },
                    { description: pattern },
                    { location: pattern },
                    { category: pattern },
                    { 'vendor.businessName': pattern },
                ],
            }
        }),
    }
}

router.get('/', async (req, res) => {
    const { search, category, location, sort, minPrice, maxPrice } = req.query
    const { page, limit, skip } = getPagination(req.query)

    const match = { ...PUBLIC_MATCH }
    if (CATEGORIES.includes(category)) {
        match.category = category
    }
    if (typeof location === 'string' && location.trim()) {
        match.location = new RegExp(`^${escapeRegex(location.trim())}$`, 'i')
    }
    const priceRange = {}
    if (Number(minPrice) > 0) {
        priceRange.$gte = Number(minPrice)
    }
    if (Number(maxPrice) > 0) {
        priceRange.$lte = Number(maxPrice)
    }
    if (Object.keys(priceRange).length > 0) {
        match.price = priceRange
    }

    const pipeline = [{ $match: match }, ...vendorLookup, hideBlockedVendors]
    if (typeof search === 'string' && search.trim()) {
        pipeline.push({ $match: getSearchMatch(search) })
    }

    const [result] = await servicesCollection
        .aggregate([
            ...pipeline,
            {
                $facet: {
                    services: [
                        { $sort: sortOptions[sort] || sortOptions.newest },
                        { $skip: skip },
                        { $limit: limit },
                        dropPrivateVendorFields,
                    ],
                    total: [{ $count: 'count' }],
                },
            },
        ])
        .toArray()

    const total = result.total[0]?.count || 0
    res.send({ services: result.services, total, page, totalPages: Math.ceil(total / limit) })
})

// Cities that have at least one public service, for the location filter
router.get('/locations', async (req, res) => {
    const locations = await servicesCollection.distinct('location', PUBLIC_MATCH)
    res.send(locations.sort((a, b) => a.localeCompare(b)))
})

// Admin: every submitted service, with search and a status filter
router.get('/admin/all', verifyToken, verifyAdmin, async (req, res) => {
    const { search, status, category } = req.query
    const { page, limit, skip } = getPagination(req.query, 10)

    const match = {}
    if (SERVICE_STATUSES.includes(status)) {
        match.status = status
    }
    if (CATEGORIES.includes(category)) {
        match.category = category
    }

    const pipeline = [{ $match: match }, ...vendorLookup]
    if (typeof search === 'string' && search.trim()) {
        pipeline.push({ $match: getSearchMatch(search) })
    }

    const [result] = await servicesCollection
        .aggregate([
            ...pipeline,
            {
                $facet: {
                    services: [{ $sort: { createdAt: -1 } }, { $skip: skip }, { $limit: limit }],
                    total: [{ $count: 'count' }],
                },
            },
        ])
        .toArray()

    const total = result.total[0]?.count || 0
    res.send({ services: result.services, total, page, totalPages: Math.ceil(total / limit) })
})

router.patch('/:id/status', verifyToken, verifyAdmin, async (req, res) => {
    const serviceId = toObjectId(req.params.id)
    if (!serviceId) {
        return res.status(400).send({ message: 'Invalid service id' })
    }
    if (!SERVICE_STATUSES.includes(req.body.status)) {
        return res.status(400).send({ message: 'Status must be pending, approved or rejected' })
    }

    const result = await servicesCollection.updateOne(
        { _id: serviceId },
        { $set: { status: req.body.status, reviewedAt: new Date(), updatedAt: new Date() } }
    )
    if (result.matchedCount === 0) {
        return res.status(404).send({ message: 'Service not found' })
    }
    res.send({ message: `Service marked as ${req.body.status}` })
})

// Pending and approved services the vendor keeps available count toward the free plan limit
const countActiveServices = (vendorId, exceptId) => {
    const query = { vendorId, isActive: true, status: { $in: ['pending', 'approved'] } }
    if (exceptId) {
        query._id = { $ne: exceptId }
    }
    return servicesCollection.countDocuments(query)
}

const planLimitMessage = `The free plan allows ${FREE_ACTIVE_SERVICE_LIMIT} active services. Upgrade to Premium or make another service unavailable first.`

router.get('/mine', verifyToken, verifyVendor, async (req, res) => {
    const services = await servicesCollection.find({ vendorId: req.user.id }).sort({ createdAt: -1 }).toArray()
    const activeCount = services.filter((service) => service.isActive && service.status !== 'rejected').length
    res.send({
        services,
        activeCount,
        activeLimit: hasActivePremium(req.user) ? null : FREE_ACTIVE_SERVICE_LIMIT,
    })
})

router.post('/', verifyToken, verifyVendor, async (req, res) => {
    const errorMessage = validateService(req.body)
    if (errorMessage) {
        return res.status(400).send({ message: errorMessage })
    }

    if (!hasActivePremium(req.user) && (await countActiveServices(req.user.id)) >= FREE_ACTIVE_SERVICE_LIMIT) {
        return res.status(403).send({ message: planLimitMessage, code: 'PLAN_LIMIT' })
    }

    const now = new Date()
    const newService = {
        ...getServiceFields(req.body),
        vendorId: req.user.id,
        status: 'pending',
        isActive: true,
        createdAt: now,
        updatedAt: now,
    }
    const result = await servicesCollection.insertOne(newService)
    res.status(201).send({ message: 'Service submitted. It will appear once an admin approves it.', serviceId: result.insertedId })
})

// Finds a service and confirms the signed-in vendor owns it
const findOwnService = async (req, res) => {
    const serviceId = toObjectId(req.params.id)
    if (!serviceId) {
        res.status(400).send({ message: 'Invalid service id' })
        return null
    }
    const service = await servicesCollection.findOne({ _id: serviceId })
    if (!service) {
        res.status(404).send({ message: 'Service not found' })
        return null
    }
    if (!service.vendorId.equals(req.user.id)) {
        res.status(403).send({ message: 'You can only change your own services' })
        return null
    }
    return service
}

router.patch('/:id', verifyToken, verifyVendor, async (req, res) => {
    const service = await findOwnService(req, res)
    if (!service) {
        return
    }
    const errorMessage = validateService(req.body)
    if (errorMessage) {
        return res.status(400).send({ message: errorMessage })
    }

    // Edited details go back to the admin for review before customers see them again
    await servicesCollection.updateOne(
        { _id: service._id, vendorId: req.user.id },
        { $set: { ...getServiceFields(req.body), status: 'pending', updatedAt: new Date() } }
    )
    res.send({ message: 'Service updated. It will be visible again after admin approval.' })
})

router.patch('/:id/availability', verifyToken, verifyVendor, async (req, res) => {
    const service = await findOwnService(req, res)
    if (!service) {
        return
    }
    if (typeof req.body.isActive !== 'boolean') {
        return res.status(400).send({ message: 'isActive must be true or false' })
    }

    const turningOn = req.body.isActive && !service.isActive
    if (turningOn && service.status !== 'rejected' && !hasActivePremium(req.user)) {
        if ((await countActiveServices(req.user.id, service._id)) >= FREE_ACTIVE_SERVICE_LIMIT) {
            return res.status(403).send({ message: planLimitMessage, code: 'PLAN_LIMIT' })
        }
    }

    await servicesCollection.updateOne(
        { _id: service._id, vendorId: req.user.id },
        { $set: { isActive: req.body.isActive, updatedAt: new Date() } }
    )
    res.send({ message: req.body.isActive ? 'Service is now available' : 'Service is now unavailable' })
})

router.delete('/:id', verifyToken, verifyRole('vendor', 'admin'), async (req, res) => {
    const serviceId = toObjectId(req.params.id)
    if (!serviceId) {
        return res.status(400).send({ message: 'Invalid service id' })
    }
    const service = await servicesCollection.findOne({ _id: serviceId })
    if (!service) {
        return res.status(404).send({ message: 'Service not found' })
    }
    if (req.user.role === 'vendor' && !service.vendorId.equals(req.user.id)) {
        return res.status(403).send({ message: 'You can only delete your own services' })
    }

    await servicesCollection.deleteOne({ _id: service._id })
    // Open requests for a removed service are closed so customers are not left waiting
    await bookingsCollection.updateMany(
        { serviceId: service._id, status: 'pending' },
        { $set: { status: 'cancelled', cancelReason: 'The service was removed', cancelledAt: new Date(), updatedAt: new Date() } }
    )
    res.send({ message: 'Service deleted' })
})

router.get('/:id', verifyToken, async (req, res) => {
    const serviceId = toObjectId(req.params.id)
    if (!serviceId) {
        return res.status(400).send({ message: 'Invalid service id' })
    }

    const [service] = await servicesCollection
        .aggregate([{ $match: { _id: serviceId } }, ...vendorLookup])
        .toArray()

    const isOwner = service && service.vendorId.equals(req.user.id)
    const isAdmin = req.user.role === 'admin'
    const isPublic = service && service.status === 'approved' && service.isActive && !service.vendor?.isBlocked

    // Pending, rejected or hidden services exist only for their vendor and the admin
    if (!service || (!isPublic && !isOwner && !isAdmin)) {
        return res.status(404).send({ message: 'Service not found or no longer available' })
    }

    delete service.vendor?.isBlocked
    res.send({ ...service, isBookable: Boolean(isPublic) })
})

export default router
