const sqlite3 = require('sqlite3').verbose();

// This creates a file named 'store.db' in your folder
const db = new sqlite3.Database('./store.db');

db.serialize(() => {
    // 1. Create the Products table
    // It stores: ID, Name, Price, Category (Bag/Shoe), and Stock
    db.run(`CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        price REAL,
        category TEXT,
        stock INTEGER
    )`);

    // 2. Let's add some starting inventory!
    const insert = 'INSERT INTO products (name, price, category, stock) VALUES (?, ?, ?, ?)';
    db.run(insert, ['Leather Tote Bag', 4500, 'Bags', 10]);
    db.run(insert, ['Classic Sneakers', 3200, 'Shoes', 5]);
    db.run(insert, ['Designer Heels', 7500, 'Shoes', 3]);

    console.log("Database initialized and stock added!");
});

db.close();