const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./store.db');

db.serialize(() => {
    // This table stores: Order ID, Customer Name, Contact, Total Price, and Date
    db.run(`CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_name TEXT,
        contact TEXT,
        total_price REAL,
        items TEXT,
        order_date DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    console.log("Orders table created!");
});
db.close();