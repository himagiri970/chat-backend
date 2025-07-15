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

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

// ✅ MongoDB connection
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => console.error("❌ MongoDB connection error:", err));

// ✅ Auth Routes
app.post("/api/auth/register", async (req, res) => {
  const { name, email, password } = req.body;
  const existing = await User.findOne({ email });
  if (existing) return res.status(400).json({ message: "User already exists" });

  const newUser = new User({ name, email, password });
  await newUser.save();
  res.json({ message: "Registered successfully" });
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;
  const user = await User.findOne({ email, password });
  if (!user) return res.status(401).json({ message: "Invalid email or password" });

  const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: "7d" });
  res.json({ token, user });
});

// ✅ Search Users
app.get("/api/users/search", async (req, res) => {
  const { name } = req.query;
  if (!name) return res.json([]);

  try {
    const users = await User.find({ name: { $regex: new RegExp(name, "i") } }).select("_id name email");
    res.json(users);
  } catch (err) {
    res.status(500).json({ message: "Search failed", error: err.message });
  }
});

// ✅ Get User by ID
app.get("/api/users/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const user = await User.findById(id).select("_id name email friends").populate({
      path: "friends",
      select: "_id name email"
    });
    if (!user) return res.status(404).json({ message: "User not found" });
    res.json(user);
  } catch (err) {
    res.status(500).json({ message: "Error fetching user", error: err.message });
  }
});

// ✅ Friend Request Routes
app.get("/api/friends/requests/:userId", async (req, res) => {
  const { userId } = req.params;
  try {
    const user = await User.findById(userId).populate("friendRequests", "_id name email");
    if (!user || !user.friendRequests) return res.json([]);
    const requests = user.friendRequests.map((u) => ({ _id: u._id, fromUser: u }));
    res.json(requests);
  } catch (err) {
    res.status(500).json({ message: "Error fetching requests", error: err.message });
  }
});

app.post("/api/friends/request", async (req, res) => {
  const { fromId, toId } = req.body;
  if (!fromId || !toId) return res.status(400).json({ message: "Missing fromId or toId" });
  if (fromId === toId) return res.status(400).json({ message: "Cannot send request to yourself" });

  try {
    const toUser = await User.findById(toId);
    if (toUser.friendRequests.includes(fromId)) {
      return res.status(400).json({ message: "Request already sent" });
    }
    await User.findByIdAndUpdate(toId, { $push: { friendRequests: fromId } });
    await User.findByIdAndUpdate(fromId, { $push: { sentRequests: toId } });
    res.json({ message: "Friend request sent" });
  } catch (err) {
    res.status(500).json({ message: "Error sending request", error: err.message });
  }
});

app.post("/api/friends/accept", async (req, res) => {
  const { userId, fromId } = req.body;
  try {
    await User.findByIdAndUpdate(userId, {
      $pull: { friendRequests: fromId },
      $push: { friends: fromId },
    });
    await User.findByIdAndUpdate(fromId, {
      $pull: { sentRequests: userId },
      $push: { friends: userId },
    });
    res.json({ message: "Friend request accepted" });
  } catch (err) {
    res.status(500).json({ message: "Error accepting request", error: err.message });
  }
});

app.post("/api/friends/reject", async (req, res) => {
  const { userId, fromId } = req.body;
  try {
    await User.findByIdAndUpdate(userId, { $pull: { friendRequests: fromId } });
    await User.findByIdAndUpdate(fromId, { $pull: { sentRequests: userId } });
    res.json({ message: "Friend request rejected" });
  } catch (err) {
    res.status(500).json({ message: "Error rejecting request", error: err.message });
  }
});

// ✅ Messages
app.get("/api/messages/:userId/:friendId", async (req, res) => {
  const { userId, friendId } = req.params;
  try {
    const messages = await Message.find({
      $or: [{ from: userId, to: friendId }, { from: friendId, to: userId }]
    }).sort({ timestamp: 1 });
    res.json(messages);
  } catch (err) {
    res.status(500).json({ message: "Error fetching messages", error: err.message });
  }
});

