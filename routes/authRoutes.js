// routes/authRoutes.js
import express from "express";
import {
  register, login, forgotPassword, resetPassword, updateProfile,
  getAllUsers, setUserRole, setPremium
} from "../controllers/authController.js";
import { verifyToken, verifyAdmin } from "../middleware/authMiddleware.js";

const router = express.Router();

router.post("/register", register);
router.post("/login", login);
router.post("/forgot", forgotPassword);
router.post("/reset", resetPassword);
router.put("/profile", verifyToken, updateProfile);

// admin
router.get("/users", verifyToken, verifyAdmin, getAllUsers);
router.put("/users/role", verifyToken, verifyAdmin, setUserRole);
router.put("/users/premium", verifyToken, verifyAdmin, setPremium);

export default router;
