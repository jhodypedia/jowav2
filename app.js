// server.js
import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import sequelize from "./config/db.js";

import authRoutes from "./routes/authRoutes.js";
import paymentRoutes from "./routes/paymentRoutes.js";
import logRoutes from "./routes/logRoutes.js";
import waRoutes from "./routes/waRoutes.js";

dotenv.config();

const app = express();

// Middleware global
app.use(cors());
app.use(express.json({ limit: "15mb" })); // untuk JSON
app.use(express.urlencoded({ extended: true, limit: "15mb" })); // untuk form-urlencoded

// DB connect + sync
(async () => {
  try {
    await sequelize.authenticate();
    console.log("✅ Database connected");
    await sequelize.sync();
    console.log("✅ Database synced");
  } catch (err) {
    console.error("❌ DB error:", err);
  }
})();

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/payment", paymentRoutes);
app.use("/api/logs", logRoutes);
app.use("/api/v1", waRoutes);

// Health check
app.get("/", (req, res) => res.json({ ok: true }));

// Global error handler
app.use((err, req, res, next) => {
  console.error("❌ Server error:", err);
  res.status(500).json({ error: "Internal Server Error", details: err.message });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
