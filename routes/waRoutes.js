// routes/waRoutes.js
import express from "express";
import waRouter from "../controllers/waController.js"; // file must export router
import { verifyApiKey } from "../middleware/authMiddleware.js";

const router = express.Router();

// allow qr-stream (EventSource) via query param ?apiKey=
router.use("/qr-stream", waRouter);

// protect other WA endpoints with API key
router.use("/", verifyApiKey, waRouter);

export default router;
