const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  name: String,
  email: { type: String, unique: true },
  password: String,

  // ✅ Clean reference-based arrays
  friends: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],          // accepted
  friendRequests: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],  // incoming
  sentRequests: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],    // outgoing
});

module.exports = mongoose.model("User", userSchema);
