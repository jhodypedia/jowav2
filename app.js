import express from "express";
import waRoutes, { createSocketForUser } from "./controllers/waController.js";
import apiKeyAuth from "./middlewares/apiKeyAuth.js";

const app = express();
app.use(express.json());

// Mount WA routes — pastikan apiKeyAuth dijalankan sebelum route handler
app.use("/api", apiKeyAuth, waRoutes);