app.post("/api/messages/send", async (req, res) => {
  const { from, to, text, name } = req.body;
  try {
    const message = new Message({ from, to, text, name });
    await message.save();
    res.json({ message: "Message sent" });
  } catch (err) {
    res.status(500).json({ message: "Error sending message", error: err.message });
  }
});

app.post("/api/messages/read", async (req, res) => {
  const { userId, friendId } = req.body;
  try {
    await Message.updateMany({ from: friendId, to: userId, read: false }, { $set: { read: true } });
    res.json({ message: "Messages marked as read" });
  } catch (err) {
    res.status(500).json({ message: "Error marking as read", error: err.message });
  }
});

// ✅ Setup HTTP + Socket.IO server
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});


// ✅ Get Unread Message Counts
// ✅ Get Conversations with Unread Counts - FIXED VERSION
app.get("/api/conversations/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    
    // Validate userId
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ 
        success: false, 
        message: "Invalid user ID format" 
      });
    }

    // Convert userId to ObjectId properly
    const userObjectId = new mongoose.Types.ObjectId(userId);

    // Get all conversations for this user
    const conversations = await Message.aggregate([
      {
        $match: {
          $or: [
            { from: userObjectId },
            { to: userObjectId }
          ]
        }
      },
      {
        $sort: { timestamp: -1 } // Sort by newest first
      },
      {
        $group: {
          _id: {
            $cond: [
              { $eq: ["$from", userObjectId] },
              "$to",
              "$from"
            ]
          },
          lastMessage: { $first: "$$ROOT" },
          unreadCount: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ["$to", userObjectId] },
                    { $eq: ["$read", false] }
                  ]
                },
                1,
                0
              ]
            }
          }
        }
      },
      {
        $lookup: {
          from: "users",
          localField: "_id",
          foreignField: "_id",
          as: "friend"
        }
      },
      {
        $unwind: "$friend"
      },
      {
        $project: {
          friendId: "$_id",
          name: "$friend.name",
          email: "$friend.email",
          lastMessage: 1,
          unreadCount: 1,
          _id: 0
        }
      },
      {
        $sort: { "lastMessage.timestamp": -1 } // Sort conversations by most recent message
      }
    ]);

    res.status(200).json({
      success: true,
      data: conversations
    });

  } catch (err) {
    console.error("Error in /api/conversations:", err);
    res.status(500).json({
      success: false,
      message: "Server error while fetching conversations",
      error: err.message
    });
  }
});
io.on("connection", (socket) => {
  console.log("⚡ Client connected:", socket.id);

  socket.on("join", ({ userId, friendId }) => {
    const room = [userId, friendId].sort().join(":");
    socket.join(room);
    console.log(`👥 ${userId} joined room ${room}`);
  });

  socket.on("send_message", async (data) => {
    console.log("📩 Incoming socket message:", data);

    const { from, to, text } = data;
    if (!from || !to || !text) {
      console.warn("⚠️ Invalid data received:", data);
      return;
    }

    try {
      // Get sender info
      const sender = await User.findById(from).select("name");
      if (!sender) throw new Error("Sender not found");

      // Save message to database
      const message = new Message({
        from,
        to,
        text,
        senderName: sender.name // Store sender name in database
      });
      await message.save();

      // Emit to both users
      const room = [from, to].sort().join(":");
      
      io.to(room).emit("receive_message", {
        _id: message._id,
        from,
        to,
        text,
        timestamp: message.timestamp,
        senderName: sender.name, // Include sender name in socket emission
        read: false
      });
      
      console.log("📤 Message emitted to room:", room);
    } catch (err) {
      console.error("❌ Error sending message:", err.message);
    }
  });

  socket.on("disconnect", () => {
    console.log("❌ Client disconnected:", socket.id);
  });
});
// ... (rest of the backend code remains the same)

// ✅ Start the server
server.listen(PORT, () => {
  console.log(`🚀 Auth server + Socket.IO running on http://localhost:${PORT}`);
});
