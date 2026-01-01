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
    addCredits,
    createTaskItems,
    createTaskMetadata,
    getTaskFullResults
} = require('./src/database');
const { startWorker } = require('./src/worker');
const { generateExcelBuffer } = require('./src/export');
const { processPDF } = require('./src/services/tr_processor');

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
    res.locals.path = req.path; // Make current path available
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

const isAdmin = async (req, res, next) => {
    if (!req.session.userId) return res.redirect('/login');
    const user = await getUserById(req.session.userId);
    if (user && user.role === 'admin') return next();
    req.flash('error', 'Acesso negado. Apenas administradores.');
    res.redirect('/');
};

// --- ROUTES ---

// Module 1: RADAR (Home)
app.get('/', async (req, res) => {
    try {
        if (!req.session.userId) return res.redirect('/login');
        // Radar is just the visual gallery now. Tasks moved to Dashboard.
        res.render('index');
    } catch (e) {
        res.status(500).send(e.message);
    }
});

// Dashboard (Active Missions)
app.get('/dashboard', isAuthenticated, async (req, res) => {
    try {
        const showArchived = req.query.show_archived === 'true';
        const user = await getUserById(req.session.userId);
        const tasks = await getTasksForUser(user, showArchived);
        res.render('dashboard', { tasks, showArchived });
    } catch (e) {
        res.status(500).send(e.message);
    }
});

// Module 2: ORACLE (Analysis)
app.get('/oracle', isAuthenticated, (req, res) => {
    res.render('oracle');
});

// Module 3: SNIPER (Execution/Create Task)
app.get('/sniper', isAuthenticated, async (req, res) => {
    const modules = getModules();
    const userGroups = await getUserGroups(req.session.userId);
    res.render('sniper', { modules, userGroups });
});

// Legacy /create redirects to Sniper
app.get('/create', (req, res) => {
    res.redirect('/sniper');
});

// Task Creation (POST) - Now called via Sniper
app.post('/create', isAuthenticated, upload.single('csvFile'), async (req, res) => {
    const { name, cep, csvText, moduleName, external_link, gridData, group_id, metadataJSON } = req.body;
    const user = res.locals.user;

    let filePath = req.file ? req.file.path : null;
    let costEstimate = 0;

    // Handle File / Grid Logic (Unified)
    if (!filePath && csvText && csvText.trim().length > 0) {
        const fileName = `paste_${Date.now()}.csv`;
        filePath = path.join('uploads', fileName);
        fs.writeFileSync(filePath, csvText);
    } else if (!filePath && gridData && gridData.trim().length > 0) {
        const fileName = `grid_${Date.now()}.csv`;
        filePath = path.join('uploads', fileName);
        fs.writeFileSync(filePath, gridData);
    }

    // Calculate Cost
    if (gridData && gridData.trim().length > 0) {
        const lines = gridData.trim().split('\n');
        costEstimate = Math.max(0, lines.length - 1);
    } else if (filePath) {
        try {
            const content = fs.readFileSync(filePath, 'utf8');
            const lines = content.trim().split('\n');
            costEstimate = Math.max(0, lines.length - 1);
        } catch(e) {
            console.error("Error reading file for cost estimate:", e);
        }
    }

    // Check Credits (For non-admins)
    if (user.role !== 'admin') {
        if (user.current_credits < costEstimate) {
             if (req.file) fs.unlinkSync(req.file.path);
             return res.status(400).send(`Créditos insuficientes. Necessário: ${costEstimate}, Disponível: ${user.current_credits}`);
        }
    }

    const missingFields = [];
    if (!filePath) missingFields.push('Lista de Itens (Arquivo, Texto ou Grid)');
    if (!name) missingFields.push('Nome da Tarefa');
    if (!cep) missingFields.push('CEP');

    if (missingFields.length > 0) {
        return res.status(400).send('Dados incompletos. Faltando: ' + missingFields.join(', '));
    }

    const taskId = uuidv4();
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
        if (costEstimate > 0) {
            await addCredits(user.id, -costEstimate, `Início da Tarefa: ${name}`, taskId);
        }

        await createTask(task);

        if (metadataJSON) {
            try {
                const metadata = JSON.parse(metadataJSON);
                await createTaskMetadata(taskId, metadata);
            } catch (e) {
                console.error("Error parsing metadataJSON:", e);
            }
        }

        if (gridData && gridData.trim().length > 0) {
             const lines = gridData.trim().split('\n');
             const items = [];
             for (let i = 1; i < lines.length; i++) {
                 const line = lines[i].trim();
                 if (!line) continue;
                 const parts = line.split(';');
                 if (parts.length >= 4) {
                     items.push({
                         id: parts[0],
                         description: parts[1],
                         valor_venda: parseFloat(parts[2]),
                         quantidade: parseInt(parts[3])
                     });
                 }
             }
             if (items.length > 0) {
                 await createTaskItems(taskId, items);
             }
        }

        res.redirect('/dashboard'); // Redirect to Dashboard
    } catch (e) {
        res.status(500).send(e.message);
    }
});

// TR Processing Endpoint (Oracle)
app.post('/api/process-tr', isAuthenticated, upload.array('pdfFiles'), async (req, res) => {
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });

    const filePaths = req.files.map(f => f.path);

    try {
        const result = await processPDF(filePaths);
        filePaths.forEach(p => fs.unlinkSync(p));
        res.json({ success: true, ...result });
    } catch (e) {
        filePaths.forEach(p => { if(fs.existsSync(p)) fs.unlinkSync(p); });
        res.status(500).json({ error: e.message });
    }
});

