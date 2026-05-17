const express = require('express');
const { createClient } = require('@libsql/client');

const db = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN
});
const session = require('express-session'); // 1. Bring in the session tool
const app = express();

const axios = require('axios'); // The tool to send messages to Safaricom
const multer = require('multer');
const path = require('path');

// Configure where to save images and what to name them
const storage = multer.diskStorage({
    destination: './public/uploads/',
    filename: function(req, file, cb) {
        cb(null, Date.now() + path.extname(file.originalname)); // Saves as 1726354.jpg
    }
});

const upload = multer({ storage: storage });

// --- M-PESA CREDENTIALS ---
// Replace these with the actual keys you got from the Safaricom website!
const consumerKey = 'GrzHqjFxaksn2PlpN9FFb5vBJGcKSfzZ9MojnOwx00WOc8K0';
const consumerSecret = 'IBLAfnUGyTvbPsINGJAuc6OJQYqTp8rRZD29GPMGADnx9mu699TIz86Bu5db5ZNF';

// This function does the "Handshake" to get your temporary VIP Pass
async function getAccessToken() {
    const url = 'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials';
    
    // Safaricom requires the keys to be scrambled together for security
    const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');

    try {
        const response = await axios.get(url, {
            headers: {
                Authorization: `Basic ${auth}`
            }
        });
        return response.data.access_token; // This is the VIP Pass!
    } catch (error) {
        console.error("Error getting Access Token:", error.message);
        throw error;
    }
}

