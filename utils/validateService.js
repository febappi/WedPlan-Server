import { CATEGORIES, MAX_SERVICE_IMAGES } from './constants.js'
import { isEmptyText } from './helpers.js'

const isImageUrl = (url) => typeof url === 'string' && /^https:\/\/\S+$/.test(url.trim())

// Returns an error message, or null when the service data is valid
export const validateService = (service) => {
    if (isEmptyText(service.serviceName) || service.serviceName.trim().length < 3) {
        return 'Service name must be at least 3 characters'
    }
    if (service.serviceName.trim().length > 100) {
        return 'Service name must be 100 characters or fewer'
    }
    if (!CATEGORIES.includes(service.category)) {
        return 'Please select a valid category'
    }
    if (isEmptyText(service.description) || service.description.trim().length < 20) {
        return 'Description must be at least 20 characters'
    }
    if (service.description.trim().length > 2000) {
        return 'Description must be 2000 characters or fewer'
    }
    if (typeof service.price !== 'number' || !Number.isFinite(service.price) || service.price <= 0) {
        return 'Price must be a positive number'
    }
    if (isEmptyText(service.location)) {
        return 'Location is required'
    }
    if (!Array.isArray(service.images) || service.images.length === 0) {
        return 'Add at least one service image'
    }
    if (service.images.length > MAX_SERVICE_IMAGES) {
        return `You can add up to ${MAX_SERVICE_IMAGES} images`
    }
    if (!service.images.every(isImageUrl)) {
        return 'Every image must be an uploaded image link'
    }
    return null
}

// Only these fields are taken from the request; status, owner and dates are set by the server
export const getServiceFields = (service) => ({
    serviceName: service.serviceName.trim(),
    category: service.category,
    description: service.description.trim(),
    price: Math.round(service.price),
    location: service.location.trim(),
    images: service.images.map((url) => url.trim()),
})
