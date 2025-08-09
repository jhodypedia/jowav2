// routes/paymentRoutes.js
import express from "express";
import { verifyToken } from "../middleware/authMiddleware.js";
import { createPremiumPaymentQRIS, midtransNotification } from "../controllers/paymentController.js";

const router = express.Router();

// protected: create order
router.post("/qris", verifyToken, createPremiumPaymentQRIS);

// webhook: public, set in Midtrans dashboard
router.post("/midtrans-notification", midtransNotification);

export default router;
