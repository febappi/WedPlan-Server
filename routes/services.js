import express from 'express'
import { servicesCollection } from '../db.js'
import verifyToken from '../middleware/verifyToken.js'
import { CATEGORIES } from '../utils/constants.js'
import { escapeRegex, getPagination, toObjectId } from '../utils/helpers.js'

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
