import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { CLIENT_URL } from './config.js'
import { connectToMongoDB, createIndexes, ensureConnected } from './db.js'
import usersRouter from './routes/users.js'
import servicesRouter from './routes/services.js'
import bookingsRouter from './routes/bookings.js'
import paymentsRouter from './routes/payments.js'
import webhookRouter from './routes/webhook.js'
import statsRouter from './routes/stats.js'

const app = express()
const PORT = process.env.PORT || 5000

app.use(cors({ origin: CLIENT_URL }))
app.use(ensureConnected)
// The Stripe webhook needs the raw body to check its signature, so it is mounted before the JSON parser
app.use('/payments/webhook', webhookRouter)
app.use(express.json())

app.get('/', (req, res) => {
    res.send({ message: 'WedPlan Server is Running' })
})

app.use('/users', usersRouter)
app.use('/services', servicesRouter)
app.use('/bookings', bookingsRouter)
app.use('/payments', paymentsRouter)
app.use('/stats', statsRouter)

app.use((req, res) => {
    res.status(404).send({ message: 'Route not found' })
})

app.use((error, req, res, next) => {
    if (error.type === 'entity.parse.failed') {
        return res.status(400).send({ message: 'Invalid JSON body' })
    }
    console.error(error)
    res.status(500).send({ message: 'Something went wrong on the server' })
})

try {
    await connectToMongoDB()
} catch (error) {
    console.error('MongoDB connection failed:', error.message)
    if (!process.env.VERCEL) {
        process.exit(1)
    }
    throw error
}

// Indexes already exist after the first run, so a cold start does not wait for this check
createIndexes().catch((error) => console.error('Index setup failed:', error.message))

if (!process.env.VERCEL) {
    app.listen(PORT, () => {
        console.log(`WedPlan Server Is Running On PORT ${PORT}`)
    })
}

export default app
