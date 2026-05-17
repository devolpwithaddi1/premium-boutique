const express = require('express');
const { createClient } = require('@libsql/client');

const db = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN
});
const session = require('express-session');
const app = express();

const axios = require('axios');
const multer = require('multer');
const path = require('path');
const PDFDocument = require('pdfkit'); 
const fs = require('fs');

// --- WHITE-LABEL CONFIGURATION ---
// These pull directly from the Render Environment Variables!
const STORE_NAME = process.env.STORE_NAME || "The Premium Boutique";
const ADMIN_USER = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASS = process.env.ADMIN_PASSWORD || "password123";
const APP_DOMAIN = process.env.APP_DOMAIN || "premium-boutique.onrender.com";

const MPESA_KEY = process.env.MPESA_CONSUMER_KEY;
const MPESA_SECRET = process.env.MPESA_CONSUMER_SECRET;
const MPESA_SHORTCODE = process.env.MPESA_SHORTCODE;
const MPESA_PASSKEY = process.env.MPESA_PASSKEY;

// Configure image uploads
const storage = multer.diskStorage({
    destination: './public/uploads/',
    filename: function(req, file, cb) {
        cb(null, Date.now() + path.extname(file.originalname)); 
    }
});
const upload = multer({ storage: storage });

// --- M-PESA FUNCTIONS ---
async function getAccessToken() {
    const url = 'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials';
    const auth = Buffer.from(`${MPESA_KEY}:${MPESA_SECRET}`).toString('base64');

    try {
        const response = await axios.get(url, {
            headers: { Authorization: `Basic ${auth}` }
        });
        return response.data.access_token; 
    } catch (error) {
        console.error("Error getting Access Token:", error.message);
        throw error;
    }
}

async function initiateSTKPush(phoneNumber, amount) {
    const accessToken = await getAccessToken();
    const url = "https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest";
    
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, -3);
    const password = Buffer.from(`${MPESA_SHORTCODE}${MPESA_PASSKEY}${timestamp}`).toString('base64');

    const data = {
        "BusinessShortCode": MPESA_SHORTCODE,
        "Password": password,
        "Timestamp": timestamp,
        "TransactionType": "CustomerPayBillOnline",
        "Amount": 1, // Keep at 1 for testing
        "PartyA": phoneNumber,
        "PartyB": MPESA_SHORTCODE,
        "PhoneNumber": phoneNumber,
        "CallBackURL": `https://${APP_DOMAIN}/mpesa-callback`, // Automatically uses the client's domain!
        "AccountReference": STORE_NAME,
        "TransactionDesc": `Payment for ${STORE_NAME}`
    };

    try {
        const response = await axios.post(url, data, {
            headers: { Authorization: `Bearer ${accessToken}` }
        });
        return response.data;
    } catch (error) {
        console.error("STK Push Error:", error.response ? error.response.data : error.message);
        throw error;
    }
}

app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json()); 

app.use(session({
    secret: 'my-fashion-secret', // You can also make this an env var later!
    resave: false,
    saveUninitialized: true
}));

app.set('view engine', 'ejs');

// --- PUBLIC ROUTES ---

// 1. Load the Homepage
app.get('/', async (req, res) => { 
    try {
        const result = await db.execute("SELECT * FROM products");
        res.render('home', { 
            storeName: STORE_NAME,
            products: result.rows 
        });
    } catch (err) {
        console.error("Error loading homepage:", err.message);
        res.status(500).send("Error loading the store");
    }
});

// 2. Add to Cart
app.post('/add-to-cart/:id', (req, res) => {
    if (!req.session.cart) req.session.cart = [];
    req.session.cart.push(req.params.id);
    res.redirect('/');
});

// 3. View Cart
app.get('/cart', async (req, res) => {
    const cartItems = req.session.cart || [];
    if (cartItems.length === 0) return res.render('cart', { items: [], total: 0 });

    const placeholders = cartItems.map(() => '?').join(','); 
    
    try {
        const result = await db.execute({
            sql: `SELECT * FROM products WHERE id IN (${placeholders})`,
            args: cartItems
        });
        
        let finalCartItems = [];
        let totalPrice = 0;

        cartItems.forEach(cartId => {
            const product = result.rows.find(row => row.id.toString() === cartId.toString());
            if (product) {
                finalCartItems.push(product); 
                totalPrice += product.price;  
            }
        });

        res.render('cart', { items: finalCartItems, total: totalPrice });
    } catch (err) {
        console.error("Error loading cart:", err.message);
        res.status(500).send("Database error");
    }
});

