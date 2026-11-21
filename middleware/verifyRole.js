// Use after verifyToken: verifyRole('admin') or verifyRole('vendor', 'admin')
const verifyRole = (...roles) => {
    return (req, res, next) => {
        if (!req.user || !roles.includes(req.user.role)) {
            return res.status(403).send({ message: 'Forbidden. You do not have access to this action.' })
        }
        next()
    }
}

export const verifyAdmin = verifyRole('admin')
export const verifyVendor = verifyRole('vendor')
export const verifyCustomer = verifyRole('customer')

export default verifyRole
