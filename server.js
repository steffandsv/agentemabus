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
    createTaskItems,
    createTaskMetadata,
    getTaskFullResults,
    getSetting,
    setSetting
} = require('./src/database');
const { startWorker } = require('./src/worker');
const { generateExcelBuffer } = require('./src/export');
const { fetchModels } = require('./src/services/ai_manager');
const { extractItemsFromPdf } = require('./src/services/pdf_parser');

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

// History Dashboard (Home)
app.get('/', isAuthenticated, async (req, res) => {
    try {
        const showArchived = req.query.show_archived === 'true';
        const page = parseInt(req.query.page) || 1;
        const limit = 20;
        const offset = (page - 1) * limit;
        const search = req.query.search || '';
        const status = req.query.status || '';
        const dateFrom = req.query.date_from || '';
        const dateTo = req.query.date_to || '';

        const user = await getUserById(req.session.userId);

        const filters = {
            search,
            status,
            dateFrom,
            dateTo
        };

        const tasks = await getTasksForUser(user, showArchived, limit, offset, filters);

        // Next page check (naive)
        const nextTasks = await getTasksForUser(user, showArchived, 1, offset + limit, filters);
        const hasNext = nextTasks.length > 0;

        res.render('index', { tasks, showArchived, page, hasNext, search, status, dateFrom, dateTo });
    } catch (e) {
        res.status(500).send(e.message);
    }
});

// Module: SNIPER (Execution/Create Task)
app.get('/sniper', isAuthenticated, async (req, res) => {
    const modules = getModules();
    const user = await getUserById(req.session.userId);
    const userGroups = await getUserGroups(req.session.userId);
    const recentTasks = await getTasksForUser(user, false, 5, 0); // Limit 5
    res.render('sniper', { modules, userGroups, recentTasks });
});

// Legacy /create redirects to Sniper
app.get('/create', (req, res) => {
    res.redirect('/sniper');
});

// Task Creation (POST) - Now called via Sniper
app.post('/create', isAuthenticated, upload.single('csvFile'), async (req, res) => {
    const { name, cep, csvText, moduleName, external_link, gridData, group_id, metadataJSON } = req.body;
    const user = res.locals.user;

    let filePath = req.file ? req.file.path : (req.body.existingFilePath && req.body.existingFilePath.startsWith('uploads/') ? req.body.existingFilePath : null);

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
        module_name: moduleName || 'gemini_meli', // Default module
        user_id: user.id,
        cost_estimate: 0,
        group_id: validGroupId
    };

    try {
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

        res.redirect('/'); // Redirect to Dashboard/History
    } catch (e) {
        res.status(500).send(e.message);
    }
});

