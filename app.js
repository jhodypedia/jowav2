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
app.use(cors());
app.use(express.json({ limit: "15mb" }));

// DB connect + sync
(async () => {
  try {
    await sequelize.authenticate();
    console.log("✅ Database connected");
    await sequelize.sync();
    console.log("✅ Database synced");
  } catch (err) {
    console.error("DB error:", err);
  }
})();

// mount routes
app.use("/api/auth", authRoutes);
app.use("/api/payment", paymentRoutes);
app.use("/api/logs", logRoutes);
app.use("/api/v1", waRoutes);

// health
app.get("/", (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
