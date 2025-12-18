const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const session = require('express-session');
const bcrypt = require('bcrypt');
const flash = require('connect-flash');
const {
    initDB,
    createTask,
    getTasks,
    getTaskById,
    updateTaskPosition,
    updateTaskTags,
    forceStartTask,
    getUserByUsername,
    getUserById,
    createUser,
    getAllUsers,
    deleteUser,
    updateUserRole,
    updateTaskStatus,
    getTaskLogs
} = require('./src/database');
const { startWorker } = require('./src/worker');
const { generateExcelBuffer } = require('./src/export');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);
const upload = multer({ dest: 'uploads/' });

// Ensure dirs
['uploads', 'outputs', 'logs', 'public'].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
});

// Template
const templatePath = path.join(__dirname, 'public', 'template.csv');
if (!fs.existsSync(templatePath)) {
    fs.writeFileSync(templatePath, 'ID;Descricao;valor_venda;quantidade\n1;Notebook;3000;1');
}

// Discover Modules
function getModules() {
    const modulesDir = path.join(__dirname, 'modules');
    if (!fs.existsSync(modulesDir)) return [];
    return fs.readdirSync(modulesDir).filter(f => fs.statSync(path.join(modulesDir, f)).isDirectory());
}

// Initialize DB (MySQL now)
initDB().then(() => {
    // Start Worker Polling Loop
    startWorker();
}).catch(e => console.error("DB Init Failed:", e));

app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json()); 

// --- AUTH CONFIGURATION ---
app.use(session({
    secret: process.env.SESSION_SECRET || 'agente-mabus-secret-key-12345',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false } // Set to true if behind https proxy
}));

app.use(flash());

// Make user available to all views
app.use(async (req, res, next) => {
    res.locals.user = req.session.userId ? await getUserById(req.session.userId) : null;
    res.locals.error = req.flash('error');
    res.locals.success = req.flash('success');
    // If user is deleted but session exists, clear session
    if (req.session.userId && !res.locals.user) {
        req.session.destroy();
    }
    next();
});

// Auth Middlewares
const isAuthenticated = (req, res, next) => {
    if (req.session.userId) return next();
    req.flash('error', 'Você precisa estar logado.');
    res.redirect('/login');
};

const isModeratorOrAdmin = async (req, res, next) => {
    if (!req.session.userId) return res.redirect('/login');
    const user = await getUserById(req.session.userId);
    if (user && (user.role === 'moderator' || user.role === 'admin')) return next();
    req.flash('error', 'Acesso negado.');
    res.redirect('/');
};

const isAdmin = async (req, res, next) => {
    if (!req.session.userId) return res.redirect('/login');
    const user = await getUserById(req.session.userId);
    if (user && user.role === 'admin') return next();
    req.flash('error', 'Acesso negado. Apenas administradores.');
    res.redirect('/');
};


// --- ROUTES ---

// Public Dashboard (Wait, everyone can see logs? Yes. But dashboard shows tasks. OK.)
app.get('/', async (req, res) => {
    try {
        const showArchived = req.query.show_archived === 'true';
        const tasks = await getTasks(showArchived);
        res.render('index', { tasks, showArchived });
    } catch (e) {
        res.status(500).send(e.message);
    }
});

