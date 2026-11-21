import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { CLIENT_URL } from './config.js'

const app = express()
const PORT = process.env.PORT || 5000

app.use(cors({ origin: CLIENT_URL }))
app.use(express.json())

app.get('/', (req, res) => {
    res.send({ message: 'WedPlan Server is Running' })
})

if (!process.env.VERCEL) {
    app.listen(PORT, () => {
        console.log(`WedPlan Server Is Running On PORT ${PORT}`)
    })
}

export default app
