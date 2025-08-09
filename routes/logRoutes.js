// routes/logRoutes.js
import express from "express";
import { getLogs } from "../controllers/logController.js";
import { verifyToken } from "../middleware/authMiddleware.js";

const router = express.Router();
router.get("/", verifyToken, getLogs);
export default router;