// 4. Remove from Cart
app.post('/remove-from-cart/:index', (req, res) => {
    if (req.session.cart) {
        req.session.cart.splice(req.params.index, 1);
        req.session.save(); 
    }
    res.redirect('/cart');
});

// --- NEW CONTACT US ROUTES ---

// Show the Contact Page
app.get('/contact', (req, res) => {
    res.render('contact', { storeName: STORE_NAME });
});

// Save the Message to Turso
app.post('/submit-contact', async (req, res) => {
    const { name, email, message } = req.body;
    try {
        await db.execute({
            sql: "INSERT INTO messages (customer_name, customer_email, message) VALUES (?, ?, ?)",
            args: [name, email, message]
        });
        res.send(`
            <div style="text-align:center; padding:50px; font-family:sans-serif;">
                <h1 style="color: #27ae60;">Message Sent! ✉️</h1>
                <p>Thank you for reaching out to ${STORE_NAME}. We will get back to you shortly.</p>
                <br>
                <a href="/" style="background:#333; color:white; padding:10px 20px; text-decoration:none; border-radius:5px;">Return to Shop</a>
            </div>
        `);
    } catch (err) {
        console.error("Error saving message:", err.message);
        res.status(500).send("Oops! Something went wrong.");
    }
});


// --- CHECKOUT & M-PESA ROUTES ---

app.get('/checkout', async (req, res) => {
    const cartItems = req.session.cart || [];
    if (cartItems.length === 0) return res.redirect('/');

    const placeholders = cartItems.map(() => '?').join(',');
    
    try {
        const result = await db.execute({
            sql: `SELECT price FROM products WHERE id IN (${placeholders})`,
            args: cartItems
        });
        
        let total = result.rows.reduce((sum, row) => sum + row.price, 0);
        res.render('checkout', { total: total });
    } catch (err) {
        console.error("Error loading checkout:", err.message);
        res.status(500).send("Error loading checkout");
    }
});

app.post('/place-order', async (req, res) => {
    const { name, phone } = req.body;
    const cartItems = req.session.cart || [];

    if (cartItems.length === 0) return res.redirect('/');
    const placeholders = cartItems.map(() => '?').join(',');
    
    try {
        const productResult = await db.execute({
            sql: `SELECT name, price FROM products WHERE id IN (${placeholders})`,
            args: cartItems
        });
        
        const total = productResult.rows.reduce((sum, row) => sum + row.price, 0);
        const itemNames = productResult.rows.map(r => r.name).join(', ');

        await initiateSTKPush(phone, total);

        const insertResult = await db.execute({
            sql: `INSERT INTO orders (customer_name, contact, total_price, items) VALUES (?, ?, ?, ?)`,
            args: [name, phone, total, itemNames]
        });

        const orderId = insertResult.lastInsertRowid; 
        req.session.cart = []; 
        
        res.send(`
            <div style="text-align:center; font-family:sans-serif; padding:50px;">
                <h1 style="color: #27ae60;">Order Successful! ✅</h1>
                <p>An M-Pesa PIN prompt has been sent to <strong>${phone}</strong>.</p>
                <p>Once you enter your PIN, your order is complete.</p>
                <br>
                <a href="/download-receipt/${orderId}" style="background:#27ae60; color:white; padding:15px 25px; text-decoration:none; border-radius:5px; font-weight:bold;">📥 Download Digital Receipt (PDF)</a>
                <br><br><br>
                <a href="/" style="color: #666;">Return to Homepage</a>
            </div>
        `);
    } catch (error) {
        console.error("Order processing error:", error);
        res.send("<h1>Oops!</h1><p>Failed to process order. Please check your number and try again.</p>");
    }
});

app.post('/mpesa-callback', (req, res) => {
    console.log("🔔 ---- SAFARICOM CALLBACK RECEIVED ---- 🔔");
    const callbackData = req.body.Body.stkCallback; 
    
    if (callbackData.ResultCode === 0) {
        console.log("✅ PAYMENT SUCCESSFUL!");
        const mpesaReceipt = callbackData.CallbackMetadata.Item.find(item => item.Name === 'MpesaReceiptNumber').Value;
        console.log(`Receipt Number: ${mpesaReceipt}`);
    } else {
        console.log("❌ PAYMENT FAILED OR CANCELLED.");
    }

    res.json({ "ResultCode": 0, "ResultDesc": "Confirmation Received Successfully" });
});

