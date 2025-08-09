import { DataTypes } from "sequelize";
import sequelize from "../config/db.js";

const User = sequelize.define("User", {
  username: { type: DataTypes.STRING, allowNull: false },
  email: { type: DataTypes.STRING, allowNull: false, unique: true },
  phone: { type: DataTypes.STRING, allowNull: false, unique: true },
  password: { type: DataTypes.STRING, allowNull: false },
  apiKey: { type: DataTypes.STRING, allowNull: false, unique: true },
  premium: { type: DataTypes.BOOLEAN, defaultValue: false },
  premiumUntil: { type: DataTypes.DATE, allowNull: true },
  resetToken: { type: DataTypes.STRING, allowNull: true },
  resetTokenExp: { type: DataTypes.DATE, allowNull: true }
});

export default User;
