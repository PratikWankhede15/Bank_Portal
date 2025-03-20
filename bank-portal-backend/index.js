require("dotenv").config();
const express = require("express");
const cors = require("cors");
const mysql = require("mysql2/promise");
const bcrypt = require("bcryptjs");

const app = express();
app.use(cors());
app.use(express.json());

// ✅ Database Connection (Promise-based)
const db = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// ✅ Admin Routes
app.get("/admin/users", async (req, res) => {
    try {
        const [users] = await db.query("SELECT id, name, email, balance FROM users");
        res.json(users);
    } catch (error) {
        console.error("Admin Users Fetch Error:", error);
        res.status(500).json({ error: "❌ Failed to fetch users!" });
    }
});

app.get("/admin/transactions", async (req, res) => {
    try {
        const [transactions] = await db.query(`
            SELECT t.id, t.amount, t.timestamp,
                   sender.name AS sender_name, sender.email AS sender_email,
                   receiver.name AS receiver_name, receiver.email AS receiver_email
            FROM transactions t
            JOIN users sender ON t.sender_id = sender.id
            JOIN users receiver ON t.receiver_id = receiver.id
            ORDER BY t.timestamp DESC
        `);
        res.json(transactions);
    } catch (error) {
        console.error("Admin Transactions Fetch Error:", error);
        res.status(500).json({ error: "❌ Failed to fetch transactions!" });
    }
});

app.delete("/admin/users/:id", async (req, res) => {
    const userId = req.params.id;
    try {
        await db.query("DELETE FROM users WHERE id = ?", [userId]);
        res.json({ message: "✅ User deleted successfully!" });
    } catch (error) {
        console.error("Admin Delete User Error:", error);
        res.status(500).json({ error: "❌ Failed to delete user!" });
    }
});

// ✅ User Routes
app.post("/signup", async (req, res) => {
    try {
        const { name, email, password } = req.body;
        if (!name || !email || !password) return res.status(400).json({ error: "❌ All fields are required!" });

        const hashedPassword = await bcrypt.hash(password, 10);
        await db.query("INSERT INTO users (name, email, password, balance) VALUES (?, ?, ?, 1000)", [name, email, hashedPassword]);

        res.json({ message: "✅ User registered successfully!" });
    } catch (error) {
        console.error("Signup Error:", error);
        res.status(500).json({ error: "❌ Server error!" });
    }
});

app.post("/login", async (req, res) => {
    const { email, password } = req.body;
    try {
        const [users] = await db.query("SELECT * FROM users WHERE email = ?", [email]);
        if (users.length === 0) return res.status(401).json({ message: "❌ User not found!" });

        const user = users[0];
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(401).json({ message: "❌ Invalid credentials!" });

        res.json({ user: { id: user.id, name: user.name, balance: user.balance } });
    } catch (error) {
        console.error("Login Error:", error);
        res.status(500).json({ error: "❌ Server error!" });
    }
});

app.get("/balance/:userId", async (req, res) => {
    try {
        const { userId } = req.params;
        const [result] = await db.query("SELECT balance FROM users WHERE id = ?", [userId]);
        if (result.length === 0) return res.status(404).json({ error: "❌ User not found!" });
        res.json({ balance: result[0].balance });
    } catch (error) {
        console.error("Balance Fetch Error:", error);
        res.status(500).json({ error: "❌ Failed to fetch balance!" });
    }
});

app.get("/transactions/:userId", async (req, res) => {
    try {
        const { userId } = req.params;
        const [transactions] = await db.query(`
            SELECT t.amount, t.timestamp,
                   sender.name AS sender_name, sender.email AS sender_email,
                   receiver.name AS receiver_name, receiver.email AS receiver_email
            FROM transactions t
            JOIN users sender ON t.sender_id = sender.id
            JOIN users receiver ON t.receiver_id = receiver.id
            WHERE t.sender_id = ? OR t.receiver_id = ?
            ORDER BY t.timestamp DESC
        `, [userId, userId]);

        res.json(transactions);
    } catch (error) {
        console.error("Transaction Fetch Error:", error);
        res.status(500).json({ error: "❌ Failed to load transactions!" });
    }
});

app.post("/transfer", async (req, res) => {
    const { senderId, recipientEmail, amount } = req.body;
    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
        return res.status(400).json({ message: "❌ Enter a valid amount!" });
    }

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        // Check sender balance
        const [sender] = await connection.query("SELECT name, balance FROM users WHERE id = ? FOR UPDATE", [senderId]);
        if (sender.length === 0 || sender[0].balance < parsedAmount) {
            throw { message: "❌ Insufficient balance!", status: 400 };
        }

        // Get receiver details
        const [receiver] = await connection.query("SELECT id, name FROM users WHERE email = ?", [recipientEmail]);
        if (receiver.length === 0) throw { message: "❌ Receiver not found!", status: 404 };

        const receiverId = receiver[0].id;
        const senderName = sender[0].name;
        const receiverName = receiver[0].name;

        // Deduct sender balance & add receiver balance
        await connection.query("UPDATE users SET balance = balance - ? WHERE id = ?", [parsedAmount, senderId]);
        await connection.query("UPDATE users SET balance = balance + ? WHERE id = ?", [parsedAmount, receiverId]);

        // Insert transaction with sender & receiver names
        await connection.query(`
            INSERT INTO transactions (sender_id, receiver_id, sender_name, receiver_name, amount, timestamp) 
            VALUES (?, ?, ?, ?, ?, NOW())`, [senderId, receiverId, senderName, receiverName, parsedAmount]);

        await connection.commit();
        res.json({ message: "✅ Transfer Successful!" });
    } catch (error) {
        await connection.rollback();
        console.error("Transfer Error:", error);
        res.status(error.status || 500).json({ message: error.message || "❌ Server error!" });
    } finally {
        connection.release();
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