app.get('/download-receipt/:orderId', async (req, res) => {
    try {
        const result = await db.execute({
            sql: "SELECT * FROM orders WHERE id = ?",
            args: [req.params.orderId]
        });
        
        const order = result.rows[0]; 
        if (!order) return res.send("Order not found.");

        const doc = new PDFDocument();
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=Receipt_Order_${order.id}.pdf`);

        doc.pipe(res); 

        doc.fontSize(25).text(STORE_NAME.toUpperCase(), { align: 'center' });
        doc.moveDown();
        doc.fontSize(18).text('OFFICIAL RECEIPT', { underline: true });
        doc.moveDown();
        doc.fontSize(12).text(`Order Number: #${order.id}`);
        doc.text(`Date: ${order.order_date}`);
        doc.text(`Customer: ${order.customer_name}`);
        doc.text(`Contact: ${order.contact}`);
        doc.moveDown();
        doc.text('-------------------------------------------');
        doc.fontSize(14).text(`Items: ${order.items}`);
        doc.moveDown();
        doc.fontSize(16).text(`TOTAL PAID: KSh ${order.total_price}`, { bold: true });
        doc.moveDown();
        doc.text('-------------------------------------------');
        doc.moveDown();
        doc.fontSize(10).text('Thank you for shopping with us!', { align: 'center', italic: true });

        doc.end(); 
    } catch (err) {
        console.error("Error generating PDF:", err.message);
        res.status(500).send("Error generating receipt");
    }
});

// --- AUTHENTICATION ---

app.get('/login', (req, res) => {
    res.render('login', { error: null });
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    
    // Now using the Environment Variables!
    if (username === ADMIN_USER && password === ADMIN_PASS) {
        req.session.isAdmin = true;
        res.redirect('/admin'); 
    } else {
        res.render('login', { error: "Invalid username or password" });
    }
});

app.get('/logout', (req, res) => {
    req.session.isAdmin = false;
    res.redirect('/'); 
});

function requireLogin(req, res, next) {
    if (req.session.isAdmin === true) next(); 
    else res.redirect('/login');
}

// --- ADMIN DASHBOARD ROUTES ---

app.get('/admin', requireLogin, async (req, res) => {
    try {
        const result = await db.execute("SELECT * FROM products ORDER BY id DESC");
        res.render('admin', { products: result.rows }); 
    } catch (err) {
        res.status(500).send("Database error");
    }
});

app.get('/admin/orders', requireLogin, async (req, res) => {
    try {
        const result = await db.execute("SELECT * FROM orders ORDER BY order_date DESC");
        res.render('admin-orders', { orders: result.rows });
    } catch (err) {
        res.status(500).send("Database error");
    }
});

// NEW: Admin Messages Route!
app.get('/admin/messages', requireLogin, async (req, res) => {
    try {
        const result = await db.execute("SELECT * FROM messages ORDER BY received_at DESC");
        res.render('admin-messages', { messages: result.rows });
    } catch (err) {
        res.status(500).send("Database error");
    }
});

app.post('/admin/add', requireLogin, upload.single('productImage'), async (req, res) => {
    const { name, price, category, stock } = req.body;
    const imageName = req.file ? req.file.filename : 'default.jpg'; 
    try {
        await db.execute({
            sql: "INSERT INTO products (name, price, category, stock, image) VALUES (?, ?, ?, ?, ?)",
            args: [name, price, category, stock, imageName]
        });
        res.redirect('/admin');
    } catch (err) {
        res.status(500).send("Database error");
    }
});

app.post('/admin/delete/:id', requireLogin, async (req, res) => { 
    try {
        await db.execute({
            sql: "DELETE FROM products WHERE id = ?",
            args: [req.params.id]
        });
        res.redirect('/admin'); 
    } catch (err) {
        res.status(500).send("Database error"); 
    }
});

app.get('/admin/edit/:id', requireLogin, async (req, res) => {
    try {
        const result = await db.execute({
            sql: "SELECT * FROM products WHERE id = ?",
            args: [req.params.id]
        });
        if (!result.rows[0]) return res.send("Product not found");
        res.render('edit', { product: result.rows[0] });
    } catch (err) {
        res.status(500).send("Database error");
    }
});

app.post('/admin/edit/:id', requireLogin, async (req, res) => {
    const { name, price, category, stock } = req.body;
    try {
        await db.execute({
            sql: "UPDATE products SET name = ?, price = ?, category = ?, stock = ? WHERE id = ?",
            args: [name, price, category, stock, req.params.id]
        });
        res.redirect('/admin'); 
    } catch (err) {
        res.status(500).send("Database error");
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});