// Detail View (Running Sniper)
app.get('/task/:id', async (req, res) => {
    try {
        const task = await getTaskById(req.params.id);
        if (!task) return res.status(404).send('Task not found');

        const results = await getTaskFullResults(task.id);

        const taskItems = results.map(r => {
            const winner = r.winnerIndex !== -1 ? r.offers[r.winnerIndex] : (r.offers[0] || null);
            return {
                id: r.id,
                description: r.description,
                valor_venda: r.valor_venda,
                quantidade: r.quantidade,
                best_price: winner ? winner.totalPrice : 0,
                winner: winner
            };
        });

        res.render('detail', { task, taskItems });
    } catch (e) {
        res.status(500).send(e.message);
    }
});

// Login/Register Routes
app.get('/login', (req, res) => { res.render('login'); });
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const user = await getUserByUsername(username);
    if (user && await bcrypt.compare(password, user.password_hash)) {
        req.session.userId = user.id;
        if (user.role === 'admin') res.redirect('/'); else res.redirect('/');
    } else {
        req.flash('error', 'Credenciais inválidas.');
        res.redirect('/login');
    }
});
app.get('/register', (req, res) => { res.render('register'); });
app.post('/register', async (req, res) => {
    const { username, password, full_name, cpf, cnpj } = req.body;
    try {
        if (!username || !password || !full_name || !cpf || !cnpj) throw new Error("Obrigatório.");
        await createUser({ username, password, full_name, cpf, cnpj, role: 'user' });
        req.flash('success', 'Cadastro OK.');
        res.redirect('/login');
    } catch (e) {
        req.flash('error', e.message);
        res.redirect('/register');
    }
});
app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/'); });

// Other APIs and Admin routes remain same but point to new dashboard
app.get('/admin/dashboard', isAdmin, async (req, res) => {
    const users = await getAllUsers();
    const groups = await getAllGroups();
    res.render('admin_dashboard', { users, groups });
});
// ... (Keep existing API routes for reorder/tags/force-start/archive/download/admin-actions) ...
// API endpoints (Some restricted?)
app.post('/api/tasks/reorder', async (req, res) => { // Removed strict middleware for simplicity or add back
    if (req.body.orderedIds && Array.isArray(req.body.orderedIds)) {
        try {
            const promises = req.body.orderedIds.map((tid, index) => updateTaskPosition(tid, index));
            await Promise.all(promises);
            res.json({ success: true });
        } catch(e) { res.status(500).json({ error: e.message }); }
    } else { res.status(400).json({ error: "Invalid data" }); }
});

app.post('/api/tasks/:id/tags', isAdmin, async (req, res) => {
    const { tags } = req.body;
    try { await updateTaskTags(req.params.id, tags); res.json({ success: true }); }
    catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/logs/:id', async (req, res) => {
    try {
        const logs = await getTaskLogs(req.params.id);
        const formatted = logs.map(l => `[${new Date(l.timestamp).toLocaleTimeString('pt-BR')}] ${l.message}`).join('\n');
        res.send(formatted);
    } catch (e) { res.status(500).send('Error fetching logs'); }
});

app.get('/download/:id', isAuthenticated, async (req, res) => {
    try {
        const task = await getTaskById(req.params.id);
        if (!task) return res.status(404).send('Task not found');
        const buffer = await generateExcelBuffer(req.params.id);
        if (!buffer) return res.status(404).send('No results.');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=resultado_${task.id}.xlsx`);
        res.send(buffer);
    } catch (e) { res.status(500).send(e.message); }
});

app.post('/task/:id/force-start', isAdmin, async (req, res) => {
    try { await forceStartTask(req.params.id); res.redirect('/dashboard'); }
    catch (e) { res.status(500).send(e.message); }
});

app.post('/task/:id/action', isAuthenticated, async (req, res) => {
    const { action } = req.body;
    const taskId = req.params.id;
    try {
        const task = await getTaskById(taskId);
        if (!task) return res.status(404).send('Task not found');
        if (action === 'abort') await updateTaskStatus(taskId, 'aborted');
        else if (action === 'archive') await updateTaskStatus(taskId, 'archived');
        else if (action === 'unarchive') {
             if (task.output_file) await updateTaskStatus(taskId, 'completed', task.output_file);
             else await updateTaskStatus(taskId, 'pending');
        }
        res.redirect('/dashboard');
    } catch (e) { res.status(500).send(e.message); }
});

// Admin actions
app.post('/admin/groups', isAdmin, async (req, res) => {
    try { await createGroup(req.body.name, req.body.description); res.redirect('/admin/dashboard'); } catch(e){res.redirect('/admin/dashboard');}
});
app.post('/admin/users/assign_group', isAdmin, async (req, res) => {
    try { await addUserToGroup(req.body.user_id, req.body.group_id); res.redirect('/admin/dashboard'); } catch(e){res.redirect('/admin/dashboard');}
});
app.post('/admin/credits', isAdmin, async (req, res) => {
    try { await addCredits(req.body.user_id, parseInt(req.body.amount), req.body.reason, null); res.redirect('/admin/dashboard'); } catch(e){res.redirect('/admin/dashboard');}
});
app.post('/admin/users/delete', isAdmin, async (req, res) => {
    if (req.body.id) await deleteUser(req.body.id); res.redirect('/admin/dashboard');
});
app.post('/admin/users/role', isAdmin, async (req, res) => {
    if (req.body.id && req.body.role) await updateUserRole(req.body.id, req.body.role); res.redirect('/admin/dashboard');
});


app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
