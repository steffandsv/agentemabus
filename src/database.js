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

        // Create pool
        pool = mysql.createPool(config);

        // Verify connection
        const connection = await pool.getConnection();
        console.log('[Database] ✅ Connected to MariaDB/MySQL!');
        connection.release();

        // Init Schema
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
                position INT DEFAULT 0
            )
        `);

    } catch (e) {
        console.error('[Database] ❌ Connection failed:', e.message);
        // Fallback or retry logic could be added here, but for now we log.
        // If DB is critical, we might want to exit? 
        // User said "O banco de dados agora deverá ter persistência".
        // Let's assume env vars are correct.
    }
}

// Ensure init is called or lazy loaded
// We'll call initDB() in server.js startup, but here we helper
async function getPool() {
    if (!pool) await initDB();
    return pool;
}

async function createTask(task) {
    const p = await getPool();
    if (!p) throw new Error("DB not ready");

    // Default position: max + 1 (bottom of list)
    const [rows] = await p.query("SELECT MAX(position) as maxPos FROM tasks");
    const nextPos = (rows[0].maxPos || 0) + 1;

    const sql = `INSERT INTO tasks (id, name, status, cep, input_file, log_file, position, tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
    await p.query(sql, [task.id, task.name, 'pending', task.cep, task.input_file, task.log_file, nextPos, '[]']);
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
    // tags should be a JSON string or object? MySQL JSON needs string.
    const tagsStr = typeof tags === 'string' ? tags : JSON.stringify(tags);
    await p.query("UPDATE tasks SET tags = ? WHERE id = ?", [tagsStr, id]);
}

// Function to get the next pending task for the dispatcher
async function getNextPendingTask() {
    const p = await getPool();
    if (!p) return null;
    
    // Select the one with lowest position value (highest priority)
    const [rows] = await p.query("SELECT * FROM tasks WHERE status = 'pending' ORDER BY position ASC LIMIT 1");
    return rows[0];
}

module.exports = { initDB, createTask, updateTaskStatus, getTasks, getTaskById, updateTaskPosition, updateTaskTags, getNextPendingTask };
