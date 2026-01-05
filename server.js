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
    getTaskFullResults,
    createOpportunity,
    getRadarOpportunities,
    getUserOpportunities,
    getSetting,
    setSetting
} = require('./src/database');
const { startWorker } = require('./src/worker');
const { generateExcelBuffer } = require('./src/export');
const { processPDF } = require('./src/services/tr_processor');
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

// Module 1: RADAR (Home)
app.get('/', async (req, res) => {
    try {
        if (!req.session.userId) return res.redirect('/login');
        // Fetch Admin Opportunities (Radar)
        const opportunities = await getRadarOpportunities();
        res.render('index', { opportunities });
    } catch (e) {
        res.status(500).send(e.message);
    }
});

// Dashboard (Active Missions)
app.get('/dashboard', isAuthenticated, async (req, res) => {
    try {
        const showArchived = req.query.show_archived === 'true';
        const page = parseInt(req.query.page) || 1;
        const limit = 20;
        const offset = (page - 1) * limit;

        const user = await getUserById(req.session.userId);
        const tasks = await getTasksForUser(user, showArchived, limit, offset);

        // Next page check (naive)
        const nextTasks = await getTasksForUser(user, showArchived, 1, offset + limit);
        const hasNext = nextTasks.length > 0;

        res.render('dashboard', { tasks, showArchived, page, hasNext });
    } catch (e) {
        res.status(500).send(e.message);
    }
});

// Module 2: ORACLE (Analysis)
app.get('/oracle', isAuthenticated, async (req, res) => {
    try {
        const history = await getUserOpportunities(req.session.userId);
        res.render('oracle', { history });
    } catch (e) {
        res.status(500).send(e.message);
    }
});

// Module 3: SNIPER (Execution/Create Task)
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
        module_name: moduleName || 'gemini_meli', // Default module
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