// Login Routes
app.get('/login', (req, res) => {
    res.render('login');
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const user = await getUserByUsername(username);
    if (user && await bcrypt.compare(password, user.password_hash)) {
        req.session.userId = user.id;
        res.redirect('/');
    } else {
        req.flash('error', 'Credenciais inválidas.');
        res.redirect('/login');
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});


// Task Management (Restricted)
app.get('/create', isModeratorOrAdmin, (req, res) => {
    const modules = getModules();
    res.render('create', { modules });
});

app.post('/create', isModeratorOrAdmin, upload.single('csvFile'), async (req, res) => {
    const { name, cep, csvText, moduleName, external_link } = req.body;
    let filePath = req.file ? req.file.path : null;

    if (!filePath && csvText && csvText.trim().length > 0) {
        const fileName = `paste_${Date.now()}.csv`;
        filePath = path.join('uploads', fileName);
        fs.writeFileSync(filePath, csvText);
    }

    if (!filePath || !name || !cep) {
        return res.status(400).send('Dados incompletos.');
    }

    const taskId = uuidv4();
    const task = {
        id: taskId,
        name,
        cep,
        input_file: filePath,
        log_file: path.join('logs', `${taskId}.txt`),
        external_link: external_link,
        module_name: moduleName
    };

    try {
        await createTask(task);
        res.redirect('/');
    } catch (e) {
        res.status(500).send(e.message);
    }
});

// API endpoints (Some restricted?)
app.post('/api/tasks/reorder', isModeratorOrAdmin, async (req, res) => {
    if (req.body.orderedIds && Array.isArray(req.body.orderedIds)) {
        try {
            const promises = req.body.orderedIds.map((tid, index) => updateTaskPosition(tid, index));
            await Promise.all(promises);
            res.json({ success: true });
        } catch(e) {
            res.status(500).json({ error: e.message });
        }
    } else {
        res.status(400).json({ error: "Invalid data" });
    }
});

app.post('/api/tasks/:id/tags', isModeratorOrAdmin, async (req, res) => {
    const { tags } = req.body; 
    try {
        await updateTaskTags(req.params.id, tags);
        res.json({ success: true });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

// View Detail - Public? Or auth? "todos poderão ver o log".
// Detail page shows logs. So public.
app.get('/task/:id', async (req, res) => {
    try {
        const task = await getTaskById(req.params.id);
        if (!task) return res.status(404).send('Task not found');
        res.render('detail', { task });
    } catch (e) {
        res.status(500).send(e.message);
    }
});

// Logs API - Public (Now fetches from DB)
app.get('/api/logs/:id', async (req, res) => {
    try {
        const logs = await getTaskLogs(req.params.id);
        // Format as plain text to maintain compatibility with frontend viewer
        const text = logs.map(l => l.message).join('\n'); // Time already in message or re-add?
        // Worker logger format: `[Time] Msg`. DB stores `message` which includes timestamp?
        // No, `logTaskMessage` stores raw msg. Worker logger PREPENDS time.
        // Wait, `Logger.log` line 25: `const line = [${timestamp}] ${msg}`.
        // `logTaskMessage` is called with `msg`. So DB has RAW message without timestamp?
        // Let's check worker.js: `logTaskMessage(this.taskId, msg, 'info');`
        // msg passed to `this.log` DOES NOT have timestamp. Timestamp is added in `line`.
        // So DB has raw message.
        // We should format it here.

        const formatted = logs.map(l => {
             const time = new Date(l.timestamp).toLocaleTimeString('pt-BR');
             return `[${time}] ${l.message}`;
        }).join('\n');

        res.send(formatted);
    } catch (e) {
        res.status(500).send('Error fetching logs');
    }
});

// Download - Authenticated (User, Mod, Admin)
// Now generates from DB on-the-fly
app.get('/download/:id', isAuthenticated, async (req, res) => {
    try {
        const task = await getTaskById(req.params.id);
        if (!task) return res.status(404).send('Task not found');

        const buffer = await generateExcelBuffer(req.params.id);
        if (!buffer) return res.status(404).send('No results found to generate Excel.');

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=resultado_${task.id}.xlsx`);
        res.send(buffer);

    } catch (e) {
        console.error(e);
        res.status(500).send(e.message);
    }
});

// Force Start - Mod/Admin
app.post('/task/:id/force-start', isModeratorOrAdmin, async (req, res) => {
    const taskId = req.params.id;
    try {
        await forceStartTask(taskId);
        res.redirect('/');
    } catch (e) {
        res.status(500).send(e.message);
    }
});

// Actions (Archive: User/Mod/Admin. Abort: Mod/Admin)
app.post('/task/:id/action', isAuthenticated, async (req, res) => {
    const { action } = req.body;
    const taskId = req.params.id;
    const user = res.locals.user;

    try {
        const task = await getTaskById(taskId);
        if (!task) return res.status(404).send('Task not found');

        if (action === 'abort') {
            if (user.role === 'moderator' || user.role === 'admin') {
                await updateTaskStatus(taskId, 'aborted');
            } else {
                return res.status(403).send('Unauthorized');
            }
        } else if (action === 'archive') {
             // Everyone (authenticated) can archive
             await updateTaskStatus(taskId, 'archived');
        } else if (action === 'unarchive') {
             // Everyone can unarchive? Assuming yes for simplicity or mirror archive permission.
             // If archived, move back to pending? Or just remove 'archived' status (wait, schema stores status).
             // If unarchived, where does it go? Probably 'pending' or 'completed' depending on finished_at?
             // Simplest: set to 'pending' to restart? Or just 'completed'?
             // If it was completed, it should go back to completed.
             // If failed, back to failed.
             // We need to know previous status. We don't store it.
             // Let's assume unarchive -> 'pending' (restart) or check finished_at.
             // Actually, usually Archive is just a filter.
             // "desarquivar cards".
             // Let's set it to 'pending' so it can be re-run or just viewed?
             // If the user wants to re-run, they force start.
             // Let's just set it to 'failed' or 'completed' based on if output exists?
             // Safe bet: Set to 'pending' effectively resets it.
             // Or set to 'completed' if output file exists.
             if (task.output_file) {
                 await updateTaskStatus(taskId, 'completed', task.output_file);
             } else {
                 await updateTaskStatus(taskId, 'pending');
             }
        }

        res.redirect('/');
    } catch (e) {
        res.status(500).send(e.message);
    }
});

// Admin User Management
app.get('/admin/users', isAdmin, async (req, res) => {
    const users = await getAllUsers();
    res.render('admin_users', { users });
});

app.post('/admin/users', isAdmin, async (req, res) => {
    const { username, password, role } = req.body;
    try {
        await createUser(username, password, role);
        req.flash('success', 'Usuário criado com sucesso.');
    } catch (e) {
        req.flash('error', 'Erro ao criar usuário (possível duplicata).');
    }
    res.redirect('/admin/users');
});

app.post('/admin/users/delete', isAdmin, async (req, res) => {
    const { id } = req.body;
    if (id) await deleteUser(id);
    res.redirect('/admin/users');
});

app.post('/admin/users/role', isAdmin, async (req, res) => {
    const { id, role } = req.body;
    if (id && role) await updateUserRole(id, role);
    res.redirect('/admin/users');
});

app.get('/download-template', (req, res) => {
    res.download(path.join(__dirname, 'public', 'template.csv'), 'modelo_importacao.csv');
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
