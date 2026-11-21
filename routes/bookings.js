import express from 'express'
import { bookingsCollection, servicesCollection, usersCollection } from '../db.js'
import verifyToken from '../middleware/verifyToken.js'
import { verifyCustomer, verifyVendor } from '../middleware/verifyRole.js'
import { BOOKING_STATUSES } from '../utils/constants.js'
import { isEmptyText, toObjectId } from '../utils/helpers.js'

const router = express.Router()

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

// The event date is kept as midnight UTC of the chosen day, so one day is one value
const parseEventDate = (value) => {
    if (typeof value !== 'string' || !DATE_PATTERN.test(value)) {
        return null
    }
    const date = new Date(`${value}T00:00:00.000Z`)
    return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : date
}

const validateBooking = (body) => {
    if (!toObjectId(body.serviceId)) {
        return 'Invalid service id'
    }
    const eventDate = parseEventDate(body.eventDate)
    if (!eventDate) {
        return 'Please choose a valid event date'
    }
    const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`)
    if (eventDate < today) {
        return 'The event date cannot be in the past'
    }
    const threeYears = new Date(today)
    threeYears.setUTCFullYear(threeYears.getUTCFullYear() + 3)
    if (eventDate > threeYears) {
        return 'Please choose a date within the next three years'
    }
    if (isEmptyText(body.eventLocation) || body.eventLocation.trim().length > 200) {
        return 'Event location is required (200 characters at most)'
    }
    if (body.message !== undefined && (typeof body.message !== 'string' || body.message.trim().length > 1000)) {
        return 'Message must be 1000 characters or fewer'
    }
    return null
}

router.post('/', verifyToken, verifyCustomer, async (req, res) => {
    const errorMessage = validateBooking(req.body)
    if (errorMessage) {
        return res.status(400).send({ message: errorMessage })
    }

    const service = await servicesCollection.findOne({ _id: toObjectId(req.body.serviceId) })
    if (!service) {
        return res.status(404).send({ message: 'Service not found' })
    }
    if (service.status !== 'approved' || !service.isActive) {
        return res.status(400).send({ message: 'This service is not taking booking requests right now' })
    }
    if (service.vendorId.equals(req.user.id)) {
        return res.status(403).send({ message: 'You cannot book your own service' })
    }
    const vendor = await usersCollection.findOne({ _id: service.vendorId }, { projection: { isBlocked: 1 } })
    if (!vendor || vendor.isBlocked) {
        return res.status(400).send({ message: 'This vendor is not taking booking requests right now' })
    }

    const now = new Date()
    const newBooking = {
        serviceId: service._id,
        vendorId: service.vendorId,
        customerId: req.user.id,
        eventDate: parseEventDate(req.body.eventDate),
        eventLocation: req.body.eventLocation.trim(),
        message: (req.body.message || '').trim(),
        status: 'pending',
        createdAt: now,
        updatedAt: now,
    }

    try {
        const result = await bookingsCollection.insertOne(newBooking)
        res.status(201).send({ message: 'Booking request sent. The vendor will answer from their dashboard.', bookingId: result.insertedId })
    } catch (error) {
        if (error.code === 11000) {
            return res.status(409).send({ message: 'You already have an open request for this service on that date' })
        }
        throw error
    }
})

export default router
