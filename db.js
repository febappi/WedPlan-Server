import { MongoClient } from 'mongodb'

if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is missing in the environment variables')
}

const client = new MongoClient(process.env.MONGODB_URI)
const db = client.db(process.env.DB_NAME || 'wedplan')

// users is managed by Better Auth on the client app, the server only reads and updates it
export const usersCollection = db.collection('users')
export const servicesCollection = db.collection('services')
export const bookingsCollection = db.collection('bookings')
export const transactionsCollection = db.collection('transactions')

export const connectToMongoDB = async () => {
    await client.connect()
    console.log('You successfully connected to MongoDB!')
}

export const createIndexes = async () => {
    await servicesCollection.createIndex({ status: 1, createdAt: -1 })
    await servicesCollection.createIndex({ vendorId: 1 })
    await bookingsCollection.createIndex({ customerId: 1, createdAt: -1 })
    await bookingsCollection.createIndex({ vendorId: 1, createdAt: -1 })
    // One open request per customer, service and event date. Rejected and cancelled ones do not count.
    await bookingsCollection.createIndex(
        { customerId: 1, serviceId: 1, eventDate: 1 },
        {
            unique: true,
            name: 'one_open_booking_per_date',
            partialFilterExpression: { status: { $in: ['pending', 'accepted'] } },
        }
    )
    await transactionsCollection.createIndex({ stripeSessionId: 1 }, { unique: true })
}

export default client
