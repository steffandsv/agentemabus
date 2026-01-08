const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');

let pool = null;

async function initDB() {
    if (pool) return;

    try {
        const config = {
            host: process.env.DB_HOST || 'srv466.hstgr.io',
            user: process.env.DB_USER || 'u225637494_fiomb',
            password: process.env.DB_PASS || '20SKDMasx',
            database: process.env.DB_DB || 'u225637494_fiomb',
            waitForConnections: true,
            connectionLimit: 10,
            queueLimit: 0,
            ssl: { rejectUnauthorized: false } // Often needed for external hosting
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
                module_name VARCHAR(50),
                group_id INT,
                user_id INT,
                cost_estimate INT DEFAULT 0
            )
        `);

        // --- USERS TABLE ---
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                username VARCHAR(50) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                role ENUM('user', 'moderator', 'admin') DEFAULT 'user',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                full_name VARCHAR(255),
                cpf VARCHAR(20),
                cnpj VARCHAR(20),
                current_credits INT DEFAULT 0
            )
        `);

        // --- GROUPS TABLE ---
        await pool.query(`
            CREATE TABLE IF NOT EXISTS groups (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                description TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // --- USER_GROUPS TABLE ---
        await pool.query(`
            CREATE TABLE IF NOT EXISTS user_groups (
                user_id INT NOT NULL,
                group_id INT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (user_id, group_id),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
            )
        `);

        // --- CREDITS LEDGER TABLE ---
        await pool.query(`
            CREATE TABLE IF NOT EXISTS credits_ledger (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT NOT NULL,
                amount INT NOT NULL,
                reason VARCHAR(255),
                task_id VARCHAR(36),
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);

        // --- TASK ITEMS TABLE ---
        await pool.query(`
            CREATE TABLE IF NOT EXISTS task_items (
                id INT AUTO_INCREMENT PRIMARY KEY,
                task_id VARCHAR(36) NOT NULL,
                original_id VARCHAR(50),
                description TEXT,
                max_price DECIMAL(10, 2),
                quantity INT,
                status VARCHAR(50) DEFAULT 'pending',
                is_unlocked BOOLEAN DEFAULT FALSE,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
            )
        `);

        // --- ITEM CANDIDATES TABLE ---
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
                gtin VARCHAR(50),
                manufacturer_part_number VARCHAR(100),
                enrichment_source VARCHAR(50),
                seller_reputation VARCHAR(50),
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (task_item_id) REFERENCES task_items(id) ON DELETE CASCADE
            )
        `);

        // --- TASK LOGS TABLE ---
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

        // --- TASK METADATA TABLE ---
        await pool.query(`
            CREATE TABLE IF NOT EXISTS task_metadata (
                id INT AUTO_INCREMENT PRIMARY KEY,
                task_id VARCHAR(36) NOT NULL,
                data JSON,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
            )
        `);

        // --- OPPORTUNITIES (ORACLE/RADAR) TABLE ---
        await pool.query(`
            CREATE TABLE IF NOT EXISTS opportunities (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT, -- Null for Admin/Radar, Set for User History
                title VARCHAR(255),
                municipality VARCHAR(255),
                metadata_json JSON, -- The Public Teaser
                locked_content_json JSON, -- The Private Analysis
                items_json JSON, -- Extracted Items for Sniper
                ipm_score INT DEFAULT 0,
                status VARCHAR(50) DEFAULT 'available', -- available, unlocked, archived
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);

        // --- SETTINGS TABLE ---
        await pool.query(`
            CREATE TABLE IF NOT EXISTS settings (
                setting_key VARCHAR(100) PRIMARY KEY,
                setting_value TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
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
        // Note: Using loop with individual try-catch to ensure one failure doesn't stop others
        const migrations = [
            "ALTER TABLE tasks ADD COLUMN external_link TEXT",
            "ALTER TABLE tasks ADD COLUMN tags JSON",
            "ALTER TABLE tasks ADD COLUMN position INT DEFAULT 0",
            "ALTER TABLE tasks ADD COLUMN module_name VARCHAR(50)",
            "ALTER TABLE tasks ADD COLUMN group_id INT",
            "ALTER TABLE tasks ADD COLUMN user_id INT",
            "ALTER TABLE tasks ADD COLUMN cost_estimate INT DEFAULT 0",
            "ALTER TABLE users ADD COLUMN full_name VARCHAR(255)",
            "ALTER TABLE users ADD COLUMN cpf VARCHAR(20)",
            "ALTER TABLE users ADD COLUMN cnpj VARCHAR(20)",
            "ALTER TABLE users ADD COLUMN current_credits INT DEFAULT 0",
            "ALTER TABLE task_items ADD COLUMN is_unlocked BOOLEAN DEFAULT FALSE"
        ];

        for (const sql of migrations) {
            try { await pool.query(sql); } catch (e) {
                // Ignore "duplicate column" errors
            }
        }

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

async function createUser(userData) {
    const p = await getPool();
    if (!p) throw new Error("DB not ready");
    const { username, password, role, full_name, cpf, cnpj } = userData;
    const hash = await bcrypt.hash(password, 10);
    await p.query(
        "INSERT INTO users (username, password_hash, role, full_name, cpf, cnpj, current_credits) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [username, hash, role || 'user', full_name, cpf, cnpj, 500]
    );
}

async function getAllUsers() {
    const p = await getPool();
    if (!p) return [];
    const [rows] = await p.query("SELECT id, username, role, created_at, full_name, current_credits FROM users");
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


// --- GROUP & CREDIT FUNCTIONS ---

async function createGroup(name, description) {
    const p = await getPool();
    if (!p) return;
    await p.query("INSERT INTO groups (name, description) VALUES (?, ?)", [name, description]);
}

async function getAllGroups() {
    const p = await getPool();
    if (!p) return [];
    const [rows] = await p.query("SELECT * FROM groups ORDER BY name ASC");
    return rows;
}

async function getUserGroups(userId) {
    const p = await getPool();
    if (!p) return [];
    const [rows] = await p.query(`
        SELECT g.*
        FROM groups g
        JOIN user_groups ug ON g.id = ug.group_id
        WHERE ug.user_id = ?
    `, [userId]);
    return rows;
}

async function addUserToGroup(userId, groupId) {
    const p = await getPool();
    if (!p) return;
    try {
        await p.query("INSERT INTO user_groups (user_id, group_id) VALUES (?, ?)", [userId, groupId]);
    } catch(e) {
        // Ignore duplicates
    }
}

async function removeUserFromGroup(userId, groupId) {
    const p = await getPool();
    if (!p) return;
    await p.query("DELETE FROM user_groups WHERE user_id = ? AND group_id = ?", [userId, groupId]);
}

async function addCredits(userId, amount, reason, taskId = null) {
    const p = await getPool();
    if (!p) throw new Error("DB not ready");

    const connection = await p.getConnection();
    try {
        await connection.beginTransaction();

        // 1. Insert Ledger
        await connection.query(
            "INSERT INTO credits_ledger (user_id, amount, reason, task_id) VALUES (?, ?, ?, ?)",
            [userId, amount, reason, taskId]
        );

        // 2. Update User Balance
        await connection.query(
            "UPDATE users SET current_credits = current_credits + ? WHERE id = ?",
            [amount, userId]
        );

        await connection.commit();
    } catch (e) {
        await connection.rollback();
        throw e;
    } finally {
        connection.release();
    }
}

async function getUserCredits(userId) {
    const p = await getPool();
    if (!p) return 0;
    const [rows] = await p.query("SELECT current_credits FROM users WHERE id = ?", [userId]);
    return rows[0] ? rows[0].current_credits : 0;
}


// --- TASK FUNCTIONS ---
async function createTask(task) {
    const p = await getPool();
    if (!p) throw new Error("DB not ready");

    const [rows] = await p.query("SELECT MAX(position) as maxPos FROM tasks");
    const nextPos = (rows[0].maxPos || 0) + 1;

    const sql = `INSERT INTO tasks (id, name, status, cep, input_file, log_file, position, tags, external_link, module_name, group_id, user_id, cost_estimate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
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
        task.module_name || 'gemini_meli',
        task.group_id || null,
        task.user_id || null,
        task.cost_estimate || 0
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

// Updated getTasks to support scoping
async function getTasksForUser(user, showArchived = false, limit = 100, offset = 0) {
    const p = await getPool();
    if (!p) return [];

    let statusSql = "status != 'archived'";
    if (showArchived) statusSql = "status = 'archived'";

    // Safe params
    limit = parseInt(limit) || 100;
    offset = parseInt(offset) || 0;

    if (user.role === 'admin') {
        // Admin sees all
        const sql = `SELECT * FROM tasks WHERE ${statusSql} ORDER BY position ASC, created_at DESC LIMIT ? OFFSET ?`;
        const [rows] = await p.query(sql, [limit, offset]);
        return rows;
    } else {
        // User sees tasks from their groups OR their own tasks
        // Get user groups
        const userGroups = await getUserGroups(user.id);
        const groupIds = userGroups.map(g => g.id);

        let whereClause = `(${statusSql}) AND (user_id = ?`;
        if (groupIds.length > 0) {
            whereClause += ` OR group_id IN (${groupIds.join(',')})`; // Safe int join
        }
        whereClause += `)`;

        const sql = `SELECT * FROM tasks WHERE ${whereClause} ORDER BY position ASC, created_at DESC LIMIT ? OFFSET ?`;
        const [rows] = await p.query(sql, [user.id, limit, offset]);
        return rows;
    }
}

async function getTasks(showArchived = false) {
    // Legacy/Internal use
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

async function getTaskItems(taskId) {
    const p = await getPool();
    if (!p) return [];
    const [rows] = await p.query("SELECT * FROM task_items WHERE task_id = ? ORDER BY id ASC", [taskId]);
    return rows;
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
        index === selectedIndex, // is_selected
        c.gtin || null,
        c.mpn || null,
        c.enrichment_source || null,
        c.seller_reputation || null
    ]);

    const sql = `INSERT INTO item_candidates (task_item_id, title, price, link, image_url, store, specs, risk_score, ai_reasoning, is_selected, gtin, manufacturer_part_number, enrichment_source, seller_reputation) VALUES ?`;
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
async function createTaskMetadata(taskId, data) {
    const p = await getPool();
    if (!p) return;
    try {
        await p.query("INSERT INTO task_metadata (task_id, data) VALUES (?, ?)", [taskId, JSON.stringify(data)]);
    } catch(e) {
        console.error("Failed to save metadata:", e);
    }
}

async function getTaskFullResults(taskId) {
    const p = await getPool();
    if (!p) return [];

    // Get Items
    const [items] = await p.query("SELECT * FROM task_items WHERE task_id = ?", [taskId]);

    // For each item, get candidates
    const results = [];
    for (const item of items) {
        const [candidates] = await p.query("SELECT * FROM item_candidates WHERE task_item_id = ?", [item.id]);

        const offers = candidates.map(c => ({
            title: c.title,
            totalPrice: parseFloat(c.price),
            link: c.link,
            image: c.image_url,
            store: c.store,
            specs: typeof c.specs === 'string' ? JSON.parse(c.specs) : c.specs,
            risk_score: c.risk_score,
            aiReasoning: c.ai_reasoning,
            brand_model: c.title
        }));

        const winnerIndex = candidates.findIndex(c => c.is_selected);

        results.push({
            id: item.original_id,
            db_id: item.id, // Internal ID for unlocking
            is_unlocked: item.is_unlocked,
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

async function getTaskMetadata(taskId) {
    const p = await getPool();
    if (!p) return null;
    const [rows] = await p.query("SELECT * FROM task_metadata WHERE task_id = ?", [taskId]);
    return rows[0];
}

async function updateTaskItemLockStatus(itemId, isUnlocked) {
    const p = await getPool();
    if (!p) throw new Error("DB not ready");
    await p.query("UPDATE task_items SET is_unlocked = ? WHERE id = ?", [isUnlocked, itemId]);
}

async function unlockAllTaskItems(taskId) {
    const p = await getPool();
    if (!p) throw new Error("DB not ready");
    await p.query("UPDATE task_items SET is_unlocked = TRUE WHERE task_id = ?", [taskId]);
}

// --- OPPORTUNITIES (RADAR/ORACLE) FUNCTIONS ---

async function createOpportunity(userId, data) {
    const p = await getPool();
    if (!p) throw new Error("DB not ready");

    // data expects: { title, municipality, metadata, locked_content, items, ipm_score }
    const sql = `INSERT INTO opportunities
        (user_id, title, municipality, metadata_json, locked_content_json, items_json, ipm_score)
        VALUES (?, ?, ?, ?, ?, ?, ?)`;

    await p.query(sql, [
        userId || null, // If null, it's global/radar
        data.title,
        data.municipality,
        JSON.stringify(data.metadata),
        JSON.stringify(data.locked_content),
        JSON.stringify(data.items),
        data.ipm_score || 0
    ]);
}

async function getRadarOpportunities() {
    const p = await getPool();
    if (!p) return [];
    // Where user_id is NULL (Admin/System generated)
    const [rows] = await p.query("SELECT * FROM opportunities WHERE user_id IS NULL ORDER BY created_at DESC");
    return rows;
}

async function getUserOpportunities(userId) {
    const p = await getPool();
    if (!p) return [];
    const [rows] = await p.query("SELECT * FROM opportunities WHERE user_id = ? ORDER BY created_at DESC", [userId]);
    return rows;
}

async function getOpportunityById(id) {
    const p = await getPool();
    if (!p) return null;
    const [rows] = await p.query("SELECT * FROM opportunities WHERE id = ?", [id]);
    return rows[0];
}

// --- SETTINGS FUNCTIONS ---
async function getSetting(key) {
    const p = await getPool();
    if (!p) return null;
    const [rows] = await p.query("SELECT setting_value FROM settings WHERE setting_key = ?", [key]);
    return rows[0] ? rows[0].setting_value : null;
}

async function setSetting(key, value) {
    const p = await getPool();
    if (!p) return;
    await p.query(`
        INSERT INTO settings (setting_key, setting_value)
        VALUES (?, ?)
        ON DUPLICATE KEY UPDATE setting_value = ?
    `, [key, value, value]);
}

module.exports = {
    initDB,
    createTask,
    updateTaskStatus,
    getTasks,
    getTasksForUser,
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
    createGroup,
    getAllGroups,
    getUserGroups,
    addUserToGroup,
    removeUserFromGroup,
    addCredits,
    getUserCredits,
    createTaskItems,
    getTaskItem,
    getTaskItems,
    saveCandidates,
    logTaskMessage,
    getTaskLogs,
    getTaskFullResults,
    createTaskMetadata,
    getTaskMetadata,
    updateTaskItemLockStatus,
    unlockAllTaskItems,
    createOpportunity,
    getRadarOpportunities,
    getUserOpportunities,
    getOpportunityById,
    getSetting,
    setSetting
};
