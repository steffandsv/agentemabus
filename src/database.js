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

        // --- TASKS TABLE ---
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

        // --- USERS TABLE ---
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                username VARCHAR(50) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                role ENUM('user', 'moderator', 'admin') DEFAULT 'user',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // --- TASK ITEMS TABLE ---
        // Stores the individual items requested in the CSV
        await pool.query(`
            CREATE TABLE IF NOT EXISTS task_items (
                id INT AUTO_INCREMENT PRIMARY KEY,
                task_id VARCHAR(36) NOT NULL,
                original_id VARCHAR(50),
                description TEXT,
                max_price DECIMAL(10, 2),
                quantity INT,
                status VARCHAR(50) DEFAULT 'pending',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
            )
        `);

        // --- ITEM CANDIDATES TABLE ---
        // Stores all offers found for a specific item
        await pool.query(`
            CREATE TABLE IF NOT EXISTS item_candidates (
                id INT AUTO_INCREMENT PRIMARY KEY,
                task_item_id INT NOT NULL,
                title VARCHAR(255),
                price DECIMAL(10, 2),
                link TEXT,
                image_url TEXT,
                store VARCHAR(100),
                specs JSON,
                risk_score VARCHAR(50),
                ai_reasoning TEXT,
                is_selected BOOLEAN DEFAULT FALSE,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (task_item_id) REFERENCES task_items(id) ON DELETE CASCADE
            )
        `);

        // --- TASK LOGS TABLE ---
        // Stores logs in DB to avoid file loss
        await pool.query(`
            CREATE TABLE IF NOT EXISTS task_logs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                task_id VARCHAR(36) NOT NULL,
                message TEXT,
                level VARCHAR(20) DEFAULT 'info',
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
            )
        `);

        // Check for default admin
        const [users] = await pool.query("SELECT * FROM users WHERE username = 'admin'");
        if (users.length === 0) {
            const hash = await bcrypt.hash('admin', 10);
            await pool.query("INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)", ['admin', hash, 'admin']);
            console.log('[Database] Default admin user created (admin/admin)');
        }

        // Migrations (Safe to run multiple times)
        try { await pool.query("ALTER TABLE tasks ADD COLUMN external_link TEXT"); } catch (e) {}
        try { await pool.query("ALTER TABLE tasks ADD COLUMN tags JSON"); } catch (e) {}
        try { await pool.query("ALTER TABLE tasks ADD COLUMN position INT DEFAULT 0"); } catch (e) {}
        try { await pool.query("ALTER TABLE tasks ADD COLUMN module_name VARCHAR(50)"); } catch (e) {}

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

// --- NEW DB PERSISTENCE FUNCTIONS ---

async function createTaskItems(taskId, items) {
    const p = await getPool();
    if (!p) return;
    // items: array of { id, description, valor_venda, quantidade }
    const values = items.map(i => [
        taskId,
        i.ID || i.id,
        i.Descricao || i.description || i.Description,
        i.valor_venda,
        i.quantidade
    ]);

    if (values.length === 0) return;

    const sql = `INSERT INTO task_items (task_id, original_id, description, max_price, quantity) VALUES ?`;
    await p.query(sql, [values]);
}

async function getTaskItem(taskId, originalId) {
    const p = await getPool();
    const [rows] = await p.query("SELECT * FROM task_items WHERE task_id = ? AND original_id = ?", [taskId, originalId]);
    return rows[0];
}

async function saveCandidates(taskItemId, candidates, selectedIndex) {
    const p = await getPool();
    if (!p || !taskItemId) return;
    if (!candidates || candidates.length === 0) return;

    const values = candidates.map((c, index) => [
        taskItemId,
        c.title || c.name || 'N/A',
        c.totalPrice || c.price || 0,
        c.link,
        c.image || c.thumbnail || null,
        c.store || 'N/A',
        JSON.stringify(c.specs || {}),
        c.risk_score || '-',
        c.aiReasoning || c.reasoning || '-',
        index === selectedIndex // is_selected
    ]);

    const sql = `INSERT INTO item_candidates (task_item_id, title, price, link, image_url, store, specs, risk_score, ai_reasoning, is_selected) VALUES ?`;
    await p.query(sql, [values]);

    // Update item status
    await p.query("UPDATE task_items SET status = 'done' WHERE id = ?", [taskItemId]);
}

async function logTaskMessage(taskId, message, level = 'info') {
    const p = await getPool();
    if (!p) return;
    try {
        await p.query("INSERT INTO task_logs (task_id, message, level) VALUES (?, ?, ?)", [taskId, message, level]);
    } catch(e) {
        console.error("Failed to log to DB:", e);
    }
}

async function getTaskLogs(taskId) {
    const p = await getPool();
    if (!p) return [];
    const [rows] = await p.query("SELECT * FROM task_logs WHERE task_id = ? ORDER BY timestamp ASC", [taskId]);
    return rows;
}

// Fetch Full Results for Excel Generation
async function getTaskFullResults(taskId) {
    const p = await getPool();
    if (!p) return [];

    // Get Items
    const [items] = await p.query("SELECT * FROM task_items WHERE task_id = ?", [taskId]);

    // For each item, get candidates
    const results = [];
    for (const item of items) {
        const [candidates] = await p.query("SELECT * FROM item_candidates WHERE task_item_id = ?", [item.id]);

        // Reconstruct the object structure expected by writeOutput logic
        // logic expects: { id, description, valor_venda, quantidade, offers: [], winnerIndex: X }
        // We stored is_selected in DB.

        const offers = candidates.map(c => ({
            title: c.title,
            totalPrice: parseFloat(c.price),
            link: c.link,
            image: c.image_url,
            store: c.store,
            specs: typeof c.specs === 'string' ? JSON.parse(c.specs) : c.specs,
            risk_score: c.risk_score,
            aiReasoning: c.ai_reasoning,
            // Re-add properties needed for Excel logic?
            brand_model: c.title // Fallback
        }));

        const winnerIndex = candidates.findIndex(c => c.is_selected);

        results.push({
            id: item.original_id,
            description: item.description,
            valor_venda: parseFloat(item.max_price),
            quantidade: item.quantity,
            offers: offers,
            winnerIndex: winnerIndex
        });
    }

    // Sort by ID to maintain order
    results.sort((a, b) => parseInt(a.id) - parseInt(b.id));
    return results;
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
    updateUserRole,
    // New
    createTaskItems,
    getTaskItem,
    saveCandidates,
    logTaskMessage,
    getTaskLogs,
    getTaskFullResults
};
