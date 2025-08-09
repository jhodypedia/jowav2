import { DataTypes } from "sequelize";
import sequelize from "../config/db.js";

const Log = sequelize.define("Log", {
  userId: { type: DataTypes.INTEGER, allowNull: false },
  type: { type: DataTypes.STRING, allowNull: false }, // contoh: 'message', 'error', 'connection'
  message: { type: DataTypes.TEXT, allowNull: false },
  meta: { type: DataTypes.JSON, allowNull: true } // data tambahan
});

export default Log;
