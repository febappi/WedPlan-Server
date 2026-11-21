import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { CLIENT_URL } from './config.js'
import { connectToMongoDB, createIndexes } from './db.js'
import usersRouter from './routes/users.js'

const app = express()
const PORT = process.env.PORT || 5000

app.use(cors({ origin: CLIENT_URL }))
app.use(express.json())

app.get('/', (req, res) => {
    res.send({ message: 'WedPlan Server is Running' })
})

app.use('/users', usersRouter)

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
    await createIndexes()
} catch (error) {
    console.error('MongoDB connection failed:', error.message)
    process.exit(1)
}

if (!process.env.VERCEL) {
    app.listen(PORT, () => {
        console.log(`WedPlan Server Is Running On PORT ${PORT}`)
    })
}

export default app
