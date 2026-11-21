import express from 'express'
import verifyToken from '../middleware/verifyToken.js'

const router = express.Router()

// The signed-in user's own profile, read fresh from the database
router.get('/me', verifyToken, async (req, res) => {
    res.send(req.user)
})

export default router