// --- M-PESA STK PUSH FUNCTION ---
async function initiateSTKPush(phoneNumber, amount) {
    const accessToken = await getAccessToken();
    const url = "https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest";
    
    // 1. Safaricom's specific Sandbox details
    const businessShortCode = "174379"; 
    const passkey = "bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919";
    
    // 2. Create a Timestamp (Format: YYYYMMDDHHMMSS)
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, -3);
    
    // 3. Create a Password (encoded in Base64)
    const password = Buffer.from(`${businessShortCode}${passkey}${timestamp}`).toString('base64');

    const data = {
        "BusinessShortCode": businessShortCode,
        "Password": password,
        "Timestamp": timestamp,
        "TransactionType": "CustomerPayBillOnline",
        "Amount": 1, // We'll keep it at 1 for testing
        "PartyA": phoneNumber,
        "PartyB": businessShortCode,
        "PhoneNumber": phoneNumber,
        "CallBackURL": "https://premium-boutique.onrender.com/mpesa-callback", // <-- Use YOUR actual Render link here!
        "AccountReference": "PremiumBoutique",
        "TransactionDesc": "Payment for Fashion Items"
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
app.use(express.json()); // Tells the server how to read Safaricom's automated JSON messages

// 2. Turn on the Sessions (The user's memory)
app.use(session({
    secret: 'my-fashion-secret',
    resave: false,
    saveUninitialized: true
}));

app.set('view engine', 'ejs');

// 3. Load the Homepage
app.get('/', async (req, res) => { 
    try {
        const result = await db.execute("SELECT * FROM products");
        res.render('home', { 
            storeName: "The Premium Boutique",
            products: result.rows 
        });
    } catch (err) {
        console.error("Error loading homepage products:", err.message);
        res.status(500).send("Error loading the store");
    }
});

// 4. Handle the "Buy" button click
// --- SHOPPING CART ROUTE ---
app.post('/add-to-cart/:id', (req, res) => {
    const productId = req.params.id;

    if (!req.session.cart) {
        req.session.cart = [];
    }

    req.session.cart.push(productId);
    console.log("Items in Cart:", req.session.cart);
    res.redirect('/');
});

// --- VIEW CART ROUTE ---
app.get('/cart', async (req, res) => {
    const cartItems = req.session.cart || [];

    if (cartItems.length === 0) {
        return res.render('cart', { items: [], total: 0 });
    }

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


// --- REMOVE FROM CART ROUTE ---
app.post('/remove-from-cart/:index', (req, res) => {
    const itemIndex = req.params.index;
    if (req.session.cart) {
        req.session.cart.splice(itemIndex, 1);
        req.session.save(); 
    }
    res.redirect('/cart');
});

// --- AUTHENTICATION ROUTES (LOGIN/LOGOUT) ---

// 1. Show the Login Page
app.get('/login', (req, res) => {
    res.render('login', { error: null });
});

// 2. Check the Username and Password
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    
    const myUsername = "mrcollins";
    const myPassword = "James12345mutho@#";

    if (username === myUsername && password === myPassword) {
        req.session.isAdmin = true;
        res.redirect('/admin'); 
    } else {
        res.render('login', { error: "Invalid username or password" });
    }
});

// --- THE SECURITY GUARD (MIDDLEWARE) ---
function requireLogin(req, res, next) {
    if (req.session.isAdmin === true) {
        next(); 
    } else {
        res.redirect('/login');
    }
}

// --- AUTOMATIC M-PESA CALLBACK ROUTE ---
app.post('/mpesa-callback', (req, res) => {
    console.log("🔔 ---- SAFARICOM CALLBACK RECEIVED ---- 🔔");
    const callbackData = req.body.Body.stkCallback; 
    
    if (callbackData.ResultCode === 0) {
        console.log("✅ PAYMENT SUCCESSFUL!");
        const mpesaReceipt = callbackData.CallbackMetadata.Item.find(item => item.Name === 'MpesaReceiptNumber').Value;
        console.log(`Receipt Number: ${mpesaReceipt}`);
    } else {
        console.log("❌ PAYMENT FAILED OR CANCELLED.");
        console.log(`Reason: ${callbackData.ResultDesc}`);
    }

    res.json({
        "ResultCode": 0,
        "ResultDesc": "Confirmation Received Successfully"
    });
});

// 3. Logout Route
app.get('/logout', (req, res) => {
    req.session.isAdmin = false;
    res.redirect('/'); 
});


// --- RECEIPT & CHECKOUT ROUTES ---

const PDFDocument = require('pdfkit'); 
const fs = require('fs');

app.get('/download-receipt/:orderId', async (req, res) => {
    try {
        const result = await db.execute({
            sql: "SELECT * FROM orders WHERE id = ?",
            args: [req.params.orderId]
        });
        
        // Turso returns an array, so we grab the first row [0]
        const order = result.rows[0]; 

        if (!order) return res.send("Order not found.");

        const doc = new PDFDocument();
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=Receipt_Order_${order.id}.pdf`);

        doc.pipe(res); 

        doc.fontSize(25).text('THE PREMIUM BOUTIQUE', { align: 'center' });
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


// 1. Show the Checkout Page
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

// 2. Process the Order (The most important part!)
app.post('/place-order', async (req, res) => {
    const { name, phone } = req.body;
    const cartItems = req.session.cart || [];

    if (cartItems.length === 0) return res.redirect('/');

    const placeholders = cartItems.map(() => '?').join(',');
    
    try {
        // 1. Fetch products
        const productResult = await db.execute({
            sql: `SELECT name, price FROM products WHERE id IN (${placeholders})`,
            args: cartItems
        });
        
        const total = productResult.rows.reduce((sum, row) => sum + row.price, 0);
        const itemNames = productResult.rows.map(r => r.name).join(', ');

        // 2. Trigger M-Pesa
        await initiateSTKPush(phone, total);

        // 3. Save to Database
        const insertResult = await db.execute({
            sql: `INSERT INTO orders (customer_name, contact, total_price, items) VALUES (?, ?, ?, ?)`,
            args: [name, phone, total, itemNames]
        });

        // Turso provides the inserted ID in a property called 'lastInsertRowid'
        const orderId = insertResult.lastInsertRowid; 
        
        req.session.cart = []; // Clear the cart memory
        
        // Send the professional success page with the PDF link
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

// --- ADMIN DASHBOARD ROUTES ---

// Lock 1: The main dashboard (Updated to fetch products)
app.get('/admin', requireLogin, async (req, res) => {
    try {
        const result = await db.execute("SELECT * FROM products ORDER BY id DESC");
        res.render('admin', { products: result.rows }); 
    } catch (err) {
        console.error("Error loading admin:", err.message);
        res.status(500).send("Database error");
    }
});

// Lock 2: Adding a product
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
        console.error("Error adding product:", err.message);
        res.status(500).send("Database error");
    }
});

// Lock 3: Viewing the orders (I consolidated your two identical routes into this one!)
app.get('/admin/orders', requireLogin, async (req, res) => {
    try {
        const result = await db.execute("SELECT * FROM orders ORDER BY order_date DESC");
        res.render('admin-orders', { orders: result.rows });
    } catch (err) {
        console.error("Error loading orders:", err.message);
        res.status(500).send("Database error");
    }
});

// Lock 4: Delete a product
app.post('/admin/delete/:id', requireLogin, async (req, res) => { 
    const productId = req.params.id;
    try {
        await db.execute({
            sql: "DELETE FROM products WHERE id = ?",
            args: [productId]
        });
        console.log(`Product ${productId} deleted.`);
        res.redirect('/admin'); 
    } catch (err) {
        console.error("Error deleting product:", err.message);
        res.status(500).send("Database error"); 
    }
});

// Lock 5: Show the Edit Page
app.get('/admin/edit/:id', requireLogin, async (req, res) => {
    try {
        const result = await db.execute({
            sql: "SELECT * FROM products WHERE id = ?",
            args: [req.params.id]
        });
        
        const row = result.rows[0]; // Get the specific product
        if (!row) return res.send("Product not found");
        
        res.render('edit', { product: row });
    } catch (err) {
        console.error("Error loading edit page:", err.message);
        res.status(500).send("Database error");
    }
});

// Lock 6: Save the changes to the database
app.post('/admin/edit/:id', requireLogin, async (req, res) => {
    const { name, price, category, stock } = req.body;
    try {
        await db.execute({
            sql: "UPDATE products SET name = ?, price = ?, category = ?, stock = ? WHERE id = ?",
            args: [name, price, category, stock, req.params.id]
        });
        console.log(`Product ${req.params.id} updated.`);
        res.redirect('/admin'); 
    } catch (err) {
        console.error("Error updating product:", err.message);
        res.status(500).send("Database error");
    }
});


// This tells the server: "Use the cloud's port, or use 3000 if I'm on my laptop"
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});