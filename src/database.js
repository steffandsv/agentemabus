const mysql = require('mysql2/promise');

let pool = null;

async function initDB() {
    if (pool) return;

    try {
        const config = {
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASS,
            database: process.env.DB_DB,
            waitForConnections: true,
            connectionLimit: 10,
            queueLimit: 0
        };

        pool = mysql.createPool(config);

        // Verify connection
        const connection = await pool.getConnection();
        console.log('[Database] ✅ Connected to MariaDB/MySQL!');
        connection.release();

        // Init Schema
        // Added external_link column as requested
        await pool.query(`
            CREATE TABLE IF NOT EXISTS tasks (
                id VARCHAR(36) PRIMARY KEY,
                name VARCHAR(255),
                status VARCHAR(50),
                cep VARCHAR(20),
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                finished_at DATETIME,
                input_file VARCHAR(255),
                output_file VARCHAR(255),
                log_file VARCHAR(255),
                tags JSON,
                position INT DEFAULT 0,
                external_link TEXT
            )
        `);

        // Migration for existing tables without new columns?
        // Simple check: describe tasks? Or just try adding column if missing.
        // For simplicity in this task scope, we assume CREATE IF NOT EXISTS works or manual migration.
        // But to be safe, let's try ALTER TABLE loosely.
        try {
            await pool.query("ALTER TABLE tasks ADD COLUMN external_link TEXT");
        } catch (e) { /* Ignore if exists */ }
        try {
            await pool.query("ALTER TABLE tasks ADD COLUMN tags JSON");
        } catch (e) { /* Ignore */ }
        try {
            await pool.query("ALTER TABLE tasks ADD COLUMN position INT DEFAULT 0");
        } catch (e) { /* Ignore */ }

    } catch (e) {
        console.error('[Database] ❌ Connection/Init failed:', e.message);
    }
}

async function getPool() {
    if (!pool) await initDB();
    return pool;
}

async function createTask(task) {
    const p = await getPool();
    if (!p) throw new Error("DB not ready");

    const [rows] = await p.query("SELECT MAX(position) as maxPos FROM tasks");
    const nextPos = (rows[0].maxPos || 0) + 1;

    // Added external_link
    const sql = `INSERT INTO tasks (id, name, status, cep, input_file, log_file, position, tags, external_link) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    await p.query(sql, [task.id, task.name, 'pending', task.cep, task.input_file, task.log_file, nextPos, '[]', task.external_link || null]);
    return task.id;
}

async function updateTaskStatus(id, status, outputFile = null) {
    const p = await getPool();
    if (!p) throw new Error("DB not ready");

    let sql = `UPDATE tasks SET status = ? WHERE id = ?`;
    let params = [status, id];

    if (status === 'completed' || status === 'failed') {
        sql = `UPDATE tasks SET status = ?, finished_at = NOW(), output_file = ? WHERE id = ?`;
        params = [status, outputFile, id];
    } else if (status === 'aborted') {
        sql = `UPDATE tasks SET status = ?, finished_at = NOW() WHERE id = ?`;
        params = [status, id];
    }

    await p.query(sql, params);
}

async function getTasks() {
    const p = await getPool();
    if (!p) return [];
    
    // Ordered by position ASC for Kanban priority
    const [rows] = await p.query("SELECT * FROM tasks WHERE status != 'archived' ORDER BY position ASC, created_at DESC");
    return rows;
}

async function getTaskById(id) {
    const p = await getPool();
    if (!p) return null;

    const [rows] = await p.query("SELECT * FROM tasks WHERE id = ?", [id]);
    return rows[0];
}

async function updateTaskPosition(id, position) {
    const p = await getPool();
    if (!p) throw new Error("DB not ready");
    await p.query("UPDATE tasks SET position = ? WHERE id = ?", [position, id]);
}

async function updateTaskTags(id, tags) {
    const p = await getPool();
    if (!p) throw new Error("DB not ready");
    const tagsStr = typeof tags === 'string' ? tags : JSON.stringify(tags);
    await p.query("UPDATE tasks SET tags = ? WHERE id = ?", [tagsStr, id]);
}

async function getNextPendingTask() {
    const p = await getPool();
    if (!p) return null;
    
    const [rows] = await p.query("SELECT * FROM tasks WHERE status = 'pending' ORDER BY position ASC LIMIT 1");
    return rows[0];
}

async function forceStartTask(id) {
    const p = await getPool();
    if (!p) throw new Error("DB not ready");
    
    // Set position to -1 to be top priority (if strict ordering)
    // And set status to pending? Or queued? 
    // The dispatcher picks 'pending'. So we set to 'pending' and pos -1.
    // If it was already pending, this boosts it. 
    // If it was queued but stuck? 
    await p.query("UPDATE tasks SET status = 'pending', position = -1 WHERE id = ?", [id]);
}

module.exports = { initDB, createTask, updateTaskStatus, getTasks, getTaskById, updateTaskPosition, updateTaskTags, getNextPendingTask, forceStartTask };
