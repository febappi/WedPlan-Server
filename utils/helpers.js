import { ObjectId } from 'mongodb'

export const isEmptyText = (value) => typeof value !== 'string' || value.trim() === ''

export const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export const toObjectId = (id) => (typeof id === 'string' && ObjectId.isValid(id) ? new ObjectId(id) : null)

export const getPagination = (query, defaultLimit = 9) => {
    const page = Math.max(Number(query.page) || 1, 1)
    const limit = Math.min(Math.max(Number(query.limit) || defaultLimit, 1), 50)
    return { page, limit, skip: (page - 1) * limit }
}

// Premium only counts while it has not run out
export const hasActivePremium = (user) => {
    if (user?.subscriptionPlan !== 'premium') {
        return false
    }
    if (!user.subscriptionExpiresAt) {
        return true
    }
    return new Date(user.subscriptionExpiresAt) > new Date()
}
