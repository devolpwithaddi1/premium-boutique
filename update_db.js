const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./store.db');

db.run("ALTER TABLE products ADD COLUMN image TEXT", (err) => {
    if (err) console.log("Column already exists or error:", err.message);
    else console.log("Database updated successfully!");
});
db.close();