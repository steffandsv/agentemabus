const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const bcrypt = require('bcrypt');
const path = require('path');

let db = null;

async function getDB() {
    if (db) return db;
    db = await open({
        filename: path.join(__dirname, '../tasks.db'),
        driver: sqlite3.Database
    });
    return db;
}

async function initDB() {
    try {
        const db = await getDB();
        console.log('[Database] ✅ Connected to SQLite!');

        // --- TASKS TABLE ---
        await db.exec(`
            CREATE TABLE IF NOT EXISTS tasks (
                id TEXT PRIMARY KEY,
                name TEXT,
                status TEXT,
                cep TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                finished_at DATETIME,
                input_file TEXT,
                output_file TEXT,
                log_file TEXT,
                tags JSON,
                position INTEGER DEFAULT 0,
                external_link TEXT,
                module_name TEXT,
                group_id INTEGER,
                user_id INTEGER,
                cost_estimate INTEGER DEFAULT 0
            )
        `);

        // --- USERS TABLE ---
        await db.exec(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                role TEXT DEFAULT 'user',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                full_name TEXT,
                cpf TEXT,
                cnpj TEXT,
                current_credits INTEGER DEFAULT 0
            )
        `);

        // --- GROUPS TABLE ---
        await db.exec(`
            CREATE TABLE IF NOT EXISTS groups (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                description TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // --- USER_GROUPS TABLE ---
        await db.exec(`
            CREATE TABLE IF NOT EXISTS user_groups (
                user_id INTEGER NOT NULL,
                group_id INTEGER NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (user_id, group_id),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
            )
        `);

        // --- CREDITS LEDGER TABLE ---
        await db.exec(`
            CREATE TABLE IF NOT EXISTS credits_ledger (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                amount INTEGER NOT NULL,
                reason TEXT,
                task_id TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);

        // --- TASK ITEMS TABLE ---
        await db.exec(`
            CREATE TABLE IF NOT EXISTS task_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id TEXT NOT NULL,
                original_id TEXT,
                description TEXT,
                max_price DECIMAL(10, 2),
                quantity INTEGER,
                status TEXT DEFAULT 'pending',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
            )
        `);

        // --- ITEM CANDIDATES TABLE ---
        await db.exec(`
            CREATE TABLE IF NOT EXISTS item_candidates (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                task_item_id INTEGER NOT NULL,
                title TEXT,
                price DECIMAL(10, 2),
                link TEXT,
                image_url TEXT,
                store TEXT,
                specs JSON,
                risk_score TEXT,
                ai_reasoning TEXT,
                is_selected BOOLEAN DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (task_item_id) REFERENCES task_items(id) ON DELETE CASCADE
            )
        `);

        // --- TASK LOGS TABLE ---
        await db.exec(`
            CREATE TABLE IF NOT EXISTS task_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id TEXT NOT NULL,
                message TEXT,
                level TEXT DEFAULT 'info',
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
            )
        `);

        // Check for default admin
        const admin = await db.get("SELECT * FROM users WHERE username = 'admin'");
        if (!admin) {
            const hash = await bcrypt.hash('admin', 10);
            await db.run("INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)", ['admin', hash, 'admin']);
            console.log('[Database] Default admin user created (admin/admin)');
        }

        // Migrations (Safe to run multiple times)
        const columnsToCheck = [
            { table: 'tasks', col: 'external_link', type: 'TEXT' },
            { table: 'tasks', col: 'tags', type: 'JSON' },
            { table: 'tasks', col: 'position', type: 'INTEGER DEFAULT 0' },
            { table: 'tasks', col: 'module_name', type: 'TEXT' },
            { table: 'tasks', col: 'group_id', type: 'INTEGER' },
            { table: 'tasks', col: 'user_id', type: 'INTEGER' },
            { table: 'tasks', col: 'cost_estimate', type: 'INTEGER DEFAULT 0' },
            { table: 'users', col: 'full_name', type: 'TEXT' },
            { table: 'users', col: 'cpf', type: 'TEXT' },
            { table: 'users', col: 'cnpj', type: 'TEXT' },
            { table: 'users', col: 'current_credits', type: 'INTEGER DEFAULT 0' }
        ];

        for (const check of columnsToCheck) {
            try {
                // SQLite doesn't have "IF NOT EXISTS" for columns, so we try and ignore error
                await db.run(`ALTER TABLE ${check.table} ADD COLUMN ${check.col} ${check.type}`);
            } catch (e) {
                // Ignore "duplicate column" errors
            }
        }

    } catch (e) {
        console.error('[Database] ❌ Connection/Init failed:', e.message);
    }
}

// --- USER FUNCTIONS ---
async function getUserByUsername(username) {
    const db = await getDB();
    return await db.get("SELECT * FROM users WHERE username = ?", [username]);
}

async function getUserById(id) {
    const db = await getDB();
    return await db.get("SELECT * FROM users WHERE id = ?", [id]);
}

async function createUser(userData) {
    const db = await getDB();
    const { username, password, role, full_name, cpf, cnpj } = userData;
    const hash = await bcrypt.hash(password, 10);
    await db.run(
        "INSERT INTO users (username, password_hash, role, full_name, cpf, cnpj) VALUES (?, ?, ?, ?, ?, ?)",
        [username, hash, role || 'user', full_name, cpf, cnpj]
    );
}

async function getAllUsers() {
    const db = await getDB();
    return await db.all("SELECT id, username, role, created_at, full_name, current_credits FROM users");
}

async function deleteUser(id) {
    const db = await getDB();
    await db.run("DELETE FROM users WHERE id = ?", [id]);
}

async function updateUserRole(id, role) {
    const db = await getDB();
    await db.run("UPDATE users SET role = ? WHERE id = ?", [role, id]);
}


// --- GROUP & CREDIT FUNCTIONS ---

async function createGroup(name, description) {
    const db = await getDB();
    await db.run("INSERT INTO groups (name, description) VALUES (?, ?)", [name, description]);
}

async function getAllGroups() {
    const db = await getDB();
    return await db.all("SELECT * FROM groups ORDER BY name ASC");
}

async function getUserGroups(userId) {
    const db = await getDB();
    return await db.all(`
        SELECT g.*
        FROM groups g
        JOIN user_groups ug ON g.id = ug.group_id
        WHERE ug.user_id = ?
    `, [userId]);
}

async function addUserToGroup(userId, groupId) {
    const db = await getDB();
    try {
        await db.run("INSERT INTO user_groups (user_id, group_id) VALUES (?, ?)", [userId, groupId]);
    } catch(e) {
        // Ignore duplicates
    }
}

async function removeUserFromGroup(userId, groupId) {
    const db = await getDB();
    await db.run("DELETE FROM user_groups WHERE user_id = ? AND group_id = ?", [userId, groupId]);
}

async function addCredits(userId, amount, reason, taskId = null) {
    const db = await getDB();

    // SQLite transactions
    await db.exec('BEGIN TRANSACTION');
    try {
        // 1. Insert Ledger
        await db.run(
            "INSERT INTO credits_ledger (user_id, amount, reason, task_id) VALUES (?, ?, ?, ?)",
            [userId, amount, reason, taskId]
        );

        // 2. Update User Balance
        await db.run(
            "UPDATE users SET current_credits = current_credits + ? WHERE id = ?",
            [amount, userId]
        );

        await db.exec('COMMIT');
    } catch (e) {
        await db.exec('ROLLBACK');
        throw e;
    }
}

async function getUserCredits(userId) {
    const db = await getDB();
    const row = await db.get("SELECT current_credits FROM users WHERE id = ?", [userId]);
    return row ? row.current_credits : 0;
}


// --- TASK FUNCTIONS ---
async function createTask(task) {
    const db = await getDB();

    const row = await db.get("SELECT MAX(position) as maxPos FROM tasks");
    const nextPos = (row ? row.maxPos : 0) + 1;

    await db.run(`INSERT INTO tasks (id, name, status, cep, input_file, log_file, position, tags, external_link, module_name, group_id, user_id, cost_estimate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
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
    const db = await getDB();
    let sql = `UPDATE tasks SET status = ? WHERE id = ?`;
    let params = [status, id];

    if (status === 'completed' || status === 'failed') {
        sql = `UPDATE tasks SET status = ?, finished_at = datetime('now', 'localtime'), output_file = ? WHERE id = ?`;
        params = [status, outputFile, id];
    } else if (status === 'aborted') {
        sql = `UPDATE tasks SET status = ?, finished_at = datetime('now', 'localtime') WHERE id = ?`;
        params = [status, id];
    }

    await db.run(sql, params);
}

// Updated getTasks to support scoping
async function getTasksForUser(user, showArchived = false) {
    const db = await getDB();
    
    let statusSql = "status != 'archived'";
    if (showArchived) statusSql = "status = 'archived'";

    if (user.role === 'admin') {
        return await db.all(`SELECT * FROM tasks WHERE ${statusSql} ORDER BY position ASC, created_at DESC`);
    } else {
        const userGroups = await getUserGroups(user.id);
        const groupIds = userGroups.map(g => g.id);

        // SQLite doesn't support arrays in params easily for IN clause, manual construction
        let whereClause = `(${statusSql}) AND (user_id = ?`;

        if (groupIds.length > 0) {
            const placeholders = groupIds.map(() => '?').join(',');
            whereClause += ` OR group_id IN (${placeholders})`;
        }
        whereClause += `)`;

        const params = [user.id, ...groupIds];
        return await db.all(`SELECT * FROM tasks WHERE ${whereClause} ORDER BY position ASC, created_at DESC`, params);
    }
}

async function getTasks(showArchived = false) {
    const db = await getDB();
    let sql = "SELECT * FROM tasks WHERE status != 'archived' ORDER BY position ASC, created_at DESC";
    if (showArchived) {
        sql = "SELECT * FROM tasks WHERE status = 'archived' ORDER BY finished_at DESC";
    }
    return await db.all(sql);
}

async function getTaskById(id) {
    const db = await getDB();
    return await db.get("SELECT * FROM tasks WHERE id = ?", [id]);
}

async function updateTaskPosition(id, position) {
    const db = await getDB();
    await db.run("UPDATE tasks SET position = ? WHERE id = ?", [position, id]);
}

async function updateTaskTags(id, tags) {
    const db = await getDB();
    const tagsStr = typeof tags === 'string' ? tags : JSON.stringify(tags);
    await db.run("UPDATE tasks SET tags = ? WHERE id = ?", [tagsStr, id]);
}

async function getNextPendingTask() {
    const db = await getDB();
    return await db.get("SELECT * FROM tasks WHERE status = 'pending' ORDER BY position ASC LIMIT 1");
}

async function forceStartTask(id) {
    const db = await getDB();
    await db.run("UPDATE tasks SET status = 'pending', position = -1 WHERE id = ?", [id]);
}

// --- NEW DB PERSISTENCE FUNCTIONS ---

async function createTaskItems(taskId, items) {
    const db = await getDB();

    // SQLite bulk insert
    // items: array of { id, description, valor_venda, quantidade }
    // We can loop or build a big query. Loop is safer for SQLite limit.
    await db.exec('BEGIN TRANSACTION');
    try {
        const stmt = await db.prepare("INSERT INTO task_items (task_id, original_id, description, max_price, quantity) VALUES (?, ?, ?, ?, ?)");
        for (const i of items) {
            await stmt.run(
                taskId,
                i.ID || i.id,
                i.Descricao || i.description || i.Description,
                i.valor_venda,
                i.quantidade
            );
        }
        await stmt.finalize();
        await db.exec('COMMIT');
    } catch(e) {
        await db.exec('ROLLBACK');
        console.error("Failed to insert items:", e);
    }
}

async function getTaskItem(taskId, originalId) {
    const db = await getDB();
    return await db.get("SELECT * FROM task_items WHERE task_id = ? AND original_id = ?", [taskId, originalId]);
}

async function saveCandidates(taskItemId, candidates, selectedIndex) {
    const db = await getDB();
    if (!taskItemId || !candidates || candidates.length === 0) return;

    await db.exec('BEGIN TRANSACTION');
    try {
        const stmt = await db.prepare("INSERT INTO item_candidates (task_item_id, title, price, link, image_url, store, specs, risk_score, ai_reasoning, is_selected) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
        for (let index = 0; index < candidates.length; index++) {
            const c = candidates[index];
            await stmt.run(
                taskItemId,
                c.title || c.name || 'N/A',
                c.totalPrice || c.price || 0,
                c.link,
                c.image || c.thumbnail || null,
                c.store || 'N/A',
                JSON.stringify(c.specs || {}),
                c.risk_score || '-',
                c.aiReasoning || c.reasoning || '-',
                index === selectedIndex ? 1 : 0
            );
        }
        await stmt.finalize();

        // Update item status
        await db.run("UPDATE task_items SET status = 'done' WHERE id = ?", [taskItemId]);

        await db.exec('COMMIT');
    } catch (e) {
        await db.exec('ROLLBACK');
        console.error("Failed to save candidates:", e);
    }
}

async function logTaskMessage(taskId, message, level = 'info') {
    const db = await getDB();
    try {
        await db.run("INSERT INTO task_logs (task_id, message, level) VALUES (?, ?, ?)", [taskId, message, level]);
    } catch(e) {
        console.error("Failed to log to DB:", e);
    }
}

async function getTaskLogs(taskId) {
    const db = await getDB();
    return await db.all("SELECT * FROM task_logs WHERE task_id = ? ORDER BY timestamp ASC", [taskId]);
}

async function getTaskFullResults(taskId) {
    const db = await getDB();
    const items = await db.all("SELECT * FROM task_items WHERE task_id = ?", [taskId]);

    const results = [];
    for (const item of items) {
        const candidates = await db.all("SELECT * FROM item_candidates WHERE task_item_id = ?", [item.id]);

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
            description: item.description,
            valor_venda: parseFloat(item.max_price),
            quantidade: item.quantity,
            offers: offers,
            winnerIndex: winnerIndex
        });
    }

    results.sort((a, b) => parseInt(a.id) - parseInt(b.id));
    return results;
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
    saveCandidates,
    logTaskMessage,
    getTaskLogs,
    getTaskFullResults
};
