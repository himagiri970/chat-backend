const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
require("dotenv").config();

const User = require("./models/User");
const Message = require("./models/Message");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const PORT = process.env.PORT || 5000;
app.use(cors());
app.use(express.json());

// ✅ MongoDB connection
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => console.error("❌ MongoDB connection error:", err));

// ✅ Register route
app.post("/api/auth/register", async (req, res) => {
  const { name, email, password } = req.body;
  const existing = await User.findOne({ email });
  if (existing) return res.status(400).json({ message: "User already exists" });

  const newUser = new User({ name, email, password });
  await newUser.save();
  res.json({ message: "Registered successfully" });
});

// ✅ Login route


app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;
  const user = await User.findOne({ email, password });
  if (!user) return res.status(401).json({ message: "Invalid email or password" });

  // ✅ Create a real JWT token
  const token = jwt.sign(
    { userId: user._id },                 // payload
    process.env.JWT_SECRET,              // secret key (from .env)
    { expiresIn: "7d" }                  // optional: token expires in 7 days
  );

  res.json({ token, user });
});


// ✅ search operation
app.get("/api/users/search", async (req, res) => {
  const { name } = req.query;
  if (!name) return res.json([]);

  try {
    const users = await User.find({
      name: { $regex: new RegExp(name, "i") }, // safer than just passing `name` directly
    }).select("_id name email");

    res.json(users);
  } catch (err) {
    console.error("Search failed:", err);
    res.status(500).json({ message: "Search failed", error: err.message });
  }
});

// ✅ Get user by ID (for dashboard)
app.get("/api/users/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const user = await User.findById(id)
      .select("_id name email friends")
      .populate({ path: "friends", select: "_id name email" });
    if (!user) return res.status(404).json({ message: "User not found" });
    res.json(user);
  } catch (err) {
    res.status(500).json({ message: "Error fetching user", error: err.message });
  }
});

// ✅ Get incoming friend requests for a user
app.get("/api/friends/requests/:userId", async (req, res) => {
  const { userId } = req.params;
  try {
    const user = await User.findById(userId).populate({
      path: "friendRequests",
      select: "_id name email"
    });
    if (!user || !user.friendRequests) return res.json([]);
    // friendRequests is an array of User objects
    const requests = user.friendRequests.map((u) => ({
      _id: u._id,
      fromUser: u
    }));
    res.json(requests);
  } catch (err) {
    res.status(500).json({ message: "Error fetching requests", error: err.message });
  }
});

// ✅ Send a friend request
app.post("/api/friends/request", async (req, res) => {
  const { fromId, toId } = req.body;
  if (!fromId || !toId) return res.status(400).json({ message: "Missing fromId or toId" });
  if (fromId === toId) return res.status(400).json({ message: "Cannot send request to yourself" });
  try {
    // Prevent duplicate requests
    const toUser = await User.findById(toId);
    if (toUser.friendRequests.includes(fromId)) {
      return res.status(400).json({ message: "Request already sent" });
    }
    // Add to incoming requests
    await User.findByIdAndUpdate(toId, { $push: { friendRequests: fromId } });
    // Add to outgoing requests
    await User.findByIdAndUpdate(fromId, { $push: { sentRequests: toId } });
    res.json({ message: "Friend request sent" });
  } catch (err) {
    res.status(500).json({ message: "Error sending request", error: err.message });
  }
});

// ✅ Accept a friend request
app.post("/api/friends/accept", async (req, res) => {
  const { userId, fromId } = req.body;
  if (!userId || !fromId) return res.status(400).json({ message: "Missing userId or fromId" });
  try {
    // Remove from incoming requests
    await User.findByIdAndUpdate(userId, { $pull: { friendRequests: fromId }, $push: { friends: fromId } });
    // Remove from outgoing requests and add to friends
    await User.findByIdAndUpdate(fromId, { $pull: { sentRequests: userId }, $push: { friends: userId } });
    res.json({ message: "Friend request accepted" });
  } catch (err) {
    res.status(500).json({ message: "Error accepting request", error: err.message });
  }
});

// ✅ Reject a friend request
app.post("/api/friends/reject", async (req, res) => {
  const { userId, fromId } = req.body;
  if (!userId || !fromId) return res.status(400).json({ message: "Missing userId or fromId" });
  try {
    // Remove from incoming requests
    await User.findByIdAndUpdate(userId, { $pull: { friendRequests: fromId } });
    // Remove from outgoing requests
    await User.findByIdAndUpdate(fromId, { $pull: { sentRequests: userId } });
    res.json({ message: "Friend request rejected" });
  } catch (err) {
    res.status(500).json({ message: "Error rejecting request", error: err.message });
  }
});

// ✅ Get messages between two users
app.get("/api/messages/:userId/:friendId", async (req, res) => {
  const { userId, friendId } = req.params;
  try {
    const messages = await Message.find({
      $or: [
        { from: userId, to: friendId },
        { from: friendId, to: userId }
      ]
    }).sort({ timestamp: 1 });
    res.json(messages);
  } catch (err) {
    res.status(500).json({ message: "Error fetching messages", error: err.message });
  }
});

// ✅ Send a message
app.post("/api/messages/send", async (req, res) => {
  const { from, to, text } = req.body;
  if (!from || !to || !text) return res.status(400).json({ message: "Missing fields" });
  try {
    const message = new Message({ from, to, text });
    await message.save();
    res.json({ message: "Message sent" });
  } catch (err) {
    res.status(500).json({ message: "Error sending message", error: err.message });
  }
});

// ✅ Mark messages as read
app.post("/api/messages/read", async (req, res) => {
  const { userId, friendId } = req.body;
  try {
    await Message.updateMany(
      { from: friendId, to: userId, read: false },
      { $set: { read: true } }
    );
    res.json({ message: "Messages marked as read" });
  } catch (err) {
    res.status(500).json({ message: "Error marking as read", error: err.message });
  }
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

io.on("connection", (socket) => {
  // Join a room for private chat
  socket.on("join", ({ userId, friendId }) => {
    const room = [userId, friendId].sort().join(":");
    socket.join(room);
  });

  // Handle sending a message
  socket.on("send_message", async (data) => {
    const { from, to, text } = data;
    const message = new Message({ from, to, text });
    await message.save();
    const room = [from, to].sort().join(":");
    io.to(room).emit("receive_message", { from, to, text, timestamp: message.timestamp });
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Auth server + Socket.IO running on http://localhost:${PORT}`);
});