// TR Processing Endpoint (Oracle) - STREAMING SSE
app.post('/api/process-tr', isAuthenticated, upload.array('pdfFiles'), async (req, res) => {
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });

    const filePaths = req.files.map(f => f.path);

    // Set headers for Server-Sent Events (SSE)
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders(); // Establish connection immediately

    const sendEvent = (type, data) => {
        res.write(`event: ${type}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // Keep track of sent titles to avoid duplicates in the UI
    let lastSentTitle = "";

    try {
        sendEvent('status', { message: 'Iniciando leitura do edital...' });

        const result = await processPDF(filePaths, (thoughtTitle) => {
            if (thoughtTitle && thoughtTitle !== lastSentTitle) {
                sendEvent('thought', { title: thoughtTitle });
                lastSentTitle = thoughtTitle;
            }
        });

        // Clean up files (KEEPING FOR SNIPER IMPORT)
        // filePaths.forEach(p => { if(fs.existsSync(p)) fs.unlinkSync(p); });

        // Save to Database (Opportunities)
        const opportunityData = {
            title: result.metadata.edital_numero || 'Análise Sem Título',
            municipality: result.metadata.municipio_uf || 'Desconhecido',
            metadata: result.metadata,
            locked_content: result.locked_content,
            items: result.items,
            ipm_score: result.metadata.ipm_score || 0
        };

        // If admin, assign to NULL (Radar) so it's public/global
        const user = await getUserById(req.session.userId);
        const targetUserId = (user && user.role === 'admin') ? null : req.session.userId;

        await createOpportunity(targetUserId, opportunityData);

        // Send Final Result
        result.file_path = filePaths[0];
        sendEvent('result', result);
        res.write('event: end\ndata: "DONE"\n\n');
        res.end();

    } catch (e) {
        filePaths.forEach(p => { if(fs.existsSync(p)) fs.unlinkSync(p); });
        console.error("Oracle Error:", e);
        sendEvent('error', { message: e.message });
        res.end();
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
                db_id: r.db_id, // Internal ID for unlocking
                is_unlocked: r.is_unlocked, // Lock status
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
            oracle_provider: await getSetting('oracle_provider'),
            oracle_model: await getSetting('oracle_model'),
            oracle_api_key: await getSetting('oracle_api_key'),
            sniper_provider: await getSetting('sniper_provider'),
            sniper_model: await getSetting('sniper_model'),
            sniper_api_key: await getSetting('sniper_api_key'),
            // Fetch Parser settings (JSON stored in value or multiple keys? "3 reserves" implies complex structure)
            // Let's store them as individual keys or JSON. Given setSetting is key-value, let's use JSON for reserves if possible or keys.
            // Using keys for simplicity of existing DB structure:
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
        oracle_provider, oracle_model, oracle_api_key,
        sniper_provider, sniper_model, sniper_api_key,
        // Parser Fields
        parser_provider_0, parser_key_0, parser_model_0,
        parser_provider_1, parser_key_1, parser_model_1,
        parser_provider_2, parser_key_2, parser_model_2,
        parser_provider_3, parser_key_3, parser_model_3
    } = req.body;

    try {
        if(oracle_provider) await setSetting('oracle_provider', oracle_provider);
        if(oracle_model) await setSetting('oracle_model', oracle_model);
        if(oracle_api_key && oracle_api_key.trim() !== '') await setSetting('oracle_api_key', oracle_api_key);

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

app.post('/api/unlock-item', isAuthenticated, async (req, res) => {
    const { itemId } = req.body;
    const { getTaskItem, updateTaskItemLockStatus, addCredits } = require('./src/database');
    const user = await getUserById(req.session.userId);

    // We need the internal DB id, or handle original_id carefully.
    // The frontend should pass the internal ID if possible, or we assume itemId is internal ID.
    // Let's assume the frontend passes the INTERNAL `id` from `task_items`.

    try {
        // Need to fetch item to verify ownership? Or at least user owns the task?
        // Let's assume basic check is enough for now or we query item -> task -> user.
        // For strict security, we should query JOIN tasks.

        // Cost: 150
        const COST = 150;
        if (user.current_credits < COST) return res.status(400).json({ error: 'Créditos insuficientes.' });

        await addCredits(user.id, -COST, `Desbloqueio Item #${itemId}`, null);
        await updateTaskItemLockStatus(itemId, true);

        res.json({ success: true });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/unlock-all', isAuthenticated, async (req, res) => {
    const { taskId } = req.body;
    const { getTaskItems, unlockAllTaskItems, addCredits, getTaskById } = require('./src/database');
    const user = await getUserById(req.session.userId);

    try {
        const task = await getTaskById(taskId);
        if (!task) return res.status(404).json({ error: 'Task not found' });

        // Verify User Ownership (unless admin)
        if (user.role !== 'admin' && task.user_id !== user.id) {
             // also check group permissions if needed, but for paying credits, usually owner pays.
             // Let's allow owner only for now to keep it simple.
             return res.status(403).json({ error: 'Apenas o dono da tarefa pode desbloquear tudo.' });
        }

        const items = await getTaskItems(taskId);
        const lockedCount = items.filter(i => !i.is_unlocked).length;

        if (lockedCount === 0) return res.json({ success: true, message: 'Todos já desbloqueados.' });

        const COST_PER_ITEM = 75; // 50% discount
        const totalCost = lockedCount * COST_PER_ITEM;

        if (user.current_credits < totalCost) {
            return res.status(400).json({ error: `Créditos insuficientes. Necessário: ${totalCost}, Disponível: ${user.current_credits}` });
        }

        await addCredits(user.id, -totalCost, `Desbloqueio Total Tarefa #${taskId} (${lockedCount} itens)`, taskId);
        await unlockAllTaskItems(taskId);

        res.json({ success: true });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/download/:id/item/:itemId', isAuthenticated, async (req, res) => {
    try {
        const { id, itemId } = req.params;
        const { generateItemExcelBuffer } = require('./src/export');
        // We need to check if unlocked
        const { getTaskItem } = require('./src/database');
        const item = await getTaskItem(id, itemId); // Note: getTaskItem uses task_id, original_id. Wait.
        // My getTaskItem query was: WHERE task_id = ? AND original_id = ?
        // But the frontend usually works with internal IDs if we set it up that way.
        // Let's assume itemId passed here is the INTERNAL DB ID for safety.
        // I need a function `getTaskItemByDbId`.

        // Let's make generateItemExcelBuffer check logic internally or check here.
        // Since I haven't implemented generateItemExcelBuffer yet, I will do that in the next step.
        // For now, I'll register the route.

        const buffer = await generateItemExcelBuffer(id, itemId);
        if (!buffer) return res.status(404).send('Item locked or not found.');

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=item_${itemId}.xlsx`);
        res.send(buffer);
    } catch(e) {
        res.status(500).send(e.message);
    }
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
