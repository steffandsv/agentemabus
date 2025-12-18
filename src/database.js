const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');

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
                external_link TEXT,
                module_name VARCHAR(50)
            )
        `);

        // Users Schema
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                username VARCHAR(50) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                role ENUM('user', 'moderator', 'admin') DEFAULT 'user',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Check for default admin
        const [users] = await pool.query("SELECT * FROM users WHERE username = 'admin'");
        if (users.length === 0) {
            const hash = await bcrypt.hash('admin', 10);
            await pool.query("INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)", ['admin', hash, 'admin']);
            console.log('[Database] Default admin user created (admin/admin)');
        }

        // Migrations
        try {
            await pool.query("ALTER TABLE tasks ADD COLUMN external_link TEXT");
        } catch (e) { /* Ignore if exists */ }
        try {
            await pool.query("ALTER TABLE tasks ADD COLUMN tags JSON");
        } catch (e) { /* Ignore */ }
        try {
            await pool.query("ALTER TABLE tasks ADD COLUMN position INT DEFAULT 0");
        } catch (e) { /* Ignore */ }
        try {
            await pool.query("ALTER TABLE tasks ADD COLUMN module_name VARCHAR(50)");
        } catch (e) { /* Ignore */ }

    } catch (e) {
        console.error('[Database] ❌ Connection/Init failed:', e.message);
    }
}

async function getPool() {
    if (!pool) await initDB();
    return pool;
}

// --- USER FUNCTIONS ---
async function getUserByUsername(username) {
    const p = await getPool();
    if (!p) return null;
    const [rows] = await p.query("SELECT * FROM users WHERE username = ?", [username]);
    return rows[0];
}

async function getUserById(id) {
    const p = await getPool();
    if (!p) return null;
    const [rows] = await p.query("SELECT * FROM users WHERE id = ?", [id]);
    return rows[0];
}

async function createUser(username, password, role) {
    const p = await getPool();
    if (!p) throw new Error("DB not ready");
    const hash = await bcrypt.hash(password, 10);
    await p.query("INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)", [username, hash, role]);
}

async function getAllUsers() {
    const p = await getPool();
    if (!p) return [];
    const [rows] = await p.query("SELECT id, username, role, created_at FROM users");
    return rows;
}

async function deleteUser(id) {
    const p = await getPool();
    if (!p) return;
    await p.query("DELETE FROM users WHERE id = ?", [id]);
}

async function updateUserRole(id, role) {
    const p = await getPool();
    if (!p) return;
    await p.query("UPDATE users SET role = ? WHERE id = ?", [role, id]);
}


// --- TASK FUNCTIONS ---
async function createTask(task) {
    const p = await getPool();
    if (!p) throw new Error("DB not ready");

    const [rows] = await p.query("SELECT MAX(position) as maxPos FROM tasks");
    const nextPos = (rows[0].maxPos || 0) + 1;

    const sql = `INSERT INTO tasks (id, name, status, cep, input_file, log_file, position, tags, external_link, module_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    await p.query(sql, [
        task.id,
        task.name,
        'pending',
        task.cep,
        task.input_file,
        task.log_file,
        nextPos,
        '[]',
        task.external_link || null,
        task.module_name || 'gemini_meli'
    ]);
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

async function getTasks(showArchived = false) {
    const p = await getPool();
    if (!p) return [];
    
    let sql = "SELECT * FROM tasks WHERE status != 'archived' ORDER BY position ASC, created_at DESC";
    if (showArchived) {
        sql = "SELECT * FROM tasks WHERE status = 'archived' ORDER BY finished_at DESC";
    }

    const [rows] = await p.query(sql);
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
    await p.query("UPDATE tasks SET status = 'pending', position = -1 WHERE id = ?", [id]);
}

module.exports = {
    initDB,
    createTask,
    updateTaskStatus,
    getTasks,
    getTaskById,
    updateTaskPosition,
    updateTaskTags,
    getNextPendingTask,
    forceStartTask,
    getUserByUsername,
    getUserById,
    createUser,
    getAllUsers,
    deleteUser,
    updateUserRole
};
