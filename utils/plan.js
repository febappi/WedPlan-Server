import { servicesCollection } from '../db.js'
import { FREE_ACTIVE_SERVICE_LIMIT } from './constants.js'

// After Premium ends, only the newest three active services stay available; the rest are switched off, not deleted
export const enforceFreeLimit = async (vendorId) => {
    const active = await servicesCollection
        .find({ vendorId, isActive: true, status: { $in: ['pending', 'approved'] } }, { projection: { _id: 1 } })
        .sort({ createdAt: -1 })
        .toArray()

    const extra = active.slice(FREE_ACTIVE_SERVICE_LIMIT).map((service) => service._id)
    if (extra.length > 0) {
        await servicesCollection.updateMany({ _id: { $in: extra } }, { $set: { isActive: false, updatedAt: new Date() } })
    }
    return extra.length
}