// PDF Parsing Endpoint (Sniper Auto-fill)
app.post('/api/sniper/parse-pdf', isAuthenticated, upload.array('pdfFiles'), async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) throw new Error("Nenhum arquivo enviado.");
        const instructions = req.body.instructions || "";
        const result = await extractItemsFromPdf(req.files, instructions);

        // Clean up uploads immediately after parsing
        req.files.forEach(f => {
            if (fs.existsSync(f.path)) fs.unlinkSync(f.path);
        });

        res.json(result);
    } catch (e) {
        // Clean up on error too
        if (req.files) req.files.forEach(f => { if(fs.existsSync(f.path)) fs.unlinkSync(f.path); });
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
                db_id: r.db_id, // Internal ID
                is_unlocked: true, // ALWAYS UNLOCKED
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

// --- NEW ADMIN AI ROUTES ---
app.get('/admin/ai-config', isAdmin, async (req, res) => {
    try {
        const settings = {
            sniper_provider: await getSetting('sniper_provider'),
            sniper_model: await getSetting('sniper_model'),
            sniper_api_key: await getSetting('sniper_api_key'),
            parser_primary: JSON.parse(await getSetting('parser_primary') || '{}'),
            parser_backup1: JSON.parse(await getSetting('parser_backup1') || '{}'),
            parser_backup2: JSON.parse(await getSetting('parser_backup2') || '{}'),
            parser_backup3: JSON.parse(await getSetting('parser_backup3') || '{}')
        };
        res.render('admin_ai_config', { settings });
    } catch (e) {
        res.status(500).send(e.message);
    }
});

app.post('/admin/ai-config/save', isAdmin, async (req, res) => {
    const {
        sniper_provider, sniper_model, sniper_api_key,
        // Parser Fields
        parser_provider_0, parser_key_0, parser_model_0,
        parser_provider_1, parser_key_1, parser_model_1,
        parser_provider_2, parser_key_2, parser_model_2,
        parser_provider_3, parser_key_3, parser_model_3
    } = req.body;

    try {
        if(sniper_provider) await setSetting('sniper_provider', sniper_provider);
        if(sniper_model) await setSetting('sniper_model', sniper_model);
        if(sniper_api_key && sniper_api_key.trim() !== '') await setSetting('sniper_api_key', sniper_api_key);

        // Save Parser Settings (as JSON strings to keep table clean)
        await setSetting('parser_primary', JSON.stringify({ provider: parser_provider_0, key: parser_key_0, model: parser_model_0 }));
        await setSetting('parser_backup1', JSON.stringify({ provider: parser_provider_1, key: parser_key_1, model: parser_model_1 }));
        await setSetting('parser_backup2', JSON.stringify({ provider: parser_provider_2, key: parser_key_2, model: parser_model_2 }));
        await setSetting('parser_backup3', JSON.stringify({ provider: parser_provider_3, key: parser_key_3, model: parser_model_3 }));

        req.flash('success', 'Configurações de IA atualizadas.');
        res.redirect('/admin/ai-config');
    } catch (e) {
        req.flash('error', e.message);
        res.redirect('/admin/ai-config');
    }
});

app.post('/api/admin/fetch-models', isAdmin, async (req, res) => {
    const { provider, apiKey } = req.body;
    try {
        // Fallback to Env if key empty
        let effectiveKey = apiKey;
        if (!effectiveKey || effectiveKey.trim() === '') {
             if (provider === 'qwen') effectiveKey = process.env.DASHSCOPE_API_KEY; // example convention
             if (provider === 'deepseek') effectiveKey = process.env.DEEPSEEK_API_KEY;
             if (provider === 'gemini') effectiveKey = process.env.GEMINI_API_KEY;
        }

        const models = await fetchModels(provider, effectiveKey);
        res.json(models);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

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

app.post('/api/task/:id/abort', isAuthenticated, async (req, res) => {
    try {
        await updateTaskStatus(req.params.id, 'aborted');
        res.json({ success: true, message: 'Tarefa abortada com sucesso.' });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/download/:id/item/:itemId', isAuthenticated, async (req, res) => {
    try {
        const { id, itemId } = req.params;
        const { generateItemExcelBuffer } = require('./src/export');
        // Always allowed
        const buffer = await generateItemExcelBuffer(id, itemId);
        if (!buffer) return res.status(404).send('Item not found.');

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=item_${itemId}.xlsx`);
        res.send(buffer);
    } catch(e) {
        res.status(500).send(e.message);
    }
});

app.post('/task/:id/force-start', isAdmin, async (req, res) => {
    try { await forceStartTask(req.params.id); res.redirect('/'); }
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
        res.redirect('/');
    } catch (e) { res.status(500).send(e.message); }
});

// Admin actions
app.post('/admin/groups', isAdmin, async (req, res) => {
    try { await createGroup(req.body.name, req.body.description); res.redirect('/admin/dashboard'); } catch(e){res.redirect('/admin/dashboard');}
});
app.post('/admin/users/assign_group', isAdmin, async (req, res) => {
    try { await addUserToGroup(req.body.user_id, req.body.group_id); res.redirect('/admin/dashboard'); } catch(e){res.redirect('/admin/dashboard');}
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
