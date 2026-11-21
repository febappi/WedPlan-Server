import { createRemoteJWKSet, jwtVerify } from 'jose'
import { ObjectId } from 'mongodb'
import { CLIENT_URL } from '../config.js'
import { usersCollection } from '../db.js'

// Better Auth on the client app signs the token, its public keys live at /api/auth/jwks
const JWKS = createRemoteJWKSet(new URL(`${CLIENT_URL}/api/auth/jwks`))

const getTokenPayload = async (req) => {
    const authHeader = req.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return null
    }

    const token = authHeader.split(' ')[1]
    try {
        const { payload } = await jwtVerify(token, JWKS, {
            issuer: CLIENT_URL,
            audience: CLIENT_URL,
        })
        return payload
    } catch (error) {
        return null
    }
}

const verifyToken = async (req, res, next) => {
    const payload = await getTokenPayload(req)
    if (!payload || !payload.sub || !ObjectId.isValid(payload.sub)) {
        return res.status(401).send({ message: 'Unauthorized access. Please sign in again.' })
    }

    // The role and blocked status come from the database, not from the token or the request
    const user = await usersCollection.findOne({ _id: new ObjectId(payload.sub) })
    if (!user) {
        return res.status(401).send({ message: 'Account not found. Please sign in again.' })
    }
    if (user.isBlocked) {
        return res.status(403).send({ message: 'Your account has been blocked.' })
    }

    req.user = {
        id: user._id,
        name: user.name,
        email: user.email,
        image: user.image || null,
        role: user.role || 'customer',
        businessName: user.businessName || null,
        subscriptionPlan: user.subscriptionPlan || 'free',
        subscriptionExpiresAt: user.subscriptionExpiresAt || null,
    }
    next()
}

export default verifyToken
