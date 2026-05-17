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

const db = new sqlite3.Database('./store.db');
app.set('view engine', 'ejs');

// 3. Load the Homepage
app.get('/', (req, res) => {
    db.all("SELECT * FROM products", [], (err, rows) => {
        if (err) throw err;
        res.render('home', { 
            storeName: "The Premium Boutique",
            products: rows 
        });
    });
});

// 4. Handle the "Buy" button click
// --- SHOPPING CART ROUTE ---
app.post('/add-to-cart/:id', (req, res) => {
    const productId = req.params.id;

    // 1. If the user doesn't have a cart yet, create an empty one for them
    if (!req.session.cart) {
        req.session.cart = [];
    }

    // 2. Add this product's ID into their cart
    req.session.cart.push(productId);

    // 3. For now, let's just log it to the terminal so we can see it working!
    console.log("Items in Cart:", req.session.cart);
    
    // 4. Send them back to the storefront so they can keep shopping
    res.redirect('/');
});

// --- VIEW CART ROUTE ---
app.get('/cart', (req, res) => {
    // 1. Get the items from memory
    const cartItems = req.session.cart || [];

    // 2. If cart is empty, show the empty cart page
    if (cartItems.length === 0) {
        return res.render('cart', { items: [], total: 0 });
    }

    // 3. Ask the database for the details of these IDs
    const placeholders = cartItems.map(() => '?').join(','); 
    
    db.all(`SELECT * FROM products WHERE id IN (${placeholders})`, cartItems, (err, rows) => {
        if (err) throw err;
        
        let finalCartItems = [];
        let totalPrice = 0;

        // 4. THE FIX: Loop through every single click in the user's memory
        cartItems.forEach(cartId => {
            // Find the database row that matches this exact click
            const product = rows.find(row => row.id.toString() === cartId.toString());
            
            if (product) {
                finalCartItems.push(product); // Add it to the final list
                totalPrice += product.price;  // Add its price to the total
            }
        });

        // 5. Send the accurate list and total price to the cart.ejs page
        res.render('cart', { items: finalCartItems, total: totalPrice });
    });
});


// --- REMOVE FROM CART ROUTE ---
app.post('/remove-from-cart/:index', (req, res) => {
    // 1. Find out which item number they clicked
    const itemIndex = req.params.index;
    
    // 2. Double-check that they actually have a cart
    if (req.session.cart) {
        // 3. Remove exactly ONE item at that specific position in the list
        req.session.cart.splice(itemIndex, 1);
        
        // Save the updated memory
        req.session.save(); 
    }
    
    // 4. Reload the cart page to show the updated list
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
    
    // CHANGE THESE to whatever secret credentials you want!
    const myUsername = "mrcollins";
    const myPassword = "James12345mutho@#";

    if (username === myUsername && password === myPassword) {
        // Give them the VIP Badge in their session memory
        req.session.isAdmin = true;
        res.redirect('/admin'); // Let them into the dashboard!
    } else {
        // Wrong password? Send them back with an error.
        res.render('login', { error: "Invalid username or password" });
    }
});

// --- THE SECURITY GUARD (MIDDLEWARE) ---
function requireLogin(req, res, next) {
    // If they have the VIP badge, let them proceed (next)
    if (req.session.isAdmin === true) {
        next(); 
    } else {
        // If they don't have the badge, kick them out to the login page!
        res.redirect('/login');
    }
}

// --- AUTOMATIC M-PESA CALLBACK ROUTE ---
app.post('/mpesa-callback', (req, res) => {
    console.log("🔔 ---- SAFARICOM CALLBACK RECEIVED ---- 🔔");
    
    // Safaricom wraps their data in this specific structure
    const callbackData = req.body.Body.stkCallback; 
    
    if (callbackData.ResultCode === 0) {
        console.log("✅ PAYMENT SUCCESSFUL!");
        
        // Safaricom sends back the exact Receipt Number (e.g., QWE123RTY)
        const mpesaReceipt = callbackData.CallbackMetadata.Item.find(item => item.Name === 'MpesaReceiptNumber').Value;
        console.log(`Receipt Number: ${mpesaReceipt}`);
        
        // *In the future, we will add a line here to update your database and mark the order as "PAID"*

    } else {
        // ResultCode is not 0, which means the user cancelled, had insufficient funds, or it timed out.
        console.log("❌ PAYMENT FAILED OR CANCELLED.");
        console.log(`Reason: ${callbackData.ResultDesc}`);
    }

    // You MUST send a response back to Safaricom immediately, otherwise they will keep sending the message!
    res.json({
        "ResultCode": 0,
        "ResultDesc": "Confirmation Received Successfully"
    });
});

// 3. Logout Route
app.get('/logout', (req, res) => {
    req.session.isAdmin = false;
    res.redirect('/'); // Send them back to the storefront
});

// --- ADMIN DASHBOARD ROUTES ---

const PDFDocument = require('pdfkit'); // 1. Bring in the PDF tool
const fs = require('fs');

