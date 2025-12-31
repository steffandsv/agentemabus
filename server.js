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
    getTasksForUser,
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
    getTaskLogs,
    createGroup,
    getAllGroups,
    getUserGroups,
    addUserToGroup,
    addCredits
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
    // Deprecated role check, treating as Admin for legacy routes or strict admin
    if (!req.session.userId) return res.redirect('/login');
    const user = await getUserById(req.session.userId);
    if (user && user.role === 'admin') return next();
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
        // Use Scoped Visibility
        let tasks = [];
        if (req.session.userId) {
            const user = await getUserById(req.session.userId);
            if (user) {
                tasks = await getTasksForUser(user, showArchived);
            }
        } else {
             // Public view? Or force login?
             // Prompt says: "O grupo determinará quais cards ele pode ver".
             // This implies if not logged in, you see nothing or public tasks?
             // Existing app was public. Let's restrict to logged in or show nothing/demo.
             // If "SaaS", usually dashboard is empty or login required.
             // Let's redirect to login if not logged in, OR show empty list.
             // Existing code allowed public view. Let's keep public view for "guest" as empty or generic?
             // Actually, let's Redirect to Login if it's a SaaS now.
             return res.redirect('/login');
        }
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
        // Check for admin role first
        if (user.role === 'admin') {
             res.redirect('/admin/dashboard');
        } else {
             res.redirect('/');
        }
    } else {
        req.flash('error', 'Credenciais inválidas.');
        res.redirect('/login');
    }
});

app.get('/register', (req, res) => {
    res.render('register');
});

app.post('/register', async (req, res) => {
    const { username, password, full_name, cpf, cnpj } = req.body;
    try {
        if (!username || !password || !full_name || !cpf || !cnpj) {
            throw new Error("Todos os campos são obrigatórios.");
        }
        await createUser({ username, password, full_name, cpf, cnpj, role: 'user' });
        req.flash('success', 'Cadastro realizado! Faça login.');
        res.redirect('/login');
    } catch (e) {
        req.flash('error', 'Erro ao cadastrar: ' + e.message);
        res.redirect('/register');
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});


// Task Management (Restricted)
// Allow normal users to access create page now (UI handles restriction)
app.get('/create', isAuthenticated, async (req, res) => {
    const modules = getModules();
    const userGroups = await getUserGroups(req.session.userId);
    res.render('create', { modules, userGroups });
});

app.post('/create', isAuthenticated, upload.single('csvFile'), async (req, res) => {
    const { name, cep, csvText, moduleName, external_link, gridData, group_id } = req.body;
    const user = res.locals.user;

    let filePath = req.file ? req.file.path : null;
    let costEstimate = 0;

    // Handle Admin/Mod vs User Logic
    if (user.role === 'admin') {
         // Admin can upload file, paste text, or use grid
         if (!filePath && csvText && csvText.trim().length > 0) {
            const fileName = `paste_${Date.now()}.csv`;
            filePath = path.join('uploads', fileName);
            fs.writeFileSync(filePath, csvText);
        } else if (!filePath && gridData && gridData.trim().length > 0) {
            const fileName = `grid_${Date.now()}.csv`;
            filePath = path.join('uploads', fileName);
            fs.writeFileSync(filePath, gridData);
        }
    } else {
        // Normal User MUST use gridData
        if (gridData && gridData.trim().length > 0) {
            const fileName = `grid_${Date.now()}.csv`;
            filePath = path.join('uploads', fileName);
            fs.writeFileSync(filePath, gridData);

            // Calculate Cost
            const lines = gridData.trim().split('\n');
            // Header is line 0, so count is lines.length - 1
            costEstimate = Math.max(0, lines.length - 1);

            // Check Credits
            if (user.current_credits < costEstimate) {
                 return res.status(400).send(`Créditos insuficientes. Necessário: ${costEstimate}, Disponível: ${user.current_credits}`);
            }

        } else {
             return res.status(403).send('Apenas administradores podem fazer upload de arquivos diretos.');
        }
    }

    if (!filePath || !name || !cep) {
        return res.status(400).send('Dados incompletos.');
    }

    const taskId = uuidv4();
    // Verify group ownership if group_id provided
    let validGroupId = null;
    if (group_id) {
        const userGroups = await getUserGroups(user.id);
        const group = userGroups.find(g => g.id == group_id);
        if (group) validGroupId = group.id;
    }

    const task = {
        id: taskId,
        name,
        cep,
        input_file: filePath,
        log_file: path.join('logs', `${taskId}.txt`),
        external_link: external_link,
        module_name: moduleName,
        user_id: user.id,
        cost_estimate: costEstimate,
        group_id: validGroupId
    };

    try {
        // Deduct Credits if Cost > 0
        if (costEstimate > 0) {
            await addCredits(user.id, -costEstimate, `Início da Tarefa: ${name}`, taskId);
        }

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
            if (user.role === 'admin') {
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
    // Redirect old route to new dashboard
    res.redirect('/admin/dashboard');
});

app.get('/admin/dashboard', isAdmin, async (req, res) => {
    try {
        const users = await getAllUsers();
        const groups = await getAllGroups();
        res.render('admin_dashboard', { users, groups });
    } catch (e) {
        res.status(500).send(e.message);
    }
});

// Create Group
app.post('/admin/groups', isAdmin, async (req, res) => {
    const { name, description } = req.body;
    try {
        await createGroup(name, description);
        req.flash('success', 'Grupo criado.');
    } catch (e) {
        req.flash('error', 'Erro ao criar grupo.');
    }
    res.redirect('/admin/dashboard');
});

// Assign User to Group
app.post('/admin/users/assign_group', isAdmin, async (req, res) => {
    const { user_id, group_id } = req.body;
    try {
        await addUserToGroup(user_id, group_id);
        req.flash('success', 'Usuário adicionado ao grupo.');
    } catch (e) {
        req.flash('error', 'Erro ao vincular.');
    }
    res.redirect('/admin/dashboard');
});

// Add/Remove Credits
app.post('/admin/credits', isAdmin, async (req, res) => {
    const { user_id, amount, reason } = req.body;
    try {
        await addCredits(user_id, parseInt(amount), reason, null); // Admin action has no task_id
        req.flash('success', 'Créditos atualizados.');
    } catch (e) {
        req.flash('error', 'Erro ao atualizar créditos: ' + e.message);
    }
    res.redirect('/admin/dashboard');
});

// Keep existing User Actions (Delete/Role) but redirect to dashboard
app.post('/admin/users/delete', isAdmin, async (req, res) => {
    const { id } = req.body;
    if (id) await deleteUser(id);
    res.redirect('/admin/dashboard');
});

app.post('/admin/users/role', isAdmin, async (req, res) => {
    const { id, role } = req.body;
    if (id && role) await updateUserRole(id, role);
    res.redirect('/admin/dashboard');
});

app.get('/download-template', (req, res) => {
    res.download(path.join(__dirname, 'public', 'template.csv'), 'modelo_importacao.csv');
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
