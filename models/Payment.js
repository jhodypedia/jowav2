import { DataTypes } from "sequelize";
import sequelize from "../config/db.js";

const Payment = sequelize.define("Payment", {
  orderId: { type: DataTypes.STRING, allowNull: false, unique: true },
  userId: { type: DataTypes.INTEGER, allowNull: false },
  amount: { type: DataTypes.INTEGER, allowNull: false },
  status: { type: DataTypes.STRING, defaultValue: "pending" },
  provider: { type: DataTypes.STRING, defaultValue: "midtrans" },
  notification: { type: DataTypes.JSON, allowNull: true }
});

export default Payment;