app.get('/download-receipt/:orderId', (req, res) => {
    const orderId = req.params.id;

    // 2. Fetch the order details from the database
    db.get("SELECT * FROM orders WHERE id = ?", [req.params.orderId], (err, order) => {
        if (err || !order) return res.send("Order not found.");

        // 3. Create the PDF
        const doc = new PDFDocument();
        
        // Tell the browser to expect a PDF file
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=Receipt_Order_${order.id}.pdf`);

        doc.pipe(res); // Send the PDF directly to the browser

        // 4. Design the Receipt
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

        doc.end(); // Finish the PDF
    });
});



// 3. Show all Orders to the Admin
app.get('/admin/orders', (req, res) => {
    // We ask the database for all orders, sorted by the newest ones first (DESC)
    db.all("SELECT * FROM orders ORDER BY order_date DESC", [], (err, rows) => {
        if (err) {
            return console.error(err.message);
        }
        // Send those orders to our new page
        res.render('admin-orders', { orders: rows });
    });
});
// 1. Show the Checkout Page
app.get('/checkout', (req, res) => {
    const cartItems = req.session.cart || [];
    if (cartItems.length === 0) return res.redirect('/');

    // Fetch prices to show the total one last time
    const placeholders = cartItems.map(() => '?').join(',');
    db.all(`SELECT price FROM products WHERE id IN (${placeholders})`, cartItems, (err, rows) => {
        let total = rows.reduce((sum, row) => sum + row.price, 0);
        res.render('checkout', { total: total });
    });
});

// 2. Process the Order (The most important part!)
app.post('/place-order', async (req, res) => {
    const { name, phone } = req.body;
    const cartItems = req.session.cart || [];

    const placeholders = cartItems.map(() => '?').join(',');
    db.all(`SELECT name, price FROM products WHERE id IN (${placeholders})`, cartItems, async (err, rows) => {
        if (err) return res.send("Error processing order.");
        
        const total = rows.reduce((sum, row) => sum + row.price, 0);
        const itemNames = rows.map(r => r.name).join(', ');

        try {
            // 1. Trigger M-Pesa
            await initiateSTKPush(phone, total);

            // 2. Save to Database
            // Note: We use "function(err) {" here instead of "err => {" 
            // so that we can use "this.lastID"
            db.run(`INSERT INTO orders (customer_name, contact, total_price, items) VALUES (?, ?, ?, ?)`,
                [name, phone, total, itemNames], function(err) {
                    if (err) return res.send("Error saving order.");

                    // --- ADD THIS PART RIGHT HERE ---
                    const orderId = this.lastID; // This gets the ID of the order just created
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
                    // --------------------------------
                }
            );
        } catch (error) {
            console.error(error);
            res.send("<h1>Oops!</h1><p>M-Pesa failed to trigger. Please check your number and try again.</p>");
        }
    });
});

// --- ADMIN DASHBOARD ROUTES ---

// Lock 1: The main dashboard (Updated to fetch products)
app.get('/admin', requireLogin, (req, res) => {
    db.all("SELECT * FROM products ORDER BY id DESC", [], (err, rows) => {
        if (err) return console.error(err.message);
        // Pass the products to the admin.ejs page
        res.render('admin', { products: rows }); 
    });
});

// Lock 2: Adding a product
app.post('/admin/add', requireLogin, upload.single('productImage'), (req, res) => {
    const { name, price, category, stock } = req.body;
    const imageName = req.file ? req.file.filename : 'default.jpg'; // Save the filename

    const insertQuery = "INSERT INTO products (name, price, category, stock, image) VALUES (?, ?, ?, ?, ?)";
    db.run(insertQuery, [name, price, category, stock, imageName], function(err) {
        if (err) return console.error(err.message);
        res.redirect('/');
    });
});

// Lock 3: Viewing the orders
app.get('/admin/orders', requireLogin, (req, res) => {
    // ... (keep all your existing database fetch code here) ...
    db.all("SELECT * FROM orders ORDER BY order_date DESC", [], (err, rows) => {
        if (err) return console.error(err.message);
        res.render('admin-orders', { orders: rows });
    });
});

// Lock 4: Delete a product
app.post('/admin/delete/:id', requireLogin, (req, res) => {
    const productId = req.params.id;
    
    db.run("DELETE FROM products WHERE id = ?", [productId], function(err) {
        if (err) return console.error(err.message);
        console.log(`Product ${productId} deleted.`);
        res.redirect('/admin'); // Refresh the admin dashboard
    });
});

// Lock 5: Show the Edit Page
app.get('/admin/edit/:id', requireLogin, (req, res) => {
    // 1. Find the specific product the user wants to edit
    db.get("SELECT * FROM products WHERE id = ?", [req.params.id], (err, row) => {
        if (err || !row) return res.send("Product not found");
        // 2. Send that product's data to the edit.ejs page
        res.render('edit', { product: row });
    });
});

// Lock 6: Save the changes to the database
app.post('/admin/edit/:id', requireLogin, (req, res) => {
    const { name, price, category, stock } = req.body;
    
    // 3. Update the specific row in the database
    const updateQuery = "UPDATE products SET name = ?, price = ?, category = ?, stock = ? WHERE id = ?";
    
    db.run(updateQuery, [name, price, category, stock, req.params.id], function(err) {
        if (err) return console.error(err.message);
        console.log(`Product ${req.params.id} updated.`);
        // 4. Send them back to the admin dashboard
        res.redirect('/admin'); 
    });
});



// This tells the server: "Use the cloud's port, or use 3000 if I'm on my laptop"
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});