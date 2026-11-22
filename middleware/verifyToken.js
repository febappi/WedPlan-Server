import { createLocalJWKSet, createRemoteJWKSet, decodeProtectedHeader, jwtVerify } from 'jose'
import { ObjectId } from 'mongodb'
import { CLIENT_URL } from '../config.js'
import { jwksCollection, usersCollection } from '../db.js'

// Better Auth on the client app signs the token. Its public keys are read from the shared database,
// so checking a token never waits on the client app waking up. The client's /api/auth/jwks is only a fallback.
const remoteJWKS = createRemoteJWKSet(new URL(`${CLIENT_URL}/api/auth/jwks`), { timeoutDuration: 10000 })

let localJWKS = null
let knownKids = new Set()
let loadedAt = 0

const loadLocalKeys = async () => {
    const docs = await jwksCollection.find({}, { projection: { publicKey: 1, alg: 1 } }).toArray()
    const keys = docs.map((doc) => ({ ...JSON.parse(doc.publicKey), alg: doc.alg || 'EdDSA', kid: String(doc._id) }))
    localJWKS = keys.length ? createLocalJWKSet({ keys }) : null
    knownKids = new Set(keys.map((key) => key.kid))
    loadedAt = Date.now()
}

// Reloads the keys when a token names one we have not seen, at most once every 30 seconds
const getKeySet = async (token) => {
    const { kid } = decodeProtectedHeader(token)
    if (!localJWKS || (kid && !knownKids.has(kid) && Date.now() - loadedAt > 30000)) {
        await loadLocalKeys()
    }
    return localJWKS && (!kid || knownKids.has(kid)) ? localJWKS : remoteJWKS
}

const getTokenPayload = async (req) => {
    const authHeader = req.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return null
    }

    const token = authHeader.split(' ')[1]
    try {
        const { payload } = await jwtVerify(token, await getKeySet(token), {
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
