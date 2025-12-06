const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, '../tasks.db');
const db = new sqlite3.Database(dbPath);

function initDB() {
    db.run(`
        CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY,
            name TEXT,
            status TEXT,
            cep TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            finished_at DATETIME,
            input_file TEXT,
            output_file TEXT,
            log_file TEXT
        )
    `);
}

function createTask(task) {
    return new Promise((resolve, reject) => {
        const sql = `INSERT INTO tasks (id, name, status, cep, input_file, log_file) VALUES (?, ?, ?, ?, ?, ?)`;
        db.run(sql, [task.id, task.name, 'pending', task.cep, task.input_file, task.log_file], function(err) {
            if (err) reject(err);
            else resolve(this.lastID);
        });
    });
}

function updateTaskStatus(id, status, outputFile = null) {
    return new Promise((resolve, reject) => {
        let sql = `UPDATE tasks SET status = ? WHERE id = ?`;
        let params = [status, id];

        if (status === 'completed' || status === 'failed') {
            sql = `UPDATE tasks SET status = ?, finished_at = CURRENT_TIMESTAMP, output_file = ? WHERE id = ?`;
            params = [status, outputFile, id];
        }

        db.run(sql, params, function(err) {
            if (err) reject(err);
            else resolve();
        });
    });
}

function getTasks() {
    return new Promise((resolve, reject) => {
        db.all("SELECT * FROM tasks ORDER BY created_at DESC", [], (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

function getTaskById(id) {
    return new Promise((resolve, reject) => {
        db.get("SELECT * FROM tasks WHERE id = ?", [id], (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

module.exports = { initDB, createTask, updateTaskStatus, getTasks, getTaskById };
